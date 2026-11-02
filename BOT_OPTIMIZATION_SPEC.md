# Architectural Specification: SQLite Native Task Queue, Captcha Resolution Flow, Humanized Jitter, Log Rotation (20MB), Compact Status Report & Contact Extraction

## 1. System Overview & Tech Stack

- **Runtime & Language:** Node.js v26+ (ESM), TypeScript 7 (`@typescript/native-preview` / `tsgo`).
- **Database & Native Queue Engine:** Native `node:sqlite` managed via Drizzle ORM (`drizzle-orm`). All asynchronous side effects (Telegram outbound messages, CLI-to-Telegram notifications, Playwright vacancy applications, and negotiation sync jobs) MUST be serialized through a persistent SQLite-backed FIFO/Priority queue table (`task_queue`) using atomic `UPDATE ... RETURNING` transactions to prevent concurrency race conditions and data loss.
- **Browser Automation & Captcha Interception:** `playwright` (Chromium persistent context). Detects HH.ru modal captcha challenges (`Пройдите капчу`) during vacancy application or navigation, pauses queue execution, notifies the user in Telegram with a direct link and confirmation action, and resumes once resolved.
- **Log Rotation Engine:** `pino` combined with `pino-roll` (or native `node:fs` byte-size ring-buffer truncation) enforcing a strict **20 MB maximum file size** on `./logs/agent-debug.jsonl` and `./logs/agent-errors.jsonl`, overwriting oldest log entries automatically.
- **Telegram Interface:** `grammy` with Inline Keyboards for Captcha resolution confirmation, Compact Status reporting, and highlighted contact blocks extracted from employer messages.

---

## 2. Project Structure

```text
src/
├── db/
│   └── schema.ts                                  # Extended with task_queue table and extracted_contacts column
├── modules/
│   ├── queue/
│   │   ├── sqlite-queue.service.ts                # Persistent SQLite message broker, atomic job locking, retry & pause states
│   │   └── queue-worker.service.ts                # Sequential job dispatcher with humanized jitter delays
│   ├── logger/
│   │   └── agent-logger.service.ts                # Updated with 20MB size cap and ring-buffer overwrite logic
│   ├── hh-hybrid/
│   │   ├── hh-captcha.detector.ts                 # Detects HH modal captcha ("Пройдите капчу"), pauses queue, awaits user resolution
│   │   └── hh-browser.service.ts                  # Integrates captcha detector into apply and search workflows
│   ├── parser/
│   │   └── contact-extractor.service.ts           # Regex/NLP extractor for Telegram (@handle, t.me), phone numbers, and emails
│   └── telegram/
│       ├── telegram-status.handler.ts             # Renders compact in-chat application summary ("📊 Статус" button)
│       └── telegram-captcha.handler.ts            # Sends captcha alert with URL + "✅ Подтвердить прохождение" button
└── utils/
    └── jitter.util.ts                             # Humanized delay calculator with ± 1-2 minute randomized jitter

```

---

## 3. Data Models & Logical Contracts

### 3.1. SQLite Native Message Broker Schema (`task_queue` in `src/db/schema.ts`)

- **Fields:**
- `id`: Integer, Primary Key, Auto-increment.
- `taskType`: Text enum (`'SEND_TG_MESSAGE'`, `'APPLY_VACANCY'`, `'SYNC_NEGOTIATIONS'`, `'GENERATE_AI_REPLY'`).
- `payloadJson`: Text (JSON-serialized parameters required by the handler).
- `status`: Text enum (`'pending'`, `'processing'`, `'paused_captcha'`, `'completed'`, `'failed'`). Default `'pending'`.
- `priority`: Integer (Higher number = higher priority: Telegram notifications = `10`, Chat sync = `5`, Auto-apply = `1`).
- `attempts`: Integer, Default `0` (Max retries = `3`).
- `lastError`: Text, Nullable.
- `scheduledFor`: Text (ISO-8601 timestamp indicating the earliest time the job can be picked up, incorporating jitter).
- `createdAt` / `updatedAt`: Text (ISO-8601 timestamps).

### 3.2. Contact Extraction Contract (`src/modules/parser/contact-extractor.service.ts`)

- **Input:** Raw employer message string from HH negotiations.
- **Output Interface (`ExtractedContacts`):**
- `telegramHandles`: Array of normalized strings (e.g., `@username` or `https://t.me/username`) matched via case-insensitive pattern for `@[a-zA-Z0-9_]{5,32}` and `(?:https?:\/\/)?(?:t\.me|telegram\.me)\/[a-zA-Z0-9_+]{5,32}`.
- `phoneNumbers`: Array of formatted phone strings matched via CIS/international phone patterns (`(?:\+7|8)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}`).
- `emails`: Array of email strings matched via standard RFC email pattern.

### 3.3. Humanized Jitter Specification (`src/utils/jitter.util.ts`)

- **Base Delay:** Configurable base interval (e.g., `180_000` ms / 3 minutes).
- **Jitter Window:** Randomized uniform or Gaussian offset between `-120_000` ms (-2 minutes) and `+120_000` ms (+2 minutes), with a hard floor of `60_000` ms (1 minute minimum) so requests never fire back-to-back.
- **Sub-second Entropy:** Always include random milliseconds (`0–999` ms) to avoid exact whole-second intervals.

---

## 4. Sequential Implementation Steps

### Step 1: Implement 20MB Bounded Log Rotation (`src/modules/logger/agent-logger.service.ts`)

- **Files touched:** `src/modules/logger/agent-logger.service.ts`
- **Logic:**

1. Before appending or during stream initialization for `./logs/agent-debug.jsonl` and `./logs/agent-errors.jsonl`, monitor file size using `fs.statSync`.
2. Enforce a strict `MAX_LOG_BYTES = 20 * 1024 * 1024` (20 MB) threshold.
3. When a log file exceeds `20 MB`, read the latest `10 MB` of complete newline-delimited JSON entries from the tail of the file, overwrite the file atomically (via a temporary `.tmp` swap file), and continue writing new entries. This guarantees the file never exceeds 20 MB while preserving recent diagnostic history for the AI agent.

### Step 2: Implement SQLite Native Message Broker (`src/modules/queue/sqlite-queue.service.ts` & `queue-worker.service.ts`)

- **Files touched:** `src/db/schema.ts`, `src/modules/queue/sqlite-queue.service.ts`, `src/modules/queue/queue-worker.service.ts`
- **Logic:**

1. Create the `task_queue` table in Drizzle schema.
2. On application startup, reset any stale jobs stuck in `'processing'` state back to `'pending'` (crash recovery).
3. Provide an `enqueue(taskType, payload, priority, delayMs)` method used by all producers (CLI console events, Telegram notifications, scheduler triggers).
4. Implement a single-concurrency loop in `QueueWorkerService` that polls `task_queue` every `1000 ms` for the highest-priority `'pending'` task where `scheduledFor <= now()`.
5. Separate queues logically by priority: `'SEND_TG_MESSAGE'` tasks (`priority = 10`) execute immediately with Telegram rate-limit protection (max 1 msg/sec), whereas `'APPLY_VACANCY'` tasks (`priority = 1`) schedule the next vacancy task using the Humanized Jitter calculator (`± 1-2 minutes`).

### Step 3: Implement Humanized Jitter Utility (`src/utils/jitter.util.ts`)

- **Files touched:** `src/utils/jitter.util.ts`
- **Logic:**

1. Implement `calculateNextRunWithJitter(baseMinutes = 3, jitterRangeMinutes = 2): Date`.
2. Compute random offset in milliseconds between `-jitterRangeMinutes * 60_000` and `+jitterRangeMinutes * 60_000`.
3. Clamp total delay to a minimum of `60_000 ms` (1 minute) and return the target ISO timestamp for `task_queue.scheduledFor`.

### Step 4: Implement Captcha Modal Detection & Manual Resolution Flow (`src/modules/hh-hybrid/hh-captcha.detector.ts` & `telegram-captcha.handler.ts`)

- **Files touched:** `src/modules/hh-hybrid/hh-captcha.detector.ts`, `src/modules/hh-hybrid/hh-browser.service.ts`, `src/modules/telegram/telegram-captcha.handler.ts`
- **Logic:**

1. During Playwright interactions (`applyToVacancy`, `searchVacancies`, `fetchUnreadNegotiations`), inspect the DOM for the HH.ru captcha modal containing text `"Пройдите капчу"`, input placeholder `"Текст с картинки"`, or selector `[data-qa*="captcha"]`.
2. When detected:

- Immediately transition the current `APPLY_VACANCY` queue state to `'paused_captcha'` and pause browser worker processing.
- Capture a screenshot of the captcha modal image and grab the current `page.url()`.
- Enqueue a high-priority `'SEND_TG_MESSAGE'` alert to the user containing:
- Captcha image snapshot (so the user can also see it immediately).
- Direct clickable URL link to the vacancy/page (`🔗 Открыть страницу с капчей`).
- Inline button: `✅ Подтвердить прохождение капчи` (`callback_data: "captcha_resolved"`).
- Ability for the user to reply directly with the text from the captcha image in Telegram, which Playwright types into `"Текст с картинки"` and clicks `"Отправить"`.

3. When the user clicks `✅ Подтвердить прохождение капчи` (or submits the captcha text via Telegram), verify in Playwright that the modal is gone, resume the `QueueWorkerService`, and re-run the interrupted task.

### Step 5: Implement Compact Status Report Button in Telegram (`src/modules/telegram/telegram-status.handler.ts`)

- **Files touched:** `src/modules/telegram/telegram-status.handler.ts`
- **Logic:**

1. Add a persistent menu button `📊 Статус` in the Telegram bot main menu.
2. When clicked, query `application_records` and `task_queue` from SQLite and format a concise, mobile-friendly Telegram message (mirroring the core Excel metrics):

- **Header:** Current bot state (`🟢 Активен` / `⏸ На паузе` / `⚠️ Ожидает капчу`), Today's applications (`X / DAILY_LIMIT`), Pending tasks in SQLite queue (`N`).
- **Totals Breakdown:** Total Applied, Invitations (`🟢`), Discards (`🔴`), Awaiting Response (`⏳`).
- **Recent 10 Applications List:** Compact numbered lines showing:
  `1. [Status Icon] Company — Position (Salary) | [Дата] | [Ссылка на вакансию]`

3. Include an inline button `📥 Скачать полный Excel` right below the compact status message.

### Step 6: Implement Contact Extraction in Employer Messages (`src/modules/parser/contact-extractor.service.ts`)

- **Files touched:** `src/modules/parser/contact-extractor.service.ts`, `src/modules/telegram/telegram-messaging.handler.ts`
- **Logic:**

1. Run `extractContacts(lastUnreadText)` on every incoming employer message before sending the Telegram notification.
2. If any Telegram handles (`@username` / `t.me/...`), phone numbers, or emails are found, append a dedicated highlighted footer section to the Telegram notification:

```text
📌 Найденные контакты для быстрой связи:
• Telegram: @hr_contact_name
• Телефон: +7 (999) 123-45-67

```

3. Ensure `@username` and phone numbers are formatted cleanly so Telegram clients make them clickable in one tap.

---

## 5. Verification & Acceptance Criteria

1. **TypeScript 7 (`tsgo`) Validation:**

- Run `npx tsgo --noEmit` -> Must exit with code `0`.

2. **20MB Log Cap Verification:**

- Generate or simulate a `21 MB` `./logs/agent-debug.jsonl` file, trigger a logger write, and verify via `fs.statSync('./logs/agent-debug.jsonl').size <= 20 * 1024 * 1024` with valid JSONL structure intact.

3. **SQLite Queue Concurrency & Persistence Test:**

- Enqueue 5 simultaneous tasks (3 `SEND_TG_MESSAGE` and 2 `APPLY_VACANCY`). Verify all 5 are written to `task_queue` and processed sequentially by priority without SQLite `SQLITE_BUSY` errors.

4. **Contact Extractor Verification:**

- Pass test string `"Здравствуйте! Напишите мне в ТГ @recruiter_hh или позвоните +7 (916) 555-33-22"` into `ContactExtractorService` -> Must return `telegramHandles: ['@recruiter_hh']` and `phoneNumbers: ['+7 (916) 555-33-22']`.

```

---

### Уточняющие вопросы перед следующим шагом

Чтобы мы убедились, что всё работает именно так, как ты задумал, подскажи:
1. В случае с капчей (на твоем скриншоте[cite: 2]) — хочешь ли ты в основном **вводить текст капчи прямо в чат Telegram-бота** (чтобы бот сам переслал эти два слова в фоновый браузер и нажал «Отправить»[cite: 2]), или тебе удобнее, чтобы на твоем ПК в этот момент **всплывало само окно браузера** для ручного ввода?
2. Сколько последних вакансий тебе будет удобнее видеть в кратком отчете по кнопке **«📊 Статус»** в Telegram — последние **5**, **10** или сделать кнопки переключения страниц (`⬅️ Назад / Вперед ➡️`), чтобы можно было листать всю историю прямо в боте?

<FollowUp label="Сделать ввод капчи прямо текстом в чате Telegram и добавить пагинацию (листание страниц) в кнопку Статус?" query="Давай сделаем так, чтобы текст капчи можно было просто написать в ответ боту в Telegram, а в кнопке Статус выводилось по 5 вакансий с кнопками переключения страниц (Назад / Вперед)."/>
```

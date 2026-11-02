# Technical Specification: AI-Readable Telemetry, 403 Bypass & Unread Chat AI Auto-Responder

## 1. System Overview & Tech Stack

- **Runtime & Compiler:** Node.js v26+ (`"type": "module"`), TypeScript 7 (`@typescript/native-preview` / `tsgo`).
- **Database:** Native `node:sqlite` with Drizzle ORM (`drizzle-orm`, `drizzle-kit`).
- **Browser Automation (403 Bypass):** `playwright` (Chromium persistent context stored at `./hh-session`). All HH.ru interactions—including vacancy search, negotiation list polling, unread message extraction, and chat reply submission—MUST execute inside the authenticated Playwright `BrowserContext` (either via DOM navigation or `context.request.fetch()` inheriting browser cookies/TLS fingerprint) to prevent `403 Forbidden` blocks on `api.hh.ru`.
- **Structured AI Telemetry:** `pino` writing deterministic JSON Lines (`.jsonl`) to `./logs/agent-debug.jsonl` and `./logs/agent-errors.jsonl` with automatic Playwright page state snapshots (`url`, `selector`, `httpStatus`, `domSnippet`, `screenshotPath`).
- **Telegram Framework:** `grammy` using Inline Keyboards (`InlineKeyboard` URL button for manual reply + callback query button for AI auto-reply).
- **Local LLM:** Ollama REST API (`http://127.0.0.1:11434/api/generate`) running `gemma4:64k` with strict `zod` JSON schema output validation.

---

## 2. Project Structure

```text
src/
├── main.ts                                      # App bootstrap: initializes Logger, DB, Playwright, Bot, and runs initial unread sync
├── db/
│   ├── index.ts                                 # node:sqlite + Drizzle connection instance
│   └── schema.ts                                # Updated schema with negotiation_messages table
├── modules/
│   ├── logger/
│   │   ├── agent-logger.types.ts                # Strict TypeScript interfaces for AI-agent JSONL log entries
│   │   └── agent-logger.service.ts              # Pino-based structured logger & Playwright error snapshotter
│   ├── hh-hybrid/
│   │   ├── hh-browser.service.ts                # Persistent Chromium context & 403-safe search/navigation
│   │   └── hh-messaging.service.ts              # Unread negotiations scanner, chat parser, and reply sender
│   ├── llm/
│   │   └── llm-reply.service.ts                 # Gemma 4:64k chat reply generator with Zod validation
│   ├── telegram/
│   │   └── telegram-messaging.handler.ts        # Notification sender & callback handler for "ai_reply:<chatId>"
│   └── scheduler/
│       └── scheduler.service.ts                 # Startup hook + Croner 10-minute polling loop for unread messages
logs/
├── agent-debug.jsonl                            # Structured stream of all operational events for AI agent inspection
├── agent-errors.jsonl                           # Isolated stream of errors with stack traces & DOM context
└── snapshots/                                   # HTML/PNG snapshots captured automatically on Playwright errors

```

---

## 3. Data Models & Interfaces

### 3.1. Database Schema Additions (`src/db/schema.ts`)

```typescript
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const negotiationMessages = sqliteTable('negotiation_messages', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	negotiationId: text('negotiation_id').notNull().unique(), // HH chat ID (e.g., "384920194")
	vacancyId: text('vacancy_id').notNull(),
	companyName: text('company_name').notNull(),
	positionTitle: text('position_title').notNull(),
	chatUrl: text('chat_url').notNull(), // Direct URL: [https://hh.ru/applicant/negotiations/item/](https://hh.ru/applicant/negotiations/item/){negotiationId}
	lastUnreadText: text('last_unread_text').notNull(), // Extracted employer message text
	chatHistoryJson: text('chat_history_json').notNull(), // JSON array of recent messages in the thread
	telegramMessageId: integer('telegram_message_id'), // ID of the sent TG message for inline keyboard updates
	replyStatus: text('reply_status', {
		enum: [
			'unread_notified',
			'replied_by_ai',
			'replied_manually',
			'failed',
		],
	})
		.notNull()
		.default('unread_notified'),
	aiGeneratedReply: text('ai_generated_reply'), // Text generated and sent by Gemma 4:64k
	updatedAt: text('updated_at').notNull(),
});
```

### 3.2. AI-Agent Telemetry Log Schema (`src/modules/logger/agent-logger.types.ts`)

```typescript
export type LogSeverity = 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export interface PlaywrightFailureContext {
	currentUrl: string;
	failedSelector?: string;
	httpStatus?: number;
	pageTitle?: string;
	domSnippet?: string; // Truncated innerHTML (max 2000 chars) around body/main
	screenshotPath?: string; // Relative path in ./logs/snapshots/
}

export interface AgentLogEntry {
	timestamp: string; // ISO-8601 UTC timestamp
	level: LogSeverity;
	traceId: string; // UUIDv4 correlating a single workflow execution
	module:
		| 'HH_BROWSER'
		| 'HH_MESSAGING'
		| 'LLM_SERVICE'
		| 'TELEGRAM_BOT'
		| 'SCHEDULER'
		| 'DB';
	action: string; // Deterministic action identifier, e.g., "SYNC_UNREAD_CHATS"
	message: string;
	durationMs?: number;
	metadata?: Record<string, unknown>;
	error?: {
		name: string;
		message: string;
		stack?: string;
		code?: string;
		DiagnosticHintForAgent: string; // Actionable hint telling the AI agent what likely failed
	};
	playwrightContext?: PlaywrightFailureContext;
}
```

### 3.3. Unread Chat & LLM Reply Contracts

```typescript
import { z } from 'zod';

export interface UnreadNegotiationItem {
	negotiationId: string;
	vacancyId: string;
	companyName: string;
	positionTitle: string;
	chatUrl: string;
	unreadMessages: string[];
	fullHistory: Array<{
		sender: 'employer' | 'applicant';
		text: string;
		timestamp?: string;
	}>;
}

export const LlmChatReplySchema = z.object({
	replyText: z.string().min(10).max(1500),
	confidenceScore: z.number().min(0).max(100),
	summaryOfIntent: z.string(),
});

export type LlmChatReply = z.infer<typeof LlmChatReplySchema>;
```

---

## 4. Sequential Implementation Steps

### Step 1: Implement AI-Readable Structured Logger (`src/modules/logger/agent-logger.service.ts`)

- **Dependencies:** `npm install pino`
- **Implementation:**

1. Ensure `./logs` and `./logs/snapshots` directories exist on startup using `node:fs/promises`.
2. Configure `pino` multistream to write all logs (`INFO` and above) to `./logs/agent-debug.jsonl` and `ERROR`/`FATAL` logs to `./logs/agent-errors.jsonl` with single-line JSON formatting (`\n` delimited).
3. Implement `logPlaywrightError(params: { traceId: string; module: AgentLogEntry['module']; action: string; error: unknown; page?: Page; failedSelector?: string; hint: string }): Promise<void>`.
4. Inside `logPlaywrightError`, if `page` is open, capture `page.url()`, `await page.title()`, extract `await page.locator('body').innerText()` (truncated to 2000 chars), save a screenshot to `./logs/snapshots/${traceId}.png`, and write the full `AgentLogEntry` JSON line.

### Step 2: Bypass 403 Forbidden via Persistent Browser Context (`src/modules/hh-hybrid/hh-browser.service.ts`)

- **Files touched:** `src/modules/hh-hybrid/hh-browser.service.ts`
- **Implementation:**

1. Remove direct unauthenticated `ofetch('https://api.hh.ru/...')` calls if they return `HTTP 403`.
2. Route vacancy search and description retrieval through the authenticated Playwright persistent context (`./hh-session`) by navigating to `https://hh.ru/search/vacancy?text=...` or executing `this.browserContext.request.get('https://hh.ru/shards/vacancy/search?...')` with browser cookies and standard Chromium `sec-ch-ua` headers.
3. Wrap every navigation and selector wait in a helper that invokes `agentLogger.logPlaywrightError(...)` on timeout or HTTP status `>= 400`.

### Step 3: Implement Unread Messages Scanner & Chat Sender (`src/modules/hh-hybrid/hh-messaging.service.ts`)

- **Files touched:** `src/modules/hh-hybrid/hh-messaging.service.ts`
- **Implementation:**

1. Implement `fetchUnreadNegotiations(traceId: string): Promise<UnreadNegotiationItem[]>`:

- Open a page in `this.browserContext` and navigate to `https://hh.ru/applicant/negotiations`.
- Locate negotiation rows containing unread indicators (`[data-qa="negotiations-item-unread"]`, badge counters, or unread class markers).
- For each unread row, extract `negotiationId`, `companyName`, `positionTitle`, and construct `chatUrl = https://hh.ru/applicant/negotiations/item/${negotiationId}`.
- Navigate to `chatUrl`, wait for chat messages container (`[data-qa="chatik-messages"]` or `[data-qa="chat-messages"]`), and extract all message bubbles (`employer` vs `applicant`). Doing so marks the message as read on HH and captures the exact text.

2. Implement `sendChatMessage(negotiationId: string, replyText: string, traceId: string): Promise<boolean>`:

- Navigate to `https://hh.ru/applicant/negotiations/item/${negotiationId}`.
- Locate chat textarea (`[data-qa="chatik-new-message-text"]` or `textarea[name="message"]`), fill `replyText`, and click the send button (`[data-qa="chatik-do-send"]`).
- Verify the new message bubble appears in the DOM and log `INFO` to `agent-debug.jsonl`.

### Step 4: Implement Local LLM Reply Generator (`src/modules/llm/llm-reply.service.ts`)

- **Files touched:** `src/modules/llm/llm-reply.service.ts`
- **Implementation:**

1. Implement `generateEmployerReply(params: { resumeRawText: string; companyName: string; positionTitle: string; chatHistory: UnreadNegotiationItem['fullHistory']; lastUnreadText: string }): Promise<LlmChatReply>`.
2. Send a POST request to Ollama (`http://127.0.0.1:11434/api/generate`) with `model: 'gemma4:64k'`, `format: 'json'`, `stream: false`.
3. System prompt must instruct the model to act as the candidate, answer the employer's specific questions politely and concisely in Russian using facts strictly from `resumeRawText`, and return JSON matching `LlmChatReplySchema`.
4. Validate response with `LlmChatReplySchema.parse(JSON.parse(raw.response))`. On validation failure, log to `agentLogger` with `DiagnosticHintForAgent: "LLM JSON output did not match LlmChatReplySchema"`.

### Step 5: Implement Telegram Notification & 2-Button Interactive Handler (`src/modules/telegram/telegram-messaging.handler.ts`)

- **Files touched:** `src/modules/telegram/telegram-messaging.handler.ts`, `src/modules/scheduler/scheduler.service.ts`, `src/main.ts`
- **Implementation:**

1. For each unread negotiation returned by `fetchUnreadNegotiations`, upsert into `negotiation_messages`.
2. Send a Telegram message to `TG_ADMIN_ID` formatted as:

```text
📩 Новое сообщение от работодателя!
🏢 Компания: {companyName}
💼 Вакансия: {positionTitle}

💬 Сообщение:
"{lastUnreadText}"

```

3. Attach a `grammy` `InlineKeyboard` with exactly two buttons:

- Button 1 (URL): `.url('🔗 Ответить самостоятельно', item.chatUrl)`
- Button 2 (Callback): `.text('🤖 Сгенерировать ИИ', `ai_reply:${item.negotiationId}`)`

4. Register callback query handler `bot.callbackQuery(/^ai_reply:(.+)$/, async (ctx) => ...)`:

- Answer callback query immediately (`Генерирую и отправляю ответ через Gemma 4...`).
- Load negotiation record from `negotiation_messages` and candidate resume from `user_profile`.
- Call `llmReplyService.generateEmployerReply(...)`.
- Call `hhMessagingService.sendChatMessage(negotiationId, result.replyText, traceId)`.
- Update DB `replyStatus = 'replied_by_ai'` and `aiGeneratedReply = result.replyText`.
- Edit the Telegram message to append the sent AI reply text and replace Button 2 with `✅ Ответ ИИ отправлен` (keeping Button 1 URL link active).

5. Wire `syncUnreadMessages()` to execute immediately on application startup in `src/main.ts` and every 10 minutes (`*/10 * * * *`) in `SchedulerService`.

---

## 5. Verification & Acceptance Criteria

Run the following deterministic checks after implementation:

1. **TypeScript 7 (`tsgo`) Typecheck:**

```bash
npx tsgo --noEmit

```

- **Expected:** Exit code `0`, zero type errors.

2. **Database Migration & Schema Verification:**

```bash
npx drizzle-kit push

```

- **Expected:** Table `negotiation_messages` created in `database.sqlite` with exit code `0`.

3. **AI Telemetry Log Verification:**

- Start the application (`node --experimental-strip-types src/main.ts`) and verify `./logs/agent-debug.jsonl` is created.
- Run:

```bash
node -e "const fs = require('fs'); const lines = fs.readFileSync('./logs/agent-debug.jsonl', 'utf8').trim().split('\n'); lines.forEach(l => JSON.parse(l)); console.log('VALID_JSONL_LINES:', lines.length);"

```

- **Expected:** Outputs `VALID_JSONL_LINES: <N>` with exit code `0` (every line is valid parseable JSON containing `timestamp`, `traceId`, `module`, and `action`).

4. **Unread Message & Telegram Buttons Smoke Test:**

- Trigger `syncUnreadMessages()` with a mock or live unread negotiation.
- Verify Telegram message arrives containing the exact employer text and 2 buttons: URL button pointing to `https://hh.ru/applicant/negotiations/item/<id>` and callback button `ai_reply:<id>`.

```

---

### Пояснение параметров и инструкция по использованию

1. **Как передать этот план ИИ-агенту:**
   * Создай в папке проекта файл **`AGENT_TELEMETRY_AND_MESSAGING.md`** и вставь в него скопированный блок выше.
   * Напиши агенту в Antigravity:
     > *«Прочитай файл `AGENT_TELEMETRY_AND_MESSAGING.md`. Выполни шаги 1–5 последовательно и проверь результат командами из раздела 5»*.

2. **Какие параметры можно настраивать под себя:**
   * **Частота проверки новых сообщений (`*/10 * * * *`):** В Шаге 5 указана проверка каждые 10 минут (плюс мгновенная проверка при включении приложения). Если хочешь проверять чаще (например, каждые 5 минут), достаточно поменять выражение таймера на `*/5 * * * *`.
   * **Папка с логами (`./logs/agent-debug.jsonl`):** Если вдруг в будущем что-то пойдет не так, тебе не придется самому искать ошибку в коде. Ты просто напишешь агенту в Antigravity: *«Проверь файл `logs/agent-errors.jsonl` и исправь последнюю ошибку»*, и агент сразу увидит точную причину и снимок страницы.

---

### Уточняющие вопросы

Чтобы убедиться, что мы учли все детали перед тем, как ты запустишь этот этап в работу, подскажи:
1. Хочешь ли ты, чтобы при нажатии на кнопку **«🤖 Сгенерировать ИИ»** бот отправлял ответ работодателю **сразу же**, или лучше сделать двухшаговый вариант: сначала бот генерирует текст и показывает его тебе в Telegram с кнопкой **«📤 Подтвердить отправку»**?
2. Нужно ли добавить в Telegram-бота команду (например, `/logs`), которая присылает последние 5 ошибок из `agent-errors.jsonl` прямо в чат, чтобы ты видел состояние программы с телефона?

<FollowUp label="Добавить предпросмотр ответа ИИ в Telegram перед отправкой работодателю?" query="Давай добавим шаг подтверждения: чтобы после нажатия 'Сгенерировать ИИ' бот сначала показывал сгенерированный ответ в Telegram с кнопками 'Отправить' и 'Перегенерировать', а также добавим команду /logs."/>
```

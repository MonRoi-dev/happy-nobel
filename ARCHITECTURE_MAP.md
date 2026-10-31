# Happy Nobel Architecture Map

> **Agent Note:** High-level topology index. For deep call graphs, symbol references, and AST dependencies, query the `codebase-memory` MCP server. Keep this file under 100 lines.

## 1. Domain Modules (`src/modules/`)

| Module | Responsibility | Public Facade / Services | DB Entities / Tables |
| :--- | :--- | :--- | :--- |
| `config-store` | App settings & company blacklist CRUD with case-insensitive substring matching | `ConfigStoreService`, `IConfigStore` | `app_settings`, `company_blacklist` |
| `logger` | JSONL telemetry & bounded 20MB rotation with traceId, token redaction, error logs, and circuit breaker | `AgentLoggerService`, `IAgentLoggerService`, `CircuitBreaker` (`circuit-breaker.util.ts`), `agentLogger` | Files: `agent-debug.jsonl`, `agent-errors.jsonl` |
| `llm` | Ollama (`gemma4:64k`) & OpenVINO NPU (`qwen2.5-3b-npu`) 1-pass evaluation, cover letter, question solving, AI chat reply, GPU load / Gaming Mode routing (`GamingModeService`), and NPU->GPU low-VRAM fallback | `LlmService`, `ILlmService`, `LlmReplyService`, `ILlmReplyService`, `GamingModeService`, `IGamingModeService` | N/A (stateless LLM client & NPU daemon supervisor) |
| `hh-hybrid` | Playwright session (`./hh-session`), warm browser pool (`WarmBrowserSession` in `hh-playwright.driver.ts`), search/details, FSM apply (`hh-apply-questions.helper.ts`), sync, bump, chat, captcha detection/solving | `HhHybridService`, `HhVacancyApplyFsm`, `HhMessagingService`, `HhCaptchaDetector`, `HhBrowserCaptchaService`, `WarmBrowserSession` | N/A (browser & HTTP) |
| `queue` | SQLite priority task queue with jitter, stale recovery, retry backoff, and captcha pause | `SqliteQueueService`, `QueueWorkerService`, `ISqliteQueueService` | `task_queue` |
| `parser` | Contact extraction (phones, emails, TG handles) from employer negotiation chats | `ContactExtractorService` | `negotiation_messages.extracted_contacts` |
| `telegram` | Grammy bot UI, wizards, blacklist inline UI, approval cards, AI reply, `/logs`, `/status` report, captcha alert, 429 flood-wait auto-retry & idempotency locks | `TelegramBotService`, `telegram-wizards.ts`, `telegram-blacklist.ts`, `telegram-approval.ts`, `telegram-messaging.handler.ts`, `telegram-status.handler.ts`, `telegram-captcha.handler.ts` | Interacts via `ConfigStoreService` & Drizzle |
| `scheduler` | Croner background jobs, blacklist & min match score gating, approval routing (`auto`/`manual`), unread sync, modular notifications | `SchedulerService`, `ISchedulerService`, `scheduler-notifications.helper.ts`, `scheduler.types.ts` | `application_records`, `negotiation_messages` |
| `exporter` | `.xlsx` report generation with `matchScore` and `aiReasoning`, Google Sheets export | `ExcelExporterService`, `GoogleSheetsExporterService` | `application_records` |

## 2. SQLite Schema (`src/db/schema.ts`)

| Table Name | Primary Key | Key Columns / Constraints | Purpose |
| :--- | :--- | :--- | :--- |
| `app_settings` | `key` (TEXT) | `value` (TEXT) | Runtime configuration (limits, thresholds, mode, bump, gaming mode, NPU host/model) |
| `company_blacklist` | `id` (INTEGER AUTO) | `companyName` (TEXT UNIQUE), `addedAt` | Employer names excluded from search & apply |
| `user_profile` | `id` (INTEGER AUTO) | `hhResumeTitle`, `resumeRawText`, `customPromptRules` | Candidate CV & custom prompt instructions |
| `search_filters` | `id` (INTEGER AUTO) | `queryText`, `excludedWords`, `areaId`, `schedule`, `salaryFrom` | HH search criteria |
| `application_records` | `id` (INTEGER AUTO) | `vacancyId` (UNIQUE), `status`, `matchScore`, `aiReasoning` | Tracked job applications and outcomes |
| `negotiation_messages` | `id` (INTEGER AUTO) | `negotiation_id` (UNIQUE), `reply_status`, `chat_url`, `last_unread_text`, `extracted_contacts` | Tracked employer chat messages & AI replies |
| `task_queue` | `id` (INTEGER AUTO) | `task_type`, `payload_json`, `status`, `priority`, `attempts`, `scheduled_for` | Bounded async task queue with jitter, retries, and captcha pausing |

## 3. Croner Background Jobs (`SchedulerService`)

| Job Name | Schedule Pattern | Interval / Purpose | Target Service Method |
| :--- | :--- | :--- | :--- |
| `autoApplyJob` | `*/10 * * * *` | Every 10 min: search vacancies, score with LLM, route auto/manual | `SchedulerService.runAutoApplyCycle()` |
| `syncNegotiationsJob` | `*/15 * * * *` | Every 15 min: sync HH negotiation statuses to SQLite | `SchedulerService.runNegotiationsSyncAndNotify()` |
| `syncUnreadMessagesJob` | `*/10 * * * *` | Every 10 min: sync unread employer messages & notify Telegram | `SchedulerService.runUnreadMessagesSync()` |
| `llmHealthJob` | `*/5 * * * *` | Every 5 min: ping Ollama server and verify model availability | `SchedulerService.checkLlmAvailabilityAndNotify()` |
| `autoBumpResumeJob` | `0 */4 * * *` | Every 4 hours: lift primary CV in HH search results | `SchedulerService.runAutoBumpResume()` |

## 4. Core Architectural Boundaries (Strict Rules)

- **SafeResult Pattern:** All service operations return `{ data: T, error: null } | { data: null, error: AppError }` without throwing unhandled exceptions.
- **Strict File Size Limits:** Every source and test file must remain strictly `< 1000 LOC`.
- **Browser Concurrency Mutex:** Playwright operations serialize via `runWithBrowserLock` mutex to prevent session corruption in `./hh-session`.
- **Bounded DB Queries:** All Drizzle ORM read queries MUST specify an explicit `.limit(N)`.
- **Decoupled Question Answering:** `HhVacancyApplyFsm` delegates question solving via injected `questionSolver` callback wired in `src/main.ts`.
- **Two-Step Human Approval:** Automated employer chat responses require explicit operator confirmation before dispatching.
- **Telegram 429 Flood-Wait & Idempotency:** grammY API transformer retries 429 flood errors automatically when `retry_after <= 30s`; concurrency sets (`inFlightApprovalIds`, `inFlightNegotiationIds`) block duplicate button clicks.
- **Resilience & Circuit Breaking:** `CircuitBreaker` protects external APIs; `AbortSignal` timeouts bound all LLM and HTTP requests; NPU automatically falls back to GPU low-VRAM mode (8192 ctx) on errors.
- **Zero-Comment Policy:** Strictly no inline or block comments in TypeScript source code; enforce clean typing and expressive naming.

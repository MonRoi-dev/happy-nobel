import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';

export type AppDatabase = NodeSQLiteDatabase;

export interface DatabaseContext {
  readonly sqlite: DatabaseSync;
  readonly db: AppDatabase;
  close(): void;
}

const SCHEMA_BOOTSTRAP_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS "app_settings" (
  "key" TEXT PRIMARY KEY NOT NULL,
  "value" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "user_profile" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "hhResumeTitle" TEXT NOT NULL,
  "resumeRawText" TEXT NOT NULL,
  "customPromptRules" TEXT
);

CREATE TABLE IF NOT EXISTS "search_filters" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "queryText" TEXT NOT NULL,
  "excludedWords" TEXT,
  "areaId" TEXT,
  "schedule" TEXT,
  "salaryFrom" INTEGER
);

CREATE TABLE IF NOT EXISTS "company_blacklist" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "companyName" TEXT NOT NULL UNIQUE,
  "addedAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "application_records" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "vacancyId" TEXT NOT NULL UNIQUE,
  "companyName" TEXT NOT NULL,
  "positionTitle" TEXT NOT NULL,
  "salaryText" TEXT NOT NULL,
  "vacancyUrl" TEXT NOT NULL,
  "coverLetter" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "matchScore" INTEGER,
  "aiReasoning" TEXT,
  "lastEmployerMessage" TEXT,
  "isNotified" INTEGER NOT NULL DEFAULT 0,
  "appliedAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_application_records_applied_at" ON "application_records" ("appliedAt");
CREATE INDEX IF NOT EXISTS "idx_application_records_is_notified" ON "application_records" ("isNotified");
CREATE INDEX IF NOT EXISTS "idx_application_records_status" ON "application_records" ("status");

CREATE TABLE IF NOT EXISTS "negotiation_messages" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "negotiation_id" TEXT NOT NULL UNIQUE,
  "vacancy_id" TEXT NOT NULL,
  "company_name" TEXT NOT NULL,
  "position_title" TEXT NOT NULL,
  "chat_url" TEXT NOT NULL,
  "last_unread_text" TEXT NOT NULL,
  "chat_history_json" TEXT NOT NULL,
  "extracted_contacts" TEXT,
  "telegram_message_id" INTEGER,
  "reply_status" TEXT NOT NULL DEFAULT 'unread_notified',
  "ai_generated_reply" TEXT,
  "updated_at" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_negotiation_messages_reply_status" ON "negotiation_messages" ("reply_status");

CREATE TABLE IF NOT EXISTS "task_queue" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "task_type" TEXT NOT NULL,
  "payload_json" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "priority" INTEGER NOT NULL DEFAULT 1,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "scheduled_for" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_task_queue_status_priority_scheduled" ON "task_queue" ("status", "priority", "scheduled_for");
`;

export function ensureNegotiationMessagesColumns(sqlite: DatabaseSync): void {
  const columns = sqlite
    .prepare('PRAGMA table_info("negotiation_messages")')
    .all() as Array<{ name?: unknown }>;

  const existingNames = new Set(
    columns
      .map((col) => (typeof col.name === 'string' ? col.name : ''))
      .filter((name) => name.length > 0)
  );

  if (!existingNames.has('extracted_contacts')) {
    sqlite.exec('ALTER TABLE "negotiation_messages" ADD COLUMN "extracted_contacts" TEXT;');
  }
}

function ensureApplicationRecordsColumns(sqlite: DatabaseSync): void {
  const columns = sqlite
    .prepare('PRAGMA table_info("application_records")')
    .all() as Array<{ name?: unknown }>;

  const existingNames = new Set(
    columns
      .map((col) => (typeof col.name === 'string' ? col.name : ''))
      .filter((name) => name.length > 0)
  );

  if (!existingNames.has('matchScore')) {
    sqlite.exec('ALTER TABLE "application_records" ADD COLUMN "matchScore" INTEGER;');
  }

  if (!existingNames.has('aiReasoning')) {
    sqlite.exec('ALTER TABLE "application_records" ADD COLUMN "aiReasoning" TEXT;');
  }
}

export function createDatabaseContext(customDbFileName = 'database.sqlite'): DatabaseContext {
  const isMemory = customDbFileName === ':memory:';
  let sqlite: DatabaseSync;

  if (isMemory) {
    sqlite = new DatabaseSync(':memory:');
  } else {
    const safeFileName = path.basename(customDbFileName);
    const workspaceRoot = path.resolve(process.cwd());
    const resolvedDbPath = path.resolve(workspaceRoot, safeFileName);

    if (!resolvedDbPath.startsWith(workspaceRoot + path.sep)) {
      throw new Error('Invalid database path boundary violation');
    }

    sqlite = new DatabaseSync(resolvedDbPath);
  }

  sqlite.exec(SCHEMA_BOOTSTRAP_SQL);
  ensureApplicationRecordsColumns(sqlite);
  ensureNegotiationMessagesColumns(sqlite);

  const db = drizzle({ client: sqlite });

  return {
    sqlite,
    db,
    close(): void {
      sqlite.close();
    },
  };
}

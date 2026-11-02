import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const userProfiles = sqliteTable('user_profile', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  hhResumeTitle: text('hhResumeTitle').notNull(),
  resumeRawText: text('resumeRawText').notNull(),
  customPromptRules: text('customPromptRules'),
});

export const userProfilesExtended = sqliteTable('user_profile', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  hhResumeTitle: text('hhResumeTitle').notNull(),
  resumeRawText: text('resumeRawText').notNull(),
  customPromptRules: text('customPromptRules'),
  resumePdfPath: text('resumePdfPath'),
  resumeTelegramFileId: text('resumeTelegramFileId'),
  applicantName: text('applicantName'),
  applicantEmail: text('applicantEmail'),
  applicantPhone: text('applicantPhone'),
  applicantTelegram: text('applicantTelegram'),
});

export const searchFilters = sqliteTable('search_filters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  queryText: text('queryText').notNull(),
  excludedWords: text('excludedWords'),
  areaId: text('areaId'),
  schedule: text('schedule'),
  salaryFrom: integer('salaryFrom'),
});

export const companyBlacklist = sqliteTable('company_blacklist', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  companyName: text('companyName').notNull().unique(),
  addedAt: text('addedAt').notNull(),
});

export const APPLICATION_STATUSES = [
  'response',
  'invitation',
  'discard',
  'viewed',
  'pending_approval',
  'skipped_low_score',
  'skipped_user',
  'applied_external',
  'pending_external_captcha',
  'tg_contact_notified',
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const applicationRecords = sqliteTable('application_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vacancyId: text('vacancyId').notNull().unique(),
  companyName: text('companyName').notNull(),
  positionTitle: text('positionTitle').notNull(),
  salaryText: text('salaryText').notNull(),
  vacancyUrl: text('vacancyUrl').notNull(),
  coverLetter: text('coverLetter').notNull(),
  status: text('status').notNull(),
  matchScore: integer('matchScore'),
  aiReasoning: text('aiReasoning'),
  lastEmployerMessage: text('lastEmployerMessage'),
  isNotified: integer('isNotified', { mode: 'boolean' }).notNull().default(false),
  appliedAt: text('appliedAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
});

export type AppSetting = typeof appSettings.$inferSelect;
export type NewAppSetting = typeof appSettings.$inferInsert;

export type UserProfile = typeof userProfiles.$inferSelect;
export type NewUserProfile = typeof userProfiles.$inferInsert;

export type ExtendedUserProfile = typeof userProfilesExtended.$inferSelect;
export type NewExtendedUserProfile = typeof userProfilesExtended.$inferInsert;

export type SearchFilter = typeof searchFilters.$inferSelect;
export type NewSearchFilter = typeof searchFilters.$inferInsert;

export type CompanyBlacklistItem = typeof companyBlacklist.$inferSelect;
export type NewCompanyBlacklistItem = typeof companyBlacklist.$inferInsert;

export type ApplicationRecord = typeof applicationRecords.$inferSelect;
export type NewApplicationRecord = typeof applicationRecords.$inferInsert;

export const NEGOTIATION_REPLY_STATUSES = [
  'unread_notified',
  'draft_generated',
  'replied_by_ai',
  'replied_manually',
  'failed',
] as const;

export type NegotiationReplyStatus = (typeof NEGOTIATION_REPLY_STATUSES)[number];

export const negotiationMessages = sqliteTable('negotiation_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  negotiationId: text('negotiation_id').notNull().unique(),
  vacancyId: text('vacancy_id').notNull(),
  companyName: text('company_name').notNull(),
  positionTitle: text('position_title').notNull(),
  chatUrl: text('chat_url').notNull(),
  lastUnreadText: text('last_unread_text').notNull(),
  chatHistoryJson: text('chat_history_json').notNull(),
  extractedContactsJson: text('extracted_contacts'),
  telegramMessageId: integer('telegram_message_id'),
  replyStatus: text('reply_status').notNull().default('unread_notified'),
  aiGeneratedReply: text('ai_generated_reply'),
  updatedAt: text('updated_at').notNull(),
});

export type NegotiationMessageRecord = typeof negotiationMessages.$inferSelect;
export type NewNegotiationMessageRecord = typeof negotiationMessages.$inferInsert;

export const TASK_TYPES = [
  'SEND_TG_MESSAGE',
  'APPLY_VACANCY',
  'SYNC_NEGOTIATIONS',
  'GENERATE_AI_REPLY',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_QUEUE_STATUSES = [
  'pending',
  'processing',
  'paused_captcha',
  'completed',
  'failed',
] as const;

export type TaskQueueStatus = (typeof TASK_QUEUE_STATUSES)[number];

export const taskQueue = sqliteTable('task_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskType: text('task_type').notNull(),
  payloadJson: text('payload_json').notNull(),
  status: text('status').notNull().default('pending'),
  priority: integer('priority').notNull().default(1),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  scheduledFor: text('scheduled_for').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type TaskQueueRecord = typeof taskQueue.$inferSelect;
export type NewTaskQueueRecord = typeof taskQueue.$inferInsert;


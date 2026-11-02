import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppDatabase } from '../../db/index.ts';
import {
  appSettings,
  companyBlacklist,
  type AppSetting,
  type CompanyBlacklistItem,
} from '../../db/schema.ts';

export type { CompanyBlacklistItem };

export const APP_SETTING_KEYS = [
  'TG_BOT_TOKEN',
  'TG_ADMIN_ID',
  'HH_IS_LOGGED_IN',
  'LLM_BASE_URL',
  'LLM_MODEL_NAME',
  'AUTO_APPLY_ENABLED',
  'DAILY_LIMIT',
  'MIN_MATCH_SCORE',
  'APPROVAL_MODE',
  'AUTO_BUMP_RESUME',
  'ANSWER_QUESTIONS_ENABLED',
  'SKIP_FOREIGN_VACANCIES',
  'GAMING_MODE',
  'NPU_BASE_URL',
  'NPU_MODEL_NAME',
  'GPU_LOAD_THRESHOLD',
  'TG_CHANNEL_AUTORESPONDER_ENABLED',
  'TG_JOB_CHANNELS',
  'LAST_RESUME_BUMP_TIME',
] as const;

export const AppSettingKeySchema = z.enum(APP_SETTING_KEYS);
export type AppSettingKey = z.infer<typeof AppSettingKeySchema>;

export const GamingModeSchema = z.enum(['auto', 'on', 'off']);
export type GamingMode = z.infer<typeof GamingModeSchema>;

export const GpuLoadThresholdSchema = z.coerce
  .number()
  .int()
  .min(5)
  .max(95);

export const TelegramBotTokenSchema = z
  .string()
  .trim()
  .regex(/^\d+:[A-Za-z0-9_-]{20,}$/, 'Invalid Telegram Bot Token format');

export const TelegramAdminIdSchema = z
  .string()
  .trim()
  .regex(/^\d+$/, 'Telegram Admin ID must contain only digits');

export const DailyLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(100);

export const MinMatchScoreSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(100);

export const ApprovalModeSchema = z.enum(['auto', 'manual']);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

const BOOLEAN_STRING_SETTING_KEYS = new Set<AppSettingKey>([
  'AUTO_APPLY_ENABLED',
  'HH_IS_LOGGED_IN',
  'AUTO_BUMP_RESUME',
  'ANSWER_QUESTIONS_ENABLED',
  'SKIP_FOREIGN_VACANCIES',
  'TG_CHANNEL_AUTORESPONDER_ENABLED',
]);

export function normalizeTgJobChannelUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const urlMatch = trimmed.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?@?([a-zA-Z0-9_]{4,64})\/?$/i);
  if (urlMatch?.[1]) {
    return `https://t.me/${urlMatch[1]}`;
  }
  const slugMatch = trimmed.match(/^@?([a-zA-Z0-9_]{4,64})$/);
  if (slugMatch?.[1]) {
    return `https://t.me/${slugMatch[1]}`;
  }
  return null;
}

export const PaginationSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
});

export type PaginationOptions = z.input<typeof PaginationSchema>;

export interface SafeResult<T> {
  readonly data: T | null;
  readonly error: string | null;
}

export const DEFAULT_APP_SETTINGS: Readonly<Partial<Record<AppSettingKey, string>>> = {
  HH_IS_LOGGED_IN: 'false',
  LLM_BASE_URL: 'http://127.0.0.1:11434',
  LLM_MODEL_NAME: 'gemma4:64k',
  AUTO_APPLY_ENABLED: 'false',
  DAILY_LIMIT: '50',
  MIN_MATCH_SCORE: '70',
  APPROVAL_MODE: 'auto',
  AUTO_BUMP_RESUME: 'true',
  ANSWER_QUESTIONS_ENABLED: 'true',
  SKIP_FOREIGN_VACANCIES: 'true',
  GAMING_MODE: 'auto',
  NPU_BASE_URL: 'http://127.0.0.1:11435',
  NPU_MODEL_NAME: 'qwen2.5-3b-npu',
  GPU_LOAD_THRESHOLD: '25',
  TG_CHANNEL_AUTORESPONDER_ENABLED: 'true',
  TG_JOB_CHANNELS: 'https://t.me/node_js_jobs_vakansii',
  LAST_RESUME_BUMP_TIME: '0',
};

export interface IConfigStore {
  ensureDefaults(): SafeResult<boolean>;
  get(key: AppSettingKey): SafeResult<string>;
  set(key: AppSettingKey, rawValue: string): SafeResult<string>;
  list(options?: PaginationOptions): SafeResult<AppSetting[]>;
  getBootstrapCredentials(): SafeResult<{ botToken: string; adminId: string }>;
  saveBootstrapCredentials(botToken: string, adminId: string): SafeResult<{ botToken: string; adminId: string }>;
  getDailyLimit(): SafeResult<number>;
  setDailyLimit(limit: number): SafeResult<number>;
  getMinMatchScore(): SafeResult<number>;
  setMinMatchScore(score: number): SafeResult<number>;
  getApprovalMode(): SafeResult<ApprovalMode>;
  setApprovalMode(mode: ApprovalMode): SafeResult<ApprovalMode>;
  isAutoBumpResumeEnabled(): SafeResult<boolean>;
  setAutoBumpResumeEnabled(enabled: boolean): SafeResult<boolean>;
  getLastResumeBumpTime(): SafeResult<number>;
  setLastResumeBumpTime(timestamp: number): SafeResult<number>;
  isAnswerQuestionsEnabled(): SafeResult<boolean>;
  setAnswerQuestionsEnabled(enabled: boolean): SafeResult<boolean>;
  isSkipForeignVacanciesEnabled(): SafeResult<boolean>;
  setSkipForeignVacanciesEnabled(enabled: boolean): SafeResult<boolean>;
  isTgChannelEnabled?(): SafeResult<boolean>;
  setTgChannelEnabled?(enabled: boolean): SafeResult<boolean>;
  getTgJobChannels?(): SafeResult<string[]>;
  setTgJobChannels?(channels: ReadonlyArray<string>): SafeResult<string[]>;
  getGamingMode?(): SafeResult<GamingMode>;
  setGamingMode?(mode: GamingMode): SafeResult<GamingMode>;
  getGpuLoadThreshold?(): SafeResult<number>;
  setGpuLoadThreshold?(threshold: number): SafeResult<number>;
  listBlacklistedCompanies(options?: PaginationOptions): SafeResult<CompanyBlacklistItem[]>;
  addBlacklistedCompany(companyName: string): SafeResult<CompanyBlacklistItem>;
  removeBlacklistedCompany(id: number): SafeResult<boolean>;
  isCompanyBlacklisted(employerName: string | null | undefined): SafeResult<boolean>;
}

export class ConfigStoreService implements IConfigStore {
  private readonly db: AppDatabase;

  constructor(db: AppDatabase) {
    this.db = db;
  }

  public ensureDefaults(): SafeResult<boolean> {
    try {
      const entries = Object.entries(DEFAULT_APP_SETTINGS) as Array<[AppSettingKey, string]>;
      for (const [key, defaultValue] of entries) {
        const existing = this.db
          .select()
          .from(appSettings)
          .where(eq(appSettings.key, key))
          .limit(1)
          .get();

        if (!existing) {
          this.db
            .insert(appSettings)
            .values({ key, value: defaultValue })
            .run();
        }
      }
      return { data: true, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to initialize default settings';
      return { data: null, error: message };
    }
  }

  public get(key: AppSettingKey): SafeResult<string> {
    const parsedKey = AppSettingKeySchema.safeParse(key);
    if (!parsedKey.success) {
      return { data: null, error: 'Invalid configuration key' };
    }

    try {
      const record = this.db
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, parsedKey.data))
        .limit(1)
        .get();

      if (!record) {
        const fallback = DEFAULT_APP_SETTINGS[parsedKey.data] ?? null;
        return { data: fallback, error: null };
      }

      return { data: record.value, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Database read failure';
      return { data: null, error: message };
    }
  }

  public set(key: AppSettingKey, rawValue: string): SafeResult<string> {
    const parsedKey = AppSettingKeySchema.safeParse(key);
    if (!parsedKey.success) {
      return { data: null, error: 'Invalid configuration key' };
    }

    const validatedValue = this.validateValueByKey(parsedKey.data, rawValue);
    if (validatedValue.error !== null || validatedValue.data === null) {
      return { data: null, error: validatedValue.error ?? 'Validation error' };
    }

    try {
      this.db
        .insert(appSettings)
        .values({ key: parsedKey.data, value: validatedValue.data })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: validatedValue.data },
        })
        .run();

      return { data: validatedValue.data, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Database write failure';
      return { data: null, error: message };
    }
  }

  public list(options?: PaginationOptions): SafeResult<AppSetting[]> {
    const parsedPagination = PaginationSchema.safeParse(options ?? {});
    if (!parsedPagination.success) {
      return { data: null, error: 'Invalid pagination parameters' };
    }

    try {
      const rows = this.db
        .select()
        .from(appSettings)
        .limit(parsedPagination.data.limit)
        .offset(parsedPagination.data.offset)
        .all();

      return { data: rows, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to list settings';
      return { data: null, error: message };
    }
  }

  public getBootstrapCredentials(): SafeResult<{ botToken: string; adminId: string }> {
    const tokenResult = this.get('TG_BOT_TOKEN');
    if (tokenResult.error) {
      return { data: null, error: tokenResult.error };
    }

    const adminResult = this.get('TG_ADMIN_ID');
    if (adminResult.error) {
      return { data: null, error: adminResult.error };
    }

    if (!tokenResult.data || !adminResult.data) {
      return { data: null, error: null };
    }

    const tokenCheck = TelegramBotTokenSchema.safeParse(tokenResult.data);
    const adminCheck = TelegramAdminIdSchema.safeParse(adminResult.data);

    if (!tokenCheck.success || !adminCheck.success) {
      return { data: null, error: null };
    }

    return {
      data: {
        botToken: tokenCheck.data,
        adminId: adminCheck.data,
      },
      error: null,
    };
  }

  public saveBootstrapCredentials(
    botToken: string,
    adminId: string
  ): SafeResult<{ botToken: string; adminId: string }> {
    const tokenSave = this.set('TG_BOT_TOKEN', botToken);
    if (tokenSave.error || !tokenSave.data) {
      return { data: null, error: tokenSave.error ?? 'Invalid TG_BOT_TOKEN' };
    }

    const adminSave = this.set('TG_ADMIN_ID', adminId);
    if (adminSave.error || !adminSave.data) {
      return { data: null, error: adminSave.error ?? 'Invalid TG_ADMIN_ID' };
    }

    return {
      data: {
        botToken: tokenSave.data,
        adminId: adminSave.data,
      },
      error: null,
    };
  }

  public getDailyLimit(): SafeResult<number> {
    const raw = this.get('DAILY_LIMIT');
    if (raw.error) {
      return { data: null, error: raw.error };
    }

    const parsed = DailyLimitSchema.safeParse(raw.data ?? '50');
    if (!parsed.success) {
      return { data: 50, error: null };
    }

    return { data: parsed.data, error: null };
  }

  public setDailyLimit(limit: number): SafeResult<number> {
    const clamped = Math.max(1, Math.min(100, Math.trunc(limit)));
    const saved = this.set('DAILY_LIMIT', String(clamped));
    if (saved.error) {
      return { data: null, error: saved.error };
    }

    return { data: clamped, error: null };
  }

  public getMinMatchScore(): SafeResult<number> {
    const raw = this.get('MIN_MATCH_SCORE');
    if (raw.error) {
      return { data: null, error: raw.error };
    }

    const parsed = MinMatchScoreSchema.safeParse(raw.data ?? '70');
    if (!parsed.success) {
      return { data: 70, error: null };
    }

    return { data: parsed.data, error: null };
  }

  public setMinMatchScore(score: number): SafeResult<number> {
    const clamped = Math.max(0, Math.min(100, Math.trunc(score)));
    const saved = this.set('MIN_MATCH_SCORE', String(clamped));
    if (saved.error) {
      return { data: null, error: saved.error };
    }

    return { data: clamped, error: null };
  }

  public getApprovalMode(): SafeResult<ApprovalMode> {
    const raw = this.get('APPROVAL_MODE');
    if (raw.error) {
      return { data: null, error: raw.error };
    }

    const parsed = ApprovalModeSchema.safeParse(raw.data ?? 'auto');
    if (!parsed.success) {
      return { data: 'auto', error: null };
    }

    return { data: parsed.data, error: null };
  }

  public setApprovalMode(mode: ApprovalMode): SafeResult<ApprovalMode> {
    const saved = this.set('APPROVAL_MODE', mode);
    if (saved.error) {
      return { data: null, error: saved.error };
    }

    return { data: mode, error: null };
  }

  public isAutoBumpResumeEnabled(): SafeResult<boolean> {
    const raw = this.get('AUTO_BUMP_RESUME');
    if (raw.error) {
      return { data: null, error: raw.error };
    }

    return { data: raw.data !== 'false', error: null };
  }

  public setAutoBumpResumeEnabled(enabled: boolean): SafeResult<boolean> {
    const saved = this.set('AUTO_BUMP_RESUME', enabled ? 'true' : 'false');
    if (saved.error) {
      return { data: null, error: saved.error };
    }

    return { data: enabled, error: null };
  }

  public getLastResumeBumpTime(): SafeResult<number> {
    const res = this.get('LAST_RESUME_BUMP_TIME');
    if (res.error) {
      return { data: 0, error: null };
    }
    const val = Number.parseInt(res.data ?? '0', 10);
    return { data: Number.isNaN(val) ? 0 : val, error: null };
  }

  public setLastResumeBumpTime(timestamp: number): SafeResult<number> {
    const res = this.set('LAST_RESUME_BUMP_TIME', String(timestamp));
    if (res.error) {
      return { data: null, error: res.error };
    }
    return { data: timestamp, error: null };
  }

  public isAnswerQuestionsEnabled(): SafeResult<boolean> {
    const raw = this.get('ANSWER_QUESTIONS_ENABLED');
    if (raw.error) {
      return { data: null, error: raw.error };
    }

    return { data: raw.data !== 'false', error: null };
  }

  public setAnswerQuestionsEnabled(enabled: boolean): SafeResult<boolean> {
    const saved = this.set('ANSWER_QUESTIONS_ENABLED', enabled ? 'true' : 'false');
    if (saved.error) {
      return { data: null, error: saved.error };
    }

    return { data: enabled, error: null };
  }

  public isSkipForeignVacanciesEnabled(): SafeResult<boolean> {
    const raw = this.get('SKIP_FOREIGN_VACANCIES');
    if (raw.error) {
      return { data: null, error: raw.error };
    }

    return { data: raw.data !== 'false', error: null };
  }

  public setSkipForeignVacanciesEnabled(enabled: boolean): SafeResult<boolean> {
    const saved = this.set('SKIP_FOREIGN_VACANCIES', enabled ? 'true' : 'false');
    if (saved.error) {
      return { data: null, error: saved.error };
    }

    return { data: enabled, error: null };
  }

  public isTgChannelEnabled(): SafeResult<boolean> {
    const raw = this.get('TG_CHANNEL_AUTORESPONDER_ENABLED');
    if (raw.error) {
      return { data: null, error: raw.error };
    }

    return { data: raw.data !== 'false', error: null };
  }

  public setTgChannelEnabled(enabled: boolean): SafeResult<boolean> {
    const saved = this.set('TG_CHANNEL_AUTORESPONDER_ENABLED', enabled ? 'true' : 'false');
    if (saved.error) {
      return { data: null, error: saved.error };
    }

    return { data: enabled, error: null };
  }

  public getTgJobChannels(): SafeResult<string[]> {
    const raw = this.get('TG_JOB_CHANNELS');
    if (raw.error) {
      return { data: null, error: raw.error };
    }
    const source = raw.data ?? 'https://t.me/node_js_jobs_vakansii';
    const seen = new Set<string>();
    const normalizedList: string[] = [];
    for (const part of source.split(/[\n,;]+/)) {
      const normalized = normalizeTgJobChannelUrl(part);
      if (normalized && !seen.has(normalized.toLowerCase())) {
        seen.add(normalized.toLowerCase());
        normalizedList.push(normalized);
      }
    }
    return {
      data: normalizedList.length > 0 ? normalizedList : ['https://t.me/node_js_jobs_vakansii'],
      error: null,
    };
  }

  public setTgJobChannels(channels: ReadonlyArray<string>): SafeResult<string[]> {
    const seen = new Set<string>();
    const normalizedList: string[] = [];
    for (const item of channels) {
      const normalized = normalizeTgJobChannelUrl(item);
      if (normalized && !seen.has(normalized.toLowerCase())) {
        seen.add(normalized.toLowerCase());
        normalizedList.push(normalized);
      }
    }
    if (normalizedList.length === 0) {
      return { data: null, error: 'Не указано ни одного корректного Telegram-канала' };
    }
    const saved = this.set('TG_JOB_CHANNELS', normalizedList.join(','));
    if (saved.error) {
      return { data: null, error: saved.error };
    }
    return { data: normalizedList, error: null };
  }

  public getGamingMode(): SafeResult<GamingMode> {
    const raw = this.get('GAMING_MODE');
    if (raw.error) {
      return { data: null, error: raw.error };
    }

    const parsed = GamingModeSchema.safeParse(raw.data ?? 'auto');
    if (!parsed.success) {
      return { data: 'auto', error: null };
    }

    return { data: parsed.data, error: null };
  }

  public setGamingMode(mode: GamingMode): SafeResult<GamingMode> {
    const saved = this.set('GAMING_MODE', mode);
    if (saved.error) {
      return { data: null, error: saved.error };
    }

    return { data: mode, error: null };
  }

  public getGpuLoadThreshold(): SafeResult<number> {
    const raw = this.get('GPU_LOAD_THRESHOLD');
    if (raw.error) {
      return { data: null, error: raw.error };
    }

    const parsed = GpuLoadThresholdSchema.safeParse(raw.data ?? '25');
    if (!parsed.success) {
      return { data: 25, error: null };
    }

    return { data: parsed.data, error: null };
  }

  public setGpuLoadThreshold(threshold: number): SafeResult<number> {
    const clamped = Math.max(5, Math.min(95, Math.trunc(threshold)));
    const saved = this.set('GPU_LOAD_THRESHOLD', String(clamped));
    if (saved.error) {
      return { data: null, error: saved.error };
    }

    return { data: clamped, error: null };
  }

  public listBlacklistedCompanies(options?: PaginationOptions): SafeResult<CompanyBlacklistItem[]> {
    const parsedPagination = PaginationSchema.safeParse(options ?? {});
    if (!parsedPagination.success) {
      return { data: null, error: 'Invalid pagination parameters' };
    }

    try {
      const rows = this.db
        .select()
        .from(companyBlacklist)
        .orderBy(asc(companyBlacklist.id))
        .limit(parsedPagination.data.limit)
        .offset(parsedPagination.data.offset)
        .all();

      return { data: rows, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to list blacklisted companies';
      return { data: null, error: message };
    }
  }

  public addBlacklistedCompany(companyName: string): SafeResult<CompanyBlacklistItem> {
    const normalized = companyName.trim().toLowerCase();
    if (normalized.length === 0) {
      return { data: null, error: 'Название компании не может быть пустым' };
    }

    try {
      const existing = this.db
        .select()
        .from(companyBlacklist)
        .where(eq(companyBlacklist.companyName, normalized))
        .limit(1)
        .get();

      if (existing) {
        return { data: existing, error: null };
      }

      this.db
        .insert(companyBlacklist)
        .values({
          companyName: normalized,
          addedAt: new Date().toISOString(),
        })
        .run();

      const inserted = this.db
        .select()
        .from(companyBlacklist)
        .where(eq(companyBlacklist.companyName, normalized))
        .limit(1)
        .get();

      if (!inserted) {
        return { data: null, error: 'Failed to retrieve inserted company' };
      }

      return { data: inserted, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add blacklisted company';
      return { data: null, error: message };
    }
  }

  public removeBlacklistedCompany(id: number): SafeResult<boolean> {
    if (!Number.isInteger(id) || id <= 0) {
      return { data: null, error: 'Invalid company ID' };
    }

    try {
      const existing = this.db
        .select()
        .from(companyBlacklist)
        .where(eq(companyBlacklist.id, id))
        .limit(1)
        .get();

      if (!existing) {
        return { data: false, error: null };
      }

      this.db
        .delete(companyBlacklist)
        .where(eq(companyBlacklist.id, id))
        .run();

      return { data: true, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove blacklisted company';
      return { data: null, error: message };
    }
  }

  public isCompanyBlacklisted(employerName: string | null | undefined): SafeResult<boolean> {
    const normalizedEmployer = (employerName ?? '').trim().toLowerCase();
    if (normalizedEmployer.length === 0) {
      return { data: false, error: null };
    }

    try {
      const rows = this.db
        .select()
        .from(companyBlacklist)
        .limit(500)
        .all();

      const isBlacklisted = rows.some(
        (row) => row.companyName.length > 0 && normalizedEmployer.includes(row.companyName)
      );

      return { data: isBlacklisted, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to check company blacklist status';
      return { data: null, error: message };
    }
  }

  private validateValueByKey(key: AppSettingKey, rawValue: string): SafeResult<string> {
    const trimmed = rawValue.trim();
    if (trimmed.length === 0) {
      return { data: null, error: `Setting ${key} cannot be empty` };
    }

    if (key === 'TG_BOT_TOKEN') {
      const parsed = TelegramBotTokenSchema.safeParse(trimmed);
      return parsed.success
        ? { data: parsed.data, error: null }
        : { data: null, error: parsed.error.issues[0]?.message ?? 'Invalid TG_BOT_TOKEN' };
    }

    if (key === 'TG_ADMIN_ID') {
      const parsed = TelegramAdminIdSchema.safeParse(trimmed);
      return parsed.success
        ? { data: parsed.data, error: null }
        : { data: null, error: parsed.error.issues[0]?.message ?? 'Invalid TG_ADMIN_ID' };
    }

    if (key === 'DAILY_LIMIT') {
      const parsed = DailyLimitSchema.safeParse(trimmed);
      return parsed.success
        ? { data: String(parsed.data), error: null }
        : { data: null, error: 'DAILY_LIMIT must be an integer between 1 and 100' };
    }

    if (key === 'MIN_MATCH_SCORE') {
      const parsed = MinMatchScoreSchema.safeParse(trimmed);
      return parsed.success
        ? { data: String(parsed.data), error: null }
        : { data: null, error: 'MIN_MATCH_SCORE must be an integer between 0 and 100' };
    }

    if (key === 'APPROVAL_MODE') {
      const parsed = ApprovalModeSchema.safeParse(trimmed);
      return parsed.success
        ? { data: parsed.data, error: null }
        : { data: null, error: 'APPROVAL_MODE must be "auto" or "manual"' };
    }

    if (BOOLEAN_STRING_SETTING_KEYS.has(key)) {
      if (trimmed !== 'true' && trimmed !== 'false') {
        return { data: null, error: `${key} must be "true" or "false"` };
      }
      return { data: trimmed, error: null };
    }

    if (key === 'LLM_BASE_URL' || key === 'NPU_BASE_URL') {
      const urlSchema = z.string().url();
      const parsed = urlSchema.safeParse(trimmed);
      return parsed.success
        ? { data: parsed.data, error: null }
        : { data: null, error: `${key} must be a valid URL` };
    }

    if (key === 'GAMING_MODE') {
      const parsed = GamingModeSchema.safeParse(trimmed);
      return parsed.success
        ? { data: parsed.data, error: null }
        : { data: null, error: 'GAMING_MODE must be "auto", "on", or "off"' };
    }

    if (key === 'GPU_LOAD_THRESHOLD') {
      const parsed = GpuLoadThresholdSchema.safeParse(trimmed);
      return parsed.success
        ? { data: String(parsed.data), error: null }
        : { data: null, error: 'GPU_LOAD_THRESHOLD must be an integer between 5 and 95' };
    }

    return { data: trimmed, error: null };
  }
}

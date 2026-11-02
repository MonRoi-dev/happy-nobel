import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createDatabaseContext, ensureUserProfileColumns } from '../src/db/index.ts';
import { APPLICATION_STATUSES, userProfilesExtended } from '../src/db/schema.ts';
import { ConfigStoreService } from '../src/modules/config-store/config-store.service.ts';

describe('Task 1: SQLite Schema & ConfigStore for TG Channel Autoresponder', () => {
  it('migrates legacy user_profile table with PDF and applicant contact columns idempotently', () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      CREATE TABLE "user_profile" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        "hhResumeTitle" TEXT NOT NULL,
        "resumeRawText" TEXT NOT NULL,
        "customPromptRules" TEXT
      );
    `);

    ensureUserProfileColumns(sqlite);
    ensureUserProfileColumns(sqlite);

    const cols = sqlite.prepare('PRAGMA table_info("user_profile")').all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));

    assert.equal(colNames.has('resumePdfPath'), true);
    assert.equal(colNames.has('resumeTelegramFileId'), true);
    assert.equal(colNames.has('applicantName'), true);
    assert.equal(colNames.has('applicantEmail'), true);
    assert.equal(colNames.has('applicantPhone'), true);
    assert.equal(colNames.has('applicantTelegram'), true);
    sqlite.close();
  });

  it('stores and retrieves extended user_profile fields and new application statuses', () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      assert.equal(APPLICATION_STATUSES.includes('applied_external'), true);
      assert.equal(APPLICATION_STATUSES.includes('pending_external_captcha'), true);
      assert.equal(APPLICATION_STATUSES.includes('tg_contact_notified'), true);

      ctx.db
        .insert(userProfilesExtended)
        .values({
          hhResumeTitle: 'Senior Node.js Engineer',
          resumeRawText: 'Node.js TypeScript PostgreSQL 6 years experience',
          customPromptRules: null,
          resumePdfPath: '/abs/path/data/resumes/candidate-cv.pdf',
          resumeTelegramFileId: 'BQACAgIAAxkBAAI',
          applicantName: 'Ivan Petrov',
          applicantEmail: 'ivan@example.com',
          applicantPhone: '+79991234567',
          applicantTelegram: '@ivan_dev',
        })
        .run();

      const saved = ctx.db.select().from(userProfilesExtended).limit(1).get();
      assert.ok(saved);
      assert.equal(saved.resumePdfPath, '/abs/path/data/resumes/candidate-cv.pdf');
      assert.equal(saved.resumeTelegramFileId, 'BQACAgIAAxkBAAI');
      assert.equal(saved.applicantName, 'Ivan Petrov');
      assert.equal(saved.applicantEmail, 'ivan@example.com');
      assert.equal(saved.applicantPhone, '+79991234567');
      assert.equal(saved.applicantTelegram, '@ivan_dev');
    } finally {
      ctx.close();
    }
  });

  it('manages TG_CHANNEL_AUTORESPONDER_ENABLED and TG_JOB_CHANNELS in ConfigStoreService', () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const store = new ConfigStoreService(ctx.db);
      store.ensureDefaults();

      assert.equal(store.isTgChannelEnabled().data, true);
      assert.deepEqual(store.getTgJobChannels().data, ['https://t.me/node_js_jobs_vakansii']);

      const toggled = store.setTgChannelEnabled(false);
      assert.equal(toggled.error, null);
      assert.equal(store.isTgChannelEnabled().data, false);

      const updatedChannels = store.setTgJobChannels([
        'https://t.me/node_js_jobs_vakansii',
        '@ts_jobs_channel',
      ]);
      assert.equal(updatedChannels.error, null);
      assert.deepEqual(store.getTgJobChannels().data, [
        'https://t.me/node_js_jobs_vakansii',
        'https://t.me/ts_jobs_channel',
      ]);
    } finally {
      ctx.close();
    }
  });
});

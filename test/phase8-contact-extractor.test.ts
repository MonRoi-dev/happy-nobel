import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import {
  createDatabaseContext,
  ensureNegotiationMessagesColumns,
} from '../src/db/index.ts';
import {
  negotiationMessages,
  taskQueue,
  type NegotiationMessageRecord,
} from '../src/db/schema.ts';
import type {
  IHhMessagingService,
  UnreadNegotiationItem,
} from '../src/modules/hh-hybrid/index.ts';
import {
  ContactExtractorService,
  extractContacts,
  formatContactsFooter,
  formatExtractedContactsBlock,
  hasExtractedContacts,
  type ExtractedContacts,
} from '../src/modules/parser/index.ts';
import {
  buildUnreadNotificationText,
  syncUnreadMessagesCore,
} from '../src/modules/telegram/index.ts';

test('Spec Criterion 4 exact phrase extracts telegram handle and phone number', () => {
  const input =
    'Здравствуйте! Напишите мне в ТГ @recruiter_hh или позвоните +7 (916) 555-33-22';
  const resFromFunc = extractContacts(input);
  const resFromStatic = ContactExtractorService.extractContacts(input);
  const serviceInstance = new ContactExtractorService();
  const resFromInstance = serviceInstance.extractContacts(input);

  assert.deepEqual(resFromFunc.telegramHandles, ['@recruiter_hh']);
  assert.deepEqual(resFromFunc.phoneNumbers, ['+7 (916) 555-33-22']);
  assert.deepEqual(resFromFunc.emails, []);

  assert.deepEqual(resFromStatic.telegramHandles, ['@recruiter_hh']);
  assert.deepEqual(resFromStatic.phoneNumbers, ['+7 (916) 555-33-22']);

  assert.deepEqual(resFromInstance.telegramHandles, ['@recruiter_hh']);
  assert.deepEqual(resFromInstance.phoneNumbers, ['+7 (916) 555-33-22']);
});

test('Telegram links emails and false positive protection works accurately', () => {
  const input =
    'Связь через t.me/hr_lead_2026 или на почту hr.team@company_name.ru или 8-999-123-45-67';
  const res = extractContacts(input);

  assert.ok(res.telegramHandles.includes('https://t.me/hr_lead_2026'));
  assert.ok(!res.telegramHandles.includes('@company_name'));
  assert.ok(!res.telegramHandles.includes('@company'));
  assert.deepEqual(res.emails, ['hr.team@company_name.ru']);
  assert.deepEqual(res.phoneNumbers, ['8-999-123-45-67']);
});

test('Invite links and duplicate normalization', () => {
  const input =
    'Канал https://t.me/+join_group_token и дубль t.me/+join_group_token и контакт @lead_dev и повтор @lead_dev';
  const res = extractContacts(input);

  assert.deepEqual(res.telegramHandles, [
    'https://t.me/+join_group_token',
    '@lead_dev',
  ]);
});

test('hasExtractedContacts returns correct boolean state', () => {
  assert.equal(
    hasExtractedContacts({
      telegramHandles: [],
      phoneNumbers: [],
      emails: [],
    }),
    false
  );

  assert.equal(
    hasExtractedContacts({
      telegramHandles: ['@recruiter_hh'],
      phoneNumbers: [],
      emails: [],
    }),
    true
  );

  assert.equal(
    hasExtractedContacts({
      telegramHandles: [],
      phoneNumbers: ['+7 (916) 555-33-22'],
      emails: [],
    }),
    true
  );

  assert.equal(
    hasExtractedContacts({
      telegramHandles: [],
      phoneNumbers: [],
      emails: ['hr@company.com'],
    }),
    true
  );
});

test('formatExtractedContactsBlock and formatContactsFooter format correctly', () => {
  const contacts: ExtractedContacts = {
    telegramHandles: ['@recruiter_hh'],
    phoneNumbers: ['+7 (916) 555-33-22'],
    emails: ['job@corp.ru'],
  };

  const formatted = formatExtractedContactsBlock(contacts);
  assert.ok(
    formatted.includes('📌 <b>Найденные контакты для быстрой связи:</b>')
  );
  assert.ok(formatted.includes('• Telegram: @recruiter_hh'));
  assert.ok(formatted.includes('• Телефон: +7 (916) 555-33-22'));
  assert.ok(formatted.includes('• Email: job@corp.ru'));

  const emptyFormatted = formatExtractedContactsBlock({
    telegramHandles: [],
    phoneNumbers: [],
    emails: [],
  });
  assert.equal(emptyFormatted, '');

  const footerText = formatContactsFooter(
    'Почта test@example.com',
    (s) => s.toUpperCase()
  );
  assert.ok(footerText.includes('• Email: TEST@EXAMPLE.COM'));

  const instanceService = new ContactExtractorService();
  const instanceFooter = instanceService.formatContactsFooter(
    'Напишите @recruiter_hh'
  );
  assert.ok(instanceFooter.includes('• Telegram: @recruiter_hh'));
});

test('buildUnreadNotificationText conditionally appends contacts block', () => {
  const withContacts = buildUnreadNotificationText({
    companyName: 'Acme LLC',
    positionTitle: 'Lead Architect',
    lastUnreadText:
      'Здравствуйте! Напишите мне в ТГ @recruiter_hh или позвоните +7 (916) 555-33-22',
  });

  assert.ok(
    withContacts.includes('📌 <b>Найденные контакты для быстрой связи:</b>')
  );
  assert.ok(withContacts.includes('• Telegram: @recruiter_hh'));
  assert.ok(withContacts.includes('• Телефон: +7 (916) 555-33-22'));

  const withoutContacts = buildUnreadNotificationText({
    companyName: 'Acme LLC',
    positionTitle: 'Lead Architect',
    lastUnreadText: 'Спасибо за ваш отклик, мы рассмотрим резюме.',
  });

  assert.ok(
    !withoutContacts.includes('Найденные контакты для быстрой связи')
  );
  assert.ok(!withoutContacts.includes('📌'));
});

test('syncUnreadMessagesCore persists extractedContactsJson into SQLite', async () => {
  const dbContext = createDatabaseContext(':memory:');

  try {
    const rawUnread =
      'Здравствуйте! Напишите мне в ТГ @recruiter_hh или позвоните +7 (916) 555-33-22';
    const unreadItems: UnreadNegotiationItem[] = [
      {
        negotiationId: 'neg-phase8-01',
        vacancyId: 'vac-phase8-01',
        companyName: 'FastTech',
        positionTitle: 'TypeScript Lead',
        chatUrl: 'https://hh.ru/chat/neg-phase8-01',
        unreadMessages: [rawUnread],
        fullHistory: [{ sender: 'employer', text: rawUnread }],
      },
    ];

    const mockHhMessaging: IHhMessagingService = {
      fetchUnreadNegotiations: async () => ({ data: unreadItems, error: null }),
      sendChatMessage: async () => ({ data: true, error: null }),
    };

    const notifiedRecords: NegotiationMessageRecord[] = [];
    const sendUnreadChatNotification = async (
      record: NegotiationMessageRecord
    ) => {
      notifiedRecords.push(record);
      return { data: 998877, error: null };
    };

    const syncRes = await syncUnreadMessagesCore({
      db: dbContext.db,
      hhMessaging: mockHhMessaging,
      sendUnreadChatNotification,
    });

    assert.equal(syncRes.error, null);
    assert.equal(syncRes.data?.checkedCount, 1);
    assert.equal(syncRes.data?.notifiedCount, 1);

    const saved = dbContext.db
      .select()
      .from(negotiationMessages)
      .where(eq(negotiationMessages.negotiationId, 'neg-phase8-01'))
      .limit(1)
      .get();

    assert.ok(saved);
    assert.equal(saved.telegramMessageId, 998877);
    assert.ok(saved.extractedContactsJson);

    const parsedContacts = JSON.parse(
      saved.extractedContactsJson
    ) as ExtractedContacts;
    assert.deepEqual(parsedContacts.telegramHandles, ['@recruiter_hh']);
    assert.deepEqual(parsedContacts.phoneNumbers, ['+7 (916) 555-33-22']);
    assert.deepEqual(parsedContacts.emails, []);
  } finally {
    dbContext.close();
  }
});

test('task_queue table exists in createDatabaseContext and supports queue operations', async () => {
  const dbContext = createDatabaseContext(':memory:');

  try {
    const nowIso = new Date().toISOString();
    const inserted = dbContext.db
      .insert(taskQueue)
      .values({
        taskType: 'SEND_TG_MESSAGE',
        payloadJson: JSON.stringify({ chatId: 12345, text: 'Hello' }),
        status: 'pending',
        priority: 2,
        attempts: 0,
        scheduledFor: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .returning()
      .get();

    assert.ok(inserted);
    assert.equal(inserted.taskType, 'SEND_TG_MESSAGE');
    assert.equal(inserted.priority, 2);
    assert.equal(inserted.status, 'pending');

    const queried = dbContext.db
      .select()
      .from(taskQueue)
      .where(eq(taskQueue.id, inserted.id))
      .limit(1)
      .get();

    assert.ok(queried);
    assert.equal(queried.taskType, 'SEND_TG_MESSAGE');
    assert.equal(queried.status, 'pending');
  } finally {
    dbContext.close();
  }
});

test('ensureNegotiationMessagesColumns adds column to existing table missing extracted_contacts', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(`
      CREATE TABLE "negotiation_messages" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        "negotiation_id" TEXT NOT NULL UNIQUE,
        "vacancy_id" TEXT NOT NULL,
        "company_name" TEXT NOT NULL,
        "position_title" TEXT NOT NULL,
        "chat_url" TEXT NOT NULL,
        "last_unread_text" TEXT NOT NULL,
        "chat_history_json" TEXT NOT NULL,
        "telegram_message_id" INTEGER,
        "reply_status" TEXT NOT NULL DEFAULT 'unread_notified',
        "ai_generated_reply" TEXT,
        "updated_at" TEXT NOT NULL
      );
    `);

    ensureNegotiationMessagesColumns(sqlite);

    const columns = sqlite
      .prepare('PRAGMA table_info("negotiation_messages")')
      .all() as Array<{ name?: unknown }>;
    const names = columns.map((c) => String(c.name));

    assert.ok(names.includes('extracted_contacts'));
  } finally {
    sqlite.close();
  }
});

test('extractContacts handles empty strings and deduplicates multiple phone numbers', () => {
  const emptyRes = extractContacts('');
  assert.deepEqual(emptyRes.telegramHandles, []);
  assert.deepEqual(emptyRes.phoneNumbers, []);
  assert.deepEqual(emptyRes.emails, []);

  const dupText =
    'Позвоните +7 (916) 111-22-33 или снова +7 (916) 111-22-33 или 8 (916) 111-22-33';
  const dupRes = extractContacts(dupText);
  assert.equal(dupRes.phoneNumbers.length, 2);
  assert.equal(dupRes.phoneNumbers[0], '+7 (916) 111-22-33');
  assert.equal(dupRes.phoneNumbers[1], '8 (916) 111-22-33');
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { createDatabaseContext } from '../src/db/index.ts';
import { applicationRecords, userProfilesExtended } from '../src/db/schema.ts';
import { ConfigStoreService } from '../src/modules/config-store/config-store.service.ts';
import { formatReportStatus } from '../src/modules/exporter/index.ts';
import { LlmService, type OllamaChatPort } from '../src/modules/llm/llm.service.ts';
import { SchedulerService } from '../src/modules/scheduler/scheduler.service.ts';
import {
  buildManualQueueDetailView,
  buildManualQueueListView,
  countManualQueueRecords,
  handleManualQueueAction,
  queryCompactStatusReport,
} from '../src/modules/telegram/index.ts';
import type { TgChannelPostItem } from '../src/modules/tg-channel/index.ts';

describe('Task 5: TG Channel Scheduler Integration (HH Direct, External Form, TG Contact)', () => {
  it('routes HH.ru links directly to applyToVacancy without filters or minMatchScore, handles external forms and TG contacts', async () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const configStore = new ConfigStoreService(ctx.db);
      configStore.ensureDefaults();
      configStore.set('HH_IS_LOGGED_IN', 'true');
      configStore.set('AUTO_APPLY_ENABLED', 'true');
      configStore.setMinMatchScore(85);

      ctx.db
        .insert(userProfilesExtended)
        .values({
          hhResumeTitle: 'Senior Node.js Developer',
          resumeRawText: 'Алексей Иванов\nalexey@example.com\n+7 (999) 111-22-33\n@alexey_node\nNode.js TypeScript PostgreSQL 6 years',
          customPromptRules: null,
          resumePdfPath: '/tmp/candidate-cv.pdf',
          applicantName: 'Алексей Иванов',
          applicantEmail: 'alexey@example.com',
          applicantPhone: '+7 (999) 111-22-33',
          applicantTelegram: '@alexey_node',
        })
        .run();

      const mockChannelPosts: TgChannelPostItem[] = [
        {
          channelSlug: 'node_js_jobs_vakansii',
          postId: '2001',
          vacancyKey: 'tg:node_js_jobs_vakansii:2001',
          postUrl: 'https://t.me/node_js_jobs_vakansii/2001',
          publishedAt: '2026-10-12T12:00:00Z',
          rawText: '💼 Вакансия Node.js Developer в HhCompany',
          positionTitle: 'Node.js Developer',
          companyName: 'HhCompany',
          salaryText: '350 000 ₽',
          primaryApplyUrl: 'https://hh.ru/vacancy/55566677',
          applyLinks: [{ href: 'https://hh.ru/vacancy/55566677', label: 'Откликнуться' }],
          tgContacts: [],
        },
        {
          channelSlug: 'node_js_jobs_vakansii',
          postId: '2002',
          vacancyKey: 'tg:node_js_jobs_vakansii:2002',
          postUrl: 'https://t.me/node_js_jobs_vakansii/2002',
          publishedAt: '2026-10-12T13:00:00Z',
          rawText: '💼 Вакансия Senior Node.js Developer в Digipal. Требования: Node.js, TypeScript, AWS.',
          positionTitle: 'Senior Node.js Developer',
          companyName: 'Digipal',
          salaryText: 'from $5000',
          primaryApplyUrl: 'https://forms.monday.com/forms/3c3644ce51583eef505408abd4eb3c53?r=use1',
          applyLinks: [
            {
              href: 'https://forms.monday.com/forms/3c3644ce51583eef505408abd4eb3c53?r=use1',
              label: 'Откликнуться',
            },
          ],
          tgContacts: [],
        },
        {
          channelSlug: 'node_js_jobs_vakansii',
          postId: '2003',
          vacancyKey: 'tg:node_js_jobs_vakansii:2003',
          postUrl: 'https://t.me/node_js_jobs_vakansii/2003',
          publishedAt: '2026-10-12T14:00:00Z',
          rawText: '💼 Вакансия Lead Node.js в CryptoTeam. Писать @crypto_hr_lead',
          positionTitle: 'Lead Node.js',
          companyName: 'CryptoTeam',
          salaryText: '4500 EUR',
          primaryApplyUrl: null,
          applyLinks: [],
          tgContacts: ['crypto_hr_lead'],
        },
      ];

      const hhAppliedIds: string[] = [];
      let evaluateCalledForHh = false;
      const sentTelegramMessages: string[] = [];

      const hhHybridMock = {
        getVacancyDetails: async (id: string) => ({
          data: {
            vacancy: {
              id,
              name: 'Node.js Developer (Direct from TG)',
              description: 'Full description from HH',
              alternate_url: `https://hh.ru/vacancy/${id}`,
              archived: false,
              has_test: false,
              response_letter_required: false,
              salary: null,
              employer: { name: 'HhCompany' },
            },
            cleanDescription: 'Full description from HH for Node.js Developer',
            salaryText: '350 000 ₽',
          },
          error: null,
        }),
        applyToVacancy: async (input: { vacancyId: string }) => {
          hhAppliedIds.push(input.vacancyId);
          return { data: true, error: null };
        },
      };

      const llmMock = {
        inspectStatus: async () => ({
          data: {
            isOnline: true,
            baseUrl: 'http://127.0.0.1:11434',
            configuredModel: 'gemma4:64k',
            isConfiguredModelInstalled: true,
            isConfiguredModelLoaded: true,
            pingMs: 5,
            installedModels: [],
            activeModels: [],
          },
          error: null,
        }),
        generateCoverLetter: async (input: { companyName: string }) => ({
          data: `Здравствуйте, команда ${input.companyName}! Откликаюсь на вакансию из TG-канала.`,
          error: null,
        }),
        evaluateVacancy: async (input: { companyName: string }) => {
          if (input.companyName === 'HhCompany') {
            evaluateCalledForHh = true;
          }
          return {
            data: {
              matchScore: 91,
              reasoning: 'Strong match',
              coverLetter: `Приветствую, команда ${input.companyName}! Мой опыт с Node.js и TypeScript отлично подходит.`,
            },
            error: null,
          };
        },
      };

      const telegramBotMock = {
        sendAdminMessage: async (text: string) => {
          sentTelegramMessages.push(text);
          return { data: true, error: null };
        },
      };

      const scheduler = new SchedulerService(
        configStore,
        ctx.db,
        hhHybridMock as never,
        llmMock as never,
        telegramBotMock as never,
        {
          customSleep: async () => undefined,
          tgChannelScraper: {
            scrapePublicChannelPosts: async () => ({
              data: mockChannelPosts,
              error: null,
            }),
          },
          externalFormApplier: {
            applyToExternalForm: async () => ({
              data: {
                status: 'applied_external',
                finalUrl: 'https://forms.monday.com/forms/3c3644ce51583eef505408abd4eb3c53?r=use1',
                matchScore: 93,
                reasoning: 'Matched external form',
                coverLetter: 'Здравствуйте, команда Digipal!',
                filledFieldsCount: 5,
              },
              error: null,
            }),
          },
        }
      );

      const cycleRes = await scheduler.runTgChannelAutoApplyCycle();
      assert.equal(cycleRes.error, null);
      assert.ok(cycleRes.data);
      assert.equal(cycleRes.data.appliedCount, 2);
      assert.equal(cycleRes.data.notifiedCount, 1);
      assert.equal(evaluateCalledForHh, false);
      assert.deepEqual(hhAppliedIds, ['55566677']);

      const hhRecord = ctx.db
        .select()
        .from(applicationRecords)
        .where(eq(applicationRecords.vacancyId, '55566677'))
        .limit(1)
        .get();
      assert.ok(hhRecord);
      assert.equal(hhRecord.status, 'response');

      const extRecord = ctx.db
        .select()
        .from(applicationRecords)
        .where(eq(applicationRecords.vacancyId, 'tg:node_js_jobs_vakansii:2002'))
        .limit(1)
        .get();
      assert.ok(extRecord);
      assert.equal(extRecord.status, 'applied_external');

      const tgContactRecord = ctx.db
        .select()
        .from(applicationRecords)
        .where(eq(applicationRecords.vacancyId, 'tg:node_js_jobs_vakansii:2003'))
        .limit(1)
        .get();
      assert.ok(tgContactRecord);
      assert.equal(tgContactRecord.status, 'tg_contact_notified');
      assert.equal(sentTelegramMessages.some((m) => m.includes('@crypto_hr_lead')), false);
      assert.equal(countManualQueueRecords(ctx.db, 'hr'), 1);

      const listView = buildManualQueueListView(ctx.db, 'hr', 0);
      assert.ok(listView.text.includes('CryptoTeam'));
      const detailView = buildManualQueueDetailView(tgContactRecord, 'hr', 0);
      assert.ok(detailView.text.includes('@crypto_hr_lead'));

      const confirmRes = handleManualQueueAction('confirm', 'hr', tgContactRecord.id, 0, {
        db: ctx.db,
        configStore,
      });
      assert.equal(confirmRes.error, null);
      assert.equal(countManualQueueRecords(ctx.db, 'hr'), 0);

      const updatedContact = ctx.db
        .select()
        .from(applicationRecords)
        .where(eq(applicationRecords.id, tgContactRecord.id))
        .limit(1)
        .get();
      assert.equal(updatedContact?.status, 'response');
      assert.equal(formatReportStatus(updatedContact!.status), 'Отправлено');

      const statusReport = queryCompactStatusReport(ctx.db, configStore, 0);
      assert.ok(statusReport.totals.totalApplied >= 3);
    } finally {
      ctx.close();
    }
  });

  it('executes runTgChannelAutoApplyCycle at the beginning of runAutoApplyCycle even when HH_IS_LOGGED_IN is false', async () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const configStore = new ConfigStoreService(ctx.db);
      configStore.ensureDefaults();
      configStore.set('HH_IS_LOGGED_IN', 'false');
      configStore.set('AUTO_APPLY_ENABLED', 'true');

      ctx.db
        .insert(userProfilesExtended)
        .values({
          hhResumeTitle: 'Senior Node.js Developer',
          resumeRawText: 'Node.js TypeScript developer with 6 years experience',
          customPromptRules: null,
        })
        .run();

      let tgScraped = false;
      const scheduler = new SchedulerService(
        configStore,
        ctx.db,
        {} as never,
        {} as never,
        { sendAdminMessage: async () => ({ data: true, error: null }) } as never,
        {
          tgChannelScraper: {
            scrapePublicChannelPosts: async () => {
              tgScraped = true;
              return { data: [], error: null };
            },
          },
        }
      );

      await scheduler.runAutoApplyCycle();
      assert.equal(tgScraped, true);
    } finally {
      ctx.close();
    }
  });

  it('serializes concurrent LlmService chat and unloadModel requests with think: false to prevent parallel timeouts', async () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const store = new ConfigStoreService(ctx.db);
      store.ensureDefaults();

      const timeline: string[] = [];
      let capturedThink: boolean | string | undefined;

      const mockClient: OllamaChatPort = {
        chat: async (req) => {
          capturedThink = req.think;
          const label = req.messages[1]?.content.includes('CompanyA') ? 'chatA' : 'chatB';
          timeline.push(`${label}:start`);
          await new Promise((r) => setTimeout(r, 25));
          timeline.push(`${label}:end`);
          return {
            model: req.model,
            created_at: new Date(),
            message: {
              role: 'assistant',
              content: JSON.stringify({
                matchScore: 88,
                reasoning: 'Отличное совпадение по стеку Node.js и TypeScript.',
                coverLetter: 'Здравствуйте! Имею коммерческий опыт разработки на Node.js более 5 лет.',
              }),
            },
            done: true,
            done_reason: 'stop',
            total_duration: 10,
            load_duration: 1,
            prompt_eval_count: 10,
            prompt_eval_duration: 2,
            eval_count: 10,
            eval_duration: 5,
          };
        },
      };

      const llm = new LlmService(store, mockClient, undefined, {
        fetch: async () => {
          timeline.push('unload:execute');
          return new Response(JSON.stringify({ done: true }), { status: 200 });
        },
      });

      const p1 = llm.evaluateVacancy({
        resumeRawText: 'Senior Node.js TypeScript Backend Developer with 6 years of experience',
        vacancyTitle: 'Node.js Developer',
        companyName: 'CompanyA',
        vacancyDescription: 'Looking for a Senior Node.js TypeScript backend engineer.',
      });
      const pUnload = llm.unloadModel();
      const p2 = llm.evaluateVacancy({
        resumeRawText: 'Senior Node.js TypeScript Backend Developer with 6 years of experience',
        vacancyTitle: 'Node.js Developer',
        companyName: 'CompanyB',
        vacancyDescription: 'Looking for a Senior Node.js TypeScript backend engineer.',
      });

      const [r1, rUnload, r2] = await Promise.all([p1, pUnload, p2]);
      assert.equal(r1.error, null);
      assert.equal(rUnload.error, null);
      assert.equal(r2.error, null);
      assert.equal(capturedThink, false);
      assert.deepEqual(timeline, [
        'chatA:start',
        'chatA:end',
        'unload:execute',
        'chatB:start',
        'chatB:end',
      ]);
    } finally {
      ctx.close();
    }
  });

  it('queues HR emails and external forms with captcha into separate manual queues without chat spam and tracks confirm/reject in Excel status', async () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const configStore = new ConfigStoreService(ctx.db);
      configStore.ensureDefaults();
      configStore.set('AUTO_APPLY_ENABLED', 'true');
      configStore.setMinMatchScore(80);

      ctx.db
        .insert(userProfilesExtended)
        .values({
          hhResumeTitle: 'Senior Node.js Developer',
          resumeRawText: 'Алексей Иванов\nalexey@example.com\nNode.js TypeScript 6 years',
          customPromptRules: null,
        })
        .run();

      const sentChatMessages: string[] = [];
      const mockPosts: TgChannelPostItem[] = [
        {
          channelSlug: 'node_js_jobs_vakansii',
          postId: '3001',
          vacancyKey: 'tg:node_js_jobs_vakansii:3001',
          postUrl: 'https://t.me/node_js_jobs_vakansii/3001',
          publishedAt: new Date().toISOString(),
          rawText: 'Вакансия Senior Node.js. Присылайте резюме на почту jobs@fintech.io',
          positionTitle: 'Senior Node.js Developer',
          companyName: 'FinTech Corp',
          salaryText: '4500 EUR',
          primaryApplyUrl: null,
          applyLinks: [],
          tgContacts: [],
          hrEmails: ['jobs@fintech.io'],
        },
        {
          channelSlug: 'node_js_jobs_vakansii',
          postId: '3002',
          vacancyKey: 'tg:node_js_jobs_vakansii:3002',
          postUrl: 'https://t.me/node_js_jobs_vakansii/3002',
          publishedAt: new Date().toISOString(),
          rawText: 'Вакансия Fullstack JS/Node.js в Wisebits',
          positionTitle: 'Fullstack Developer (JS/Node.js)',
          companyName: 'Wisebits',
          salaryText: '4000 EUR',
          primaryApplyUrl: 'https://wisebits.com/vacancies/162-fullstack-developer-jsnodejs',
          applyLinks: [{ href: 'https://wisebits.com/vacancies/162-fullstack-developer-jsnodejs', label: 'Откликнуться' }],
          tgContacts: [],
          hrEmails: [],
        },
      ];

      const scheduler = new SchedulerService(
        configStore,
        ctx.db,
        {} as never,
        {
          evaluateVacancy: async () => ({
            data: {
              matchScore: 92,
              reasoning: 'Отличное совпадение',
              coverLetter: 'Здравствуйте! Готов обсудить вакансию.',
            },
            error: null,
          }),
        } as never,
        {
          sendAdminMessage: async (text: string) => {
            sentChatMessages.push(text);
            return { data: true, error: null };
          },
        } as never,
        {
          tgChannelScraper: {
            scrapePublicChannelPosts: async () => ({ data: mockPosts, error: null }),
          },
          externalFormApplier: {
            applyToExternalForm: async () => ({
              data: {
                status: 'pending_external_captcha',
                finalUrl: 'https://wisebits.com/vacancies/162-fullstack-developer-jsnodejs',
                matchScore: 90,
                reasoning: 'Requires reCAPTCHA',
                coverLetter: 'Hello Wisebits team!',
              },
              error: null,
            }),
          },
        }
      );

      const res = await scheduler.runTgChannelAutoApplyCycle();
      assert.equal(res.error, null);
      assert.equal(res.data?.notifiedCount, 2);
      assert.equal(sentChatMessages.length, 0);

      assert.equal(countManualQueueRecords(ctx.db, 'hr'), 1);
      assert.equal(countManualQueueRecords(ctx.db, 'form'), 1);

      const hrPage = buildManualQueueListView(ctx.db, 'hr', 0);
      assert.ok(hrPage.text.includes('FinTech Corp'));

      const formPage = buildManualQueueListView(ctx.db, 'form', 0);
      assert.ok(formPage.text.includes('Wisebits'));

      const hrRec = ctx.db
        .select()
        .from(applicationRecords)
        .where(eq(applicationRecords.vacancyId, 'tg:node_js_jobs_vakansii:3001'))
        .limit(1)
        .get()!;
      const formRec = ctx.db
        .select()
        .from(applicationRecords)
        .where(eq(applicationRecords.vacancyId, 'tg:node_js_jobs_vakansii:3002'))
        .limit(1)
        .get()!;

      assert.equal(formatReportStatus(hrRec.status), 'Ожидает отклика (контакт HR)');
      assert.equal(formatReportStatus(formRec.status), 'Ожидает отклика (форма сайта)');

      const hrDetail = buildManualQueueDetailView(hrRec, 'hr', 0);
      assert.ok(hrDetail.text.includes('jobs@fintech.io'));

      handleManualQueueAction('skip', 'hr', hrRec.id, 0, { db: ctx.db, configStore });
      handleManualQueueAction('confirm', 'form', formRec.id, 0, { db: ctx.db, configStore });

      assert.equal(countManualQueueRecords(ctx.db, 'hr'), 0);
      assert.equal(countManualQueueRecords(ctx.db, 'form'), 0);

      const updatedHr = ctx.db.select().from(applicationRecords).where(eq(applicationRecords.id, hrRec.id)).get()!;
      const updatedForm = ctx.db.select().from(applicationRecords).where(eq(applicationRecords.id, formRec.id)).get()!;

      assert.equal(updatedHr.status, 'skipped_user');
      assert.equal(formatReportStatus(updatedHr.status), 'Пропущено пользователем');

      assert.equal(updatedForm.status, 'applied_external');
      assert.equal(formatReportStatus(updatedForm.status), 'Отправлено (внешняя форма)');
    } finally {
      ctx.close();
    }
  });
});

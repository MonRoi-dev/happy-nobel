import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDatabaseContext } from '../../db/index.ts';
import { ConfigStoreService } from '../config-store/index.ts';
import { GamingModeService } from './gaming-mode.service.ts';
import { LlmReplyService } from './llm-reply.service.ts';
import { LlmService, hasRecruiterOrCritiqueLeak, humanizeCoverLetter, type OllamaChatPort } from './llm.service.ts';

describe('LlmService and LlmReplyService with GamingModeService (NPU routing)', () => {
  it('routes LlmService.evaluateVacancy to NPU with num_ctx=4096 and parses markdown-fenced JSON', async () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const store = new ConfigStoreService(ctx.db);
      store.ensureDefaults();
      store.setGamingMode('on');

      const gamingMode = new GamingModeService(store, {
        autoSpawnDaemon: false,
        customFetch: async () =>
          new Response(JSON.stringify({ gpu3dLoadPct: 50, vramUsedMb: 8000, npuReady: true }), { status: 200 }),
      });

      let capturedModel = '';
      let capturedNumCtx = 0;

      const fakeClient: OllamaChatPort = {
        chat: async (req) => {
          capturedModel = req.model;
          capturedNumCtx = (req.options as { num_ctx?: number } | undefined)?.num_ctx ?? 0;
          return {
            model: req.model,
            created_at: new Date(),
            message: {
              role: 'assistant',
              content:
                '```json\n{"matchScore": 85, "reasoning": "Полное совпадение по Node.js и TypeScript", "coverLetter": "Здравствуйте! Имею коммерческий опыт на Node.js и TypeScript более 5 лет, буду рад обсудить задачи вашей команды."}\n```',
            },
            done: true,
            done_reason: 'stop',
            total_duration: 100,
            load_duration: 10,
            prompt_eval_count: 50,
            prompt_eval_duration: 20,
            eval_count: 30,
            eval_duration: 70,
          };
        },
      };

      const llm = new LlmService(store, fakeClient, gamingMode);
      const res = await llm.evaluateVacancy({
        resumeRawText: 'Senior Node.js TypeScript Backend Engineer with 6 years of production experience',
        vacancyTitle: 'Senior Backend Developer (Node.js)',
        companyName: 'TechCorp',
        vacancyDescription: 'Looking for a Senior Node.js TypeScript engineer to build high-load microservices.',
        minMatchScore: 70,
      });

      assert.equal(res.error, null);
      assert.equal(capturedModel, 'qwen2.5-3b-npu');
      assert.equal(capturedNumCtx, 4096);
      assert.equal(res.data?.matchScore, 85);
      assert.equal(res.data?.reasoning, 'Полное совпадение по Node.js и TypeScript');
    } finally {
      ctx.close();
    }
  });

  it('routes LlmReplyService.generateEmployerReply to NPU endpoint when gaming mode is active', async () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const store = new ConfigStoreService(ctx.db);
      store.ensureDefaults();
      store.setGamingMode('on');

      const gamingMode = new GamingModeService(store, {
        autoSpawnDaemon: false,
        customFetch: async () =>
          new Response(JSON.stringify({ gpu3dLoadPct: 60, vramUsedMb: 9000, npuReady: true }), { status: 200 }),
      });

      const calledUrls: string[] = [];
      const calledModels: string[] = [];

      const llmReply = new LlmReplyService(store, {
        gamingModeService: gamingMode,
        customFetch: async (url, init) => {
          calledUrls.push(String(url));
          if (init?.body) {
            const parsed = JSON.parse(String(init.body)) as { model?: string };
            if (parsed.model) {
              calledModels.push(parsed.model);
            }
          }
          return new Response(
            JSON.stringify({
              response: JSON.stringify({
                replyText: 'Добрый день! Спасибо за приглашение, готов созвониться завтра в 14:00.',
                confidenceScore: 92,
                summaryOfIntent: 'Согласие на интервью',
              }),
            }),
            { status: 200 }
          );
        },
      });

      const replyRes = await llmReply.generateEmployerReply({
        resumeRawText: 'Senior Node.js Engineer',
        companyName: 'Acme',
        positionTitle: 'Node.js Developer',
        chatHistory: [],
        lastUnreadText: 'Здравствуйте! Когда вам удобно пройти техническое интервью?',
      });

      assert.equal(replyRes.error, null);
      assert.equal(calledUrls[0], 'http://127.0.0.1:11435/api/generate');
      assert.equal(calledModels[0], 'qwen2.5-3b-npu');
      assert.equal(replyRes.data?.confidenceScore, 92);
    } finally {
      ctx.close();
    }
  });

  it('never falls back to GPU (11434) when NPU daemon fails during active gaming mode', async () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const store = new ConfigStoreService(ctx.db);
      store.ensureDefaults();
      store.setGamingMode('on');

      const gamingMode = new GamingModeService(store, {
        autoSpawnDaemon: false,
        customFetch: async () =>
          new Response(JSON.stringify({ gpu3dLoadPct: 80, vramUsedMb: 11000, npuReady: false }), { status: 200 }),
      });

      const calledUrls: string[] = [];
      const llmReply = new LlmReplyService(store, {
        gamingModeService: gamingMode,
        customFetch: async (url) => {
          calledUrls.push(String(url));
          throw new Error('ECONNREFUSED 127.0.0.1:11435');
        },
      });

      const replyRes = await llmReply.generateEmployerReply({
        resumeRawText: 'Senior Node.js Engineer',
        companyName: 'GameDev Corp',
        positionTitle: 'Backend Developer',
        chatHistory: [],
        lastUnreadText: 'Здравствуйте!',
      });

      assert.notEqual(replyRes.error, null);
      assert.equal(replyRes.data, null);
      assert.deepEqual(calledUrls, ['http://127.0.0.1:11435/api/generate']);
    } finally {
      ctx.close();
    }
  });

  it('parses markdown-fenced JSON in answerEmployerQuestions on NPU', async () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const store = new ConfigStoreService(ctx.db);
      store.ensureDefaults();
      store.setGamingMode('on');

      const gamingMode = new GamingModeService(store, {
        autoSpawnDaemon: false,
        customFetch: async () =>
          new Response(JSON.stringify({ gpu3dLoadPct: 40, vramUsedMb: 7000, npuReady: true }), { status: 200 }),
      });

      const fakeClient: OllamaChatPort = {
        chat: async (req) => ({
          model: req.model,
          created_at: new Date(),
          message: {
            role: 'assistant',
            content:
              '```json\n{"answers": [{"id": "q1", "answerText": "5 лет опыта коммерческой разработки", "selectedOptions": []}]}\n```',
          },
          done: true,
          done_reason: 'stop',
          total_duration: 50,
          load_duration: 5,
          prompt_eval_count: 20,
          prompt_eval_duration: 10,
          eval_count: 15,
          eval_duration: 35,
        }),
      };

      const llm = new LlmService(store, fakeClient, gamingMode);
      const res = await llm.answerEmployerQuestions({
        resumeRawText: 'Senior Node.js Developer with 5 years of commercial experience',
        vacancyTitle: 'Backend Engineer',
        companyName: 'Tech',
        questions: [{ id: 'q1', questionText: 'Какой у вас опыт?', fieldType: 'text' }],
      });

      assert.equal(res.error, null);
      assert.equal( res.data?.length, 1);
      assert.equal(res.data?.[0]?.answerText, '5 лет опыта коммерческой разработки');
    } finally {
      ctx.close();
    }
  });

  it('compacts oversized resumeRawText and vacancyDescription when routing to NPU so both fit within NPU token budget', async () => {
    const ctx = createDatabaseContext(':memory:');
    try {
      const store = new ConfigStoreService(ctx.db);
      store.ensureDefaults();
      store.setGamingMode('on');

      const gamingMode = new GamingModeService(store, {
        autoSpawnDaemon: false,
        customFetch: async () =>
          new Response(JSON.stringify({ gpu3dLoadPct: 55, vramUsedMb: 8200, npuReady: true }), { status: 200 }),
      });

      let capturedUserPrompt = '';
      const fakeClient: OllamaChatPort = {
        chat: async (req) => {
          const userMsg = req.messages?.find((m) => m.role === 'user');
          capturedUserPrompt = userMsg?.content ?? '';
          return {
            model: req.model,
            created_at: new Date(),
            message: {
              role: 'assistant',
              content: JSON.stringify({
                matchScore: 88,
                reasoning: 'Отличное совпадение по стеку Node.js и TypeScript.',
                coverLetter:
                  'Здравствуйте! Имею более 6 лет опыта разработки на Node.js и TypeScript, готов подключиться к вашим задачам.',
              }),
            },
            done: true,
            done_reason: 'stop',
            total_duration: 50,
            load_duration: 5,
            prompt_eval_count: 100,
            prompt_eval_duration: 20,
            eval_count: 30,
            eval_duration: 30,
          };
        },
      };

      const longVacancy = `VACANCY_START ${'Требуется Senior Node.js TypeScript разработчик. '.repeat(120)} VACANCY_END`;
      const longResume = `RESUME_START ${'Опыт коммерческой разработки на Node.js, TypeScript, PostgreSQL 6 лет. '.repeat(120)} RESUME_END`;

      const llm = new LlmService(store, fakeClient, gamingMode);
      const res = await llm.evaluateVacancy({
        resumeRawText: longResume,
        vacancyTitle: 'Инженер-программист (Node.js / TypeScript)',
        companyName: 'ПАО Газпром нефть ИТ',
        vacancyDescription: longVacancy,
        minMatchScore: 70,
      });

      assert.equal(res.error, null);
      assert.ok(capturedUserPrompt.length < 4800, `Expected compact prompt < 4800 chars, got ${capturedUserPrompt.length}`);
      assert.ok(capturedUserPrompt.includes('VACANCY_START'));
      assert.ok(capturedUserPrompt.includes('RESUME_START'));
      assert.ok(capturedUserPrompt.includes('RESUME_END'));
    } finally {
      ctx.close();
    }
  });

  it('detects recruiter persona or self-critique leaks and rewrites coverLetter from first-person applicant perspective', async () => {
    assert.equal(
      hasRecruiterOrCritiqueLeak(
        'Здравствуйте! Ваше резюме привлекло мое внимание. Однако, к сожалению, недостаточно опыта в робототехнике.'
      ),
      true
    );
    assert.equal(
      hasRecruiterOrCritiqueLeak(
        'Здравствуйте! Меня заинтересовала ваша вакансия. Имею более 5 лет коммерческого опыта разработки на Node.js и TypeScript.'
      ),
      false
    );

    const ctx = createDatabaseContext(':memory:');
    try {
      const store = new ConfigStoreService(ctx.db);
      store.ensureDefaults();
      store.setGamingMode('on');

      const gamingMode = new GamingModeService(store, {
        autoSpawnDaemon: false,
        customFetch: async () =>
          new Response(JSON.stringify({ gpu3dLoadPct: 60, vramUsedMb: 8500, npuReady: true }), { status: 200 }),
      });

      let callCount = 0;
      const fakeClient: OllamaChatPort = {
        chat: async (req) => {
          callCount += 1;
          const content =
            callCount === 1
              ? JSON.stringify({
                  matchScore: 82,
                  reasoning: 'Хорошее совпадение по Node.js и TypeScript.',
                  coverLetter:
                    'Здравствуйте! Ваше резюме привлекло мое внимание. Однако, к сожалению, недостаточно опыта в робототехнике, что может ограничить вашу способность выполнять обязанности.',
                })
              : JSON.stringify({
                  coverLetter:
                    'Здравствуйте! Меня заинтересовала вакансия инженера-программиста. Мой коммерческий опыт разработки на Node.js, TypeScript и Python составляет более 5 лет, буду рад обсудить задачи вашей команды.',
                });

          return {
            model: req.model,
            created_at: new Date(),
            message: { role: 'assistant', content },
            done: true,
            done_reason: 'stop',
            total_duration: 40,
            load_duration: 5,
            prompt_eval_count: 80,
            prompt_eval_duration: 15,
            eval_count: 25,
            eval_duration: 20,
          };
        },
      };

      const llm = new LlmService(store, fakeClient, gamingMode);
      const res = await llm.evaluateVacancy({
        resumeRawText: 'Разработчик Node.js, TypeScript, Python с опытом 5 лет.',
        vacancyTitle: 'Инженер-программист робототехнических комплексов',
        companyName: 'ПАО Газпром нефть ИТ',
        vacancyDescription: 'Разработка ПО на Node.js, TypeScript, Python.',
        minMatchScore: 70,
      });

      assert.equal(res.error, null);
      assert.equal(callCount, 2);
      assert.ok(res.data?.coverLetter.includes('Мой коммерческий опыт'));
      assert.equal(hasRecruiterOrCritiqueLeak(res.data?.coverLetter ?? ''), false);
    } finally {
      ctx.close();
    }
  });

  it('strips robotic AI cliches from coverLetter via humanizeCoverLetter', () => {
    const robotic =
      'Здравствуйте! Меня заинтересовала ваша вакансия Fullstack-разработчика. Я пишу бэкенд на Node.js и TypeScript, а также делал админки на React, что соответствует требованиям вашей вакансии.';
    const cleaned = humanizeCoverLetter(robotic);
    assert.equal(cleaned.includes('что соответствует требованиям вашей вакансии'), false);
    assert.equal(cleaned.includes('Меня заинтересовала ваша вакансия'), false);
    assert.ok(cleaned.includes('Node.js и TypeScript'));
  });
});

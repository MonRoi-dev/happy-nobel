import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { ConfigStoreService } from '../src/modules/config-store/config-store.service.ts';
import { LlmService, type OllamaChatPort } from '../src/modules/llm/index.ts';

function createTestDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE "app_settings" (
      "key" TEXT PRIMARY KEY NOT NULL,
      "value" TEXT NOT NULL
    );
    CREATE TABLE "company_blacklist" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      "companyName" TEXT NOT NULL UNIQUE,
      "addedAt" TEXT NOT NULL
    );
  `);
  const db = drizzle({ client: sqlite });
  return { sqlite, db };
}

test('ConfigStoreService company blacklist - add with lowercase normalization and whitespace trimming', () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);

  const result = configStore.addBlacklistedCompany('  Яндекс ТЕХНОЛОГИИ  ');
  assert.equal(result.error, null);
  assert.ok(result.data);
  assert.equal(result.data.companyName, 'яндекс технологии');
  assert.equal(result.data.id, 1);
  assert.ok(typeof result.data.addedAt === 'string');
});

test('ConfigStoreService company blacklist - reject empty or whitespace company name', () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);

  const emptyResult = configStore.addBlacklistedCompany('');
  assert.equal(emptyResult.data, null);
  assert.equal(emptyResult.error, 'Название компании не может быть пустым');

  const whitespaceResult = configStore.addBlacklistedCompany('    ');
  assert.equal(whitespaceResult.data, null);
  assert.equal(whitespaceResult.error, 'Название компании не может быть пустым');
});

test('ConfigStoreService company blacklist - idempotency on duplicate company name', () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);

  const first = configStore.addBlacklistedCompany('Сбер');
  assert.equal(first.error, null);
  assert.ok(first.data);

  const duplicate = configStore.addBlacklistedCompany('  СБЕР  ');
  assert.equal(duplicate.error, null);
  assert.ok(duplicate.data);
  assert.equal(duplicate.data.id, first.data.id);
  assert.equal(duplicate.data.companyName, 'сбер');

  const list = configStore.listBlacklistedCompanies();
  assert.equal(list.error, null);
  assert.equal(list.data?.length, 1);
});

test('ConfigStoreService company blacklist - list and pagination', () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);

  configStore.addBlacklistedCompany('Company A');
  configStore.addBlacklistedCompany('Company B');
  configStore.addBlacklistedCompany('Company C');

  const fullList = configStore.listBlacklistedCompanies();
  assert.equal(fullList.error, null);
  assert.equal(fullList.data?.length, 3);

  const paginated = configStore.listBlacklistedCompanies({ limit: 2, offset: 1 });
  assert.equal(paginated.error, null);
  assert.equal(paginated.data?.length, 2);
  assert.equal(paginated.data?.[0].companyName, 'company b');
  assert.equal(paginated.data?.[1].companyName, 'company c');
});

test('ConfigStoreService company blacklist - removal by id and edge cases', () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);

  const added = configStore.addBlacklistedCompany('Bad Employer');
  assert.ok(added.data);

  const removeResult = configStore.removeBlacklistedCompany(added.data.id);
  assert.equal(removeResult.error, null);
  assert.equal(removeResult.data, true);

  const removeAgain = configStore.removeBlacklistedCompany(added.data.id);
  assert.equal(removeAgain.error, null);
  assert.equal(removeAgain.data, false);

  const invalidIdResult = configStore.removeBlacklistedCompany(0);
  assert.equal(invalidIdResult.data, null);
  assert.ok(invalidIdResult.error);

  const negativeIdResult = configStore.removeBlacklistedCompany(-5);
  assert.equal(negativeIdResult.data, null);
  assert.ok(negativeIdResult.error);
});

test('ConfigStoreService company blacklist - isCompanyBlacklisted substring and case-insensitive check', () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);

  configStore.addBlacklistedCompany('инфотех');
  configStore.addBlacklistedCompany('super corp');

  const matchCaseInsensitive = configStore.isCompanyBlacklisted('ООО "ИНФОТЕХ СЕРВИС"');
  assert.equal(matchCaseInsensitive.error, null);
  assert.equal(matchCaseInsensitive.data, true);

  const matchExact = configStore.isCompanyBlacklisted('Super Corp');
  assert.equal(matchExact.error, null);
  assert.equal(matchExact.data, true);

  const noMatch = configStore.isCompanyBlacklisted('Яндекс');
  assert.equal(noMatch.error, null);
  assert.equal(noMatch.data, false);

  const nullCheck = configStore.isCompanyBlacklisted(null);
  assert.equal(nullCheck.error, null);
  assert.equal(nullCheck.data, false);

  const undefinedCheck = configStore.isCompanyBlacklisted(undefined);
  assert.equal(undefinedCheck.error, null);
  assert.equal(undefinedCheck.data, false);

  const emptyCheck = configStore.isCompanyBlacklisted('   ');
  assert.equal(emptyCheck.error, null);
  assert.equal(emptyCheck.data, false);
});

test('LlmService evaluateVacancy - high match score returns score, reasoning and clamped cover letter', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();

  const longLetter = 'Здравствуйте! Меня зовут Алексей, я Senior Backend разработчик с опытом более 6 лет в Node.js и TypeScript. Успешно разрабатывал высоконагруженные микросервисы, оптимизировал PostgreSQL и Redis. Полностью подхожу под ваши требования.'.repeat(6);

  const mockClient: OllamaChatPort = {
    chat: async () => ({
      model: 'gemma4:64k',
      message: {
        role: 'assistant',
        content: JSON.stringify({
          matchScore: 88,
          reasoning: 'Отличное совпадение по стеку Node.js и базам данных.',
          coverLetter: longLetter,
        }),
      },
      done: true,
      total_duration: 100,
      load_duration: 10,
      prompt_eval_count: 50,
      eval_count: 50,
    } as any),
  };

  const llm = new LlmService(configStore, mockClient);
  const result = await llm.evaluateVacancy({
    resumeRawText: 'Senior Backend Engineer, Node.js, TypeScript, PostgreSQL',
    vacancyTitle: 'Senior Backend Developer',
    companyName: 'Acme Corp',
    vacancyDescription: 'Looking for a Senior Backend Developer proficient in Node.js and TypeScript',
    minMatchScore: 70,
  });

  assert.equal(result.error, null);
  assert.ok(result.data);
  assert.equal(result.data.matchScore, 88);
  assert.equal(result.data.reasoning, 'Отличное совпадение по стеку Node.js и базам данных.');
  assert.ok(result.data.coverLetter.length <= 1200);
  assert.ok(result.data.coverLetter.length >= 20);
  assert.ok(result.data.coverLetter.endsWith('...'));
});

test('LlmService evaluateVacancy - low match score returns empty cover letter even if LLM generated text', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();

  const mockClient: OllamaChatPort = {
    chat: async () => ({
      model: 'gemma4:64k',
      message: {
        role: 'assistant',
        content: JSON.stringify({
          matchScore: 42,
          reasoning: 'Недостаточно опыта в Rust и распределенных системах.',
          coverLetter: 'Some text that should be erased because score is below threshold',
        }),
      },
      done: true,
      total_duration: 100,
      load_duration: 10,
      prompt_eval_count: 50,
      eval_count: 50,
    } as any),
  };

  const llm = new LlmService(configStore, mockClient);
  const result = await llm.evaluateVacancy({
    resumeRawText: 'Junior Frontend Developer, HTML, CSS, JavaScript',
    vacancyTitle: 'Staff Rust Infrastructure Engineer',
    companyName: 'LowLevel Systems',
    vacancyDescription: 'Building distributed storage engine in Rust with Raft consensus',
    minMatchScore: 75,
  });

  assert.equal(result.error, null);
  assert.ok(result.data);
  assert.equal(result.data.matchScore, 42);
  assert.equal(result.data.reasoning, 'Недостаточно опыта в Rust и распределенных системах.');
  assert.equal(result.data.coverLetter, '');
});

test('LlmService evaluateVacancy - high match score with too short cover letter returns error', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();

  const mockClient: OllamaChatPort = {
    chat: async () => ({
      model: 'gemma4:64k',
      message: {
        role: 'assistant',
        content: JSON.stringify({
          matchScore: 90,
          reasoning: 'Идеальное совпадение стека.',
          coverLetter: 'Коротко.',
        }),
      },
      done: true,
      total_duration: 100,
      load_duration: 10,
      prompt_eval_count: 50,
      eval_count: 50,
    } as any),
  };

  const llm = new LlmService(configStore, mockClient);
  const result = await llm.evaluateVacancy({
    resumeRawText: 'Senior Backend Engineer, Node.js, TypeScript, PostgreSQL',
    vacancyTitle: 'Senior Backend Developer',
    companyName: 'Acme Corp',
    vacancyDescription: 'Looking for a Senior Backend Developer proficient in Node.js and TypeScript',
    minMatchScore: 70,
  });

  assert.equal(result.data, null);
  assert.equal(result.error, 'Cover letter text is too short for matched vacancy');
});

test('LlmService answerEmployerQuestions - correctly answers radio, checkbox, and text questions', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();

  let capturedPrompt = '';
  const mockClient: OllamaChatPort = {
    chat: async (req) => {
      capturedPrompt = req.messages?.[1]?.content ?? '';
      return {
        model: 'gemma4:64k',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            answers: [
              {
                id: 'q1',
                answerText: '',
                selectedOptions: ['Более 5 лет'],
              },
              {
                id: 'q2',
                answerText: '',
                selectedOptions: ['TypeScript', 'Docker', 'PostgreSQL'],
              },
              {
                id: 'q3',
                answerText: 'Готов выйти через 2 недели после оффера.',
                selectedOptions: [],
              },
            ],
          }),
        },
        done: true,
        total_duration: 100,
        load_duration: 10,
        prompt_eval_count: 50,
        eval_count: 50,
      } as any;
    },
  };

  const llm = new LlmService(configStore, mockClient);
  const result = await llm.answerEmployerQuestions({
    resumeRawText: 'Node.js разработчик с 6 годами коммерческого опыта. Стек: TypeScript, Docker, PostgreSQL.',
    vacancyTitle: 'Senior Node.js Developer',
    companyName: 'Fintech Solutions',
    questions: [
      {
        id: 'q1',
        questionText: 'Какой у вас опыт коммерческой разработки на Node.js?',
        fieldType: 'radio',
        options: ['Менее 1 года', '1-3 года', '3-5 лет', 'Более 5 лет'],
      },
      {
        id: 'q2',
        questionText: 'Какими технологиями владеете?',
        fieldType: 'checkbox',
        options: ['TypeScript', 'Docker', 'PostgreSQL', 'Kubernetes', 'Go'],
      },
      {
        id: 'q3',
        questionText: 'Когда готовы приступить к работе?',
        fieldType: 'text',
      },
    ],
  });

  assert.equal(result.error, null);
  assert.ok(result.data);
  assert.equal(result.data.length, 3);
  assert.equal(result.data[0]?.id, 'q1');
  assert.deepEqual(result.data[0]?.selectedOptions, ['Более 5 лет']);
  assert.equal(result.data[1]?.id, 'q2');
  assert.deepEqual(result.data[1]?.selectedOptions, ['TypeScript', 'Docker', 'PostgreSQL']);
  assert.equal(result.data[2]?.id, 'q3');
  assert.equal(result.data[2]?.answerText, 'Готов выйти через 2 недели после оффера.');
  assert.ok(capturedPrompt.includes('Fintech Solutions'));
});

test('LlmService generateCoverLetter - uses custom temperature when provided', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();

  let receivedTemperature: number | undefined;
  const mockClient: OllamaChatPort = {
    chat: async (req) => {
      receivedTemperature = req.options?.temperature;
      return {
        model: 'gemma4:64k',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            coverLetter: 'Здравствуйте! Я заинтересован в вакансии Frontend разработчика и обладаю необходимым опытом.',
          }),
        },
        done: true,
        total_duration: 100,
        load_duration: 10,
        prompt_eval_count: 50,
        eval_count: 50,
      } as any;
    },
  };

  const llm = new LlmService(configStore, mockClient);
  const result = await llm.generateCoverLetter({
    resumeRawText: 'Frontend Developer with React and TypeScript experience',
    vacancyTitle: 'React Developer',
    companyName: 'Frontend Co',
    vacancyDescription: 'Looking for React developer with TypeScript',
    temperature: 0.65,
  });

  assert.equal(result.error, null);
  assert.ok(result.data);
  assert.equal(receivedTemperature, 0.65);
});

import { Ollama, type ChatRequest, type ChatResponse, type ListResponse } from 'ollama';
import { z } from 'zod';
import { createLogger } from '../../utils/logger.ts';
import type { GamingMode, IConfigStore, SafeResult } from '../config-store/index.ts';
import type { IGamingModeService, LlmProviderType } from './gaming-mode.service.ts';
import { stripMarkdownFences } from './llm-reply.service.ts';

const logger = createLogger('LLM');

export const CoverLetterInputSchema = z.object({
  resumeRawText: z.string().trim().min(10, 'Resume text is too short'),
  vacancyTitle: z.string().trim().min(1, 'Vacancy title is required'),
  companyName: z.string().trim().min(1, 'Company name is required'),
  vacancyDescription: z.string().trim().min(10, 'Vacancy description is too short'),
  customPromptRules: z.string().trim().optional().nullable(),
  temperature: z.number().min(0).max(2).optional(),
});

export type CoverLetterInput = z.infer<typeof CoverLetterInputSchema>;

export const VacancyEvaluationInputSchema = z.object({
  resumeRawText: z.string().trim().min(10, 'Resume text is too short'),
  vacancyTitle: z.string().trim().min(1, 'Vacancy title is required'),
  companyName: z.string().trim().min(1, 'Company name is required'),
  vacancyDescription: z.string().trim().min(10, 'Vacancy description is too short'),
  customPromptRules: z.string().trim().optional().nullable(),
  minMatchScore: z.number().int().min(0).max(100).optional(),
});

export type VacancyEvaluationInput = z.input<typeof VacancyEvaluationInputSchema>;

export const VacancyEvaluationResponseSchema = z.object({
  matchScore: z.number().int().min(0).max(100),
  reasoning: z.string().trim().min(3, 'AI reasoning is required'),
  coverLetter: z
    .string()
    .trim()
    .default('')
    .transform((val) => (val.length > 0 ? clampCoverLetterLength(val, 1200) : '')),
});

export type VacancyEvaluationResult = z.infer<typeof VacancyEvaluationResponseSchema>;

export const EmployerQuestionItemSchema = z.object({
  id: z.string().trim().min(1),
  questionText: z.string().trim().min(1),
  fieldType: z.enum(['text', 'textarea', 'radio', 'checkbox']),
  options: z.array(z.string().trim().min(1)).optional(),
});

export type EmployerQuestionItem = z.infer<typeof EmployerQuestionItemSchema>;

export const EmployerQuestionAnswerSchema = z.object({
  id: z.string().trim().min(1),
  answerText: z.string().trim().optional().default(''),
  selectedOptions: z.array(z.string().trim()).optional().default([]),
});

export type EmployerQuestionAnswer = z.infer<typeof EmployerQuestionAnswerSchema>;

export const AnswerEmployerQuestionsInputSchema = z.object({
  resumeRawText: z.string().trim().min(10, 'Resume text is too short'),
  vacancyTitle: z.string().trim().min(1, 'Vacancy title is required'),
  companyName: z.string().trim().min(1, 'Company name is required'),
  questions: z.array(EmployerQuestionItemSchema).min(1, 'At least one question is required'),
});

export type AnswerEmployerQuestionsInput = z.infer<typeof AnswerEmployerQuestionsInputSchema>;

export const AnswerEmployerQuestionsResponseSchema = z.object({
  answers: z.array(EmployerQuestionAnswerSchema).min(1),
});

export function humanizeCoverLetter(raw: string): string {
  let cleaned = raw.trim();
  if (!cleaned) {
    return '';
  }

  cleaned = cleaned
    .replace(/Пишу\s+на\s+основе\s+вашего\s+объявления\.\s*/gi, '')
    .replace(/Меня\s+заинтересовала\s+(?:ваша\s+)?вакансия\s+/gi, 'Откликаюсь на вакансию ')
    .replace(
      /,\s*что\s+(?:полностью\s+|отлично\s+)?соответствует\s+требованиям\s+(?:вашей\s+|данной\s+)?(?:вакансии|должности|компании|команды)/gi,
      ''
    )
    .replace(
      /\s+и\s+это\s+соответствует\s+требованиям\s+(?:вашей\s+|данной\s+)?(?:вакансии|должности)/gi,
      ''
    )
    .replace(
      /\s*позволяет\s+мне\s+эффективно\s+(?:взаимодействовать\s+с\s+современными\s+технологиями|решать\s+задачи)\.?/gi,
      '.'
    )
    .replace(
      /\s*будет\s+полезен\s+для\s+выполнения\s+задач\s+в\s+данной\s+(?:вакансии|должности)\.?/gi,
      '.'
    )
    .replace(
      /\s*Я\s+уверен,\s*что\s+смогу\s+внести\s+(?:свой\s+|значимый\s+|ценный\s+)?вклад\s+в\s+(?:вашу\s+команду|развитие\s+компании|проект)\.?/gi,
      ' Буду рад обсудить задачи.'
    )
    .replace(/обладаю\s+(?:всеми\s+)?необходимыми\s+(?:навыками|компетенциями)\s*(?:и\s+опытом)?/gi, 'имею практический опыт')
    .replace(/внедрил\s+систему\s+динамического\s+управления\s+/gi, 'настраивал ')
    .replace(/реализовал\s+сложную\s+логику\s+/gi, 'делал ')
    .replace(/спроектировал\s+и\s+реализовал\s+переход\s+/gi, 'переводил проект ')
    .replace(/внедрил\s+многоуровневое\s+кэширование/gi, 'настраивал кэш')
    .replace(/,\s*обеспечив\s+устойчивость\s+к\s+пиковым\s+нагрузкам/gi, '')
    .replace(/\.{2,}/g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return cleaned;
}

export function clampCoverLetterLength(raw: string, maxLen = 1200): string {
  const trimmed = humanizeCoverLetter(raw);
  if (trimmed.length <= maxLen) {
    return trimmed;
  }
  const slice = trimmed.slice(0, maxLen - 3);
  const lastSpace = slice.lastIndexOf(' ');
  const cleanSlice = lastSpace > maxLen / 2 ? slice.slice(0, lastSpace) : slice;
  return `${cleanSlice}...`;
}

export const CoverLetterResponseSchema = z.object({
  coverLetter: z
    .string()
    .trim()
    .min(20, 'Cover letter text is too short')
    .transform((val) => clampCoverLetterLength(val, 1200)),
});

export type CoverLetterResponse = z.infer<typeof CoverLetterResponseSchema>;

export interface OllamaChatPort {
  chat(request: ChatRequest & { stream?: false }): Promise<ChatResponse>;
  list?(): Promise<ListResponse>;
  ps?(): Promise<ListResponse>;
}

export interface LlmModelDetails {
  readonly name: string;
  readonly size: number;
  readonly modifiedAt?: string;
  readonly digest?: string;
}

export interface LlmActiveModelDetails {
  readonly name: string;
  readonly sizeVram?: number;
  readonly expiresAt?: string;
}

export interface LlmHealthStatus {
  readonly isOnline: boolean;
  readonly baseUrl: string;
  readonly configuredModel: string;
  readonly isConfiguredModelInstalled: boolean;
  readonly isConfiguredModelLoaded: boolean;
  readonly pingMs: number;
  readonly installedModels: LlmModelDetails[];
  readonly activeModels: LlmActiveModelDetails[];
  readonly gamingMode?: GamingMode;
  readonly activeProvider?: LlmProviderType;
  readonly gpu3dLoadPct?: number;
  readonly vramUsedMb?: number;
  readonly npuReady?: boolean;
  readonly error?: string | null;
}

export interface ILlmService {
  generateCoverLetter(input: CoverLetterInput & { temperature?: number }): Promise<SafeResult<string>>;
  evaluateVacancy(input: VacancyEvaluationInput): Promise<SafeResult<VacancyEvaluationResult>>;
  answerEmployerQuestions(input: AnswerEmployerQuestionsInput): Promise<SafeResult<EmployerQuestionAnswer[]>>;
  checkHealth(): Promise<SafeResult<{ model: string; baseUrl: string }>>;
  inspectStatus(): Promise<SafeResult<LlmHealthStatus>>;
  listAvailableModels(): Promise<SafeResult<LlmModelDetails[]>>;
  unloadModel?(): Promise<SafeResult<boolean>>;
}

const SYSTEM_PROMPT = [
  'Вы — опытный разработчик (автор резюме), который пишет убедительное, не шаблонное сопроводительное письмо работодателю на HH.ru от первого лица («я», «мой опыт», «писал», «настраивал», «делал»).',
  '',
  'ПРАВИЛА СОСТАВЛЕНИЯ ПИСЬМА:',
  '1. АДАПТАЦИЯ ПОД ТРЕБОВАНИЯ ВАКАНСИИ: Внимательно изучите Vacancy Description (стек, требования, задачи, архитектурные вызовы). Найдите ключевые пересечения с навыками и проектами из Candidate Resume. Напишите отклик так, чтобы работодатель видел: вы прочитали именно его вакансию, работали именно с нужным ему стеком и решали релевантные задачи (уверенно подчеркивайте и слегка усиливайте подходящий практический опыт).',
  '2. ИМЯ КОМПАНИИ: Обязательно органично упомяните название компании (Target Company) или проекта в приветствии либо в контексте задач («Здравствуйте, команда X!», «Добрый день! Увидел вашу вакансию в X...», «Приветствую! Заинтересовал проект X...»). Это защищает письмо от впечатления массовой спам-рассылки.',
  '3. РАЗНООБРАЗИЕ И СТИЛЬ: Избегайте заученных одинаковых шаблонов. Разнообразьте вступления и структуру. Пишите живым разговорным языком реального инженера (3-5 предложений, 250-600 символов).',
  '4. БЕЗ ИИ-КЛИШЕ И КАНЦЕЛЯРИТА: СТРОГО ЗАПРЕЩЕНЫ штампы («Меня заинтересовала ваша вакансия», «позволяет мне эффективно взаимодействовать», «современные технологии», «что соответствует требованиям вашей вакансии», «будет полезен для выполнения задач», «внести вклад», «обладаю необходимыми компетенциями»). Тяжелые фразы заменяйте живыми («настраивал кэш и очереди», «проектировал микросервисы», «оптимизировал запросы к БД»).',
  '5. СТРОГО ОТ ПЕРВОГО ЛИЦА: Запрещено писать от лица рекрутера («Ваше резюме») или писать про нехватку опыта.',
  '6. Верните ответ СТРОГО в формате JSON с единственным ключом "coverLetter".',
].join('\n');

const COVER_LETTER_JSON_SCHEMA = {
  type: 'object',
  properties: { coverLetter: { type: 'string' } },
  required: ['coverLetter'],
};

const VACANCY_EVALUATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    matchScore: { type: 'integer' },
    reasoning: { type: 'string' },
    coverLetter: { type: 'string' },
  },
  required: ['matchScore', 'reasoning', 'coverLetter'],
};

const SYSTEM_PROMPT_EVALUATE = [
  'Вы — опытный разработчик (соискатель) на HH.ru. Оцените вакансию под свое резюме и напишите живой, адаптированный отклик работодателю.',
  '',
  'ПРАВИЛА ОЦЕНКИ И ОТКЛИКА:',
  '1. Выставьте matchScore (0..100) — насколько стек и задачи вакансии подходят под резюме кандидата.',
  '2. В поле reasoning напишите 1 короткое емкое предложение с причиной оценки.',
  '3. Если matchScore >= порога Minimum Match Score Threshold, напишите в coverLetter убедительное, не шаблонное сопроводительное письмо (3-5 предложений, 250-600 символов):',
  '   - АДАПТАЦИЯ: Внимательно изучите Vacancy Description, выделите требования, стек и задачи проекта. Сопоставьте их с Candidate Resume и напишите, как ваш практический опыт решает задачи именно этой вакансии (уверенно преподносите и подчеркивайте пересекающийся стек, инструменты и кейсы).',
  '   - ИМЯ КОМПАНИИ: Обязательно органично назовите компанию (Target Company) или команду в приветствии либо в тексте («Здравствуйте, команда X!», «Добрый день! Увидел вакансию в X...», «Приветствую! Заинтересовал проект X...»), чтобы отклик был индивидуальным.',
  '   - РАЗНООБРАЗИЕ: Варьируйте формулировки и структуру текста, избегайте повторяющихся заученных фраз.',
  '   - СТРОГО ЗАПРЕЩЕНЫ штампы ИИ: «Меня заинтересовала ваша вакансия», «позволяет мне эффективно взаимодействовать», «современные технологии», «что соответствует требованиям вашей вакансии», «будет полезен для выполнения задач», «внести вклад в развитие».',
  '   - ЗАПРЕЩЕНЫ УТЕЧКИ РЕКРУТЕРА: Запрещено писать «Ваше резюме», «Ваш опыт» или писать о нехватке опыта.',
  '   - Если matchScore < порога, верните "" в coverLetter.',
  '4. Верните ответ СТРОГО как JSON со схемой: matchScore, reasoning, coverLetter.',
].join('\n');

const EMPLOYER_QUESTIONS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          answerText: { type: 'string' },
          selectedOptions: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'answerText', 'selectedOptions'],
      },
    },
  },
  required: ['answers'],
};

const SYSTEM_PROMPT_QUESTIONS = [
  'You are an expert job applicant assistant answering employer screening questions on HH.ru on behalf of the candidate.',
  'STRICT RULES:',
  '1. Base all answers strictly and truthfully on the provided candidate resume.',
  '2. For "text" or "textarea" questions, provide a concise, professional answer in Russian in "answerText", and set "selectedOptions" to an empty array [].',
  '3. For "radio" questions, pick exactly ONE option from the provided options list that best reflects the candidate resume. Put this exact option text in "selectedOptions" as a single-element array, or in "answerText".',
  '4. For "checkbox" questions, pick all options from the provided options list that match the candidate resume into "selectedOptions" as an array of strings.',
  '5. Provide an answer object for each question in the input with the exact matching "id".',
  '6. Return the response strictly as a JSON object matching the schema with key "answers".',
].join('\n');

function matchesModelName(target: string, candidate: string): boolean {
  const normTarget = target.trim().toLowerCase();
  const normCandidate = candidate.trim().toLowerCase();
  if (normTarget === normCandidate) {
    return true;
  }
  if (`${normTarget}:latest` === normCandidate) {
    return true;
  }
  if (normTarget === `${normCandidate}:latest`) {
    return true;
  }
  return false;
}

export function compactForNpu(text: string, maxChars: number): string {
  const cleaned = text
    .replace(/Покажите в резюме рекомендации[\s\S]*?Показывать рекомендации/gi, '')
    .replace(/Подтверждение навыков[\s\S]*?Посмотреть курсы/gi, '')
    .replace(/^Чаты\s+Резюме[\s\S]*?Профиль\s+\/\s+/i, '')
    .trim();
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  const headLen = Math.floor(maxChars * 0.8);
  const tailLen = Math.max(0, maxChars - headLen - 7);
  return `${cleaned.slice(0, headLen)}\n...\n${cleaned.slice(cleaned.length - tailLen)}`;
}

const RECRUITER_OR_CRITIQUE_LEAK_PATTERNS: ReadonlyArray<RegExp> = [
  /ваш[еиау]\s+резюме/i,
  /ваш(?:его|ему|им)?\s+опыт/i,
  /ваш[иау]\s+навык/i,
  /ваш[ауей]\s+способност/i,
  /привлекло\s+мо[её]\s+внимание/i,
  /ограничить\s+вашу/i,
  /рассмотрели\s+ваше/i,
  /недостаточно\s+опыта/i,
  /к\s+сожалению,\s+недостаточно/i,
  /вы\s+не\s+обладаете/i,
  /у\s+вас\s+нет\s+опыта/i,
  /эффективно\s+взаимодействовать\s+с\s+современными\s+технологиями/i,
];

export function hasRecruiterOrCritiqueLeak(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  return RECRUITER_OR_CRITIQUE_LEAK_PATTERNS.some((pattern) => pattern.test(normalized));
}

export interface LlmServiceOptions {
  readonly requestTimeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`LLM request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

export class LlmService implements ILlmService {
  private readonly configStore: IConfigStore;
  private readonly customClient?: OllamaChatPort;
  private readonly gamingModeService?: IGamingModeService;
  private readonly options?: LlmServiceOptions;

  constructor(
    configStore: IConfigStore,
    customClient?: OllamaChatPort,
    gamingModeService?: IGamingModeService,
    options?: LlmServiceOptions
  ) {
    this.configStore = configStore;
    this.customClient = customClient;
    this.gamingModeService = gamingModeService;
    this.options = options;
  }

  public async generateCoverLetter(input: CoverLetterInput & { temperature?: number }): Promise<SafeResult<string>> {
    const parsedInput = CoverLetterInputSchema.safeParse(input);
    if (!parsedInput.success) {
      return { data: null, error: parsedInput.error.issues[0]?.message ?? 'Invalid cover letter input' };
    }

    const runtimeConfig = await this.resolveActiveTarget();
    if (runtimeConfig.error || !runtimeConfig.data) {
      return { data: null, error: runtimeConfig.error ?? 'Failed to resolve LLM configuration' };
    }

    const temperature = input.temperature ?? parsedInput.data.temperature ?? 0.45;
    const chatResult = await this.executeChatWithFallback(runtimeConfig.data, (isNpu) => ({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: this.buildUserPrompt(parsedInput.data, isNpu) },
      ],
      format: COVER_LETTER_JSON_SCHEMA,
      temperature,
    }));

    if (chatResult.error || !chatResult.data) {
      return { data: null, error: chatResult.error ?? 'Ollama generation request failed' };
    }

    const parsedOut = this.parseModelOutput(chatResult.data);
    if (parsedOut.data && hasRecruiterOrCritiqueLeak(parsedOut.data)) {
      const client = this.resolveClient(runtimeConfig.data.baseUrl);
      const retried = await this.rewriteApplicantCoverLetter(
        client,
        runtimeConfig.data,
        parsedInput.data,
        runtimeConfig.data.provider === 'npu'
      );
      if (!retried.error && retried.data) {
        return retried;
      }
      return { data: null, error: 'Cover letter failed applicant persona check' };
    }

    return parsedOut;
  }

  public async evaluateVacancy(input: VacancyEvaluationInput): Promise<SafeResult<VacancyEvaluationResult>> {
    const parsedInput = VacancyEvaluationInputSchema.safeParse(input);
    if (!parsedInput.success) {
      return { data: null, error: parsedInput.error.issues[0]?.message ?? 'Invalid vacancy evaluation input' };
    }

    const runtimeConfig = await this.resolveActiveTarget();
    if (runtimeConfig.error || !runtimeConfig.data) {
      return { data: null, error: runtimeConfig.error ?? 'Failed to resolve LLM configuration' };
    }

    const minMatchScore = parsedInput.data.minMatchScore ?? (this.configStore.getMinMatchScore().data ?? 70);
    const chatResult = await this.executeChatWithFallback(runtimeConfig.data, (isNpu) => ({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT_EVALUATE },
        { role: 'user', content: this.buildEvaluationUserPrompt(parsedInput.data, minMatchScore, isNpu) },
      ],
      format: VACANCY_EVALUATION_JSON_SCHEMA,
      temperature: 0.45,
    }));

    if (chatResult.error || !chatResult.data) {
      return { data: null, error: chatResult.error ?? 'Ollama evaluation request failed' };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripMarkdownFences(chatResult.data));
    } catch {
      return { data: null, error: 'Failed to parse LLM evaluation output as JSON' };
    }

    const validated = VacancyEvaluationResponseSchema.safeParse(parsedJson);
    if (!validated.success) {
      return {
        data: null,
        error: validated.error.issues[0]?.message ?? 'Invalid evaluation JSON structure',
      };
    }

    if (validated.data.matchScore < minMatchScore) {
      return {
        data: {
          matchScore: validated.data.matchScore,
          reasoning: validated.data.reasoning,
          coverLetter: '',
        },
        error: null,
      };
    }

    if (validated.data.matchScore >= minMatchScore && validated.data.coverLetter.length < 20) {
      return { data: null, error: 'Cover letter text is too short for matched vacancy' };
    }

    let finalCoverLetter = validated.data.coverLetter;
    if (hasRecruiterOrCritiqueLeak(finalCoverLetter)) {
      logger.warn(
        `Обнаружен ответ от лица рекрутера/самокритика в coverLetter (${runtimeConfig.data.model}). Перегенерация строго от 1-го лица соискателя...`
      );
      const client = this.resolveClient(runtimeConfig.data.baseUrl);
      const retried = await this.rewriteApplicantCoverLetter(
        client,
        runtimeConfig.data,
        parsedInput.data,
        runtimeConfig.data.provider === 'npu'
      );
      if (retried.error || !retried.data) {
        return { data: null, error: retried.error ?? 'Failed to rewrite cover letter from applicant perspective' };
      }
      finalCoverLetter = retried.data;
    }

    return {
      data: {
        matchScore: validated.data.matchScore,
        reasoning: validated.data.reasoning,
        coverLetter: finalCoverLetter,
      },
      error: null,
    };
  }

  public async answerEmployerQuestions(input: AnswerEmployerQuestionsInput): Promise<SafeResult<EmployerQuestionAnswer[]>> {
    const parsedInput = AnswerEmployerQuestionsInputSchema.safeParse(input);
    if (!parsedInput.success) {
      return { data: null, error: parsedInput.error.issues[0]?.message ?? 'Invalid questions input' };
    }

    const runtimeConfig = await this.resolveActiveTarget();
    if (runtimeConfig.error || !runtimeConfig.data) {
      return { data: null, error: runtimeConfig.error ?? 'Failed to resolve LLM configuration' };
    }

    const chatResult = await this.executeChatWithFallback(runtimeConfig.data, (isNpu) => ({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT_QUESTIONS },
        { role: 'user', content: this.buildQuestionsUserPrompt(parsedInput.data, isNpu) },
      ],
      format: EMPLOYER_QUESTIONS_JSON_SCHEMA,
      temperature: 0.2,
    }));

    if (chatResult.error || !chatResult.data) {
      return { data: null, error: chatResult.error ?? 'Ollama questions request failed' };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripMarkdownFences(chatResult.data));
    } catch {
      return { data: null, error: 'Failed to parse LLM questions output as JSON' };
    }

    const validated = AnswerEmployerQuestionsResponseSchema.safeParse(parsedJson);
    if (!validated.success) {
      return {
        data: null,
        error: validated.error.issues[0]?.message ?? 'Invalid questions response structure',
      };
    }

    return { data: validated.data.answers, error: null };
  }

  private async executeChatWithFallback(
    activeTarget: { provider: LlmProviderType; baseUrl: string; model: string; numCtx: number },
    buildRequest: (isNpu: boolean) => {
      messages: Array<{ role: string; content: string }>;
      format?: unknown;
      temperature: number;
    }
  ): Promise<SafeResult<string>> {
    const isNpu = activeTarget.provider === 'npu';
    const timeoutMs = this.options?.requestTimeoutMs ?? (isNpu ? 60_000 : 90_000);
    const client = this.resolveClient(activeTarget.baseUrl);
    const req = buildRequest(isNpu);

    try {
      const response = await withTimeout(
        client.chat({
          model: activeTarget.model,
          stream: false,
          keep_alive: '2m',
          format: req.format as any,
          options: {
            num_ctx: activeTarget.numCtx,
            temperature: req.temperature,
          },
          messages: req.messages,
        }),
        timeoutMs
      );

      const content = response.message?.content?.trim() ?? '';
      if (!content) {
        return { data: null, error: 'Empty response received from Ollama model' };
      }
      return { data: content, error: null };
    } catch (err) {
      if (isNpu) {
        logger.warn(
          `NPU request failed (${err instanceof Error ? err.message : String(err)}), falling back to GPU (num_ctx: 8192)...`
        );
        const gpuConfig = this.resolveGpuFallbackTarget();
        const gpuTimeout = this.options?.requestTimeoutMs ?? 90_000;
        const gpuClient = this.resolveClient(gpuConfig.baseUrl);
        const gpuReq = buildRequest(false);
        try {
          const gpuResp = await withTimeout(
            gpuClient.chat({
              model: gpuConfig.model,
              stream: false,
              keep_alive: '2m',
              format: gpuReq.format as any,
              options: {
                num_ctx: 8192,
                temperature: gpuReq.temperature,
              },
              messages: gpuReq.messages,
            }),
            gpuTimeout
          );
          const gpuContent = gpuResp.message?.content?.trim() ?? '';
          if (!gpuContent) {
            return { data: null, error: 'Empty response received from Ollama model' };
          }
          return { data: gpuContent, error: null };
        } catch (gpuErr) {
          const msg = gpuErr instanceof Error ? gpuErr.message : 'GPU fallback request failed';
          return { data: null, error: msg };
        }
      }
      const msg = err instanceof Error ? err.message : 'Ollama generation request failed';
      return { data: null, error: msg };
    }
  }

  private resolveGpuFallbackTarget(): { baseUrl: string; model: string } {
    const fallback = this.resolveRuntimeConfig();
    return {
      baseUrl: fallback.data?.baseUrl ?? 'http://127.0.0.1:11434',
      model: fallback.data?.model ?? 'gemma4:64k',
    };
  }

  public async checkHealth(): Promise<SafeResult<{ model: string; baseUrl: string }>> {
    const runtimeConfig = await this.resolveActiveTarget();
    if (runtimeConfig.error || !runtimeConfig.data) {
      return { data: null, error: runtimeConfig.error ?? 'Failed to resolve LLM configuration' };
    }

    return {
      data: {
        model: runtimeConfig.data.model,
        baseUrl: runtimeConfig.data.baseUrl,
      },
      error: null,
    };
  }

  public async inspectStatus(): Promise<SafeResult<LlmHealthStatus>> {
    const runtimeConfig = await this.resolveActiveTarget();
    if (runtimeConfig.error || !runtimeConfig.data) {
      return {
        data: null,
        error: runtimeConfig.error ?? 'Failed to resolve LLM configuration',
      };
    }

    const { baseUrl, model: configuredModel, provider, gpu3dLoadPct, vramUsedMb, npuReady } = runtimeConfig.data;
    const gamingMode =
      typeof this.configStore.getGamingMode === 'function'
        ? (this.configStore.getGamingMode().data ?? 'auto')
        : 'auto';
    const client = this.resolveClient(baseUrl);
    const startTime = performance.now();

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const listPromise = client.list();
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Connection timed out (5000ms)')), 5000);
      });
      const response = await Promise.race([listPromise, timeoutPromise]).finally(() => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      });
      const pingMs = Math.round(performance.now() - startTime);

      const installedModels: LlmModelDetails[] = (response.models ?? []).map((m) => ({
        name: m.name,
        size: m.size ?? 0,
        modifiedAt: m.modified_at ? String(m.modified_at) : undefined,
        digest: m.digest,
      }));

      let activeModels: LlmActiveModelDetails[] = [];
      try {
        const psRes = await client.ps();
        activeModels = (psRes.models ?? []).map((m) => ({
          name: m.name,
          sizeVram: m.size_vram,
          expiresAt: m.expires_at ? String(m.expires_at) : undefined,
        }));
      } catch {
        activeModels = [];
      }

      const isInstalled = installedModels.some((m) => matchesModelName(configuredModel, m.name));
      const isLoaded = activeModels.some((m) => matchesModelName(configuredModel, m.name));

      return {
        data: {
          isOnline: true,
          baseUrl,
          configuredModel,
          isConfiguredModelInstalled: isInstalled,
          isConfiguredModelLoaded: isLoaded,
          pingMs,
          installedModels,
          activeModels,
          gamingMode,
          activeProvider: provider,
          gpu3dLoadPct,
          vramUsedMb,
          npuReady,
          error: null,
        },
        error: null,
      };
    } catch (err) {
      const pingMs = Math.round(performance.now() - startTime);
      const message = err instanceof Error ? err.message : 'LLM connection error';
      return {
        data: {
          isOnline: false,
          baseUrl,
          configuredModel,
          isConfiguredModelInstalled: false,
          isConfiguredModelLoaded: false,
          pingMs,
          installedModels: [],
          activeModels: [],
          gamingMode,
          activeProvider: provider,
          gpu3dLoadPct,
          vramUsedMb,
          npuReady,
          error: message,
        },
        error: null,
      };
    }
  }

  public async listAvailableModels(): Promise<SafeResult<LlmModelDetails[]>> {
    const runtimeConfig = this.resolveRuntimeConfig();
    if (runtimeConfig.error || !runtimeConfig.data) {
      return {
        data: null,
        error: runtimeConfig.error ?? 'Failed to resolve LLM configuration',
      };
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const client = this.resolveClient(runtimeConfig.data.baseUrl);
      const listPromise = client.list();
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Connection timed out (5000ms)')), 5000);
      });
      const response = await Promise.race([listPromise, timeoutPromise]).finally(() => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      });
      const models: LlmModelDetails[] = (response.models ?? []).map((m) => ({
        name: m.name,
        size: m.size ?? 0,
        modifiedAt: m.modified_at ? String(m.modified_at) : undefined,
        digest: m.digest,
      }));
      return { data: models, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to list Ollama models';
      return { data: null, error: message };
    }
  }

  public async unloadModel(): Promise<SafeResult<boolean>> {
    const runtimeConfig = await this.resolveActiveTarget();
    if (runtimeConfig.error || !runtimeConfig.data) {
      return { data: null, error: runtimeConfig.error ?? 'Failed to resolve LLM configuration' };
    }
    try {
      const url = `${runtimeConfig.data.baseUrl.replace(/\/+$/, '')}/api/generate`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: runtimeConfig.data.model,
          keep_alive: 0,
        }),
      });
      logger.info(`Модель ${runtimeConfig.data.model} выгружена из памяти (keep_alive: 0).`);
      return { data: true, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to unload model';
      logger.warn(`Не удалось выгрузить модель ${runtimeConfig.data.model}: ${msg}`);
      return { data: null, error: msg };
    }
  }

  private resolveClient(baseUrl: string): {
    chat: (req: ChatRequest & { stream?: false }) => Promise<ChatResponse>;
    list: () => Promise<ListResponse>;
    ps: () => Promise<ListResponse>;
  } {
    const fallback = new Ollama({ host: baseUrl });
    return {
      chat: (req) => (this.customClient ? this.customClient.chat(req) : fallback.chat(req)),
      list: () => (this.customClient?.list ? this.customClient.list() : fallback.list()),
      ps: () => (this.customClient?.ps ? this.customClient.ps() : fallback.ps()),
    };
  }

  private async resolveActiveTarget(): Promise<
    SafeResult<{
      provider: LlmProviderType;
      baseUrl: string;
      model: string;
      numCtx: number;
      gpu3dLoadPct: number;
      vramUsedMb: number;
      npuReady: boolean;
    }>
  > {
    if (this.gamingModeService) {
      const routed = await this.gamingModeService.resolveRoutingTarget();
      if (!routed.error && routed.data) {
        return { data: routed.data, error: null };
      }
    }

    const fallback = this.resolveRuntimeConfig();
    if (fallback.error || !fallback.data) {
      return { data: null, error: fallback.error ?? 'Failed to resolve LLM configuration' };
    }

    return {
      data: {
        provider: 'gpu',
        baseUrl: fallback.data.baseUrl,
        model: fallback.data.model,
        numCtx: 65536,
        gpu3dLoadPct: 0,
        vramUsedMb: 0,
        npuReady: false,
      },
      error: null,
    };
  }

  private resolveRuntimeConfig(): SafeResult<{ baseUrl: string; model: string }> {
    const baseUrlResult = this.configStore.get('LLM_BASE_URL');
    if (baseUrlResult.error) {
      return { data: null, error: baseUrlResult.error };
    }

    const modelResult = this.configStore.get('LLM_MODEL_NAME');
    if (modelResult.error) {
      return { data: null, error: modelResult.error };
    }

    return {
      data: {
        baseUrl: baseUrlResult.data ?? 'http://127.0.0.1:11434',
        model: modelResult.data ?? 'gemma4:64k',
      },
      error: null,
    };
  }

  private buildUserPrompt(data: CoverLetterInput, isNpu = false): string {
    const vacancyDesc = isNpu ? compactForNpu(data.vacancyDescription, 1200) : data.vacancyDescription;
    const resumeText = isNpu ? compactForNpu(data.resumeRawText, 2000) : data.resumeRawText;
    const sections = [
      `Target Company: ${data.companyName}`,
      `Target Position: ${data.vacancyTitle}`,
      `Candidate Resume (Я — разработчик, автор этого резюме):\n${resumeText}`,
      `Vacancy Description (Вакансия работодателя, куда я откликаюсь):\n${vacancyDesc}`,
      `Instruction: Напиши убедительное, не шаблонное сопроводительное письмо (coverLetter, 3-5 предложений) от первого лица («я», «мой опыт», «писал», «настраивал», «решал») работодателю "${data.companyName}" на позицию "${data.vacancyTitle}". Внимательно изучи описание вакансии и выдели ключевые требования, стек и задачи. Найди пересечения с моим резюме и покажи практический релевантный опыт (уверенно преподноси и подчеркивай совпадающие технологии и задачи). Обязательно органично упомяни имя компании "${data.companyName}". Разнообразь формулировки, пиши живым человеческим языком инженера. СТРОГО ЗАПРЕЩЕНЫ штампы ИИ («Меня заинтересовала ваша вакансия», «позволяет мне эффективно взаимодействовать», «современные технологии», «что соответствует требованиям вашей вакансии», «будет полезен для выполнения задач»). Запрещено писать «Ваше резюме» или указывать недостатки.`,
    ];

    if (data.customPromptRules && data.customPromptRules.trim().length > 0) {
      const rules = isNpu ? compactForNpu(data.customPromptRules, 300) : data.customPromptRules.trim();
      sections.push(`Additional Candidate Style Preferences:\n${rules}`);
    }

    return sections.join('\n\n---\n\n');
  }

  private buildEvaluationUserPrompt(
    data: z.infer<typeof VacancyEvaluationInputSchema>,
    minMatchScore: number,
    isNpu = false
  ): string {
    const vacancyDesc = isNpu ? compactForNpu(data.vacancyDescription, 1200) : data.vacancyDescription;
    const resumeText = isNpu ? compactForNpu(data.resumeRawText, 2000) : data.resumeRawText;
    const sections = [
      `Target Company: ${data.companyName}`,
      `Target Position: ${data.vacancyTitle}`,
      `Minimum Match Score Threshold: ${minMatchScore}`,
      `Candidate Resume (Я — разработчик, автор этого резюме):\n${resumeText}`,
      `Vacancy Description (Вакансия работодателя, куда я откликаюсь):\n${vacancyDesc}`,
      `Instruction: Оцени совпадение (matchScore, reasoning). Если matchScore >= ${minMatchScore}, напиши в coverLetter убедительное, не шаблонное сопроводительное письмо (3-5 емких предложений) от первого лица («я», «мой опыт», «делал», «настраивал», «проектировал»). Проанализируй описание вакансии: выдели ключевые требования, стек и задачи работодателя, найди пересечения с резюме кандидата и свяжи свой опыт с тем, что нужно проекту (слегка подчеркивая и усиливая релевантный практический опыт). Обязательно органично назови компанию "${data.companyName}" или команду в тексте. Избегай шаблонных одинаковых вступлений, разнообразь структуру письма. СТРОГО ЗАПРЕЩЕНЫ фразы-клише ИИ («Меня заинтересовала ваша вакансия», «позволяет мне эффективно взаимодействовать», «современные технологии», «что соответствует требованиям вашей вакансии», «будет полезен для выполнения задач», «внести вклад»). Запрещено писать от лица рекрутера («Ваше резюме») или про нехватку опыта!`,
    ];

    if (data.customPromptRules && data.customPromptRules.trim().length > 0) {
      const rules = isNpu ? compactForNpu(data.customPromptRules, 400) : data.customPromptRules.trim();
      sections.push(`Additional Candidate Style Preferences:\n${rules}`);
    }

    return sections.join('\n\n---\n\n');
  }

  private async rewriteApplicantCoverLetter(
    client: { chat: (req: ChatRequest & { stream?: false }) => Promise<ChatResponse> },
    runtimeConfig: { model: string; numCtx: number },
    data: {
      resumeRawText: string;
      vacancyTitle: string;
      companyName: string;
      vacancyDescription: string;
      customPromptRules?: string | null;
    },
    isNpu: boolean
  ): Promise<SafeResult<string>> {
    const prompt = this.buildUserPrompt(data, isNpu);
    const timeoutMs = this.options?.requestTimeoutMs ?? (isNpu ? 60_000 : 90_000);
    try {
      const response = await withTimeout(
        client.chat({
          model: runtimeConfig.model,
          stream: false,
          keep_alive: '2m',
          format: COVER_LETTER_JSON_SCHEMA,
          options: {
            num_ctx: runtimeConfig.numCtx,
            temperature: 0.35,
          },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
        }),
        timeoutMs
      );

      const rawContent = response.message?.content?.trim() ?? '';
      if (!rawContent) {
        return { data: null, error: 'Empty response received on cover letter retry' };
      }

      const parsed = this.parseModelOutput(rawContent);
      if (parsed.error || !parsed.data) {
        return parsed;
      }

      if (hasRecruiterOrCritiqueLeak(parsed.data)) {
        return { data: null, error: 'Cover letter still contains recruiter persona leak after retry' };
      }

      return parsed;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cover letter retry failed';
      return { data: null, error: message };
    }
  }

  private buildQuestionsUserPrompt(data: AnswerEmployerQuestionsInput, isNpu = false): string {
    const resumeText = isNpu ? compactForNpu(data.resumeRawText, 2200) : data.resumeRawText;
    const formattedQuestions = data.questions
      .map((q, index) => {
        const parts = [
          `Question #${index + 1} (id: "${q.id}", type: "${q.fieldType}"):`,
          q.questionText,
        ];
        if (q.options && q.options.length > 0) {
          parts.push(`Options:\n${q.options.map((opt) => `- ${opt}`).join('\n')}`);
        }
        return parts.join('\n');
      })
      .join('\n\n');

    return [
      `Target Company: ${data.companyName}`,
      `Target Position: ${data.vacancyTitle}`,
      `Candidate Resume:\n${resumeText}`,
      `Employer Questions to answer:\n${formattedQuestions}`,
    ].join('\n\n---\n\n');
  }

  private parseModelOutput(rawContent: string): SafeResult<string> {
    try {
      const parsedJson: unknown = JSON.parse(stripMarkdownFences(rawContent));
      const validated = CoverLetterResponseSchema.safeParse(parsedJson);
      if (validated.success) {
        return { data: validated.data.coverLetter, error: null };
      }
      return {
        data: null,
        error: validated.error.issues[0]?.message ?? 'Invalid cover letter JSON structure',
      };
    } catch {
      const fallbackValidated = CoverLetterResponseSchema.safeParse({ coverLetter: rawContent });
      if (fallbackValidated.success) {
        return { data: fallbackValidated.data.coverLetter, error: null };
      }
      return { data: null, error: 'Failed to parse LLM output as valid cover letter' };
    }
  }
}

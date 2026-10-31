import { z } from 'zod';
import type { IConfigStore, SafeResult } from '../config-store/index.ts';
import type { ChatMessageBubble } from '../hh-hybrid/index.ts';
import { agentLogger, type IAgentLoggerService } from '../logger/index.ts';
import type { IGamingModeService } from './gaming-mode.service.ts';

export const LlmChatReplySchema = z.object({
  replyText: z.string().min(10).max(1500),
  confidenceScore: z.number().min(0).max(100),
  summaryOfIntent: z.string().min(1),
});

export type LlmChatReply = z.infer<typeof LlmChatReplySchema>;

export interface GenerateEmployerReplyInput {
  readonly resumeRawText: string;
  readonly companyName: string;
  readonly positionTitle: string;
  readonly chatHistory: ReadonlyArray<ChatMessageBubble>;
  readonly lastUnreadText: string;
  readonly customPromptRules?: string | null;
  readonly temperature?: number;
  readonly traceId?: string;
}

export interface LlmReplyServiceOptions {
  readonly customFetch?: typeof fetch;
  readonly loggerService?: IAgentLoggerService;
  readonly gamingModeService?: IGamingModeService;
  readonly requestTimeoutMs?: number;
}

export interface ILlmReplyService {
  generateEmployerReply(input: GenerateEmployerReplyInput): Promise<SafeResult<LlmChatReply>>;
}

const SYSTEM_PROMPT = [
  'Act as the candidate responding to an employer in HH.ru chat.',
  'Answer the employer message politely, concisely, and professionally in Russian, strictly using facts from the candidate resume (never invent skills or experience).',
  'Return ONLY a JSON object matching {"replyText": "...", "confidenceScore": 0..100, "summaryOfIntent": "..."}.',
].join('\n');

export function stripMarkdownFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
  const match = fenceRegex.exec(trimmed);
  if (match && match[1]) {
    return match[1].trim();
  }
  if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
    const inner = trimmed.slice(3, -3).trim();
    if (inner.toLowerCase().startsWith('json')) {
      return inner.slice(4).trim();
    }
    return inner;
  }
  return trimmed;
}

function buildUserPrompt(input: GenerateEmployerReplyInput, isNpu = false): string {
  const resumeText =
    isNpu && input.resumeRawText.length > 2200
      ? `${input.resumeRawText.slice(0, 1650)}\n...\n${input.resumeRawText.slice(-500)}`
      : input.resumeRawText;
  const sections: string[] = [
    `Target Company: ${input.companyName}`,
    `Target Position: ${input.positionTitle}`,
    `Candidate Resume:\n${resumeText}`,
  ];

  if (input.chatHistory && input.chatHistory.length > 0) {
    const formattedHistory = input.chatHistory
      .map((msg) => {
        const senderLabel = msg.sender === 'employer' ? 'Employer' : 'Candidate';
        const timestamp = msg.timestamp ? ` [${msg.timestamp}]` : '';
        return `${senderLabel}${timestamp}: ${msg.text}`;
      })
      .join('\n');
    sections.push(`Chat History:\n${formattedHistory}`);
  }

  sections.push(`Last Message from Employer:\n${input.lastUnreadText}`);

  if (input.customPromptRules && input.customPromptRules.trim().length > 0) {
    sections.push(`Additional Candidate Rules/Preferences:\n${input.customPromptRules.trim()}`);
  }

  return sections.join('\n\n---\n\n');
}

export class LlmReplyService implements ILlmReplyService {
  private readonly configStore: IConfigStore;
  private readonly fetchFn: typeof fetch;
  private readonly loggerService: IAgentLoggerService;
  private readonly gamingModeService?: IGamingModeService;
  private readonly requestTimeoutMs: number;

  constructor(configStore: IConfigStore, options?: LlmReplyServiceOptions) {
    this.configStore = configStore;
    this.fetchFn = options?.customFetch ?? globalThis.fetch;
    this.loggerService = options?.loggerService ?? agentLogger;
    this.gamingModeService = options?.gamingModeService;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 60_000;
  }

  public async generateEmployerReply(
    input: GenerateEmployerReplyInput
  ): Promise<SafeResult<LlmChatReply>> {
    const traceId = input.traceId ?? this.loggerService.createTraceId();
    const startTime = Date.now();

    let baseUrl = (this.configStore.get('LLM_BASE_URL').data ?? '').trim() || 'http://127.0.0.1:11434';
    let modelName = (this.configStore.get('LLM_MODEL_NAME').data ?? '').trim() || 'gemma4:64k';
    let isNpu = false;

    if (this.gamingModeService) {
      const routed = await this.gamingModeService.resolveRoutingTarget();
      if (!routed.error && routed.data) {
        baseUrl = routed.data.baseUrl;
        modelName = routed.data.model;
        isNpu = routed.data.provider === 'npu';
      }
    }

    const userPrompt = buildUserPrompt(input, isNpu);
    const requestBody = {
      model: modelName,
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
      format: 'json',
      stream: false,
      keep_alive: '2m',
      options: {
        temperature: input.temperature ?? 0.35,
      },
    };

    const targetUrl = `${baseUrl.replace(/\/+$/, '')}/api/generate`;
    let rawResponseContent = '';

    try {
      let response: Response;
      try {
        response = await this.fetchFn(targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText || 'Ollama request failed'}`);
        }
      } catch (primaryErr) {
        if (isNpu) {
          const fallbackBaseUrl =
            (this.configStore.get('LLM_BASE_URL').data ?? '').trim() || 'http://127.0.0.1:11434';
          const fallbackModel =
            (this.configStore.get('LLM_MODEL_NAME').data ?? '').trim() || 'gemma4:64k';
          const fallbackTargetUrl = `${fallbackBaseUrl.replace(/\/+$/, '')}/api/generate`;
          const fallbackPrompt = buildUserPrompt(input, false);
          const fallbackBody = {
            model: fallbackModel,
            system: SYSTEM_PROMPT,
            prompt: fallbackPrompt,
            format: 'json',
            stream: false,
            keep_alive: '2m',
            options: {
              temperature: input.temperature ?? 0.35,
              num_ctx: 8192,
            },
          };
          response = await this.fetchFn(fallbackTargetUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(fallbackBody),
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText || 'Ollama request failed'}`);
          }
        } else {
          throw primaryErr;
        }
      }

      const rawJson = (await response.json()) as { response?: unknown };
      if (typeof rawJson?.response !== 'string') {
        const shapeError = new Error('Ollama response body does not contain a string "response" field');
        this.loggerService.logError({
          traceId,
          module: 'LLM_SERVICE',
          action: 'GENERATE_EMPLOYER_REPLY',
          message: 'Failed to call Ollama /api/generate',
          error: shapeError,
          hint: 'Verify Ollama server is running at LLM_BASE_URL and model is pulled',
        });
        return { data: null, error: shapeError.message };
      }

      rawResponseContent = rawJson.response;
    } catch (err) {
      this.loggerService.logError({
        traceId,
        module: 'LLM_SERVICE',
        action: 'GENERATE_EMPLOYER_REPLY',
        message: 'Failed to call Ollama /api/generate',
        error: err,
        hint: 'Verify Ollama server is running at LLM_BASE_URL and model is pulled',
      });
      return {
        data: null,
        error: err instanceof Error ? err.message : 'Failed to call Ollama /api/generate',
      };
    }

    try {
      const stripped = stripMarkdownFences(rawResponseContent);
      const parsedJson: unknown = JSON.parse(stripped);
      const parsed = LlmChatReplySchema.safeParse(parsedJson);

      if (!parsed.success) {
        this.loggerService.logError({
          traceId,
          module: 'LLM_SERVICE',
          action: 'GENERATE_EMPLOYER_REPLY',
          message: 'LLM JSON validation failed',
          error: parsed.error,
          hint: 'LLM JSON output did not match LlmChatReplySchema',
        });
        return { data: null, error: 'LLM JSON output did not match LlmChatReplySchema' };
      }

      const durationMs = Date.now() - startTime;
      this.loggerService.logInfo({
        traceId,
        module: 'LLM_SERVICE',
        action: 'GENERATE_EMPLOYER_REPLY',
        message: `Generated employer chat reply (${parsed.data.replyText.length} chars, confidence=${parsed.data.confidenceScore})`,
        durationMs,
      });

      return { data: parsed.data, error: null };
    } catch (err) {
      this.loggerService.logError({
        traceId,
        module: 'LLM_SERVICE',
        action: 'GENERATE_EMPLOYER_REPLY',
        message: 'LLM JSON validation failed',
        error: err,
        hint: 'LLM JSON output did not match LlmChatReplySchema',
      });
      return { data: null, error: 'LLM JSON output did not match LlmChatReplySchema' };
    }
  }
}

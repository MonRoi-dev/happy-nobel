import { z } from 'zod';

export const HhSalarySchema = z
  .object({
    from: z.number().nullable().optional(),
    to: z.number().nullable().optional(),
    currency: z.string().nullable().optional(),
    gross: z.boolean().nullable().optional(),
  })
  .nullable()
  .optional();

export type HhSalary = z.infer<typeof HhSalarySchema>;

export const HhVacancyShortItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  alternate_url: z.string().url(),
  apply_alternate_url: z.string().url().optional(),
  archived: z.boolean().default(false),
  has_test: z.boolean().default(false),
  response_letter_required: z.boolean().default(false),
  salary: HhSalarySchema,
  employer: z
    .object({
      id: z.string().optional(),
      name: z.string().default('Unknown Company'),
    })
    .nullable()
    .optional(),
  snippet: z
    .object({
      requirement: z.string().nullable().optional(),
      responsibility: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export type HhVacancyShortItem = z.infer<typeof HhVacancyShortItemSchema>;

export const HhVacancySearchResponseSchema = z.object({
  items: z.array(HhVacancyShortItemSchema),
  found: z.number().int().nonnegative().default(0),
  page: z.number().int().nonnegative().default(0),
  pages: z.number().int().nonnegative().default(0),
  per_page: z.number().int().positive().default(20),
});

export type HhVacancySearchResponse = z.infer<typeof HhVacancySearchResponseSchema>;

export const HhVacancyFullResponseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  alternate_url: z.string().url(),
  archived: z.boolean().default(false),
  has_test: z.boolean().default(false),
  response_letter_required: z.boolean().default(false),
  salary: HhSalarySchema,
  employer: z
    .object({
      id: z.string().optional(),
      name: z.string().default('Unknown Company'),
    })
    .nullable()
    .optional(),
  key_skills: z
    .array(
      z.object({
        name: z.string(),
      })
    )
    .default([]),
});

export type HhVacancyFullResponse = z.infer<typeof HhVacancyFullResponseSchema>;

export const VacancySearchQuerySchema = z.object({
  queryText: z.string().trim().min(1),
  excludedWords: z.string().trim().optional().nullable(),
  areaId: z.string().trim().optional().nullable(),
  schedule: z.string().trim().optional().nullable(),
  salaryFrom: z.number().int().positive().optional().nullable(),
  page: z.number().int().min(0).max(19).default(0),
  perPage: z.number().int().min(1).max(100).default(20),
});

export type VacancySearchQuery = z.input<typeof VacancySearchQuerySchema>;

export const ApplyToVacancyInputSchema = z.object({
  vacancyId: z.string().trim().min(1),
  vacancyUrl: z.string().url(),
  resumeTitle: z.string().trim().optional().nullable(),
  coverLetter: z.string().trim().min(1).max(1200),
  skipForeignVacancies: z.boolean().optional().default(true),
  vacancyTitle: z.string().trim().min(1).optional(),
  companyName: z.string().trim().min(1).optional(),
});

export type ApplyToVacancyInput = z.input<typeof ApplyToVacancyInputSchema>;

export const ScrapedNegotiationItemSchema = z.object({
  vacancyId: z.string().min(1),
  status: z.enum(['response', 'invitation', 'discard', 'viewed']),
  lastEmployerMessage: z.string().nullable().default(null),
});

export type ScrapedNegotiationItem = z.infer<typeof ScrapedNegotiationItemSchema>;

export type ValidatedVacancySearchQuery = z.infer<typeof VacancySearchQuerySchema>;

export function stripHtmlTags(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|li|br|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export function formatSalaryText(salary: HhSalary): string {
  if (!salary) {
    return 'Не указана';
  }
  const currency = salary.currency ?? 'RUR';
  if (salary.from && salary.to) {
    return `${salary.from} - ${salary.to} ${currency}`;
  }
  if (salary.from) {
    return `от ${salary.from} ${currency}`;
  }
  if (salary.to) {
    return `до ${salary.to} ${currency}`;
  }
  return 'Не указана';
}

export function normalizeScrapedNegotiationStatus(
  rawBadgeText: string,
  qaAttribute?: string | null
): 'response' | 'invitation' | 'discard' | 'viewed' {
  const qaLower = (qaAttribute ?? '').toLowerCase();
  if (qaLower.includes('interview') || qaLower.includes('invitation')) {
    return 'invitation';
  }
  if (qaLower.includes('not-viewed')) {
    return 'response';
  }
  if (qaLower.includes('viewed')) {
    return 'viewed';
  }
  if (qaLower.includes('discard') || qaLower.includes('decline')) {
    return 'discard';
  }

  const textLower = rawBadgeText.toLowerCase();
  if (textLower.includes('приглаш') || textLower.includes('собеседован')) {
    return 'invitation';
  }
  if (textLower.includes('не просмотрен') || textLower.includes('ожидание')) {
    return 'response';
  }
  if (textLower.includes('просмотрен') || textLower.includes('просмотр')) {
    return 'viewed';
  }
  if (textLower.includes('отказ') || textLower.includes('не готовы')) {
    return 'discard';
  }
  return 'response';
}

export function buildHhSearchVacanciesUrl(
  webBaseUrl: string,
  query: ValidatedVacancySearchQuery
): string {
  const base = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
  const url = new URL(`${base}/search/vacancy`);

  url.searchParams.set('text', query.queryText);
  url.searchParams.set('page', String(query.page));
  url.searchParams.set('items_on_page', String(query.perPage));

  if (query.excludedWords) {
    const cleanedExcluded = query.excludedWords
      .split(/[,\s]+/)
      .map((w) => w.trim())
      .filter(Boolean)
      .join(', ');
    if (cleanedExcluded.length > 0) {
      url.searchParams.set('excluded_text', cleanedExcluded);
    }
  }

  if (query.areaId) {
    url.searchParams.set('area', query.areaId);
  }

  if (query.schedule) {
    url.searchParams.set('schedule', query.schedule);
  }

  if (query.salaryFrom) {
    url.searchParams.set('salary', String(query.salaryFrom));
    url.searchParams.set('currency_code', 'RUR');
  }

  return url.toString();
}

export function isBrowserClosedError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const msg = err.message.toLowerCase();
  return (
    msg.includes('target page, context or browser has been closed') ||
    msg.includes('browser has been closed') ||
    msg.includes('target closed')
  );
}

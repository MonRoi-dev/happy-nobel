import { createLogger } from '../../utils/logger.ts';
import type { SafeResult } from '../config-store/index.ts';
import { extractContacts } from '../parser/index.ts';
import type {
  ClassifiedVacancyTarget,
  ITgChannelScraperService,
  TgChannelPostItem,
  TgChannelPostLink,
} from './tg-channel.types.ts';

const logger = createLogger('TgChannelScraper');

const PROMO_LINK_TEXT_PATTERNS = [
  /poster/i,
  /постим\s+it-вакансии/i,
  /разместить\s+вакансию/i,
  /пишите\s+в\s+поддержку/i,
  /реклама/i,
  /подписаться/i,
];

const PROMO_HREF_PATTERNS = [
  /poster/i,
  /vakansii_it_bot/i,
  /freeit_job/i,
  /node_js_jobs_vakansii/i,
  /t\.me\/s\//i,
];

const APPLY_ANCHOR_TEXT_REGEX = /(откликнуться|apply|отклик|анкета|форма|отправить\s+резюме)/i;
const HH_VACANCY_URL_REGEX = /^https?:\/\/(?:[a-z0-9-]+\.)?hh\.(?:ru|kz|uz|by)\/vacancy\/(\d+)/i;
const TG_DIRECT_USER_URL_REGEX =
  /^https?:\/\/(?:t\.me|telegram\.me)\/@?([a-zA-Z0-9_]{5,32})(?:\/|\?.*)?$/i;

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripTagsPreserveNewlines(html: string): string {
  const withLineBreaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n');
  const stripped = withLineBreaks.replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(stripped)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractChannelSlug(channelUrlOrSlug: string): string | null {
  const trimmed = channelUrlOrSlug.trim();
  const urlMatch = trimmed.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?@?([a-zA-Z0-9_]{4,64})\/?$/i);
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }
  const handleMatch = trimmed.match(/^@?([a-zA-Z0-9_]{4,64})$/);
  if (handleMatch?.[1]) {
    return handleMatch[1];
  }
  return null;
}

export function buildPublicChannelWebUrl(channelUrlOrSlug: string): string | null {
  const slug = extractChannelSlug(channelUrlOrSlug);
  if (!slug) {
    return null;
  }
  return `https://t.me/s/${slug}`;
}

function isPromoLink(link: TgChannelPostLink, channelSlug: string): boolean {
  const baseHref = link.href.split('?')[0] ?? link.href;
  if (baseHref.toLowerCase().includes(channelSlug.toLowerCase())) {
    return true;
  }
  if (PROMO_LINK_TEXT_PATTERNS.some((rx) => rx.test(link.label))) {
    return true;
  }
  if (PROMO_HREF_PATTERNS.some((rx) => rx.test(baseHref))) {
    return true;
  }
  return false;
}

function isPromoOrIgnoredTgUsername(username: string, channelSlug: string): boolean {
  const lower = username.toLowerCase();
  if (lower === 's' || lower === channelSlug.toLowerCase()) {
    return true;
  }
  if (lower.endsWith('bot') || lower.includes('poster') || lower === 'freeit_job') {
    return true;
  }
  return false;
}

function isNonVacancyAnnouncementPost(rawText: string): boolean {
  if (/^📢\s*Обновили\s+формат\s+вакансий/i.test(rawText)) {
    return true;
  }
  if (
    /разместить\s+вакансию\s+в\s+наших\s+каналах/i.test(rawText) &&
    !/Требования/i.test(rawText)
  ) {
    return true;
  }
  return false;
}

function extractTitleAndCompany(rawText: string, messageHtml: string): {
  positionTitle: string;
  companyName: string;
  salaryText: string;
} {
  let positionTitle = 'Node.js Developer';
  const titleLineMatch = rawText.match(/(?:💼|📑|👩‍💻|👨‍💻)?\s*(?:Вакансия|Позиция|Role|Position)\s*[:—-]?\s*([^\n]+)/i);
  if (titleLineMatch?.[1]) {
    positionTitle = titleLineMatch[1].replace(/^Вакансия\s+/i, '').trim();
  } else {
    const firstLine = rawText.split('\n').map((l) => l.trim()).find((l) => l.length > 3);
    if (firstLine) {
      positionTitle = firstLine.replace(/^(?:💼|📑|👩‍💻|👨‍💻)\s*/, '').trim();
    }
  }

  let companyName = 'Unknown Company';
  const boldCompanyAfterGem = messageHtml.match(
    /💎(?:<\/b>)?(?:<\/i>)?(?:<\/tg-emoji>)?\s*(?:В\s+|Компания\s+)?(?:<a[^>]*>\s*)?<b>([^<]+)<\/b>/i
  );
  if (boldCompanyAfterGem?.[1]) {
    companyName = decodeHtmlEntities(boldCompanyAfterGem[1]).trim();
  } else {
    const oldFormatCompanyMatch = rawText.match(/(?:🟢\s*)?В\s+компанию\s+([^\n🟢🟦]+)/i);
    if (oldFormatCompanyMatch?.[1]) {
      companyName = oldFormatCompanyMatch[1].trim();
    } else {
      const gemTextMatch = rawText.match(
        /💎\s*(?:В\s+|Компания\s+)?([A-Za-zА-Яа-яЁё0-9._\-\u2010-\u2015]+(?:\s+[A-Za-zА-Яа-яЁё0-9._\-\u2010-\u2015]+)?)(?:\s+(?:требуется|ищет|в\s+поиске|приглашает|предстоит))?/i
      );
      if (gemTextMatch?.[1]) {
        companyName = gemTextMatch[1].trim();
      } else {
        const explicitCompanyMatch = rawText.match(/(?:Компания|Company)\s*[:—-]\s*([^\n]+)/i);
        if (explicitCompanyMatch?.[1]) {
          companyName = explicitCompanyMatch[1].trim();
        }
      }
    }
  }

  let salaryText = 'Не указана';
  const salaryMatch = rawText.match(/(?:💰\s*|(?:Зарплата|Вилка|Salary)\s*[:—-])\s*([^\n]+)/i);
  if (salaryMatch?.[1]) {
    salaryText = salaryMatch[1].trim();
  } else {
    const currencyMatch = rawText.match(
      /(?:(?:от|from)\s+)?(?:\d[\d\s.,]*\s+(?:до|to)\s+)?\d[\d\s.,]*\s*(?:₽|руб\.?|р\.|USD|\$|EUR|€|евро)(?:\s*(?:net|gross|чистыми|на\s+руки))?/i
    );
    if (currencyMatch?.[0]) {
      salaryText = currencyMatch[0].replace(/\s+/g, ' ').trim();
    } else if (/ЗП\s+обсуждается/i.test(rawText)) {
      salaryText = 'ЗП обсуждается на собеседовании';
    }
  }

  return { positionTitle, companyName, salaryText };
}

export function parseTelegramChannelWebHtml(
  html: string,
  channelSlug: string
): TgChannelPostItem[] {
  const results: TgChannelPostItem[] = [];
  const blockRegex =
    /<div[^>]*class="[^"]*tgme_widget_message[^"]*"[^>]*data-post="([^"]+)"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*tgme_widget_message_wrap|$)/gi;

  for (const match of html.matchAll(blockRegex)) {
    const dataPost = match[1]?.trim() ?? '';
    const blockHtml = match[2] ?? '';
    const postParts = dataPost.split('/');
    const postId = postParts[1] ?? postParts[0] ?? '';
    if (!postId) {
      continue;
    }

    const textBlockMatch = blockHtml.match(
      /<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i
    );
    if (!textBlockMatch?.[1]) {
      continue;
    }
    const messageHtml = textBlockMatch[1];
    const messageHtmlWithoutBlockquotes = messageHtml.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '');
    const rawText = stripTagsPreserveNewlines(messageHtmlWithoutBlockquotes);
    if (rawText.length < 15 || isNonVacancyAnnouncementPost(rawText)) {
      continue;
    }

    const timeMatch = blockHtml.match(/<time[^>]*datetime="([^"]+)"/i);
    const publishedAt = timeMatch?.[1] ?? new Date().toISOString();

    const gemCompanyHrefMatch = messageHtmlWithoutBlockquotes.match(
      /💎(?:<\/b>)?(?:<\/i>)?(?:<\/tg-emoji>)?\s*(?:В\s+|Компания\s+)?<a[^>]*href="([^"]+)"[^>]*>/i
    );
    const gemCompanyHref = gemCompanyHrefMatch?.[1]
      ? decodeHtmlEntities(gemCompanyHrefMatch[1].trim())
      : null;

    const anchorRegex = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const applyLinks: TgChannelPostLink[] = [];
    const mailtoEmails: string[] = [];
    for (const aMatch of messageHtmlWithoutBlockquotes.matchAll(anchorRegex)) {
      const href = decodeHtmlEntities(aMatch[1]?.trim() ?? '');
      const label = stripTagsPreserveNewlines(aMatch[2] ?? '');
      if (/^mailto:/i.test(href)) {
        const emailVal = href.replace(/^mailto:/i, '').split('?')[0]?.trim().toLowerCase() ?? '';
        if (emailVal.includes('@')) {
          mailtoEmails.push(emailVal);
        }
        continue;
      }
      if (!href.startsWith('http')) {
        continue;
      }
      if (gemCompanyHref && href === gemCompanyHref && !extractHhVacancyIdFromUrl(href)) {
        continue;
      }
      const linkObj: TgChannelPostLink = { href, label };
      if (!isPromoLink(linkObj, channelSlug)) {
        applyLinks.push(linkObj);
      }
    }

    const explicitApplyLink =
      applyLinks.find((l) => APPLY_ANCHOR_TEXT_REGEX.test(l.label) || Boolean(extractHhVacancyIdFromUrl(l.href))) ??
      applyLinks.find((l) => TG_DIRECT_USER_URL_REGEX.test(l.href)) ??
      applyLinks[0] ??
      null;

    const extracted = extractContacts(rawText);
    const tgContactsFromText = extracted.telegramHandles
      .map((h) => h.replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i, '').replace(/^@/, '').split('?')[0]?.trim() ?? '')
      .filter((u) => u.length >= 5 && !isPromoOrIgnoredTgUsername(u, channelSlug));

    const tgContactsFromLinks: string[] = [];
    for (const l of applyLinks) {
      const m = TG_DIRECT_USER_URL_REGEX.exec(l.href);
      if (m?.[1] && !isPromoOrIgnoredTgUsername(m[1], channelSlug)) {
        tgContactsFromLinks.push(m[1]);
      }
    }
    const tgContacts = Array.from(new Set([...tgContactsFromLinks, ...tgContactsFromText]));
    const hrEmails = Array.from(
      new Set([...mailtoEmails, ...extracted.emails.map((e) => e.trim().toLowerCase())])
    ).filter((e) => e.length >= 5 && !e.includes('poster'));

    const { positionTitle, companyName, salaryText } = extractTitleAndCompany(rawText, messageHtmlWithoutBlockquotes);

    results.push({
      channelSlug,
      postId,
      vacancyKey: `tg:${channelSlug}:${postId}`,
      postUrl: `https://t.me/${channelSlug}/${postId}`,
      publishedAt,
      rawText,
      positionTitle,
      companyName,
      salaryText,
      primaryApplyUrl: explicitApplyLink?.href ?? null,
      applyLinks,
      tgContacts,
      hrEmails,
    });
  }

  return results;
}

export const parsePublicChannelHtml = parseTelegramChannelWebHtml;

export function extractHhVacancyIdFromUrl(url: string): string | null {
  const match = HH_VACANCY_URL_REGEX.exec(url.trim());
  return match?.[1] ?? null;
}

export function classifyChannelPostTarget(post: TgChannelPostItem): ClassifiedVacancyTarget | null {
  const candidateUrls = [
    ...(post.primaryApplyUrl ? [post.primaryApplyUrl] : []),
    ...post.applyLinks.map((l) => l.href),
  ];

  for (const url of candidateUrls) {
    const hhId = extractHhVacancyIdFromUrl(url);
    if (hhId) {
      return {
        kind: 'hh_vacancy',
        hhVacancyId: hhId,
        hhVacancyUrl: `https://hh.ru/vacancy/${hhId}`,
      };
    }
  }

  for (const url of candidateUrls) {
    const tgMatch = TG_DIRECT_USER_URL_REGEX.exec(url);
    if (tgMatch?.[1]) {
      const username = tgMatch[1];
      if (!isPromoOrIgnoredTgUsername(username, post.channelSlug)) {
        return {
          kind: 'tg_contact',
          tgUsername: username,
          tgChatUrl: `https://t.me/${username}`,
        };
      }
    }
  }

  if (post.primaryApplyUrl) {
    return {
      kind: 'external_form',
      targetUrl: post.primaryApplyUrl,
    };
  }

  if (post.tgContacts.length > 0) {
    const username = post.tgContacts[0]!;
    return {
      kind: 'tg_contact',
      tgUsername: username,
      tgChatUrl: `https://t.me/${username}`,
    };
  }

  if (post.hrEmails && post.hrEmails.length > 0) {
    const email = post.hrEmails[0]!;
    return {
      kind: 'tg_contact',
      tgUsername: email,
      tgChatUrl: post.postUrl,
      hrEmail: email,
      contactType: 'email',
    };
  }

  return null;
}

export interface TgChannelScraperOptions {
  readonly customFetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class TgChannelScraperService implements ITgChannelScraperService {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options?: TgChannelScraperOptions) {
    this.fetchFn = options?.customFetch ?? fetch;
    this.timeoutMs = options?.timeoutMs ?? 15_000;
  }

  public async scrapePublicChannelPosts(
    channelUrlOrSlug: string,
    limit = 20
  ): Promise<SafeResult<TgChannelPostItem[]>> {
    const slug = extractChannelSlug(channelUrlOrSlug);
    const webUrl = buildPublicChannelWebUrl(channelUrlOrSlug);
    if (!slug || !webUrl) {
      logger.warn(`Некорректный идентификатор Telegram-канала: ${channelUrlOrSlug}`);
      return { data: null, error: `Invalid Telegram channel identifier: ${channelUrlOrSlug}` };
    }

    try {
      logger.info(`Запрос публичной веб-ленты Telegram-канала @${slug} (${webUrl})...`);
      const response = await this.fetchFn(webUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        logger.warn(`Ошибка HTTP ${response.status} при чтении канала ${webUrl}`);
        return { data: null, error: `HTTP ${response.status} when fetching ${webUrl}` };
      }

      const html = await response.text();
      const allPosts = parseTelegramChannelWebHtml(html, slug);
      const sliced = allPosts.slice(Math.max(0, allPosts.length - limit));
      logger.info(
        `Из HTML канала @${slug} извлечено постов с вакансиями: ${allPosts.length} (взято в работу: ${sliced.length}).`
      );
      return { data: sliced, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to scrape Telegram channel';
      logger.error(`Сбой при получении постов из канала ${webUrl}: ${msg}`, err);
      return { data: null, error: msg };
    }
  }
}

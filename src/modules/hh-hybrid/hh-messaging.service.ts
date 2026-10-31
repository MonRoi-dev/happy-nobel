import { chromium, type BrowserContext, type Page } from 'playwright';
import type { SafeResult } from '../config-store/index.ts';
import { agentLogger, type IAgentLoggerService } from '../logger/index.ts';
import { isBrowserClosedError } from './hh-hybrid.schemas.ts';
import type { IHhHybridService } from './hh-hybrid.service.ts';
import { isTrackerUrl } from './hh-playwright.driver.ts';

const SYSTEM_CHAT_PATTERNS = [
  /пользователь.*(покинул|присоединился)/i,
  /ии-помощник.*(покинул|присоединился)/i,
  /чат\s+создан/i,
  /отклик\s+на\s+вакансию/i,
  /вы\s+откликнулись/i,
  /собеседование\s+назначено/i,
  /непрочитанные\s+сообщения/i,
  /новые\s+сообщения/i,
  /отклик\s+отправлен/i,
];

const DATE_DIVIDER_PATTERN =
  /^(сегодня|вчера|позавчера|\d{1,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)|\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?)(\s+\d{1,2}:\d{2})?$/i;

export function isInformativeEmployerMessage(rawText: string | null | undefined): boolean {
  if (!rawText) {
    return false;
  }
  const text = rawText.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length < 10) {
    return false;
  }
  if (DATE_DIVIDER_PATTERN.test(text)) {
    return false;
  }
  if (/^\d{1,2}:\d{2}$/.test(text)) {
    return false;
  }
  for (const pattern of SYSTEM_CHAT_PATTERNS) {
    if (pattern.test(text)) {
      return false;
    }
  }
  return /[a-zA-Zа-яА-ЯёЁ]/.test(text);
}

export interface ChatMessageBubble {
  readonly sender: 'employer' | 'applicant';
  readonly text: string;
  readonly timestamp?: string;
}

export interface UnreadNegotiationItem {
  readonly negotiationId: string;
  readonly vacancyId: string;
  readonly companyName: string;
  readonly positionTitle: string;
  readonly chatUrl: string;
  readonly unreadMessages: ReadonlyArray<string>;
  readonly fullHistory: ReadonlyArray<ChatMessageBubble>;
}

export interface HhMessagingBrowserDriver {
  fetchUnreadInBrowser(sessionDir: string, traceId: string): Promise<SafeResult<UnreadNegotiationItem[]>>;
  sendChatInBrowser(
    sessionDir: string,
    negotiationId: string,
    replyText: string,
    traceId: string
  ): Promise<SafeResult<boolean>>;
}

export interface HhMessagingOptions {
  readonly webBaseUrl?: string;
  readonly customDriver?: HhMessagingBrowserDriver;
  readonly loggerService?: IAgentLoggerService;
}

export interface IHhMessagingService {
  fetchUnreadNegotiations(traceId?: string): Promise<SafeResult<UnreadNegotiationItem[]>>;
  sendChatMessage(negotiationId: string, replyText: string, traceId?: string): Promise<SafeResult<boolean>>;
}

export class DefaultHhMessagingBrowserDriver implements HhMessagingBrowserDriver {
  private readonly webBaseUrl: string;
  private readonly loggerService: IAgentLoggerService;

  constructor(webBaseUrl = 'https://hh.ru', loggerService: IAgentLoggerService = agentLogger) {
    this.webBaseUrl = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
    this.loggerService = loggerService;
  }

  public async fetchUnreadInBrowser(
    sessionDir: string,
    traceId: string
  ): Promise<SafeResult<UnreadNegotiationItem[]>> {
    let context: BrowserContext | null = null;
    let currentPage: Page | null = null;
    try {
      context = await chromium.launchPersistentContext(sessionDir, {
        headless: true,
        viewport: { width: 1280, height: 840 },
      });
      if (typeof context.route === 'function') {
        await context.route('**/*', async (route) => {
          if (isTrackerUrl(route.request().url())) {
            await route.abort().catch(() => undefined);
            return;
          }
          await route.continue().catch(() => undefined);
        });
      }

      const page = context.pages()[0] ?? (await context.newPage());
      currentPage = page;

      let navResp = await page
        .goto(`${this.webBaseUrl}/chat`, { waitUntil: 'domcontentloaded' })
        .catch(() => null);

      if (!navResp || navResp.status() >= 400) {
        navResp = await page.goto(`${this.webBaseUrl}/applicant/negotiations`, {
          waitUntil: 'domcontentloaded',
        });
      }

      if (navResp && navResp.status() >= 400) {
        await this.loggerService.logPlaywrightError({
          traceId,
          module: 'HH_MESSAGING',
          action: 'FETCH_UNREAD_NEGOTIATIONS',
          error: new Error(`HTTP ${navResp.status()}`),
          page,
          httpStatus: navResp.status(),
          hint: 'HH.ru negotiations returned HTTP >= 400 inside Playwright persistent session; check cookies or anti-bot challenge',
        });
        return { data: null, error: `HTTP ${navResp.status()}: negotiations navigation failed` };
      }

      await page.waitForTimeout(1500);

      if (page.url().includes('/account/login')) {
        await this.loggerService.logPlaywrightError({
          traceId,
          module: 'HH_MESSAGING',
          action: 'FETCH_UNREAD_NEGOTIATIONS',
          error: new Error('Session redirected to /account/login'),
          page,
          hint: 'HH.ru session is not authenticated (/account/login)',
        });
        return { data: null, error: 'Сессия HH.ru не авторизована (/account/login).' };
      }

      await page
        .locator('a[data-qa*="chatik-open-chat"], a[href*="/chat/"], [data-qa="negotiations-item"]')
        .first()
        .waitFor({ timeout: 3000 })
        .catch(() => undefined);

      const rawUnreadRows = await page.evaluate(() => {
        const normalize = (value: string | null | undefined): string =>
          (value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

        const items = Array.from(
          document.querySelectorAll(
            'a[data-qa*="chatik-open-chat"], a[href*="/chat/"], [data-qa="negotiations-item"]'
          )
        );
        const extracted: Array<{
          negotiationId: string;
          vacancyId: string;
          companyName: string;
          positionTitle: string;
          previewText: string;
          unreadCount: number;
          isOutgoingApply: boolean;
        }> = [];

        for (const item of items) {
          const badgeCandidates = Array.from(
            item.querySelectorAll(
              '[data-qa="chatik-info-badges"], [data-qa="negotiations-item-unread"], span[class*="magritte-badge___"], [data-qa*="unread"]'
            )
          ).filter((el) => {
            const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
            return !cls.includes('avatar') && !cls.includes('online-badge');
          });

          const badgeEl =
            badgeCandidates.find((el) => {
              const txt = normalize(el.textContent);
              return Boolean(txt && /^\d+$/.test(txt) && parseInt(txt, 10) > 0);
            }) ?? badgeCandidates[0];

          const badgeText = normalize(badgeEl?.textContent);
          const hasNumericBadge = Boolean(
            badgeText && /^\d+$/.test(badgeText) && parseInt(badgeText, 10) > 0
          );
          const rawCls =
            typeof item.className === 'string'
              ? item.className
              : item.getAttribute('class') || '';
          const rawQa = item.getAttribute('data-qa') || '';
          const badgeCls = badgeEl
            ? typeof badgeEl.className === 'string'
              ? badgeEl.className
              : badgeEl.getAttribute('class') || ''
            : '';
          const hasUnreadBadge =
            hasNumericBadge ||
            rawCls.includes('unread') ||
            rawQa.includes('unread') ||
            badgeCls.includes('accent') ||
            Boolean(item.querySelector('[class*="unread"]:not([class*="avatar"])'));

          const messageEl = item.querySelector(
            '[data-qa="chat-cell-last-message"], [data-qa="negotiations-item-message"], [data-qa="negotiations-item-text"]'
          );
          const previewText = normalize(messageEl?.textContent);
          const isOutgoingApply =
            previewText.toLowerCase().startsWith('отклик на вакансию') ||
            previewText.toLowerCase().startsWith('вы откликнулись');

          const isDiscard =
            previewText.toLowerCase() === 'отказ' ||
            previewText.toLowerCase().includes('отказ') ||
            previewText.toLowerCase().includes('не готовы') ||
            rawQa.includes('discard') ||
            rawCls.includes('discard');

          const hasUnread = hasUnreadBadge && !isDiscard;
          if (!hasUnread) {
            continue;
          }

          const href = item.getAttribute('href') ?? '';
          const chatMatch = /\/chat\/(\d+)/.exec(href);
          const negMatch = /\/negotiations\/item\/([^/?#]+)/.exec(href);
          const vacancyLink = item.querySelector('a[href*="/vacancy/"]');
          const vacancyHref = vacancyLink?.getAttribute('href') ?? href;
          const vacancyMatch = /\/vacancy\/(\d+)/.exec(vacancyHref);
          const vacancyId = vacancyMatch?.[1] ?? '';

          const itemQa = item.getAttribute('data-qa') ?? '';
          const qaIdMatch = /chatik-open-chat-(\d+)/.exec(itemQa);

          const negotiationId =
            chatMatch?.[1] ??
            qaIdMatch?.[1] ??
            negMatch?.[1] ??
            item.getAttribute('data-qa-negotiation-id') ??
            item.getAttribute('data-negotiation-id') ??
            item.getAttribute('id') ??
            vacancyId;

          if (!negotiationId) {
            continue;
          }

          const companyEl = item.querySelector(
            '[data-qa="chat-cell-subtitle"], [data-qa="negotiations-item-company"], [data-qa*="employer"]'
          );
          const positionEl = item.querySelector(
            '[data-qa="chat-cell-title"], [data-qa="negotiations-item-vacancy"], a[href*="/vacancy/"]'
          );

          extracted.push({
            negotiationId,
            vacancyId: vacancyId || negotiationId,
            companyName: normalize(companyEl?.textContent) || 'Работодатель',
            positionTitle: normalize(positionEl?.textContent) || 'Вакансия',
            previewText,
            unreadCount: hasNumericBadge ? parseInt(badgeText, 10) : 1,
            isOutgoingApply,
          });

          if (extracted.length >= 10) {
            break;
          }
        }
        return extracted;
      });

      const results: UnreadNegotiationItem[] = [];

      for (const row of rawUnreadRows) {
        let chatUrl = `${this.webBaseUrl}/chat/${encodeURIComponent(row.negotiationId)}`;

        let chatNav = await page
          .goto(chatUrl, { waitUntil: 'domcontentloaded' })
          .catch(() => null);
        if (!chatNav || chatNav.status() >= 400) {
          chatUrl = `${this.webBaseUrl}/applicant/negotiations/item/${encodeURIComponent(row.negotiationId)}`;
          chatNav = await page
            .goto(chatUrl, { waitUntil: 'domcontentloaded' })
            .catch(() => null);
        }

        if (chatNav && chatNav.status() >= 400) {
          await this.loggerService.logPlaywrightError({
            traceId,
            module: 'HH_MESSAGING',
            action: 'FETCH_UNREAD_CHAT_NAVIGATION',
            error: new Error(`HTTP ${chatNav.status()}`),
            page,
            httpStatus: chatNav.status(),
            hint: `Chat navigation returned HTTP >= 400 for negotiation ${row.negotiationId}`,
          });
          continue;
        }

        await page
          .locator(
            '[data-qa*="chatik-chat-message-bubble"], [data-qa="chat-bubble-message"], [data-qa*="chatik-chat-message-"]'
          )
          .first()
          .waitFor({ timeout: 4000 })
          .catch(() => undefined);

        const chatData = await page.evaluate(() => {
          const normalize = (value: string | null | undefined): string =>
            (value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

          const vacLink = document.querySelector('a[href*="/vacancy/"]');
          const vacHref = vacLink?.getAttribute('href') ?? '';
          const vacMatch = /\/vacancy\/(\d+)/.exec(vacHref);
          const detectedVacancyId = vacMatch?.[1] ?? '';

          let bubbleNodes = Array.from(
            document.querySelectorAll('[data-qa*="chatik-chat-message-bubble"]')
          );

          if (bubbleNodes.length === 0) {
            bubbleNodes = Array.from(
              document.querySelectorAll(
                '[data-qa^="chatik-chat-message-"]:not([data-qa$="-text"]), [data-qa="chat-bubble-message"], [data-qa="chatik-message"], [data-qa="chat-message"]'
              )
            );
          }

          const history: Array<{ sender: 'employer' | 'applicant'; text: string; timestamp?: string }> = [];

          for (const node of bubbleNodes) {
            const rawQa = (node.getAttribute('data-qa') ?? '').toLowerCase();
            const rawClass =
              typeof node.className === 'string'
                ? node.className.toLowerCase()
                : node.getAttribute('class')?.toLowerCase() || '';
            const subClasses = Array.from(node.querySelectorAll('*'))
              .map((s) => (typeof s.className === 'string' ? s.className.toLowerCase() : ''))
              .filter((c) => c.length > 0);

            const isApplicant =
              rawClass.includes('outgoing') ||
              rawClass.includes('bubble_outgoing') ||
              rawClass.includes('message_my') ||
              rawQa.includes('outbound') ||
              rawQa.includes('applicant') ||
              rawQa.includes('my-message') ||
              subClasses.some(
                (c) =>
                  c.includes('outgoing') ||
                  c.includes('bubble_outgoing') ||
                  c.includes('message_my')
              );

            const textEl =
              node.querySelector('[data-qa="chat-bubble-text"]') ??
              node.querySelector('[data-qa="chat-bubble-message"]') ??
              node.querySelector('[class*="magritte-message___"]') ??
              node.querySelector('[class*="chat-bubble-text--"]') ??
              node.querySelector('[class*="bubble-content"]') ??
              node;

            const text = normalize(textEl.textContent);
            if (!text) {
              continue;
            }

            if (history.length > 0 && history[history.length - 1]!.text === text) {
              continue;
            }

            const timeEl = node.querySelector(
              '[data-qa*="time"], [data-qa="chat-bubble-display-time"], [class*="display-time"], time, [class*="timestamp"]'
            );
            const timestamp = normalize(timeEl?.textContent) || undefined;

            history.push({
              sender: isApplicant ? 'applicant' : 'employer',
              text,
              timestamp,
            });
          }

          return { detectedVacancyId, history };
        });

        const fullHistory: ChatMessageBubble[] = chatData.history.length > 0 ? chatData.history : [];
        let unreadMessages: string[] = [];

        if (fullHistory.length > 0) {
          const lastBubble = fullHistory[fullHistory.length - 1];
          if (lastBubble?.sender === 'employer') {
            const lowerBubble = lastBubble.text.toLowerCase();
            const isDiscardMsg =
              lowerBubble === 'отказ' ||
              lowerBubble.includes('отказ') ||
              lowerBubble.includes('не готовы пригласить') ||
              lowerBubble.includes('не готовы предложить') ||
              lowerBubble.includes('вынуждены отказать') ||
              lowerBubble.includes('выбрали другого');
            if (!isDiscardMsg && isInformativeEmployerMessage(lastBubble.text)) {
              unreadMessages = [lastBubble.text];
            }
          }
        }

        if (unreadMessages.length === 0) {
          continue;
        }

        results.push({
          negotiationId: row.negotiationId,
          vacancyId: chatData.detectedVacancyId || row.vacancyId,
          companyName: row.companyName,
          positionTitle: row.positionTitle,
          chatUrl,
          unreadMessages,
          fullHistory,
        });
      }

      this.loggerService.logInfo({
        traceId,
        module: 'HH_MESSAGING',
        action: 'FETCH_UNREAD_NEGOTIATIONS',
        message: `Successfully fetched ${results.length} unread negotiations`,
        metadata: { count: results.length },
      });

      return { data: results, error: null };
    } catch (err) {
      if (isBrowserClosedError(err)) {
        return { data: null, error: 'ABORTED_BROWSER_CLOSED' };
      }
      await this.loggerService.logPlaywrightError({
        traceId,
        module: 'HH_MESSAGING',
        action: 'FETCH_UNREAD_NEGOTIATIONS',
        error: err,
        page: currentPage ?? undefined,
        hint: 'Playwright selector wait or negotiations evaluation failed',
      });
      return {
        data: null,
        error: err instanceof Error ? err.message : 'Playwright unread negotiations retrieval failed',
      };
    } finally {
      if (context) {
        await context.close();
      }
    }
  }

  public async sendChatInBrowser(
    sessionDir: string,
    negotiationId: string,
    replyText: string,
    traceId: string
  ): Promise<SafeResult<boolean>> {
    let context: BrowserContext | null = null;
    let currentPage: Page | null = null;
    try {
      context = await chromium.launchPersistentContext(sessionDir, {
        headless: true,
        viewport: { width: 1280, height: 840 },
      });
      if (typeof context.route === 'function') {
        await context.route('**/*', async (route) => {
          if (isTrackerUrl(route.request().url())) {
            await route.abort().catch(() => undefined);
            return;
          }
          await route.continue().catch(() => undefined);
        });
      }

      const page = context.pages()[0] ?? (await context.newPage());
      currentPage = page;

      let chatUrl = `${this.webBaseUrl}/chat/${encodeURIComponent(negotiationId)}`;
      let navResp = await page
        .goto(chatUrl, { waitUntil: 'domcontentloaded' })
        .catch(() => null);

      if (!navResp || navResp.status() >= 400) {
        chatUrl = `${this.webBaseUrl}/applicant/negotiations/item/${encodeURIComponent(negotiationId)}`;
        navResp = await page
          .goto(chatUrl, { waitUntil: 'domcontentloaded' })
          .catch(() => null);
      }

      if (navResp && navResp.status() >= 400) {
        await this.loggerService.logPlaywrightError({
          traceId,
          module: 'HH_MESSAGING',
          action: 'SEND_CHAT_MESSAGE',
          error: new Error(`HTTP ${navResp.status()}`),
          page,
          httpStatus: navResp.status(),
          hint: 'HH.ru chat page returned HTTP >= 400 inside Playwright persistent session',
        });
        return { data: null, error: `HTTP ${navResp.status()}: chat navigation failed` };
      }

      const textareaLocator = page
        .locator(
          'textarea[data-qa="text-input"], [data-qa="chatik-new-message-text"], textarea[name="message"], textarea[placeholder*="Сообщение"], textarea'
        )
        .first();

      const textareaVisible = await textareaLocator
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false);

      if (!textareaVisible) {
        await this.loggerService.logPlaywrightError({
          traceId,
          module: 'HH_MESSAGING',
          action: 'SEND_CHAT_MESSAGE',
          error: new Error('Chat textarea not found'),
          page,
          failedSelector: '[data-qa="chatik-new-message-text"]',
          hint: 'Employer may have disabled chat replies or HH chat DOM selector changed',
        });
        return { data: null, error: 'Поле ввода сообщения в чате HH.ru не найдено' };
      }

      await textareaLocator.focus().catch(() => undefined);
      await textareaLocator.fill(replyText);
      await page.waitForTimeout(400);

      const sendButton = page
        .locator(
          'button[data-qa="chatik-do-send-message"], [data-qa="chatik-do-send"], button[aria-label*="отправить сообщение" i], button[type="submit"]'
        )
        .first();

      const isSendBtnVisible = await sendButton.isVisible().catch(() => false);
      if (isSendBtnVisible) {
        await sendButton.click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(500);
      }

      let inputVal = await textareaLocator.inputValue().catch(() => '');
      if (inputVal.length > 0) {
        await textareaLocator.focus().catch(() => undefined);
        await textareaLocator.press('Enter').catch(() => undefined);
        await page.waitForTimeout(1000);
      }

      inputVal = await textareaLocator.inputValue().catch(() => '');
      if (inputVal.length > 0) {
        await sendButton.dispatchEvent('click').catch(() => undefined);
        await page.waitForTimeout(1000);
      }

      inputVal = await textareaLocator.inputValue().catch(() => '');
      if (inputVal.length > 0) {
        await this.loggerService.logPlaywrightError({
          traceId,
          module: 'HH_MESSAGING',
          action: 'SEND_CHAT_MESSAGE',
          error: new Error('Textarea not cleared after send attempt'),
          page,
          hint: 'Playwright filled textarea and triggered send/Enter, but HH chat did not submit message',
        });
        return {
          data: null,
          error: 'Не удалось отправить сообщение: поле ввода HH.ru не очистилось после отправки',
        };
      }

      await page.waitForTimeout(1000);

      this.loggerService.logInfo({
        traceId,
        module: 'HH_MESSAGING',
        action: 'SEND_CHAT_MESSAGE',
        message: `Chat message sent to negotiation ${negotiationId}`,
        metadata: { negotiationId, length: replyText.length },
      });

      return { data: true, error: null };
    } catch (err) {
      if (isBrowserClosedError(err)) {
        return { data: null, error: 'ABORTED_BROWSER_CLOSED' };
      }
      await this.loggerService.logPlaywrightError({
        traceId,
        module: 'HH_MESSAGING',
        action: 'SEND_CHAT_MESSAGE',
        error: err,
        page: currentPage ?? undefined,
        hint: 'Playwright send chat message failed',
      });
      return {
        data: null,
        error: err instanceof Error ? err.message : 'Playwright send chat message failed',
      };
    } finally {
      if (context) {
        await context.close();
      }
    }
  }
}

export class HhMessagingService implements IHhMessagingService {
  private readonly hhHybrid: IHhHybridService;
  private readonly browserDriver: HhMessagingBrowserDriver;
  private readonly loggerService: IAgentLoggerService;

  constructor(hhHybrid: IHhHybridService, options?: HhMessagingOptions) {
    this.hhHybrid = hhHybrid;
    const webBaseUrl = (options?.webBaseUrl ?? 'https://hh.ru').replace(/\/+$/, '');
    this.loggerService = options?.loggerService ?? agentLogger;
    this.browserDriver =
      options?.customDriver ??
      new DefaultHhMessagingBrowserDriver(webBaseUrl, this.loggerService);
  }

  public async fetchUnreadNegotiations(traceId?: string): Promise<SafeResult<UnreadNegotiationItem[]>> {
    const effectiveTraceId = traceId ?? this.loggerService.createTraceId();
    if (!this.hhHybrid.runWithSession) {
      return { data: null, error: 'HhHybridService session runner is not available.' };
    }
    const result = await this.hhHybrid.runWithSession(async (sessionDir) => {
      return this.browserDriver.fetchUnreadInBrowser(sessionDir, effectiveTraceId);
    });
    if (result.data) {
      this.loggerService.logInfo({
        traceId: effectiveTraceId,
        module: 'HH_MESSAGING',
        action: 'FETCH_UNREAD_NEGOTIATIONS',
        message: `Fetched ${result.data.length} unread negotiations`,
        metadata: { count: result.data.length },
      });
    }
    return result;
  }

  public async sendChatMessage(
    negotiationId: string,
    replyText: string,
    traceId?: string
  ): Promise<SafeResult<boolean>> {
    const trimmedId = negotiationId.trim();
    const trimmedText = replyText.trim();
    if (!trimmedId || !trimmedText) {
      return { data: null, error: 'negotiationId and replyText cannot be empty' };
    }
    const effectiveTraceId = traceId ?? this.loggerService.createTraceId();
    if (!this.hhHybrid.runWithSession) {
      return { data: null, error: 'HhHybridService session runner is not available.' };
    }
    const result = await this.hhHybrid.runWithSession(async (sessionDir) => {
      return this.browserDriver.sendChatInBrowser(
        sessionDir,
        trimmedId,
        trimmedText,
        effectiveTraceId
      );
    });
    if (result.data) {
      this.loggerService.logInfo({
        traceId: effectiveTraceId,
        module: 'HH_MESSAGING',
        action: 'SEND_CHAT_MESSAGE',
        message: `Chat message sent to negotiation ${trimmedId}`,
        metadata: { negotiationId: trimmedId, length: trimmedText.length },
      });
    }
    return result;
  }
}

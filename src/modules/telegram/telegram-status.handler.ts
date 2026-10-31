import { desc, inArray } from 'drizzle-orm';
import { InlineKeyboard, type Bot, type Context } from 'grammy';
import type { AppDatabase } from '../../db/index.ts';
import {
  applicationRecords,
  taskQueue,
  type ApplicationRecord,
  type TaskQueueRecord,
} from '../../db/schema.ts';
import type { IConfigStore } from '../config-store/index.ts';
import type { IHhBrowserCaptchaService } from '../hh-hybrid/index.ts';
import { countTodayAppliedRecords } from '../scheduler/scheduler-notifications.helper.ts';
import { escapeHtml } from './telegram-blacklist.ts';
import type { BotContext } from './telegram-wizards.ts';

export const STATUS_PAGE_SIZE = 5;

export type BotOperationalState = 'active' | 'paused' | 'paused_captcha';

export interface CompactStatusTotals {
  readonly totalApplied: number;
  readonly invitations: number;
  readonly discards: number;
  readonly awaitingResponse: number;
}

export interface CompactStatusReportData {
  readonly botState: BotOperationalState;
  readonly todayApplied: number;
  readonly dailyLimit: number;
  readonly pendingQueueCount: number;
  readonly totals: CompactStatusTotals;
  readonly items: ReadonlyArray<ApplicationRecord>;
  readonly page: number;
  readonly totalPages: number;
  readonly pageSize: number;
}

export interface StatusHandlerDeps {
  readonly db: AppDatabase;
  readonly configStore: IConfigStore;
  readonly captchaService?: IHhBrowserCaptchaService;
  readonly safeEditMessageText: (
    ctx: Context,
    text: string,
    other?: Parameters<Context['editMessageText']>[1]
  ) => Promise<void>;
}

export function formatStatusIcon(status: string): string {
  if (status === 'invitation') {
    return '🟢';
  }
  if (status === 'discard') {
    return '🔴';
  }
  if (status === 'viewed') {
    return '👀';
  }
  return '⏳';
}

export function queryCompactStatusReport(
  db: AppDatabase,
  configStore: IConfigStore,
  page = 0,
  pageSize = STATUS_PAGE_SIZE,
  isCaptchaPaused?: boolean
): CompactStatusReportData {
  let queueRows: TaskQueueRecord[] = [];
  try {
    queueRows = db
      .select()
      .from(taskQueue)
      .where(inArray(taskQueue.status, ['pending', 'processing', 'paused_captcha']))
      .limit(1000)
      .all();
  } catch {
    queueRows = [];
  }

  const pendingQueueCount = queueRows.length;
  const hasPausedCaptchaInDb = queueRows.some((r) => r.status === 'paused_captcha');

  let botState: BotOperationalState;
  if (isCaptchaPaused || hasPausedCaptchaInDb) {
    botState = 'paused_captcha';
  } else if (configStore.get('AUTO_APPLY_ENABLED').data === 'true') {
    botState = 'active';
  } else {
    botState = 'paused';
  }

  const allRows = db
    .select()
    .from(applicationRecords)
    .orderBy(desc(applicationRecords.appliedAt), desc(applicationRecords.id))
    .limit(1000)
    .all();

  const appliedRows = allRows.filter(
    (r) => !['pending_approval', 'skipped_user', 'skipped_low_score'].includes(r.status)
  );

  const todayApplied = countTodayAppliedRecords(db);
  const dailyLimit = configStore.getDailyLimit().data ?? 50;

  const totalApplied = appliedRows.length;
  const invitations = appliedRows.filter((r) => r.status === 'invitation').length;
  const discards = appliedRows.filter((r) => r.status === 'discard').length;
  const awaitingResponse = appliedRows.filter(
    (r) => r.status === 'response' || r.status === 'viewed'
  ).length;

  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(appliedRows.length / safePageSize));
  const clampedPage = Math.max(0, Math.min(totalPages - 1, page));
  const startIdx = clampedPage * safePageSize;
  const items = appliedRows.slice(startIdx, startIdx + safePageSize);

  return {
    botState,
    todayApplied,
    dailyLimit,
    pendingQueueCount,
    totals: {
      totalApplied,
      invitations,
      discards,
      awaitingResponse,
    },
    items,
    page: clampedPage,
    totalPages,
    pageSize: safePageSize,
  };
}

export function buildCompactStatusText(data: CompactStatusReportData): string {
  let stateLabel = '⏸ На паузе';
  if (data.botState === 'paused_captcha') {
    stateLabel = '⚠️ Ожидает капчу';
  } else if (data.botState === 'active') {
    stateLabel = '🟢 Активен';
  }

  const lines: string[] = [
    '📊 <b>Краткий отчет по откликам (Статус)</b>',
    '',
    `<b>Состояние бота:</b> ${stateLabel}`,
    `<b>Откликов за сегодня:</b> ${data.todayApplied} / ${data.dailyLimit}`,
    `<b>Задач в очереди SQLite:</b> ${data.pendingQueueCount}`,
    '',
    '📈 <b>Сводная статистика:</b>',
    `• Всего откликов: <b>${data.totals.totalApplied}</b>`,
    `• Приглашения (🟢): <b>${data.totals.invitations}</b>`,
    `• Отказы (🔴): <b>${data.totals.discards}</b>`,
    `• Ожидают ответа (⏳): <b>${data.totals.awaitingResponse}</b>`,
    '',
    `📋 <b>Последние отклики (стр. ${data.page + 1} из ${data.totalPages}):</b>`,
  ];

  if (data.items.length === 0) {
    lines.push('<i>Откликов пока нет.</i>');
  } else {
    for (let idx = 0; idx < data.items.length; idx++) {
      const item = data.items[idx]!;
      const num = data.page * data.pageSize + idx + 1;
      const icon = formatStatusIcon(item.status);
      const dateStr = item.appliedAt.slice(0, 10);
      const salary = item.salaryText || 'Не указана';
      lines.push(
        `${num}. ${icon} <b>${escapeHtml(item.companyName)}</b> — ${escapeHtml(item.positionTitle)} (${escapeHtml(salary)}) | ${escapeHtml(dateStr)} | <a href="${escapeHtml(item.vacancyUrl)}">Ссылка</a>`
      );
    }
  }

  return lines.join('\n');
}

export function buildCompactStatusKeyboard(page: number, totalPages: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (totalPages > 1) {
    if (page > 0) {
      kb.text('⬅️ Назад', `status:page:${page - 1}`);
    }
    kb.text(`Стр. ${page + 1}/${totalPages}`, 'status:noop');
    if (page + 1 < totalPages) {
      kb.text('Вперед ➡️', `status:page:${page + 1}`);
    }
    kb.row();
  }
  kb.text('📥 Скачать полный Excel', 'menu:export_excel').row();
  kb.text('🔄 Обновить статус', `status:page:${page}`).row();
  kb.text('🔙 Главное меню', 'menu:back_to_main');
  return kb;
}

export function registerStatusHandlers(
  bot: Bot<BotContext>,
  deps: StatusHandlerDeps
): void {
  const renderStatus = (page = 0) => {
    const isCaptchaPaused = deps.captchaService?.isAwaitingCaptcha() ?? false;
    const data = queryCompactStatusReport(
      deps.db,
      deps.configStore,
      page,
      STATUS_PAGE_SIZE,
      isCaptchaPaused
    );
    return {
      text: buildCompactStatusText(data),
      keyboard: buildCompactStatusKeyboard(data.page, data.totalPages),
    };
  };

  bot.command('status', async (ctx) => {
    const { text, keyboard } = renderStatus(0);
    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.callbackQuery('menu:status', async (ctx) => {
    await ctx.answerCallbackQuery();
    const { text, keyboard } = renderStatus(0);
    await deps.safeEditMessageText(ctx, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.callbackQuery('status:noop', async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^status:page:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const page = Number.parseInt((ctx.match as RegExpMatchArray)[1] ?? '0', 10);
    const { text, keyboard } = renderStatus(Number.isNaN(page) ? 0 : page);
    await deps.safeEditMessageText(ctx, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  });
}

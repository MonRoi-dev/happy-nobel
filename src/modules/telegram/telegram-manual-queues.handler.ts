import { and, desc, eq, inArray } from 'drizzle-orm';
import { InlineKeyboard, type Bot, type Context } from 'grammy';
import type { AppDatabase } from '../../db/index.ts';
import { applicationRecords, type ApplicationRecord } from '../../db/schema.ts';
import type { IConfigStore, SafeResult } from '../config-store/index.ts';
import { escapeHtml } from './telegram-blacklist.ts';
import type { BotContext } from './telegram-wizards.ts';

export type ManualQueueKind = 'hr' | 'form';

export const MANUAL_QUEUE_PAGE_SIZE = 6;

export interface ManualQueueHandlerDeps {
  readonly db: AppDatabase;
  readonly configStore: IConfigStore;
  readonly safeEditMessageText: (
    ctx: Context,
    text: string,
    other?: Parameters<Context['editMessageText']>[1]
  ) => Promise<void>;
}

export interface ManualQueuePageData {
  readonly kind: ManualQueueKind;
  readonly items: ReadonlyArray<ApplicationRecord>;
  readonly totalCount: number;
  readonly page: number;
  readonly totalPages: number;
}

function resolveTargetStatus(kind: ManualQueueKind): 'tg_contact_notified' | 'pending_external_captcha' {
  return kind === 'hr' ? 'tg_contact_notified' : 'pending_external_captcha';
}

export function countManualQueueRecords(db: AppDatabase, kind: ManualQueueKind): number {
  const status = resolveTargetStatus(kind);
  const rows = db
    .select({ id: applicationRecords.id })
    .from(applicationRecords)
    .where(eq(applicationRecords.status, status))
    .limit(1000)
    .all();
  return rows.length;
}

export function queryManualQueuePage(
  db: AppDatabase,
  kind: ManualQueueKind,
  page = 0,
  pageSize = MANUAL_QUEUE_PAGE_SIZE
): ManualQueuePageData {
  const status = resolveTargetStatus(kind);
  const allRows = db
    .select()
    .from(applicationRecords)
    .where(eq(applicationRecords.status, status))
    .orderBy(desc(applicationRecords.appliedAt), desc(applicationRecords.id))
    .limit(1000)
    .all();

  const totalCount = allRows.length;
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(totalCount / safePageSize));
  const clampedPage = Math.max(0, Math.min(totalPages - 1, page));
  const startIdx = clampedPage * safePageSize;
  const items = allRows.slice(startIdx, startIdx + safePageSize);

  return {
    kind,
    items,
    totalCount,
    page: clampedPage,
    totalPages,
  };
}

export function buildManualQueueListView(
  db: AppDatabase,
  kind: ManualQueueKind,
  page = 0,
  bannerHtml?: string
): { text: string; keyboard: InlineKeyboard } {
  const data = queryManualQueuePage(db, kind, page);
  const header =
    kind === 'hr'
      ? `👤 <b>Очередь: Контакты HR / Почта (${data.totalCount})</b>`
      : `🌐 <b>Очередь: Формы сайтов для ручного отклика (${data.totalCount})</b>`;

  const subtitle =
    kind === 'hr'
      ? 'Здесь накапливаются вакансии с прямыми контактами рекрутеров в Telegram или Email. Нажмите на вакансию, чтобы посмотреть текст письма, написать HR и подтвердить или отклонить отклик.'
      : 'Здесь накапливаются вакансии с формами на внешних сайтах (капча или ручная анкета). Нажмите на вакансию, чтобы открыть сайт, скопировать письмо и подтвердить или отклонить отклик.';

  const lines: string[] = [];
  if (bannerHtml) {
    lines.push(bannerHtml, '');
  }
  lines.push(header, '', `<i>${subtitle}</i>`, '');

  const kb = new InlineKeyboard();

  if (data.items.length === 0) {
    lines.push('✨ <b>Список пуст!</b> Новые подходящие вакансии будут автоматически накапливаться здесь.');
  } else {
    lines.push(`📋 <b>Список вакансий (стр. ${data.page + 1} из ${data.totalPages}):</b>`);
    for (let idx = 0; idx < data.items.length; idx++) {
      const item = data.items[idx]!;
      const num = data.page * MANUAL_QUEUE_PAGE_SIZE + idx + 1;
      const score = item.matchScore ?? 0;
      const salary = item.salaryText || 'З/П не указана';
      lines.push(
        `${num}. <b>${escapeHtml(item.positionTitle)}</b> — ${escapeHtml(item.companyName)} (${escapeHtml(salary)}) | 🎯 ${score}%`
      );
      const btnLabel = `${num}. ${item.positionTitle.slice(0, 26)} • ${item.companyName.slice(0, 18)} (${score}%)`;
      kb.text(btnLabel, `mqueue:view:${kind}:${item.id}:${data.page}`).row();
    }
  }

  if (data.totalPages > 1) {
    if (data.page > 0) {
      kb.text('⬅️ Назад', `mqueue:list:${kind}:${data.page - 1}`);
    }
    kb.text(`Стр. ${data.page + 1}/${data.totalPages}`, 'status:noop');
    if (data.page + 1 < data.totalPages) {
      kb.text('Вперед ➡️', `mqueue:list:${kind}:${data.page + 1}`);
    }
    kb.row();
  }

  kb.text('🔄 Обновить список', `mqueue:list:${kind}:${data.page}`).row();
  kb.text('🔙 Главное меню', 'menu:back_to_main');

  return {
    text: lines.join('\n'),
    keyboard: kb,
  };
}

function parseMetaAndPostUrl(lastEmployerMessage: string | null): {
  metaText: string | null;
  postUrl: string | null;
} {
  if (!lastEmployerMessage) {
    return { metaText: null, postUrl: null };
  }
  const parts = lastEmployerMessage.split('| Пост:');
  const metaText = parts[0]?.trim() || null;
  const postUrl = parts[1]?.trim() || null;
  return { metaText, postUrl };
}

export function buildManualQueueDetailView(
  record: ApplicationRecord,
  kind: ManualQueueKind,
  page = 0
): { text: string; keyboard: InlineKeyboard } {
  const salary = record.salaryText || 'Не указана';
  const score = record.matchScore ?? 0;
  const { metaText, postUrl } = parseMetaAndPostUrl(record.lastEmployerMessage);

  const title =
    kind === 'hr'
      ? '👤 <b>Вакансия с прямым контактом HR / Почтой</b>'
      : '🌐 <b>Вакансия с внешней формой на сайте</b>';

  const lines: string[] = [
    title,
    '',
    `💼 <b>Должность:</b> ${escapeHtml(record.positionTitle)}`,
    `🏢 <b>Компания:</b> ${escapeHtml(record.companyName)}`,
    `💰 <b>Зарплата:</b> ${escapeHtml(salary)}`,
    `🎯 <b>Совпадение ИИ:</b> ${score}/100`,
  ];

  if (record.aiReasoning) {
    lines.push(`💡 <b>Оценка ИИ:</b> <i>${escapeHtml(record.aiReasoning)}</i>`);
  }

  if (kind === 'hr') {
    if (metaText?.startsWith('Email:')) {
      const emailVal = metaText.replace(/^Email:\s*/i, '').trim();
      lines.push(`📧 <b>Почта HR (нажмите для копирования):</b> <code>${escapeHtml(emailVal)}</code>`);
    } else if (metaText?.startsWith('TG:')) {
      const tgVal = metaText.replace(/^TG:\s*/i, '').trim();
      lines.push(
        `👤 <b>Контакт HR:</b> ${escapeHtml(tgVal)} (<a href="${escapeHtml(record.vacancyUrl)}">Открыть чат</a>)`
      );
    } else {
      lines.push(`🔗 <b>Контакт / Ссылка:</b> <a href="${escapeHtml(record.vacancyUrl)}">${escapeHtml(record.vacancyUrl)}</a>`);
    }
  } else {
    if (metaText) {
      lines.push(`📌 <b>Примечание:</b> ${escapeHtml(metaText)}`);
    }
    lines.push(`🌐 <b>Форма отклика:</b> <a href="${escapeHtml(record.vacancyUrl)}">Открыть страницу вакансии</a>`);
  }

  if (postUrl) {
    lines.push(`📢 <b>Пост в Telegram:</b> <a href="${escapeHtml(postUrl)}">Открыть пост</a>`);
  }

  if (record.coverLetter && record.coverLetter.trim().length > 0) {
    lines.push(
      '',
      '✉️ <b>Готовое сопроводительное письмо (нажмите на текст для копирования):</b>',
      `<code>${escapeHtml(record.coverLetter)}</code>`
    );
  }

  const kb = new InlineKeyboard();
  if (/^https?:\/\//i.test(record.vacancyUrl)) {
    kb.url(
      kind === 'hr' ? '💬 Открыть чат / контакт' : '🌐 Открыть сайт с формой',
      record.vacancyUrl
    ).row();
  }
  if (postUrl && /^https?:\/\//i.test(postUrl) && postUrl !== record.vacancyUrl) {
    kb.url('📢 Пост в канале', postUrl).row();
  }

  kb.text('✅ Я откликнулся (В отчет)', `mqueue:confirm:${kind}:${record.id}:${page}`).row();
  kb.text('❌ Отклонить', `mqueue:skip:${kind}:${record.id}:${page}`)
    .text('🚫 Компанию в ЧС', `mqueue:bl:${kind}:${record.id}:${page}`)
    .row();
  kb.text('🔙 К списку', `mqueue:list:${kind}:${page}`)
    .text('🏠 Главное меню', 'menu:back_to_main');

  return {
    text: lines.join('\n'),
    keyboard: kb,
  };
}

export function handleManualQueueAction(
  action: 'confirm' | 'skip' | 'bl',
  kind: ManualQueueKind,
  recordId: number,
  page: number,
  deps: Pick<ManualQueueHandlerDeps, 'db' | 'configStore'>
): SafeResult<{ text: string; keyboard: InlineKeyboard }> {
  const record = deps.db
    .select()
    .from(applicationRecords)
    .where(eq(applicationRecords.id, recordId))
    .limit(1)
    .get();

  if (!record) {
    return { data: null, error: 'Вакансия не найдена в базе данных' };
  }

  const nowIso = new Date().toISOString();

  if (action === 'confirm') {
    const nextStatus = kind === 'hr' ? 'response' : 'applied_external';
    deps.db
      .update(applicationRecords)
      .set({
        status: nextStatus,
        appliedAt: nowIso,
        updatedAt: nowIso,
        isNotified: true,
      })
      .where(eq(applicationRecords.id, recordId))
      .run();

    const banner = `✅ <b>Отклик подтвержден и учтен в статистике и Excel:</b> «${escapeHtml(record.positionTitle)}» (${escapeHtml(record.companyName)})`;
    return {
      data: buildManualQueueListView(deps.db, kind, page, banner),
      error: null,
    };
  }

  if (action === 'skip') {
    deps.db
      .update(applicationRecords)
      .set({
        status: 'skipped_user',
        updatedAt: nowIso,
        isNotified: true,
      })
      .where(eq(applicationRecords.id, recordId))
      .run();

    const banner = `❌ <b>Вакансия отклонена (сохранена в историю и Excel):</b> «${escapeHtml(record.positionTitle)}» (${escapeHtml(record.companyName)})`;
    return {
      data: buildManualQueueListView(deps.db, kind, page, banner),
      error: null,
    };
  }

  deps.configStore.addBlacklistedCompany(record.companyName);
  deps.db
    .update(applicationRecords)
    .set({
      status: 'skipped_user',
      updatedAt: nowIso,
      isNotified: true,
    })
    .where(
      and(
        eq(applicationRecords.companyName, record.companyName),
        inArray(applicationRecords.status, [
          'pending_approval',
          'tg_contact_notified',
          'pending_external_captcha',
        ])
      )
    )
    .run();

  const banner = `🚫 <b>Компания «${escapeHtml(record.companyName)}» добавлена в черный список.</b> Вакансия отклонена.`;
  return {
    data: buildManualQueueListView(deps.db, kind, page, banner),
    error: null,
  };
}

export function registerManualQueueHandlers(
  bot: Bot<BotContext>,
  deps: ManualQueueHandlerDeps
): void {
  bot.command('hr_contacts', async (ctx) => {
    const view = buildManualQueueListView(deps.db, 'hr', 0);
    await ctx.reply(view.text, {
      parse_mode: 'HTML',
      reply_markup: view.keyboard,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command('ext_forms', async (ctx) => {
    const view = buildManualQueueListView(deps.db, 'form', 0);
    await ctx.reply(view.text, {
      parse_mode: 'HTML',
      reply_markup: view.keyboard,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.callbackQuery(/^mqueue:list:(hr|form):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const match = ctx.match as RegExpMatchArray;
    const kind = (match[1] === 'form' ? 'form' : 'hr') as ManualQueueKind;
    const page = Number.parseInt(match[2] ?? '0', 10);
    const view = buildManualQueueListView(deps.db, kind, Number.isNaN(page) ? 0 : page);
    await deps.safeEditMessageText(ctx, view.text, {
      parse_mode: 'HTML',
      reply_markup: view.keyboard,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.callbackQuery(/^mqueue:view:(hr|form):(\d+):(\d+)$/, async (ctx) => {
    const match = ctx.match as RegExpMatchArray;
    const kind = (match[1] === 'form' ? 'form' : 'hr') as ManualQueueKind;
    const recordId = Number.parseInt(match[2] ?? '-1', 10);
    const page = Number.parseInt(match[3] ?? '0', 10);

    const record = deps.db
      .select()
      .from(applicationRecords)
      .where(eq(applicationRecords.id, recordId))
      .limit(1)
      .get();

    if (!record) {
      await ctx.answerCallbackQuery({ text: '❌ Вакансия не найдена', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();
    const detail = buildManualQueueDetailView(record, kind, Number.isNaN(page) ? 0 : page);
    await deps.safeEditMessageText(ctx, detail.text, {
      parse_mode: 'HTML',
      reply_markup: detail.keyboard,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.callbackQuery(/^mqueue:(confirm|skip|bl):(hr|form):(\d+):(\d+)$/, async (ctx) => {
    const match = ctx.match as RegExpMatchArray;
    const action = match[1] as 'confirm' | 'skip' | 'bl';
    const kind = (match[2] === 'form' ? 'form' : 'hr') as ManualQueueKind;
    const recordId = Number.parseInt(match[3] ?? '-1', 10);
    const page = Number.parseInt(match[4] ?? '0', 10);

    const res = handleManualQueueAction(action, kind, recordId, Number.isNaN(page) ? 0 : page, deps);
    if (res.error || !res.data) {
      await ctx.answerCallbackQuery({
        text: `❌ ${res.error ?? 'Ошибка обработки'}`,
        show_alert: true,
      });
      return;
    }

    const toastText =
      action === 'confirm'
        ? '✅ Отклик подтвержден и добавлен в отчет'
        : action === 'skip'
          ? '❌ Вакансия отклонена'
          : '🚫 Компания добавлена в ЧС';
    await ctx.answerCallbackQuery(toastText);
    await deps.safeEditMessageText(ctx, res.data.text, {
      parse_mode: 'HTML',
      reply_markup: res.data.keyboard,
      link_preview_options: { is_disabled: true },
    });
  });
}

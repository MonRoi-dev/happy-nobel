import { and, eq } from 'drizzle-orm';
import { InlineKeyboard, type Context, type Bot } from 'grammy';
import type { AppDatabase } from '../../db/index.ts';
import {
  applicationRecords,
  userProfiles,
  type ApplicationRecord,
} from '../../db/schema.ts';
import type { IConfigStore, SafeResult } from '../config-store/index.ts';
import type { IHhHybridService } from '../hh-hybrid/index.ts';
import type { ILlmService } from '../llm/index.ts';
import { escapeHtml } from './telegram-blacklist.ts';
import type { BotContext } from './telegram-wizards.ts';

export interface ApprovalHandlerDeps {
  readonly countTodayApplications: () => number;
  readonly configStore: IConfigStore;
  readonly db: AppDatabase;
  readonly hhHybrid: IHhHybridService;
  readonly llm: ILlmService;
}

export function buildApprovalCardText(record: ApplicationRecord): string {
  const salary = record.salaryText || 'Не указана';
  const score = record.matchScore ?? 0;
  const reasoning = record.aiReasoning ? `\n<i>${escapeHtml(record.aiReasoning)}</i>` : '';

  return [
    `💼 <b><a href="${record.vacancyUrl}">${escapeHtml(record.positionTitle)}</a></b>`,
    `🏢 <b>Компания:</b> ${escapeHtml(record.companyName)}`,
    `💰 <b>Зарплата:</b> ${escapeHtml(salary)}`,
    '',
    `🎯 <b>Совпадение:</b> ${score}/100${reasoning}`,
    '',
    '📝 <b>Сопроводительное письмо:</b>',
    escapeHtml(record.coverLetter),
  ].join('\n');
}

export function buildApprovalCardKeyboard(recordId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Отправить отклик', `appr:send:${recordId}`)
    .row()
    .text('🔄 Перегенерировать письмо', `appr:regen:${recordId}`)
    .row()
    .text('❌ Пропустить', `appr:skip:${recordId}`)
    .text('🚫 Компанию в ЧС', `appr:bl:${recordId}`);
}

export const inFlightApprovalIds = new Set<number>();

export async function handleApprovalAction(
  action: 'send' | 'regen' | 'skip' | 'bl',
  recordId: number,
  deps: ApprovalHandlerDeps
): Promise<SafeResult<{ updatedText: string; updatedKeyboard?: InlineKeyboard }>> {
  if (inFlightApprovalIds.has(recordId)) {
    return {
      data: null,
      error: 'Запрос по этой вакансии уже выполняется. Подождите завершения.',
    };
  }

  inFlightApprovalIds.add(recordId);
  try {
    const record = deps.db
      .select()
      .from(applicationRecords)
      .where(eq(applicationRecords.id, recordId))
      .limit(1)
      .get();

    if (!record) {
      return { data: null, error: 'Запись не найдена' };
    }

    const nowIso = new Date().toISOString();

    if (action === 'send') {
      if (record.status === 'response') {
        return {
          data: {
            updatedText: `${buildApprovalCardText(record)}\n\n✅ <b>Отклик уже отправлен ранее!</b>`,
          },
          error: null,
        };
      }

      const todayCount = deps.countTodayApplications();
      const limit = deps.configStore.getDailyLimit().data ?? 50;

      if (todayCount >= limit) {
        return {
          data: null,
          error: `Дневной лимит откликов (${limit}) исчерпан. Отправка отложена.`,
        };
      }

    const profile = deps.db.select().from(userProfiles).limit(1).get();
    const applyRes = await deps.hhHybrid.applyToVacancy({
      vacancyId: record.vacancyId,
      vacancyUrl: record.vacancyUrl,
      resumeTitle: profile?.hhResumeTitle ?? null,
      coverLetter: record.coverLetter,
    });

    if (applyRes.error === 'QUESTIONS_REQUIRED') {
      deps.db
        .update(applicationRecords)
        .set({
          status: 'pending_approval',
          lastEmployerMessage: 'Требуется ручное прохождение теста',
          isNotified: true,
          updatedAt: nowIso,
        })
        .where(eq(applicationRecords.id, recordId))
        .run();

      const letterBlock = record.coverLetter
        ? `\n\n📝 <b>Сопроводительное письмо:</b>\n<pre>${escapeHtml(record.coverLetter)}</pre>`
        : '';

      return {
        data: {
          updatedText: `⚠️ <b>Требуется ручное прохождение теста:</b>\n<a href="${record.vacancyUrl}">${escapeHtml(record.positionTitle)}</a> (${escapeHtml(record.companyName)})${letterBlock}`,
        },
        error: null,
      };
    }

    if (applyRes.error && applyRes.error !== 'ALREADY_APPLIED') {
      return {
        data: null,
        error: `Ошибка отправки отклика: ${applyRes.error}`,
      };
    }

    deps.db
      .update(applicationRecords)
      .set({
        status: 'response',
        appliedAt: nowIso,
        updatedAt: nowIso,
        isNotified: true,
      })
      .where(eq(applicationRecords.id, recordId))
      .run();

    return {
      data: {
        updatedText: `${buildApprovalCardText(record)}\n\n✅ <b>Отклик успешно отправлен!</b>`,
      },
      error: null,
    };
  }

  if (action === 'regen') {
    const profile = deps.db.select().from(userProfiles).limit(1).get();
    const detailsRes = await deps.hhHybrid.getVacancyDetails(record.vacancyId);

    const cleanDesc = detailsRes.data?.cleanDescription;
    const vacancyDescription =
      cleanDesc && cleanDesc.length >= 10
        ? cleanDesc
        : `${record.positionTitle}. ${record.aiReasoning ?? ''}`.trim();

    const letterRes = await deps.llm.generateCoverLetter({
      resumeRawText: profile?.resumeRawText ?? 'Experienced specialist',
      vacancyTitle: record.positionTitle,
      companyName: record.companyName,
      vacancyDescription,
      customPromptRules: profile?.customPromptRules ?? undefined,
      temperature: 0.65,
    });

    if (letterRes.error || !letterRes.data) {
      return {
        data: null,
        error: letterRes.error ?? 'Не удалось перегенерировать письмо',
      };
    }

    deps.db
      .update(applicationRecords)
      .set({
        coverLetter: letterRes.data,
        updatedAt: nowIso,
      })
      .where(eq(applicationRecords.id, recordId))
      .run();

    const updatedRecord = deps.db
      .select()
      .from(applicationRecords)
      .where(eq(applicationRecords.id, recordId))
      .limit(1)
      .get();

    return {
      data: {
        updatedText: buildApprovalCardText(updatedRecord!),
        updatedKeyboard: buildApprovalCardKeyboard(recordId),
      },
      error: null,
    };
  }

  if (action === 'skip') {
    deps.db
      .update(applicationRecords)
      .set({
        status: 'skipped_user',
        isNotified: true,
        updatedAt: nowIso,
      })
      .where(eq(applicationRecords.id, recordId))
      .run();

    return {
      data: {
        updatedText: `❌ <b>Вакансия пропущена:</b> <a href="${record.vacancyUrl}">${escapeHtml(record.positionTitle)}</a> (${escapeHtml(record.companyName)})`,
      },
      error: null,
    };
  }

  deps.configStore.addBlacklistedCompany(record.companyName);

  deps.db
    .update(applicationRecords)
    .set({
      status: 'skipped_user',
      isNotified: true,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(applicationRecords.companyName, record.companyName),
        eq(applicationRecords.status, 'pending_approval')
      )
    )
    .run();

  return {
    data: {
      updatedText: `🚫 <b>Компания «${escapeHtml(record.companyName)}» добавлена в черный список.</b> Вакансия пропущена.`,
    },
    error: null,
  };
} finally {
  inFlightApprovalIds.delete(recordId);
}
}

export function registerApprovalHandlers(
  bot: Bot<BotContext>,
  deps: ApprovalHandlerDeps,
  safeEditMessageText: (
    ctx: Context,
    text: string,
    other?: Parameters<Context['editMessageText']>[1]
  ) => Promise<void>
): void {
  bot.callbackQuery(/^appr:(send|regen|skip|bl):(\d+)$/, async (ctx) => {
    const match = ctx.match as RegExpMatchArray;
    const action = match[1] as 'send' | 'regen' | 'skip' | 'bl';
    const recordId = Number.parseInt(match[2] ?? '-1', 10);

    const result = await handleApprovalAction(action, recordId, deps);
    if (result.error || !result.data) {
      await ctx.answerCallbackQuery({
        text: `❌ ${result.error ?? 'Ошибка'}`,
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();
    await safeEditMessageText(ctx, result.data.updatedText, {
      parse_mode: 'HTML',
      reply_markup: result.data.updatedKeyboard,
      link_preview_options: {
        is_disabled: true,
      },
    });
  });
}

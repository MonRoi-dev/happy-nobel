import { and, gte, inArray, eq, notInArray } from 'drizzle-orm';
import type { AppDatabase } from '../../db/index.ts';
import { applicationRecords, type ApplicationRecord } from '../../db/schema.ts';
import type { IConfigStore } from '../config-store/index.ts';
import type { HhVacancyShortItem } from '../hh-hybrid/index.ts';
import { escapeHtml, type ITelegramBotService } from '../telegram/index.ts';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('SchedulerNotifications');

export function getLocalDayKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getStartOfLocalDayIso(now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function countTodayAppliedRecords(db: AppDatabase, now: Date = new Date()): number {
  const startIso = getStartOfLocalDayIso(now);
  const rows = db
    .select({ id: applicationRecords.id })
    .from(applicationRecords)
    .where(
      and(
        notInArray(applicationRecords.status, [
          'pending_approval',
          'skipped_user',
          'skipped_low_score',
          'tg_contact_notified',
          'pending_external_captcha',
        ]),
        gte(applicationRecords.appliedAt, startIso)
      )
    )
    .limit(500)
    .all();

  return rows.length;
}

export function formatStatusLabel(status: string): string {
  switch (status) {
    case 'invitation':
    case 'interview':
      return '🎉 Приглашение на собеседование';
    case 'discard':
    case 'rejected':
      return '❌ Отказ';
    case 'offer':
      return '🏆 Предложение о работе (оффер)';
    case 'viewed':
      return '👀 Резюме просмотрено';
    default:
      return '📨 Отклик отправлен';
  }
}

export function buildEmployerUpdateNotification(record: ApplicationRecord): string {
  const lines = [
    `🔔 <b>Обновление статуса отклика!</b>`,
    ``,
    `<b>Компания:</b> ${escapeHtml(record.companyName)}`,
    `<b>Вакансия:</b> <a href="${record.vacancyUrl}">${escapeHtml(record.positionTitle)}</a>`,
    `<b>Статус:</b> ${formatStatusLabel(record.status)}`,
  ];

  if (record.lastEmployerMessage && record.lastEmployerMessage.trim().length > 0) {
    lines.push(`<b>Сообщение от HR:</b>\n<i>${escapeHtml(record.lastEmployerMessage.trim())}</i>`);
  }

  return lines.join('\n');
}

export function formatAutoAppliedMessage(
  info: {
    vacancyUrl?: string;
    positionTitle?: string;
    companyName?: string;
    salaryText?: string;
  },
  todayCount: number,
  limit: number,
  delayMs: number
): string {
  const pauseNote =
    delayMs > 0
      ? `\n⏱ <i>Пауза перед следующим откликом: ~${Math.round(delayMs / 1000)} сек.</i>`
      : '';

  const lines = [
    `🚀 <b>Отправлен отклик! (${todayCount} из ${limit})</b>`,
    '',
    `<b>Вакансия:</b> <a href="${info.vacancyUrl ?? '#'}">${escapeHtml(info.positionTitle ?? 'Вакансия')}</a>`,
    `<b>Компания:</b> ${escapeHtml(info.companyName ?? 'Работодатель')}`,
    info.salaryText ? `<b>Зарплата:</b> ${escapeHtml(info.salaryText)}` : null,
    pauseNote,
  ].filter(Boolean);

  return lines.join('\n');
}

export function formatEmployerQuestionsEscalationText(
  vacancyName: string,
  vacancyUrl: string,
  companyName: string,
  coverLetter?: string
): string {
  const letterBlock = coverLetter
    ? `\n\n📝 <b>Сопроводительное письмо:</b>\n<pre>${escapeHtml(coverLetter)}</pre>`
    : '';

  return `⚠️ <b>Вакансия требует ручного отклика:</b>\n<a href="${vacancyUrl}">${escapeHtml(
    vacancyName
  )}</a> (${escapeHtml(companyName)})\n<i>Требуется ручное прохождение теста.</i>${letterBlock}`;
}

export function formatLlmUnavailableMessage(host: string, model: string, reason: string): string {
  const lines = [
    '⚠️ <b>Локальная языковая модель сейчас недоступна!</b>',
    '',
    `<b>Хост:</b> <code>${escapeHtml(host)}</code>`,
    `<b>Модель:</b> <code>${escapeHtml(model)}</code>`,
    `<b>Причина:</b> ${escapeHtml(reason)}`,
    '',
    '<i>Генерация сопроводительных писем и автоотклики приостановлены до восстановления работы модели.</i>',
  ];
  return lines.join('\n');
}

export function formatLlmRestoredMessage(model: string): string {
  const lines = [
    '🟢 <b>Связь с локальной языковой моделью восстановлена!</b>',
    '',
    `<b>Модель:</b> <code>${escapeHtml(model)}</code> готова к работе.`,
  ];
  return lines.join('\n');
}

export function formatDailyLimitReachedMessage(limit: number): string {
  return `Дневной лимит откликов (${limit} шт.) достигнут. Автоотклики продолжатся завтра`;
}

export function formatManualApprovalCardText(record: ApplicationRecord): string {
  const lines = [
    `📋 <b>Требуется ручное подтверждение отклика</b>`,
    '',
    `<b>Компания:</b> ${escapeHtml(record.companyName)}`,
    `<b>Вакансия:</b> <a href="${record.vacancyUrl}">${escapeHtml(record.positionTitle)}</a>`,
  ];
  if (record.salaryText) {
    lines.push(`<b>Зарплата:</b> ${escapeHtml(record.salaryText)}`);
  }
  if (record.matchScore !== null) {
    lines.push(`<b>Оценка совпадения:</b> ${record.matchScore}/100`);
  }
  if (record.aiReasoning) {
    lines.push(`<b>Анализ:</b> <i>${escapeHtml(record.aiReasoning)}</i>`);
  }
  if (record.coverLetter) {
    lines.push('', `<b>Сопроводительное письмо:</b>`, `<pre>${escapeHtml(record.coverLetter)}</pre>`);
  }
  return lines.join('\n');
}

export function formatDailyDigestMessage(stats: { appliedCount: number; limit: number }): string {
  return `📊 <b>Итоги дня:</b>\nОтправлено откликов: ${stats.appliedCount} из ${stats.limit}.`;
}

export function formatDirectContactsBlock(contacts: ReadonlyArray<string>): string {
  if (contacts.length === 0) {
    return '';
  }
  const formatted = contacts.map((c) => `• ${escapeHtml(c)}`).join('\n');
  return `📞 <b>Прямые контакты:</b>\n${formatted}`;
}

export async function notifyPendingEmployerUpdates(
  db: AppDatabase,
  telegramBot: ITelegramBotService
): Promise<number> {
  const unnotifiedRecords = db
    .select()
    .from(applicationRecords)
    .where(
      and(
        eq(applicationRecords.isNotified, false),
        inArray(applicationRecords.status, ['response', 'invitation', 'discard', 'viewed'])
      )
    )
    .limit(100)
    .all();

  let notifiedCount = 0;

  for (const record of unnotifiedRecords) {
    if (record.status === 'discard') {
      db.update(applicationRecords)
        .set({ isNotified: true })
        .where(eq(applicationRecords.id, record.id))
        .run();
      continue;
    }

    const text = buildEmployerUpdateNotification(record);
    const sendRes = await telegramBot.sendAdminMessage(text);

    if (!sendRes.error && sendRes.data) {
      db.update(applicationRecords)
        .set({ isNotified: true })
        .where(eq(applicationRecords.id, record.id))
        .run();
      notifiedCount += 1;
    } else if (sendRes.error) {
      logger.error('Failed to send employer status update notification', {
        id: record.id,
        error: sendRes.error,
      });
    }
  }

  return notifiedCount;
}

export function filterUnappliedVacancies(
  db: AppDatabase,
  configStore: IConfigStore,
  items: ReadonlyArray<HhVacancyShortItem>
): HhVacancyShortItem[] {
  if (items.length === 0) {
    return [];
  }
  const ids = items.map((i) => i.id);
  const existingRows = db
    .select({ vacancyId: applicationRecords.vacancyId })
    .from(applicationRecords)
    .where(inArray(applicationRecords.vacancyId, ids))
    .limit(100)
    .all();

  const appliedSet = new Set(existingRows.map((r) => r.vacancyId));
  return items.filter(
    (i) => !appliedSet.has(i.id) && configStore.isCompanyBlacklisted(i.employer?.name).data !== true
  );
}

export function formatCircuitBreakerOpenMessage(): string {
  return '⚠️ <b>HH.ru временно недоступен</b>\nЗафиксировано несколько последовательных сбоев. Автоотклики приостановлены на 15 минут (CircuitBreaker OPEN).';
}


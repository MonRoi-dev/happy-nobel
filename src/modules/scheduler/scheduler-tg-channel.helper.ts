import { eq } from 'drizzle-orm';
import { getExtendedUserProfile, type AppDatabase } from '../../db/index.ts';
import { applicationRecords, type ExtendedUserProfile } from '../../db/schema.ts';
import { createLogger } from '../../utils/logger.ts';
import type { IConfigStore, SafeResult } from '../config-store/index.ts';
import type { IHhBrowserCaptchaService, IHhHybridService } from '../hh-hybrid/index.ts';
import type { ILlmService } from '../llm/index.ts';
import { extractApplicantProfileFields } from '../parser/index.ts';
import type { ITelegramBotService } from '../telegram/index.ts';
import {
  classifyChannelPostTarget,
  ExternalFormApplierService,
  TgChannelScraperService,
  type IExternalFormApplierService,
  type ITgChannelScraperService,
  type TgChannelPostItem,
} from '../tg-channel/index.ts';
import type { TgChannelCycleSummary } from './scheduler.types.ts';

const logger = createLogger('TgChannelAutoApply');

function escapeHtmlText(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatTgContactCardMessage(params: {
  companyName: string;
  positionTitle: string;
  salaryText: string;
  postUrl: string;
  tgUsername: string;
  tgChatUrl: string;
  matchScore: number;
  coverLetter: string;
}): string {
  return [
    '📢 <b>Вакансия из Telegram-канала (прямой контакт HR)</b>',
    '',
    `💼 <b>Должность:</b> ${escapeHtmlText(params.positionTitle)}`,
    `🏢 <b>Компания:</b> ${escapeHtmlText(params.companyName)}`,
    `💰 <b>Зарплата:</b> ${escapeHtmlText(params.salaryText)}`,
    `🎯 <b>Совпадение ИИ:</b> ${params.matchScore}/100`,
    `👤 <b>Рекрутер:</b> @${escapeHtmlText(params.tgUsername)} (<a href="${escapeHtmlText(params.tgChatUrl)}">Открыть чат</a>)`,
    `🔗 <a href="${escapeHtmlText(params.postUrl)}">Пост в канале</a>`,
    '',
    '✉️ <b>Готовое сопроводительное (нажмите для копирования):</b>',
    `<code>${escapeHtmlText(params.coverLetter)}</code>`,
  ].join('\n');
}

export function formatExternalFormAppliedMessage(params: {
  companyName: string;
  positionTitle: string;
  salaryText: string;
  targetUrl: string;
  postUrl: string;
  matchScore: number;
}): string {
  return [
    '🌐 <b>Автоотклик отправлен через внешнюю форму (TG-канал)</b>',
    '',
    `💼 <b>Должность:</b> ${escapeHtmlText(params.positionTitle)}`,
    `🏢 <b>Компания:</b> ${escapeHtmlText(params.companyName)}`,
    `💰 <b>Зарплата:</b> ${escapeHtmlText(params.salaryText)}`,
    `🎯 <b>Совпадение ИИ:</b> ${params.matchScore}/100`,
    `🔗 <a href="${escapeHtmlText(params.targetUrl)}">Форма отклика</a> | <a href="${escapeHtmlText(params.postUrl)}">Пост в канале</a>`,
  ].join('\n');
}

export function formatExternalFormEscalationMessage(params: {
  companyName: string;
  positionTitle: string;
  targetUrl: string;
  postUrl: string;
  matchScore: number;
  reason: string;
  coverLetter: string;
}): string {
  return [
    '⚠️ <b>Внешняя форма подготовлена (требуется подтверждение / капча)</b>',
    '',
    `💼 <b>Должность:</b> ${escapeHtmlText(params.positionTitle)}`,
    `🏢 <b>Компания:</b> ${escapeHtmlText(params.companyName)}`,
    `🎯 <b>Совпадение ИИ:</b> ${params.matchScore}/100`,
    `📌 <b>Статус:</b> ${escapeHtmlText(params.reason)}`,
    `🔗 <a href="${escapeHtmlText(params.targetUrl)}">Открыть форму отклика</a> | <a href="${escapeHtmlText(params.postUrl)}">Пост в канале</a>`,
    '',
    '✉️ <b>Сопроводительное письмо (нажмите для копирования):</b>',
    `<code>${escapeHtmlText(params.coverLetter)}</code>`,
  ].join('\n');
}

export interface TgChannelCycleDeps {
  readonly db: AppDatabase;
  readonly configStore: IConfigStore;
  readonly hhHybrid: IHhHybridService;
  readonly llm: ILlmService;
  readonly telegramBot: ITelegramBotService;
  readonly captchaService?: IHhBrowserCaptchaService;
  readonly tgChannelScraper?: ITgChannelScraperService;
  readonly externalFormApplier?: IExternalFormApplierService;
  readonly countTodayApplications: () => number;
  readonly resolveDailyLimit: () => number;
}

function isVacancyIdRecorded(db: AppDatabase, vacancyId: string): boolean {
  const existing = db
    .select({ id: applicationRecords.id })
    .from(applicationRecords)
    .where(eq(applicationRecords.vacancyId, vacancyId))
    .limit(1)
    .get();
  return Boolean(existing);
}

function saveRecord(
  db: AppDatabase,
  values: typeof applicationRecords.$inferInsert
): void {
  db.insert(applicationRecords)
    .values(values)
    .onConflictDoNothing({ target: applicationRecords.vacancyId })
    .run();
}

async function applyDirectHhVacancyFromChannel(
  deps: TgChannelCycleDeps,
  post: TgChannelPostItem,
  profile: ExtendedUserProfile,
  hhVacancyId: string,
  hhVacancyUrl: string
): Promise<'applied' | 'skipped'> {
  if (isVacancyIdRecorded(deps.db, hhVacancyId)) {
    logger.info(
      `[Пост ${post.postId}] Прямая ссылка HH.ru (${hhVacancyId}) уже есть в истории откликов, пропуск.`
    );
    const nowIso = new Date().toISOString();
    saveRecord(deps.db, {
      vacancyId: post.vacancyKey,
      companyName: post.companyName,
      positionTitle: post.positionTitle,
      salaryText: post.salaryText,
      vacancyUrl: hhVacancyUrl,
      coverLetter: '',
      status: 'skipped_user',
      matchScore: 100,
      aiReasoning: 'Direct HH link already applied earlier',
      lastEmployerMessage: null,
      isNotified: true,
      appliedAt: nowIso,
      updatedAt: nowIso,
    });
    return 'skipped';
  }

  logger.info(
    `[Пост ${post.postId}] Прямой отклик на HH.ru без фильтров и порога оценки: ${hhVacancyUrl}`
  );

  let vacancyTitle = post.positionTitle;
  let companyName = post.companyName;
  let salaryText = post.salaryText;
  let description = post.rawText;

  const detailsRes = await deps.hhHybrid.getVacancyDetails(hhVacancyId);
  if (detailsRes.data) {
    vacancyTitle = detailsRes.data.vacancy.name || vacancyTitle;
    companyName = detailsRes.data.vacancy.employer?.name ?? companyName;
    salaryText = detailsRes.data.salaryText || salaryText;
    if (detailsRes.data.cleanDescription.length >= 10) {
      description = detailsRes.data.cleanDescription;
    }
  } else if (detailsRes.error) {
    logger.warn(
      `[Пост ${post.postId}] Не удалось загрузить детали вакансии HH.ru ${hhVacancyId} (${detailsRes.error}), используем текст из поста.`
    );
  }

  const letterRes = await deps.llm.generateCoverLetter({
    resumeRawText: profile.resumeRawText,
    vacancyTitle,
    companyName,
    vacancyDescription: description.length >= 10 ? description : `${vacancyTitle} at ${companyName}`,
    customPromptRules: profile.customPromptRules,
  });

  if (letterRes.error) {
    logger.warn(
      `[Пост ${post.postId}] Ошибка генерации сопроводительного письма LLM для HH.ru (${hhVacancyId}): ${letterRes.error}`
    );
  }

  const coverLetter = letterRes.data ?? '';
  const skipForeign = deps.configStore.isSkipForeignVacanciesEnabled?.().data ?? true;

  const applyRes = await deps.hhHybrid.applyToVacancy({
    vacancyId: hhVacancyId,
    vacancyUrl: hhVacancyUrl,
    resumeTitle: profile.hhResumeTitle,
    coverLetter,
    skipForeignVacancies: skipForeign,
  });

  if (applyRes.error === 'CAPTCHA_REQUIRED') {
    logger.warn(`[Пост ${post.postId}] При отклике на HH.ru (${hhVacancyId}) потребовалась капча.`);
    await deps.captchaService?.handleCaptchaDetected({
      detected: true,
      pageUrl: hhVacancyUrl,
    });
    return 'skipped';
  }

  const nowIso = new Date().toISOString();
  if (applyRes.error && applyRes.error !== 'ALREADY_APPLIED') {
    logger.warn(
      `[Пост ${post.postId}] Не удалось отправить отклик на HH.ru (${hhVacancyId}): ${applyRes.error}`
    );
    saveRecord(deps.db, {
      vacancyId: post.vacancyKey,
      companyName,
      positionTitle: vacancyTitle,
      salaryText,
      vacancyUrl: hhVacancyUrl,
      coverLetter,
      status: 'skipped_user',
      matchScore: 100,
      aiReasoning: 'Direct HH link from TG channel',
      lastEmployerMessage: applyRes.error,
      isNotified: true,
      appliedAt: nowIso,
      updatedAt: nowIso,
    });
    return 'skipped';
  }

  logger.info(
    `[Пост ${post.postId}] Прямой отклик на HH.ru (${hhVacancyId}) успешно отправлен: "${vacancyTitle}" (${companyName}).`
  );

  const commonRecord = {
    companyName,
    positionTitle: vacancyTitle,
    salaryText,
    vacancyUrl: hhVacancyUrl,
    coverLetter,
    status: 'response',
    matchScore: 100,
    aiReasoning: 'Direct HH route from Telegram channel (bypassed filters & score)',
    lastEmployerMessage: null,
    isNotified: true,
    appliedAt: nowIso,
    updatedAt: nowIso,
  };

  saveRecord(deps.db, { ...commonRecord, vacancyId: hhVacancyId });
  saveRecord(deps.db, { ...commonRecord, vacancyId: post.vacancyKey });

  await deps.telegramBot.sendAdminMessage(
    [
      '✅ <b>Прямой отклик на HH.ru из Telegram-канала</b>',
      `💼 <b>Должность:</b> ${escapeHtmlText(vacancyTitle)}`,
      `🏢 <b>Компания:</b> ${escapeHtmlText(companyName)}`,
      `🔗 <a href="${escapeHtmlText(hhVacancyUrl)}">Вакансия HH.ru</a> | <a href="${escapeHtmlText(post.postUrl)}">Пост</a>`,
    ].join('\n'),
    { parse_mode: 'HTML' }
  );

  return 'applied';
}

export async function runTgChannelAutoApplyCore(
  deps: TgChannelCycleDeps
): Promise<SafeResult<TgChannelCycleSummary>> {
  const isEnabled =
    typeof deps.configStore.isTgChannelEnabled === 'function'
      ? deps.configStore.isTgChannelEnabled().data !== false
      : true;

  if (!isEnabled) {
    logger.info('Автоотклики по Telegram-каналам отключены (TG_CHANNEL_AUTORESPONDER_ENABLED=false).');
    return {
      data: { appliedCount: 0, skippedCount: 0, notifiedCount: 0 },
      error: null,
    };
  }

  const profile = getExtendedUserProfile(deps.db);
  if (!profile) {
    logger.warn('Пропуск цикла Telegram-каналов: не заполнен профиль резюме (user_profile).');
    return {
      data: { appliedCount: 0, skippedCount: 0, notifiedCount: 0 },
      error: null,
    };
  }

  const channels =
    typeof deps.configStore.getTgJobChannels === 'function'
      ? (deps.configStore.getTgJobChannels().data ?? ['https://t.me/node_js_jobs_vakansii'])
      : ['https://t.me/node_js_jobs_vakansii'];

  const scraper = deps.tgChannelScraper ?? new TgChannelScraperService();
  const applier =
    deps.externalFormApplier ??
    new ExternalFormApplierService();

  const extractedContacts = extractApplicantProfileFields(
    profile.resumeRawText,
    profile.applicantName ?? profile.hhResumeTitle
  );
  const applicantProfile = {
    applicantName: profile.applicantName ?? extractedContacts.applicantName,
    applicantEmail: profile.applicantEmail ?? extractedContacts.applicantEmail,
    applicantPhone: profile.applicantPhone ?? extractedContacts.applicantPhone,
    applicantTelegram: profile.applicantTelegram ?? extractedContacts.applicantTelegram,
    resumeRawText: profile.resumeRawText,
    resumePdfPath: profile.resumePdfPath ?? null,
    customPromptRules: profile.customPromptRules,
  };

  const minMatchScore = deps.configStore.getMinMatchScore().data ?? 70;
  let appliedCount = 0;
  let skippedCount = 0;
  let notifiedCount = 0;

  logger.info(
    `Старт цикла автооткликов по Telegram-каналам (каналов: ${channels.length}, порог ИИ: ${minMatchScore}/100, PDF: ${applicantProfile.resumePdfPath ? 'загружен' : 'нет'})...`
  );

  for (const channelUrl of channels) {
    const postsRes = await scraper.scrapePublicChannelPosts(channelUrl, 20);
    if (postsRes.error || !postsRes.data) {
      logger.warn(`Не удалось прочитать Telegram-канал ${channelUrl}: ${postsRes.error}`);
      continue;
    }

    logger.info(
      `Анализ постов из канала ${channelUrl}: всего получено ${postsRes.data.length} вакансий.`
    );

    for (const post of postsRes.data) {
      if (deps.countTodayApplications() >= deps.resolveDailyLimit()) {
        logger.info(
          `Дневной лимит откликов достигнут (${deps.countTodayApplications()}/${deps.resolveDailyLimit()}), остановка цикла Telegram-каналов.`
        );
        return {
          data: { appliedCount, skippedCount, notifiedCount },
          error: null,
        };
      }

      if (isVacancyIdRecorded(deps.db, post.vacancyKey)) {
        logger.info(
          `[Пост ${post.postId}] "${post.positionTitle}" (${post.companyName}) — уже обработан ранее, пропуск.`
        );
        skippedCount += 1;
        continue;
      }

      if (deps.configStore.isCompanyBlacklisted(post.companyName).data === true) {
        logger.info(
          `[Пост ${post.postId}] Компания "${post.companyName}" в черном списке, пропуск.`
        );
        skippedCount += 1;
        continue;
      }

      const target = classifyChannelPostTarget(post);
      if (!target) {
        logger.info(
          `[Пост ${post.postId}] "${post.positionTitle}" (${post.companyName}) — не найдена веб-ссылка или TG-контакт для автоотклика, пропуск.`
        );
        skippedCount += 1;
        continue;
      }

      if (target.kind === 'hh_vacancy') {
        logger.info(
          `[Пост ${post.postId}] "${post.positionTitle}" (${post.companyName}) -> классифицирован как прямая ссылка HH.ru (${target.hhVacancyUrl}).`
        );
        const hhOutcome = await applyDirectHhVacancyFromChannel(
          deps,
          post,
          profile,
          target.hhVacancyId,
          target.hhVacancyUrl
        );
        if (hhOutcome === 'applied') {
          appliedCount += 1;
        } else {
          skippedCount += 1;
        }
        continue;
      }

      if (target.kind === 'tg_contact') {
        logger.info(
          `[Пост ${post.postId}] "${post.positionTitle}" (${post.companyName}) -> классифицирован как прямой контакт рекрутера @${target.tgUsername}. Оценка через LLM...`
        );
        const evalRes = await deps.llm.evaluateVacancy({
          resumeRawText: profile.resumeRawText,
          vacancyTitle: post.positionTitle,
          companyName: post.companyName,
          vacancyDescription: post.rawText,
          customPromptRules: profile.customPromptRules,
          minMatchScore,
        });

        if (evalRes.error || !evalRes.data) {
          logger.error(
            `[Пост ${post.postId}] Ошибка оценки LLM для вакансии "${post.positionTitle}" (${post.companyName}): ${evalRes.error ?? 'нет ответа'}`
          );
          skippedCount += 1;
          continue;
        }

        const nowIso = new Date().toISOString();
        if (evalRes.data.matchScore < minMatchScore) {
          logger.info(
            `[Пост ${post.postId}] Вакансия "${post.positionTitle}" (${post.companyName}) пропущена по оценке ИИ (${evalRes.data.matchScore} < ${minMatchScore}).`
          );
          saveRecord(deps.db, {
            vacancyId: post.vacancyKey,
            companyName: post.companyName,
            positionTitle: post.positionTitle,
            salaryText: post.salaryText,
            vacancyUrl: post.postUrl,
            coverLetter: '',
            status: 'skipped_low_score',
            matchScore: evalRes.data.matchScore,
            aiReasoning: evalRes.data.reasoning,
            lastEmployerMessage: null,
            isNotified: true,
            appliedAt: nowIso,
            updatedAt: nowIso,
          });
          skippedCount += 1;
          continue;
        }

        const contactSummary =
          target.contactType === 'email' && target.hrEmail
            ? `Email: ${target.hrEmail} | Пост: ${post.postUrl}`
            : `TG: @${target.tgUsername} | Пост: ${post.postUrl}`;

        saveRecord(deps.db, {
          vacancyId: post.vacancyKey,
          companyName: post.companyName,
          positionTitle: post.positionTitle,
          salaryText: post.salaryText,
          vacancyUrl: target.tgChatUrl,
          coverLetter: evalRes.data.coverLetter,
          status: 'tg_contact_notified',
          matchScore: evalRes.data.matchScore,
          aiReasoning: evalRes.data.reasoning,
          lastEmployerMessage: contactSummary,
          isNotified: true,
          appliedAt: nowIso,
          updatedAt: nowIso,
        });

        logger.info(
          `[Пост ${post.postId}] Вакансия добавлена в очередь «Контакты HR / Почта»: ${target.tgUsername} (${evalRes.data.matchScore}/100).`
        );
        notifiedCount += 1;
        continue;
      }

      if (target.kind === 'external_form') {
        logger.info(
          `[Пост ${post.postId}] "${post.positionTitle}" (${post.companyName}) -> классифицирован как внешняя форма: ${target.targetUrl}`
        );
        const extRes = await applier.applyToExternalForm({
          targetUrl: target.targetUrl,
          channelPostText: post.rawText,
          positionTitle: post.positionTitle,
          companyName: post.companyName,
          applicantProfile,
          minMatchScore,
          evaluateVacancyFn: (evalInput) => deps.llm.evaluateVacancy(evalInput),
          questionSolver:
            deps.configStore.isAnswerQuestionsEnabled().data !== false &&
            typeof deps.llm.answerEmployerQuestions === 'function'
              ? (questions) =>
                  deps.llm.answerEmployerQuestions({
                    resumeRawText: profile.resumeRawText,
                    vacancyTitle: post.positionTitle,
                    companyName: post.companyName,
                    questions: [...questions],
                  })
              : undefined,
        });

        if (extRes.error || !extRes.data) {
          logger.error(
            `[Пост ${post.postId}] Ошибка обработки внешней формы ${target.targetUrl}: ${extRes.error ?? 'нет данных'}`
          );
          skippedCount += 1;
          continue;
        }

        const outcome = extRes.data;
        if (outcome.status === 'redirected_to_hh' && outcome.hhVacancyId && outcome.hhVacancyUrl) {
          logger.info(
            `[Пост ${post.postId}] Внешняя ссылка ${target.targetUrl} перенаправила на HH.ru (${outcome.hhVacancyId}).`
          );
          const hhOutcome = await applyDirectHhVacancyFromChannel(
            deps,
            post,
            profile,
            outcome.hhVacancyId,
            outcome.hhVacancyUrl
          );
          if (hhOutcome === 'applied') {
            appliedCount += 1;
          } else {
            skippedCount += 1;
          }
          continue;
        }

        const nowIso = new Date().toISOString();
        if (outcome.status === 'skipped_low_score') {
          logger.info(
            `[Пост ${post.postId}] Внешняя вакансия "${post.positionTitle}" (${post.companyName}) пропущена по оценке ИИ (${outcome.matchScore ?? 0} < ${minMatchScore}).`
          );
          saveRecord(deps.db, {
            vacancyId: post.vacancyKey,
            companyName: post.companyName,
            positionTitle: post.positionTitle,
            salaryText: post.salaryText,
            vacancyUrl: outcome.finalUrl,
            coverLetter: '',
            status: 'skipped_low_score',
            matchScore: outcome.matchScore ?? 0,
            aiReasoning: outcome.reasoning ?? null,
            lastEmployerMessage: null,
            isNotified: true,
            appliedAt: nowIso,
            updatedAt: nowIso,
          });
          skippedCount += 1;
          continue;
        }

        if (outcome.status === 'applied_external') {
          logger.info(
            `[Пост ${post.postId}] Успешно отправлен автоотклик через внешнюю форму: ${outcome.finalUrl} (заполнено полей: ${outcome.filledFieldsCount}).`
          );
          saveRecord(deps.db, {
            vacancyId: post.vacancyKey,
            companyName: post.companyName,
            positionTitle: post.positionTitle,
            salaryText: post.salaryText,
            vacancyUrl: outcome.finalUrl,
            coverLetter: outcome.coverLetter ?? '',
            status: 'applied_external',
            matchScore: outcome.matchScore ?? 100,
            aiReasoning: outcome.reasoning ?? null,
            lastEmployerMessage: null,
            isNotified: true,
            appliedAt: nowIso,
            updatedAt: nowIso,
          });

          await deps.telegramBot.sendAdminMessage(
            formatExternalFormAppliedMessage({
              companyName: post.companyName,
              positionTitle: post.positionTitle,
              salaryText: post.salaryText,
              targetUrl: outcome.finalUrl,
              postUrl: post.postUrl,
              matchScore: outcome.matchScore ?? 100,
            }),
            { parse_mode: 'HTML' }
          );
          appliedCount += 1;
          continue;
        }

        if (outcome.status === 'pending_external_captcha' || outcome.status === 'missing_resume_pdf') {
          const reason =
            outcome.status === 'missing_resume_pdf'
              ? 'На форме требуется PDF-файл резюме (загрузите PDF через /resume)'
              : 'Требуется ручное подтверждение / прохождение капчи на форме сайта';

          logger.info(
            `[Пост ${post.postId}] Внешняя форма ${outcome.finalUrl} добавлена в очередь «Формы сайтов»: ${reason}`
          );

          saveRecord(deps.db, {
            vacancyId: post.vacancyKey,
            companyName: post.companyName,
            positionTitle: post.positionTitle,
            salaryText: post.salaryText,
            vacancyUrl: outcome.finalUrl,
            coverLetter: outcome.coverLetter ?? '',
            status: 'pending_external_captcha',
            matchScore: outcome.matchScore ?? 100,
            aiReasoning: outcome.reasoning ?? null,
            lastEmployerMessage: `${reason} | Пост: ${post.postUrl}`,
            isNotified: true,
            appliedAt: nowIso,
            updatedAt: nowIso,
          });

          notifiedCount += 1;
          continue;
        }

        logger.warn(
          `[Пост ${post.postId}] Внешняя форма ${outcome.finalUrl} не была отправлена (статус: ${outcome.status}).`
        );
        skippedCount += 1;
      }
    }
  }

  logger.info(
    `Цикл Telegram-каналов завершен: отправлено=${appliedCount}, уведомлений=${notifiedCount}, пропущено=${skippedCount}.`
  );

  return {
    data: { appliedCount, skippedCount, notifiedCount },
    error: null,
  };
}

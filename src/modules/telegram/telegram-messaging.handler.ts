import { InlineKeyboard, type Context, type Bot } from 'grammy';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../../db/index.ts';
import {
  applicationRecords,
  negotiationMessages,
  userProfiles,
  type NegotiationMessageRecord,
} from '../../db/schema.ts';
import type { SafeResult } from '../config-store/index.ts';
import {
  isInformativeEmployerMessage,
  type ChatMessageBubble,
  type IHhMessagingService,
} from '../hh-hybrid/index.ts';
import type { ILlmReplyService } from '../llm/index.ts';
import type { AgentLogEntry } from '../logger/index.ts';
import { extractContacts, formatExtractedContactsBlock } from '../parser/index.ts';
import { escapeHtml } from './telegram-blacklist.ts';
import type { BotContext } from './telegram-wizards.ts';

export interface UnreadNotificationRecordLike {
  readonly companyName: string;
  readonly positionTitle: string;
  readonly lastUnreadText: string;
}

export function buildUnreadNotificationText(
  record: UnreadNotificationRecordLike
): string {
  const lines: string[] = [
    '📩 <b>Новое сообщение от работодателя!</b>',
    `🏢 <b>Компания:</b> ${escapeHtml(record.companyName)}`,
    `💼 <b>Вакансия:</b> ${escapeHtml(record.positionTitle)}`,
    '',
    '💬 <b>Сообщение:</b>',
    `"${escapeHtml(record.lastUnreadText)}"`,
  ];

  const contacts = extractContacts(record.lastUnreadText);
  const contactsBlock = formatExtractedContactsBlock(contacts, escapeHtml);
  if (contactsBlock.length > 0) {
    lines.push('', contactsBlock);
  }

  return lines.join('\n');
}

export function buildUnreadInitialKeyboard(
  negotiationId: string,
  chatUrl: string
): InlineKeyboard {
  return new InlineKeyboard()
    .url('🔗 Ответить самостоятельно', chatUrl)
    .row()
    .text('🤖 Сгенерировать ИИ', `ai_reply:gen:${negotiationId}`);
}

export function buildUnreadDraftPreviewText(
  record: UnreadNotificationRecordLike,
  draftText: string,
  _confidenceScore?: number
): string {
  return [
    buildUnreadNotificationText(record),
    '',
    '🤖 <b>Черновик ответа ИИ:</b>',
    `<pre>${escapeHtml(draftText)}</pre>`,
  ].join('\n');
}

export function buildUnreadDraftKeyboard(
  negotiationId: string,
  chatUrl: string
): InlineKeyboard {
  return new InlineKeyboard()
    .text('📤 Отправить', `ai_reply:send:${negotiationId}`)
    .text('🔄 Перегенерировать', `ai_reply:regen:${negotiationId}`)
    .row()
    .url('🔗 Ответить самостоятельно', chatUrl);
}

export function buildUnreadSentText(
  record: UnreadNotificationRecordLike,
  sentText: string
): string {
  return [
    buildUnreadNotificationText(record),
    '',
    '✅ <b>Ответ ИИ отправлен:</b>',
    `<pre>${escapeHtml(sentText)}</pre>`,
  ].join('\n');
}

export function buildUnreadSentKeyboard(
  negotiationId: string,
  chatUrl: string
): InlineKeyboard {
  return new InlineKeyboard()
    .url('🔗 Ответить самостоятельно', chatUrl)
    .row()
    .text('✅ Ответ ИИ отправлен', `ai_reply:done:${negotiationId}`);
}

export function buildRecentErrorsReportText(
  entries: ReadonlyArray<AgentLogEntry>
): string {
  if (entries.length === 0) {
    return '✅ <b>Ошибок в agent-errors.jsonl не зафиксировано.</b>';
  }
  const slice = entries.slice(0, 5);
  const lines: string[] = [`🪵 <b>Последние ошибки (${slice.length}):</b>`, ''];
  for (let i = 0; i < slice.length; i++) {
    const entry = slice[i]!;
    const hint = entry.error?.DiagnosticHintForAgent;
    lines.push(
      `<b>${i + 1}. [${escapeHtml(entry.timestamp)}] [${escapeHtml(entry.module)}] ${escapeHtml(entry.action)}</b>`
    );
    lines.push(`💬 ${escapeHtml(entry.message)}`);
    if (hint) {
      lines.push(`💡 <i>Подсказка:</i> ${escapeHtml(hint)}`);
    }
    if (i < slice.length - 1) {
      lines.push('');
    }
  }
  return lines.join('\n');
}

export interface SyncUnreadMessagesDeps {
  readonly db: AppDatabase;
  readonly hhMessaging: IHhMessagingService;
  readonly sendUnreadChatNotification: (
    record: NegotiationMessageRecord
  ) => Promise<SafeResult<number>>;
}

export async function syncUnreadMessagesCore(
  deps: SyncUnreadMessagesDeps,
  traceId?: string
): Promise<SafeResult<{ checkedCount: number; notifiedCount: number }>> {
  const fetchRes = await deps.hhMessaging.fetchUnreadNegotiations(traceId);
  if (fetchRes.error || !fetchRes.data) {
    return {
      data: null,
      error: fetchRes.error ?? 'Failed to fetch unread negotiations',
    };
  }

  const unreadItems = fetchRes.data;
  let notifiedCount = 0;

  for (const item of unreadItems) {
    const existing = deps.db
      .select()
      .from(negotiationMessages)
      .where(eq(negotiationMessages.negotiationId, item.negotiationId))
      .limit(1)
      .get();

    if (!item.unreadMessages || item.unreadMessages.length === 0) {
      continue;
    }

    const lastUnreadText = item.unreadMessages[item.unreadMessages.length - 1]?.trim() ?? '';
    if (!lastUnreadText || !isInformativeEmployerMessage(lastUnreadText)) {
      continue;
    }

    if (existing && existing.lastUnreadText === lastUnreadText) {
      continue;
    }

    const appRec = item.vacancyId
      ? deps.db
          .select({ status: applicationRecords.status })
          .from(applicationRecords)
          .where(eq(applicationRecords.vacancyId, item.vacancyId))
          .limit(1)
          .get()
      : null;

    const lowerText = lastUnreadText.toLowerCase();
    const isDiscard =
      appRec?.status === 'discard' ||
      lowerText === 'отказ' ||
      lowerText.includes('отказ') ||
      lowerText.includes('не готовы пригласить') ||
      lowerText.includes('не готовы предложить') ||
      lowerText.includes('вынуждены отказать') ||
      lowerText.includes('выбрали другого');

    if (isDiscard) {
      const nowIso = new Date().toISOString();
      if (existing) {
        deps.db
          .update(negotiationMessages)
          .set({
            lastUnreadText,
            replyStatus: 'replied_manually',
            updatedAt: nowIso,
          })
          .where(eq(negotiationMessages.id, existing.id))
          .run();
      } else {
        deps.db
          .insert(negotiationMessages)
          .values({
            negotiationId: item.negotiationId,
            vacancyId: item.vacancyId,
            companyName: item.companyName,
            positionTitle: item.positionTitle,
            chatUrl: item.chatUrl,
            lastUnreadText,
            chatHistoryJson: JSON.stringify(item.fullHistory),
            extractedContactsJson: '[]',
            replyStatus: 'replied_manually',
            updatedAt: nowIso,
          })
          .run();
      }
      continue;
    }

    const extractedContactsJson = JSON.stringify(extractContacts(lastUnreadText));
    const nowIso = new Date().toISOString();
    if (existing) {
      deps.db
        .update(negotiationMessages)
        .set({
          vacancyId: item.vacancyId,
          companyName: item.companyName,
          positionTitle: item.positionTitle,
          chatUrl: item.chatUrl,
          lastUnreadText,
          chatHistoryJson: JSON.stringify(item.fullHistory),
          extractedContactsJson,
          replyStatus: 'unread_notified',
          updatedAt: nowIso,
        })
        .where(eq(negotiationMessages.id, existing.id))
        .run();
    } else {
      deps.db
        .insert(negotiationMessages)
        .values({
          negotiationId: item.negotiationId,
          vacancyId: item.vacancyId,
          companyName: item.companyName,
          positionTitle: item.positionTitle,
          chatUrl: item.chatUrl,
          lastUnreadText,
          chatHistoryJson: JSON.stringify(item.fullHistory),
          extractedContactsJson,
          replyStatus: 'unread_notified',
          updatedAt: nowIso,
        })
        .run();
    }

    const savedRecord = deps.db
      .select()
      .from(negotiationMessages)
      .where(eq(negotiationMessages.negotiationId, item.negotiationId))
      .limit(1)
      .get();

    if (savedRecord) {
      const sendRes = await deps.sendUnreadChatNotification(savedRecord);
      if (!sendRes.error && typeof sendRes.data === 'number') {
        deps.db
          .update(negotiationMessages)
          .set({ telegramMessageId: sendRes.data })
          .where(eq(negotiationMessages.id, savedRecord.id))
          .run();
      }
      notifiedCount++;
    }
  }

  return {
    data: {
      checkedCount: unreadItems.length,
      notifiedCount,
    },
    error: null,
  };
}

export interface MessagingHandlerDeps {
  readonly db: AppDatabase;
  readonly hhMessaging?: IHhMessagingService;
  readonly llmReply?: ILlmReplyService;
  readonly safeEditMessageText: (
    ctx: Context,
    text: string,
    other?: Parameters<Context['editMessageText']>[1]
  ) => Promise<void>;
}

export async function handleAiReplyCallback(
  action: 'gen' | 'regen' | 'send' | 'done',
  negotiationId: string,
  deps: MessagingHandlerDeps,
  ctx: Context
): Promise<SafeResult<boolean>> {
  if (action === 'done') {
    await ctx.answerCallbackQuery({ text: 'Ответ уже отправлен' });
    return { data: true, error: null };
  }

  let record = deps.db
    .select()
    .from(negotiationMessages)
    .where(eq(negotiationMessages.negotiationId, negotiationId))
    .limit(1)
    .get();

  if (!record) {
    await ctx.answerCallbackQuery({
      text: '❌ Диалог не найден в базе данных.',
      show_alert: true,
    });
    return { data: null, error: 'Negotiation record not found' };
  }

  const appRecord = record.vacancyId
    ? deps.db
        .select({ status: applicationRecords.status })
        .from(applicationRecords)
        .where(eq(applicationRecords.vacancyId, record.vacancyId))
        .limit(1)
        .get()
    : null;

  const lowerRecordMsg = record.lastUnreadText.toLowerCase();
  if (
    appRecord?.status === 'discard' ||
    lowerRecordMsg === 'отказ' ||
    lowerRecordMsg.includes('отказ') ||
    lowerRecordMsg.includes('не готовы пригласить')
  ) {
    await ctx.answerCallbackQuery({
      text: '❌ По данной вакансии получен отказ, автоответ не требуется.',
      show_alert: true,
    });
    return { data: false, error: 'Negotiation rejected' };
  }

  if (action === 'gen' || action === 'regen') {
    if (!deps.llmReply) {
      await ctx.answerCallbackQuery({
        text: '❌ Сервис LLM не настроен.',
        show_alert: true,
      });
      return { data: null, error: 'LlmReplyService not available' };
    }

    await ctx.answerCallbackQuery({
      text: 'Генерирую черновик ответа через Gemma 4...',
    });

    const profile = deps.db.select().from(userProfiles).limit(1).get();
    let chatHistory: ChatMessageBubble[] = [];
    try {
      chatHistory = JSON.parse(record.chatHistoryJson);
    } catch {
      chatHistory = [];
    }

    const temperature = action === 'regen' ? 0.65 : 0.35;
    const genRes = await deps.llmReply.generateEmployerReply({
      resumeRawText: profile?.resumeRawText ?? '',
      companyName: record.companyName,
      positionTitle: record.positionTitle,
      chatHistory,
      lastUnreadText: record.lastUnreadText,
      customPromptRules: profile?.customPromptRules,
      temperature,
    });

    if (genRes.error || !genRes.data) {
      await ctx.reply(
        `❌ Ошибка генерации ответа: ${genRes.error ?? 'неизвестная ошибка'}`
      );
      return {
        data: null,
        error: genRes.error ?? 'Failed to generate employer reply',
      };
    }

    const nowIso = new Date().toISOString();
    deps.db
      .update(negotiationMessages)
      .set({
        replyStatus: 'draft_generated',
        aiGeneratedReply: genRes.data.replyText,
        updatedAt: nowIso,
      })
      .where(eq(negotiationMessages.id, record.id))
      .run();

    const updatedRecord: NegotiationMessageRecord = {
      ...record,
      replyStatus: 'draft_generated',
      aiGeneratedReply: genRes.data.replyText,
      updatedAt: nowIso,
    };

    await deps.safeEditMessageText(
      ctx,
      buildUnreadDraftPreviewText(
        updatedRecord,
        genRes.data.replyText,
        genRes.data.confidenceScore
      ),
      {
        parse_mode: 'HTML',
        reply_markup: buildUnreadDraftKeyboard(
          negotiationId,
          record.chatUrl
        ),
      }
    );

    return { data: true, error: null };
  }

  if (action === 'send') {
    if (record.replyStatus === 'replied_by_ai') {
      await ctx.answerCallbackQuery({ text: 'Ответ уже был отправлен' });
      return { data: true, error: null };
    }

    let replyText = record.aiGeneratedReply;
    if (!replyText) {
      if (!deps.llmReply) {
        await ctx.answerCallbackQuery({
          text: '❌ Сервис LLM не настроен.',
          show_alert: true,
        });
        return { data: null, error: 'LlmReplyService not available' };
      }

      await ctx.answerCallbackQuery({
        text: 'Генерирую черновик ответа через Gemma 4...',
      });

      const profile = deps.db.select().from(userProfiles).limit(1).get();
      let chatHistory: ChatMessageBubble[] = [];
      try {
        chatHistory = JSON.parse(record.chatHistoryJson);
      } catch {
        chatHistory = [];
      }

      const genRes = await deps.llmReply.generateEmployerReply({
        resumeRawText: profile?.resumeRawText ?? '',
        companyName: record.companyName,
        positionTitle: record.positionTitle,
        chatHistory,
        lastUnreadText: record.lastUnreadText,
        customPromptRules: profile?.customPromptRules,
        temperature: 0.35,
      });

      if (genRes.error || !genRes.data) {
        await ctx.reply(
          `❌ Ошибка генерации ответа: ${genRes.error ?? 'неизвестная ошибка'}`
        );
        return {
          data: null,
          error: genRes.error ?? 'Failed to generate employer reply',
        };
      }

      replyText = genRes.data.replyText;
      const nowIso = new Date().toISOString();
      deps.db
        .update(negotiationMessages)
        .set({
          replyStatus: 'draft_generated',
          aiGeneratedReply: replyText,
          updatedAt: nowIso,
        })
        .where(eq(negotiationMessages.id, record.id))
        .run();

      record = {
        ...record,
        replyStatus: 'draft_generated',
        aiGeneratedReply: replyText,
        updatedAt: nowIso,
      };
    }

    if (!deps.hhMessaging) {
      await ctx.answerCallbackQuery({
        text: '❌ Сервис HH.ru сообщений не настроен.',
        show_alert: true,
      });
      return { data: null, error: 'HhMessagingService not available' };
    }

    await ctx.answerCallbackQuery({
      text: 'Отправляю ответ в чат HH.ru...',
    });

    const sendRes = await deps.hhMessaging.sendChatMessage(
      negotiationId,
      replyText
    );

    const nowIso = new Date().toISOString();
    if (sendRes.error || !sendRes.data) {
      deps.db
        .update(negotiationMessages)
        .set({
          replyStatus: 'failed',
          updatedAt: nowIso,
        })
        .where(eq(negotiationMessages.id, record.id))
        .run();

      await ctx.reply(
        `❌ Ошибка отправки ответа: ${sendRes.error ?? 'неизвестная ошибка'}`
      );
      return {
        data: null,
        error: sendRes.error ?? 'Failed to send chat message',
      };
    }

    deps.db
      .update(negotiationMessages)
      .set({
        replyStatus: 'replied_by_ai',
        aiGeneratedReply: replyText,
        updatedAt: nowIso,
      })
      .where(eq(negotiationMessages.id, record.id))
      .run();

    const sentRecord: NegotiationMessageRecord = {
      ...record,
      replyStatus: 'replied_by_ai',
      aiGeneratedReply: replyText,
      updatedAt: nowIso,
    };

    await deps.safeEditMessageText(
      ctx,
      buildUnreadSentText(sentRecord, replyText),
      {
        parse_mode: 'HTML',
        reply_markup: buildUnreadSentKeyboard(
          negotiationId,
          record.chatUrl
        ),
      }
    );

    return { data: true, error: null };
  }

  return { data: null, error: `Unsupported action: ${String(action)}` };
}

export function registerMessagingHandlers(
  bot: Bot<BotContext>,
  deps: MessagingHandlerDeps
): void {
  bot.callbackQuery(/^ai_reply:(?:(gen|regen|send|done):)?(.+)$/, async (ctx) => {
    const rawAction = ctx.match[1];
    const action = (rawAction as 'gen' | 'regen' | 'send' | 'done') || 'gen';
    const negotiationId = ctx.match[2] ?? '';
    await handleAiReplyCallback(action, negotiationId, deps, ctx);
  });
}

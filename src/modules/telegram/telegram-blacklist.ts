import { InlineKeyboard, type Context, type Bot } from 'grammy';
import type { BotCommand } from 'grammy/types';
import type { IConfigStore } from '../config-store/index.ts';
import type { BotContext } from './telegram-wizards.ts';

export const BOT_MENU_COMMANDS: readonly BotCommand[] = [
  { command: 'menu', description: '📋 Главное меню и статус' },
  { command: 'status', description: '📊 Краткий отчет по откликам' },
  { command: 'settings', description: '⚙️ Настройки автоматизации и ИИ' },
  { command: 'blacklist', description: '🚫 Черный список компаний' },
  { command: 'filters', description: '🔍 Настроить фильтры поиска' },
  { command: 'resume', description: '📄 Загрузить резюме (PDF / текст)' },
  { command: 'limit', description: '🎯 Изменить дневной лимит откликов' },
  { command: 'llm', description: '🧠 Управление моделью LLM' },
  { command: 'logs', description: '🪵 Последние ошибки (JSONL)' },
  { command: 'export', description: '📊 Скачать отчет (Excel)' },
  { command: 'start', description: '🔑 Перезапуск / Вход в HH.ru' },
];

export function buildAutomationSettingsText(configStore: IConfigStore): string {
  const mode = configStore.getApprovalMode().data ?? 'auto';
  const minScore = configStore.getMinMatchScore().data ?? 70;
  const autoBump = configStore.isAutoBumpResumeEnabled().data ?? true;
  const answerQ = configStore.isAnswerQuestionsEnabled().data ?? true;
  const skipForeign = configStore.isSkipForeignVacanciesEnabled?.().data ?? true;

  return [
    '⚙️ <b>Настройки автоматизации и ИИ</b>',
    '',
    `<b>Режим одобрения откликов:</b> ${mode === 'manual' ? '🖐 Ручной (через карточки)' : '⚡ Автоматический (сразу в HH)'}`,
    `<b>Минимальный порог совпадения ИИ:</b> ${minScore}/100`,
    `<b>Автоподнятие резюме:</b> ${autoBump ? '🟢 Включено' : '⚪ Выключено'}`,
    `<b>Автоответы на анкеты работодателей:</b> ${answerQ ? '🟢 Включено' : '⚪ Выключено'}`,
    `<b>Пропуск вакансий в других странах:</b> ${skipForeign ? '🟢 Включено' : '⚪ Выключено'}`,
  ].join('\n');
}

export function buildAutomationSettingsKeyboard(configStore: IConfigStore): InlineKeyboard {
  const mode = configStore.getApprovalMode().data ?? 'auto';
  const minScore = configStore.getMinMatchScore().data ?? 70;
  const autoBump = configStore.isAutoBumpResumeEnabled().data ?? true;
  const answerQ = configStore.isAnswerQuestionsEnabled().data ?? true;
  const skipForeign = configStore.isSkipForeignVacanciesEnabled?.().data ?? true;

  return new InlineKeyboard()
    .text(`🎯 Мин. порог оценки ИИ (${minScore}/100)`, 'settings:min_score').row()
    .text(`⚙️ Режим: ${mode === 'manual' ? '🖐 Ручное одобрение' : '⚡ Полный автомат'}`, 'settings:toggle_approval_mode').row()
    .text(`⬆️ Автоподнятие резюме: ${autoBump ? '🟢 ВКЛ' : '⚪ ВЫКЛ'}`, 'settings:toggle_auto_bump').row()
    .text(`❓ Автоответы на анкеты: ${answerQ ? '🟢 ВКЛ' : '⚪ ВЫКЛ'}`, 'settings:toggle_answer_questions').row()
    .text(`🌍 Пропуск вакансий за рубежом: ${skipForeign ? '🟢 ВКЛ' : '⚪ ВЫКЛ'}`, 'settings:toggle_skip_foreign').row()
    .text('🔙 Главное меню', 'menu:back_to_main');
}

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const digitGroups = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const size = bytes / Math.pow(1024, digitGroups);
  return `${size.toFixed(2)} ${units[digitGroups]}`;
}

export function buildBlacklistText(configStore: IConfigStore): string {
  const result = configStore.listBlacklistedCompanies({ limit: 50, offset: 0 });
  const companies = result.data ?? [];
  const lines = ['🚫 <b>Черный список работодателей</b>', ''];

  if (companies.length === 0) {
    lines.push('Список пуст. Вакансии не блокируются по работодателю.');
  } else {
    for (let i = 0; i < companies.length; i++) {
      const item = companies[i]!;
      lines.push(`${i + 1}. ${escapeHtml(item.companyName)}`);
    }
  }

  return lines.join('\n');
}

export function buildBlacklistKeyboard(configStore: IConfigStore): InlineKeyboard {
  const result = configStore.listBlacklistedCompanies({ limit: 50, offset: 0 });
  const companies = result.data ?? [];
  const keyboard = new InlineKeyboard();

  for (const item of companies) {
    keyboard.text(`❌ Удалить: ${item.companyName}`, `bl:del:${item.id}`).row();
  }

  keyboard.text('➕ Добавить компанию', 'bl:add').row();
  keyboard.text('🔙 Главное меню', 'menu:back_to_main');

  return keyboard;
}

export function registerBlacklistHandlers(
  bot: Bot<BotContext>,
  configStore: IConfigStore,
  safeEditMessageText: (
    ctx: Context,
    text: string,
    other?: Parameters<Context['editMessageText']>[1]
  ) => Promise<void>
): void {
  bot.callbackQuery('menu:blacklist', async (ctx) => {
    await ctx.answerCallbackQuery();
    await safeEditMessageText(ctx, buildBlacklistText(configStore), {
      parse_mode: 'HTML',
      reply_markup: buildBlacklistKeyboard(configStore),
    });
  });

  bot.callbackQuery('bl:add', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter('addBlacklistWizard');
  });

  bot.callbackQuery(/^bl:del:(\d+)$/, async (ctx) => {
    const match = ctx.match as RegExpMatchArray;
    const id = Number.parseInt(match[1] ?? '-1', 10);
    configStore.removeBlacklistedCompany(id);
    await ctx.answerCallbackQuery('Компания удалена из ЧС');
    await safeEditMessageText(ctx, buildBlacklistText(configStore), {
      parse_mode: 'HTML',
      reply_markup: buildBlacklistKeyboard(configStore),
    });
  });
}

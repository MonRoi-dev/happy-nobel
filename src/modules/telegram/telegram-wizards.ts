import { createConversation, type Conversation, type ConversationFlavor } from '@grammyjs/conversations';
import { InlineKeyboard, type Context, type Bot } from 'grammy';
import { extractText, getDocumentProxy } from 'unpdf';
import type { AppDatabase } from '../../db/index.ts';
import { searchFilters, userProfiles } from '../../db/schema.ts';
import type { IConfigStore, SafeResult } from '../config-store/index.ts';
import type { ILlmService } from '../llm/index.ts';
import {
  buildBlacklistKeyboard,
  buildBlacklistText,
  escapeHtml,
  formatBytes,
} from './telegram-blacklist.ts';

export type BotContext = ConversationFlavor<Context>;
export type BotConversation = Conversation<BotContext, Context>;

export interface DailyLimitParseResult {
  readonly limit: number;
  readonly wasClampedUpper: boolean;
}

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const PDF_MAGIC_HEADER = '%PDF-';

export function parseAndClampDailyLimit(rawInput: string): SafeResult<DailyLimitParseResult> {
  const trimmed = rawInput.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return { data: null, error: 'Введите целое число от 1 до 100.' };
  }

  const numeric = Number.parseInt(trimmed, 10);
  if (Number.isNaN(numeric) || numeric < 1) {
    return { data: null, error: 'Лимит должен быть не меньше 1 отклика в сутки.' };
  }

  if (numeric > 100) {
    return {
      data: {
        limit: 100,
        wasClampedUpper: true,
      },
      error: null,
    };
  }

  return {
    data: {
      limit: numeric,
      wasClampedUpper: false,
    },
    error: null,
  };
}

export function parseAndClampMinMatchScore(rawInput: string): SafeResult<number> {
  const trimmed = rawInput.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return { data: null, error: 'Введите целое число от 0 до 100.' };
  }

  const numeric = Number.parseInt(trimmed, 10);
  if (Number.isNaN(numeric) || numeric < 0 || numeric > 100) {
    return { data: null, error: 'Порог совпадения должен быть от 0 до 100.' };
  }

  return {
    data: numeric,
    error: null,
  };
}

export async function extractPdfResumeText(buffer: Uint8Array): Promise<SafeResult<string>> {
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_UPLOAD_BYTES) {
    return {
      data: null,
      error: 'Размер PDF-файла превышает допустимый лимит (5 МБ) или файл пуст.',
    };
  }

  const headerAscii = new TextDecoder('ascii').decode(buffer.subarray(0, 5));
  if (headerAscii !== PDF_MAGIC_HEADER) {
    return {
      data: null,
      error: 'Файл не является корректным PDF-документом (неверная сигнатура).',
    };
  }

  try {
    const pdf = await getDocumentProxy(buffer);
    try {
      const { text } = await extractText(pdf, { mergePages: true });
      const cleaned = text.trim();
      if (cleaned.length < 10) {
        return { data: null, error: 'Не удалось извлечь текст из PDF-файла.' };
      }
      return { data: cleaned, error: null };
    } finally {
      await pdf.cleanup();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка чтения PDF';
    return { data: null, error: message };
  }
}

export async function buildLlmStatusText(llm: ILlmService): Promise<string> {
  const statusRes = await llm.inspectStatus();
  if (statusRes.error || !statusRes.data) {
    return [
      '🧠 <b>Панель управления LLM (Ollama)</b>',
      '',
      `❌ Ошибка проверки статуса: ${escapeHtml(statusRes.error ?? 'Unknown error')}`,
    ].join('\n');
  }

  const s = statusRes.data;
  const onlineStatus = s.isOnline
    ? `🟢 Доступен (${s.pingMs} мс)`
    : `🔴 Недоступен (${escapeHtml(s.error ?? 'Connection error')})`;

  let modelStatus = '🔴 Не найдена на сервере';
  if (s.isConfiguredModelLoaded) {
    const activeInfo = s.activeModels.find((m) =>
      m.name.toLowerCase().includes(s.configuredModel.toLowerCase())
    );
    const vram = activeInfo?.sizeVram ? ` [VRAM: ${formatBytes(activeInfo.sizeVram)}]` : '';
    modelStatus = `🟢 Загружена в память${vram}`;
  } else if (s.isConfiguredModelInstalled) {
    modelStatus = '🟡 Установлена (в режиме ожидания)';
  }

  const activeList = s.activeModels.map((m) => m.name).join(', ') || 'нет';
  const modeLabel =
    s.gamingMode === 'on'
      ? '🎮 Всегда NPU (ВКЛ)'
      : s.gamingMode === 'off'
        ? '🚀 Всегда GPU (ВЫКЛ)'
        : '⚡ Авто (по нагрузке 3D GPU)';
  const providerBadge =
    s.activeProvider === 'npu' ? '⚡ Intel NPU (OpenVINO)' : '🚀 Дискретная GPU (Ollama)';
  const gpuLoadStr =
    typeof s.gpu3dLoadPct === 'number'
      ? `${s.gpu3dLoadPct.toFixed(1)}% (VRAM: ${Math.round(s.vramUsedMb ?? 0)} МБ)`
      : 'н/д';

  return [
    '🧠 <b>Панель управления и статус LLM (Ollama / OpenVINO NPU)</b>',
    '',
    `<b>Игровой режим:</b> ${modeLabel}`,
    `<b>Активный движок:</b> ${providerBadge}`,
    `<b>Нагрузка 3D GPU:</b> ${escapeHtml(gpuLoadStr)}`,
    `<b>Хост (Base URL):</b> <code>${escapeHtml(s.baseUrl)}</code>`,
    `<b>Статус сервиса:</b> ${onlineStatus}`,
    `<b>Текущая модель:</b> <code>${escapeHtml(s.configuredModel)}</code>`,
    `<b>Статус модели:</b> ${modelStatus}`,
    `<b>Активно в VRAM:</b> ${escapeHtml(activeList)}`,
    `<b>Всего моделей на хосте:</b> ${s.installedModels.length}`,
  ].join('\n');
}

export function buildLlmStatusKeyboard(configStore?: IConfigStore): InlineKeyboard {
  const rawMode =
    configStore && typeof configStore.getGamingMode === 'function'
      ? (configStore.getGamingMode().data ?? 'auto')
      : (configStore?.get('GAMING_MODE').data ?? 'auto');
  const modeBtnLabel =
    rawMode === 'on'
      ? '🎮 Игровой режим: ВКЛ (NPU)'
      : rawMode === 'off'
        ? '🚀 Игровой режим: ВЫКЛ (GPU)'
        : '⚡ Игровой режим: АВТО (GPU/NPU)';

  return new InlineKeyboard()
    .text('🔄 Обновить статус', 'menu:llm_refresh').row()
    .text(modeBtnLabel, 'menu:llm_toggle_gaming_mode').row()
    .text('📋 Выбрать модель из списка', 'menu:llm_select_installed').row()
    .text('✍️ Ввести имя модели вручную', 'menu:llm_set_model_manual').row()
    .text('🌐 Настроить Base URL', 'menu:llm_set_base_url').row()
    .text('🔙 Главное меню', 'menu:back_to_main');
}

export async function buildModelPickerKeyboard(
  llm: ILlmService,
  configStore: IConfigStore
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const listRes = await llm.listAvailableModels();
  const kb = new InlineKeyboard();

  if (listRes.error || !listRes.data || listRes.data.length === 0) {
    kb.text('✍️ Ввести вручную', 'menu:llm_set_model_manual').row()
      .text('🔙 Назад в меню LLM', 'menu:llm_status');

    const message = listRes.error
      ? `❌ Не удалось получить список моделей: ${escapeHtml(listRes.error)}`
      : '⚠️ На сервере Ollama не найдено ни одной установленной модели.';

    return {
      text: `${message}\n\nВы можете ввести название модели вручную или настроить Base URL:`,
      keyboard: kb,
    };
  }

  const currentModel = configStore.get('LLM_MODEL_NAME').data ?? '';

  for (let i = 0; i < listRes.data.length; i++) {
    const item = listRes.data[i]!;
    const isSelected =
      item.name.toLowerCase() === currentModel.toLowerCase() ||
      `${item.name}:latest`.toLowerCase() === currentModel.toLowerCase() ||
      item.name.toLowerCase() === `${currentModel}:latest`.toLowerCase();
    const marker = isSelected ? '✅ ' : '';
    const label = `${marker}${item.name} (${formatBytes(item.size)})`;
    kb.text(label, `menu:llm_pick:${i}`).row();
  }

  kb.text('✍️ Ввести другое имя вручную', 'menu:llm_set_model_manual').row()
    .text('🔙 Назад в меню LLM', 'menu:llm_status');

  return {
    text: '📋 <b>Выберите модель из установленных на сервере Ollama:</b>',
    keyboard: kb,
  };
}

export interface WizardDeps {
  readonly bot: Bot<BotContext>;
  readonly configStore: IConfigStore;
  readonly db: AppDatabase;
  readonly buildMainMenuText: () => string;
  readonly buildMainMenuKeyboard: () => InlineKeyboard;
  readonly buildLlmStatusText: () => Promise<string>;
  readonly buildLlmStatusKeyboard: () => InlineKeyboard;
  readonly buildAutomationSettingsText: () => string;
  readonly buildAutomationSettingsKeyboard: () => InlineKeyboard;
  readonly onDailyLimitUpdated?: (newLimit: number) => Promise<void>;
}

export function createUploadResumeConversation(deps: WizardDeps) {
  return async (conversation: BotConversation, ctx: Context): Promise<void> => {
    await ctx.reply(
      '📄 Пришлите PDF-файл вашего резюме (до 5 МБ) или отправьте полный текст резюме обычным сообщением:'
    );

    const uploadCtx = await conversation.waitFor(['message:document', 'message:text']);
    let resumeRawText = '';
    let hhResumeTitle = 'Загруженное резюме';

    if (uploadCtx.message?.text) {
      resumeRawText = uploadCtx.message.text.trim();
    } else if (uploadCtx.message?.document) {
      const doc = uploadCtx.message.document;
      hhResumeTitle = doc.file_name ?? 'PDF Резюме';
      const fileSize = doc.file_size ?? 0;

      if (fileSize > MAX_UPLOAD_BYTES) {
        await ctx.reply('❌ Файл превышает допустимый размер 5 МБ.');
        return;
      }

      const extracted = await conversation.external(async () => {
        const fileInfo = await deps.bot.api.getFile(doc.file_id);
        if (!fileInfo.file_path) {
          return { data: null, error: 'Не удалось получить путь к файлу в Telegram.' };
        }
        const token = deps.configStore.get('TG_BOT_TOKEN').data ?? '';
        const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
        const response = await fetch(fileUrl);
        const arrayBuffer = await response.arrayBuffer();
        return extractPdfResumeText(new Uint8Array(arrayBuffer));
      });

      if (extracted.error || !extracted.data) {
        await ctx.reply(`❌ ${extracted.error ?? 'Не удалось прочитать PDF-файл.'}`);
        return;
      }

      resumeRawText = extracted.data;
    }

    if (resumeRawText.length < 10) {
      await ctx.reply('❌ Текст резюме слишком короткий.');
      return;
    }

    await ctx.reply(
      '✍️ Введите дополнительные пожелания к стилю сопроводительных писем (или отправьте <code>-</code>, чтобы пропустить):',
      { parse_mode: 'HTML' }
    );
    const rulesMsg = await conversation.waitFor('message:text');
    const customPromptRules = rulesMsg.message.text.trim() === '-' ? null : rulesMsg.message.text.trim();

    await conversation.external(() => {
      const current = deps.db.select().from(userProfiles).limit(1).get() ?? null;
      deps.db.delete(userProfiles).run();
      deps.db
        .insert(userProfiles)
        .values({
          hhResumeTitle: current?.hhResumeTitle ?? hhResumeTitle,
          resumeRawText,
          customPromptRules,
        })
        .run();
    });

    const menuText = await conversation.external(() => deps.buildMainMenuText());
    const menuKb = await conversation.external(() => deps.buildMainMenuKeyboard());

    await ctx.reply('✅ Резюме и пожелания к стилю успешно сохранены в базу!');
    await ctx.reply(menuText, {
      parse_mode: 'HTML',
      reply_markup: menuKb,
    });
  };
}

export function createSearchFiltersConversation(deps: WizardDeps) {
  return async (conversation: BotConversation, ctx: Context): Promise<void> => {
    await ctx.reply(
      '🔍 <b>Настройка фильтров поиска вакансий</b>\nВведите ключевые слова, должность и стек (например: <code>Node.js TypeScript Backend</code>):',
      { parse_mode: 'HTML' }
    );
    const queryMsg = await conversation.waitFor('message:text');
    const queryText = queryMsg.message.text.trim();

    await ctx.reply(
      'Введите слова-исключения через запятую (например: <code>PHP, 1C, Junior</code>) или <code>-</code>, чтобы пропустить:',
      { parse_mode: 'HTML' }
    );
    const excludedMsg = await conversation.waitFor('message:text');
    const excludedWords = excludedMsg.message.text.trim() === '-' ? null : excludedMsg.message.text.trim();

    await ctx.reply(
      'Введите код региона HH.ru (например: <code>113</code> — Россия, <code>1</code> — Москва, или <code>-</code> для поиска везде):',
      { parse_mode: 'HTML' }
    );
    const areaMsg = await conversation.waitFor('message:text');
    const areaId = areaMsg.message.text.trim() === '-' ? null : areaMsg.message.text.trim();

    await ctx.reply(
      'Введите график работы (<code>remote</code> — удаленная работа, <code>fullDay</code> — полный день, или <code>-</code> для любого):',
      { parse_mode: 'HTML' }
    );
    const scheduleMsg = await conversation.waitFor('message:text');
    const schedule = scheduleMsg.message.text.trim() === '-' ? null : scheduleMsg.message.text.trim();

    await ctx.reply(
      'Введите минимальную зарплату в рублях числом (например: <code>250000</code>) или <code>-</code>, чтобы не фильтровать:',
      { parse_mode: 'HTML' }
    );
    const salaryMsg = await conversation.waitFor('message:text');
    const rawSalary = salaryMsg.message.text.trim();
    const salaryFrom = /^\d+$/.test(rawSalary) ? Number.parseInt(rawSalary, 10) : null;

    await conversation.external(() => {
      deps.db.delete(searchFilters).run();
      deps.db
        .insert(searchFilters)
        .values({
          queryText,
          excludedWords,
          areaId,
          schedule,
          salaryFrom,
        })
        .run();
    });

    const menuText = await conversation.external(() => deps.buildMainMenuText());
    const menuKb = await conversation.external(() => deps.buildMainMenuKeyboard());

    await ctx.reply('✅ Фильтры поиска вакансий сохранены!');
    await ctx.reply(menuText, {
      parse_mode: 'HTML',
      reply_markup: menuKb,
    });
  };
}

export function createDailyLimitConversation(deps: WizardDeps) {
  return async (conversation: BotConversation, ctx: Context): Promise<void> => {
    const currentLimit = await conversation.external(() => deps.configStore.getDailyLimit().data ?? 50);
    await ctx.reply(
      `🎯 Введите новый дневной лимит откликов (число от 1 до 100).\nТекущий лимит: ${currentLimit}`
    );

    const responseCtx = await conversation.waitFor('message:text');
    const rawText = responseCtx.message.text;

    const parsed = parseAndClampDailyLimit(rawText);
    if (parsed.error || !parsed.data) {
      await ctx.reply(`❌ ${parsed.error ?? 'Некорректное число.'}`);
      return;
    }

    if (parsed.data.wasClampedUpper) {
      await ctx.reply(
        '⚠️ Введено значение больше 100. В целях защиты аккаунта от блокировки HH.ru установлено максимальное безопасное значение: 100.'
      );
    }

    await conversation.external(async () => {
      deps.configStore.setDailyLimit(parsed.data!.limit);
      if (deps.onDailyLimitUpdated) {
        await deps.onDailyLimitUpdated(parsed.data!.limit);
      }
    });

    const menuText = await conversation.external(() => deps.buildMainMenuText());
    const menuKb = await conversation.external(() => deps.buildMainMenuKeyboard());

    await ctx.reply(`✅ Дневной лимит установлен: ${parsed.data.limit} откликов в сутки.`);
    await ctx.reply(menuText, {
      parse_mode: 'HTML',
      reply_markup: menuKb,
    });
  };
}

export function createLlmBaseUrlConversation(deps: WizardDeps) {
  return async (conversation: BotConversation, ctx: Context): Promise<void> => {
    const currentUrl = await conversation.external(
      () => deps.configStore.get('LLM_BASE_URL').data ?? 'http://127.0.0.1:11434'
    );
    await ctx.reply(
      `🌐 <b>Настройка адреса Ollama (LLM_BASE_URL)</b>\n\nТекущий адрес: <code>${escapeHtml(currentUrl)}</code>\n\nВведите новый URL (например, <code>http://127.0.0.1:11434</code>) или отправьте <code>-</code> для отмены:`,
      { parse_mode: 'HTML' }
    );

    const msg = await conversation.waitFor('message:text');
    const text = msg.message.text.trim();

    if (text === '-' || text.toLowerCase() === 'cancel') {
      await ctx.reply('Отмена изменения адреса.');
      const statusText = await conversation.external(() => deps.buildLlmStatusText());
      const statusKb = await conversation.external(() => deps.buildLlmStatusKeyboard());
      await ctx.reply(statusText, { parse_mode: 'HTML', reply_markup: statusKb });
      return;
    }

    const saveRes = await conversation.external(() => deps.configStore.set('LLM_BASE_URL', text));
    if (saveRes.error || !saveRes.data) {
      await ctx.reply(`❌ Некорректный URL: ${saveRes.error ?? 'Invalid URL'}`);
      const statusText = await conversation.external(() => deps.buildLlmStatusText());
      const statusKb = await conversation.external(() => deps.buildLlmStatusKeyboard());
      await ctx.reply(statusText, { parse_mode: 'HTML', reply_markup: statusKb });
      return;
    }

    await ctx.reply(`✅ Адрес сохранен: <code>${escapeHtml(saveRes.data)}</code>\nПроверяю подключение...`, {
      parse_mode: 'HTML',
    });

    const statusText = await conversation.external(() => deps.buildLlmStatusText());
    const statusKb = await conversation.external(() => deps.buildLlmStatusKeyboard());
    await ctx.reply(statusText, { parse_mode: 'HTML', reply_markup: statusKb });
  };
}

export function createLlmModelManualConversation(deps: WizardDeps) {
  return async (conversation: BotConversation, ctx: Context): Promise<void> => {
    const currentModel = await conversation.external(
      () => deps.configStore.get('LLM_MODEL_NAME').data ?? 'gemma4:64k'
    );
    await ctx.reply(
      `✍️ <b>Указание модели LLM вручную</b>\n\nТекущая модель: <code>${escapeHtml(currentModel)}</code>\n\nВведите точное название модели (например, <code>gemma4-64k:latest</code>) или отправьте <code>-</code> для отмены:`,
      { parse_mode: 'HTML' }
    );

    const msg = await conversation.waitFor('message:text');
    const text = msg.message.text.trim();

    if (text === '-' || text.toLowerCase() === 'cancel') {
      await ctx.reply('Отмена ввода.');
      const statusText = await conversation.external(() => deps.buildLlmStatusText());
      const statusKb = await conversation.external(() => deps.buildLlmStatusKeyboard());
      await ctx.reply(statusText, { parse_mode: 'HTML', reply_markup: statusKb });
      return;
    }

    const saveRes = await conversation.external(() => deps.configStore.set('LLM_MODEL_NAME', text));
    if (saveRes.error || !saveRes.data) {
      await ctx.reply(`❌ Ошибка сохранения модели: ${saveRes.error ?? 'Invalid model'}`);
      const statusText = await conversation.external(() => deps.buildLlmStatusText());
      const statusKb = await conversation.external(() => deps.buildLlmStatusKeyboard());
      await ctx.reply(statusText, { parse_mode: 'HTML', reply_markup: statusKb });
      return;
    }

    await ctx.reply(`✅ Модель сохранена: <code>${escapeHtml(saveRes.data)}</code>\nПроверяю статус модели...`, {
      parse_mode: 'HTML',
    });

    const statusText = await conversation.external(() => deps.buildLlmStatusText());
    const statusKb = await conversation.external(() => deps.buildLlmStatusKeyboard());
    await ctx.reply(statusText, { parse_mode: 'HTML', reply_markup: statusKb });
  };
}

export function createMinMatchScoreConversation(deps: WizardDeps) {
  return async (conversation: BotConversation, ctx: Context): Promise<void> => {
    await ctx.reply(
      '🎯 Введите минимальный порог совпадения ИИ (MIN_MATCH_SCORE) от 0 до 100 (или отправьте <code>-</code> для отмены):',
      { parse_mode: 'HTML' }
    );

    const msg = await conversation.waitFor('message:text');
    const text = msg.message.text.trim();

    if (text === '-' || text.toLowerCase() === 'cancel') {
      await ctx.reply('Отмена изменения порога.');
      const settingsText = await conversation.external(() => deps.buildAutomationSettingsText());
      const settingsKb = await conversation.external(() => deps.buildAutomationSettingsKeyboard());
      await ctx.reply(settingsText, { parse_mode: 'HTML', reply_markup: settingsKb });
      return;
    }

    const parseRes = parseAndClampMinMatchScore(text);
    if (parseRes.error || parseRes.data === null) {
      await ctx.reply(`❌ ${parseRes.error ?? 'Некорректное значение.'}`);
      const settingsText = await conversation.external(() => deps.buildAutomationSettingsText());
      const settingsKb = await conversation.external(() => deps.buildAutomationSettingsKeyboard());
      await ctx.reply(settingsText, { parse_mode: 'HTML', reply_markup: settingsKb });
      return;
    }

    const score = parseRes.data;
    await conversation.external(() => deps.configStore.setMinMatchScore(score));

    await ctx.reply(`✅ Минимальный порог совпадения ИИ установлен: ${score}/100.`);
    const settingsText = await conversation.external(() => deps.buildAutomationSettingsText());
    const settingsKb = await conversation.external(() => deps.buildAutomationSettingsKeyboard());
    await ctx.reply(settingsText, { parse_mode: 'HTML', reply_markup: settingsKb });
  };
}

export function createAddBlacklistCompanyConversation(deps: WizardDeps) {
  return async (conversation: BotConversation, ctx: Context): Promise<void> => {
    await ctx.reply(
      '🚫 Введите название компании для добавления в черный список (или отправьте <code>-</code> для отмены):',
      { parse_mode: 'HTML' }
    );

    const msg = await conversation.waitFor('message:text');
    const text = msg.message.text.trim();

    if (text === '-' || text.toLowerCase() === 'cancel') {
      await ctx.reply('Отмена добавления компании.');
      const blText = await conversation.external(() => buildBlacklistText(deps.configStore));
      const blKb = await conversation.external(() => buildBlacklistKeyboard(deps.configStore));
      await ctx.reply(blText, { parse_mode: 'HTML', reply_markup: blKb });
      return;
    }

    const addRes = await conversation.external(() => deps.configStore.addBlacklistedCompany(text));
    if (addRes.error || !addRes.data) {
      await ctx.reply(`❌ ${addRes.error ?? 'Не удалось добавить компанию в черный список.'}`);
      const blText = await conversation.external(() => buildBlacklistText(deps.configStore));
      const blKb = await conversation.external(() => buildBlacklistKeyboard(deps.configStore));
      await ctx.reply(blText, { parse_mode: 'HTML', reply_markup: blKb });
      return;
    }

    await ctx.reply(`✅ Компания «${escapeHtml(addRes.data.companyName)}» добавлена в черный список!`, {
      parse_mode: 'HTML',
    });
    const blText = await conversation.external(() => buildBlacklistText(deps.configStore));
    const blKb = await conversation.external(() => buildBlacklistKeyboard(deps.configStore));
    await ctx.reply(blText, { parse_mode: 'HTML', reply_markup: blKb });
  };
}

export function registerWizardConversations(bot: Bot<BotContext>, deps: WizardDeps): void {
  bot.use(createConversation(createUploadResumeConversation(deps), { id: 'uploadResumeWizard' }));
  bot.use(createConversation(createSearchFiltersConversation(deps), { id: 'searchFiltersWizard' }));
  bot.use(createConversation(createDailyLimitConversation(deps), { id: 'dailyLimitWizard' }));
  bot.use(createConversation(createLlmBaseUrlConversation(deps), { id: 'llmBaseUrlWizard' }));
  bot.use(createConversation(createLlmModelManualConversation(deps), { id: 'llmModelManualWizard' }));
  bot.use(createConversation(createMinMatchScoreConversation(deps), { id: 'minMatchScoreWizard' }));
  bot.use(createConversation(createAddBlacklistCompanyConversation(deps), { id: 'addBlacklistWizard' }));
}

import fs from 'node:fs';
import { InlineKeyboard, InputFile, type Context, type Bot } from 'grammy';
import { createLogger } from '../../utils/logger.ts';
import type { SafeResult } from '../config-store/index.ts';
import type { CaptchaChallengeSnapshot, IHhBrowserCaptchaService } from '../hh-hybrid/index.ts';
import { escapeHtml } from './telegram-blacklist.ts';
import type { BotContext } from './telegram-wizards.ts';

const logger = createLogger('Telegram');

export function buildCaptchaAlertCaption(pageUrl: string): string {
  return [
    '⚠️ <b>HH.ru запросил прохождение капчи («Пройдите капчу»)!</b>',
    '',
    'Очередь автооткликов временно поставлена на паузу.',
    '',
    '✍️ <b>Вариант 1 (прямо в боте):</b> Просто отправьте ответным сообщением в этот чат текст с картинки капчи — бот сам введёт его в браузер и нажмёт «Отправить».',
    `🌐 <b>Вариант 2 (вручную):</b> Перейдите по <a href="${escapeHtml(pageUrl)}">ссылке на страницу</a>, решите капчу и нажмите кнопку подтверждения ниже.`,
  ].join('\n');
}

export function buildCaptchaAlertKeyboard(pageUrl: string): InlineKeyboard {
  return new InlineKeyboard()
    .url('🔗 Открыть страницу с капчей', pageUrl)
    .row()
    .text('🔄 Обновить капчу', 'captcha_reload')
    .row()
    .text('✅ Подтвердить прохождение капчи', 'captcha_resolved');
}

export async function sendCaptchaAlertToAdmin(
  bot: Bot<BotContext>,
  adminId: string,
  snapshot: CaptchaChallengeSnapshot
): Promise<SafeResult<boolean>> {
  const caption = buildCaptchaAlertCaption(snapshot.pageUrl);
  const keyboard = buildCaptchaAlertKeyboard(snapshot.pageUrl);

  let photoBuffer =
    snapshot.screenshotBuffer && snapshot.screenshotBuffer.length > 0
      ? snapshot.screenshotBuffer
      : undefined;
  if (!photoBuffer && snapshot.screenshotPath && fs.existsSync(snapshot.screenshotPath)) {
    try {
      photoBuffer = fs.readFileSync(snapshot.screenshotPath);
    } catch {
      photoBuffer = undefined;
    }
  }

  if (photoBuffer && photoBuffer.length > 0) {
    try {
      const file = new InputFile(photoBuffer, 'captcha.png');
      await bot.api.sendPhoto(adminId, file, {
        caption,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      return { data: true, error: null };
    } catch (photoErr) {
      logger.error('Не удалось отправить фото капчи через sendPhoto, переход на sendMessage', photoErr);
      try {
        await bot.api.sendMessage(adminId, caption, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
          link_preview_options: { is_disabled: true },
        });
        return { data: true, error: null };
      } catch (sendErr) {
        return {
          data: null,
          error: sendErr instanceof Error ? sendErr.message : String(sendErr),
        };
      }
    }
  }

  try {
    await bot.api.sendMessage(adminId, caption, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
    return { data: true, error: null };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function handleCaptchaResolvedCallback(
  captchaService: IHhBrowserCaptchaService,
  ctx: Context
): Promise<SafeResult<boolean>> {
  const res = await captchaService.verifyAndResumeCaptcha();
  if (res.error || !res.data) {
    await ctx.answerCallbackQuery({
      text: `❌ ${res.error ?? 'Капча еще не решена'}`,
      show_alert: true,
    }).catch(() => undefined);
    return { data: false, error: res.error ?? 'Captcha still active' };
  }

  await ctx.answerCallbackQuery({
    text: '✅ Капча подтверждена! Очередь возобновлена.',
  }).catch(() => undefined);

  await ctx.reply(
    '✅ <b>Прохождение капчи подтверждено!</b> Очередь автооткликов возобновлена.',
    { parse_mode: 'HTML' }
  ).catch(() => undefined);

  return { data: true, error: null };
}

export async function handleCaptchaTextReply(
  captchaText: string,
  captchaService: IHhBrowserCaptchaService,
  ctx: Context
): Promise<SafeResult<boolean>> {
  const res = await captchaService.submitCaptchaText(captchaText);
  if (res.error || !res.data) {
    if (!captchaService.isAwaitingCaptcha()) {
      await ctx.reply(
        '✅ <b>Капча успешно пройдена!</b> Очередь автооткликов возобновлена.',
        { parse_mode: 'HTML' }
      ).catch(() => undefined);
      return { data: true, error: null };
    }
    const errText = `❌ Не удалось пройти капчу текстом: ${res.error ?? 'неверный код'}. Попробуйте ввести текст ещё раз или решите по ссылке и нажмите «✅ Подтвердить прохождение капчи».`;
    const updatedSnap = captchaService.getActiveChallenge();
    if (
      updatedSnap?.screenshotBuffer &&
      typeof (ctx as { replyWithPhoto?: unknown }).replyWithPhoto === 'function'
    ) {
      await ctx
        .replyWithPhoto(new InputFile(updatedSnap.screenshotBuffer, 'captcha.png'), {
          caption: errText,
          reply_markup: buildCaptchaAlertKeyboard(updatedSnap.pageUrl),
        })
        .catch(async () => {
          await ctx.reply(errText).catch(() => undefined);
        });
    } else {
      await ctx.reply(errText).catch(() => undefined);
    }
    return { data: false, error: res.error ?? 'Captcha text rejected' };
  }

  await ctx.reply(
    '✅ <b>Капча успешно отправлена и принята!</b> Очередь автооткликов возобновлена.',
    { parse_mode: 'HTML' }
  ).catch(() => undefined);

  return { data: true, error: null };
}

export async function handleCaptchaReloadCallback(
  captchaService: IHhBrowserCaptchaService,
  ctx: Context
): Promise<SafeResult<CaptchaChallengeSnapshot>> {
  await ctx.answerCallbackQuery({
    text: '🔄 Обновляем капчу на HH.ru...',
  }).catch(() => undefined);

  const res = await captchaService.reloadCaptcha();
  if (res.error || !res.data) {
    const errMsg = `❌ Не удалось обновить капчу: ${res.error ?? 'неизвестная ошибка'}. Попробуйте решить по ссылке.`;
    await ctx.reply(errMsg).catch(() => undefined);
    return { data: null, error: res.error ?? 'Failed to reload captcha' };
  }

  const snap = res.data;
  const caption = buildCaptchaAlertCaption(snap.pageUrl);
  const keyboard = buildCaptchaAlertKeyboard(snap.pageUrl);

  let edited = false;
  if (
    snap.screenshotBuffer &&
    snap.screenshotBuffer.length > 0 &&
    typeof (ctx as { editMessageMedia?: unknown }).editMessageMedia === 'function'
  ) {
    try {
      await ctx.editMessageMedia(
        {
          type: 'photo',
          media: new InputFile(snap.screenshotBuffer, 'captcha.png'),
          caption,
          parse_mode: 'HTML',
        },
        {
          reply_markup: keyboard,
        }
      );
      edited = true;
    } catch {
      edited = false;
    }
  }

  if (!edited) {
    if (
      snap.screenshotBuffer &&
      snap.screenshotBuffer.length > 0 &&
      typeof (ctx as { replyWithPhoto?: unknown }).replyWithPhoto === 'function'
    ) {
      await ctx
        .replyWithPhoto(new InputFile(snap.screenshotBuffer, 'captcha.png'), {
          caption,
          parse_mode: 'HTML',
          reply_markup: keyboard,
        })
        .catch(async () => {
          await ctx.reply(caption, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => undefined);
        });
    } else {
      await ctx.reply(caption, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => undefined);
    }
  }

  return { data: snap, error: null };
}

export function registerCaptchaHandlers(
  bot: Bot<BotContext>,
  captchaService: IHhBrowserCaptchaService
): void {
  bot.callbackQuery('captcha_reload', async (ctx) => {
    await handleCaptchaReloadCallback(captchaService, ctx);
  });

  bot.callbackQuery('captcha_resolved', async (ctx) => {
    await handleCaptchaResolvedCallback(captchaService, ctx);
  });

  bot.on('message:text', async (ctx, next) => {
    if (
      captchaService.isAwaitingCaptcha() &&
      ctx.message?.text &&
      !ctx.message.text.startsWith('/')
    ) {
      await handleCaptchaTextReply(ctx.message.text, captchaService, ctx);
      return;
    }
    await next();
  });
}

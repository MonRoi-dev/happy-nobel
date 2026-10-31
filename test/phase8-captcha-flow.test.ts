import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { Bot, Context } from 'grammy';
import type { Page } from 'playwright';
import { createDatabaseContext } from '../src/db/index.ts';
import {
  FOREIGN_VACANCY_ERROR,
  HhVacancyApplyFsm,
  type ApplyWorkflowInput,
} from '../src/modules/hh-hybrid/hh-apply-fsm.ts';
import {
  HhBrowserCaptchaService,
  type IHhBrowserCaptchaService,
} from '../src/modules/hh-hybrid/hh-browser.service.ts';
import {
  CAPTCHA_REQUIRED_ERROR,
  HhCaptchaDetector,
  type CaptchaChallengeSnapshot,
} from '../src/modules/hh-hybrid/hh-captcha.detector.ts';
import { SqliteQueueService } from '../src/modules/queue/index.ts';
import {
  buildCaptchaAlertCaption,
  buildCaptchaAlertKeyboard,
  handleCaptchaReloadCallback,
  handleCaptchaResolvedCallback,
  handleCaptchaTextReply,
  registerCaptchaHandlers,
  sendCaptchaAlertToAdmin,
} from '../src/modules/telegram/telegram-captcha.handler.ts';
import type { BotContext } from '../src/modules/telegram/telegram-wizards.ts';

function createMockPage(overrides?: {
  url?: string;
  matchedSelectors?: string[];
  firstVisible?: boolean;
  onFill?: (val: string) => void;
  onClick?: () => void;
  screenshotBuffer?: Buffer;
}): Page {
  const matched = new Set(overrides?.matchedSelectors ?? []);
  const pageUrl = overrides?.url ?? 'https://hh.ru/vacancy/123456';

  return {
    url: () => pageUrl,
    goto: async () => {},
    locator: (selector: string) => {
      const isMatch = Array.from(matched).some((m) => selector.includes(m));
      return {
        count: async () => (isMatch ? 1 : 0),
        first: () => ({
          count: async () => (isMatch ? 1 : 0),
          isVisible: async () => (overrides?.firstVisible !== false ? isMatch : false),
          waitFor: async () => {},
          fill: async (val: string) => {
            overrides?.onFill?.(val);
          },
          click: async () => {
            overrides?.onClick?.();
          },
        }),
      };
    },
    screenshot: async () => overrides?.screenshotBuffer ?? Buffer.from('fake-screenshot-data'),
    waitForTimeout: async () => {},
  } as unknown as Page;
}

test('HhCaptchaDetector detects captcha challenges by selector', async () => {
  const detector = new HhCaptchaDetector();

  const negativePage = createMockPage({ matchedSelectors: [] });
  const negativeResult = await detector.detectCaptchaOnPage(negativePage);
  assert.equal(negativeResult.detected, false);
  assert.equal(negativeResult.pageUrl, 'https://hh.ru/vacancy/123456');

  const textPage = createMockPage({ matchedSelectors: ['text="Пройдите капчу"'] });
  const textResult = await detector.detectCaptchaOnPage(textPage, { captureSnapshot: false });
  assert.equal(textResult.detected, true);
  assert.equal(textResult.detectedSelector, 'text="Пройдите капчу"');

  const inputPage = createMockPage({
    matchedSelectors: ['input[placeholder*="Текст с картинки"]'],
  });
  const inputResult = await detector.detectCaptchaOnPage(inputPage, { captureSnapshot: false });
  assert.equal(inputResult.detected, true);

  const qaPage = createMockPage({ matchedSelectors: ['[data-qa*="captcha"]'] });
  const qaResult = await detector.detectCaptchaOnPage(qaPage, { captureSnapshot: false });
  assert.equal(qaResult.detected, true);

  const iframePage = createMockPage({ matchedSelectors: ['iframe[src*="captcha"]'] });
  const iframeResult = await detector.detectCaptchaOnPage(iframePage, { captureSnapshot: false });
  assert.equal(iframeResult.detected, true);
});

test('HhCaptchaDetector captures snapshot to buffer and disk', async () => {
  const detector = new HhCaptchaDetector();
  const testDir = path.resolve(process.cwd(), 'logs', 'test-snapshots');

  const page = createMockPage({
    matchedSelectors: ['[data-qa*="captcha"]'],
    screenshotBuffer: Buffer.from('mock-png-buffer'),
  });

  const result = await detector.detectCaptchaOnPage(page, {
    captureSnapshot: true,
    snapshotsDir: testDir,
  });

  assert.equal(result.detected, true);
  assert.ok(result.screenshotBuffer);
  assert.ok(result.screenshotPath);
  assert.ok(fs.existsSync(result.screenshotPath));

  if (result.screenshotPath && fs.existsSync(result.screenshotPath)) {
    fs.unlinkSync(result.screenshotPath);
  }
  if (fs.existsSync(testDir)) {
    fs.rmdirSync(testDir);
  }
});

test('HhCaptchaDetector submitCaptchaTextOnPage validates input and fills text', async () => {
  const detector = new HhCaptchaDetector();

  const pageEmpty = createMockPage();
  const emptyRes = await detector.submitCaptchaTextOnPage(pageEmpty, '   ');
  assert.equal(emptyRes.data, null);
  assert.equal(emptyRes.error, 'Текст капчи не может быть пустым');

  const pageNoInput = createMockPage({ matchedSelectors: [] });
  const noInputRes = await detector.submitCaptchaTextOnPage(pageNoInput, 'abcd');
  assert.equal(noInputRes.data, null);
  assert.equal(
    noInputRes.error,
    'Поле ввода капчи ("Текст с картинки") не найдено на странице'
  );

  let filledText = '';
  let buttonClicked = false;
  let modalActive = true;

  const dynamicPage = {
    url: () => 'https://hh.ru/vacancy/123456',
    locator: (selector: string) => {
      const isInput = selector.includes('Текст с картинки') || selector.includes('input');
      const isBtn = selector.includes('Отправить') || selector.includes('captcha-submit');
      const isCaptchaModal =
        selector.includes('Пройдите капчу') || selector.includes('[data-qa*="captcha"]');

      const matched = modalActive ? isInput || isBtn || isCaptchaModal : false;
      return {
        count: async () => (matched ? 1 : 0),
        first: () => ({
          count: async () => (matched ? 1 : 0),
          isVisible: async () => matched,
          waitFor: async () => {},
          fill: async (val: string) => {
            filledText = val;
          },
          click: async () => {
            buttonClicked = true;
            if (filledText === '5678') {
              modalActive = false;
            }
          },
        }),
      };
    },
    waitForTimeout: async () => {},
  } as unknown as Page;

  const persistentRes = await detector.submitCaptchaTextOnPage(dynamicPage, '1234');
  assert.equal(filledText, '1234');
  assert.equal(buttonClicked, true);
  assert.equal(persistentRes.data, false);
  assert.equal(persistentRes.error, 'Капча все еще отображается (возможно, неверный текст)');

  const successRes = await detector.submitCaptchaTextOnPage(dynamicPage, '5678');
  assert.equal(filledText, '5678');
  assert.equal(successRes.data, true);
  assert.equal(successRes.error, null);
});

test('HhCaptchaDetector submitCaptchaTextOnPage succeeds when modal disappears even if stale error was in DOM', async () => {
  const detector = new HhCaptchaDetector();

  let modalOpen = true;
  let evaluateCallCount = 0;

  const pageWithStaleError = {
    url: () => 'https://hh.ru/vacancy/138853868',
    locator: (selector: string) => {
      const isInput = selector.includes('Текст с картинки') || selector.includes('input');
      const isBtn = selector.includes('Отправить') || selector.includes('captcha-submit');
      const isCaptchaModal =
        selector.includes('Пройдите капчу') || selector.includes('[data-qa*="captcha"]');

      const matched = modalOpen ? isInput || isBtn || isCaptchaModal : false;
      return {
        count: async () => (matched ? 1 : 0),
        first: () => ({
          count: async () => (matched ? 1 : 0),
          isVisible: async () => matched,
          waitFor: async () => {},
          fill: async () => {},
          pressSequentially: async () => {},
          click: async () => {
            setTimeout(() => {
              modalOpen = false;
            }, 50);
          },
        }),
      };
    },
    evaluate: async () => {
      evaluateCallCount++;
      return 'Неверный текст. Пожалуйста, повторите попытку.';
    },
    screenshot: async () => Buffer.from('fake-shot'),
    waitForTimeout: async () => {
      await new Promise((r) => setTimeout(r, 60));
    },
  } as unknown as Page;

  const res = await detector.submitCaptchaTextOnPage(pageWithStaleError, 'очумел замками');
  assert.equal(res.data, true);
  assert.equal(res.error, null);
});

test('HhVacancyApplyFsm returns CAPTCHA_REQUIRED when captcha modal is detected on page', async () => {
  const fsm = new HhVacancyApplyFsm();

  const fakePage = {
    url: () => 'https://hh.ru/vacancy/123456',
    goto: async () => {},
    locator: (selector: string) => {
      const isCaptcha = selector.includes('Пройдите капчу') || selector.includes('[data-qa*="captcha"]');
      return {
        count: async () => (isCaptcha ? 1 : 0),
        first: () => ({
          count: async () => (isCaptcha ? 1 : 0),
          isVisible: async () => isCaptcha,
          waitFor: async () => {},
          fill: async () => {},
          click: async () => {},
        }),
      };
    },
    waitForTimeout: async () => {},
  } as unknown as Page;

  const result = await fsm.execute({
    page: fakePage,
    vacancyId: '123456',
    vacancyUrl: 'https://hh.ru/vacancy/123456',
  });

  assert.equal(result.data, null);
  assert.equal(result.error, CAPTCHA_REQUIRED_ERROR);
});

test('HhVacancyApplyFsm returns CAPTCHA_REQUIRED when captcha appears after dispatching application', async () => {
  let step = 0;
  const fsm = new HhVacancyApplyFsm();

  const fakePage = {
    url: () => 'https://hh.ru/vacancy/789',
    goto: async () => {
      step = 1;
    },
    locator: (selector: string) => {
      const isButton =
        selector.includes('vacancy-response-link-top') ||
        selector.includes('vacancy-response-link-bottom');
      const isAlreadyResponded = selector.includes('Вы откликнулись');
      const isCaptcha =
        step >= 2 &&
        (selector.includes('Пройдите капчу') || selector.includes('[data-qa*="captcha"]'));

      return {
        count: async () => (isButton || isCaptcha ? 1 : 0),
        first: () => ({
          count: async () => (isButton || isCaptcha ? 1 : 0),
          isVisible: async () => !isAlreadyResponded && (isButton || isCaptcha),
          waitFor: async () => {},
          click: async () => {
            if (isButton) {
              step = 2;
            }
          },
          fill: async () => {},
        }),
      };
    },
    waitForTimeout: async () => {},
  } as unknown as Page;

  const result = await fsm.execute({
    page: fakePage,
    vacancyId: '789',
    vacancyUrl: 'https://hh.ru/vacancy/789',
  });

  assert.equal(result.data, null);
  assert.equal(result.error, CAPTCHA_REQUIRED_ERROR);
});

test('HhBrowserCaptchaService coordinates pause, alert enqueue, and state checks', async () => {
  const ctx = createDatabaseContext(':memory:');
  try {
    const queue = new SqliteQueueService(ctx.db, ctx.sqlite);

    const applyTaskRes = queue.enqueue({
      taskType: 'APPLY_VACANCY',
      payload: { vacancyId: 'v-101' },
    });
    assert.ok(applyTaskRes.data);
    const claimed = queue.claimNextPending();
    assert.equal(claimed.data?.id, applyTaskRes.data.id);
    assert.equal(claimed.data?.status, 'processing');

    let notifiedSnapshot: CaptchaChallengeSnapshot | null = null;
    const service = new HhBrowserCaptchaService({
      queueService: queue,
      onNotifyCaptcha: async (snap) => {
        notifiedSnapshot = snap;
        return { data: true, error: null };
      },
    });

    assert.equal(service.isAwaitingCaptcha(), false);
    assert.equal(service.getActiveChallenge(), null);

    const challenge: CaptchaChallengeSnapshot = {
      detected: true,
      pageUrl: 'https://hh.ru/vacancy/v-101',
      screenshotPath: '/tmp/test.png',
    };

    const handleRes = await service.handleCaptchaDetected(challenge, claimed.data.id);
    assert.equal(handleRes.data, true);
    assert.equal(service.isAwaitingCaptcha(), true);
    assert.deepEqual(service.getActiveChallenge(), challenge);
    assert.deepEqual(notifiedSnapshot, challenge);

    const pausedTask = queue.getTaskById(claimed.data.id);
    assert.equal(pausedTask?.status, 'paused_captcha');
    assert.equal(queue.hasPausedCaptchaTask(), true);

    const alertTask = queue.claimNextPending();
    assert.ok(alertTask.data);
    assert.equal(alertTask.data.taskType, 'SEND_TG_MESSAGE');
    assert.equal(alertTask.data.priority, 10);
    const alertPayload = JSON.parse(alertTask.data.payloadJson);
    assert.equal(alertPayload.kind, 'CAPTCHA_ALERT');
    assert.equal(alertPayload.pageUrl, 'https://hh.ru/vacancy/v-101');
  } finally {
    ctx.close();
  }
});

test('Variant 1: Telegram text reply resolution flow resumes paused tasks', async () => {
  const ctx = createDatabaseContext(':memory:');
  try {
    const queue = new SqliteQueueService(ctx.db, ctx.sqlite);

    const applyTask = queue.enqueue({
      taskType: 'APPLY_VACANCY',
      payload: { vacancyId: 'v-202' },
    }).data!;
    queue.claimNextPending();

    let solvedText = '';
    const service = new HhBrowserCaptchaService({
      queueService: queue,
      captchaSolverRunner: async (text, pageUrl) => {
        solvedText = text;
        assert.equal(pageUrl, 'https://hh.ru/vacancy/v-202');
        if (text === 'wrong') {
          return { data: false, error: 'Incorrect code' };
        }
        return { data: true, error: null };
      },
    });

    await service.handleCaptchaDetected(
      { detected: true, pageUrl: 'https://hh.ru/vacancy/v-202' },
      applyTask.id
    );
    assert.equal(service.isAwaitingCaptcha(), true);

    const repliedMessages: string[] = [];
    const mockCtx = {
      reply: async (text: string) => {
        repliedMessages.push(text);
      },
    } as unknown as Context;

    const failRes = await handleCaptchaTextReply('wrong', service, mockCtx);
    assert.equal(failRes.data, false);
    assert.equal(service.isAwaitingCaptcha(), true);
    assert.ok(repliedMessages[0].includes('Не удалось пройти капчу текстом'));
    assert.equal(queue.getTaskById(applyTask.id)?.status, 'paused_captcha');

    const successRes = await handleCaptchaTextReply('x7k9m', service, mockCtx);
    assert.equal(successRes.data, true);
    assert.equal(solvedText, 'x7k9m');
    assert.equal(service.isAwaitingCaptcha(), false);
    assert.ok(repliedMessages[1].includes('Капча успешно отправлена и принята'));
    assert.equal(queue.getTaskById(applyTask.id)?.status, 'pending');
  } finally {
    ctx.close();
  }
});

test('Variant 2: Inline button callback resolution flow resumes paused tasks', async () => {
  const ctx = createDatabaseContext(':memory:');
  try {
    const queue = new SqliteQueueService(ctx.db, ctx.sqlite);

    const applyTask = queue.enqueue({
      taskType: 'APPLY_VACANCY',
      payload: { vacancyId: 'v-303' },
    }).data!;
    queue.claimNextPending();

    let verifierShouldPass = false;
    const service = new HhBrowserCaptchaService({
      queueService: queue,
      captchaVerifierRunner: async (pageUrl) => {
        assert.equal(pageUrl, 'https://hh.ru/vacancy/v-303');
        if (!verifierShouldPass) {
          return { data: false, error: 'Modal still visible' };
        }
        return { data: true, error: null };
      },
    });

    await service.handleCaptchaDetected(
      { detected: true, pageUrl: 'https://hh.ru/vacancy/v-303' },
      applyTask.id
    );
    assert.equal(service.isAwaitingCaptcha(), true);

    const callbackAnswers: Array<{ text?: string; show_alert?: boolean }> = [];
    const repliedMessages: string[] = [];
    const mockCtx = {
      answerCallbackQuery: async (params: { text?: string; show_alert?: boolean }) => {
        callbackAnswers.push(params);
      },
      reply: async (text: string) => {
        repliedMessages.push(text);
      },
    } as unknown as Context;

    const failRes = await handleCaptchaResolvedCallback(service, mockCtx);
    assert.equal(failRes.data, false);
    assert.equal(service.isAwaitingCaptcha(), true);
    assert.equal(callbackAnswers[0].show_alert, true);
    assert.ok(callbackAnswers[0].text?.includes('Modal still visible'));
    assert.equal(queue.getTaskById(applyTask.id)?.status, 'paused_captcha');

    verifierShouldPass = true;
    const successRes = await handleCaptchaResolvedCallback(service, mockCtx);
    assert.equal(successRes.data, true);
    assert.equal(service.isAwaitingCaptcha(), false);
    assert.ok(callbackAnswers[1].text?.includes('Капча подтверждена'));
    assert.ok(repliedMessages[0].includes('Прохождение капчи подтверждено'));
    assert.equal(queue.getTaskById(applyTask.id)?.status, 'pending');
  } finally {
    ctx.close();
  }
});

test('Telegram captcha helper formatting, photo sending, and middleware registration', async () => {
  const caption = buildCaptchaAlertCaption('https://hh.ru/account/captcha?id=42&foo=bar');
  assert.ok(caption.includes('Пройдите капчу'));
  assert.ok(caption.includes('https://hh.ru/account/captcha?id=42&amp;foo=bar'));
  assert.ok(caption.includes('Вариант 1'));
  assert.ok(caption.includes('Вариант 2'));

  const keyboard = buildCaptchaAlertKeyboard('https://hh.ru/account/captcha');
  assert.ok(keyboard.inline_keyboard.length >= 3);
  assert.equal(keyboard.inline_keyboard[0][0].text, '🔗 Открыть страницу с капчей');
  assert.equal(keyboard.inline_keyboard[1][0].callback_data, 'captcha_reload');
  assert.equal(keyboard.inline_keyboard[2][0].callback_data, 'captcha_resolved');

  let sentPhotoChatId = '';
  let sentMessageChatId = '';
  const mockBot = {
    api: {
      sendPhoto: async (chatId: string) => {
        sentPhotoChatId = chatId;
      },
      sendMessage: async (chatId: string) => {
        sentMessageChatId = chatId;
      },
    },
    callbackQuery: (pattern: string, fn: (ctx: Context) => Promise<void>) => {
      registeredCallbacks.set(pattern, fn);
    },
    on: (filter: string, fn: (ctx: Context, next: () => Promise<void>) => Promise<void>) => {
      registeredMiddlewares.push({ filter, fn });
    },
  } as unknown as Bot<BotContext>;

  const registeredCallbacks = new Map<string, (ctx: Context) => Promise<void>>();
  const registeredMiddlewares: Array<{
    filter: string;
    fn: (ctx: Context, next: () => Promise<void>) => Promise<void>;
  }> = [];

  const photoSnap: CaptchaChallengeSnapshot = {
    detected: true,
    pageUrl: 'https://hh.ru/captcha',
    screenshotBuffer: Buffer.from('test-photo-data'),
  };

  const photoSendRes = await sendCaptchaAlertToAdmin(mockBot, '12345', photoSnap);
  assert.equal(photoSendRes.data, true);
  assert.equal(sentPhotoChatId, '12345');

  const textSnap: CaptchaChallengeSnapshot = {
    detected: true,
    pageUrl: 'https://hh.ru/captcha-no-pic',
  };
  const textSendRes = await sendCaptchaAlertToAdmin(mockBot, '67890', textSnap);
  assert.equal(textSendRes.data, true);
  assert.equal(sentMessageChatId, '67890');

  const service = new HhBrowserCaptchaService();
  registerCaptchaHandlers(mockBot, service);
  assert.ok(registeredCallbacks.has('captcha_reload'));
  assert.ok(registeredCallbacks.has('captcha_resolved'));
  assert.equal(registeredMiddlewares.length, 1);
  assert.equal(registeredMiddlewares[0].filter, 'message:text');

  let nextCalled = false;
  const dummyCtx = {
    message: { text: 'random message' },
  } as unknown as Context;
  await registeredMiddlewares[0].fn(dummyCtx, async () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);

  service.setActiveChallenge({ detected: true, pageUrl: 'https://hh.ru/captcha' });
  nextCalled = false;
  const commandCtx = {
    message: { text: '/start' },
  } as unknown as Context;
  await registeredMiddlewares[0].fn(commandCtx, async () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test('Regression 136591983 & 138659018: detects captcha after relocation confirm and after cover letter modal submit without double-clicking submit popup', async () => {
  const fsmReloc = new HhVacancyApplyFsm();
  let relocStep = 0;

  const relocPage = {
    url: () => 'https://krasnodar.hh.ru/vacancy/136591983',
    goto: async () => {
      relocStep = 1;
    },
    locator: (selector: string) => {
      const isTopBtn = selector.includes('vacancy-response-link-top') && !selector.includes('Вы откликнулись');
      const isRelocBtn = selector.includes('relocation-warning-confirm');
      const isCaptcha =
        relocStep >= 3 &&
        (selector.includes('account-captcha-picture') || selector.includes('Пройдите капчу'));

      const matched =
        (relocStep === 1 && isTopBtn) ||
        (relocStep === 2 && isRelocBtn) ||
        isCaptcha;

      return {
        count: async () => (matched ? 1 : 0),
        first: () => ({
          count: async () => (matched ? 1 : 0),
          isVisible: async () => matched,
          waitFor: async () => {},
          click: async () => {
            if (isTopBtn) relocStep = 2;
            if (isRelocBtn) relocStep = 3;
          },
          fill: async () => {},
        }),
      };
    },
    waitForTimeout: async () => {},
  } as unknown as Page;

  const relocRes = await fsmReloc.execute({
    page: relocPage,
    vacancyId: '136591983',
    vacancyUrl: 'https://hh.ru/vacancy/136591983',
    coverLetter: 'Cover letter text',
  });
  assert.equal(relocRes.data, null);
  assert.equal(relocRes.error, CAPTCHA_REQUIRED_ERROR);

  const fsmModal = new HhVacancyApplyFsm();
  let modalStep = 0;
  let popupSubmitClicks = 0;

  const modalPage = {
    url: () => 'https://krasnodar.hh.ru/vacancy/138659018',
    goto: async () => {
      modalStep = 1;
    },
    locator: (selector: string) => {
      const isTopBtn = selector.includes('vacancy-response-link-top') && !selector.includes('Вы откликнулись');
      const isRelocBtn = selector.includes('relocation-warning-confirm');
      const isHiddenWarn = selector === '[data-qa="hidden-resume-warning"]';
      const isLetterInput = selector.includes('vacancy-response-popup-form-letter-input');
      const isPopupSubmit = selector.includes('vacancy-response-submit-popup');
      const isCaptcha =
        modalStep >= 4 &&
        (selector.includes('account-captcha-picture') || selector.includes('Пройдите капчу'));

      const matched =
        (modalStep === 1 && isTopBtn) ||
        (modalStep === 2 && isRelocBtn) ||
        (modalStep >= 3 && (isHiddenWarn || isLetterInput || isPopupSubmit)) ||
        isCaptcha;

      return {
        count: async () => (matched ? 1 : 0),
        first: () => ({
          count: async () => (matched ? 1 : 0),
          isVisible: async () => matched,
          boundingBox: async () => (isHiddenWarn ? { x: 0, y: 0, width: 572, height: 0 } : { x: 0, y: 0, width: 100, height: 40 }),
          waitFor: async () => {},
          click: async () => {
            if (isTopBtn) modalStep = 2;
            else if (isRelocBtn) modalStep = 3;
            else if (isPopupSubmit) {
              popupSubmitClicks += 1;
              if (popupSubmitClicks > 1) {
                throw new Error('modal-overlay intercepts pointer events');
              }
              modalStep = 4;
            }
          },
          fill: async () => {},
        }),
      };
    },
    waitForTimeout: async () => {},
  } as unknown as Page;

  const modalRes = await fsmModal.execute({
    page: modalPage,
    vacancyId: '138659018',
    vacancyUrl: 'https://hh.ru/vacancy/138659018',
    coverLetter: 'Hello Кибер Лид!',
  });
  assert.equal(popupSubmitClicks, 1);
  assert.equal(modalRes.data, null);
  assert.equal(modalRes.error, CAPTCHA_REQUIRED_ERROR);
});

test('HhCaptchaDetector.reloadCaptchaOnPage clicks reload button and returns refreshed snapshot', async () => {
  const detector = new HhCaptchaDetector();
  let reloadClicked = false;

  const mockPage = {
    url: () => 'https://hh.ru/vacancy/123456',
    locator: (selector: string) => {
      const isReload =
        selector.includes('account-captcha-refresh') || selector.includes('refresh') || selector.includes('reload');
      const isCaptcha = selector.includes('account-captcha-picture') || selector.includes('Пройдите капчу');
      const matched = isReload || isCaptcha;

      return {
        count: async () => (matched ? 1 : 0),
        first: () => ({
          count: async () => (matched ? 1 : 0),
          isVisible: async () => matched,
          waitFor: async () => {},
          click: async () => {
            if (isReload) reloadClicked = true;
          },
          fill: async () => {},
        }),
      };
    },
    evaluate: async () => true,
    screenshot: async () => Buffer.from('reloaded-snapshot'),
    waitForTimeout: async () => {},
  } as unknown as Page;

  const res = await detector.reloadCaptchaOnPage(mockPage);
  assert.equal(reloadClicked, true);
  assert.equal(res.error, null);
  assert.ok(res.data);
  assert.equal(res.data.detected, true);
  assert.deepEqual(res.data.screenshotBuffer, Buffer.from('reloaded-snapshot'));
});

test('HhBrowserCaptchaService.reloadCaptcha coordinates reload and updates activeChallenge', async () => {
  let reloadedCount = 0;
  const service = new HhBrowserCaptchaService({
    captchaReloaderRunner: async (pageUrl) => {
      reloadedCount += 1;
      return {
        data: {
          detected: true,
          pageUrl,
          screenshotBuffer: Buffer.from(`new-buffer-${reloadedCount}`),
        },
        error: null,
      };
    },
  });

  const noChallengeRes = await service.reloadCaptcha();
  assert.equal(noChallengeRes.data, null);
  assert.equal(noChallengeRes.error, 'Активное требование капчи не найдено');

  service.setActiveChallenge({
    detected: true,
    pageUrl: 'https://hh.ru/vacancy/123',
    screenshotBuffer: Buffer.from('old-buffer'),
  });

  const reloadRes = await service.reloadCaptcha();
  assert.equal(reloadRes.error, null);
  assert.ok(reloadRes.data);
  assert.equal(reloadedCount, 1);
  assert.deepEqual(service.getActiveChallenge()?.screenshotBuffer, Buffer.from('new-buffer-1'));
});

test('handleCaptchaReloadCallback responds to user and edits message media with new captcha photo', async () => {
  const service = new HhBrowserCaptchaService({
    captchaReloaderRunner: async (pageUrl) => ({
      data: {
        detected: true,
        pageUrl,
        screenshotBuffer: Buffer.from('fresh-captcha-image'),
      },
      error: null,
    }),
  });

  service.setActiveChallenge({
    detected: true,
    pageUrl: 'https://hh.ru/account/captcha',
    screenshotBuffer: Buffer.from('stale-captcha-image'),
  });

  let callbackAnswered = false;
  let editedMedia: unknown = null;
  const mockCtx = {
    answerCallbackQuery: async () => {
      callbackAnswered = true;
    },
    editMessageMedia: async (media: unknown) => {
      editedMedia = media;
    },
    reply: async () => {},
  } as unknown as Context;

  const res = await handleCaptchaReloadCallback(service, mockCtx);
  assert.equal(callbackAnswered, true);
  assert.equal(res.error, null);
  assert.ok(res.data);
  assert.ok(editedMedia);
  assert.equal((editedMedia as { type: string }).type, 'photo');
});

test('HhVacancyApplyFsm skips foreign country vacancy when skipForeignVacancies is enabled', async () => {
  const fsm = new HhVacancyApplyFsm();
  let relocConfirmClicked = false;
  let topBtnClicked = false;

  const foreignPage = {
    url: () => 'https://hh.ru/vacancy/999999',
    goto: async () => {},
    evaluate: async () => true,
    locator: (selector: string) => {
      const isTopBtn = selector.includes('vacancy-response-link-top') && !selector.includes('Вы откликнулись');
      const isRelocBtn = selector.includes('relocation-warning-confirm');
      const isForeignText = selector.includes('другой стране') || selector.includes('другая страна');

      const matched =
        (!topBtnClicked && isTopBtn) ||
        (topBtnClicked && isRelocBtn) ||
        (topBtnClicked && isForeignText);

      return {
        count: async () => (matched ? 1 : 0),
        first: () => ({
          count: async () => (matched ? 1 : 0),
          isVisible: async () => matched,
          waitFor: async () => {},
          click: async () => {
            if (isTopBtn) topBtnClicked = true;
            if (isRelocBtn) relocConfirmClicked = true;
          },
          fill: async () => {},
        }),
      };
    },
    waitForTimeout: async () => {},
  } as unknown as Page;

  const result = await fsm.execute({
    page: foreignPage,
    vacancyId: '999999',
    vacancyUrl: 'https://hh.ru/vacancy/999999',
    skipForeignVacancies: true,
  });

  assert.equal(result.data, null);
  assert.equal(result.error, FOREIGN_VACANCY_ERROR);
  assert.equal(relocConfirmClicked, false);
});

test('HhVacancyApplyFsm confirms foreign country vacancy when skipForeignVacancies is false', async () => {
  const fsm = new HhVacancyApplyFsm();
  let relocConfirmClicked = false;
  let topBtnClicked = false;

  const foreignPage = {
    url: () => 'https://hh.ru/vacancy/888888',
    goto: async () => {},
    evaluate: async () => false,
    locator: (selector: string) => {
      const isTopBtn = selector.includes('vacancy-response-link-top') && !selector.includes('Вы откликнулись');
      const isRelocBtn = selector.includes('relocation-warning-confirm');
      const isSuccess = relocConfirmClicked && selector.includes('Вы откликнулись');

      const matched =
        (!topBtnClicked && isTopBtn) ||
        (topBtnClicked && !relocConfirmClicked && isRelocBtn) ||
        isSuccess;

      return {
        count: async () => (matched ? 1 : 0),
        first: () => ({
          count: async () => (matched ? 1 : 0),
          isVisible: async () => matched,
          waitFor: async () => {},
          click: async () => {
            if (isTopBtn) topBtnClicked = true;
            if (isRelocBtn) relocConfirmClicked = true;
          },
          fill: async () => {},
        }),
      };
    },
    waitForTimeout: async () => {},
  } as unknown as Page;

  const result = await fsm.execute({
    page: foreignPage,
    vacancyId: '888888',
    vacancyUrl: 'https://hh.ru/vacancy/888888',
    skipForeignVacancies: false,
  });

  assert.equal(relocConfirmClicked, true);
  assert.equal(result.error, null);
  assert.ok(result.data);
  assert.equal(result.data.applied, true);
});

import type { Frame, Page } from 'playwright';
import { createLogger } from '../../utils/logger.ts';
import type { SafeResult } from '../config-store/index.ts';
import type { EmployerQuestionAnswer, EmployerQuestionItem } from '../llm/index.ts';

const logger = createLogger('HhApplyQuestions');

export async function attachCoverLetterViaChatOnPage(
  page: Page,
  vacancyId: string,
  coverLetter: string,
  webBaseUrl: string,
  requireUnattachedAction = false
): Promise<boolean> {
  try {
    logger.info(`[HhHybrid] Попытка отправки сопроводительного письма через чат для вакансии ${vacancyId}...`);

    const viewTopicBtn = page.locator('[data-qa="vacancy-response-link-view-topic"]').first();
    let hasChatOnPage = (await viewTopicBtn.count().catch(() => 0)) > 0;
    if (!hasChatOnPage) {
      hasChatOnPage = await viewTopicBtn.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    }

    if (hasChatOnPage) {
      logger.info(`[HhHybrid] Кнопка чата найдена на странице вакансии ${vacancyId}. Открытие чата...`);
      await viewTopicBtn.click().catch(() => undefined);
      const sentOnPage = await waitForChatAndSendLetterOnPage(
        page,
        coverLetter,
        requireUnattachedAction
      );
      if (sentOnPage) {
        logger.info(`[HhHybrid] Сопроводительное письмо успешно отправлено со страницы вакансии ${vacancyId}.`);
        return true;
      }
      if (requireUnattachedAction) {
        return false;
      }
    }

    logger.info(`[HhHybrid] Переход в /applicant/negotiations для отправки письма к вакансии ${vacancyId}...`);
    await page.goto(`${webBaseUrl}/applicant/negotiations`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const rowByVacancy = page
      .locator('[data-qa="negotiations-item"]')
      .filter({ has: page.locator(`a[href*="/vacancy/${vacancyId}"]`) })
      .first();

    let targetRow = (await rowByVacancy.count().catch(() => 0)) > 0 ? rowByVacancy : null;
    if (!targetRow) {
      const firstRow = page.locator('[data-qa="negotiations-item"]').first();
      if ((await firstRow.count().catch(() => 0)) > 0) {
        targetRow = firstRow;
      }
    }

    if (!targetRow) {
      logger.warn(`[HhHybrid] Не найден элемент отклика в /applicant/negotiations для вакансии ${vacancyId}.`);
      return false;
    }

    const openChatBtn = targetRow
      .locator('[data-qa="open_chat"], a:has-text("Перейти в чат"), [data-qa="vacancy-response-link-view-topic"]')
      .first();

    const openChatReady = await openChatBtn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    if (!openChatReady) {
      logger.warn(`[HhHybrid] Кнопка чата в строке отклика не найдена.`);
      return false;
    }

    await openChatBtn.click().catch(() => undefined);
    const sentInNegotiations = await waitForChatAndSendLetterOnPage(
      page,
      coverLetter,
      requireUnattachedAction
    );
    if (sentInNegotiations) {
      logger.info(`[HhHybrid] Сопроводительное письмо успешно отправлено через чат в /applicant/negotiations.`);
      return true;
    }

    return false;
  } catch (err) {
    logger.warn(`[HhHybrid] Ошибка отправки сопроводительного письма через чат: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function waitForChatAndSendLetterOnPage(
  page: Page,
  coverLetter: string,
  requireUnattachedAction = false
): Promise<boolean> {
  try {
    let chatFrame: Frame | null = null;
    const startWait = Date.now();
    while (Date.now() - startWait < 12000) {
      const found = page.frames().find((f) => f.url().includes('chatik.hh.ru'));
      if (found) {
        chatFrame = found;
        break;
      }
      await page.waitForTimeout(500);
    }

    if (!chatFrame) {
      logger.warn(`[HhHybrid] Фрейм chatik.hh.ru не обнаружен за 12 секунд.`);
      return false;
    }

    const addCoverBtn = chatFrame
      .locator(
        '[data-qa="chatik-chat-message-applicant-action"], button:has-text("Добавить сопроводительное")'
      )
      .first();
    const addCoverVisible = await addCoverBtn.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    if (addCoverVisible) {
      logger.info(`[HhHybrid] Нажата кнопка "Добавить сопроводительное" в чате.`);
      await addCoverBtn.click().catch(() => undefined);
      await page.waitForTimeout(600);
    } else if (requireUnattachedAction) {
      return false;
    }

    const input = chatFrame.locator('textarea[data-qa="text-input"]').first();
    const inputReady = await input.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
    if (!inputReady) {
      logger.warn(`[HhHybrid] Поле textarea[data-qa="text-input"] не появилось в чате.`);
      return false;
    }

    await input.focus().catch(() => undefined);
    await input.fill(coverLetter);
    await page.waitForTimeout(600);

    const sendBtn = chatFrame.locator('[data-qa="chatik-do-send-message"]').first();
    const sendVisible = await sendBtn.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
    if (sendVisible) {
      await sendBtn.click().catch(() => undefined);
    } else {
      await input.press('Enter').catch(() => undefined);
    }
    await page.waitForTimeout(2000);

    let inputVal = await input.inputValue().catch(() => '');
    if (inputVal.length > 0) {
      const sendStillVisible = await sendBtn.isVisible().catch(() => false);
      if (sendStillVisible) {
        await sendBtn.click().catch(() => undefined);
      } else {
        await input.press('Enter').catch(() => undefined);
      }
      await page.waitForTimeout(2000);
      inputVal = await input.inputValue().catch(() => '');
    }

    if (inputVal.length > 0) {
      logger.warn('[HhHybrid] Поле ввода в чате не очистилось после отправки.');
      return false;
    }

    await addCoverBtn.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => undefined);
    return true;
  } catch (err) {
    logger.warn(`[HhHybrid] Ошибка во фрейме chatik: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function scrapeEmployerQuestionsOnPage(page: Page): Promise<EmployerQuestionItem[]> {
  if (typeof page.evaluate === 'function') {
    try {
      const evaluated = await page.evaluate(() => {
        const normalize = (val: string | null | undefined): string =>
          (val ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

        const items: Array<{
          id: string;
          questionText: string;
          fieldType: 'text' | 'textarea' | 'radio' | 'checkbox';
          options?: string[];
        }> = [];

        const containers = Array.from(
          document.querySelectorAll(
            '[data-qa="task-body"], [data-qa="vacancy-response-popup-questions"] [data-qa="task-question"], form [data-qa*="task"]'
          )
        );

        if (containers.length > 0) {
          containers.forEach((container, idx) => {
            const titleEl = container.querySelector(
              '[data-qa="task-question-title"], [data-qa="task-text"], .bloko-header-3, legend, label'
            );
            const questionText = normalize(titleEl?.textContent) || `Question ${idx + 1}`;

            const extractOpts = (els: Element[]) =>
              els
                .map((r) => normalize((r.closest('label') ?? document.querySelector(`label[for="${r.id}"]`))?.textContent || r.getAttribute('value')))
                .filter((opt): opt is string => opt.length > 0);

            const textarea = container.querySelector('textarea');
            if (textarea) {
              items.push({ id: textarea.getAttribute('name') || textarea.id || `task_${idx}`, questionText, fieldType: 'textarea' });
              return;
            }
            const radios = Array.from(container.querySelectorAll('input[type="radio"]'));
            if (radios.length > 0) {
              items.push({ id: radios[0].getAttribute('name') || `task_${idx}`, questionText, fieldType: 'radio', options: extractOpts(radios) });
              return;
            }
            const checkboxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
            if (checkboxes.length > 0) {
              items.push({ id: checkboxes[0].getAttribute('name') || `task_${idx}`, questionText, fieldType: 'checkbox', options: extractOpts(checkboxes) });
              return;
            }
            const textInput = container.querySelector('input[type="text"], input:not([type])');
            if (textInput) {
              items.push({ id: textInput.getAttribute('name') || textInput.id || `task_${idx}`, questionText, fieldType: 'text' });
            }
          });
        }

        if (items.length === 0) {
          const directInputs = Array.from(
            document.querySelectorAll('textarea[name^="task_"], input[name^="task_"], [data-qa="test-task-input"]')
          );
          directInputs.forEach((inp, idx) => {
            const id = inp.getAttribute('name') || inp.id || `task_${idx}`;
            const tag = inp.tagName.toLowerCase();
            const type = inp.getAttribute('type') || 'text';
            const label = inp.closest('label') ?? (inp.id ? document.querySelector(`label[for="${inp.id}"]`) : null);
            const questionText = normalize(label?.textContent || inp.getAttribute('placeholder')) || `Question ${idx + 1}`;
            if (tag === 'textarea' || inp.getAttribute('data-qa') === 'test-task-input') {
              items.push({ id, questionText, fieldType: 'textarea' });
            } else if (type === 'radio' || type === 'checkbox') {
              items.push({ id, questionText, fieldType: type, options: [] });
            } else {
              items.push({ id, questionText, fieldType: 'text' });
            }
          });
        }
        return items;
      });
      if (Array.isArray(evaluated) && evaluated.length > 0) {
        return evaluated;
      }
    } catch {}
  }

  const fallbackItems: EmployerQuestionItem[] = [];
  const textareas = page.locator('textarea[name^="task_"], [data-qa="test-task-input"]');
  const taCount = await textareas.count().catch(() => 0);
  for (let i = 0; i < taCount; i++) {
    const el = typeof textareas.nth === 'function' ? textareas.nth(i) : textareas.first();
    const name = (await el.getAttribute('name').catch(() => null)) || `task_${i}`;
    fallbackItems.push({ id: name, questionText: 'Test question', fieldType: 'textarea' });
  }

  const radioLoc = page.locator('input[type="radio"][name^="task_"]');
  if ((await radioLoc.count().catch(() => 0)) > 0) {
    const el = typeof radioLoc.nth === 'function' ? radioLoc.nth(0) : radioLoc.first();
    const name = (await el.getAttribute('name').catch(() => null)) || 'task_radio';
    fallbackItems.push({ id: name, questionText: 'Radio question', fieldType: 'radio', options: [] });
  }

  const checkLoc = page.locator('input[type="checkbox"][name^="task_"]');
  if ((await checkLoc.count().catch(() => 0)) > 0) {
    const el = typeof checkLoc.nth === 'function' ? checkLoc.nth(0) : checkLoc.first();
    const name = (await el.getAttribute('name').catch(() => null)) || 'task_checkbox';
    fallbackItems.push({ id: name, questionText: 'Checkbox question', fieldType: 'checkbox', options: [] });
  }

  const textInputs = page.locator('input[type="text"][name^="task_"]');
  const textCount = await textInputs.count().catch(() => 0);
  for (let i = 0; i < textCount; i++) {
    const el = typeof textInputs.nth === 'function' ? textInputs.nth(i) : textInputs.first();
    const name = (await el.getAttribute('name').catch(() => null)) || `task_text_${i}`;
    fallbackItems.push({ id: name, questionText: 'Text question', fieldType: 'text' });
  }
  return fallbackItems;
}

export async function fillEmployerQuestionAnswersOnPage(
  page: Page,
  questions: ReadonlyArray<EmployerQuestionItem>,
  answers: ReadonlyArray<EmployerQuestionAnswer>
): Promise<boolean> {
  if (answers.length === 0) {
    return false;
  }

  let filledCount = 0;
  for (const answer of answers) {
    const q = questions.find((item) => item.id === answer.id);
    const fieldType =
      q?.fieldType ??
      (answer.selectedOptions && answer.selectedOptions.length > 0 ? 'radio' : 'textarea');

    try {
      if ((fieldType === 'textarea' || fieldType === 'text') && answer.answerText) {
        const locator = page
          .locator(
            `textarea[name="${answer.id}"], input[name="${answer.id}"], [data-qa="test-task-input"]`
          )
          .first();
        const count = await locator.count().catch(() => 0);
        if (count > 0) {
          await locator.fill(answer.answerText);
          await page.waitForTimeout(300);
          filledCount++;
        }
      } else if (
        (fieldType === 'radio' || fieldType === 'checkbox') &&
        answer.selectedOptions &&
        answer.selectedOptions.length > 0
      ) {
        for (const optText of answer.selectedOptions) {
          const labelLocator = page.locator('label', { hasText: optText }).first();
          const count = await labelLocator.count().catch(() => 0);
          if (count > 0) {
            await labelLocator.click();
            await page.waitForTimeout(300);
            filledCount++;
          }
        }
      }
    } catch {
    }
  }

  return filledCount > 0;
}

export async function submitQuestionsFormOrModalOnPage(
  page: Page,
  submitModalFn?: (p: Page) => Promise<SafeResult<boolean>>
): Promise<SafeResult<boolean>> {
  if (submitModalFn) {
    const modalRes = await submitModalFn(page);
    if (modalRes.data) {
      return modalRes;
    }
  }

  const submitSelectors = [
    '[data-qa="vacancy-response-submit-popup"]',
    '[data-qa="vacancy-response-letter-submit"]',
    'button[type="submit"]:has-text("Отправить")',
    'button:has-text("Отправить")',
    'button:has-text("Откликнуться")',
  ];

  for (const selector of submitSelectors) {
    const btn = page.locator(selector).first();
    const count = await btn.count().catch(() => 0);
    if (count > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.click().catch(() => undefined);
      await page.waitForTimeout(1200);
      return { data: true, error: null };
    }
  }

  return { data: false, error: null };
}

export async function checkEmployerQuestionsRequiredOnPage(
  page: Page,
  isResumeWarningBlockingFn?: (page: Page) => Promise<boolean>
): Promise<boolean> {
  if (isResumeWarningBlockingFn && (await isResumeWarningBlockingFn(page))) {
    return true;
  }

  const questionIndicators = [
    'textarea[name^="task_"]',
    'input[name^="task_"]',
    'text="Для отклика необходимо ответить на несколько вопросов работодателя"',
    'text="Ответьте на вопросы"',
    '[data-qa="test-task-input"]',
    '[data-qa="vacancy-response-popup-questions"]',
  ];

  for (const sel of questionIndicators) {
    const locator = page.locator(sel);
    if (!locator || typeof locator.count !== 'function') {
      continue;
    }
    const count = await locator.count();
    if (count > 0 && (await locator.first().isVisible().catch(() => false))) {
      return true;
    }
  }

  return false;
}

export async function hasFormValidationErrorsOnPage(page: Page): Promise<boolean> {
  const errorSelectors = [
    '[class*="error"]:has-text("Писать тут")',
    '[data-qa*="error"]:has-text("Писать тут")',
    '[class*="error"]:has-text("Заполните")',
    '[data-qa*="error"]:has-text("Заполните")',
    'text="Писать тут"',
  ];

  for (const sel of errorSelectors) {
    const locator = page.locator(sel);
    if (!locator || typeof locator.count !== 'function') {
      continue;
    }
    const count = await locator.count();
    if (count > 0 && (await locator.first().isVisible().catch(() => false))) {
      return true;
    }
  }

  return false;
}

export async function checkForeignCountryWarningOnPage(page: Page): Promise<boolean> {
  const dialogLocators = [
    page.locator('[data-qa="relocation-warning-confirm"]'),
    page.locator('[data-qa="relocation-warning"]'),
    page.locator('[data-qa*="relocation"]'),
    page.locator('[role="dialog"]'),
    page.locator('.bloko-modal'),
  ];

  let hasAnyDialog = false;
  for (const loc of dialogLocators) {
    if (!loc || typeof loc.count !== 'function') continue;
    const count = await loc.count().catch(() => 0);
    if (count > 0 && (await loc.first().isVisible().catch(() => false))) {
      hasAnyDialog = true;
      break;
    }
  }

  if (!hasAnyDialog) {
    return false;
  }

  const foreignSelectors = [
    'text="другой стране"',
    'text="другая страна"',
    'text="другую страну"',
    'text="в другой стране"',
    '[data-qa*="relocation-warning"]:has-text("стран")',
    '[role="dialog"]:has-text("стран")',
    '.bloko-modal:has-text("стран")',
  ];

  for (const sel of foreignSelectors) {
    const loc = page.locator(sel).first();
    if (loc && typeof loc.count !== 'function') {
      continue;
    }
    const count = await loc.count().catch(() => 0);
    if (count > 0 && (await loc.isVisible().catch(() => false))) {
      return true;
    }
  }

  if (typeof page.evaluate === 'function') {
    const evalResult = await page
      .evaluate(() => {
        const dialogs = document.querySelectorAll(
          '[role="dialog"], .bloko-modal, [data-qa*="relocation-warning"], [data-qa*="warning-modal"]'
        );
        const searchScope = dialogs.length > 0 ? Array.from(dialogs) : [document.body];
        for (const el of searchScope) {
          if (!el) continue;
          const text = ((el as HTMLElement).innerText ?? el.textContent ?? '').toLowerCase();
          const hasCountryMention =
            text.includes('другой стране') ||
            text.includes('другая страна') ||
            text.includes('другую страну') ||
            text.includes('в другой стране');
          if (hasCountryMention) {
            return true;
          }
        }
        return false;
      })
      .catch(() => false);

    return evalResult === true;
  }

  return false;
}

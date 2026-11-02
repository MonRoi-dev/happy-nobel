import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ExternalFormApplierService } from '../src/modules/tg-channel/external-form-applier.service.ts';

function createMockFormPage(options: {
  url: string;
  bodyText: string;
  hasRecaptcha?: boolean;
  hasFileInput?: boolean;
  customQuestions?: Array<{ id: string; questionText: string; fieldType: 'text' | 'textarea' }>;
}) {
  const filledValues: Record<string, string> = {};
  const uploadedFiles: string[] = [];
  let submitClicked = false;

  const page = {
    url: () => options.url,
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => undefined,
    screenshot: async (opts?: { path?: string }) => {
      const buf = Buffer.from('FAKE_PNG_SCREENSHOT');
      if (opts?.path) {
        fs.mkdirSync(path.dirname(opts.path), { recursive: true });
        fs.writeFileSync(opts.path, buf);
      }
      return buf;
    },
    evaluate: async (fn: unknown) => {
      const fnStr = String(fn);
      if (fnStr.includes('innerText')) {
        return options.bodyText;
      }
      if (fnStr.includes('hasExternalCaptcha')) {
        return Boolean(options.hasRecaptcha);
      }
      if (fnStr.includes('customQuestions')) {
        return options.customQuestions ?? [];
      }
      return null;
    },
    locator: (selector: string) => {
      if (selector.includes('input[type="file"]')) {
        return {
          count: async () => (options.hasFileInput !== false ? 1 : 0),
          first: () => ({
            setInputFiles: async (filePath: string) => {
              uploadedFiles.push(filePath);
            },
          }),
        };
      }
      if (selector.includes('captcha') || selector.includes('turnstile')) {
        return {
          count: async () => (options.hasRecaptcha ? 1 : 0),
          first: () => ({
            isVisible: async () => Boolean(options.hasRecaptcha),
          }),
        };
      }
      if (selector.includes('submit') || selector.includes('APPLY') || selector.includes('Отправить')) {
        return {
          count: async () => 1,
          first: () => ({
            isVisible: async () => true,
            click: async () => {
              submitClicked = true;
            },
          }),
        };
      }
      return {
        count: async () => 1,
        first: () => ({
          isVisible: async () => true,
          fill: async (val: string) => {
            filledValues[selector] = val;
          },
          click: async () => undefined,
        }),
      };
    },
  };

  return { page, filledValues, uploadedFiles, isSubmitClicked: () => submitClicked };
}

describe('Task 4: ExternalFormApplierService (Playwright ATS Form Filler)', () => {
  it('detects redirect to hh.ru/vacancy/:id and returns redirected_to_hh without filling external form', async () => {
    const { page } = createMockFormPage({
      url: 'https://hh.ru/vacancy/11223344',
      bodyText: 'Senior Node.js Developer at HH',
    });

    const applier = new ExternalFormApplierService({
      withPage: async (cb) => cb(page as never),
    });

    const res = await applier.applyToExternalForm({
      targetUrl: 'https://bit.ly/some-redirect',
      channelPostText: 'Вакансия Node.js',
      positionTitle: 'Senior Node.js Developer',
      companyName: 'TechCo',
      applicantProfile: {
        applicantName: 'Alexey Ivanov',
        applicantEmail: 'alexey@example.com',
        applicantPhone: '+79991112233',
        applicantTelegram: '@alexey_node',
        resumeRawText: 'Node.js TypeScript 6 years',
        resumePdfPath: null,
      },
      minMatchScore: 70,
      evaluateVacancyFn: async () => ({
        data: { matchScore: 90, reasoning: 'Great fit', coverLetter: 'Hello TechCo!' },
        error: null,
      }),
    });

    assert.equal(res.error, null);
    assert.equal(res.data?.status, 'redirected_to_hh');
    assert.equal(res.data?.hhVacancyId, '11223344');
  });

  it('fills Name, Email, Comment, attaches PDF via setInputFiles, and submits when no captcha is present', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-form-pdf-'));
    const pdfPath = path.join(tmpDir, 'candidate-cv.pdf');
    fs.writeFileSync(pdfPath, '%PDF-1.7 mock');

    try {
      const mock = createMockFormPage({
        url: 'https://forms.monday.com/forms/3c3644ce51583eef505408abd4eb3c53?r=use1',
        bodyText: 'Senior Node.js Developer at Digipal. Requirements: 5+ years Node.js, TypeScript, AWS.',
        hasRecaptcha: false,
        hasFileInput: true,
      });

      const applier = new ExternalFormApplierService({
        withPage: async (cb) => cb(mock.page as never),
      });

      const res = await applier.applyToExternalForm({
        targetUrl: 'https://forms.monday.com/forms/3c3644ce51583eef505408abd4eb3c53?r=use1',
        channelPostText: 'Digipal ищет Senior Node.js Developer',
        positionTitle: 'Senior Node.js Developer',
        companyName: 'Digipal',
        applicantProfile: {
          applicantName: 'Alexey Ivanov',
          applicantEmail: 'alexey@example.com',
          applicantPhone: '+79991112233',
          applicantTelegram: '@alexey_node',
          resumeRawText: 'Node.js TypeScript AWS PostgreSQL 6 years',
          resumePdfPath: pdfPath,
        },
        minMatchScore: 70,
        evaluateVacancyFn: async () => ({
          data: {
            matchScore: 92,
            reasoning: 'Strong Node.js + AWS match',
            coverLetter: 'Здравствуйте, команда Digipal! Имею 6 лет опыта с Node.js и AWS.',
          },
          error: null,
        }),
      });

      assert.equal(res.error, null);
      assert.equal(res.data?.status, 'applied_external');
      assert.equal(mock.uploadedFiles.includes(pdfPath), true);
      assert.equal(mock.isSubmitClicked(), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('pre-fills form, attaches PDF, takes screenshot, and returns pending_external_captcha when reCAPTCHA v2 is detected (Wisebits case)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-form-captcha-'));
    const pdfPath = path.join(tmpDir, 'candidate-cv.pdf');
    fs.writeFileSync(pdfPath, '%PDF-1.7 mock');

    try {
      const mock = createMockFormPage({
        url: 'https://wisebits.com/career/fullstack-js-nodejs',
        bodyText: 'Wisebits — Fullstack Developer (JS/Node.js). From €4,000 net per month.',
        hasRecaptcha: true,
        hasFileInput: true,
      });

      const applier = new ExternalFormApplierService({
        withPage: async (cb) => cb(mock.page as never),
        snapshotsDir: tmpDir,
      });

      const res = await applier.applyToExternalForm({
        targetUrl: 'https://wisebits.com/career/fullstack-js-nodejs',
        channelPostText: 'Wisebits ищет Fullstack Developer (JS/Node.js)',
        positionTitle: 'Fullstack Developer (JS/Node.js)',
        companyName: 'Wisebits',
        applicantProfile: {
          applicantName: 'Alexey Ivanov',
          applicantEmail: 'alexey@example.com',
          applicantPhone: '+79991112233',
          applicantTelegram: '@alexey_node',
          resumeRawText: 'Node.js 18+, SvelteKit, MongoDB, WebSockets, Docker',
          resumePdfPath: pdfPath,
        },
        minMatchScore: 70,
        evaluateVacancyFn: async () => ({
          data: {
            matchScore: 88,
            reasoning: 'Matches Node.js 18+ and high-load requirements',
            coverLetter: 'Здравствуйте, команда Wisebits! Откликаюсь на позицию Fullstack Developer.',
          },
          error: null,
        }),
      });

      assert.equal(res.error, null);
      assert.equal(res.data?.status, 'pending_external_captcha');
      assert.equal(mock.uploadedFiles.includes(pdfPath), true);
      assert.equal(mock.isSubmitClicked(), false);
      assert.ok(res.data?.screenshotPath);
      assert.equal(fs.existsSync(res.data.screenshotPath), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

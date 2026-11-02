import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { extractApplicantProfileFields } from '../src/modules/parser/contact-extractor.service.ts';
import {
  ensureResumePdfOnDisk,
  saveUploadedResumePdf,
} from '../src/modules/telegram/telegram-wizards.ts';

describe('Task 2: Resume PDF Persistence & Applicant Contact Extraction', () => {
  it('extracts applicant Name, Email, Phone, and Telegram from raw resume text', () => {
    const rawResume = [
      'Иванов Алексей Сергеевич',
      'Senior Node.js / TypeScript Developer',
      'Email: alexey.ivanov@example.dev',
      'Телефон: +7 (999) 123-45-67',
      'Telegram: https://t.me/alexey_node',
      'Опыт работы — 6 лет: Node.js, NestJS, PostgreSQL, Redis, Docker.',
    ].join('\n');

    const extracted = extractApplicantProfileFields(rawResume);
    assert.equal(extracted.applicantName, 'Иванов Алексей Сергеевич');
    assert.equal(extracted.applicantEmail, 'alexey.ivanov@example.dev');
    assert.equal(extracted.applicantPhone, '+7 (999) 123-45-67');
    assert.equal(extracted.applicantTelegram, '@alexey_node');
  });

  it('saves valid PDF buffer to disk and prevents path traversal', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-pdf-test-'));
    try {
      const pdfBytes = new TextEncoder().encode('%PDF-1.7\nMock PDF content for CV');
      const res = saveUploadedResumePdf(pdfBytes, '../../evil/../Alexey_CV.pdf', tmpDir);

      assert.equal(res.error, null);
      assert.ok(res.data);
      assert.equal(res.data.startsWith(tmpDir + path.sep), true);
      assert.equal(fs.existsSync(res.data), true);
      assert.equal(fs.readFileSync(res.data).byteLength, pdfBytes.byteLength);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects non-PDF buffer when saving resume PDF', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-pdf-invalid-'));
    try {
      const invalidBytes = new TextEncoder().encode('NOT_A_PDF_FILE');
      const res = saveUploadedResumePdf(invalidBytes, 'resume.pdf', tmpDir);
      assert.equal(res.data, null);
      assert.ok(res.error);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('restores missing local PDF from Telegram file_id via ensureResumePdfOnDisk', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-pdf-restore-'));
    try {
      const pdfBytes = new TextEncoder().encode('%PDF-1.7\nRestored from Telegram file_id');
      const res = await ensureResumePdfOnDisk({
        resumePdfPath: path.join(tmpDir, 'missing.pdf'),
        resumeTelegramFileId: 'tg_file_123',
        targetDir: tmpDir,
        getFilePathFn: async (fileId) => (fileId === 'tg_file_123' ? 'documents/file_9.pdf' : null),
        downloadFileFn: async () => pdfBytes,
      });

      assert.equal(res.error, null);
      assert.ok(res.data);
      assert.equal(fs.existsSync(res.data), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

import { desc } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import type { AppDatabase } from '../../db/index.ts';
import { applicationRecords, type ApplicationRecord } from '../../db/schema.ts';
import { createLogger } from '../../utils/logger.ts';
import type { SafeResult } from '../config-store/index.ts';

const logger = createLogger('Exporter');

const DEFAULT_EXPORT_LIMIT = 2000;
const MAX_EXPORT_LIMIT = 5000;
const FORMULA_INJECTION_PREFIX = /^[=+\-@\t\r]/;

export interface ExportReportArtifact {
  readonly buffer: Uint8Array;
  readonly fileName: string;
  readonly rowCount: number;
  readonly mimeType: string;
}

export interface IReportExporter {
  exportApplicationsReport(limit?: number): Promise<SafeResult<ExportReportArtifact>>;
}

export interface GoogleSheetsExporterOptions {
  readonly spreadsheetId?: string;
  readonly serviceAccountEmail?: string;
}

export function sanitizeSpreadsheetCell(value: string | null | undefined): string {
  const normalized = (value ?? '').trim();
  if (!normalized) {
    return '';
  }
  if (FORMULA_INJECTION_PREFIX.test(normalized)) {
    return `'${normalized}`;
  }
  return normalized;
}

export function formatReportStatus(status: string): string {
  switch (status) {
    case 'pending_approval':
      return 'Ожидает одобрения';
    case 'tg_contact_notified':
      return 'Ожидает отклика (контакт HR)';
    case 'pending_external_captcha':
      return 'Ожидает отклика (форма сайта)';
    case 'applied_external':
      return 'Отправлено (внешняя форма)';
    case 'skipped_low_score':
      return 'Пропущено (низкий балл ИИ)';
    case 'skipped_user':
      return 'Пропущено пользователем';
    case 'invitation':
      return 'Приглашение';
    case 'discard':
      return 'Отказ';
    case 'viewed':
      return 'Просмотрено';
    default:
      return 'Отправлено';
  }
}

export function formatReportDate(isoDate: string): string {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) {
    return sanitizeSpreadsheetCell(isoDate);
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(
    parsed.getHours()
  )}:${pad(parsed.getMinutes())}`;
}

function clampExportLimit(rawLimit?: number): number {
  if (!rawLimit || Number.isNaN(rawLimit) || rawLimit < 1) {
    return DEFAULT_EXPORT_LIMIT;
  }
  return Math.min(MAX_EXPORT_LIMIT, Math.floor(rawLimit));
}

export class ExcelExporterService implements IReportExporter {
  private readonly db: AppDatabase;

  constructor(db: AppDatabase) {
    this.db = db;
  }

  public async exportApplicationsReport(
    limit = DEFAULT_EXPORT_LIMIT
  ): Promise<SafeResult<ExportReportArtifact>> {
    const safeLimit = clampExportLimit(limit);

    try {
      const records: ApplicationRecord[] = this.db
        .select()
        .from(applicationRecords)
        .orderBy(desc(applicationRecords.appliedAt), desc(applicationRecords.id))
        .limit(safeLimit)
        .all();

      logger.info(`Формирование Excel-отчета (записей: ${records.length})...`);

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'HH.ru Auto-Responder Bot';
      workbook.created = new Date();

      const sheet = workbook.addWorksheet('Отклики HH.ru', {
        views: [{ state: 'frozen', ySplit: 1 }],
      });

      sheet.columns = [
        { header: 'Дата', key: 'appliedDate', width: 20 },
        { header: 'Компания', key: 'companyName', width: 28 },
        { header: 'Позиция', key: 'positionTitle', width: 36 },
        { header: 'Зарплата', key: 'salaryText', width: 22 },
        { header: 'Статус', key: 'statusLabel', width: 18 },
        { header: 'Оценка ИИ (%)', key: 'matchScore', width: 16 },
        { header: 'Комментарий ИИ', key: 'aiReasoning', width: 45 },
        { header: 'Ссылка на вакансию', key: 'vacancyUrl', width: 38 },
        { header: 'Сопроводительное письмо', key: 'coverLetter', width: 65 },
      ];

      const headerRow = sheet.getRow(1);
      headerRow.font = { bold: true };
      headerRow.alignment = { vertical: 'middle', horizontal: 'left' };

      for (const record of records) {
        const row = sheet.addRow({
          appliedDate: formatReportDate(record.appliedAt),
          companyName: sanitizeSpreadsheetCell(record.companyName),
          positionTitle: sanitizeSpreadsheetCell(record.positionTitle),
          salaryText: sanitizeSpreadsheetCell(record.salaryText),
          statusLabel: formatReportStatus(record.status),
          matchScore:
            record.matchScore !== null && record.matchScore !== undefined
              ? record.matchScore
              : '',
          aiReasoning: sanitizeSpreadsheetCell(record.aiReasoning),
          vacancyUrl: sanitizeSpreadsheetCell(record.vacancyUrl),
          coverLetter: sanitizeSpreadsheetCell(record.coverLetter),
        });

        row.alignment = { vertical: 'top', wrapText: true };
      }

      const rawBuffer = await workbook.xlsx.writeBuffer();
      const uint8Buffer = new Uint8Array(rawBuffer);
      const dateStamp = new Date().toISOString().slice(0, 10);
      const fileName = `hh_applications_${dateStamp}.xlsx`;

      logger.info(`Excel-отчет "${fileName}" сформирован (${uint8Buffer.byteLength} байт).`);

      return {
        data: {
          buffer: uint8Buffer,
          fileName,
          rowCount: records.length,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
        error: null,
      };
    } catch (err) {
      logger.error('Ошибка генерации Excel-отчета', err);
      const message = err instanceof Error ? err.message : 'Failed to generate Excel report';
      return { data: null, error: message };
    }
  }
}

export class GoogleSheetsExporterService implements IReportExporter {
  private readonly db: AppDatabase;
  private readonly options: GoogleSheetsExporterOptions;

  constructor(db: AppDatabase, options: GoogleSheetsExporterOptions = {}) {
    this.db = db;
    this.options = options;
  }

  public async exportApplicationsReport(
    limit = DEFAULT_EXPORT_LIMIT
  ): Promise<SafeResult<ExportReportArtifact>> {
    const safeLimit = clampExportLimit(limit);
    const recordsCount = this.db
      .select({ id: applicationRecords.id })
      .from(applicationRecords)
      .limit(safeLimit)
      .all().length;

    if (!this.options.spreadsheetId) {
      return {
        data: null,
        error: `Google Sheets интеграция является шаблоном (готово к выгрузке записей: ${recordsCount}). Укажите spreadsheetId для активации.`,
      };
    }

    return {
      data: null,
      error: `Google Sheets синхронизация для таблицы ${this.options.spreadsheetId} еще не настроена.`,
    };
  }
}

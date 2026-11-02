export interface ExtractedContacts {
  readonly telegramHandles: string[];
  readonly phoneNumbers: string[];
  readonly emails: string[];
}

export interface ApplicantProfileFields {
  readonly applicantName: string;
  readonly applicantEmail: string | null;
  readonly applicantPhone: string | null;
  readonly applicantTelegram: string | null;
}

const NAME_LINE_REGEX = /^[А-ЯЁA-Z][а-яёa-z]+(?:\s+[А-ЯЁA-Z][а-яёa-z]+){1,2}$/;
const LABELED_NAME_REGEX = /(?:ФИО|Имя|Name|Candidate)\s*[:—-]\s*([А-ЯЁA-Z][а-яёa-z]+(?:\s+[А-ЯЁA-Z][а-яёa-z]+){0,2})/i;
const ROLE_KEYWORDS_REGEX = /\b(developer|engineer|backend|frontend|fullstack|node|typescript|javascript|разработчик|инженер|программист|резюме|cv|resume|senior|middle|lead)\b/i;

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9._-]+\.[a-zA-Z]{2,}/g;
const TELEGRAM_LINK_REGEX =
  /(?:https?:\/\/)?(?<!@)(?:t\.me|telegram\.me)\/@?([a-zA-Z0-9_+]{5,32})\b/gi;
const TELEGRAM_HANDLE_REGEX =
  /(?<![a-zA-Z0-9._%+-])@([a-zA-Z0-9_]{5,32})\b/g;
const PHONE_REGEX =
  /(?:\+7|8)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g;

export function extractContacts(rawText: string): ExtractedContacts {
  if (typeof rawText !== 'string' || rawText.length === 0) {
    return {
      telegramHandles: [],
      phoneNumbers: [],
      emails: [],
    };
  }

  const seenEmails = new Set<string>();
  const emails: string[] = [];
  for (const match of rawText.matchAll(EMAIL_REGEX)) {
    const email = match[0].trim();
    const lower = email.toLowerCase();
    if (email.length > 0 && !seenEmails.has(lower)) {
      seenEmails.add(lower);
      emails.push(email);
    }
  }

  const seenTelegram = new Set<string>();
  const seenUsernames = new Set<string>();
  const telegramHandles: string[] = [];

  for (const match of rawText.matchAll(TELEGRAM_LINK_REGEX)) {
    const segment = match[1] ?? '';
    const normalized = `https://t.me/${segment}`;
    const cleanSegment = segment.startsWith('+') ? segment : segment.toLowerCase();
    if (!seenTelegram.has(normalized.toLowerCase()) && !seenUsernames.has(cleanSegment)) {
      seenTelegram.add(normalized.toLowerCase());
      seenUsernames.add(cleanSegment);
      telegramHandles.push(normalized);
    }
  }

  for (const match of rawText.matchAll(TELEGRAM_HANDLE_REGEX)) {
    const username = match[1] ?? '';
    const normalized = `@${username}`;
    const cleanUsername = username.toLowerCase();
    if (!seenTelegram.has(normalized.toLowerCase()) && !seenUsernames.has(cleanUsername)) {
      seenTelegram.add(normalized.toLowerCase());
      seenUsernames.add(cleanUsername);
      telegramHandles.push(normalized);
    }
  }

  const seenPhones = new Set<string>();
  const phoneNumbers: string[] = [];
  for (const match of rawText.matchAll(PHONE_REGEX)) {
    const phone = match[0].trim();
    if (phone.length > 0 && !seenPhones.has(phone)) {
      seenPhones.add(phone);
      phoneNumbers.push(phone);
    }
  }

  return {
    telegramHandles,
    phoneNumbers,
    emails,
  };
}

export function hasExtractedContacts(contacts: ExtractedContacts): boolean {
  return (
    contacts.telegramHandles.length > 0 ||
    contacts.phoneNumbers.length > 0 ||
    contacts.emails.length > 0
  );
}

export function formatExtractedContactsBlock(
  contacts: ExtractedContacts,
  escapeFn?: (s: string) => string
): string {
  if (!hasExtractedContacts(contacts)) {
    return '';
  }

  const esc = escapeFn ?? ((s: string) => s);
  const lines: string[] = ['📌 <b>Найденные контакты для быстрой связи:</b>'];

  if (contacts.telegramHandles.length > 0) {
    lines.push(`• Telegram: ${contacts.telegramHandles.map(esc).join(', ')}`);
  }
  if (contacts.phoneNumbers.length > 0) {
    lines.push(`• Телефон: ${contacts.phoneNumbers.map(esc).join(', ')}`);
  }
  if (contacts.emails.length > 0) {
    lines.push(`• Email: ${contacts.emails.map(esc).join(', ')}`);
  }

  return lines.join('\n');
}

export function formatContactsFooter(
  rawText: string,
  escapeFn?: (s: string) => string
): string {
  const contacts = extractContacts(rawText);
  return formatExtractedContactsBlock(contacts, escapeFn);
}

export function extractApplicantProfileFields(
  resumeRawText: string,
  fallbackName = 'Candidate'
): ApplicantProfileFields {
  const contacts = extractContacts(resumeRawText);
  const applicantEmail = contacts.emails[0] ?? null;
  const applicantPhone = contacts.phoneNumbers[0] ?? null;

  let applicantTelegram: string | null = null;
  const firstTg = contacts.telegramHandles[0];
  if (firstTg) {
    const clean = firstTg
      .replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i, '')
      .replace(/^@/, '')
      .trim();
    if (clean.length > 0) {
      applicantTelegram = `@${clean}`;
    }
  }

  let applicantName = fallbackName;
  const labeledMatch = LABELED_NAME_REGEX.exec(resumeRawText);
  if (labeledMatch?.[1]) {
    applicantName = labeledMatch[1].trim();
  } else {
    const lines = resumeRawText
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length >= 3 && line.length <= 60);

    for (const line of lines.slice(0, 8)) {
      if (NAME_LINE_REGEX.test(line) && !ROLE_KEYWORDS_REGEX.test(line)) {
        applicantName = line;
        break;
      }
    }
  }

  return {
    applicantName,
    applicantEmail,
    applicantPhone,
    applicantTelegram,
  };
}

export class ContactExtractorService {
  public static extractContacts(rawText: string): ExtractedContacts {
    return extractContacts(rawText);
  }

  public static formatContactsFooter(
    rawText: string,
    escapeFn?: (s: string) => string
  ): string {
    return formatContactsFooter(rawText, escapeFn);
  }

  public extractContacts(rawText: string): ExtractedContacts {
    return ContactExtractorService.extractContacts(rawText);
  }

  public formatContactsFooter(
    rawText: string,
    escapeFn?: (s: string) => string
  ): string {
    return ContactExtractorService.formatContactsFooter(rawText, escapeFn);
  }
}

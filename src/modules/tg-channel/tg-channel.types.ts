import type { SafeResult } from '../config-store/index.ts';

export interface TgChannelPostLink {
  readonly href: string;
  readonly label: string;
}

export interface TgChannelPostItem {
  readonly channelSlug: string;
  readonly postId: string;
  readonly vacancyKey: string;
  readonly postUrl: string;
  readonly publishedAt: string;
  readonly rawText: string;
  readonly positionTitle: string;
  readonly companyName: string;
  readonly salaryText: string;
  readonly primaryApplyUrl: string | null;
  readonly applyLinks: TgChannelPostLink[];
  readonly tgContacts: string[];
  readonly hrEmails?: string[];
}

export type ClassifiedVacancyTarget =
  | {
      readonly kind: 'hh_vacancy';
      readonly hhVacancyId: string;
      readonly hhVacancyUrl: string;
    }
  | {
      readonly kind: 'tg_contact';
      readonly tgUsername: string;
      readonly tgChatUrl: string;
      readonly hrEmail?: string;
      readonly contactType?: 'telegram' | 'email';
    }
  | {
      readonly kind: 'external_form';
      readonly targetUrl: string;
    };

export interface ITgChannelScraperService {
  scrapePublicChannelPosts(channelUrlOrSlug: string, limit?: number): Promise<SafeResult<TgChannelPostItem[]>>;
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPublicChannelWebUrl,
  classifyChannelPostTarget,
  parsePublicChannelHtml,
  parseTelegramChannelWebHtml,
  TgChannelScraperService,
} from '../src/modules/tg-channel/index.ts';

const SAMPLE_TG_CHANNEL_HTML = `
<div class="tgme_widget_message_wrap">
  <div class="tgme_widget_message" data-post="node_js_jobs_vakansii/1041">
    <div class="tgme_widget_message_text js-message_text" dir="auto">
      💼 <b>Вакансия Senior Node.js Developer</b><br/><br/>
      Удалённо · B2B Contract<br/><br/>
      💎 <b>Digipal</b> требуется Senior Node.js Developer для разработки масштабируемых программных продуктов.<br/><br/>
      🧩 <b>Требования:</b> от 5 лет опыта работы Node.js-разработчиком, TypeScript, AWS, PostgreSQL.<br/><br/>
      🌐 <a href="https://forms.monday.com/forms/3c3644ce51583eef505408abd4eb3c53?r=use1" target="_blank">Откликнуться</a><br/><br/>
      🔮 <a href="https://t.me/it_poster_bot" target="_blank">POSTER</a> — бесплатно постим IT-вакансии
    </div>
    <time datetime="2026-10-12T16:05:00+00:00"></time>
  </div>
</div>
<div class="tgme_widget_message_wrap">
  <div class="tgme_widget_message" data-post="node_js_jobs_vakansii/1042">
    <div class="tgme_widget_message_text js-message_text" dir="auto">
      💼 <b>Вакансия Lead Backend Developer (Node.js)</b><br/><br/>
      💎 <b>TBank</b> ищет техлида в платежное ядро.<br/><br/>
      🌐 <a href="https://spb.hh.ru/vacancy/98765432?from=tg" target="_blank">Откликнуться</a><br/><br/>
      🔮 <a href="https://t.me/it_poster_bot" target="_blank">POSTER</a> — бесплатно постим IT-вакансии
    </div>
    <time datetime="2026-10-13T16:05:00+00:00"></time>
  </div>
</div>
<div class="tgme_widget_message_wrap">
  <div class="tgme_widget_message" data-post="node_js_jobs_vakansii/1043">
    <div class="tgme_widget_message_text js-message_text" dir="auto">
      💼 <b>Вакансия Senior Fullstack JS/Node.js</b><br/><br/>
      💎 <b>StartupLab</b> ищет разработчика в распределенную команду. Пишите рекрутеру @hr_startuplab в личные сообщения.<br/><br/>
      🔮 <a href="https://t.me/it_poster_bot" target="_blank">POSTER</a> — бесплатно постим IT-вакансии
    </div>
    <time datetime="2026-10-14T16:05:00+00:00"></time>
  </div>
</div>
`;

describe('Task 3: Telegram Channel Scraper & Link Classifier', () => {
  it('converts channel URL or handle to public t.me/s/ web preview URL', () => {
    assert.equal(
      buildPublicChannelWebUrl('https://t.me/node_js_jobs_vakansii'),
      'https://t.me/s/node_js_jobs_vakansii'
    );
    assert.equal(
      buildPublicChannelWebUrl('@node_js_jobs_vakansii'),
      'https://t.me/s/node_js_jobs_vakansii'
    );
  });

  it('parses channel HTML into structured TgChannelPostItem entries and ignores promo links', () => {
    const posts = parseTelegramChannelWebHtml(SAMPLE_TG_CHANNEL_HTML, 'node_js_jobs_vakansii');
    assert.equal(posts.length, 3);

    const p1 = posts[0]!;
    assert.equal(p1.postId, '1041');
    assert.equal(p1.vacancyKey, 'tg:node_js_jobs_vakansii:1041');
    assert.equal(p1.positionTitle, 'Senior Node.js Developer');
    assert.equal(p1.companyName, 'Digipal');
    assert.equal(
      p1.primaryApplyUrl,
      'https://forms.monday.com/forms/3c3644ce51583eef505408abd4eb3c53?r=use1'
    );

    const c1 = classifyChannelPostTarget(p1);
    assert.deepEqual(c1, {
      kind: 'external_form',
      targetUrl: 'https://forms.monday.com/forms/3c3644ce51583eef505408abd4eb3c53?r=use1',
    });

    const p2 = posts[1]!;
    assert.equal(p2.companyName, 'TBank');
    const c2 = classifyChannelPostTarget(p2);
    assert.deepEqual(c2, {
      kind: 'hh_vacancy',
      hhVacancyId: '98765432',
      hhVacancyUrl: 'https://hh.ru/vacancy/98765432',
    });

    const p3 = posts[2]!;
    assert.equal(p3.companyName, 'StartupLab');
    const c3 = classifyChannelPostTarget(p3);
    assert.deepEqual(c3, {
      kind: 'tg_contact',
      tgUsername: 'hr_startuplab',
      tgChatUrl: 'https://t.me/hr_startuplab',
    });
  });

  it('fetches channel HTML via injected fetch in TgChannelScraperService', async () => {
    const scraper = new TgChannelScraperService({
      customFetch: async () =>
        new Response(SAMPLE_TG_CHANNEL_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });

    const res = await scraper.scrapePublicChannelPosts('https://t.me/node_js_jobs_vakansii', 10);
    assert.equal(res.error, null);
    assert.equal(res.data?.length, 3);
  });

  it('accurately parses real t.me/s/node_js_jobs_vakansii markup (tg-emoji, linked company, blockquote scam warning, and skips announcements)', () => {
    const realWorldHtml = `
<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="node_js_jobs_vakansii/77">
  <div class="tgme_widget_message_text js-message_text" dir="auto"><tg-emoji emoji-id="1"><i class="emoji"><b>👩‍💻</b></i></tg-emoji><b>Вакансия</b> <b>Fullstack Developer (JS/Node.js)</b><br/><br/><tg-emoji emoji-id="2"><i class="emoji"><b>🟢</b></i></tg-emoji>Удаленно<br/><tg-emoji emoji-id="2"><i class="emoji"><b>🟢</b></i></tg-emoji>от 4 000 евро net<br/><tg-emoji emoji-id="2"><i class="emoji"><b>🟢</b></i></tg-emoji>В компанию Wisebits<br/><br/><i class="emoji"><b>🌐</b></i> <a href="https://wisebits.com/vacancies/162-fullstack-developer-jsnodejs" target="_blank">Откликнуться</a></div>
</div></div>
<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="node_js_jobs_vakansii/85">
  <div class="tgme_widget_message_text js-message_text" dir="auto"><i class="emoji"><b>📢</b></i> <b>Обновили формат вакансий</b><br/><br/>Теперь вакансии выходят короче. Отправьте вакансию в бота <a href="https://t.me/vakansii_it_bot?start=mychannels-selfpost"><b>POSTER IT-вакансий</b></a></div>
</div></div>
<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="node_js_jobs_vakansii/92">
  <div class="tgme_widget_message_text js-message_text" dir="auto"><i class="emoji"><b>📑</b></i><b> Вакансия Fullstack Developer (Node.js+Vue.js)</b><br/><br/><i class="emoji"><b>💎</b></i> В <b>Noveo</b> предстоит вести разработку функционала.<br/><br/><i class="emoji"><b>🧩</b></i><b> Требования</b>: от 8 лет опыта.<br/><br/><i class="emoji"><b>🌐</b></i> <a href="https://noveogroup.com/fullstack-developer-nodejsvuejs" target="_blank">Откликнуться</a></div>
</div></div>
<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="node_js_jobs_vakansii/96">
  <div class="tgme_widget_message_text js-message_text" dir="auto"><i class="emoji"><b>📑</b></i> <b>Вакансия Fullstack JavaScript-разработчика</b><br/><br/>от 60 000 до 90 000 ₽ чистыми · Удалённо<br/><br/><i class="emoji"><b>💎</b></i> <a href="https://makediff.dev/" target="_blank"><b>MakeDifference</b></a> ищет разработчика.<br/><br/><i class="emoji"><b>🧩</b></i> <b>Требования:</b> React, Next.js, TypeScript, Node.js.<br/><br/><i class="emoji"><b>💬</b></i> <b>Резюме отправлять </b><a href="https://t.me/alinabestHR?text=%D0%97%D0%B4%D1%80%D0%B0%D0%B2%D1%81%D1%82%D0%B2%D1%83%D0%B9%D1%82%D0%B5%20%40node_js_jobs_vakansii" target="_blank"><b>@alinabestHR</b></a><br/><br/><blockquote><i>Обязательно </i><a href="https://t.me/freeIT_job" target="_blank"><i>пишите в поддержку.</i></a></blockquote><br/><br/><i class="emoji"><b>🔮</b></i> <a href="https://t.me/vakansii_it_bot?start=footer-node" target="_blank"><b>POSTER</b></a></div>
</div></div>`;

    const parsed = parsePublicChannelHtml(realWorldHtml, 'node_js_jobs_vakansii');
    assert.equal(parsed.length, 3);

    assert.equal(parsed[0]?.postId, '77');
    assert.equal(parsed[0]?.companyName, 'Wisebits');
    assert.equal(parsed[0]?.salaryText, 'от 4 000 евро net');

    assert.equal(parsed[1]?.postId, '92');
    assert.equal(parsed[1]?.companyName, 'Noveo');

    assert.equal(parsed[2]?.postId, '96');
    assert.equal(parsed[2]?.companyName, 'MakeDifference');
    assert.equal(parsed[2]?.salaryText, 'от 60 000 до 90 000 ₽ чистыми');
    assert.deepEqual(classifyChannelPostTarget(parsed[2]!), {
      kind: 'tg_contact',
      tgUsername: 'alinabestHR',
      tgChatUrl: 'https://t.me/alinabestHR',
    });
  });
});

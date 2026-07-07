// Content contract for the seeded app_intro email, asserted against the
// source-of-truth TEMPLATE rendered through the real renderer. Guards the
// things that must hold for the email to work: both store badges clickable to
// the right stores, the screenshots present, no webp (Outlook can't render it),
// and no unresolved variables.
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({ where: jest.fn(() => ({ first: jest.fn(async () => null) })) }));
  db.schema = { hasTable: jest.fn(async () => true) };
  return db;
});
jest.mock('../services/sendgrid-mail', () => ({ serviceGroupId: () => 0, newsletterGroupId: () => 0 }));

const { renderTemplate } = require('../services/email-template-library');
const { TEMPLATE } = require('../models/migrations/20260707000020_app_intro_email_lawn_waves_ai');

const APP_STORE_URL = 'https://apps.apple.com/us/app/waves-pest-control/id6782775654';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.wavespestcontrol.portal';

function renderAppIntro(payload = {}) {
  return renderTemplate({
    template: { name: TEMPLATE.name, mode: 'service' },
    version: { subject: TEMPLATE.subject, preview_text: TEMPLATE.preview, blocks: TEMPLATE.blocks },
    payload: { first_name: 'Sam', app_store_url: APP_STORE_URL, play_store_url: PLAY_STORE_URL, ...payload },
  });
}

describe('app_intro email content contract', () => {
  test('both store badges are clickable to the correct stores', () => {
    const { html, text } = renderAppIntro();
    expect(html).toContain(`<a href="${APP_STORE_URL}"`);
    expect(html).toContain(`<a href="${PLAY_STORE_URL}"`);
    expect(html).toContain('apple-app-store-badge.png');
    expect(html).toContain('google-play-badge.png');
    expect(text).toContain(`Download on the App Store: ${APP_STORE_URL}`);
    expect(text).toContain(`Get it on Google Play: ${PLAY_STORE_URL}`);
  });

  test('includes the app screenshots and personalizes the name', () => {
    const { html } = renderAppIntro({ first_name: 'Dana' });
    expect(html).toContain('app-home.png');
    expect(html).toContain('app-report.png');
    expect(html).toContain('app-reschedule.png');
    expect(html).toContain('app-waves-ai.png');
    expect(html).toContain('Dana');
  });

  test('uses only email-safe images and leaves no unresolved variables', () => {
    const { html } = renderAppIntro();
    expect(html).not.toMatch(/\.webp/i);
    expect(html).not.toMatch(/\{\{\s*\w+\s*\}\}/);
  });

  test('declares first_name required and the store URLs as variables', () => {
    expect(TEMPLATE.required).toContain('first_name');
    expect(TEMPLATE.optional).toEqual(expect.arrayContaining(['app_store_url', 'play_store_url']));
  });
});

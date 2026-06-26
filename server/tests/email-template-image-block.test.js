// Contract for the `image` block added to the email template renderer.
// Covers the two ways the app-intro email uses it: a rounded screenshot, and a
// store badge wrapped in a clickable link whose href comes from a payload var.
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({ where: jest.fn(() => ({ first: jest.fn(async () => null) })) }));
  db.schema = { hasTable: jest.fn(async () => true) };
  return db;
});
jest.mock('../services/sendgrid-mail', () => ({
  serviceGroupId: () => 0,
  newsletterGroupId: () => 0,
}));

const { renderTemplate } = require('../services/email-template-library');

const baseTemplate = { name: 'App Intro', mode: 'service' };
const render = (blocks, payload = {}) =>
  renderTemplate({ template: baseTemplate, version: { subject: 'Meet the app', blocks }, payload });

describe('email renderer — image block', () => {
  test('renders a rounded screenshot <img> at the requested width', () => {
    const { html } = render([
      { type: 'image', src: 'https://portal.wavespestcontrol.com/app-email/app-tracking.png', alt: 'Track your tech', width: 160, radius: 16 },
    ]);
    expect(html).toContain('src="https://portal.wavespestcontrol.com/app-email/app-tracking.png"');
    expect(html).toContain('width="160"');
    expect(html).toContain('border-radius:16px');
    expect(html).toContain('alt="Track your tech"');
  });

  test('wraps a badge image in a clickable store link resolved from a payload var', () => {
    const appStoreUrl = 'https://apps.apple.com/us/app/waves-pest-control/id6782775654';
    const { html, text } = render(
      [{ type: 'image', src: 'https://portal.wavespestcontrol.com/app-email/apple-app-store-badge.png', alt: 'Download on the App Store', width: 168, url_variable: 'app_store_url' }],
      { app_store_url: appStoreUrl },
    );
    expect(html).toContain(`<a href="${appStoreUrl}"`);
    expect(html).toContain('apple-app-store-badge.png');
    // Plain-text part keeps the link reachable.
    expect(text).toContain(`Download on the App Store: ${appStoreUrl}`);
  });

  test('a blank src renders no image (no empty-src <img> leaks past the guard)', () => {
    // The layout wrapper carries the Waves logo <img>, so assert specifically
    // that the block didn't emit an empty-src image.
    const { html } = render([{ type: 'image', src: '', alt: 'x', width: 100 }]);
    expect(html).not.toContain('src=""');
  });
});

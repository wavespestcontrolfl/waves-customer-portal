'use strict';

// services/email-resubscribe-confirm.js (GATE_PORTAL_EMAIL_RESUBSCRIBE): the one
// "Turn Waves emails back on?" email. Real sendgrid-mail and email-template; only
// fetch is faked, so the assertions are on the payload SendGrid would receive.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const TOKEN = 'A'.repeat(43);

describe('resubscribe confirmation email', () => {
  const originalKey = process.env.SENDGRID_API_KEY;
  const originalUrl = process.env.PUBLIC_PORTAL_URL;

  beforeEach(() => {
    jest.resetModules();
    process.env.SENDGRID_API_KEY = 'SG.test-key';
    process.env.PUBLIC_PORTAL_URL = 'https://portal.example.test';
    global.fetch = jest.fn(async () => ({ ok: true, headers: { get: () => 'msg-1' } }));
  });
  afterEach(() => {
    delete global.fetch;
    if (originalKey === undefined) delete process.env.SENDGRID_API_KEY; else process.env.SENDGRID_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.PUBLIC_PORTAL_URL; else process.env.PUBLIC_PORTAL_URL = originalUrl;
  });

  const payloadOf = () => JSON.parse(global.fetch.mock.calls[0][1].body);

  test('the SendGrid request bypasses the global unsubscribe list, has no ASM group, and tracking is off', async () => {
    const { sendResubscribeConfirmation } = require('../services/email-resubscribe-confirm');
    await sendResubscribeConfirmation({ to: 'pat@example.com', token: TOKEN, firstName: 'Pat' });
    const payload = payloadOf();
    expect(payload.mail_settings).toEqual({ bypass_unsubscribe_management: { enable: true } });
    expect(payload).not.toHaveProperty('asm');
    expect(payload.tracking_settings).toEqual({
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false },
    });
    expect(payload.personalizations[0].to).toEqual([{ email: 'pat@example.com' }]);
    expect(payload.subject).toBe('Turn Waves emails back on?');
    expect(payload.from.email).toBe('contact@wavespestcontrol.com');
    expect(payload.categories).toEqual(['email_resubscribe_confirm']);
  });

  test('the body greets by name, says why, and the button points at the public confirm page with the token', async () => {
    const { sendResubscribeConfirmation } = require('../services/email-resubscribe-confirm');
    await sendResubscribeConfirmation({ to: 'pat@example.com', token: TOKEN, firstName: 'Pat' });
    const { content } = payloadOf();
    const html = content.find((c) => c.type === 'text/html').value;
    const text = content.find((c) => c.type === 'text/plain').value;
    const url = `https://portal.example.test/api/public/email-resubscribe/${TOKEN}`;
    expect(html).toContain('Hi Pat, you asked in the Waves app to get our emails again. This address was unsubscribed, so we need your OK first.');
    expect(html).toContain('Turn emails back on');
    expect(html).toContain(url);
    expect(html).toContain("If you didn't ask for this, you can ignore this email. Nothing changes.");
    expect(text).toContain('Hi Pat, you asked in the Waves app');
    expect(text).toContain(url);
  });

  test('a first name with markup is escaped in the HTML, and a missing name reads Hi there', () => {
    const { buildConfirmationEmail } = require('../services/email-resubscribe-confirm');
    const evil = buildConfirmationEmail({ token: TOKEN, firstName: '<img src=x onerror=alert(1)>' });
    expect(evil.html).not.toContain('<img src=x');
    expect(evil.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(buildConfirmationEmail({ token: TOKEN, firstName: '  ' }).html).toContain('Hi there, you asked in the Waves app');
    expect(buildConfirmationEmail({ token: TOKEN }).text).toContain('Hi there,');
  });

  test('a SendGrid rejection throws so the caller can answer failed', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 400, text: async () => 'bad' }));
    const { sendResubscribeConfirmation } = require('../services/email-resubscribe-confirm');
    await expect(sendResubscribeConfirmation({ to: 'pat@example.com', token: TOKEN, firstName: 'Pat' })).rejects.toMatchObject({ status: 400 });
  });

  test('an ordinary sendOne does not carry the bypass setting', async () => {
    const sendgrid = require('../services/sendgrid-mail');
    await sendgrid.sendOne({ to: 'pat@example.com', fromEmail: 'contact@example.test', subject: 'Hi', text: 'Hi', suppressErrorLog: true });
    expect(payloadOf()).not.toHaveProperty('mail_settings');
    global.fetch.mockClear();
    await sendgrid.sendOne({ to: 'pat@example.com', fromEmail: 'contact@example.test', subject: 'Hi', text: 'Hi', bypassUnsubscribeManagement: true, suppressErrorLog: true });
    expect(payloadOf().mail_settings).toEqual({ bypass_unsubscribe_management: { enable: true } });
  });
});

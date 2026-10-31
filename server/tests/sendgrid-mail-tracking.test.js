describe('SendGrid security-email tracking controls', () => {
  const originalApiKey = process.env.SENDGRID_API_KEY;

  beforeEach(() => {
    jest.resetModules();
    process.env.SENDGRID_API_KEY = 'SG.test-key';
    global.fetch = jest.fn(async () => ({
      ok: true,
      headers: { get: jest.fn(() => 'msg-1') },
    }));
  });

  afterEach(() => {
    delete global.fetch;
    if (originalApiKey === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = originalApiKey;
  });

  test('disableTracking prevents HTML link rewriting and open pixels', async () => {
    const sendgrid = require('../services/sendgrid-mail');
    await sendgrid.sendOne({
      to: 'staff@example.test',
      fromEmail: 'contact@example.test',
      subject: 'Reset password',
      html: '<a href="https://portal.test/reset#token=secret">Reset</a>',
      text: 'https://portal.test/reset#token=secret',
      disableTracking: true,
      suppressErrorLog: true,
    });

    const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(payload.tracking_settings).toEqual({
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false },
    });
  });

  test('cc is added to the personalization only when given', async () => {
    const sendgrid = require('../services/sendgrid-mail');
    const base = { to: 'vendor@example.test', fromEmail: 'contact@example.test', subject: 'Order', text: 'Hi', suppressErrorLog: true };
    await sendgrid.sendOne({ ...base, cc: ['copy@example.test'] });
    await sendgrid.sendOne(base);
    await sendgrid.sendOne({ ...base, cc: [] }); // the order email passes its cc list even when empty
    const withCc = JSON.parse(global.fetch.mock.calls[0][1].body).personalizations[0];
    const without = JSON.parse(global.fetch.mock.calls[1][1].body).personalizations[0];
    const emptyList = JSON.parse(global.fetch.mock.calls[2][1].body).personalizations[0];
    expect(withCc.cc).toEqual([{ email: 'copy@example.test' }]);
    expect(withCc.to).toEqual([{ email: 'vendor@example.test' }]);
    expect(without).not.toHaveProperty('cc');
    expect(emptyList).not.toHaveProperty('cc');
  });

  test('clearBlockedAddress deletes only the encoded SendGrid block entry', async () => {
    const sendgrid = require('../services/sendgrid-mail');
    await sendgrid.clearBlockedAddress('customer+tag@example.com');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.sendgrid.com/v3/suppression/blocks/customer%2Btag%40example.com',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

// Regression: every emailed link went through SendGrid's click host, which the
// app does not claim, so no email link ever opened the Waves app.
describe('customer-page email links skip the SendGrid click rewrite', () => {
  const originalApiKey = process.env.SENDGRID_API_KEY;
  const originalPortal = process.env.PUBLIC_PORTAL_URL;
  const portal = 'https://portal.wavespestcontrol.com';
  const untracked = [
    `<a href="${portal}/l/wpc-2026-0042-0507-k3j9abcd2x">Pay invoice</a>`,
    `<a style="color:#fff" href="${portal}/?tab=billing">Billing</a>`,
    `<a href='http://portal.wavespestcontrol.com/report/0f3a9c'>Report</a>`,
    `<a href=${portal}/secure/tok123>Add card</a>`,
    `<a href="${portal}/login">Sign in</a>`,
    `<a href="${portal}/estimate/0f3a9c4b2d7e?website=1">Your estimate</a>`,
  ];
  const tracked = [
    '<a href="https://www.wavespestcontrol.com/app/">Get the app</a>',
    `<a href="${portal}/quote">Get a quote</a>`,
    `<a href="${portal}/estimate/lawn">Lawn quote</a>`,
    `<a href="${portal}/api/reports/0f3a9c/pdf">PDF</a>`,
    `<a href="${portal}/app-email/videos/waves-pest-tour.mp4">Video</a>`,
    `<a href="${portal}/card/tok123">Business card</a>`,
    `<a href="${portal}/r/WAVES25">Refer a friend</a>`,
    `<a href="${portal}/admin/invoices">Staff page</a>`,
    '<a href="https://portal.example.test/l/abc">Other host</a>',
    '<a clicktracking=off href="https://www.wavespestcontrol.com/">Already set</a>',
    '<abbr title="Waves">W</abbr>',
  ];

  beforeEach(() => {
    jest.resetModules();
    process.env.SENDGRID_API_KEY = 'SG.test-key';
    process.env.PUBLIC_PORTAL_URL = portal;
    global.fetch = jest.fn(async () => ({
      ok: true,
      headers: { get: jest.fn(() => 'msg-1') },
    }));
  });

  afterEach(() => {
    delete global.fetch;
    if (originalApiKey === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = originalApiKey;
    if (originalPortal === undefined) delete process.env.PUBLIC_PORTAL_URL;
    else process.env.PUBLIC_PORTAL_URL = originalPortal;
  });

  test('only portal customer-page anchors get clicktracking=off, ahead of href', () => {
    const { untrackAppLinks } = require('../services/messaging/email-link-policy');
    const out = untrackAppLinks([...untracked, ...tracked].join('\n')).split('\n');
    expect(out.slice(0, untracked.length)).toEqual(untracked.map((tag) => tag.replace(/^<a /, '<a clicktracking=off ')));
    expect(out.slice(untracked.length)).toEqual(tracked);
  });

  test('sendOne keeps click tracking on and sends the marked anchors', async () => {
    // The annual-offer guard reads portal links from the DB; this case is about the anchors only.
    jest.doMock('../services/estimate-annual-guard', () => ({
      annualHandoffGuard: () => async () => ({ blocked: false }),
      withheldLinkPolicyForTemplate: () => null,
    }));
    const sendgrid = require('../services/sendgrid-mail');
    await sendgrid.sendOne({
      to: 'customer@example.test',
      fromEmail: 'contact@example.test',
      subject: 'Invoice',
      html: `<p>${untracked[0]} ${tracked[0]}</p>`,
      suppressErrorLog: true,
    });

    const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(payload.tracking_settings.click_tracking).toEqual({ enable: true, enable_text: false });
    expect(payload.content).toEqual([{ type: 'text/html', value: `<p><a clicktracking=off ${untracked[0].slice(3)} ${tracked[0]}</p>` }]);
  });
});

describe('SendGrid unconfigured error classification', () => {
  const originalApiKey = process.env.SENDGRID_API_KEY;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.SENDGRID_API_KEY;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
    if (originalApiKey === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = originalApiKey;
  });

  test('a pre-request auth failure carries SENDGRID_NOT_CONFIGURED and never calls fetch', async () => {
    const sendgrid = require('../services/sendgrid-mail');
    await expect(sendgrid.clearBlockedAddress('customer@example.test')).rejects.toMatchObject({
      message: 'SENDGRID_API_KEY not configured',
      code: 'SENDGRID_NOT_CONFIGURED',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

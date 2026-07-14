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
});

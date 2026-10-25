jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({ messageId: 'msg-1' })),
}));
jest.mock('../services/logger', () => ({ info: jest.fn() }));

const sendgrid = require('../services/sendgrid-mail');
const logger = require('../services/logger');
const { staffPasswordResetUrl } = require('../services/staff-password-reset-email');
const { HIRE_LINK_TTL_DAYS, formatFirstDay, sendStaffWelcomeEmail } = require('../services/staff-welcome-email');

describe('staff welcome email', () => {
  const originalOrigin = process.env.STAFF_PASSWORD_RESET_ORIGIN;
  const originalNodeEnv = process.env.NODE_ENV;
  const token = 'T'.repeat(43);

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.STAFF_PASSWORD_RESET_ORIGIN = 'https://staff.example.test';
    jest.clearAllMocks();
    sendgrid.isConfigured.mockReturnValue(true);
  });

  afterAll(() => {
    if (originalOrigin === undefined) delete process.env.STAFF_PASSWORD_RESET_ORIGIN;
    else process.env.STAFF_PASSWORD_RESET_ORIGIN = originalOrigin;
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('the link is the staff reset URL, in the fragment, in both versions', async () => {
    await sendStaffWelcomeEmail({
      technicianId: 'tech-1', email: 'casey@example.test', token, firstName: 'Casey', firstDay: '2027-01-04',
    });
    const sent = sendgrid.sendOne.mock.calls[0][0];
    const url = staffPasswordResetUrl(token);
    expect(url).toBe(`https://staff.example.test/admin/reset-password#token=${token}`);
    expect(sent.html).toContain(url);
    expect(sent.text).toContain(url);
    expect(sent).toMatchObject({
      to: 'casey@example.test',
      subject: 'Welcome to Waves Pest Control',
      categories: ['staff_welcome'],
      asmGroupId: 0,
      suppressErrorLog: true,
      disableTracking: true,
    });
  });

  test('copy: heading, greeting, first day, button and seven-day footer', async () => {
    await sendStaffWelcomeEmail({
      technicianId: 'tech-1', email: 'casey@example.test', token, firstName: 'Casey', firstDay: '2027-01-04',
    });
    const { html, text } = sendgrid.sendOne.mock.calls[0][0];
    expect(html).toContain('Welcome to Waves Pest Control');
    expect(html).toContain('Set your password');
    expect(html).toContain('Hi Casey, set your password to open the Waves staff app. Then complete the documents on your Onboarding card before your first day, Monday, January 4.');
    expect(text).toContain('Hi Casey, set your password to open the Waves staff app. Then complete the documents on your Onboarding card before your first day, Monday, January 4.');
    expect(html).toContain('This link works for 7 days. If it expires, ask the office to send a new one.');
    expect(text).toContain('This link works for 7 days. If it expires, ask the office to send a new one.');
    expect(HIRE_LINK_TTL_DAYS).toBe(7);
  });

  test('first day is a calendar date: no timezone shift for a date string or a local-midnight Date', () => {
    expect(formatFirstDay('2027-01-04')).toBe('Monday, January 4');
    expect(formatFirstDay('2027-12-31')).toBe('Friday, December 31');
    expect(formatFirstDay(new Date(2027, 0, 4))).toBe('Monday, January 4');
    expect(formatFirstDay('2027-03-14T00:00:00.000Z')).toBe('Sunday, March 14');
    expect(formatFirstDay(null)).toBeNull();
    expect(formatFirstDay('garbage')).toBeNull();
  });

  test('escapes the name and falls back when there is no name or date', async () => {
    await sendStaffWelcomeEmail({
      technicianId: 'tech-1', email: 'casey@example.test', token, firstName: '<b>X</b>', firstDay: null,
    });
    let sent = sendgrid.sendOne.mock.calls[0][0];
    expect(sent.html).not.toContain('<b>X</b>');
    expect(sent.html).toContain('&lt;b&gt;X&lt;/b&gt;');
    await sendStaffWelcomeEmail({ technicianId: 'tech-1', email: 'casey@example.test', token, firstName: '', firstDay: undefined });
    sent = sendgrid.sendOne.mock.calls[1][0];
    expect(sent.text).toContain('Hi there, set your password');
    expect(sent.text).toContain('before your first day.');
  });

  test('logs the technician id and message id, never the token, link or address', async () => {
    await sendStaffWelcomeEmail({
      technicianId: 'tech-1', email: 'casey@example.test', token, firstName: 'Casey', firstDay: '2027-01-04',
    });
    const logged = JSON.stringify(logger.info.mock.calls);
    expect(logged).toContain('tech-1');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain('casey@example.test');
    expect(logged).not.toContain('reset-password');
  });

  test('a failure before the provider call is marked definitelyNotQueued', async () => {
    sendgrid.isConfigured.mockReturnValue(false);
    await expect(sendStaffWelcomeEmail({ technicianId: 't', email: 'a@example.test', token }))
      .rejects.toMatchObject({ definitelyNotQueued: true });
    sendgrid.isConfigured.mockReturnValue(true);
    process.env.STAFF_PASSWORD_RESET_ORIGIN = 'http://insecure.example.test';
    await expect(sendStaffWelcomeEmail({ technicianId: 't', email: 'a@example.test', token }))
      .rejects.toMatchObject({ definitelyNotQueued: true });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    await expect(sendStaffWelcomeEmail({ technicianId: 't', email: '', token }))
      .rejects.toThrow(/missing required fields/);
  });

  test('a provider error passes through untouched for the caller to classify', async () => {
    sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('upstream'), { status: 503 }));
    await expect(sendStaffWelcomeEmail({ technicianId: 't', email: 'a@example.test', token }))
      .rejects.toMatchObject({ status: 503 });
  });
});

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/email', () => ({
  send: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
}));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const EmailService = require('../services/email');
const EmailTemplateLibrary = require('../services/email-template-library');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const OnboardingFollowUp = require('../services/onboarding-follow-up');

function chain({ result = [] } = {}) {
  const q = {};
  [
    'leftJoin',
    'whereNot',
    'whereNotNull',
    'orWhereNotNull',
    'orWhereNull',
    'whereBetween',
    'select',
  ].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.where = jest.fn((arg) => {
    if (typeof arg === 'function') arg(q);
    return q;
  });
  q.update = jest.fn(async () => 1);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
}

describe('onboarding follow-up emails', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('marks suppressed email-only template follow-ups as attempted', async () => {
    const session = {
      id: 'onboarding-1',
      token: 'token-1',
      customer_id: 'customer-1',
      status: 'started',
      started_at: new Date('2026-05-17T12:00:00.000Z'),
      expires_at: new Date('2026-05-25T12:00:00.000Z'),
      waveguard_tier: 'Gold',
      first_name: 'Sam',
      phone: null,
      email: 'sam@example.com',
    };
    const update24h = chain();
    setDbQueues({
      onboarding_sessions: [
        chain({ result: [session] }),
        update24h,
        chain({ result: [] }),
        chain({ result: [] }),
      ],
    });
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({
      sent: false,
      blocked: true,
      reason: 'Suppressed: manual (service_operational)',
      message: { id: 'msg-blocked', status: 'blocked' },
    });

    const result = await OnboardingFollowUp.checkAll();

    expect(result.sent).toBe(1);
    expect(update24h.update).toHaveBeenCalledWith({ followup_24h_sent: true });
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'onboarding.24h_reminder',
      to: 'sam@example.com',
    }));
    expect(EmailService.send).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('does not mark dual-channel follow-ups sent when SMS fails and email is suppressed', async () => {
    const session = {
      id: 'onboarding-2',
      token: 'token-2',
      customer_id: 'customer-2',
      status: 'started',
      started_at: new Date('2026-05-17T12:00:00.000Z'),
      expires_at: new Date('2026-05-25T12:00:00.000Z'),
      waveguard_tier: 'Gold',
      first_name: 'Sam',
      phone: '+15555550100',
      email: 'sam@example.com',
    };
    const updateOrNextQuery = chain();
    setDbQueues({
      onboarding_sessions: [
        chain({ result: [session] }),
        updateOrNextQuery,
        chain({ result: [] }),
        chain({ result: [] }),
      ],
    });
    smsTemplatesRouter.getTemplate.mockResolvedValue('Finish your Waves onboarding setup.');
    sendCustomerMessage.mockResolvedValue({
      sent: false,
      reason: 'temporary carrier failure',
    });
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({
      sent: false,
      blocked: true,
      reason: 'Suppressed: manual (service_operational)',
      message: { id: 'msg-blocked', status: 'blocked' },
    });

    const result = await OnboardingFollowUp.checkAll();

    expect(result.sent).toBe(0);
    expect(updateOrNextQuery.update).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalled();
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'onboarding.24h_reminder',
      to: 'sam@example.com',
    }));
    expect(EmailService.send).not.toHaveBeenCalled();
  });
});

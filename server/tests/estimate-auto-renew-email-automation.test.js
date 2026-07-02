const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
const mockSendCustomerMessage = jest.fn();
const mockShorten = jest.fn();
const mockProcessTrigger = jest.fn();
const mockSendTemplate = jest.fn();
const mockEmailSend = jest.fn();
const mockIsConfigured = jest.fn();
const mockIsEnabled = jest.fn();
const mockGetTemplate = jest.fn();

function query(result) {
  const chain = {
    where: jest.fn(() => chain),
    whereIn: jest.fn(() => chain),
    whereNull: jest.fn(() => chain),
    whereNotNull: jest.fn(() => chain),
    orWhereNull: jest.fn(() => chain),
    orWhereNotNull: jest.fn(() => chain),
    update: jest.fn(async () => 1),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    catch: (reject) => Promise.resolve(result).catch(reject),
  };
  return chain;
}

const mockDb = jest.fn((table) => {
  if (table === 'estimates') return mockDb.__estimateQueries.shift();
  throw new Error(`Unexpected table ${table}`);
});
mockDb.__estimateQueries = [];
mockDb.raw = jest.fn((sql) => sql);

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => mockLogger);
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: mockSendCustomerMessage,
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: mockShorten,
}));
jest.mock('../services/email-template-automation-executor', () => ({
  processTrigger: mockProcessTrigger,
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: mockSendTemplate,
}));
jest.mock('../services/email', () => ({
  send: mockEmailSend,
}));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: mockIsConfigured,
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: mockIsEnabled,
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: mockGetTemplate,
}));

const EstimateAutoRenew = require('../services/estimate-auto-renew');

function staleEstimate(overrides = {}) {
  return {
    id: 'estimate-1',
    token: 'estimate-token',
    customer_id: 'customer-1',
    customer_name: 'Sam Customer',
    customer_phone: null,
    customer_email: 'sam@example.com',
    status: 'sent',
    created_at: '2026-05-01T12:00:00.000Z',
    renewal_count: 0,
    ...overrides,
  };
}

describe('estimate auto-renew email automation cutover', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.__estimateQueries = [];
    mockShorten.mockResolvedValue('https://portal.example/estimate/short');
    mockIsConfigured.mockReturnValue(true);
    mockIsEnabled.mockReturnValue(true);
    mockProcessTrigger.mockResolvedValue({
      automation_count: 1,
      results: [{ run: { id: 'run-1', status: 'sent' } }],
    });
    mockSendTemplate.mockResolvedValue({ sent: true, message: { id: 'message-1' } });
  });

  test('uses the email template automation executor when the gate is enabled', async () => {
    const estimate = staleEstimate();
    mockDb.__estimateQueries.push(query([estimate]), query(1));

    await expect(EstimateAutoRenew.checkAll()).resolves.toEqual({ renewed: 1 });

    expect(mockProcessTrigger).toHaveBeenCalledWith(expect.objectContaining({
      triggerEventKey: 'estimate.auto_renewed',
      triggerEventId: 'estimate_auto_renew:estimate-1',
      entityType: 'estimate',
      entityId: 'estimate-1',
      recipient: {
        email: 'sam@example.com',
        type: 'customer',
        id: 'customer-1',
      },
      executeImmediately: true,
      payload: expect.objectContaining({
        estimate_id: 'estimate-1',
        customer_id: 'customer-1',
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        estimate_url: 'https://portal.example/estimate/short',
        estimate_status: 'sent',
        status: 'sent',
        renewal_count: 1,
      }),
    }));
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  test('keeps the direct template send fallback when the automation gate is disabled', async () => {
    mockIsEnabled.mockReturnValue(false);
    const estimate = staleEstimate();
    mockDb.__estimateQueries.push(query([estimate]), query(1));

    await expect(EstimateAutoRenew.checkAll()).resolves.toEqual({ renewed: 1 });

    expect(mockProcessTrigger).not.toHaveBeenCalled();
    expect(mockSendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'estimate.extension_notice',
      to: 'sam@example.com',
      recipientType: 'customer',
      recipientId: 'customer-1',
      triggerEventId: 'estimate_auto_renew:estimate-1',
      categories: ['estimate_auto_renew'],
      payload: expect.objectContaining({
        estimate_id: 'estimate-1',
        new_expires_at: expect.any(String),
      }),
    }));
  });
});

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(),
}));
jest.mock('../services/automation-runner', () => ({
  enrollCustomer: jest.fn(),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const smsTemplates = require('../routes/admin-sms-templates');
const AutomationRunner = require('../services/automation-runner');
const EmailAutomationService = require('../services/email-automations');

function query({ first } = {}) {
  const q = {
    where: jest.fn(() => q),
    first: jest.fn(async () => first),
    insert: jest.fn(async () => [1]),
  };
  return q;
}

describe('email automation SMS template governance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AutomationRunner.enrollCustomer.mockResolvedValue({ enrolled: true });
  });

  test('defines SMS companions by template key only', () => {
    expect(EmailAutomationService.AUTOMATIONS.new_recurring.smsTemplateKey).toBe('auto_new_recurring');
    expect(EmailAutomationService.AUTOMATIONS.lawn_service.smsTemplateKey).toBeUndefined();
    expect(EmailAutomationService.AUTOMATIONS.new_appointment.smsTemplateKey).toBe('auto_new_appointment');
    expect(EmailAutomationService.AUTOMATIONS.bed_bug.smsTemplateKey).toBe('auto_bed_bug');
    expect(EmailAutomationService.AUTOMATIONS.cockroach.smsTemplateKey).toBe('auto_cockroach');
    expect(EmailAutomationService.AUTOMATIONS.service_renewal.smsTemplateKey).toBe('auto_service_renewal');

    for (const auto of Object.values(EmailAutomationService.AUTOMATIONS)) {
      expect(auto.smsTemplate).toBeUndefined();
    }
  });

  test('skips SMS companion when DB template is missing instead of using inline fallback copy', async () => {
    const logQuery = query();
    db.mockImplementation((table) => {
      if (table === 'email_automation_log') return logQuery;
      throw new Error(`Unexpected table ${table}`);
    });
    smsTemplates.getTemplate.mockResolvedValue(null);

    const result = await EmailAutomationService.executeAutomation(
      'new_recurring',
      EmailAutomationService.AUTOMATIONS.new_recurring,
      {
        id: 'cust-1',
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@example.test',
        phone: '+19415550123',
      },
    );

    expect(smsTemplates.getTemplate).toHaveBeenCalledWith('auto_new_recurring', {
      first_name: 'Ada',
      last_name: 'Lovelace',
    }, {
      workflow: 'email_automation_sms',
      entity_type: 'customer',
      entity_id: 'cust-1',
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[email-auto] SMS template auto_new_recurring missing/disabled; SMS companion skipped for new_recurring customer cust-1',
    );
    expect(result.sms).toMatchObject({
      sent: false,
      skipped: true,
      reason: 'template-missing',
      template_key: 'auto_new_recurring',
    });
  });

  test('sends SMS companion when DB template renders', async () => {
    const logQuery = query();
    db.mockImplementation((table) => {
      if (table === 'email_automation_log') return logQuery;
      throw new Error(`Unexpected table ${table}`);
    });
    smsTemplates.getTemplate.mockResolvedValue('Welcome Ada from Waves.');
    sendCustomerMessage.mockResolvedValue({ sent: true });

    const result = await EmailAutomationService.executeAutomation(
      'new_recurring',
      EmailAutomationService.AUTOMATIONS.new_recurring,
      {
        id: 'cust-1',
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@example.test',
        phone: '+19415550123',
      },
    );

    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      body: 'Welcome Ada from Waves.',
      entryPoint: 'email_automation_sms',
      metadata: expect.objectContaining({
        original_message_type: 'auto_new_recurring',
        automation_key: 'new_recurring',
      }),
    }));
    expect(result.sms).toEqual({ sent: true });
  });
});

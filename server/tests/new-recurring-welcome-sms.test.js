const mockSendCustomerMessage = jest.fn();
const mockGetTemplate = jest.fn();
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

let mockSequenceExists = false;
let mockPriorRecurringSeries = null;
let mockPriorServiceRecord = null;
let mockInserts = [];

const mockDb = jest.fn((table) => {
  const chain = {
    where: jest.fn(() => chain),
    whereNot: jest.fn(() => chain),
    first: jest.fn(async () => {
      if (table === 'scheduled_services') {
        return mockPriorRecurringSeries;
      }
      if (table === 'service_records') {
        return mockPriorServiceRecord;
      }
      if (table === 'sms_sequences') {
        return mockSequenceExists ? { id: 'seq-1' } : null;
      }
      return null;
    }),
    columnInfo: jest.fn(async () => {
      if (table === 'sms_sequences') {
        return {
          customer_id: {},
          sequence_type: {},
          status: {},
          step: {},
          metadata: {},
        };
      }
      if (table === 'customer_interactions') {
        return {
          customer_id: {},
          interaction_type: {},
          subject: {},
          body: {},
          admin_user_id: {},
          metadata: {},
        };
      }
      return {};
    }),
    insert: jest.fn(async (data) => {
      mockInserts.push({ table, data });
      if (table === 'sms_sequences') mockSequenceExists = true;
      return [data];
    }),
  };
  return chain;
});

mockDb.schema = {
  hasTable: jest.fn(async (table) => ['sms_sequences', 'customer_interactions'].includes(table)),
};

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => mockLogger);
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: mockSendCustomerMessage,
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: mockGetTemplate,
}));

describe('new recurring welcome SMS', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSequenceExists = false;
    mockPriorRecurringSeries = null;
    mockPriorServiceRecord = null;
    mockInserts = [];
    service = require('../services/new-recurring-welcome-sms');
  });

  test('treats prior service history as not a new recurring signup', async () => {
    await expect(service.isNewRecurringSignupCandidate('customer-1')).resolves.toBe(true);

    mockPriorServiceRecord = { id: 'record-1' };
    await expect(service.isNewRecurringSignupCandidate('customer-1')).resolves.toBe(false);

    mockPriorServiceRecord = null;
    mockPriorRecurringSeries = { id: 'series-1' };
    await expect(service.isNewRecurringSignupCandidate('customer-1')).resolves.toBe(false);
  });

  test('sends the auto_new_recurring template and marks the welcome sequence', async () => {
    mockGetTemplate.mockResolvedValue('Hello Ada! Welcome to Waves!');
    mockSendCustomerMessage.mockResolvedValue({
      sent: true,
      auditLogId: 'audit-1',
      providerMessageId: 'SM123',
    });

    const result = await service.sendNewRecurringWelcome({
      customer: {
        id: 'customer-1',
        first_name: 'Ada',
        phone: '(941) 555-1234',
      },
      scheduledServiceId: 'svc-1',
      recurringPattern: 'quarterly',
      entryPoint: 'admin_recurring_appointment_created',
      adminUserId: 'tech-1',
    });

    expect(result.sent).toBe(true);
    expect(mockGetTemplate).toHaveBeenCalledWith('auto_new_recurring', { first_name: 'Ada' });
    expect(mockSendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '(941) 555-1234',
      body: 'Hello Ada! Welcome to Waves!',
      channel: 'sms',
      audience: 'customer',
      purpose: 'appointment',
      customerId: 'customer-1',
      appointmentId: 'svc-1',
      identityTrustLevel: 'service_contact_authorized',
      entryPoint: 'admin_recurring_appointment_created',
      metadata: expect.objectContaining({
        original_message_type: 'auto_new_recurring',
        template_key: 'auto_new_recurring',
        scheduled_service_id: 'svc-1',
        recurring_pattern: 'quarterly',
        adminUserId: 'tech-1',
      }),
    }));
    expect(mockInserts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'sms_sequences',
        data: expect.objectContaining({
          customer_id: 'customer-1',
          sequence_type: 'new_customer_welcome',
          status: 'completed',
        }),
      }),
      expect.objectContaining({
        table: 'customer_interactions',
        data: expect.objectContaining({
          customer_id: 'customer-1',
          interaction_type: 'sms_outbound',
          subject: 'New recurring welcome SMS sent',
          admin_user_id: 'tech-1',
        }),
      }),
    ]));
  });

  test('does not send when the customer already has the welcome sequence', async () => {
    mockSequenceExists = true;

    const result = await service.sendNewRecurringWelcome({
      customer: {
        id: 'customer-1',
        first_name: 'Ada',
        phone: '(941) 555-1234',
      },
      scheduledServiceId: 'svc-1',
    });

    expect(result).toEqual({ sent: false, skipped: true, reason: 'already_sent' });
    expect(mockGetTemplate).not.toHaveBeenCalled();
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mockInserts).toEqual([]);
  });
});

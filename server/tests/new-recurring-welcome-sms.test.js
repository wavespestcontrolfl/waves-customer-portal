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
let mockDueSequences = [];
let mockStaleSequences = [];
let mockSmsLogProviderRow = null;
let mockClaimResults = []; // shift()ed per sms_sequences update; empty = always 1
let mockCustomerRow = null;
let mockScheduledServiceRow = null;
let mockInserts = [];
let mockUpdates = [];

const mockDb = jest.fn((table) => {
  const wheres = [];
  const chain = {
    where: jest.fn((arg) => { wheres.push(arg); return chain; }),
    whereNot: jest.fn(() => chain),
    whereIn: jest.fn(() => chain),
    whereNotNull: jest.fn(() => chain),
    limit: jest.fn(async () => {
      if (table === 'sms_sequences') {
        // The sweep runs two scans over this table — stale-claim recovery
        // (status 'sending') and due delivery (status 'active').
        const statusFilter = wheres.find((w) => w && typeof w === 'object' && 'status' in w)?.status;
        return statusFilter === 'sending' ? mockStaleSequences : mockDueSequences;
      }
      return [];
    }),
    first: jest.fn(async () => {
      if (table === 'scheduled_services') {
        return mockScheduledServiceRow !== null
          ? mockScheduledServiceRow
          : mockPriorRecurringSeries;
      }
      if (table === 'service_records') {
        return mockPriorServiceRecord;
      }
      if (table === 'sms_sequences') {
        return mockSequenceExists ? { id: 'seq-1' } : null;
      }
      if (table === 'customers') {
        return mockCustomerRow;
      }
      if (table === 'sms_log') {
        return mockSmsLogProviderRow;
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
          next_send_at: {},
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
    update: jest.fn(async (data) => {
      mockUpdates.push({ table, data, wheres: [...wheres] });
      if (table === 'sms_sequences' && mockClaimResults.length) return mockClaimResults.shift();
      return 1;
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
    mockDueSequences = [];
    mockStaleSequences = [];
    mockSmsLogProviderRow = null;
    mockClaimResults = [];
    mockCustomerRow = null;
    mockScheduledServiceRow = null;
    mockInserts = [];
    mockUpdates = [];
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

  test('queues the welcome with a delivery delay instead of sending inline', async () => {
    const before = Date.now();
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

    expect(result).toEqual({ sent: false, queued: true });
    // Nothing texts at booking time — the confirmation SMS owns that moment.
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mockGetTemplate).not.toHaveBeenCalled();

    expect(mockInserts).toHaveLength(1);
    const { table, data } = mockInserts[0];
    expect(table).toBe('sms_sequences');
    expect(data).toEqual(expect.objectContaining({
      customer_id: 'customer-1',
      sequence_type: 'new_customer_welcome',
      status: 'active',
    }));
    const delayMs = data.next_send_at.getTime() - before;
    expect(delayMs).toBeGreaterThanOrEqual((service.WELCOME_DELAY_MINUTES - 1) * 60 * 1000);
    const meta = JSON.parse(data.metadata);
    expect(meta).toEqual(expect.objectContaining({
      template_key: 'auto_new_recurring',
      scheduled_service_id: 'svc-1',
      recurring_pattern: 'quarterly',
      entry_point: 'admin_recurring_appointment_created',
      admin_user_id: 'tech-1',
    }));
  });

  test('does not queue when the customer already has the welcome sequence', async () => {
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

  test('processDueWelcomes delivers a due queued welcome', async () => {
    mockDueSequences = [{
      id: 'seq-1',
      customer_id: 'customer-1',
      step: 0,
      metadata: JSON.stringify({
        template_key: 'auto_new_recurring',
        scheduled_service_id: 'svc-1',
        recurring_pattern: 'quarterly',
        entry_point: 'admin_recurring_appointment_created',
        admin_user_id: 'tech-1',
      }),
    }];
    mockCustomerRow = { id: 'customer-1', first_name: 'Ada', phone: '(941) 555-1234' };
    mockScheduledServiceRow = { status: 'pending' };
    mockGetTemplate.mockResolvedValue('Hello Ada! Welcome to Waves!');
    mockSendCustomerMessage.mockResolvedValue({
      sent: true,
      auditLogId: 'audit-1',
      providerMessageId: 'SM123',
    });

    const results = await service.processDueWelcomes();

    expect(results.sent).toBe(1);
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
    // Row completes and the interaction is logged.
    expect(mockUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'sms_sequences',
        data: expect.objectContaining({ status: 'completed' }),
      }),
    ]));
    expect(mockInserts).toEqual(expect.arrayContaining([
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

  test('processDueWelcomes requeues a retryable provider failure instead of cancelling', async () => {
    mockDueSequences = [{
      id: 'seq-1',
      customer_id: 'customer-1',
      step: 0,
      metadata: JSON.stringify({ scheduled_service_id: 'svc-1' }),
    }];
    mockCustomerRow = { id: 'customer-1', first_name: 'Ada', phone: '(941) 555-1234' };
    mockScheduledServiceRow = { status: 'pending' };
    mockGetTemplate.mockResolvedValue('Hello Ada! Welcome to Waves!');
    mockSendCustomerMessage.mockResolvedValue({ sent: false, retryable: true, code: 'PROVIDER_FAILURE' });

    const results = await service.processDueWelcomes();

    expect(results.sent).toBe(0);
    // Claimed as 'sending' before dispatch, released back to 'active' with a
    // pushed-out next_send_at — never cancelled or completed.
    const statusUpdates = mockUpdates.filter((u) => u.table === 'sms_sequences' && 'status' in u.data);
    expect(statusUpdates.map((u) => u.data.status)).toEqual(['sending', 'active']);
    const requeue = mockUpdates.find((u) => u.table === 'sms_sequences' && 'next_send_at' in u.data);
    expect(requeue).toBeTruthy();
    expect(requeue.data.status).toBe('active');
  });

  test('processDueWelcomes retries CONSENT_LOOKUP_FAILED instead of burning the once-ever guard', async () => {
    mockDueSequences = [{
      id: 'seq-1',
      customer_id: 'customer-1',
      step: 0,
      metadata: JSON.stringify({ scheduled_service_id: 'svc-1' }),
    }];
    mockCustomerRow = { id: 'customer-1', first_name: 'Ada', phone: '(941) 555-1234' };
    mockScheduledServiceRow = { status: 'pending' };
    mockGetTemplate.mockResolvedValue('Hello Ada! Welcome to Waves!');
    // Transient prefs/customer lookup DB blip — retry-advised by contract but
    // carries no retryable/deferred/nextAllowedAt metadata.
    mockSendCustomerMessage.mockResolvedValue({ sent: false, code: 'CONSENT_LOOKUP_FAILED' });

    const results = await service.processDueWelcomes();

    expect(results.sent).toBe(0);
    // Released for retry — a cancelled row would permanently block the
    // welcome via hasWelcomeSequence's once-ever guard.
    const statusUpdates = mockUpdates.filter((u) => u.table === 'sms_sequences' && 'status' in u.data);
    expect(statusUpdates.map((u) => u.data.status)).toEqual(['sending', 'active']);
    const requeue = mockUpdates.find((u) => u.table === 'sms_sequences' && 'next_send_at' in u.data);
    expect(requeue.data.next_send_at).toBeInstanceOf(Date);
  });

  test('processDueWelcomes schedules quiet-hours holds at nextAllowedAt without burning an attempt', async () => {
    mockDueSequences = [{
      id: 'seq-1',
      customer_id: 'customer-1',
      step: 0,
      metadata: JSON.stringify({ scheduled_service_id: 'svc-1' }),
    }];
    mockCustomerRow = { id: 'customer-1', first_name: 'Ada', phone: '(941) 555-1234' };
    mockScheduledServiceRow = { status: 'pending' };
    mockGetTemplate.mockResolvedValue('Hello Ada! Welcome to Waves!');
    const nextAllowedAt = '2026-07-07T12:00:00.000Z';
    mockSendCustomerMessage.mockResolvedValue({ sent: false, retryable: true, code: 'QUIET_HOURS_HOLD', nextAllowedAt });

    await service.processDueWelcomes();

    const requeue = mockUpdates.find((u) => u.table === 'sms_sequences' && 'next_send_at' in u.data);
    expect(requeue.data.next_send_at.toISOString()).toBe(nextAllowedAt);
    // Legal-window hold refunds the attempt so overnight holds can't
    // exhaust MAX_DELIVERY_ATTEMPTS before 8am.
    expect(requeue.data.step).toBe(0);
    // Claim → release only; never cancelled or completed.
    const statusUpdates = mockUpdates.filter((u) => u.table === 'sms_sequences' && 'status' in u.data);
    expect(statusUpdates.map((u) => u.data.status)).toEqual(['sending', 'active']);
  });

  test('processDueWelcomes claims the row before dispatch and skips on a claim miss', async () => {
    mockDueSequences = [{
      id: 'seq-1',
      customer_id: 'customer-1',
      step: 0,
      metadata: JSON.stringify({ scheduled_service_id: 'svc-1' }),
    }];
    mockCustomerRow = { id: 'customer-1', first_name: 'Ada', phone: '(941) 555-1234' };
    mockScheduledServiceRow = { status: 'pending' };
    mockGetTemplate.mockResolvedValue('Hello Ada! Welcome to Waves!');
    mockSendCustomerMessage.mockResolvedValue({ sent: true });
    // Another worker won the claim (0 rows updated) — this sweep must not text.
    mockClaimResults = [0];

    const results = await service.processDueWelcomes();

    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(results.sent).toBe(0);
    // The claim carried the status flip + attempt count in one atomic update,
    // guarded on status='active'.
    const claim = mockUpdates.find((u) => u.table === 'sms_sequences' && u.data.status === 'sending');
    expect(claim).toBeTruthy();
    expect(claim.data.step).toBe(1);
    expect(claim.wheres).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'active' })]));
  });

  test('stale-claim recovery settles as completed when a provider row proves the send, else releases', async () => {
    // Crash after Twilio accepted: provider sms_log row exists → completed,
    // never re-sent.
    mockStaleSequences = [{ id: 'seq-stale', customer_id: 'customer-1', step: 1 }];
    mockSmsLogProviderRow = { id: 'sms-1' };

    await service.processDueWelcomes();

    let recovery = mockUpdates.find((u) => u.table === 'sms_sequences' && u.data.status === 'completed');
    expect(recovery).toBeTruthy();
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();

    // Crash before Twilio accepted: no provider row → released for retry.
    mockUpdates = [];
    mockSmsLogProviderRow = null;

    await service.processDueWelcomes();

    recovery = mockUpdates.find((u) => u.table === 'sms_sequences' && u.data.status === 'active');
    expect(recovery).toBeTruthy();
    expect(recovery.data.next_send_at).toBeInstanceOf(Date);
  });

  test('processDueWelcomes drops the welcome when the appointment was cancelled', async () => {
    mockDueSequences = [{
      id: 'seq-1',
      customer_id: 'customer-1',
      step: 0,
      metadata: JSON.stringify({ scheduled_service_id: 'svc-1' }),
    }];
    mockCustomerRow = { id: 'customer-1', first_name: 'Ada', phone: '(941) 555-1234' };
    mockScheduledServiceRow = { status: 'cancelled' };

    const results = await service.processDueWelcomes();

    expect(results.sent).toBe(0);
    expect(results.skipped).toBe(1);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mockUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'sms_sequences',
        data: expect.objectContaining({ status: 'cancelled' }),
      }),
    ]));
  });
});

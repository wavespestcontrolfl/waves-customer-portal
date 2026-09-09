const mockSend = jest.fn();
const mockContext = jest.fn(async customer => ({ customerId: customer.id }));
const mockPipeline = jest.fn();
const mockMessage = jest.fn();
jest.mock('../services/twilio', () => ({ sendSMS: mockSend }));
jest.mock('../services/context-aggregator', () => ({ getContextForCustomer: mockContext }));
jest.mock('../services/pipeline-manager', () => ({ onEvent: mockPipeline }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: mockMessage }));
jest.mock('../services/short-url', () => ({}));
jest.mock('../services/pricing-authority-gate', () => ({}));
jest.mock('../services/estimate-automation-duplicates', () => ({
  blockIfAutomatedEstimateDuplicate: async () => null,
  withAutomatedEstimatePhoneLock: async (_phone, callback, { database }) => callback(database),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn() }));
const mockState = {};
const mockDb = jest.fn(table => {
  const filters = {};
  let invocation;
  const builder = {
    where: jest.fn((key, value) => { Object.assign(filters, typeof key === 'object' ? key : { [key]: value }); return builder; }),
    whereIn: jest.fn(() => builder),
    whereNull: jest.fn(key => { filters[key] = null; return builder; }),
    whereRaw: jest.fn((_sql, bindings) => { invocation = bindings; return builder; }),
    forUpdate: jest.fn(() => builder),
    forNoKeyUpdate: jest.fn(() => builder),
    first: jest.fn(async () => {
      const row = table === 'leads' ? mockState.lead : table === 'customers' ? mockState.customer : mockState.activity;
      if (row && invocation) {
        const metadata = JSON.parse(row.metadata);
        if (metadata.sessionId !== invocation[0] || metadata.toolUseId !== invocation[1]) return undefined;
      }
      return row && Object.entries(filters).every(([key, value]) => (row[key] ?? null) === value) ? row : undefined;
    }),
    insert: jest.fn(value => {
      if (mockState.insertFails) throw new Error('storage unavailable');
      mockState.activity = { id: `activity-${++mockState.inserts}`, ...value };
      return { returning: async () => [mockState.activity] };
    }),
    update: jest.fn(async value => {
      if (table === 'lead_activities' && mockState.activity) {
        const metadata = JSON.parse(mockState.activity.metadata);
        if (typeof value.metadata === 'string') mockState.activity.metadata = value.metadata;
        else {
          delete metadata.alertClaimToken; delete metadata.alertLeaseUntil;
          mockState.activity.metadata = JSON.stringify({ ...metadata, alertStatus: value.metadata.bindings[0] });
        }
      }
      return 1;
    }),
  };
  return builder;
});
mockDb.transaction = jest.fn(async callback => callback(mockDb));
mockDb.raw = (sql, bindings) => ({ sql, bindings });
jest.mock('../models/db', () => mockDb);
const { executeLeadTool } = require('../services/lead-response-tools');
const context = { leadId: '00000000-0000-4000-8000-000000000001', customerId: '00000000-0000-4000-8000-000000000002', sessionId: 'session-1', toolUseId: 'tool-1' };
beforeEach(() => {
  jest.clearAllMocks();
  mockState.lead = { id: context.leadId, customer_id: context.customerId, phone: '+19415550100' };
  mockState.customer = { id: context.customerId, phone: '+19415550100' };
  mockState.activity = null;
  mockState.inserts = 0;
  mockState.insertFails = false;
  process.env.ADAM_PHONE = '+19415550101';
  mockSend.mockResolvedValue({ success: true, sid: 'SM_fixture' });
});
afterAll(() => { delete process.env.ADAM_PHONE; });
test('requires server context before database lookup', async () => {
  expect(await executeLeadTool('get_customer_context', {})).toHaveProperty('error');
  expect(mockDb).not.toHaveBeenCalled();
});
test.each([
  { customer_id: '00000000-0000-4000-8000-000000000099' },
  { lead_id: '00000000-0000-4000-8000-000000000099' },
  { phone: '+19415550199' }, { phone: 'anonymous' }, { phone: '+4419415550100' },
])('rejects foreign or malformed target %j', async input => {
  expect(await executeLeadTool('get_customer_context', input, context)).toMatchObject({ error: expect.any(String), validationError: true });
  expect(mockContext).not.toHaveBeenCalled();
});
test.each(['deleted', 'repointed', 'customer_deleted'])('refuses %s subject', async mode => {
  if (mode === 'deleted') mockState.lead.deleted_at = new Date();
  if (mode === 'repointed') mockState.lead.customer_id = 'other';
  if (mode === 'customer_deleted') mockState.customer.deleted_at = new Date();
  expect(await executeLeadTool('get_customer_context', {}, context)).toHaveProperty('error');
  expect(mockContext).not.toHaveBeenCalled();
});
test('uses resolved customer without shared-phone lookup', async () => {
  expect(await executeLeadTool('get_customer_context', { phone: '(941) 555-0100' }, context)).toEqual({ customerId: context.customerId });
  expect(mockContext).toHaveBeenCalledWith(mockState.customer);
});
test.each(['new_lead', 'service_completed', 'subscription_cancelled', '__proto__'])('rejects unsupported lead stage %s', async stage => {
  expect(await executeLeadTool('update_lead_pipeline', { stage }, context)).toHaveProperty('error');
  expect(mockPipeline).not.toHaveBeenCalled();
});
test('maps supported stage to assigned customer', async () => {
  expect(await executeLeadTool('update_lead_pipeline', { stage: 'contacted' }, context)).toEqual({ updated: true, stage: 'contacted' });
  expect(mockPipeline).toHaveBeenCalledWith(context.customerId, 'first_contact', {}, { database: mockDb });
});
test('failed insert cannot report queued or alert', async () => {
  mockState.insertFails = true;
  await expect(executeLeadTool('queue_for_adam', { reason: 'Review', draft_response: 'Draft' }, context)).rejects.toThrow('storage unavailable');
  expect(mockSend).not.toHaveBeenCalled();
});
test('saved draft survives alert failure; retry delivers once and closes the receipt', async () => {
  mockSend.mockRejectedValueOnce(new Error('provider unavailable'));
  const first = await executeLeadTool('queue_for_adam', { reason: 'Review', draft_response: 'Draft' }, context);
  expect(first).toMatchObject({ queued: true, activityId: 'activity-1', alertStatus: 'failed', failed: true, retryable: true });
  expect(await executeLeadTool('queue_for_adam', { reason: 'Changed retry' }, context)).toMatchObject({ queued: true, activityId: 'activity-1', replayed: true, alertStatus: 'sent' });
  expect(mockSend.mock.calls[1][1]).toContain('Suggested reply:\n"Draft"');
  expect(await executeLeadTool('queue_for_adam', {}, context)).toMatchObject({ queued: true, replayed: true, alertStatus: 'sent' });
  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(mockState.inserts).toBe(1);
});
test('rechecks relationship inside draft transaction', async () => {
  mockDb.transaction.mockImplementationOnce(async callback => {
    mockState.lead.customer_id = 'other';
    return callback(mockDb);
  });
  expect(await executeLeadTool('queue_for_adam', {}, context)).toHaveProperty('error');
  expect(mockState.activity).toBeNull();
  expect(mockSend).not.toHaveBeenCalled();
});
test('report persistence failure reports unsaved', async () => {
  mockState.insertFails = true;
  expect(await executeLeadTool('save_lead_response_report', {}, context)).toEqual({ saved: false, error: 'Lead response report could not be saved' });
});


test.each([
  [undefined, 'failed'],
  [{ success: false }, 'failed'],
  [{ success: true, notificationUndelivered: true, suppressed: true }, 'failed'],
  [{ success: true, notificationError: true, suppressed: true }, 'failed'],
  [{ success: true, notificationRedirected: true, suppressed: true }, 'notified'],
  [{ success: true, pushRouted: true, sid: 'push_fixture' }, 'notified'],
  [{ success: true, gateBlocked: true }, 'suppressed'],
  [{ success: true, suppressed: true }, 'suppressed'],
  [{ success: true, sid: 'SM_fixture' }, 'sent'],
])('reports adapter delivery honestly for %j', async (result, alertStatus) => {
  mockSend.mockResolvedValue(result);
  expect(await executeLeadTool('queue_for_adam', { reason: 'Review' }, context)).toMatchObject({ queued: true, alertStatus });
});
test.each([{ sessionId: 'session-2' }, { toolUseId: 'tool-2' }])('keeps independent queue invocations separate: %j', async different => {
  const first = await executeLeadTool('queue_for_adam', { reason: 'Review' }, context);
  const second = await executeLeadTool('queue_for_adam', { reason: 'Review' }, { ...context, ...different });
  expect(first.activityId).not.toBe(second.activityId);
  expect(mockState.inserts).toBe(2);
  expect(mockSend).toHaveBeenCalledTimes(2);
});


test.each(['update_lead_pipeline', 'flag_for_estimate', 'save_lead_response_report'])('revalidates the lead under the write lock for %s', async tool => {
  mockDb.transaction.mockImplementationOnce(async callback => {
    mockState.lead.customer_id = 'other';
    return callback(mockDb);
  });
  expect(await executeLeadTool(tool, { stage: 'won' }, context)).toMatchObject({ error: expect.any(String), validationError: true });
  expect(mockMessage).not.toHaveBeenCalled();
  expect(mockPipeline).not.toHaveBeenCalled();
  expect(mockState.inserts).toBe(0);
});
test.each(['send_lead_response', 'queue_for_adam', 'update_lead_pipeline', 'flag_for_estimate', 'save_lead_response_report'])(
  'rejects a foreign model target before %s can read or write it', async tool => {
    expect(await executeLeadTool(tool, { customer_id: 'foreign' }, context)).toMatchObject({ validationError: true });
    expect(mockDb).not.toHaveBeenCalled();
  },
);

test.each(['bookkeeping', 'audit'])('a known provider acceptance survives %s failure', async failure => {
  mockMessage.mockImplementation(async () => {
    mockState.lead.customer_id = 'reassigned';
    const outcome = { sent: true, providerMessageId: 'SM_accepted' };
    if (failure === 'audit') throw Object.assign(new Error('audit unavailable'), { providerOutcome: outcome });
    return outcome;
  });
  expect(await executeLeadTool('send_lead_response', { message: 'Synthetic reply' }, context)).toMatchObject({ sent: true });
  expect(mockPipeline).not.toHaveBeenCalled();
  expect(mockState.inserts).toBe(0);
});

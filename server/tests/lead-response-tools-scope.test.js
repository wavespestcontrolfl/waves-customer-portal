const mockContext = jest.fn(async customer => ({ customerId: customer.id }));
jest.mock('../services/context-aggregator', () => ({ getContextForCustomer: mockContext }));
jest.mock('../services/short-url', () => ({}));
jest.mock('../services/pricing-authority-gate', () => ({}));
jest.mock('../services/estimate-automation-duplicates', () => ({}));
const mockState = {};
const mockDb = jest.fn(table => {
  const filters = {};
  const builder = {
    where: jest.fn((key, value) => { Object.assign(filters, typeof key === 'object' ? key : { [key]: value }); return builder; }),
    whereNull: jest.fn(key => { filters[key] = null; return builder; }),
    first: jest.fn(async () => {
      const row = table === 'leads' ? mockState.lead : mockState.customer;
      return row && Object.entries(filters).every(([key, value]) => (row[key] ?? null) === value) ? row : undefined;
    }),
  };
  return builder;
});
jest.mock('../models/db', () => mockDb);
const { executeLeadTool } = require('../services/lead-response-tools');
const context = { leadId: '00000000-0000-4000-8000-000000000001', customerId: '00000000-0000-4000-8000-000000000002' };
beforeEach(() => {
  jest.clearAllMocks();
  mockState.lead = { id: context.leadId, customer_id: context.customerId, phone: '+19415550100' };
  mockState.customer = { id: context.customerId, phone: '+19415550100' };
});
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
test.each(['send_lead_response', 'queue_for_adam', 'update_lead_pipeline', 'flag_for_estimate', 'save_lead_response_report'])(
  'rejects a foreign model target before %s can read or write it', async tool => {
    expect(await executeLeadTool(tool, { customer_id: 'foreign' }, context)).toMatchObject({ validationError: true });
    expect(mockDb).not.toHaveBeenCalled();
  },
);

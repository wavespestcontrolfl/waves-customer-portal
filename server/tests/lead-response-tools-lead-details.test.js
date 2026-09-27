/**
 * Lead Response Agent — get_lead_details hides staff-only extracted_data.
 *
 * The agent writes the customer's first texts, so the neighbor page's
 * "Which home had the sign?" answer (extracted_data.sign_host, stored by
 * routes/lead-webhook.js for the office's sign-host credit) must never reach
 * it. Every other extracted_data key still comes through unchanged.
 */

const mockState = {};
const mockDb = jest.fn(table => {
  const builder = {
    where: jest.fn(() => builder),
    whereNull: jest.fn(() => builder),
    orderBy: jest.fn(() => builder),
    first: jest.fn(async () => {
      if (table === 'customers') return mockState.customer;
      if (table === 'leads') return mockState.lead;
      if (table === 'lead_activities') return mockState.triageActivity;
      return undefined;
    }),
  };
  return builder;
});
mockDb.raw = (sql, bindings) => ({ sql, bindings });
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/short-url', () => ({}));
jest.mock('../services/pricing-authority-gate', () => ({}));
jest.mock('../services/estimate-automation-duplicates', () => ({}));

const { executeLeadTool } = require('../services/lead-response-tools');

const context = {
  leadId: '00000000-0000-4000-8000-000000000001',
  customerId: '00000000-0000-4000-8000-000000000002',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockState.customer = { id: context.customerId, phone: '+19415550100' };
  mockState.lead = {
    id: context.leadId,
    customer_id: context.customerId,
    first_name: 'Pat',
    last_name: 'Neighbor',
    phone: '+19415550100',
    service_interest: 'Recurring Pest Control',
    lead_type: 'form_submission',
    status: 'new',
  };
  mockState.triageActivity = undefined;
});

test('strips sign_host and keeps every other key (jsonb object)', async () => {
  mockState.lead.extracted_data = {
    stage: 'lead_webhook_received',
    timeline: 'this_week',
    attribution: { utm: { source: 'yard_sign', medium: 'print', campaign: 'neighbor' } },
    sign_host: 'the blue house at 4512 Greenbrook',
  };

  const result = await executeLeadTool('get_lead_details', {}, context);

  expect(result.found).toBe(true);
  expect(result.extractedData).not.toHaveProperty('sign_host');
  expect(result.extractedData).toEqual({
    stage: 'lead_webhook_received',
    timeline: 'this_week',
    attribution: { utm: { source: 'yard_sign', medium: 'print', campaign: 'neighbor' } },
  });
  expect(JSON.stringify(result)).not.toContain('Greenbrook');
  // The stored row itself is untouched.
  expect(mockState.lead.extracted_data.sign_host).toBe('the blue house at 4512 Greenbrook');
});

test('strips sign_host from a JSON-string extracted_data too', async () => {
  mockState.lead.extracted_data = JSON.stringify({ timeline: 'now', sign_host: '4512 Greenbrook' });

  const result = await executeLeadTool('get_lead_details', {}, context);

  expect(result.extractedData).toEqual({ timeline: 'now' });
});

test('a lead without extracted_data still returns null', async () => {
  mockState.lead.extracted_data = null;

  const result = await executeLeadTool('get_lead_details', {}, context);

  expect(result.found).toBe(true);
  expect(result.extractedData).toBeNull();
});

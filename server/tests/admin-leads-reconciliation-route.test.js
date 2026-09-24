jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../routes/admin-customers', () => ({ ensureCustomerAccount: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/lead-funnel-bridge', () => ({ bridgeLeadFunnelStage: jest.fn() }));
jest.mock('../services/lead-attribution', () => ({
  ...jest.requireActual('../services/lead-attribution'),
  settleWonFunnelRow: jest.fn(),
}));
jest.mock('../services/lead-status-reconciliation', () => ({
  getLeadStatusReconciliation: jest.fn(),
}));

const knex = require('knex')({ client: 'pg' });
const db = require('../models/db');
const logger = require('../services/logger');
const { getLeadStatusReconciliation } = require('../services/lead-status-reconciliation');
const router = require('../routes/admin-leads');
const handler = router.stack.find((layer) => layer.route?.path === '/:id' && layer.route.methods.get).route.stack.at(-1).handle;

const lead = { id: 'lead-1', status: 'new', first_contact_at: '2026-09-01T12:00:00.000Z' };
const activities = [{ id: 'activity-1', activity_type: 'note' }];

knex.client.runner = (builder) => ({ run: async () => {
  const compiled = builder.toSQL();
  if (compiled.sql.includes('from "leads"')) return lead;
  if (compiled.sql.includes('from "lead_activities"')) return activities;
  return [];
} });

async function request(query = {}) {
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  const next = jest.fn();
  await handler({ params: { id: lead.id }, query }, res, next);
  return { body: res.json.mock.calls[0]?.[0], error: next.mock.calls[0]?.[0] };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation((table) => knex(table));
  db.raw = knex.raw.bind(knex);
  getLeadStatusReconciliation.mockResolvedValue({
    mode: 'read_only', status: 'review', findings: [{ code: 'synthetic' }],
  });
});
afterAll(() => knex.destroy());

test('leaves the existing detail response unchanged unless leadReview is explicitly enabled', async () => {
  const { body, error } = await request();
  expect(error).toBeUndefined();
  expect(body).toEqual({ lead, activities, calls: [] });
  expect(getLeadStatusReconciliation).not.toHaveBeenCalled();
});

test('adds a read-only reconciliation preview when leadReview=1', async () => {
  const { body, error } = await request({ leadReview: '1' });
  expect(error).toBeUndefined();
  expect(body.reconciliation).toMatchObject({ mode: 'read_only', status: 'review' });
  expect(getLeadStatusReconciliation).toHaveBeenCalledWith({
    database: db, lead, activities, associatedCallCount: 0,
  });
});

test('keeps detail usable with an unavailable preview if reconciliation fails', async () => {
  getLeadStatusReconciliation.mockRejectedValueOnce(new Error('synthetic failure'));
  const { body, error } = await request({ leadReview: '1' });
  expect(error).toBeUndefined();
  expect(body.reconciliation).toMatchObject({
    mode: 'read_only', status: 'unavailable', findings: [],
  });
  expect(logger.warn).toHaveBeenCalledWith(
    '[leads] status reconciliation preview unavailable',
    { leadId: lead.id },
  );
});

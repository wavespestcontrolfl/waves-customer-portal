jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(), requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../routes/admin-customers', () => ({ ensureCustomerAccount: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/lead-funnel-bridge', () => ({ bridgeLeadFunnelStage: jest.fn() }));
jest.mock('../services/lead-attribution', () => ({
  ...jest.requireActual('../services/lead-attribution'), settleWonFunnelRow: jest.fn(),
}));
jest.mock('../services/lead-status-reconciliation', () => ({ getLeadStatusReconciliation: jest.fn() }));
const knex = require('knex')({ client: 'pg' });
const db = require('../models/db');
const logger = require('../services/logger');
const { getLeadStatusReconciliation } = require('../services/lead-status-reconciliation');
const router = require('../routes/admin-leads');
const handler = router.stack.find((layer) => layer.route?.path === '/:id' && layer.route.methods.get).route.stack.at(-1).handle;
const lead = { id: 'lead-1', status: 'new', first_contact_at: '2026-09-01T12:00:00.000Z' };
const activities = [{ id: 'activity-1', activity_type: 'note' }];
let failCalls, calls, callCount, callQueries;
knex.client.runner = (builder) => ({ run: async () => {
  const compiled = builder.toSQL();
  if (compiled.sql.includes('from "call_log"')) callQueries.push(compiled);
  if (compiled.sql.includes('from "leads"')) return lead;
  if (compiled.sql.includes('from "lead_activities"')) return activities;
  if (compiled.sql.includes('from "call_log"') && failCalls) throw new Error('synthetic call lookup failure');
  if (compiled.sql.includes('from "call_log"') && compiled.sql.includes('count(*)')) return { count: callCount };
  if (compiled.sql.includes('from "call_log"')) return calls;
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
  failCalls = false; calls = []; callCount = 0; callQueries = [];
  delete lead.twilio_call_sid;
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
  expect(callQueries.some(({ sql }) => sql.includes('count(*)'))).toBe(false);
});
test('adds a read-only reconciliation preview when leadReview=1', async () => {
  const { body, error } = await request({ leadReview: '1' });
  expect(error).toBeUndefined();
  expect(body.reconciliation).toMatchObject({ mode: 'read_only', status: 'review' });
  expect(getLeadStatusReconciliation).toHaveBeenCalledWith({
    database: db, lead, activities, associatedCallCount: 0, associatedCallsAvailable: true,
  });
});
test('marks call evidence unavailable when the best-effort call lookup fails', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  failCalls = true;
  const { error } = await request({ leadReview: '1' });
  expect(error).toBeUndefined();
  expect(getLeadStatusReconciliation).toHaveBeenCalledWith(expect.objectContaining({
    associatedCallCount: 0, associatedCallsAvailable: false,
  }));
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
test('counts lifecycle-associated calls independently of displayable call rows', async () => {
  callCount = 4;
  await request({ leadReview: '1' });
  expect(getLeadStatusReconciliation).toHaveBeenCalledWith(expect.objectContaining({ associatedCallCount: 4 }));
  const countQuery = callQueries.find(({ sql }) => sql.includes('count(*)'));
  expect(countQuery.sql).toContain('"created_at" >= ?');
  expect(countQuery.bindings).toContainEqual(new Date(lead.first_contact_at));
  expect(countQuery.sql).not.toMatch(/"(?:transcription|recording_url)" is not null/);
  expect(countQuery.sql).toContain("metadata->>'lead_id' = ?");
  expect(countQuery.bindings).toContain(lead.id);
});
test('retains initiating SID and settled-stamp calls even when they started before lead creation', async () => {
  lead.twilio_call_sid = 'CA-initiating';
  callCount = 1;
  await request({ leadReview: '1' });
  const countQuery = callQueries.find(({ sql }) => sql.includes('count(*)'));
  expect(countQuery.sql).toContain('"created_at" >= ? or (metadata->>\'lead_id\' = ?');
  expect(countQuery.sql).toContain('or "twilio_call_sid" = ?');
  expect(countQuery.bindings.filter((value) => value === lead.twilio_call_sid)).toHaveLength(2);
  expect(getLeadStatusReconciliation).toHaveBeenCalledWith(expect.objectContaining({ associatedCallCount: 1 }));
});

/**
 * IB closeout tools — read-only surface over the canonical closeout-status
 * service (#3647). Admin-only via the standing role gate (non-admin tokens
 * pass only TECH_TOOL_NAMES); deliberately NOT in write-gates.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/closeout-status', () => ({
  getCloseoutStatus: jest.fn(),
  FACT_NAMES: ['completion', 'application', 'photos', 'report', 'reportDelivery', 'invoice', 'invoiceDelivery', 'comms', 'followUp', 'license'],
}));

const db = require('../models/db');
const { getCloseoutStatus } = require('../services/closeout-status');
const { CLOSEOUT_TOOLS, executeCloseoutTool } = require('../services/intelligence-bar/closeout-tools');

function visitChain(rows) {
  const chain = {
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    select: async () => rows,
  };
  return chain;
}

function status(overrides = {}) {
  return {
    found: true,
    summary: { open: [], failed: [], unknown: [], contradictions: [], unevaluated: [], closedOut: true },
    facts: Object.fromEntries(['completion', 'application', 'photos', 'report', 'reportDelivery', 'invoice', 'invoiceDelivery', 'comms', 'followUp', 'license']
      .map((n) => [n, { state: 'done', reason: 'x' }])),
    ...overrides,
  };
}

beforeEach(() => jest.clearAllMocks());

test('tool schemas: uuid param declares format, read-only names never in write-gates', () => {
  const byName = Object.fromEntries(CLOSEOUT_TOOLS.map((t) => [t.name, t]));
  expect(byName.get_closeout_status.input_schema.properties.service_id.format).toBe('uuid');
  expect(byName.get_closeout_status.input_schema.required).toEqual(['service_id']);
  const gates = require('../services/intelligence-bar/write-gates');
  for (const t of CLOSEOUT_TOOLS) {
    for (const set of Object.values(gates)) {
      if (set instanceof Set) expect(set.has(t.name)).toBe(false);
    }
  }
});

test('get_closeout_status returns the service result; found:false is a clear error, outage says unknown-not-missing', async () => {
  getCloseoutStatus.mockResolvedValue(status());
  const ok = await executeCloseoutTool('get_closeout_status', { service_id: 'svc-1' });
  expect(ok.summary.closedOut).toBe(true);
  // Operator free text never leaves the tool (codex r3).
  getCloseoutStatus.mockResolvedValue(status({ facts: { ...status().facts, invoice: { state: 'not_required', reason: 'disposition_intentionally_free', dispositionId: 'd1', dispositionReason: 'waived for Jane at 12 Palm St' } } }));
  const stripped = await executeCloseoutTool('get_closeout_status', { service_id: 'svc-1' });
  expect(stripped.facts.invoice).toEqual({ state: 'not_required', reason: 'disposition_intentionally_free', dispositionId: 'd1' });
  expect(JSON.stringify(stripped)).not.toMatch(/Jane|Palm St/);
  getCloseoutStatus.mockResolvedValue({ found: false, lookupFailed: false });
  expect((await executeCloseoutTool('get_closeout_status', { service_id: 'nope' })).error).toMatch(/No visit/);
  getCloseoutStatus.mockResolvedValue({ found: false, lookupFailed: true });
  expect((await executeCloseoutTool('get_closeout_status', { service_id: 'svc-1' })).error).toMatch(/unknown, not missing/);
  expect((await executeCloseoutTool('get_closeout_status', {})).error).toMatch(/required/);
});

test('list_open_closeouts sweeps completed visits and returns only non-closed ones, unknown kept apart', async () => {
  db.mockImplementation(() => visitChain([
    { id: 'svc-1', service_type: 'Pest', customer_id: 'c1', window_start: '09:00' },
    { id: 'svc-2', service_type: 'Lawn', customer_id: 'c2', window_start: '10:00' },
    { id: 'svc-3', service_type: 'WDO', customer_id: 'c3', window_start: '11:00' },
  ]));
  getCloseoutStatus
    .mockResolvedValueOnce(status()) // closed out
    .mockResolvedValueOnce(status({
      summary: { open: ['invoice'], failed: [], unknown: ['photos'], contradictions: [], unevaluated: [], closedOut: false },
      facts: { ...status().facts, invoice: { state: 'pending', reason: 'expected_invoice_not_minted' }, photos: { state: 'unknown', reason: 'service_photos_lookup_failed' } },
    }))
    .mockRejectedValueOnce(new Error('down'));
  const out = await executeCloseoutTool('list_open_closeouts', { date: '2026-08-31' });
  expect(out).toMatchObject({ date: '2026-08-31', completedVisitsChecked: 3, closedOut: 1, statusUnavailable: 1, truncated: false });
  expect(out.unavailableVisits).toEqual([expect.objectContaining({ serviceId: 'svc-3', reason: 'status_load_failed' })]);
  expect(out.openCloseouts).toHaveLength(1);
  expect(out.openCloseouts[0]).toMatchObject({
    serviceId: 'svc-2', open: ['invoice'], unknown: ['photos'],
    facts: expect.objectContaining({ invoice: { state: 'pending', reason: 'expected_invoice_not_minted' } }),
  });
  // No PII fields ride along.
  const json = JSON.stringify(out);
  expect(json).not.toMatch(/first_name|last_name|phone|email|address/);
});

test('list_open_closeouts: absent date = today; malformed or impossible dates error (codex r1); db outage is an error, not an empty all-clear', async () => {
  db.mockImplementation(() => visitChain([]));
  const out = await executeCloseoutTool('list_open_closeouts', {});
  expect(out.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(out.openCloseouts).toEqual([]);
  expect((await executeCloseoutTool('list_open_closeouts', { date: 'nope' })).error).toMatch(/Invalid date/);
  expect((await executeCloseoutTool('list_open_closeouts', { date: '2026-02-30' })).error).toMatch(/Invalid date/);
  expect((await executeCloseoutTool('list_open_closeouts', { date: '2026-8-31' })).error).toMatch(/Invalid date/);
  db.mockImplementation(() => { throw new Error('conn refused'); });
  expect((await executeCloseoutTool('list_open_closeouts', {})).error).toMatch(/unavailable/);
});

test('list_open_closeouts marks truncation when a day exceeds the cap (codex r2)', async () => {
  const many = Array.from({ length: 51 }, (_, i) => ({ id: `svc-${i}`, service_type: 'Pest', customer_id: `c${i}`, window_start: '09:00' }));
  db.mockImplementation(() => visitChain(many));
  getCloseoutStatus.mockResolvedValue(status());
  const out = await executeCloseoutTool('list_open_closeouts', { date: '2026-08-31' });
  expect(out).toMatchObject({ completedVisitsChecked: 50, truncated: true });
  expect(out.note).toMatch(/NOT an all-clear/);
  expect(getCloseoutStatus).toHaveBeenCalledTimes(50);
});

test('unknown tool name returns an error object', async () => {
  expect(await executeCloseoutTool('bogus', {})).toEqual({ error: 'Unknown tool: bogus' });
});

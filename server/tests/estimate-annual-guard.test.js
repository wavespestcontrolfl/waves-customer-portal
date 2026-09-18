const { annualPlanOfferFingerprint } = require('../services/estimate-offer-version');
const { loadAnnualOfferRow, annualOfferVerdict, annualHandoffGuard } = require('../services/estimate-annual-guard');

const PLAN_LINE = { service: 'termite_bait', plan: 'annual_protection', stations: 15 };
const QUARTERLY_LINE = { ...PLAN_LINE, plan: 'quarterly' };
const row = (data = { result: { lineItems: [PLAN_LINE] } }, overrides = {}) => ({
  id: 'synthetic-annual', status: 'draft', expires_at: null,
  monthly_total: 0, annual_total: 299, onetime_total: 450, estimate_data: data,
  customer_id: 'cust-1', property_id: 'prop-1', estimate_group_id: null, customer_name: 'Synthetic Customer',
  customer_phone: '9415550100', customer_email: 'synthetic@example.test', address: 'Synthetic property',
  notes: null, show_one_time_option: false, bill_by_invoice: false, waveguard_tier: null,
  service_interest: null, category: null, source: null,
  ...overrides,
});
const delivered = (overrides = {}) => {
  const estimate = row(undefined, overrides);
  estimate.status = 'sent';
  estimate.estimate_data.deliveryState = {
    firstDeliveredAt: '2026-01-01T12:00:00Z',
    annualPlanOfferFingerprint: annualPlanOfferFingerprint(estimate),
  };
  return estimate;
};

const prior = [process.env.GATE_TERMITE_ANNUAL_PLAN, process.env.GATE_CANCEL_FLOW_V2];
beforeEach(() => {
  process.env.GATE_TERMITE_ANNUAL_PLAN = process.env.GATE_CANCEL_FLOW_V2 = 'false';
});
afterAll(() => {
  ['GATE_TERMITE_ANNUAL_PLAN', 'GATE_CANCEL_FLOW_V2'].forEach((key, index) => {
    if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index];
  });
});

// Minimal knex-shaped fake: db('estimates').where({id}).first(...cols) and
// the same chain with .forUpdate() inserted before .first(). Each call is
// recorded on `calls` so tests can assert the table/columns/lock used —
// mirrors the codebase's own first(...cols) idiom (never select().first()).
function fakeDb(rowsById, calls = []) {
  const db = (table) => {
    const call = { table, where: null, first: null, forUpdate: false };
    calls.push(call);
    const builder = {
      where(cond) { call.where = cond; return builder; },
      forUpdate() { call.forUpdate = true; return builder; },
      first: async (...cols) => { call.first = cols; return rowsById[call.where && call.where.id]; },
    };
    return builder;
  };
  return db;
}

describe('annualOfferVerdict', () => {
  test.each([
    ['quarterly row', row({ result: { lineItems: [QUARTERLY_LINE] } }), false],
    ['missing row', null, false],
  ])('%s is never withheld', (_label, r, withheld) => {
    expect(annualOfferVerdict(r)).toEqual({ withheld, reason: withheld ? 'annual_offer_withheld' : null });
  });

  test('annual row with both gates on is not withheld', () => {
    process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
    process.env.GATE_CANCEL_FLOW_V2 = 'true';
    expect(annualOfferVerdict(row())).toEqual({ withheld: false, reason: null });
  });

  test('annual row, gate off, matching fingerprint is not withheld', () => {
    expect(annualOfferVerdict(delivered())).toEqual({ withheld: false, reason: null });
  });

  test('annual row, gate off, missing fingerprint is withheld', () => {
    const estimate = row();
    expect(annualOfferVerdict(estimate)).toEqual({ withheld: true, reason: 'annual_offer_withheld' });
  });

  test('annual row, gate off, stale fingerprint is withheld', () => {
    const estimate = delivered();
    estimate.estimate_data.deliveryState.annualPlanOfferFingerprint = 'stale-fingerprint';
    expect(annualOfferVerdict(estimate)).toEqual({ withheld: true, reason: 'annual_offer_withheld' });
  });

  test.each(['accepted', 'declined'])('%s status is never withheld even with no delivered fingerprint', (status) => {
    const estimate = row();
    estimate.status = status;
    expect(annualOfferVerdict(estimate)).toEqual({ withheld: false, reason: null });
  });
});

describe('loadAnnualOfferRow', () => {
  test('selects id/status/expires_at/estimate_data plus every fingerprint column', async () => {
    const calls = [];
    const db = fakeDb({ 'est-1': row() }, calls);
    const result = await loadAnnualOfferRow(db, 'est-1');
    expect(result).toEqual(row());
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('estimates');
    expect(calls[0].where).toEqual({ id: 'est-1' });
    expect(calls[0].forUpdate).toBe(false);
    expect(calls[0].first).toEqual(expect.arrayContaining([
      'id', 'status', 'expires_at', 'estimate_data',
      'customer_id', 'property_id', 'estimate_group_id', 'customer_name', 'customer_phone',
      'customer_email', 'address', 'notes', 'monthly_total', 'annual_total', 'onetime_total',
      'show_one_time_option', 'bill_by_invoice', 'waveguard_tier', 'service_interest', 'category', 'source',
    ]));
  });

  test('forUpdate: true locks the row', async () => {
    const calls = [];
    const db = fakeDb({ 'est-1': row() }, calls);
    await loadAnnualOfferRow(db, 'est-1', { forUpdate: true });
    expect(calls[0].forUpdate).toBe(true);
  });

  test('default forUpdate is false (no lock) when the option is omitted', async () => {
    const calls = [];
    const db = fakeDb({ 'est-1': row() }, calls);
    await loadAnnualOfferRow(db, 'est-1');
    expect(calls[0].forUpdate).toBe(false);
  });
});

describe('annualHandoffGuard', () => {
  test('a single withheld estimate blocks with its id', async () => {
    const db = fakeDb({ 'est-1': row() });
    const verdict = await annualHandoffGuard({ db, estimateIds: ['est-1'] })();
    expect(verdict).toEqual({ blocked: true, reason: 'annual_offer_withheld', estimateId: 'est-1' });
  });

  test('all delivered estimates are not blocked', async () => {
    const db = fakeDb({ 'est-1': delivered(), 'est-2': delivered({ id: 'est-2' }) });
    const verdict = await annualHandoffGuard({ db, estimateIds: ['est-1', 'est-2'] })();
    expect(verdict).toEqual({ blocked: false, reason: null, estimateId: null });
  });

  test('blocks on any one withheld id among several, without reading ids after it', async () => {
    const calls = [];
    const db = fakeDb({ 'est-1': delivered(), 'est-2': row({ result: { lineItems: [PLAN_LINE] } }), 'est-3': delivered({ id: 'est-3' }) }, calls);
    const verdict = await annualHandoffGuard({ db, estimateIds: ['est-1', 'est-2', 'est-3'] })();
    expect(verdict).toEqual({ blocked: true, reason: 'annual_offer_withheld', estimateId: 'est-2' });
    expect(calls.map((c) => c.where.id)).toEqual(['est-1', 'est-2']);
  });

  test('a single estimateId (not an array) is accepted', async () => {
    const db = fakeDb({ 'est-1': row() });
    const verdict = await annualHandoffGuard({ db, estimateIds: 'est-1' })();
    expect(verdict.blocked).toBe(true);
  });

  test('null/undefined ids are ignored, an empty id list is never blocked', async () => {
    const db = fakeDb({});
    expect(await annualHandoffGuard({ db, estimateIds: [null, undefined] })()).toEqual({ blocked: false, reason: null, estimateId: null });
    expect(await annualHandoffGuard({ db, estimateIds: [] })()).toEqual({ blocked: false, reason: null, estimateId: null });
  });

  test('an unknown/missing estimate id is not this guard\'s job — not blocked', async () => {
    const db = fakeDb({});
    const verdict = await annualHandoffGuard({ db, estimateIds: ['does-not-exist'] })();
    expect(verdict).toEqual({ blocked: false, reason: null, estimateId: null });
  });

  test('a loader error propagates out of the guard rather than being treated as allowed', async () => {
    const db = () => ({
      where() { return this; },
      forUpdate() { return this; },
      first: async () => { throw new Error('connection lost'); },
    });
    await expect(annualHandoffGuard({ db, estimateIds: ['est-1'] })()).rejects.toThrow('connection lost');
  });
});

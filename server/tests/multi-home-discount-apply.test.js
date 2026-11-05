/**
 * Multi-Home Discount on every home: the decisions that need no database. The real-schema half (the actual "This and
 * following" helpers, the ledger, the bell dedupe, idempotency over a second run) is
 * multi-home-discount-apply-postgres.test.js. Synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('db must not be touched'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockGate = { live: true, stacking: false, episodes: false };
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  multiHomeAllHomesLive: () => mockGate.live,
  discountStackingLive: () => mockGate.stacking,
  alertEpisodesLive: () => mockGate.episodes,
  isEnabled: () => true,
}));
const mockEligible = jest.fn();
jest.mock('../services/multi-home-family', () => ({
  familyMembers: jest.fn(),
  familyMultiHomeEligible: (...args) => mockEligible(...args),
}));
const mockRaise = jest.fn(async () => ({}));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: (...args) => mockRaise(...args),
}));

const db = require('../models/db');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const apply = require('../services/multi-home-discount-apply');

const { guardHold, seriesShapeVerdict, flatRefusal, discountFields, describeSource, applyTargets, settleTarget, recordHold, HoldError } = apply._private;

const PRESET = { id: 'preset-1', name: 'Multi-Home Discount', discount_type: 'percentage', amount: '10.00', max_discount_dollars: null, service_key_filter: null, service_category_filter: null };

beforeEach(() => {
  jest.clearAllMocks();
  mockGate.live = true;
  mockGate.stacking = false;
  mockGate.episodes = false;
  mockEligible.mockReset();
});

describe('source detection', () => {
  const md = (extra = {}) => ({ presetKey: 'multi_home', type: 'PERCENT', value: 10, recurringAmount: 40, amount: 40, ...extra });

  test.each([
    ['summary', { summary: { manualDiscount: md() } }],
    ['result', { result: { manualDiscount: md() } }],
    ['result totals', { result: { totals: { manualDiscount: md() } } }],
    ['result summary', { result: { summary: { manualDiscount: md() } } }],
  ])('finds the preset on the stored %s object', (_label, data) => {
    expect(apply.multiHomeSourceDiscount(data)).toMatchObject({ presetKey: 'multi_home' });
  });

  test('another preset, no recurring slice, or no discount is not a source', () => {
    expect(apply.multiHomeSourceDiscount({ summary: { manualDiscount: md({ presetKey: 'military' }) } })).toBeNull();
    expect(apply.multiHomeSourceDiscount({ summary: { manualDiscount: md({ recurringAmount: 0 }) } })).toBeNull();
    expect(apply.multiHomeSourceDiscount({ summary: { manualDiscount: md({ type: 'NONE' }) } })).toBeNull();
    expect(apply.multiHomeSourceDiscount({})).toBeNull();
    expect(apply.multiHomeSourceDiscount(null)).toBeNull();
  });

  test('a stored object with no split falls back to its amount; the catalog id also identifies the preset', () => {
    expect(apply.multiHomeSourceDiscount({ summary: { manualDiscount: md({ recurringAmount: undefined, amount: 12 }) } })).not.toBeNull();
    expect(apply.multiHomeSourceDiscount({ summary: { manualDiscount: md({ recurringAmount: undefined, amount: 0 }) } })).toBeNull();
    const byId = { summary: { manualDiscount: md({ presetKey: undefined, presetId: 'preset-1' }) } };
    expect(apply.multiHomeSourceDiscount(byId)).toBeNull();
    expect(apply.multiHomeSourceDiscount(byId, 'preset-1')).not.toBeNull();
  });

  test('otherManualDiscount sees a different preset and ignores the Multi-Home one', () => {
    expect(apply.otherManualDiscount({ summary: { manualDiscount: md({ presetKey: 'military' }) } })).toMatchObject({ presetKey: 'military' });
    expect(apply.otherManualDiscount({ summary: { manualDiscount: md() } })).toBeNull();
  });

  test('describeSource: needs the profile to be multi-home by flag or by family, and booked plan visits', async () => {
    const estimate = { id: 'est-1', customer_id: 'son', property_id: 'home-s', estimate_data: { summary: { manualDiscount: md() } } };
    const fakeDb = ({ customer, rows }) => {
      const dbh = jest.fn(() => ({ where: () => ({ first: async () => customer }) }));
      dbh.raw = jest.fn(async () => ({ rows }));
      return dbh;
    };
    const visits = [{ id: 'v1', recurring_parent_id: null, property_id: 'home-s' }, { id: 'v2', recurring_parent_id: 'v1', property_id: 'home-s' }];
    const active = { id: 'son', active: true, deleted_at: null, has_multi_home: false };

    mockEligible.mockResolvedValue(true);
    const viaFamily = await describeSource(fakeDb({ customer: active, rows: visits }), estimate, null);
    expect(viaFamily).toMatchObject({ estimateId: 'est-1', customerId: 'son', propertyId: 'home-s' });
    expect([...viaFamily.roots]).toEqual(['v1']);

    mockEligible.mockResolvedValue(false);
    expect(await describeSource(fakeDb({ customer: active, rows: visits }), estimate, null)).toBeNull();
    expect(await describeSource(fakeDb({ customer: { ...active, has_multi_home: true }, rows: visits }), estimate, null)).not.toBeNull();
    expect(await describeSource(fakeDb({ customer: { ...active, has_multi_home: true }, rows: [] }), estimate, null)).toBeNull();
    expect(await describeSource(fakeDb({ customer: { ...active, active: false, has_multi_home: true }, rows: visits }), estimate, null)).toBeNull();
    expect(await describeSource(fakeDb({ customer: null, rows: visits }), estimate, null)).toBeNull();
    expect(await describeSource(fakeDb({ customer: active, rows: visits }), { ...estimate, estimate_data: {} }, null)).toBeNull();
  });
});

describe('target selection', () => {
  const source = { customerId: 'son', propertyId: 'home-s', roots: new Set(['root-source']) };
  const s = (extra) => ({ customerId: 'son', rootId: 'root-x', propertyId: 'home-s', serviceKey: 'pest_general_quarterly', ...extra });
  const pick = (series, extra = {}) => apply.selectTargetSeries({ series, source, familyCustomerIds: ['parents'], ...extra }).map((t) => t.rootId);

  test('the source estimate\'s own series is never a target', () => {
    expect(pick([s({ rootId: 'root-source', propertyId: 'home-other' })])).toEqual([]);
  });

  test('another property of the same profile is a target; the same property, or an unknown one, is not', () => {
    expect(pick([s({ rootId: 'a', propertyId: 'home-other' })])).toEqual(['a']);
    expect(pick([s({ rootId: 'b', propertyId: 'home-s' })])).toEqual([]);
    expect(pick([s({ rootId: 'c', propertyId: null })])).toEqual([]);
    expect(pick([s({ rootId: 'd', propertyId: null })], { primaryPropertyByCustomer: new Map([['son', 'home-s']]) })).toEqual([]);
    expect(pick([s({ rootId: 'e', propertyId: null })], { primaryPropertyByCustomer: new Map([['son', 'home-primary']]) })).toEqual(['e']);
  });

  test('every series of a linked profile is a target, whatever its property; an unlinked profile is not', () => {
    expect(pick([s({ customerId: 'parents', rootId: 'p1', propertyId: 'home-p' }), s({ customerId: 'parents', rootId: 'p2', propertyId: null })])).toEqual(['p1', 'p2']);
    expect(pick([s({ customerId: 'stranger', rootId: 'z', propertyId: 'home-z' })])).toEqual([]);
  });

  test('a service the percent discount never touches is not a target', () => {
    const isExcluded = (key) => key === 'termite_bond_1yr';
    expect(pick([s({ customerId: 'parents', rootId: 'bond', serviceKey: 'termite_bond_1yr' }), s({ customerId: 'parents', rootId: 'pest' })], { isExcluded })).toEqual(['pest']);
  });

  test('the resolved property rides on the target', () => {
    const [t] = apply.selectTargetSeries({ series: [s({ customerId: 'parents', propertyId: null })], source, familyCustomerIds: ['parents'], primaryPropertyByCustomer: new Map([['parents', 'home-p']]) });
    expect(t.propertyId).toBe('home-p');
  });
});

describe('series shape and hold decisions', () => {
  const visit = (extra = {}) => ({ id: 'v', status: 'pending', estimated_price: '117.00', primary_line_price: null, ...extra });

  test('verdicts in order', () => {
    expect(seriesShapeVerdict([], 'p')).toEqual({ reason: 'no_future_visit' });
    expect(seriesShapeVerdict([visit({ status: 'completed' })], 'p')).toEqual({ reason: 'no_future_visit' });
    expect(seriesShapeVerdict([visit(), visit({ status: 'rescheduled' })], 'p')).toEqual({ reason: 'visit_in_reschedule' });
    expect(seriesShapeVerdict([visit(), visit({ status: null })], 'p')).toEqual({ reason: 'visit_status_missing' });
    expect(seriesShapeVerdict([visit(), visit({ discount_type: 'percentage' })], 'p')).toEqual({ reason: 'visit_already_discounted' });
    expect(seriesShapeVerdict([visit({ line_discount_dollars: '5' })], 'p')).toEqual({ reason: 'visit_already_discounted' });
    expect(seriesShapeVerdict([visit(), visit()], 'p')).toBeNull();
  });

  test('every upcoming visit already carrying the preset needs nothing; one other discount does not', () => {
    const done = { discount_id: 'p', discount_type: 'percentage', discount_dollars: '11.70' };
    expect(seriesShapeVerdict([visit(done), visit(done)], 'p')).toEqual({ already: true });
    expect(seriesShapeVerdict([visit(done), visit({ ...done, discount_id: 'other' })], 'p')).toEqual({ reason: 'visit_already_discounted' });
    expect(seriesShapeVerdict([visit(done), visit()], 'p')).toEqual({ reason: 'visit_already_discounted' });
  });

  test('flat refusals map to this job\'s reasons', () => {
    const cur = 11700;
    expect(flatRefusal([visit()], { currentCents: cur })).toBeNull();
    expect(flatRefusal([visit({ estimated_price: '120.00' })], { currentCents: cur })).toMatchObject({ reason: 'visit_prices_differ' });
    expect(flatRefusal([visit({ estimated_price: null })], { currentCents: cur })).toMatchObject({ reason: 'visit_unpriced' });
    expect(flatRefusal([visit({ prepaid_amount: '117' })], { currentCents: cur })).toMatchObject({ reason: 'visit_prepaid' });
    expect(flatRefusal([visit({ annual_prepay_term_id: 't1' })], { currentCents: cur, liveTermIds: new Set(['t1']) })).toMatchObject({ reason: 'visit_prepaid' });
    expect(flatRefusal([visit({ primary_line_price: '110' })], { currentCents: cur })).toMatchObject({ reason: 'visit_price_structure' });
    expect(flatRefusal([visit({ id: 'x' })], { currentCents: cur, addonCounts: new Map([['x', 1]]) })).toMatchObject({ reason: 'visit_has_addons', visitId: 'x' });
    expect(flatRefusal([visit({ discount_type: 'percentage' })], { currentCents: cur })).toMatchObject({ reason: 'visit_already_discounted' });
  });

  test('the series guards\' 409s become holds with the useful reason', () => {
    const e = (message, code) => Object.assign(new Error(message), { statusCode: 409, code });
    expect(guardHold(e('Can\'t apply this price/service change to the rest of the series: the later visit already has an invoice. Settle')).holdCode).toBe('live_invoice');
    expect(guardHold(e('... is attached to an invoice that has money on it. Handle')).holdCode).toBe('live_invoice');
    expect(guardHold(e('... the later visit is already prepaid. Handle')).holdCode).toBe('visit_prepaid');
    expect(guardHold(e('... is covered by an annual prepay term. Handle')).holdCode).toBe('annual_prepay_visit');
    expect(guardHold(e('... is holding a card for a late-cancel fee. Handle')).holdCode).toBe('visit_card_hold');
    expect(guardHold(e('The customer is finishing their card confirmation for the later visit', 'VISIT_BUSY_RETRY')).holdCode).toBe('card_confirmation_in_flight');
    expect(guardHold(e('Another change to a later visit in this series is in progress', 'VISIT_BUSY_RETRY')).holdCode).toBe('series_busy');
    expect(guardHold(e('something else')).holdCode).toBe('series_guard_refused');
    expect(guardHold(new Error('boom'))).toBeNull();
    const own = new HoldError('plan_on_hold');
    expect(guardHold(own)).toBe(own);
  });

  test('discountFields write the catalog row with the visit price as the gross', () => {
    expect(discountFields(PRESET, 117)).toEqual({
      primary_line_price: 117, discount_type: 'percentage', discount_amount: 10, discount_id: 'preset-1', discount_name: 'Multi-Home Discount',
      discount_service_key_filter: null, discount_service_category_filter: null, discount_max_dollars: null,
    });
  });

  test('every hold has bell copy that passes the admin-notification rules, and no code leaks into it', () => {
    for (const [code, why] of Object.entries(apply.HOLD_COPY)) {
      expect(() => composeAdminAlert({
        area: 'Billing', action: 'finish a Multi-Home Discount by hand', why, severity: 'needs-you', link: '/admin/customers?customerId=c1',
        subject: { type: 'customer', id: 'c1' }, doneWhen: 'multi_home_discount_applied', who: 'person',
      })).not.toThrow();
      expect(why).not.toContain(code);
    }
  });
});

describe('the job', () => {
  test('gate off: returns before any query', async () => {
    mockGate.live = false;
    const dbh = jest.fn(() => { throw new Error('query'); });
    dbh.raw = jest.fn(() => { throw new Error('query'); });
    const out = await apply.runMultiHomeAllHomes({ now: new Date('2026-11-06T15:00:00Z'), dbh });
    expect(out).toEqual({ ok: false, reason: 'gate_off' });
    expect(dbh).not.toHaveBeenCalled();
    expect(dbh.raw).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  const source = { estimateId: 'est-1', customerId: 'son' };
  const targets = [{ customerId: 'parents', rootId: 'r1', propertyId: 'home-p' }, { customerId: 'parents', rootId: 'r2', propertyId: 'home-p' }, { customerId: 'parents', rootId: 'r3', propertyId: 'home-p' }];
  const fresh = () => ({ ok: true, sources: 1, targets: 0, applied: 0, already: 0, held: 0, skipped: 0, holds: [] });
  const dbhStub = () => { const d = jest.fn(); d.raw = jest.fn(async () => ({})); return d; };

  test('idempotent: an applied or already_discounted series is never applied again; a held one is retried', async () => {
    const ledger = new Map([['r1', { status: 'applied' }], ['r2', { status: 'already_discounted' }], ['r3', { status: 'held', hold_reason: 'plan_on_hold' }]]);
    const run = jest.fn(async () => ({ status: 'applied' }));
    const out = fresh();
    await applyTargets(dbhStub(), source, targets, ledger, { now: new Date(), apply: run }, out);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1].rootId).toBe('r3');
    expect(out).toMatchObject({ targets: 1, applied: 1, held: 0 });
  });

  test('tallies applied, already discounted, skipped and held results', async () => {
    const results = [{ status: 'applied' }, { status: 'already_discounted' }, { skipped: true }];
    const run = jest.fn(async () => results.shift());
    const out = fresh();
    await applyTargets(dbhStub(), source, targets, new Map(), { now: new Date(), apply: run }, out);
    expect(out).toMatchObject({ targets: 3, applied: 1, already: 1, skipped: 1, held: 0 });
  });

  test('a hold is recorded in the ledger and rings ONE bell keyed by source, series and reason', async () => {
    const dbh = dbhStub();
    const out = fresh();
    await settleTarget(dbh, source, targets[0], { status: 'held', hold: 'lane_monthly_membership', detail: { lane: 'monthly_membership' } }, new Date('2026-11-06T15:00:00Z'), out);
    expect(out).toMatchObject({ held: 1 });
    expect(out.holds).toEqual([{ sourceEstimateId: 'est-1', targetCustomerId: 'parents', seriesRootId: 'r1', reason: 'lane_monthly_membership' }]);
    const [sql, bindings] = dbh.raw.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(source_estimate_id, series_root_id\) DO UPDATE/);
    expect(sql).toMatch(/WHERE multi_home_discount_applications\.status = 'held'/);
    expect(bindings).toEqual(expect.arrayContaining(['est-1', 'parents', 'r1', 'lane_monthly_membership']));
    expect(mockRaise).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = mockRaise.mock.calls[0];
    expect(category).toBe('billing');
    expect(spec).toMatchObject({ area: 'Billing', severity: 'needs-you', subject: { type: 'customer', id: 'parents' } });
    expect(opts.dedupeKey).toBe('multi-home-discount-hold:est-1:r1:lane_monthly_membership');
  });

  test('an applied result rings nothing and never writes a hold', async () => {
    const dbh = dbhStub();
    await settleTarget(dbh, source, targets[0], { status: 'applied' }, new Date(), fresh());
    expect(dbh.raw).not.toHaveBeenCalled();
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('recordHold never overwrites a row that already applied (the upsert only updates held rows)', async () => {
    const dbh = dbhStub();
    await recordHold(dbh, { source, target: targets[0], code: 'plan_on_hold', detail: null, now: new Date() });
    expect(dbh.raw.mock.calls[0][0]).toMatch(/WHERE multi_home_discount_applications\.status = 'held'/);
  });
});

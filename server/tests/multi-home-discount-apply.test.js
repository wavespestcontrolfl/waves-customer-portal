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
  lockFamilyChangesShared: jest.fn(async () => {}),
}));
const mockClose = jest.fn(async () => 1);
jest.mock('../services/admin-alert-episodes', () => ({ closeAdminAlertKeys: (...args) => mockClose(...args) }));
const mockAgreed = jest.fn(async () => null);
jest.mock('../services/customer-properties', () => ({
  ...jest.requireActual('../services/customer-properties'),
  seriesAgreedPropertyId: (...args) => mockAgreed(...args),
}));
const mockRaise = jest.fn(async () => ({}));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: (...args) => mockRaise(...args),
}));

const db = require('../models/db');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const apply = require('../services/multi-home-discount-apply');

const {
  guardHold, seriesShapeVerdict, flatRefusal, discountFields, describeSource, applyTargets, settleTarget, recordHold, HoldError,
  relationshipHolds, verifyTemplateForAlready, pruneStaleHeld, eachSourceEstimate, dropHeldForSource, pruneOutOfScopeHeld, processSource,
} = apply._private;

const PRESET = { id: 'preset-1', name: 'Multi-Home Discount', discount_type: 'percentage', amount: '10.00', max_discount_dollars: null, service_key_filter: null, service_category_filter: null };

beforeEach(() => {
  jest.clearAllMocks();
  mockGate.live = true;
  mockGate.stacking = false;
  mockGate.episodes = false;
  mockEligible.mockReset();
  mockAgreed.mockReset();
  mockAgreed.mockResolvedValue(null);
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
    // No source property known: no same-profile series can be shown to be another home.
    expect(apply.selectTargetSeries({ series: [s({ rootId: 'd', propertyId: 'home-other' })], source: { ...source, propertyId: null }, familyCustomerIds: [] })).toEqual([]);
  });

  test('every series of a linked profile is a target, whatever its property; an unlinked profile is not', () => {
    expect(pick([s({ customerId: 'parents', rootId: 'p1', propertyId: 'home-p' }), s({ customerId: 'parents', rootId: 'p2', propertyId: null })])).toEqual(['p1', 'p2']);
    expect(pick([s({ customerId: 'stranger', rootId: 'z', propertyId: 'home-z' })])).toEqual([]);
  });

  test('a service the percent discount never touches is not a target', () => {
    const isExcluded = (key) => key === 'termite_bond_1yr';
    expect(pick([s({ customerId: 'parents', rootId: 'bond', serviceKey: 'termite_bond_1yr' }), s({ customerId: 'parents', rootId: 'pest' })], { isExcluded })).toEqual(['pest']);
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

  test('the written fields are only keys the Edit appointment save propagates (PRICE_SERVICE_PRICE_KEYS)', () => {
    const { PRICE_SERVICE_PRICE_KEYS } = require('../services/recurring-template-overrides');
    const fields = { ...discountFields(PRESET, 117), estimated_price: 105.3 };
    expect(Object.keys(fields).filter((k) => !PRICE_SERVICE_PRICE_KEYS.includes(k))).toEqual([]);
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
  const fresh = () => ({ ok: true, sources: 1, targets: 0, applied: 0, already: 0, held: 0, skipped: 0, dropped: 0, holds: [] });
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

// A table-keyed fake knex: every query on a table answers that table's rows (filters are not applied, so each test
// names exactly the rows the real query would return).
function fakeTrx(tables, extra = {}) {
  const trx = jest.fn((name) => {
    const rows = tables[name] || [];
    const q = {
      where: () => q, whereIn: () => q, join: () => q, whereRaw: () => q, select: async () => rows, first: async () => rows[0], del: jest.fn(async () => 1),
      columnInfo: async () => ({}), then: (res, rej) => Promise.resolve(rows).then(res, rej),
    };
    return q;
  });
  return Object.assign(trx, extra);
}

describe('the relationship is read again under the family lock', () => {
  const src = { estimateId: 'est-1', customerId: 'son', propertyId: 'home-s' };
  const source = src;
  const targets = [{ customerId: 'parents', rootId: 'r1', propertyId: 'home-p' }];
  const fresh = () => ({ ok: true, sources: 1, targets: 0, applied: 0, already: 0, held: 0, skipped: 0, dropped: 0, holds: [] });
  const dbhStub = () => { const d = jest.fn(); d.raw = jest.fn(async () => ({})); return d; };
  const live = (...ids) => ids.map((id) => ({ id, active: true, deleted_at: null }));

  test('the source estimate must still be accepted, and both profiles live', async () => {
    const target = { customerId: 'parents', rootId: 'r1', propertyId: 'home-p' };
    const base = { estimates: [{ id: 'est-1' }], customers: live('son', 'parents'), multi_home_family_members: [{ customer_id: 'son', family_id: 'f' }, { customer_id: 'parents', family_id: 'f' }] };
    mockEligible.mockResolvedValue(true);
    expect(await relationshipHolds(fakeTrx(base), { source: src, target })).toBe(true);
    expect(await relationshipHolds(fakeTrx({ ...base, estimates: [] }), { source: src, target })).toBe(false);
    expect(await relationshipHolds(fakeTrx({ ...base, customers: live('son') }), { source: src, target })).toBe(false);
    expect(await relationshipHolds(fakeTrx({ ...base, customers: [...live('son'), { id: 'parents', active: true, deleted_at: new Date() }] }), { source: src, target })).toBe(false);
    expect(await relationshipHolds(fakeTrx({ ...base, customers: [...live('son'), { id: 'parents', active: false, deleted_at: null }] }), { source: src, target })).toBe(false);
  });

  test('another profile: both must be in the SAME family that still has 2 or more live members', async () => {
    const target = { customerId: 'parents', rootId: 'r1', propertyId: null };
    const base = { estimates: [{ id: 'est-1' }], customers: live('son', 'parents') };
    mockEligible.mockResolvedValue(true);
    const rows = (a, b) => [{ customer_id: 'son', family_id: a }, { customer_id: 'parents', family_id: b }];
    expect(await relationshipHolds(fakeTrx({ ...base, multi_home_family_members: rows('f', 'f') }), { source: src, target })).toBe(true);
    expect(await relationshipHolds(fakeTrx({ ...base, multi_home_family_members: rows('f', 'g') }), { source: src, target })).toBe(false);
    expect(await relationshipHolds(fakeTrx({ ...base, multi_home_family_members: [{ customer_id: 'son', family_id: 'f' }] }), { source: src, target })).toBe(false);
    expect(await relationshipHolds(fakeTrx({ ...base, multi_home_family_members: [] }), { source: src, target })).toBe(false);
    mockEligible.mockResolvedValue(false);
    expect(await relationshipHolds(fakeTrx({ ...base, multi_home_family_members: rows('f', 'f') }), { source: src, target })).toBe(false);
  });

  test('the same profile: the target must be an active property that differs from the source\'s, both read now', async () => {
    // The selection-time propertyId is NOT trusted: the series' agreed house is read in the transaction.
    const target = { customerId: 'son', rootId: 'r1', propertyId: 'stale-value' };
    const base = { estimates: [{ id: 'est-1', property_id: 'home-s' }], customers: live('son') };
    const houses = (map) => mockAgreed.mockImplementation(async (rootId) => (rootId in map ? map[rootId] : null));
    houses({ r1: 'home-2' });
    expect(await relationshipHolds(fakeTrx({ ...base, customer_properties: [{ id: 'home-2' }] }), { source: src, target })).toBe(true);
    expect(await relationshipHolds(fakeTrx({ ...base, customer_properties: [] }), { source: src, target })).toBe(false);
    // The series moved to the source's own house after selection.
    houses({ r1: 'home-s' });
    expect(await relationshipHolds(fakeTrx({ ...base, customer_properties: [{ id: 'home-s' }] }), { source: src, target })).toBe(false);
    // The series names no agreed house any more.
    houses({});
    expect(await relationshipHolds(fakeTrx({ ...base, customer_properties: [{ id: 'home-2' }] }), { source: src, target })).toBe(false);
    // Source house unknown (no estimate property, no plan series): never shown to be another home.
    houses({ r1: 'home-2' });
    expect(await relationshipHolds(fakeTrx({ ...base, estimates: [{ id: 'est-1', property_id: null }], customer_properties: [{ id: 'home-2' }] }), { source: src, target })).toBe(false);
    // Source house from its plan series when the estimate names none.
    houses({ r1: 'home-2', r0: 'home-s' });
    expect(await relationshipHolds(fakeTrx({ ...base, estimates: [{ id: 'est-1', property_id: null }], customer_properties: [{ id: 'home-2' }] }), { source: { ...src, roots: new Set(['r0']) }, target })).toBe(true);
  });

  test('a series that is no longer a target counts as dropped: no hold, no bell, no price', async () => {
    const dbh = dbhStub();
    const out = fresh();
    await settleTarget(dbh, source, targets[0], { skipped: true, dropped: true }, new Date(), out);
    expect(out).toMatchObject({ dropped: 1, skipped: 0, held: 0, applied: 0 });
    expect(dbh.raw).not.toHaveBeenCalled();
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('a held ledger row for a series that is no longer a target is deleted; applied and current rows stay', async () => {
    const del = jest.fn(async () => 1);
    const dbh = jest.fn(() => ({ where: () => ({ del }) }));
    const ledger = new Map([['gone', { status: 'held' }], ['kept', { status: 'held' }], ['done', { status: 'applied' }]]);
    const out = fresh();
    await pruneStaleHeld(dbh, source, [{ rootId: 'kept' }], ledger, out);
    expect(del).toHaveBeenCalledTimes(1);
    expect(out.dropped).toBe(1);
  });
});

describe('already_discounted is only recorded when the next spawn is discounted too', () => {
  const upcoming = [{ id: 'v1', estimated_price: '105.30', primary_line_price: '117.00', discount_dollars: '11.70' }, { id: 'v2', estimated_price: '105.30', primary_line_price: '117.00', discount_dollars: '11.70' }];
  const target = { customerId: 'parents', rootId: 'root' };

  // The production price walk (seriesNextOccurrencesPrice) is faked from the stored parent: the next spawn prices the
  // parent overlaid with its stamped overrides, plus any recurring add-on. The real function runs in the Postgres suite.
  function setup({ overrides = null, stampWorks = true, addons = [], walk = null } = {}) {
    const parent = { id: 'root', estimated_price: 117, recurring_template_overrides: overrides };
    const price = () => {
      const row = { ...parent, ...(parent.recurring_template_overrides || {}) };
      const gross = Number(row.primary_line_price) || Number(row.estimated_price);
      const off = row.discount_type === 'percentage' ? Math.round(gross * Number(row.discount_amount)) / 100 : 0;
      return Math.round((gross - off) * 100) / 100 + addons.reduce((sum, a) => sum + a.estimated_price, 0);
    };
    const schedule = {
      acquireRecurringSeriesMaintenanceLock: jest.fn(async () => {}),
      loadStoredDiscountScope: async () => null,
      calculateStoredVisitFinancials: (row) => {
        const gross = Number(row.primary_line_price) || Number(row.estimated_price);
        const off = row.discount_type === 'percentage' ? Math.round(gross * Number(row.discount_amount)) / 100 : 0;
        return { price: Math.round((gross - off) * 100) / 100 };
      },
      seriesNextOccurrencesPrice: jest.fn(async () => (walk !== null ? walk : { unverified: false, price: price() })),
      stampRecurringTemplateOverrides: jest.fn(async (_t, _id, fields) => { if (stampWorks) parent.recurring_template_overrides = { ...(parent.recurring_template_overrides || {}), ...fields }; }),
    };
    return { parent, schedule, trx: fakeTrx({ scheduled_services: [parent] }) };
  }
  const run = (env, reason) => verifyTemplateForAlready(env.trx, env.schedule, { target, preset: PRESET, upcoming, reason });

  test('a template that already spawns at the discounted price needs no write', async () => {
    const env = setup({ overrides: { primary_line_price: 117, discount_type: 'percentage', discount_amount: 10 } });
    expect(await run(env, 'all_upcoming_visits_carry_it')).toEqual({ templateStamped: false });
    expect(env.schedule.stampRecurringTemplateOverrides).not.toHaveBeenCalled();
    expect(env.schedule.acquireRecurringSeriesMaintenanceLock).toHaveBeenCalledWith(env.trx, 'root', false);
  });

  test('visits carry it but the template does not: the template is stamped and the spawn proven', async () => {
    const env = setup();
    expect(await run(env, 'all_upcoming_visits_carry_it')).toEqual({ templateStamped: true });
    const fields = env.schedule.stampRecurringTemplateOverrides.mock.calls[0][2];
    expect(fields).toMatchObject({ primary_line_price: 117, estimated_price: 105.3, discount_id: 'preset-1', discount_type: 'percentage', discount_amount: 10 });
  });

  test('a template the stamp cannot fix holds as template_not_discounted (the stamp rolls back with the transaction)', async () => {
    await expect(run(setup({ stampWorks: false }), 'all_upcoming_visits_carry_it')).rejects.toMatchObject({ holdCode: 'template_not_discounted' });
    await expect(run(setup({ addons: [{ id: 'a', estimated_price: 20 }] }), 'all_upcoming_visits_carry_it')).rejects.toMatchObject({ holdCode: 'template_not_discounted' });
  });

  test('sold with the discount netted in: a template that spawns at another price holds and is never stamped', async () => {
    const sold = [{ id: 'v1', estimated_price: '105.30' }, { id: 'v2', estimated_price: '105.30' }];
    const env = setup();
    await expect(verifyTemplateForAlready(env.trx, env.schedule, { target, preset: PRESET, upcoming: sold, reason: 'sold_with_multi_home_discount' })).rejects.toMatchObject({ holdCode: 'template_not_discounted' });
    expect(env.schedule.stampRecurringTemplateOverrides).not.toHaveBeenCalled();
    const ok = setup({ overrides: { estimated_price: 105.3, primary_line_price: 105.3 } });
    expect(await verifyTemplateForAlready(ok.trx, ok.schedule, { target, preset: PRESET, upcoming: sold, reason: 'sold_with_multi_home_discount' })).toEqual({ templateStamped: false });
  });

  test('the price comes from production\'s own walk; a walk that cannot finish is unproven, and a series with no spawn needs no proof', async () => {
    const env = setup({ walk: { unverified: true, price: 0 } });
    await expect(run(env, 'all_upcoming_visits_carry_it')).rejects.toMatchObject({ holdCode: 'template_not_discounted' });
    expect(env.schedule.seriesNextOccurrencesPrice).toHaveBeenCalledWith(env.trx, 'root');
    const none = setup({ walk: null });
    none.schedule.seriesNextOccurrencesPrice = jest.fn(async () => null);
    expect(await run(none, 'all_upcoming_visits_carry_it')).toEqual({ templateStamped: false });
    expect(none.schedule.stampRecurringTemplateOverrides).not.toHaveBeenCalled();
  });

  test('visits at different prices hold', async () => {
    const env = setup();
    await expect(verifyTemplateForAlready(env.trx, env.schedule, { target, preset: PRESET, upcoming: [upcoming[0], { ...upcoming[1], estimated_price: '99.00' }], reason: 'all_upcoming_visits_carry_it' })).rejects.toMatchObject({ holdCode: 'visit_prices_differ' });
  });
});

describe('every source in the window is visited, and a source that stops qualifying leaves nothing behind', () => {
  // A fake estimates query that answers pages in order and records the keyset it was asked for.
  function pagedDb(pages) {
    const calls = [];
    const dbh = jest.fn(() => {
      const call = { limit: null, keyset: null, raw: [] };
      calls.push(call);
      const q = {
        where: () => q, whereNotNull: () => q, orderBy: () => q,
        whereRaw: (sql, bindings) => { call.raw.push([sql, bindings]); if (/accepted_at, id\) >/.test(sql)) call.keyset = bindings; return q; },
        limit: (n) => { call.limit = n; return q; },
        select: async () => pages[calls.length - 1] || [],
      };
      return q;
    });
    dbh.raw = jest.fn((sql) => sql);
    return { dbh, calls };
  }
  const est = (n) => ({ id: `e${n}`, accepted_key: `2026-11-0${n} 10:00:00.123456+00` });

  test('more sources than one page are all visited, by keyset', async () => {
    const { dbh, calls } = pagedDb([[est(1), est(2)], [est(3), est(4)], [est(5)]]);
    const seen = [];
    await eachSourceEstimate(dbh, new Date('2026-11-06T15:00:00Z'), async (e) => { seen.push(e.id); }, 2);
    expect(seen).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.limit === 2)).toBe(true);
    expect(calls[0].keyset).toBeNull();
    expect(calls[1].keyset).toEqual(['2026-11-02 10:00:00.123456+00', 'e2']);
    expect(calls[2].keyset).toEqual(['2026-11-04 10:00:00.123456+00', 'e4']);
  });

  test('an exact multiple of the page size ends on the empty page; a short first page needs no second read', async () => {
    const exact = pagedDb([[est(1), est(2)], []]);
    const seen = [];
    await eachSourceEstimate(exact.dbh, new Date(), async (e) => { seen.push(e.id); }, 2);
    expect(seen).toEqual(['e1', 'e2']);
    expect(exact.calls).toHaveLength(2);
    const short = pagedDb([[est(1)]]);
    await eachSourceEstimate(short.dbh, new Date(), async () => {}, 2);
    expect(short.calls).toHaveLength(1);
  });

  test('the prefilter matches the preset by key OR by catalog id, so an id-only stored discount is found', async () => {
    const withId = pagedDb([[]]);
    await eachSourceEstimate(withId.dbh, new Date(), async () => {}, 2, 'preset-1');
    const [sql, bindings] = withId.calls[0].raw[0];
    expect(sql).toMatch(/LIKE '%multi_home%' OR estimate_data::text LIKE \?/);
    expect(bindings).toEqual(['%preset-1%']);
    const keyOnly = pagedDb([[]]);
    await eachSourceEstimate(keyOnly.dbh, new Date(), async () => {}, 2, null);
    expect(keyOnly.calls[0].raw[0][0]).toBe("estimate_data::text LIKE '%multi_home%'");
  });

  test('the production page is large enough to matter and the gate-off path never reads', async () => {
    const { dbh, calls } = pagedDb([[]]);
    await eachSourceEstimate(dbh, new Date(), async () => {});
    expect(calls[0].limit).toBeGreaterThanOrEqual(200);
  });

  test('a source that no longer qualifies loses its HELD rows and their bells (applied rows stay)', async () => {
    mockGate.episodes = true;
    const held = [{ id: 'l1', source_estimate_id: 'est-9', series_root_id: 'rootA' }, { id: 'l2', source_estimate_id: 'est-9', series_root_id: 'rootB' }];
    const trx = fakeTrx({ multi_home_discount_applications: held });
    const out = { dropped: 0 };
    await dropHeldForSource(trx, 'est-9', out);
    expect(out.dropped).toBe(2);
    expect(mockClose).toHaveBeenCalledTimes(2);
    const keys = mockClose.mock.calls[0][1];
    expect(keys).toContain('multi-home-discount-hold:est-9:rootA:plan_on_hold');
    expect(keys.every((k) => k.startsWith('multi-home-discount-hold:est-9:rootA:'))).toBe(true);
    expect(mockClose.mock.calls[1][1][0]).toMatch(/:rootB:/);
    const none = { dropped: 0 };
    await dropHeldForSource(fakeTrx({ multi_home_discount_applications: [] }), 'est-9', none);
    expect(none.dropped).toBe(0);
  });

  test('processSource on an estimate that no longer qualifies clears its held rows and applies nothing', async () => {
    const held = [{ id: 'l1', source_estimate_id: 'est-9', series_root_id: 'rootA' }];
    const trx = fakeTrx({ multi_home_discount_applications: held });
    const out = { sources: 0, dropped: 0 };
    await processSource(trx, { id: 'est-9', customer_id: 'son', estimate_data: {} }, null, { now: new Date(), today: '2026-11-06' }, out);
    expect(out).toEqual({ sources: 0, dropped: 1 });
  });

  test('a held row whose accepted, in-window source no longer carries the Multi-Home Discount is cleared', async () => {
    const now = new Date('2026-11-06T15:00:00Z');
    const acceptedAt = new Date('2026-11-05T15:00:00Z');
    const withPreset = { summary: { manualDiscount: { presetKey: 'multi_home', type: 'PERCENT', value: 10, recurringAmount: 40, amount: 40 } } };
    const rows = [
      { id: 'keep', source_estimate_id: 'est-a', series_root_id: 'rootA', estimate_status: 'accepted', accepted_at: acceptedAt, estimate_data: withPreset },
      { id: 'gone', source_estimate_id: 'est-b', series_root_id: 'rootB', estimate_status: 'accepted', accepted_at: acceptedAt, estimate_data: {} },
    ];
    const joined = fakeTrx({ 'multi_home_discount_applications as m': rows, multi_home_discount_applications: rows });
    const out = { dropped: 0 };
    await pruneOutOfScopeHeld(joined, now, out, 'preset-1');
    expect(out.dropped).toBe(1);
  });

  test('held rows whose source left the window or stopped being accepted are cleared in one pass', async () => {
    const trx = fakeTrx({ multi_home_discount_applications: [] });
    const rows = [{ id: 'l1', source_estimate_id: 'old-1', series_root_id: 'rootA' }];
    const joined = fakeTrx({ 'multi_home_discount_applications as m': rows, multi_home_discount_applications: rows });
    const out = { dropped: 0 };
    await pruneOutOfScopeHeld(joined, new Date('2026-11-06T15:00:00Z'), out);
    expect(out.dropped).toBe(1);
    const nothing = { dropped: 0 };
    await pruneOutOfScopeHeld(trx, new Date(), nothing);
    expect(nothing.dropped).toBe(0);
  });
});

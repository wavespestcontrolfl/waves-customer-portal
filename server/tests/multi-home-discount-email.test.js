/**
 * "Your Multi-Home Discount is on" email: the decisions that need no database (trigger, grouping, greeting, cell values,
 * idempotency key, gate). The real-schema half (PR 2 applies, then the email is recorded once through the real template
 * and a fake provider) is multi-home-discount-email-postgres.test.js. Synthetic names, addresses and ids only.
 */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('db must not be touched'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockGate = { email: true, discount: true };
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  multiHomeDiscountEmailLive: () => mockGate.email,
  multiHomeAllHomesLive: () => mockGate.discount,
}));

const mockApply = {
  describeSource: jest.fn(),
  targetsForSource: jest.fn(),
  eachSourceEstimate: jest.fn(),
};
jest.mock('../services/multi-home-discount-apply', () => ({
  TABLE: 'multi_home_discount_applications',
  multiHomeSourceDiscount: (data) => data?.summary?.manualDiscount || null,
  _private: {
    PRESET_KEY: 'multi_home',
    MAX_SOURCES: 200,
    describeSource: (...a) => mockApply.describeSource(...a),
    targetsForSource: (...a) => mockApply.targetsForSource(...a),
    eachSourceEstimate: (...a) => mockApply.eachSourceEstimate(...a),
  },
}));
const mockAutopay = { on: jest.fn(), method: jest.fn() };
jest.mock('../services/autopay-eligibility', () => ({
  customerOnAutopay: (...a) => mockAutopay.on(...a),
  getChargeableAutopayMethod: (...a) => mockAutopay.method(...a),
  isBankMethodType: (t) => t === 'us_bank_account',
}));

const logger = require('../services/logger');
const email = require('../services/multi-home-discount-email');

const { openTargetReason, sourcePrices, targetPrices, idempotencyKeyFor, weekdayDate, money, processSource, greetingFor } = email._private;

const TODAY = '2026-11-06';
const NOW = new Date('2026-11-06T15:00:00Z');
const EST = 'est-1';
const md = (extra = {}) => ({ presetKey: 'multi_home', type: 'PERCENT', value: 10, recurringAmount: 40, amount: 40, ...extra });

// A tiny knex stand-in: tables filtered by where/whereIn, raw() answers the visit query by series root.
function fakeDb({ tables = {}, visits = {}, rawError = null }) {
  const dbh = (name) => {
    let rows = tables[name] || [];
    const q = {
      where(cond) { rows = rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      whereIn(col, vals) { const set = vals.map(String); rows = rows.filter((r) => set.includes(String(r[col]))); return q; },
      // SQL-only filters (the retry backoff's status/clock test) keep the rows the test seeded for that table.
      whereRaw() { return q; },
      whereNotNull(col) { rows = rows.filter((r) => r[col] != null); return q; },
      whereNull(col) { rows = rows.filter((r) => r[col] == null); return q; },
      orderBy() { return q; },
      forShare() { return q; },
      distinct() { return q; },
      select() { return q; },
      first() { return Promise.resolve(rows[0]); },
      then(res, rej) { return Promise.resolve(rows).then(res, rej); },
    };
    return q;
  };
  dbh.raw = jest.fn(async (_sql, params) => {
    if (rawError) throw rawError;
    return { rows: visits[params[0]] || [] };
  });
  dbh.touched = () => dbh.raw.mock.calls.length;
  // The provider handoff's transaction runs on the same tables.
  dbh.transaction = jest.fn(async (work) => work(dbh));
  return dbh;
}

const visit = (date, price, extra = {}) => ({
  id: `v-${date}`, scheduled_date: date, estimated_price: price, primary_line_price: null, discount_id: null,
  service_type: 'Quarterly Pest Control Service', property_id: null, service_address_line1: null, service_address_line2: null,
  cadence: 'quarterly', ...extra,
});

const customer = (id, extra = {}) => ({
  id, first_name: 'Sample', last_name: 'Example', email: `${id}@example.invalid`, payer_id: null, billing_mode: 'per_application',
  autopay_enabled: true, autopay_paused_until: null, autopay_payment_method_id: null, ach_status: null,
  address_line1: `${id} Profile Road`, address_line2: null, ...extra,
});

const ledgerRow = (rootId, status, extra = {}) => ({
  source_estimate_id: EST, series_root_id: rootId, status, price_before: '120.00', price_after: '108.00', first_visit_date: '2026-11-14', ...extra,
});

function scenario({ targets = [], ledger = [], customers = [], payers = [], prefs = [], properties = [], visits = {}, estimateData, sourceExtra = {} }) {
  const source = { estimateId: EST, customerId: 'son', propertyId: 'prop-son', roots: new Set(['root-son']), presetId: 'preset-1', ...sourceExtra };
  mockApply.describeSource.mockResolvedValue(source);
  mockApply.targetsForSource.mockResolvedValue(targets);
  const dbh = fakeDb({
    tables: {
      multi_home_discount_applications: ledger,
      customers,
      payers,
      notification_prefs: prefs,
      customer_properties: [{ id: 'prop-son', customer_id: 'son', address_line1: '10 New Home Lane', address_line2: null }, ...properties],
    },
    visits: { 'root-son': [visit('2026-11-14', '90.00')], ...visits },
  });
  const estimate = { id: EST, customer_id: 'son', estimate_data: estimateData || { summary: { manualDiscount: md() } } };
  return { dbh, estimate };
}

const target = (rootId, customerId, propertyId = null) => ({ customerId, rootId, propertyId });
const emptyOut = () => ({ sources: 0, waiting: 0, sent: 0, deduped: 0, blocked: 0, failed: 0, skipped: 0, noAddress: 0 });

async function run(sc, send) {
  const out = emptyOut();
  // The production price walk is faked: no extension to price unless a test says so.
  await processSource(sc.dbh, sc.estimate, { presetId: 'preset-1', today: TODAY, send, nextPrices: sc.nextPrices || (async () => null) }, out);
  return out;
}

const sendOk = () => jest.fn(async () => ({ sent: true, providerAttempted: true }));

beforeEach(() => {
  jest.clearAllMocks();
  mockGate.email = true;
  mockGate.discount = true;
  mockAutopay.on.mockReset();
  mockAutopay.on.mockResolvedValue(true);
  mockAutopay.method.mockReset();
  mockAutopay.method.mockResolvedValue({ method_type: 'card' });
});

describe('the gate', () => {
  test('email gate off: no query, no send', async () => {
    mockGate.email = false;
    const send = sendOk();
    expect(await email.runMultiHomeDiscountEmail({ now: NOW, send })).toEqual({ ok: false, reason: 'gate_off' });
    expect(mockApply.eachSourceEstimate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  test('PR 2 gate off: no query, no send', async () => {
    mockGate.discount = false;
    const send = sendOk();
    expect(await email.runMultiHomeDiscountEmail({ now: NOW, send })).toEqual({ ok: false, reason: 'discount_job_off' });
    expect(mockApply.eachSourceEstimate).not.toHaveBeenCalled();
  });

  test('gate on: reads the same in-window sources PR 2 reads', async () => {
    const dbh = fakeDb({ tables: { discounts: [{ id: 'preset-1', discount_key: 'multi_home' }] } });
    mockApply.eachSourceEstimate.mockImplementation(async (_d, _n, visitFn) => { await visitFn({ id: EST }); });
    mockApply.describeSource.mockResolvedValue(null);
    const out = await email.runMultiHomeDiscountEmail({ now: NOW, dbh, send: sendOk() });
    expect(out).toMatchObject({ ok: true, sources: 0 });
    expect(mockApply.eachSourceEstimate).toHaveBeenCalledWith(dbh, NOW, expect.any(Function), 200, 'preset-1');
  });
});

describe('when it sends', () => {
  test('every current target applied or already_discounted: one email per paying address', async () => {
    const sc = scenario({
      targets: [target('root-a', 'parents'), target('root-b', 'aunt')],
      ledger: [ledgerRow('root-a', 'applied'), ledgerRow('root-b', 'already_discounted')],
      customers: [customer('son'), customer('parents'), customer('aunt')],
      visits: { 'root-a': [visit('2026-11-14', '108.00')], 'root-b': [visit('2026-11-16', '108.00')] },
    });
    const send = sendOk();
    const out = await run(sc, send);
    expect(out).toMatchObject({ sent: 3, waiting: 0 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  test.each([
    ['a held target', [ledgerRow('root-a', 'applied'), ledgerRow('root-b', 'held')]],
    ['a target with no ledger row yet', [ledgerRow('root-a', 'applied')]],
  ])('%s: nothing is sent, the source waits', async (_label, ledger) => {
    const sc = scenario({
      targets: [target('root-a', 'parents'), target('root-b', 'aunt')],
      ledger,
      customers: [customer('son'), customer('parents'), customer('aunt')],
    });
    const send = sendOk();
    const out = await run(sc, send);
    expect(out).toMatchObject({ sent: 0, waiting: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  test('a held row for a series that is no longer a target is ignored; its applied history is too', async () => {
    const sc = scenario({
      targets: [target('root-a', 'parents')],
      ledger: [ledgerRow('root-a', 'applied'), ledgerRow('root-gone', 'held'), ledgerRow('root-old', 'applied')],
      customers: [customer('son'), customer('parents')],
      visits: { 'root-a': [visit('2026-11-14', '108.00')] },
    });
    const send = sendOk();
    const out = await run(sc, send);
    expect(out.sent).toBe(2);
    const homesSent = send.mock.calls.map(([args]) => args.payload.home_1_address).sort();
    expect(homesSent).toEqual(['10 New Home Lane', 'parents Profile Road']);
  });

  test('no target series at all: the source home still gets its email', async () => {
    const sc = scenario({ targets: [], ledger: [], customers: [customer('son')] });
    const send = sendOk();
    const out = await run(sc, send);
    expect(out.sent).toBe(1);
    expect(send.mock.calls[0][0].payload).toMatchObject({ home_1_address: '10 New Home Lane', home_1_service: 'Quarterly Pest Control Service' });
    expect(send.mock.calls[0][0].payload.home_2_address).toBeUndefined();
  });

  test('not a valid source (PR 2 would skip it): no ledger read, no send', async () => {
    const sc = scenario({});
    mockApply.describeSource.mockResolvedValue(null);
    const send = sendOk();
    expect(await run(sc, send)).toMatchObject({ sources: 0, sent: 0 });
    expect(mockApply.targetsForSource).not.toHaveBeenCalled();
  });
});

describe('who gets it, and the greeting', () => {
  test('homes that pay to one address (any letter case) share ONE email, new home first; greeting is that profile\'s first name', async () => {
    const sc = scenario({
      targets: [target('root-a', 'parents')],
      ledger: [ledgerRow('root-a', 'applied')],
      customers: [customer('son', { first_name: 'Robin', email: 'Shared@Example.invalid' }), customer('parents', { first_name: 'Pat', email: 'shared@example.INVALID' })],
      visits: { 'root-a': [visit('2026-11-14', '108.00')] },
    });
    const send = sendOk();
    await run(sc, send);
    expect(send).toHaveBeenCalledTimes(1);
    const args = send.mock.calls[0][0];
    expect(args.payload).toMatchObject({ greeting_name: 'Robin', home_1_address: '10 New Home Lane', home_2_address: 'parents Profile Road' });
    expect(args).toMatchObject({ templateKey: 'customer.multi_home_discount_on', recipientType: 'customer', recipientId: 'son', categories: ['multi_home_discount_on'] });
  });

  test('a home billed to a Bill-To payer goes to the payer\'s AP email, greets the payer by first word, and says invoice by email', async () => {
    const sc = scenario({
      targets: [target('root-a', 'parents')],
      ledger: [ledgerRow('root-a', 'applied')],
      customers: [customer('son'), customer('parents', { payer_id: 7 })],
      payers: [{ id: 7, display_name: 'Morgan Example', company_name: null, ap_email: 'ap@example.invalid', active: true }],
      visits: { 'root-a': [visit('2026-11-14', '108.00')] },
    });
    const send = sendOk();
    await run(sc, send);
    const byTo = Object.fromEntries(send.mock.calls.map(([a]) => [a.to, a]));
    expect(Object.keys(byTo).sort()).toEqual(['ap@example.invalid', 'son@example.invalid']);
    expect(byTo['ap@example.invalid'].payload).toMatchObject({ greeting_name: 'Morgan', home_1_address: 'parents Profile Road', home_1_payment: 'Invoice to you by email' });
    expect(byTo['ap@example.invalid']).toMatchObject({ recipientType: 'payer', recipientId: '7' });
    expect(byTo['ap@example.invalid'].payload.home_2_address).toBeUndefined();
    // Another customer's data never rides along: the son's own email lists only the son's home.
    expect(byTo['son@example.invalid'].payload).toMatchObject({ greeting_name: 'Sample', home_1_address: '10 New Home Lane' });
    expect(byTo['son@example.invalid'].payload.home_2_address).toBeUndefined();
  });

  test('a payer that is inactive or has no usable AP email falls back to the profile\'s own email', async () => {
    const sc = scenario({
      targets: [target('root-a', 'parents'), target('root-b', 'aunt')],
      ledger: [ledgerRow('root-a', 'applied'), ledgerRow('root-b', 'applied')],
      customers: [customer('son'), customer('parents', { payer_id: 7 }), customer('aunt', { payer_id: 8 })],
      payers: [
        { id: 7, display_name: 'Off Payer', ap_email: 'off@example.invalid', active: false },
        { id: 8, display_name: 'No Email', ap_email: 'not-an-email', active: true },
      ],
      visits: { 'root-a': [visit('2026-11-14', '108.00')], 'root-b': [visit('2026-11-15', '108.00')] },
    });
    const send = sendOk();
    await run(sc, send);
    expect(send.mock.calls.map(([a]) => a.to).sort()).toEqual(['aunt@example.invalid', 'parents@example.invalid', 'son@example.invalid']);
  });

  test('no email address: no email for that group, logged; the other groups still go', async () => {
    const sc = scenario({
      targets: [target('root-a', 'parents')],
      ledger: [ledgerRow('root-a', 'applied')],
      customers: [customer('son'), customer('parents', { email: '' })],
      visits: { 'root-a': [visit('2026-11-14', '108.00')] },
    });
    const send = sendOk();
    const out = await run(sc, send);
    expect(out).toMatchObject({ sent: 1, noAddress: 1 });
    expect(send.mock.calls[0][0].to).toBe('son@example.invalid');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('no email address'));
  });

  test('a profile with its portal-wide email switch off is left out', async () => {
    const sc = scenario({
      targets: [target('root-a', 'parents')],
      ledger: [ledgerRow('root-a', 'applied')],
      customers: [customer('son'), customer('parents')],
      prefs: [{ customer_id: 'parents', email_enabled: false }],
      visits: { 'root-a': [visit('2026-11-14', '108.00')] },
    });
    const send = sendOk();
    const out = await run(sc, send);
    expect(out.sent).toBe(1);
    expect(send.mock.calls.map(([a]) => a.to)).toEqual(['son@example.invalid']);
  });

  test('an unreadable email switch is not read as "on": the source is not sent this tick', async () => {
    const sc = scenario({ customers: [customer('son')] });
    const original = sc.dbh;
    const dbh = (name) => (name === 'notification_prefs' ? { whereIn: () => ({ where: () => ({ select: () => Promise.reject(new Error('relation missing')) }) }) } : original(name));
    dbh.raw = original.raw;
    const send = sendOk();
    await expect(processSource(dbh, sc.estimate, { presetId: 'preset-1', today: TODAY, send, nextPrices: async () => null }, emptyOut())).rejects.toThrow('relation missing');
    expect(send).not.toHaveBeenCalled();
  });

  test('greeting falls back to "there" when the profile has no first name', () => {
    const group = { payer: null, homes: [{ customerId: 'x' }] };
    expect(greetingFor(group, new Map([['x', { first_name: '  ' }]]))).toBe('there');
    expect(greetingFor({ payer: { display_name: 'Morgan Example' }, homes: [] }, new Map())).toBe('Morgan');
    expect(greetingFor({ payer: { display_name: '' }, homes: [] }, new Map())).toBe('there');
  });

  test('more homes at one address than the email holds: not sent, logged', async () => {
    const targets = Array.from({ length: 8 }, (_, i) => target(`root-${i}`, 'parents'));
    const visits = Object.fromEntries(targets.map((t) => [t.rootId, [visit('2026-11-14', '108.00')]]));
    const sc = scenario({
      targets,
      ledger: targets.map((t) => ledgerRow(t.rootId, 'applied')),
      customers: [customer('son', { email: 'same@example.invalid' }), customer('parents', { email: 'same@example.invalid' })],
      visits,
    });
    const send = sendOk();
    const out = await run(sc, send);
    expect(out).toMatchObject({ sent: 0, skipped: 1 });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('more than the 8'));
  });
});

describe('cell values come from records and are left out when unreadable', () => {
  test('other homes: the PR 2 ledger gives Regular, discount, Per application and Starts', async () => {
    const sc = scenario({
      targets: [target('root-a', 'parents')],
      ledger: [ledgerRow('root-a', 'applied')],
      customers: [customer('son'), customer('parents')],
      visits: { 'root-a': [visit('2026-11-14', '108.00')] },
    });
    const send = sendOk();
    await run(sc, send);
    const parents = send.mock.calls.map(([a]) => a).find((a) => a.to === 'parents@example.invalid');
    expect(parents.payload).toMatchObject({
      home_1_address: 'parents Profile Road', home_1_service: 'Quarterly Pest Control Service', home_1_regular: '$120.00',
      home_1_discount: '-$12.00', home_1_price: '$108.00', home_1_starts: 'Sat, Nov 14', home_1_payment: 'Auto Pay card on file',
    });
  });

  test('the new home: price is the stored visit price; Regular is that price plus the stored discount slice per visit', async () => {
    const sc = scenario({ customers: [customer('son')] });
    const send = sendOk();
    await run(sc, send);
    expect(send.mock.calls[0][0].payload).toMatchObject({
      home_1_regular: '$100.00', home_1_discount: '-$10.00', home_1_price: '$90.00', home_1_starts: 'Sat, Nov 14',
    });
  });

  test('the new home with several series, no stored slice, a non-percent discount, an odd cadence or a mismatched percent: Regular and discount left out', () => {
    const facts = { flatPriceCents: 9000, cadence: 'quarterly' };
    const base = { estimateData: { summary: { manualDiscount: md() } }, presetId: 'p', facts, seriesCount: 1 };
    expect(sourcePrices(base)).toEqual({ priceCents: 9000, regularCents: 10000, discountCents: 1000, provable: true });
    // Several series: the arithmetic does not apply (provable false), so the plan is judged unchanged-since-sale instead.
    expect(sourcePrices({ ...base, seriesCount: 2 })).toEqual({ priceCents: 9000, regularCents: null, discountCents: null, provable: false });
    expect(sourcePrices({ ...base, estimateData: { summary: { manualDiscount: md({ recurringAmount: undefined }) } } }).regularCents).toBeNull();
    expect(sourcePrices({ ...base, estimateData: { summary: { manualDiscount: md({ type: 'FIXED' }) } } }).regularCents).toBeNull();
    expect(sourcePrices({ ...base, facts: { ...facts, cadence: 'every_6_weeks' } }).regularCents).toBeNull();
    expect(sourcePrices({ ...base, estimateData: { summary: { manualDiscount: md({ recurringAmount: 90 }) } } }).regularCents).toBeNull();
    expect(sourcePrices({ ...base, facts: { ...facts, flatPriceCents: null } })).toEqual({ priceCents: null, regularCents: null, discountCents: null, provable: true });
    expect(sourcePrices({ ...base, estimateData: {} }).regularCents).toBeNull();
  });

  test('the new home must match its stored discount to the cent: a repriced plan is not trusted', () => {
    const base = { estimateData: { summary: { manualDiscount: md() } }, presetId: 'p', seriesCount: 1 };
    // Sold at 90.00 with a 10.00 slice: Regular 100.00, 10% of it is 10.00.
    expect(sourcePrices({ ...base, facts: { flatPriceCents: 9000, cadence: 'quarterly' } }).regularCents).toBe(10000);
    // Repriced to 100.00 (or the discount taken off): 10% of 110.00 is 11.00, not the stored 10.00.
    expect(sourcePrices({ ...base, facts: { flatPriceCents: 10000, cadence: 'quarterly' } }).regularCents).toBeNull();
    expect(sourcePrices({ ...base, facts: { flatPriceCents: 9100, cadence: 'quarterly' } }).regularCents).toBeNull();
  });

  test('a provable new home that was repriced holds the whole email', async () => {
    const repriced = scenario({ customers: [customer('son')], visits: { 'root-son': [visit('2026-11-14', '100.00')] } });
    const send = sendOk();
    expect(await run(repriced, send)).toMatchObject({ waiting: 1, sent: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  test('a several-series new home unchanged since the sale is listed with its current price only', async () => {
    const several = scenario({
      customers: [customer('son')],
      sourceExtra: { roots: new Set(['root-son', 'root-son-lawn']) },
      visits: { 'root-son-lawn': [visit('2026-11-14', '45.00')] },
    });
    const send = sendOk();
    expect(await run(several, send)).toMatchObject({ waiting: 0, sent: 1 });
    const payload = send.mock.calls[0][0].payload;
    expect(payload.home_1_price).toBe('$90.00');
    expect(payload.home_1_regular).toBe('');
    expect(payload.home_1_discount).toBe('');
  });

  test('a several-series new home repriced through "this and following" (a price stamped on its template) holds the email', async () => {
    const several = scenario({
      customers: [customer('son')],
      sourceExtra: { roots: new Set(['root-son', 'root-son-lawn']) },
      visits: { 'root-son-lawn': [visit('2026-11-14', '45.00')] },
    });
    const tables = { scheduled_services: [{ id: 'root-son', recurring_template_overrides: { estimated_price: 95 } }] };
    const original = several.dbh;
    const dbh = (name) => (name === 'scheduled_services' ? fakeDb({ tables })(name) : original(name));
    dbh.raw = original.raw;
    const send = sendOk();
    expect(await run({ ...several, dbh }, send)).toMatchObject({ waiting: 1, sent: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  test('never divides a gross out of a net: no stored slice, no Regular', () => {
    const out = sourcePrices({ estimateData: { summary: { manualDiscount: md({ recurringAmount: 0 }) } }, presetId: 'p', facts: { flatPriceCents: 9000, cadence: 'quarterly' }, seriesCount: 1 });
    expect(out.regularCents).toBeNull();
  });

  test('already_discounted: the next visits give the price; Regular only when the visit carries the preset with its stored gross', () => {
    const carries = { first: { primary_line_price: '120.00', discount_id: 'preset-1' }, flatPriceCents: 10800, startsDate: '2026-11-16' };
    expect(targetPrices({ row: { status: 'already_discounted' }, facts: carries, presetId: 'preset-1' })).toEqual({
      priceCents: 10800, regularCents: 12000, discountCents: 1200, startsDate: '2026-11-16',
    });
    const sold = { first: { primary_line_price: null, discount_id: null }, flatPriceCents: 10800, startsDate: '2026-11-16' };
    expect(targetPrices({ row: { status: 'already_discounted' }, facts: sold, presetId: 'preset-1' })).toEqual({
      priceCents: 10800, regularCents: null, discountCents: null, startsDate: '2026-11-16',
    });
    expect(targetPrices({ row: { status: 'already_discounted' }, facts: { first: null, flatPriceCents: null, startsDate: null }, presetId: 'preset-1' }).priceCents).toBeNull();
  });

  test('another home whose upcoming visits are no longer at one price holds the whole email (it no longer proves its discount)', async () => {
    const sc = scenario({
      targets: [target('root-a', 'parents')],
      ledger: [ledgerRow('root-b-unused', 'applied'), ledgerRow('root-a', 'already_discounted')],
      customers: [customer('son'), customer('parents')],
      visits: { 'root-a': [visit('2026-11-14', '108.00'), visit('2027-02-13', '99.00')] },
    });
    const send = sendOk();
    const out = await run(sc, send);
    expect(send).not.toHaveBeenCalled();
    expect(out.waiting).toBe(1);
  });

  test.each([
    ['Auto Pay on a saved card', {}, true, { method_type: 'card' }, 'Auto Pay card on file'],
    ['no Auto Pay', {}, false, null, 'Invoice after each visit'],
    ['Auto Pay on a bank account (no card to name)', {}, true, { method_type: 'us_bank_account' }, ''],
    ['another billing basis', { billing_mode: 'monthly_membership' }, true, { method_type: 'card' }, ''],
  ])('how it is paid: %s', async (_label, profile, on, method, expected) => {
    mockAutopay.on.mockResolvedValue(on);
    mockAutopay.method.mockResolvedValue(method);
    const sc = scenario({ customers: [customer('son', profile)] });
    const send = sendOk();
    await run(sc, send);
    expect(send.mock.calls[0][0].payload.home_1_payment).toBe(expected);
  });

  test('an Auto Pay lookup that fails leaves the cell out, not a guess', async () => {
    mockAutopay.on.mockRejectedValue(new Error('boom'));
    const sc = scenario({ customers: [customer('son')] });
    const send = sendOk();
    await run(sc, send);
    expect(send.mock.calls[0][0].payload.home_1_payment).toBe('');
  });

  test('a home with no street address anywhere is not emailed about', async () => {
    const sc = scenario({ customers: [customer('son', { address_line1: '' })], properties: [], sourceExtra: { propertyId: null } });
    const send = sendOk();
    const out = await run(sc, send);
    expect(out.skipped).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  test('formatting helpers', () => {
    expect(weekdayDate('2026-11-14')).toBe('Sat, Nov 14');
    expect(weekdayDate('nope')).toBe('');
    expect(money(10800)).toBe('$108.00');
    expect(money(123456)).toBe('$1,234.56');
    expect(money(null)).toBe('');
  });
});

describe('once per (source estimate, paying address)', () => {
  test('the key is stable for the same address in any letter case and differs per estimate and per address', () => {
    const key = idempotencyKeyFor('est-1', 'a@example.invalid');
    expect(key).toBe(idempotencyKeyFor('est-1', 'a@example.invalid'));
    expect(key).not.toBe(idempotencyKeyFor('est-2', 'a@example.invalid'));
    expect(key).not.toBe(idempotencyKeyFor('est-1', 'b@example.invalid'));
    expect(key).toMatch(/^customer\.multi_home_discount_on:est-1:[0-9a-f]{32}$/);
    expect(key).not.toContain('example');
    expect(key.length).toBeLessThan(260);
  });

  test('each send carries the key of its own address, and a deduped or blocked result is not counted as a new send', async () => {
    const sc = scenario({
      targets: [target('root-a', 'parents')],
      ledger: [ledgerRow('root-a', 'applied')],
      customers: [customer('son'), customer('parents')],
      visits: { 'root-a': [visit('2026-11-14', '108.00')] },
    });
    const send = jest.fn(async ({ to }) => (to.startsWith('son') ? { sent: true, deduped: true } : { sent: false, blocked: true, deduped: true }));
    const out = await run(sc, send);
    expect(out).toMatchObject({ sent: 0, deduped: 1, blocked: 1, failed: 0 });
    const keys = send.mock.calls.map(([a]) => a.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toContain(idempotencyKeyFor(EST, 'son@example.invalid'));
  });

  test('a send that throws is counted, never rethrown, never retried here, and does not stop the other groups', async () => {
    const sc = scenario({
      targets: [target('root-a', 'parents')],
      ledger: [ledgerRow('root-a', 'applied')],
      customers: [customer('son'), customer('parents')],
      visits: { 'root-a': [visit('2026-11-14', '108.00')] },
    });
    const send = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('held son@example.invalid'), { code: 'EMAIL_PROVIDER_RETRY_HELD' }))
      .mockResolvedValueOnce({ sent: true });
    const out = await run(sc, send);
    expect(out).toMatchObject({ failed: 1, sent: 1 });
    expect(send).toHaveBeenCalledTimes(2);
    const logged = logger.warn.mock.calls.map((c) => c[0]).join(' ');
    expect(logged).toContain('EMAIL_PROVIDER_RETRY_HELD');
    expect(logged).not.toContain('example.invalid');
  });
});

describe('openTargetReason', () => {
  const t = (id) => ({ rootId: id });
  test('only applied and already_discounted rows, one per current target, pass', () => {
    const ledger = new Map([['a', { status: 'applied' }], ['b', { status: 'already_discounted' }]]);
    expect(openTargetReason([t('a'), t('b')], ledger)).toBeNull();
    expect(openTargetReason([], ledger)).toBeNull();
    expect(openTargetReason([t('a'), t('c')], ledger)).toBe('target_not_recorded');
    expect(openTargetReason([t('a')], new Map([['a', { status: 'held' }]]))).toBe('target_held');
    expect(openTargetReason([t('a')], new Map([['a', { status: 'weird' }]]))).toBe('target_unknown_status');
  });
});


describe('a failed send is never replayed from stored copy and is retried by the job at most once a day', () => {
  const { failedRecently, sendGroups, CATEGORY } = require('../services/multi-home-discount-email')._private;
  const { staleStoredCopyReason, MULTI_HOME_DISCOUNT_CATEGORY } = require('../constants/email-replay-exclusions');

  test('the email carries a category both stored-copy rails refuse to replay', () => {
    expect(CATEGORY).toBe(MULTI_HOME_DISCOUNT_CATEGORY);
    expect(staleStoredCopyReason([CATEGORY])).toMatch(/Not re-sent from stored copy/);
  });

  const fakeDb = (row) => {
    const chain = { where: () => chain, whereRaw: () => chain, first: async () => row };
    return jest.fn(() => chain);
  };

  test('failedRecently is true only when a recent FAILED row exists for the key', async () => {
    expect(await failedRecently(fakeDb({ id: 'm1' }), 'key')).toBe(true);
    expect(await failedRecently(fakeDb(undefined), 'key')).toBe(false);
    expect(await failedRecently(null, 'key')).toBe(false);
  });

  const { earlierAttemptVerdict } = require('../services/multi-home-discount-email')._private;
  const failedRow = { id: 'm1', status: 'failed' };

  test('earlierAttemptVerdict: a held (ambiguous) failure is never re-sent; a recent definite failure waits', async () => {
    expect(await earlierAttemptVerdict(fakeDb(failedRow), 'key', () => ({ code: 'ambiguous' }))).toBe('never');
    expect(await earlierAttemptVerdict(fakeDb(failedRow), 'key', () => null)).toBe('wait');
    expect(await earlierAttemptVerdict(fakeDb({ id: 'm1', status: 'sent' }), 'key', () => null)).toBe('send');
    expect(await earlierAttemptVerdict(fakeDb(undefined), 'key', () => null)).toBe('send');
    expect(await earlierAttemptVerdict(null, 'key', () => null)).toBe('send');
  });

  test('sendGroups: waits on a recent definite failure, skips a held one quietly, and sends neither', async () => {
    const send = jest.fn(async () => ({ sent: true, status: 'sent' }));
    const home = (id) => ({ customerId: id, address: '1 Example Way', isSource: true });
    const groups = () => [{ key: 'a@example.com', address: 'a@example.com', homes: [home('c1')] }];
    const out = () => ({ sent: 0, deduped: 0, blocked: 0, failed: 0, skipped: 0, waiting: 0 });
    const waiting = out();
    await sendGroups(send, groups(), { estimate: { id: 'est-1' }, customers: new Map(), dbh: fakeDb(failedRow), holdsEarlier: () => null }, waiting);
    expect(waiting.waiting).toBe(1);
    const held = out();
    await sendGroups(send, groups(), { estimate: { id: 'est-1' }, customers: new Map(), dbh: fakeDb(failedRow), holdsEarlier: () => ({}) }, held);
    expect(held.skipped).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });
});


describe('the ledger is history: another home is checked again before any email', () => {
  const { targetStillCurrent } = require('../services/multi-home-discount-email')._private;
  const facts = (price, extra = {}) => ({ first: { discount_id: null, ...extra }, flatPriceCents: price, startsDate: '2026-11-14' });
  const applied = { status: 'applied', price_after: '108.00' };
  const none = async () => null;

  test('applied: the visits must still be flat at the recorded discounted price', async () => {
    expect(await targetStillCurrent(null, { row: applied, facts: facts(10800, { discount_id: 'preset-1' }), presetId: 'preset-1', rootId: 'r', nextPrices: none })).toBe(true);
    // Staff removed the discount (price back to the regular one) or repriced the series.
    expect(await targetStillCurrent(null, { row: applied, facts: facts(12000), presetId: 'preset-1', rootId: 'r', nextPrices: none })).toBe(false);
    expect(await targetStillCurrent(null, { row: applied, facts: facts(9900, { discount_id: 'preset-1' }), presetId: 'preset-1', rootId: 'r', nextPrices: none })).toBe(false);
    // Visits no longer flat.
    expect(await targetStillCurrent(null, { row: applied, facts: facts(null), presetId: 'preset-1', rootId: 'r', nextPrices: none })).toBe(false);
  });

  test('another appointment discount replaced it: not current', async () => {
    expect(await targetStillCurrent(null, { row: applied, facts: facts(10800, { discount_id: 'military' }), presetId: 'preset-1', rootId: 'r', nextPrices: none })).toBe(false);
  });

  test('already discounted because the visits carried it: they must still carry it', async () => {
    const row = { status: 'already_discounted', detail: { reason: 'all_upcoming_visits_carry_it' } };
    expect(await targetStillCurrent(null, { row, facts: facts(10800, { discount_id: 'preset-1' }), presetId: 'preset-1', rootId: 'r', nextPrices: none })).toBe(true);
    expect(await targetStillCurrent(null, { row, facts: facts(10800), presetId: 'preset-1', rootId: 'r', nextPrices: none })).toBe(false);
    // Sold with the discount netted in: no visit stamp to check, the current flat price stands.
    const sold = { status: 'already_discounted', detail: JSON.stringify({ reason: 'sold_with_multi_home_discount' }) };
    expect(await targetStillCurrent(null, { row: sold, facts: facts(10800), presetId: 'preset-1', rootId: 'r', nextPrices: none })).toBe(true);
  });

  test('every next extension must price the same (production walk); an unfinished walk is unproven', async () => {
    const at = (prices) => async () => ({ unverified: false, prices });
    const ok = { row: applied, facts: facts(10800, { discount_id: 'preset-1' }), presetId: 'preset-1', rootId: 'r' };
    expect(await targetStillCurrent(null, { ...ok, nextPrices: at([108, 108]) })).toBe(true);
    expect(await targetStillCurrent(null, { ...ok, nextPrices: at([108, 120]) })).toBe(false);
    expect(await targetStillCurrent(null, { ...ok, nextPrices: async () => ({ unverified: true, prices: [] }) })).toBe(false);
  });
});


describe('every listed home proves its discount now: sold-with-discount homes and the new home\'s extensions', () => {
  const soldRow = (rootId) => ledgerRow(rootId, 'already_discounted', { price_before: null, price_after: null, detail: { reason: 'sold_with_multi_home_discount' } });
  const soldTables = (price) => ({
    targets: [target('root-p', 'parents')],
    ledger: [soldRow('root-p')],
    customers: [customer('son'), customer('parents')],
    visits: { 'root-p': [visit('2026-11-16', price)], 'est-parents': [{ id: 'root-p', recurring_parent_id: null }] },
  });
  const withSold = (sc) => {
    // The parents' series links ONE accepted estimate sold with the Multi-Home Discount netted in.
    const original = sc.dbh;
    const tables = { scheduled_services: [{ id: 'root-p', source_estimate_id: 'est-parents' }], estimates: [{ id: 'est-parents', status: 'accepted', estimate_data: { summary: { manualDiscount: md() } } }] };
    const dbh = (name) => (tables[name] ? fakeDb({ tables })(name) : original(name));
    dbh.raw = original.raw;
    return { ...sc, dbh };
  };

  test('a home sold with the discount netted in is proven from its own sold estimate and shows its Regular and 10%', async () => {
    const sc = withSold(scenario(soldTables('90.00')));
    const send = sendOk();
    const out = await run(sc, send);
    expect(out).toMatchObject({ sent: 2, waiting: 0 });
    const parents = send.mock.calls.map(([a]) => a).find((a) => a.to === 'parents@example.invalid');
    expect(parents.payload).toMatchObject({ home_1_regular: '$100.00', home_1_discount: '-$10.00', home_1_price: '$90.00' });
  });

  test('a sold-with-discount home repriced since the sale holds the whole email', async () => {
    const sc = withSold(scenario(soldTables('100.00')));
    const send = sendOk();
    expect(await run(sc, send)).toMatchObject({ sent: 0, waiting: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  test('the new home\'s next extensions must price the same: a different extension date holds the email', async () => {
    const sc = { ...scenario({ customers: [customer('son')] }), nextPrices: async () => ({ unverified: false, prices: [90, 100] }) };
    const send = sendOk();
    expect(await run(sc, send)).toMatchObject({ sent: 0, waiting: 1 });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the provider handoff reads the routing again under the comms locks', () => {
  const { groupByPayingAddress, routingHandoff } = email._private;

  // The handoff's transaction: the fake tables (a test edits them after grouping), with every advisory lock recorded.
  function handoffDb(tables) {
    const trx = fakeDb({ tables });
    const locks = [];
    trx.raw = jest.fn(async (_sql, params) => { locks.push(params[0]); return { rows: [] }; });
    return { dbh: { transaction: jest.fn(async (work) => work(trx)) }, trx, locks };
  }

  // Two homes, one per profile, grouped from the tables as they are now.
  async function groupNow(tables) {
    const customers = new Map(tables.customers.map((c) => [String(c.id), c]));
    const payers = new Map((tables.payers || []).map((p) => [String(p.id), p]));
    const homes = tables.customers.map((c, i) => ({ customerId: c.id, rootId: `root-${c.id}`, isSource: i === 0, address: `${i + 1} Example Way` }));
    const { groups } = await groupByPayingAddress(fakeDb({ tables }), homes, { customers, payers, optedOut: new Set() });
    return { groups, customers };
  }

  const shared = () => ({
    customers: [customer('son', { email: 'family@example.invalid' }), customer('parents', { email: 'Family@Example.invalid' })],
    payers: [],
    notification_prefs: [],
  });

  async function handoff(tables, edit) {
    const { groups, customers } = await groupNow(tables);
    expect(groups).toHaveLength(1);
    const group = groups[0];
    const greeting = email._private.payloadFor(group, customers).greeting_name;
    edit(tables);
    const { dbh, trx, locks } = handoffDb(tables);
    const state = { routingChanged: false };
    let locksAtDispatch = null;
    const dispatch = jest.fn(async (database) => { expect(database).toBe(trx); locksAtDispatch = [...locks]; });
    const verdict = await routingHandoff(dbh, group, greeting, state)(dispatch);
    return { verdict, dispatch, locks, locksAtDispatch, state };
  }

  test('unchanged: each profile\'s comms key in id order, then the address key, and the request runs inside the locks', async () => {
    const { verdict, dispatch, locksAtDispatch, state } = await handoff(shared(), () => {});
    expect(verdict).toEqual({ ok: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(locksAtDispatch).toEqual(['customer-comms:parents', 'customer-comms:son', 'customer-email:family@example.invalid']);
    expect(state.routingChanged).toBe(false);
  });

  test.each([
    ['a profile\'s email changed', (t) => { t.customers[1].email = 'moved@example.invalid'; }],
    ['a profile now bills to a payer with the same AP email (the payment line would be wrong)', (t) => {
      t.payers.push({ id: 9, display_name: 'Morgan Example', company_name: null, ap_email: 'family@example.invalid', active: true });
      t.customers[1].payer_id = 9;
    }],
    ['a profile turned email off', (t) => { t.notification_prefs.push({ customer_id: 'parents', email_enabled: false }); }],
    ['a profile was deleted', (t) => { t.customers[1].deleted_at = new Date(); }],
    ['the greeting changed', (t) => { t.customers[0].first_name = 'Robin'; }],
  ])('%s: refused before the request, no address lock, the job is told', async (_label, edit) => {
    const { verdict, dispatch, locks, state } = await handoff(shared(), edit);
    expect(verdict).toEqual({ ok: false, reason: 'recipient_changed' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(locks.some((k) => k.startsWith('customer-email:'))).toBe(false);
    expect(state.routingChanged).toBe(true);
  });

  test('a payer-routed group: the payer turned inactive or its AP email changed, refused', async () => {
    const paid = () => ({
      customers: [customer('son', { payer_id: 7 }), customer('parents', { payer_id: 7 })],
      payers: [{ id: 7, display_name: 'Morgan Example', company_name: null, ap_email: 'ap@example.invalid', active: true }],
      notification_prefs: [],
    });
    expect((await handoff(paid(), () => {})).verdict).toEqual({ ok: true });
    expect((await handoff(paid(), (t) => { t.payers[0].active = false; })).verdict).toEqual({ ok: false, reason: 'recipient_changed' });
    expect((await handoff(paid(), (t) => { t.payers[0].ap_email = 'new-ap@example.invalid'; })).verdict).toEqual({ ok: false, reason: 'recipient_changed' });
    expect((await handoff(paid(), (t) => { t.payers[0].display_name = 'Avery Example'; })).verdict).toEqual({ ok: false, reason: 'recipient_changed' });
  });

  test('a refusal at the handoff counts as waiting, and the log never names the address', async () => {
    const sc = scenario({
      targets: [target('root-a', 'parents')],
      ledger: [ledgerRow('root-a', 'applied')],
      customers: [customer('son'), customer('parents')],
      visits: { 'root-a': [visit('2026-11-14', '108.00')] },
    });
    // Staff change the parents' email after the job grouped the homes, before the request.
    const send = jest.fn(async (args) => {
      if (args.to === 'parents@example.invalid') {
        const rows = await sc.dbh('customers');
        rows.find((r) => r.id === 'parents').email = 'moved@example.invalid';
      }
      const verdict = await args.withProviderHandoff(async () => {});
      return verdict.ok ? { sent: true, providerAttempted: true } : { sent: false, aborted: true };
    });
    const out = await run(sc, send);
    expect(out).toMatchObject({ sent: 1, waiting: 1, failed: 0 });
    const logged = logger.info.mock.calls.map(([m]) => m).find((m) => m.includes('changed just before the send'));
    expect(logged).toBeTruthy();
    expect(logged).not.toContain('@');
  });
});


/**
 * Yearly application limits of the area add-ons (Codex round 7 P1 on #6135; owner ruling 2026-10-08,
 * ADD-ON-ONLY limits). The rule counts the applications of the add-on's PRODUCT at the property
 * (program and add-on applications together, booked-not-done add-ons too) and only ever blocks or
 * holds the ADD-ON, never a Tree & Shrub or lawn program visit.
 *
 * No database: the pure rule runs on injected summaries; the reader and the enforcement points run
 * against a small in-memory fake of the tables they read.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The treated-property scope itself is application-limits' own (tested there); here it keeps the rows placed on
// the property or unplaced, the way scopeHistoryToTreatment does.
jest.mock('../services/application-limits', () => ({
  scopeHistoryToTreatment: (query, _db, { propertyId } = {}) => {
    if (propertyId) query.where(function placedHereOrUnplaced() { this.whereNull('property_id').orWhere('property_id', propertyId); });
    return query;
  },
}));

// The hold grace (a lapsed hold still counts for this long): the reader asks slot-reservation, which this suite does not load.
jest.mock('../services/slot-reservation', () => ({ commitGraceMinutes: () => 10 }));

const fs = require('fs');
const path = require('path');
const { AREA_ADDONS } = require('../services/pricing-engine/constants');
const limits = require('../services/pricing-engine/area-addon-limits');
const { generateEstimate, areaAddOnCatalog } = require('../services/pricing-engine');
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
const service = require('../services/area-addon-limits');

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const PROPERTY = '22222222-2222-4222-8222-222222222222';
const OTHER_PROPERTY = '33333333-3333-4333-8333-333333333333';
const HOLD_ID = '88888888-8888-4888-8888-888888888881';
const OTHER_ESTIMATE = '99999999-9999-4999-8999-999999999991';
const ESTIMATE = '44444444-4444-4444-8444-444444444444';
const HOME = { homeSqFt: 2000, lotSqFt: 7500 };
const TODAY = '2026-10-09';
const daysBefore = (n) => limits.addDays(TODAY, -n);
const hist = (byKey) => ({ available: true, asOf: TODAY, byKey: Object.fromEntries(Object.entries(byKey).map(([k, dates]) => [k, { dates }])) });

let savedGate;
beforeEach(() => { savedGate = process.env.GATE_AREA_ADDONS; process.env.GATE_AREA_ADDONS = 'true'; });
afterEach(() => {
  if (savedGate === undefined) delete process.env.GATE_AREA_ADDONS; else process.env.GATE_AREA_ADDONS = savedGate;
});

describe('the rule table: each add-on at its limit and one under it', () => {
  // [key, dates that are AT the limit today, dates one under it]
  test.each([
    // Snapshot: 4 in any 12 months, 60 days apart. Four spread applications fill it; three do not.
    ['bed_pre_emergent', [daysBefore(300), daysBefore(220), daysBefore(140), daysBefore(70)], [daysBefore(300), daysBefore(220), daysBefore(140)]],
    // Snapshot: 60 days since the last one, whatever the count.
    ['bed_pre_emergent', [daysBefore(59)], [daysBefore(60)]],
    // Arena: 2 in 12 months, 56 days (8 weeks) apart.
    ['lawn_insect_spot', [daysBefore(200), daysBefore(100)], [daysBefore(100)]],
    ['lawn_insect_spot', [daysBefore(55)], [daysBefore(56)]],
    ['fire_ant_yard', [daysBefore(364)], [daysBefore(365)]],
    ['lawn_insect_preventive', [daysBefore(30)], [daysBefore(400)]],
    // Roundup QuikPro SC: 2 in 12 months, no spacing.
    ['hardscape_weed', [daysBefore(300), daysBefore(2)], [daysBefore(300)]],
  ])('%s: blocked at %j, open at %j', (key, atLimit, under) => {
    expect(limits.areaAddOnLimitVerdict(key, hist({ [key]: atLimit }))).toMatchObject({ reason: 'area_addon_yearly_limit_reached' });
    expect(limits.areaAddOnLimitVerdict(key, hist({ [key]: under }))).toBeNull();
  });

  test('the web sweep has no limit, however long its history', () => {
    expect(AREA_ADDONS.items.web_sweep.maxPerYear).toBeNull();
    expect(limits.areaAddOnLimitVerdict('web_sweep', hist({ web_sweep: Array.from({ length: 30 }, (_, i) => daysBefore(i)) }))).toBeNull();
  });

  test('the verdict names the last application and when the next one is allowed', () => {
    const verdict = limits.areaAddOnLimitVerdict('bed_pre_emergent', hist({ bed_pre_emergent: [daysBefore(20)] }));
    expect(verdict).toMatchObject({ lastAppliedOn: daysBefore(20), nextAllowedOn: limits.addDays(daysBefore(20), 60) });
    expect(verdict.detail).toBe(`Snapshot 2.5TG was applied or booked 1 time at this property in the last 12 months (limit 4 in 12 months, at least 60 days apart). Last on ${daysBefore(20)}. The next one is allowed on ${limits.addDays(daysBefore(20), 60)}.`);
    const year = limits.areaAddOnLimitVerdict('fire_ant_yard', hist({ fire_ant_yard: [daysBefore(100)] }));
    expect(year.nextAllowedOn).toBe(limits.addDays(daysBefore(100), 365));
  });

  test('a booked visit in the future counts (two estimates cannot each book the one allowed application)', () => {
    const verdict = limits.areaAddOnLimitVerdict('fire_ant_yard', hist({ fire_ant_yard: [limits.addDays(TODAY, 14)] }));
    expect(verdict).toMatchObject({ reason: 'area_addon_yearly_limit_reached' });
    // ... and a booked Snapshot visit next week holds a new one inside the 60 days either side of it.
    expect(limits.areaAddOnLimitVerdict('bed_pre_emergent', hist({ bed_pre_emergent: [limits.addDays(TODAY, 7)] }))).toMatchObject({ reason: 'area_addon_yearly_limit_reached' });
  });

  test('the day it will be applied is judged, not only today', () => {
    const h = hist({ bed_pre_emergent: [daysBefore(30)] });
    expect(limits.areaAddOnLimitVerdict('bed_pre_emergent', h)).not.toBeNull();
    expect(limits.areaAddOnLimitVerdict('bed_pre_emergent', h, { day: limits.addDays(TODAY, 40) })).toBeNull();
  });

  test('an unreadable summary fails closed for a limited add-on, a missing one means no limit', () => {
    for (const bad of [{ available: false }, 'x', [], { available: true }, { available: true, asOf: 'soon', byKey: {} }, { available: true, asOf: TODAY, byKey: { fire_ant_yard: { dates: ['yesterday'] } } }]) {
      expect(limits.areaAddOnLimitVerdict('fire_ant_yard', bad)).toMatchObject({ reason: 'area_addon_history_unavailable' });
      expect(limits.areaAddOnLimitVerdict('web_sweep', bad)).toBeNull();
    }
    expect(limits.areaAddOnLimitVerdict('fire_ant_yard', undefined)).toBeNull();
    expect(limits.areaAddOnLimitVerdict('fire_ant_yard', null)).toBeNull();
  });

  test('the job card line counts this application as the next one', () => {
    expect(limits.limitUseText(AREA_ADDONS.items.lawn_insect_spot, [daysBefore(90)], TODAY)).toBe(`Application 2 of 2 in 12 months; last applied ${daysBefore(90)}.`);
    expect(limits.limitUseText(AREA_ADDONS.items.lawn_insect_spot, [], TODAY)).toBe('Application 1 of 2 in 12 months.');
    expect(limits.limitUseText(AREA_ADDONS.items.web_sweep, [], TODAY)).toBeNull();
  });
});

describe('one source: the catalog payload, the protocol text and the history product agree with AREA_ADDONS', () => {
  const protocols = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'protocols.json'), 'utf8'));
  const visits = protocols.area_addon.visits;

  test('the catalog payload states each limit from the table', () => {
    for (const row of areaAddOnCatalog()) {
      const cfg = AREA_ADDONS.items[row.key];
      expect(row).toMatchObject({ maxPerYear: cfg.maxPerYear, minDaysApart: cfg.minDaysApart || null, limitText: limits.limitText(cfg) });
    }
  });

  test.each(Object.entries(AREA_ADDONS.items).filter(([, cfg]) => cfg.maxPerYear))('%s: the governed protocol hints the limit product and states the same limit', (key, cfg) => {
    const visit = visits.find((v) => Object.values(v.lineMeta || {}).some((meta) => (meta.catalogProductHints || []).includes(cfg.limitProduct)));
    expect(visit).toBeTruthy();
    const text = visit.labelFacts.limit;
    expect(text).toMatch(cfg.maxPerYear === 1 ? /\bonce\b/i : new RegExp(`\\b${cfg.maxPerYear} applications\\b`));
    if (cfg.minDaysApart) expect(text).toMatch(cfg.minDaysApart % 7 === 0 && cfg.minDaysApart / 7 === 8 ? /8 weeks/ : new RegExp(`${cfg.minDaysApart} days`));
  });

  test('the Arena add-on limit matches the v13 lawn program own Arena cap', () => {
    const arena = require('../config/lawn-v13-count-caps').V13_COUNT_CAPS.find((entry) => entry.name === 'Arena 50 WDG');
    expect(arena).toMatchObject({ cap: AREA_ADDONS.items.lawn_insect_spot.maxPerYear, minIntervalDays: AREA_ADDONS.items.lawn_insect_spot.minDaysApart });
  });
});

describe('the engine: a limited add-on is a custom-quote line (injected history, never a query)', () => {
  const run = (areaAddOns, history, extra = {}) => generateEstimate({
    ...HOME, ...extra, services: { areaAddOns, ...(history === undefined ? {} : { areaAddOnHistory: history }) },
  });
  const lines = (est) => est.lineItems.filter((l) => l.service === 'area_addon');

  test('at the limit: no price, the reason, the staff detail and the dates', () => {
    const [line] = lines(run([{ key: 'bed_pre_emergent', areaSqFt: 1000 }], hist({ bed_pre_emergent: [daysBefore(20)] })));
    expect(line).toMatchObject({ price: null, quoteRequired: true, requiresCustomQuote: true, customQuoteReason: 'area_addon_yearly_limit_reached', carriesJobAdmin: false, carriesVisitDrive: false });
    expect(line.detail).toContain(`Last on ${daysBefore(20)}`);
    expect(line.limit).toEqual({ count: 1, max: 4, lastAppliedOn: daysBefore(20), nextAllowedOn: limits.addDays(daysBefore(20), 60) });
  });

  test('under the limit, with no history (a new lead) or for the web sweep: priced as before', () => {
    expect(lines(run([{ key: 'bed_pre_emergent', areaSqFt: 1000 }], hist({ bed_pre_emergent: [daysBefore(90)] })))[0].price).toBe(99);
    expect(lines(run([{ key: 'bed_pre_emergent', areaSqFt: 1000 }], undefined))[0].price).toBe(99);
    expect(lines(run([{ key: 'web_sweep' }], { available: false }))[0].price).toBe(89);
  });

  test('a limited first entry never carries the drive or the admin: the next priced add-on does', () => {
    const out = lines(run([{ key: 'fire_ant_yard', areaSqFt: 3000 }, { key: 'web_sweep' }], hist({ fire_ant_yard: [daysBefore(10)] })));
    expect(out.map((l) => [l.addOnKey, l.price, l.carriesVisitDrive, l.carriesJobAdmin])).toEqual([['fire_ant_yard', null, false, false], ['web_sweep', 89, true, true]]);
  });

  test('a history read failure is the custom-quote line for a chemical add-on, never a silent pass', () => {
    const [line] = lines(run([{ key: 'hardscape_weed', areaSqFt: 1000 }], { available: false, reason: 'history_unavailable' }));
    expect(line).toMatchObject({ price: null, customQuoteReason: 'area_addon_history_unavailable' });
  });

  test('a pest, lawn or Tree & Shrub program line on the same estimate is never held by an add-on limit', () => {
    const withPrograms = generateEstimate({
      ...HOME,
      services: {
        pest: { frequency: 'quarterly' }, lawn: { track: 'st_augustine', tier: 'enhanced' }, treeShrub: { tier: 'enhanced', bedArea: 2000 },
        areaAddOns: [{ key: 'bed_pre_emergent', areaSqFt: 1000 }], areaAddOnHistory: hist({ bed_pre_emergent: [daysBefore(5)] }),
      },
    });
    expect(lines(withPrograms)[0]).toMatchObject({ price: null, customQuoteReason: 'area_addon_yearly_limit_reached' });
    const programs = withPrograms.lineItems.filter((l) => l.service !== 'area_addon');
    expect(programs.length).toBeGreaterThan(1);
    // Every program line is priced exactly as it is without the add-on or its history.
    const without = generateEstimate({ ...HOME, services: { pest: { frequency: 'quarterly' }, lawn: { track: 'st_augustine', tier: 'enhanced' }, treeShrub: { tier: 'enhanced', bedArea: 2000 } } });
    expect(programs.map((l) => [l.service, l.quoteRequired === true, l.annual ?? l.price])).toEqual(without.lineItems.map((l) => [l.service, l.quoteRequired === true, l.annual ?? l.price]));
  });

  test('the mapped estimate carries the limited add-on as an unpriced row with the reason and the staff detail', () => {
    const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
    const mapped = mapV1ToLegacyShape(run([{ key: 'bed_pre_emergent', areaSqFt: 1000 }], hist({ bed_pre_emergent: [daysBefore(20)] })));
    expect(mapped.oneTime.items.filter((i) => i.service === 'area_addon')).toEqual([]);
    expect(mapped.oneTime.specItems).toEqual([expect.objectContaining({
      service: 'area_addon', addOnKey: 'bed_pre_emergent', price: null, quoteRequired: true, customQuoteReason: 'area_addon_yearly_limit_reached',
      detail: expect.stringContaining(`Last on ${daysBefore(20)}. The next one is allowed on ${limits.addDays(daysBefore(20), 60)}.`),
    })]);
  });

  test('the translator never copies a posted history into the engine input', () => {
    const v1 = translateV2CallToV1Input(HOME, [], { grassType: 'st_augustine', areaAddOns: [{ key: 'bed_pre_emergent', areaSqFt: 1000 }], areaAddOnHistory: hist({}), history: hist({}) });
    expect(v1.services.areaAddOnHistory).toBeUndefined();
  });
});

// A small in-memory fake of the tables the reader touches. Rows carry the columns the queries name (the
// joined add-on query reads prefixed columns "a." / "s.").
function fakeDb(tables, calls = []) {
  const get = (row, col) => row[col];
  const toPred = (a, b, c) => {
    if (typeof a === 'function') return (row) => evalGroup(a, row);
    if (a && typeof a === 'object') return (row) => Object.entries(a).every(([k, v]) => String(get(row, k)) === String(v));
    if (c === undefined) return (row) => String(get(row, a)) === String(b);
    if (b === '>') return (row) => String(get(row, a)) > String(c);
    throw new Error(`unsupported where ${a} ${b}`);
  };
  // The two raw SQL predicates the reader writes, evaluated the way Postgres would: the hold's expiry against the grace, and the
  // estimate's phone (last 10 digits) or address (letters and digits only).
  const digits = (value) => { const d = String(value || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
  const addressKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const rawPredicate = (sql, bindings) => {
    if (sql.includes('reservation_expires_at >= NOW()')) return (r) => r['s.reservation_expires_at'] != null && Date.parse(r['s.reservation_expires_at']) >= Date.now() - bindings[0] * 60000;
    if (sql.includes('customer_phone')) return (r) => digits(r.customer_phone) === bindings[0];
    if (sql.includes('lower(COALESCE(address')) return (r) => addressKey(r.address) === bindings[0];
    throw new Error(`unsupported raw ${sql}`);
  };
  function evalGroup(fn, row) {
    const parts = [];
    const sub = {
      orWhereRaw(sql, bindings) { parts.push(['or', rawPredicate(sql, bindings)]); return sub; },
      where(...args) { parts.push(['and', toPred(...args)]); return sub; },
      whereNull(col) { parts.push(['and', (r) => get(r, col) == null]); return sub; },
      orWhere(...args) { parts.push(['or', toPred(...args)]); return sub; },
      orWhereNull(col) { parts.push(['or', (r) => get(r, col) == null]); return sub; },
      orWhereNot(col, v) { parts.push(['or', (r) => String(get(r, col)) !== String(v)]); return sub; },
    };
    fn.call(sub);
    return parts.reduce((acc, [op, pred], i) => (i === 0 ? pred(row) : (op === 'and' ? acc && pred(row) : acc || pred(row))), true);
  }
  const db = (spec) => {
    const [table] = String(spec).split(/\s+as\s+/i);
    calls.push(table);
    if (!Object.prototype.hasOwnProperty.call(tables, table)) throw new Error(`no such table ${table}`);
    if (typeof tables[table] === 'function') tables[table] = tables[table]();
    const preds = [];
    let cols = null; let max = Infinity; let single = false;
    const q = {
      where(...args) { preds.push(toPred(...args)); return q; },
      whereIn(col, values) { preds.push((r) => values.map(String).includes(String(get(r, col)))); return q; },
      whereNotIn(col, values) { preds.push((r) => !values.includes(get(r, col))); return q; },
      whereNull(col) { preds.push((r) => get(r, col) == null); return q; },
      whereNot(col, v) {
        if (col && typeof col === 'object') Object.entries(col).forEach(([k, val]) => preds.push((r) => String(get(r, k)) !== String(val)));
        else preds.push((r) => String(get(r, col)) !== String(v));
        return q;
      },
      whereNotNull(col) { preds.push((r) => get(r, col) != null); return q; },
      whereRaw(sql, bindings) { preds.push(rawPredicate(sql, bindings)); return q; },
      modify(fn) { fn(q); return q; },
      orderBy() { return q; },
      join() { return q; },
      limit(n) { max = n; return q; },
      select(...c) { cols = c; return q; },
      first(...c) { cols = c; single = true; return q; },
      then(resolve, reject) {
        try {
          const rows = tables[table].filter((row) => preds.every((p) => p(row))).slice(0, max);
          const shaped = rows.map((row) => (cols ? Object.fromEntries(cols.map((c) => {
            const [from, to] = c.split(/\s+as\s+/i);
            return [to || from.replace(/^\w+\./, ''), get(row, from)];
          })) : row));
          resolve(single ? shaped[0] : shaped);
        } catch (e) { reject(e); }
      },
    };
    return q;
  };
  db.calls = calls;
  return db;
}

const CATALOG = [
  { id: 'p-snap', name: 'Snapshot 2.5TG', active: true }, { id: 'p-arena', name: 'Arena 50 WDG', active: true },
  { id: 'p-top', name: 'Topchoice Granular Insecticide', active: true }, { id: 'p-acel', name: 'Acelepryn Insecticide', active: true },
  { id: 'p-round', name: 'Roundup QuikPro SC', active: true },
];
function world(over = {}) {
  return {
    products_catalog: CATALOG,
    product_aliases: [],
    customer_properties: [{ id: PROPERTY, customer_id: CUSTOMER, active: true }],
    property_application_history: [],
    scheduled_services: [],
    scheduled_service_addons: [],
    estimates: [],
    ...over,
  };
}
const ledger = (productId, daysAgo, extra = {}) => ({ customer_id: CUSTOMER, product_id: productId, application_date: daysBefore(daysAgo), property_id: PROPERTY, retracted_at: null, ...extra });
const ownVisit = (serviceKey, date, extra = {}) => ({ 's.service_key_snapshot': serviceKey, 's.customer_id': CUSTOMER, 's.status': 'confirmed', 's.property_id': PROPERTY, 's.source_estimate_id': null, 's.id': 'v-1', 's.scheduled_date': date, ...extra });
const rowVisit = (serviceKey, date, extra = {}) => ({ 'a.service_key_snapshot': serviceKey, 's.customer_id': CUSTOMER, 's.status': 'confirmed', 's.property_id': PROPERTY, 's.source_estimate_id': null, 's.id': 'v-2', 's.scheduled_date': date, ...extra });

describe('the history reader', () => {
  const load = (tables, extra = {}) => service.loadAreaAddOnHistory(fakeDb(tables), { customerId: CUSTOMER, propertyId: PROPERTY, asOf: TODAY, keys: ['bed_pre_emergent', 'web_sweep'], ...extra });

  test('program applications and add-on applications both count: the ledger holds every completed Snapshot application', async () => {
    // A Tree & Shrub visit applied Snapshot this quarter (program), a bed add-on did last spring.
    const out = await load(world({ property_application_history: [ledger('p-snap', 25), ledger('p-snap', 200), ledger('p-other', 10)] }));
    expect(out).toEqual({ available: true, asOf: TODAY, byKey: { bed_pre_emergent: { dates: [daysBefore(200), daysBefore(25)] } } });
    expect(limits.areaAddOnLimitVerdict('bed_pre_emergent', out)).toMatchObject({ reason: 'area_addon_yearly_limit_reached', nextAllowedOn: limits.addDays(daysBefore(25), 60) });
  });

  test('older than 12 months, retracted, or at another property: not counted; unplaced rows still count', async () => {
    const out = await load(world({ property_application_history: [
      ledger('p-snap', 400), ledger('p-snap', 30, { retracted_at: '2026-09-01' }), ledger('p-snap', 31, { property_id: OTHER_PROPERTY }), ledger('p-snap', 32, { property_id: null }),
    ] }));
    expect(out.byKey.bed_pre_emergent.dates).toEqual([daysBefore(32)]);
  });

  test('add-on visits booked and not done count, on the visit itself and as a row; done and cancelled do not; only the rows named by id are left out', async () => {
    const ADOPTED = '77777777-7777-4777-8777-777777777771';
    const FIRST_BOOKING = '77777777-7777-4777-8777-777777777772';
    const input = world({
      scheduled_services: [
        ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 10)),
        ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 11), { 's.status': 'cancelled' }),
        ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 12), { 's.status': 'completed' }),
        // The appointment this accept adopts: named by id, so it does not count against itself.
        ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 13), { 's.source_estimate_id': ESTIMATE, 's.id': ADOPTED }),
        ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 14), { 's.property_id': OTHER_PROPERTY }),
        ownVisit('pest_general_quarterly', limits.addDays(TODAY, 15)),
        // An accepted estimate booked a SECOND time: its first booking (same estimate, another visit) still counts.
        ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 16), { 's.source_estimate_id': ESTIMATE, 's.id': FIRST_BOOKING }),
      ],
      scheduled_service_addons: [rowVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 20)), rowVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 21), { 's.status': 'skipped' })],
    });
    const out = await load(input, { excludeVisitIds: [ADOPTED] });
    expect(out.byKey.bed_pre_emergent.dates).toEqual([limits.addDays(TODAY, 10), limits.addDays(TODAY, 16), limits.addDays(TODAY, 20)]);
    // Naming nothing leaves every booking in; the estimate id alone excludes nothing (the old, wider rule is gone).
    const all = await load(input);
    expect(all.byKey.bed_pre_emergent.dates).toEqual([10, 13, 16, 20].map((n) => limits.addDays(TODAY, n)));
  });

  test('the visit being displayed is left out of its own count (job card)', async () => {
    const out = await load(world({ scheduled_services: [ownVisit('area_addon_bed_pre_emergent', TODAY, { 's.id': 'this-visit' })] }), { excludeVisitId: '55555555-5555-4555-8555-555555555555' });
    expect(out.byKey.bed_pre_emergent.dates).toEqual([TODAY]);
    const left = await load(world({ scheduled_services: [ownVisit('area_addon_bed_pre_emergent', TODAY, { 's.id': '55555555-5555-4555-8555-555555555555' })] }), { excludeVisitId: '55555555-5555-4555-8555-555555555555' });
    expect(left.byKey.bed_pre_emergent.dates).toEqual([]);
  });

  test('a product deactivated in the Service Library keeps its history in the limit', async () => {
    const catalog = CATALOG.map((row) => (row.id === 'p-snap' ? { ...row, active: false } : row));
    const out = await load(world({ products_catalog: catalog, property_application_history: [ledger('p-snap', 25)] }));
    expect(out.byKey.bed_pre_emergent.dates).toEqual([daysBefore(25)]);
  });

  test('a limited add-on whose product has no catalog row is an unreadable history, never an empty one', async () => {
    const catalog = CATALOG.filter((row) => row.id !== 'p-snap');
    await expect(load(world({ products_catalog: catalog, property_application_history: [ledger('p-snap', 25)] })))
      .rejects.toMatchObject({ code: 'AREA_ADDON_LIMIT_PRODUCT_UNRESOLVED' });
    // The quote step turns that into the custom-quote line, not a pass.
    process.env.GATE_AREA_ADDONS = 'true';
    const quoted = await service.quoteAreaAddOnHistory(fakeDb(world({ products_catalog: catalog })), { entries: [{ key: 'bed_pre_emergent' }], customerId: CUSTOMER, propertyId: PROPERTY });
    expect(quoted).toEqual({ available: false, reason: 'history_unavailable' });
  });

  test('the customer\'s only property is used when none is named; keys with no limit read nothing', async () => {
    const db = fakeDb(world({ property_application_history: [ledger('p-snap', 25)] }));
    const out = await service.loadAreaAddOnHistory(db, { customerId: CUSTOMER, asOf: TODAY, keys: ['bed_pre_emergent'] });
    expect(out.byKey.bed_pre_emergent.dates).toEqual([daysBefore(25)]);
    expect(db.calls).toContain('customer_properties');
    const none = fakeDb(world());
    expect(await service.loadAreaAddOnHistory(none, { customerId: CUSTOMER, asOf: TODAY, keys: ['web_sweep'] })).toEqual({ available: true, asOf: TODAY, byKey: {} });
    expect(none.calls).toEqual([]);
  });

  test('a synthetic or missing customer id reads nothing (no query at all)', async () => {
    for (const customerId of ['combo', '', null, undefined]) {
      const db = fakeDb(world());
      expect(await service.loadAreaAddOnHistory(db, { customerId, asOf: TODAY, keys: ['bed_pre_emergent'] })).toEqual({ available: true, asOf: TODAY, byKey: {} });
      expect(db.calls).toEqual([]);
    }
  });
});

describe('quote time: attached to the engine input by the route, never by the client', () => {
  const entries = [{ key: 'bed_pre_emergent', areaSqFt: 1000 }, { key: 'web_sweep' }];

  test('a known customer gets the summary; the engine then returns the custom-quote line', async () => {
    const db = fakeDb(world({ property_application_history: [ledger('p-snap', 25)] }));
    const v1 = await service.attachQuoteAreaAddOnHistory(db, { ...HOME, services: { areaAddOns: entries } }, { existingCustomerId: CUSTOMER, propertyId: PROPERTY });
    const est = generateEstimate(v1);
    expect(est.lineItems.filter((l) => l.service === 'area_addon').map((l) => [l.addOnKey, l.price, l.customQuoteReason || null]))
      .toEqual([['bed_pre_emergent', null, 'area_addon_yearly_limit_reached'], ['web_sweep', 89, null]]);
  });

  test('an unknown property or a new lead (no customer): no history, priced normally', async () => {
    const db = fakeDb(world({ property_application_history: [ledger('p-snap', 25)] }));
    const v1 = await service.attachQuoteAreaAddOnHistory(db, { ...HOME, services: { areaAddOns: entries } }, {});
    expect(v1.services.areaAddOnHistory).toBeUndefined();
    expect(db.calls).toEqual([]);
    expect(generateEstimate(v1).lineItems.find((l) => l.addOnKey === 'bed_pre_emergent').price).toBe(99);
    // A customer with two properties and none named: the whole customer history counts (nothing can be proven elsewhere).
    const two = fakeDb(world({ customer_properties: [{ id: PROPERTY, customer_id: CUSTOMER, active: true }, { id: OTHER_PROPERTY, customer_id: CUSTOMER, active: true }], property_application_history: [ledger('p-snap', 25, { property_id: OTHER_PROPERTY })] }));
    const out = await service.attachQuoteAreaAddOnHistory(two, { ...HOME, services: { areaAddOns: entries } }, { existingCustomerId: CUSTOMER });
    expect(out.services.areaAddOnHistory.byKey.bed_pre_emergent.dates).toEqual([daysBefore(25)]);
  });

  test('a history read failure becomes the custom-quote line, never a silent pass', async () => {
    const broken = fakeDb(world({ property_application_history: () => { throw new Error('connection lost'); } }));
    const v1 = await service.attachQuoteAreaAddOnHistory(broken, { ...HOME, services: { areaAddOns: entries } }, { existingCustomerId: CUSTOMER, propertyId: PROPERTY });
    expect(v1.services.areaAddOnHistory).toEqual({ available: false, reason: 'history_unavailable' });
    expect(generateEstimate(v1).lineItems.filter((l) => l.service === 'area_addon').map((l) => [l.addOnKey, l.price, l.customQuoteReason || null]))
      .toEqual([['bed_pre_emergent', null, 'area_addon_history_unavailable'], ['web_sweep', 89, null]]);
  });

  test('gate off: no read at all (the engine refuses the add-on on its own)', async () => {
    delete process.env.GATE_AREA_ADDONS;
    const db = fakeDb(world());
    const v1 = await service.attachQuoteAreaAddOnHistory(db, { ...HOME, services: { areaAddOns: entries } }, { existingCustomerId: CUSTOMER });
    expect(db.calls).toEqual([]);
    expect(v1.services.areaAddOnHistory).toBeUndefined();
    expect(await service.areaAddOnLimitRefusal(db, { estimate: { id: ESTIMATE, customer_id: CUSTOMER, estimate_data: storedWith(['bed_pre_emergent']) } })).toBeNull();
    expect(db.calls).toEqual([]);
  });

  test('a posted history is dropped from the engine input and replaced by the server\'s, without touching the posted object', () => {
    const posted = { available: true, asOf: TODAY, byKey: {} };
    const services = { areaAddOns: entries, areaAddOnHistory: posted };
    const input = service.applyAreaAddOnHistory({ ...HOME, services }, undefined);
    expect(input.services.areaAddOnHistory).toBeUndefined();
    expect(services.areaAddOnHistory).toBe(posted);
    const server = { available: false };
    expect(service.applyAreaAddOnHistory({ ...HOME, services }, server).services.areaAddOnHistory).toBe(server);
  });

  test('the save reads the history for the posted add-ons from the verified customer', async () => {
    const db = fakeDb(world({ property_application_history: [ledger('p-snap', 25)] }));
    const out = await service.quoteAreaAddOnHistoryForSave(db, { engineRequest: { options: { areaAddOns: entries } } }, { customerId: CUSTOMER, propertyId: PROPERTY });
    expect(out.byKey.bed_pre_emergent.dates).toEqual([daysBefore(25)]);
    expect(await service.quoteAreaAddOnHistoryForSave(db, { engineRequest: { options: { areaAddOns: entries } } }, {})).toBeUndefined();
  });
});

function storedWith(keys, extra = {}) {
  return { result: { oneTime: { items: keys.map((addOnKey) => ({ service: 'area_addon', addOnKey, price: 99, ...extra })) } } };
}

describe('accept time: the recheck inside the transaction (history can change between quote and accept)', () => {
  const estimate = (keys, over = {}) => ({ id: ESTIMATE, customer_id: CUSTOMER, property_id: PROPERTY, estimate_data: storedWith(keys), ...over });

  test('quote vs accept race: priced at quote time, then another Snapshot application lands: the accept is refused with its own code', async () => {
    const before = fakeDb(world());
    const quoted = await service.attachQuoteAreaAddOnHistory(before, { ...HOME, services: { areaAddOns: [{ key: 'bed_pre_emergent', areaSqFt: 1000 }] } }, { existingCustomerId: CUSTOMER, propertyId: PROPERTY });
    expect(generateEstimate(quoted).lineItems.find((l) => l.addOnKey === 'bed_pre_emergent').price).toBe(99);
    await expect(service.assertAreaAddOnLimitsOpen(before, { estimate: estimate(['bed_pre_emergent']) })).resolves.toBeUndefined();
    // A Tree & Shrub visit applies Snapshot, or a second estimate books the add-on, before this one is accepted.
    for (const changed of [
      world({ property_application_history: [ledger('p-snap', 3)] }),
      world({ scheduled_services: [ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 5))] }),
      world({ scheduled_service_addons: [rowVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 5))] }),
    ]) {
      await expect(service.assertAreaAddOnLimitsOpen(fakeDb(changed), { estimate: estimate(['bed_pre_emergent']) })).rejects.toMatchObject({
        status: 409, code: 'AREA_ADDON_YEARLY_LIMIT_REACHED',
        message: 'One of the add-on treatments on this estimate was applied at your property too recently to repeat. Please contact our office and we will confirm what can be scheduled.',
      });
    }
  });

  test('the estimate being accepted never blocks itself: its own hold and the appointment it adopts are left out, a second booking is not', async () => {
    const ADOPTED = '77777777-7777-4777-8777-777777777771';
    const FIRST_BOOKING = '77777777-7777-4777-8777-777777777772';
    const adopted = () => ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 5), { 's.source_estimate_id': ESTIMATE, 's.id': ADOPTED });
    // The adopted appointment, named by id: open.
    await expect(service.assertAreaAddOnLimitsOpen(fakeDb(world({ scheduled_services: [adopted()] })), { estimate: estimate(['bed_pre_emergent']), excludeVisitIds: [ADOPTED] })).resolves.toBeUndefined();
    // The same row NOT named (the staff booking of an accepted estimate, a second time): the first booking counts.
    await expect(service.assertAreaAddOnLimitsOpen(fakeDb(world({ scheduled_services: [adopted()] })), { estimate: estimate(['bed_pre_emergent']), staff: true })).rejects.toMatchObject({ code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' });
    // Naming one visit leaves another booking of the same estimate in.
    const two = world({ scheduled_services: [adopted(), ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 6), { 's.source_estimate_id': ESTIMATE, 's.id': FIRST_BOOKING })] });
    await expect(service.assertAreaAddOnLimitsOpen(fakeDb(two), { estimate: estimate(['bed_pre_emergent']), excludeVisitIds: [ADOPTED] })).rejects.toMatchObject({ code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' });
    // Its own live hold (no customer yet) is the row being graduated: never counted, with or without an id.
    const ownHold = { 's.customer_id': null, 's.source_estimate_id': ESTIMATE, 's.reservation_expires_at': new Date(Date.now() + 600000).toISOString(), 's.status': 'pending', 's.id': HOLD_ID, 's.scheduled_date': limits.addDays(TODAY, 5), 's.property_id': null };
    const holdWorld = world({ scheduled_services: [ownHold], estimates: [{ id: ESTIMATE, customer_phone: '(941) 555-0142', address: '1 Test Way', estimate_data: storedWith(['bed_pre_emergent']) }] });
    await expect(service.assertAreaAddOnLimitsOpen(fakeDb(holdWorld), { estimate: estimate(['bed_pre_emergent'], { customer_phone: '+19415550142' }) })).resolves.toBeUndefined();
  });

  test('staff see the dates; the customer never does', async () => {
    const db = fakeDb(world({ property_application_history: [ledger('p-snap', 3)] }));
    await expect(service.assertAreaAddOnLimitsOpen(db, { estimate: estimate(['bed_pre_emergent']), staff: true })).rejects.toMatchObject({ message: expect.stringContaining(`Last on ${daysBefore(3)}`) });
    await expect(service.assertAreaAddOnLimitsOpen(db, { estimate: estimate(['bed_pre_emergent']) })).rejects.toMatchObject({ message: expect.not.stringContaining(daysBefore(3)) });
  });

  test('the booked day is judged, so a visit 60 days out is open even though today is not', async () => {
    const db = fakeDb(world({ property_application_history: [ledger('p-snap', 30)] }));
    await expect(service.assertAreaAddOnLimitsOpen(db, { estimate: estimate(['bed_pre_emergent']) })).rejects.toMatchObject({ code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' });
    await expect(service.assertAreaAddOnLimitsOpen(db, { estimate: estimate(['bed_pre_emergent']), appliedOn: limits.addDays(TODAY, 40) })).resolves.toBeUndefined();
  });

  test('a history read failure fails closed for a chemical add-on with its own code; the web sweep alone reads nothing', async () => {
    const broken = fakeDb(world({ property_application_history: () => { throw new Error('connection lost'); } }));
    await expect(service.assertAreaAddOnLimitsOpen(broken, { estimate: estimate(['hardscape_weed']) })).rejects.toMatchObject({
      status: 409, code: 'AREA_ADDON_HISTORY_UNAVAILABLE',
      message: 'We could not confirm the treatment history for the add-ons on this estimate. Please contact our office and we will finish booking.',
    });
    await expect(service.assertAreaAddOnLimitsOpen(broken, { estimate: estimate(['hardscape_weed']), staff: true })).rejects.toMatchObject({
      code: 'AREA_ADDON_HISTORY_UNAVAILABLE', message: expect.stringContaining('could not be read'),
    });
    const sweepOnly = fakeDb(world());
    await expect(service.assertAreaAddOnLimitsOpen(sweepOnly, { estimate: estimate(['web_sweep']) })).resolves.toBeUndefined();
    expect(sweepOnly.calls).toEqual([]);
  });

  test('an estimate with no add-on (a Tree & Shrub or lawn program) is never touched', async () => {
    const db = fakeDb(world({ property_application_history: [ledger('p-snap', 1), ledger('p-snap', 2), ledger('p-snap', 3), ledger('p-snap', 4)] }));
    await expect(service.assertAreaAddOnLimitsOpen(db, { estimate: { id: ESTIMATE, customer_id: CUSTOMER, estimate_data: { result: { recurring: { services: [{ name: 'Tree & Shrub', mo: 80 }] }, oneTime: { items: [] } } } } })).resolves.toBeUndefined();
    expect(db.calls).toEqual([]);
  });

  test('no customer known ANYWHERE passes, and reads no history (only the lookups that could have named one)', async () => {
    const db = fakeDb(world({ property_application_history: [ledger('p-snap', 1), ledger('p-snap', 2), ledger('p-snap', 3), ledger('p-snap', 4)] }));
    await expect(service.assertAreaAddOnLimitsOpen(db, { estimate: estimate(['bed_pre_emergent'], { customer_id: null }), resolveCustomer: async () => null })).resolves.toBeUndefined();
    expect(db.calls).toEqual(['scheduled_services']);
  });

  test('an unpriced (custom-quote) add-on row is not a sold add-on', async () => {
    const db = fakeDb(world({ property_application_history: [ledger('p-snap', 3)] }));
    const data = { result: { oneTime: { items: [], specItems: [{ service: 'area_addon', addOnKey: 'bed_pre_emergent', price: null }] } } };
    await expect(service.assertAreaAddOnLimitsOpen(db, { estimate: { id: ESTIMATE, customer_id: CUSTOMER, estimate_data: data } })).resolves.toBeUndefined();
  });

  test('the refusal object form answers { status, body } and rethrows anything else', async () => {
    const db = fakeDb(world({ property_application_history: [ledger('p-snap', 3)] }));
    expect(await service.areaAddOnLimitRefusal(db, { estimate: estimate(['bed_pre_emergent']) })).toEqual({
      status: 409, body: { error: expect.any(String), code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' },
    });
    expect(await service.areaAddOnLimitRefusal(fakeDb(world()), { estimate: estimate(['bed_pre_emergent']) })).toBeNull();
  });
});

describe('booking time: an estimate with no customer_id of its own is checked for the customer the request names (Codex round 8)', () => {
  // A lead or standalone estimate: customer_id NULL. The history of the customer known by then must be read.
  const unowned = (keys, over = {}) => ({ id: ESTIMATE, customer_id: null, property_id: null, estimate_data: storedWith(keys), ...over });
  const snapHistory = world({ property_application_history: [ledger('p-snap', 3)] });
  const refusal = { code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' };

  test('staff booking: the booking customer (verified) is read, on the booking property, though the estimate has none', async () => {
    await expect(service.assertAreaAddOnLimitsOpen(fakeDb(snapHistory), { estimate: unowned(['bed_pre_emergent']), customerId: CUSTOMER, property: { property_id: PROPERTY }, staff: true })).rejects.toMatchObject(refusal);
    // Before the fix the call omitted the customer: the same estimate passed.
    await expect(service.assertAreaAddOnLimitsOpen(fakeDb(snapHistory), { estimate: unowned(['bed_pre_emergent']), resolveCustomer: async () => null, staff: true })).resolves.toBeUndefined();
    // The booking property scopes the read: a Snapshot application at another property does not count.
    const elsewhere = world({ property_application_history: [ledger('p-snap', 3, { property_id: OTHER_PROPERTY })] });
    await expect(service.assertAreaAddOnLimitsOpen(fakeDb(elsewhere), { estimate: unowned(['bed_pre_emergent']), customerId: CUSTOMER, property: { property_id: PROPERTY }, staff: true })).resolves.toBeUndefined();
  });

  test('staff booking: the route passes the booking customer and property to the recheck', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    expect(src).toContain('areaAddOnLimitRefusal(db, { estimate: linkedEstimate, customerId, property: bookingProperty, appliedOn: scheduledDate, staff: true })');
    expect(src).toMatch(/assertAreaAddOnLimitsOpen\(trx, \{\s+estimate: linkedEstimate, customerId, property: bookingProperty, appliedOn: scheduledDate, staff: true,\s+\}\)/);
  });

  test('Mark Won and the public accept: a booked appointment linked to the estimate names the customer and its property', async () => {
    const linked = world({
      property_application_history: [ledger('p-snap', 3)],
      scheduled_services: [{ source_estimate_id: ESTIMATE, customer_id: CUSTOMER, property_id: PROPERTY }],
    });
    for (const staff of [true, false]) {
      await expect(service.assertAreaAddOnLimitsOpen(fakeDb(linked), { estimate: unowned(['bed_pre_emergent']), staff })).rejects.toMatchObject(refusal);
    }
    // A hold the estimate placed itself has no customer yet: nothing is known.
    const hold = world({ scheduled_services: [{ source_estimate_id: ESTIMATE, customer_id: null, property_id: null }] });
    await expect(service.assertAreaAddOnLimitsOpen(fakeDb(hold), { estimate: unowned(['bed_pre_emergent']) })).resolves.toBeUndefined();
  });

  test('an appointment of ANOTHER customer never lends its property to the customer the caller verified', async () => {
    const other = '99999999-9999-4999-8999-999999999999';
    const db = fakeDb(world({
      property_application_history: [ledger('p-snap', 3)],
      scheduled_services: [{ source_estimate_id: ESTIMATE, customer_id: other, property_id: OTHER_PROPERTY }],
    }));
    // The verified customer's own property is unknown here: the customer's only property is used, and the history is read.
    await expect(service.assertAreaAddOnLimitsOpen(db, { estimate: unowned(['bed_pre_emergent']), customerId: CUSTOMER })).rejects.toMatchObject(refusal);
  });

  test('a grouped estimate: the accepted sibling owns the acceptance, so its customer is read', async () => {
    const GROUP = '55555555-5555-4555-8555-555555555555';
    const grouped = world({
      property_application_history: [ledger('p-snap', 3)],
      estimates: [{ estimate_group_id: GROUP, id: '66666666-6666-4666-8666-666666666666', customer_id: CUSTOMER, accepted_at: '2026-10-01' }],
      customers: [{ id: CUSTOMER, deleted_at: null }],
    });
    await expect(service.assertAreaAddOnLimitsOpen(fakeDb(grouped), { estimate: unowned(['bed_pre_emergent'], { estimate_group_id: GROUP }) })).rejects.toMatchObject(refusal);
  });

  test('reserve: the customer the estimate phone matches is read (resolveCustomer runs only when nothing else names one)', async () => {
    const resolve = jest.fn(async () => CUSTOMER);
    await expect(service.assertAreaAddOnLimitsOpen(fakeDb(snapHistory), { estimate: unowned(['bed_pre_emergent']), resolveCustomer: resolve })).rejects.toMatchObject(refusal);
    expect(resolve).toHaveBeenCalledTimes(1);
    const named = jest.fn(async () => CUSTOMER);
    await service.areaAddOnLimitRefusal(fakeDb(world()), { estimate: unowned(['bed_pre_emergent'], { customer_id: CUSTOMER }), resolveCustomer: named });
    expect(named).not.toHaveBeenCalled();
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'estimate-slots-public.js'), 'utf8');
    expect(src).toContain('lockedAreaAddOnLimitRefusal(row, trx, date)');
    expect(src).toContain('resolveCustomer: () => phoneMatchedCustomerId(row, trx),');
    expect(src).toMatch(/async function phoneMatchedCustomerId\(row, trx\) \{\s+return \(await matchAcceptCustomerByPhone\(row, trx\)\)\.match\?\.id \|\| null;/);
  });

  test('a failed lookup of who the customer is fails closed, like a failed history read', async () => {
    const broken = fakeDb(world({ scheduled_services: () => { throw new Error('connection lost'); } }));
    await expect(service.assertAreaAddOnLimitsOpen(broken, { estimate: unowned(['bed_pre_emergent']) })).rejects.toMatchObject({ code: 'AREA_ADDON_HISTORY_UNAVAILABLE' });
  });

  test('the public accept passes its locked or phone-matched customer, the hold\'s day, and only the hold and the adopted appointment to leave out', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'estimate-public.js'), 'utf8');
    const call = src.slice(src.indexOf('assertAreaAddOnLimitsOpen(trx, {'), src.indexOf('// Bind the accept to the SetupIntent it verified'));
    expect(call).toContain('customerId: acceptPreLockedCommsId,');
    expect(call).toContain('appliedOn: acceptPreLockedDate,');
    expect(call).toContain('excludeVisitIds: rowIds(capacityHold, existingAppointmentRow),');
    expect(call).toContain('resolveCustomer: () => resolveAcceptLimitCustomer(trx, estimate),');
    expect(call).toContain("fenceCustomer: (id) => require('../services/area-addon-limits').fenceCustomerBookings(trx, id),");
    expect(call).not.toContain('excludeEstimateId');
    // the resolver: the account step's own authoritative phone match; the fence is the shared non-blocking take (below)
    const resolver = src.slice(src.indexOf('async function resolveAcceptLimitCustomer'), src.indexOf('// B18 park: the accept cannot complete self-serve when the estimate'));
    expect(resolver).toContain('matchAcceptCustomerByPhone(estimate, trx, { authoritative: true, afterSiblingResolution: true })');
    expect(src).not.toContain('fenceAcceptLimitCustomer');
  });

  test('the calculate step reads the history of the customer the staff picked, under either field the estimator route accepts', async () => {
    const input = (extra) => ({ ...HOME, services: { areaAddOns: [{ key: 'bed_pre_emergent', areaSqFt: 1000 }] }, ...extra });
    for (const options of [{ existingCustomerId: CUSTOMER }, { customerId: CUSTOMER }]) {
      const out = await service.attachQuoteAreaAddOnHistory(fakeDb(snapHistory), input(), { ...options, propertyId: PROPERTY });
      expect(out.services.areaAddOnHistory).toMatchObject({ available: true });
      expect(generateEstimate(out).lineItems.find((l) => l.addOnKey === 'bed_pre_emergent')).toMatchObject({ quoteRequired: true });
    }
    const none = await service.attachQuoteAreaAddOnHistory(fakeDb(snapHistory), input(), { propertyId: PROPERTY });
    expect(none.services.areaAddOnHistory).toBeUndefined();
  });

  test('a revision keeps the stored customer: the save body is merged with the row before the history is read', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'admin-estimate-persistence.js'), 'utf8');
    expect(src).toContain('customerId: body.customerId || estimate.customer_id || null,\n      // The V2 revision payload sends no grouping fields');
  });
});

describe('a customer who does not exist yet: the holds of the same person count, read under a lock on who they are (Codex round 9)', () => {
  const soon = new Date(Date.now() + 600000).toISOString();
  const lapsed = new Date(Date.now() - 3600000).toISOString();
  const lead = (keys, over = {}) => ({ id: ESTIMATE, customer_id: null, property_id: null, customer_phone: '+19415550142', address: '1 Test Way, Bradenton, FL 34202', estimate_data: storedWith(keys), ...over });
  const hold = (extra = {}) => ({ 's.customer_id': null, 's.source_estimate_id': OTHER_ESTIMATE, 's.reservation_expires_at': soon, 's.status': 'pending', 's.id': HOLD_ID, 's.scheduled_date': limits.addDays(TODAY, 5), 's.property_id': null, ...extra });
  const theirs = (over = {}) => ({ id: OTHER_ESTIMATE, customer_phone: '(941) 555-0142', address: '9 Other St', customer_id: null, estimate_data: storedWith(['bed_pre_emergent']), ...over });
  const refusal = { code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' };
  const check = (tables, estimate = lead(['bed_pre_emergent']), extra = {}) => service.assertAreaAddOnLimitsOpen(fakeDb(world(tables)), { estimate, resolveCustomer: async () => null, ...extra });

  test('an unowned hold of another estimate with the same phone (any formatting) is a booked application: the second accept is refused', async () => {
    await expect(check({ scheduled_services: [hold()], estimates: [theirs()] })).rejects.toMatchObject(refusal);
    // the customer sees the office hand-off, staff the dates
    await expect(check({ scheduled_services: [hold()], estimates: [theirs()] }, lead(['bed_pre_emergent']), { staff: true })).rejects.toMatchObject({ message: expect.stringContaining('applied or booked') });
  });

  test('another phone, a lapsed hold, a hold of the same estimate, another add-on or a hold with no sold add-on do not count', async () => {
    await expect(check({ scheduled_services: [hold()], estimates: [theirs({ customer_phone: '941-555-0199' })] })).resolves.toBeUndefined();
    await expect(check({ scheduled_services: [hold({ 's.reservation_expires_at': lapsed })], estimates: [theirs()] })).resolves.toBeUndefined();
    await expect(check({ scheduled_services: [hold({ 's.source_estimate_id': ESTIMATE })], estimates: [theirs({ id: ESTIMATE })] })).resolves.toBeUndefined();
    await expect(check({ scheduled_services: [hold()], estimates: [theirs({ estimate_data: storedWith(['fire_ant_yard']) })] })).resolves.toBeUndefined();
    await expect(check({ scheduled_services: [hold()], estimates: [theirs({ estimate_data: { result: { oneTime: { items: [] } } } })] })).resolves.toBeUndefined();
  });

  test('an estimate with no phone is matched by its address, whatever the punctuation', async () => {
    const noPhone = lead(['bed_pre_emergent'], { customer_phone: null });
    await expect(check({ scheduled_services: [hold()], estimates: [theirs({ customer_phone: null, address: '1 test way bradenton fl 34202' })] }, noPhone)).rejects.toMatchObject(refusal);
    await expect(check({ scheduled_services: [hold()], estimates: [theirs({ customer_phone: null, address: '2 Test Way, Bradenton, FL 34202' })] }, noPhone)).resolves.toBeUndefined();
  });

  test('a known customer also counts the holds of that customer\'s other estimates', async () => {
    const db = fakeDb(world({ scheduled_services: [hold()], estimates: [theirs({ customer_phone: '941-555-0199', customer_id: CUSTOMER })] }));
    await expect(service.assertAreaAddOnLimitsOpen(db, { estimate: lead(['bed_pre_emergent'], { customer_id: CUSTOMER, customer_phone: '+19415550150' }) })).rejects.toMatchObject(refusal);
  });

  test('the same-phone lock is taken inside the transaction before anything is read, and not for a named customer or outside a transaction', async () => {
    const order = [];
    const trx = fakeDb(world());
    trx.isTransaction = true;
    trx.raw = jest.fn(async (sql, bindings) => { order.push([String(sql), bindings && bindings[0]]); return {}; });
    const reads = [];
    const wrapped = Object.assign((table) => { reads.push(table); return trx(table); }, { isTransaction: true, raw: trx.raw });
    await service.assertAreaAddOnLimitsOpen(wrapped, { estimate: lead(['bed_pre_emergent']), resolveCustomer: async () => null });
    expect(order[0]).toEqual(["SELECT pg_advisory_xact_lock(hashtext('area-addon-identity'), hashtext(?::text))", 'phone:9415550142']);
    expect(order[1][1]).toBe('address:1testwaybradentonfl34202');
    expect(order.findIndex(([sql]) => sql.startsWith('SAVEPOINT'))).toBeGreaterThan(1);
    // a customer already named is serialized by the customer lock: no identity lock
    trx.raw.mockClear(); order.length = 0;
    await service.assertAreaAddOnLimitsOpen(wrapped, { estimate: lead(['bed_pre_emergent'], { customer_id: CUSTOMER }) });
    expect(order.filter(([sql]) => sql.includes('advisory'))).toEqual([]);
    // outside a transaction the lock would fence nothing: not taken
    const plain = fakeDb(world());
    plain.raw = jest.fn();
    await service.assertAreaAddOnLimitsOpen(plain, { estimate: lead(['bed_pre_emergent']), resolveCustomer: async () => null });
    expect(plain.raw).not.toHaveBeenCalled();
  });

  test('the customer the accept resolves under the lock is read (the first accept created it): the second accept is refused on its booked visit', async () => {
    const booked = ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 5));
    const db = fakeDb(world({ scheduled_services: [booked] }));
    await expect(service.assertAreaAddOnLimitsOpen(db, { estimate: lead(['bed_pre_emergent']), resolveCustomer: async () => CUSTOMER })).rejects.toMatchObject(refusal);
  });

  test('a customer the check found for itself (phone match, group owner, linked appointment) is fenced by the caller before the read; a named one is not', async () => {
    const GROUP = '55555555-5555-4555-8555-555555555555';
    const fence = jest.fn(async () => {});
    const grouped = world({ estimates: [{ estimate_group_id: GROUP, id: '66666666-6666-4666-8666-666666666666', customer_id: CUSTOMER, accepted_at: '2026-10-01' }], customers: [{ id: CUSTOMER, deleted_at: null }] });
    await service.assertAreaAddOnLimitsOpen(fakeDb(grouped), { estimate: lead(['bed_pre_emergent'], { estimate_group_id: GROUP }), fenceCustomer: fence });
    expect(fence).toHaveBeenCalledWith(CUSTOMER);
    fence.mockClear();
    await service.assertAreaAddOnLimitsOpen(fakeDb(world()), { estimate: lead(['bed_pre_emergent']), resolveCustomer: async () => CUSTOMER, fenceCustomer: fence });
    expect(fence).toHaveBeenCalledWith(CUSTOMER);
    fence.mockClear();
    await service.assertAreaAddOnLimitsOpen(fakeDb(world()), { estimate: lead(['bed_pre_emergent'], { customer_id: CUSTOMER }), fenceCustomer: fence });
    await service.assertAreaAddOnLimitsOpen(fakeDb(world()), { estimate: lead(['bed_pre_emergent']), customerId: CUSTOMER, fenceCustomer: fence });
    expect(fence).not.toHaveBeenCalled();
    // a busy account is the caller's own answer
    const busy = Object.assign(new Error('busy'), { status: 409, code: 'CUSTOMER_BUSY_RETRY' });
    await expect(service.assertAreaAddOnLimitsOpen(fakeDb(world()), { estimate: lead(['bed_pre_emergent']), resolveCustomer: async () => CUSTOMER, fenceCustomer: async () => { throw busy; } })).rejects.toBe(busy);
  });

  test('a retry-later answer from the resolver is the caller\'s own, not a "history unavailable" refusal', async () => {
    const busy = Object.assign(new Error('busy'), { status: 409, code: 'CUSTOMER_BUSY_RETRY' });
    await expect(service.assertAreaAddOnLimitsOpen(fakeDb(world()), { estimate: lead(['bed_pre_emergent']), resolveCustomer: async () => { throw busy; } })).rejects.toBe(busy);
  });
});

describe('the day of the visit is judged on every path (Codex round 9)', () => {
  const lastYear = world({ property_application_history: [ledger('p-top', 360)] });
  const fireAnt = { id: ESTIMATE, customer_id: CUSTOMER, property_id: PROPERTY, estimate_data: storedWith(['fire_ant_yard']) };

  test('an application 360 days ago blocks today but not a slot ten days out (the reserve passes the selected slot day)', async () => {
    await expect(service.assertAreaAddOnLimitsOpen(fakeDb(lastYear), { estimate: fireAnt })).rejects.toMatchObject({ code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' });
    await expect(service.assertAreaAddOnLimitsOpen(fakeDb(lastYear), { estimate: fireAnt, appliedOn: limits.addDays(TODAY, 10) })).resolves.toBeUndefined();
    // a Date from the database (a scheduled_date column) is read as its ET calendar day
    await expect(service.assertAreaAddOnLimitsOpen(fakeDb(lastYear), { estimate: fireAnt, appliedOn: new Date(`${limits.addDays(TODAY, 10)}T00:00:00.000Z`) })).resolves.toBeUndefined();
  });

  test('the visits a caller commits give the day when it names none (an adopted appointment, the booked rows of a Mark Won)', async () => {
    const VISIT = '77777777-7777-4777-8777-777777777771';
    const adopted = ownVisit('area_addon_fire_ant_yard', limits.addDays(TODAY, 10), { 's.id': VISIT, 's.source_estimate_id': ESTIMATE, 's.status': 'confirmed' });
    // the adopted appointment is 10 days out; the last application 360 days ago is a year old by then
    const tables = { property_application_history: [ledger('p-top', 360)], scheduled_services: [adopted] };
    await expect(service.assertAreaAddOnLimitsOpen(fakeDb(world(tables)), { estimate: fireAnt, excludeVisitIds: [VISIT] })).resolves.toBeUndefined();
    await expect(service.assertAreaAddOnLimitsOpen(fakeDb(world(tables)), { estimate: fireAnt })).rejects.toMatchObject({ code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' });
    // an explicit day always wins; an id that is not a uuid names nothing
    await expect(service.assertAreaAddOnLimitsOpen(fakeDb(world(tables)), { estimate: fireAnt, excludeVisitIds: [VISIT], appliedOn: TODAY })).rejects.toMatchObject({ code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' });
    const none = fakeDb(world({ property_application_history: [ledger('p-top', 360)] }));
    await expect(service.assertAreaAddOnLimitsOpen(none, { estimate: fireAnt, excludeVisitIds: ['combo'] })).rejects.toMatchObject({ code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' });
    expect(none.calls).not.toContain('scheduled_services as s');
  });

  test('every caller passes a day: reserve (slot), accept (hold or adopted appointment), staff booking (booking date), Mark Won (booked visits)', () => {
    const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    expect(read('routes/estimate-slots-public.js')).toContain('appliedOn: date,');
    expect(read('routes/estimate-public.js')).toContain('appliedOn: acceptPreLockedDate,');
    expect(read('routes/admin-schedule.js')).toContain('appliedOn: scheduledDate, staff: true');
    // no day named, visits named: the day of the committed visits (an adopted appointment, the staff booking's rows)
    expect(read('services/area-addon-limits.js')).toContain('day = appliedOn || await visitsFirstDay(database, excludeVisitIds);');
    expect(read('services/estimate-manual-acceptance.js')).toContain('estimate, staff: true, excludeVisitIds: bookedAppointmentIds, fenceCustomer');
  });
});

describe('the job card shows the count beside the governed limit text', () => {
  const card = (id) => ({ id, name: 'x', governed: { limit: 'Label limit text.' } });
  const catalog = CATALOG.map((p) => ({ ...p, aliases: [] }));

  test('an add-on product card gets "Application N of M in 12 months; last applied ..." from the property history', async () => {
    const db = fakeDb(world({
      scheduled_services: [{ id: 'visit-1', customer_id: CUSTOMER, property_id: PROPERTY }],
      property_application_history: [ledger('p-arena', 90)],
    }));
    const cards = await service.attachLimitUse([card('p-arena'), { id: 'p-other', name: 'y' }, card('p-round')], { catalog, serviceId: 'visit-1', visitDay: TODAY, dbh: db });
    expect(cards[0].governed).toEqual({ limit: 'Label limit text.', use: `Application 2 of 2 in 12 months; last applied ${daysBefore(90)}.` });
    expect(cards[1].governed).toBeUndefined();
    expect(cards[2].governed.use).toBe('Application 1 of 2 in 12 months.');
  });

  test('a failed read leaves the card as it was; a card with no governed text reads nothing', async () => {
    const broken = fakeDb(world({ scheduled_services: [{ id: 'visit-1', customer_id: CUSTOMER, property_id: PROPERTY }], property_application_history: () => { throw new Error('down'); } }));
    const cards = await service.attachLimitUse([card('p-arena')], { catalog, serviceId: 'visit-1', visitDay: TODAY, dbh: broken });
    expect(cards[0].governed).toEqual({ limit: 'Label limit text.' });
    const quiet = fakeDb(world());
    await service.attachLimitUse([{ id: 'p-arena', name: 'x' }], { catalog, serviceId: 'visit-1', visitDay: TODAY, dbh: quiet });
    expect(quiet.calls).toEqual([]);
  });
});

describe('where the recheck runs (source order)', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test('the public accept runs it in the transaction, after the customer lock and the estimate row lock (the reserve order), before any other write of the accept', () => {
    const src = read('routes/estimate-public.js');
    const lock = src.indexOf('await lockCustomerComms(trx, acceptPreLockedCommsId);');
    const rowLock = src.indexOf("const err = new Error('Estimate is no longer active');", src.indexOf('.update(withServedDisclosurePreserved(trx, acceptedUpdates));'));
    const check = src.indexOf('await require(\'../services/area-addon-limits\').assertAreaAddOnLimitsOpen(trx, {');
    const setupIntent = src.indexOf('// Bind the accept to the SetupIntent it verified');
    const account = src.indexOf('const account = await ensureCustomerAccount(trx, {');
    expect(lock).toBeGreaterThan(0);
    expect(rowLock).toBeGreaterThan(lock);
    expect(check).toBeGreaterThan(rowLock);
    expect(setupIntent).toBeGreaterThan(check);
    // ... and before the account step creates the customer the recheck must have judged.
    expect(account).toBeGreaterThan(check);
  });

  test('the reserve rechecks inside the reserve transaction on the selected slot day; the staff booking before AND inside its transaction (after the customer lock, before the visit insert); Mark Won in its transaction', () => {
    expect(read('routes/estimate-slots-public.js')).toMatch(/revalidateEstimate: async \(row, trx, \{ date \} = \{\}\) => \{[\s\S]{0,300}lockedAreaAddOnLimitRefusal\(row, trx, date\)/);
    expect(read('services/slot-reservation.js')).toContain('await revalidateEstimate(estimate, trx, { date });');
    const schedule = read('routes/admin-schedule.js');
    const book = schedule.indexOf('areaAddOnLimitRefusal(db, { estimate: linkedEstimate, customerId, property: bookingProperty, appliedOn: scheduledDate, staff: true })');
    expect(book).toBeGreaterThan(0);
    expect(book).toBeLessThan(schedule.indexOf('db.transaction', book));
    const customerLock = schedule.indexOf('await lockCustomerComms(trx, customerId);', book);
    const again = schedule.indexOf("assertAreaAddOnLimitsOpen(trx, {\n            estimate: linkedEstimate, customerId, property: bookingProperty, appliedOn: scheduledDate, staff: true,", customerLock);
    const insert = schedule.indexOf("[svc] = await trx('scheduled_services').insert(adminCreateInsert).returning('*');", again);
    expect(customerLock).toBeGreaterThan(book);
    expect(again).toBeGreaterThan(customerLock);
    expect(insert).toBeGreaterThan(again);
    const won = read('services/estimate-manual-acceptance.js');
    expect(won).toContain('estimate, staff: true, excludeVisitIds: bookedAppointmentIds, fenceCustomer');
    expect(won.indexOf('await lockCustomerComms(trx, estimate.customer_id);')).toBeLessThan(won.indexOf('assertAreaAddOnLimitsOpen(trx, {'));
  });

  test('the quote steps attach the history; the engine file never queries', () => {
    expect(read('routes/property-lookup-v2.js')).toContain('attachQuoteAreaAddOnHistory(require(\'../models/db\'), v1Input, options)');
    expect(read('services/admin-estimate-persistence.js')).toContain('quoteAreaAddOnHistoryForSave(database, trustedEstimateData, body)');
    for (const rel of ['services/pricing-engine/area-addon-limits.js', 'services/pricing-engine/service-pricing.js']) {
      expect(read(rel)).not.toMatch(/require\(['"](\.\.\/)+models\/db['"]\)|knex\(/);
    }
  });

  test('no product_limits row and no migration carries an add-on limit (add-on-only limits)', () => {
    const migrations = fs.readdirSync(path.join(__dirname, '..', 'models', 'migrations')).filter((f) => f.startsWith('2026100824') || f.startsWith('2026100825'));
    for (const f of migrations) expect(read(`models/migrations/${f}`)).not.toMatch(/product_limits/);
  });
});

// Codex round 11 P1 on #6135: the reserve read a matched customer's history under the prospect identity lock only, while staff
// bookings serialize on the customer-row lock (lockCustomerComms), so a concurrent reserve and staff booking could both pass a
// one-per-year limit. Every limit-check caller now holds that customer's booking fence when it reads.
describe('the booking fence: every reader of a customer\'s add-on history holds that customer\'s fence (Codex round 11)', () => {
  const lead = (keys, over = {}) => ({ id: ESTIMATE, customer_id: null, property_id: null, customer_phone: '+19415550142', address: '1 Test Way, Bradenton, FL 34202', estimate_data: storedWith(keys), ...over });

  test('fenceNamed fences the customer the estimate names too (the reserve locks nobody up front); without it a named customer is the caller\'s own', async () => {
    const fence = jest.fn(async () => {});
    await service.assertAreaAddOnLimitsOpen(fakeDb(world()), { estimate: lead(['bed_pre_emergent'], { customer_id: CUSTOMER }), fenceCustomer: fence, fenceNamed: true });
    expect(fence).toHaveBeenCalledWith(CUSTOMER);
    fence.mockClear();
    await service.assertAreaAddOnLimitsOpen(fakeDb(world()), { estimate: lead(['bed_pre_emergent']), customerId: CUSTOMER, fenceCustomer: fence, fenceNamed: true });
    expect(fence).toHaveBeenCalledWith(CUSTOMER);
    // the fence comes BEFORE the history read
    const order = [];
    const wrapped = (table) => { order.push(`read:${table}`); return fakeDb(world())(table); };
    await service.assertAreaAddOnLimitsOpen(wrapped, { estimate: lead(['bed_pre_emergent'], { customer_id: CUSTOMER }), fenceNamed: true, fenceCustomer: async () => { order.push('fence'); } });
    expect(order.indexOf('fence')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('fence')).toBeLessThan(order.indexOf('read:property_application_history'));
    // no add-on sold: no customer, no fence, no read
    fence.mockClear();
    await service.assertAreaAddOnLimitsOpen(fakeDb(world()), { estimate: lead([], { customer_id: CUSTOMER }), fenceCustomer: fence, fenceNamed: true });
    expect(fence).not.toHaveBeenCalled();
  });

  test('fenceCustomerBookings takes the customer-comms lock without blocking; a busy account is the retryable 409 and nothing is read', async () => {
    const trx = (locked) => ({ raw: jest.fn(async () => ({ rows: [{ locked }] })) });
    const free = trx(true);
    await expect(service.fenceCustomerBookings(free, CUSTOMER)).resolves.toBeUndefined();
    expect(free.raw.mock.calls[0][0]).toContain('pg_try_advisory_xact_lock');
    expect(free.raw.mock.calls[0][1]).toEqual([`customer-comms:${CUSTOMER}`]);
    await expect(service.fenceCustomerBookings(trx(false), CUSTOMER)).rejects.toMatchObject({ status: 409, code: 'CUSTOMER_BUSY_RETRY', message: expect.stringContaining('being updated right now') });
  });

  test('a busy account stops the recheck before any history is read, for the reserve\'s own answer', async () => {
    const reads = [];
    const wrapped = (table) => { reads.push(table); return fakeDb(world())(table); };
    const busy = Object.assign(new Error('busy'), { status: 409, code: 'CUSTOMER_BUSY_RETRY' });
    await expect(service.assertAreaAddOnLimitsOpen(wrapped, { estimate: lead(['bed_pre_emergent'], { customer_id: CUSTOMER }), fenceNamed: true, fenceCustomer: async () => { throw busy; } })).rejects.toBe(busy);
    expect(reads.filter((table) => table === 'property_application_history')).toEqual([]);
  });

  test('the reserve fences the customer on the locked row, answers a busy account with the existing retryable refusal, and every other caller keeps its own lock', () => {
    const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const reserve = read('routes/estimate-slots-public.js');
    const fn = reserve.slice(reserve.indexOf('async function lockedAreaAddOnLimitRefusal'), reserve.indexOf('// Answer a no-booking refusal'));
    expect(fn).toContain('fenceCustomer: (id) => limits.fenceCustomerBookings(trx, id),');
    expect(fn).toContain('fenceNamed: true,');
    expect(fn).toContain("if (err?.code === 'CUSTOMER_BUSY_RETRY') return CUSTOMER_BUSY_REFUSAL;");
    // Mark Won: the estimate's own customer is locked at the top; a customer the check finds is fenced
    const markWon = read('services/estimate-manual-acceptance.js');
    expect(markWon).toContain('fenceCustomer: (id) => addOnLimits.fenceCustomerBookings(trx, id),');
    expect(markWon.indexOf('await lockCustomerComms(trx, estimate.customer_id);')).toBeLessThan(markWon.indexOf('addOnLimits.assertAreaAddOnLimitsOpen(trx'));
    // Staff booking: the limits are read AFTER lockCustomerComms(trx, customerId) of the booking's customer
    const schedule = read('routes/admin-schedule.js');
    const lockAt = schedule.indexOf('await lockCustomerComms(trx, customerId);', schedule.indexOf('Rung 6 (scheduling/occupancy.js ORDERING CONTRACT) — BEFORE the'));
    const recheckAt = schedule.indexOf("require('../services/area-addon-limits').assertAreaAddOnLimitsOpen(trx, {");
    expect(lockAt).toBeGreaterThan(0);
    expect(recheckAt).toBeGreaterThan(lockAt);
    // The extend commits no application and runs no recheck; the card intents mint a SetupIntent and read no history
    const slots = read('routes/estimate-slots-public.js');
    const extend = slots.slice(slots.indexOf("router.post('/:token/reserve/:scheduledServiceId/extend'"));
    expect(extend).not.toContain('area-addon-limits');
    expect(slots.slice(slots.indexOf("router.post('/:token/card-hold-intent'"), slots.indexOf("router.delete('/:token/reserve/:scheduledServiceId'"))).not.toContain('area-addon-limits');
  });
});

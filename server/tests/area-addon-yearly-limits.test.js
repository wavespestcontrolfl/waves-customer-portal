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

  test('past applications and later bookings are counted as two separate 12-month spans, never summed', () => {
    // 300 days before and 300 days after the candidate day: no 12-month window holds both.
    const verdict = limits.areaAddOnLimitVerdict('fire_ant_yard', hist({ fire_ant_yard: [daysBefore(300), limits.addDays(TODAY, 300)] }));
    expect(verdict).toMatchObject({ count: 1, bookedAfter: 1, max: 1 });
    expect(verdict.detail).toContain(`was applied or booked 1 time at this property in the 12 months up to ${TODAY}, and is booked 1 time in the 12 months after it (limit 1 in 12 months)`);
    expect(verdict.detail).not.toContain('2 times');
    // Only a later booking: zero before, said as such.
    const later = limits.areaAddOnLimitVerdict('fire_ant_yard', hist({ fire_ant_yard: [limits.addDays(TODAY, 30)] }));
    expect(later).toMatchObject({ count: 0, bookedAfter: 1 });
    expect(later.detail).toContain('0 times at this property in the 12 months up to');
  });

  test('the verdict names the last application and when the next one is allowed', () => {
    const verdict = limits.areaAddOnLimitVerdict('bed_pre_emergent', hist({ bed_pre_emergent: [daysBefore(20)] }));
    expect(verdict).toMatchObject({ lastAppliedOn: daysBefore(20), nextAllowedOn: limits.addDays(daysBefore(20), 60) });
    expect(verdict.detail).toBe(`Snapshot 2.5TG was applied or booked 1 time at this property in the 12 months up to ${TODAY} (limit 4 in 12 months, at least 60 days apart). Last on ${daysBefore(20)}. The next one is allowed on ${limits.addDays(daysBefore(20), 60)}.`);
    expect(verdict).toMatchObject({ count: 1, bookedAfter: 0 });
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

const { fakeDb } = require('./helpers/area-addon-fake-db');

const CATALOG = [
  { id: 'p-snap', name: 'Snapshot 2.5TG', active: true }, { id: 'p-arena', name: 'Arena 50 WDG', active: true },
  { id: 'p-top', name: 'Topchoice Granular Insecticide', active: true }, { id: 'p-acel', name: 'Acelepryn Insecticide', active: true },
  { id: 'p-round', name: 'Roundup QuikPro SC', active: true },
];
const ADMIN_TECH = '99999999-9999-4999-8999-999999999999';
const FIELD_TECH = '88888888-8888-4888-8888-888888888888';
function world(over = {}) {
  return {
    technicians: [{ id: ADMIN_TECH, role: 'admin', active: true }, { id: FIELD_TECH, role: 'technician', active: true }],
    products_catalog: CATALOG,
    product_aliases: [],
    customer_properties: [{ id: PROPERTY, customer_id: CUSTOMER, active: true }],
    property_application_history: [],
    service_records: [],
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

  // Codex round 12 on #6135: the add-on's product is found by catalog identity (names and aliases), the same resolver the
  // job card, the feed and the completion use.
  test('a product renamed in the Service Library, its old name kept as an alias, keeps its history in the limit', async () => {
    const catalog = CATALOG.map((row) => (row.id === 'p-snap' ? { ...row, name: 'Snapshot Pro Granular' } : row));
    const out = await load(world({ products_catalog: catalog, product_aliases: [{ product_id: 'p-snap', alias_name: 'Snapshot 2.5TG' }], property_application_history: [ledger('p-snap', 25)] }));
    expect(out.byKey.bed_pre_emergent.dates).toEqual([daysBefore(25)]);
  });

  test('duplicate-named active and inactive rows of one product: the history counts both ids', async () => {
    const catalog = [...CATALOG, { id: 'p-snap-old', name: 'Snapshot 2.5TG', active: false }];
    const out = await load(world({ products_catalog: catalog, property_application_history: [ledger('p-snap', 25), ledger('p-snap-old', 40)] }));
    expect(out.byKey.bed_pre_emergent.dates).toEqual([daysBefore(40), daysBefore(25)]);
  });

  test('a limited add-on whose product has no catalog row is an unreadable history, never an empty one', async () => {
    const catalog = CATALOG.filter((row) => row.id !== 'p-snap');
    await expect(load(world({ products_catalog: catalog, property_application_history: [ledger('p-snap', 25)] })))
      .rejects.toMatchObject({ code: 'AREA_ADDON_LIMIT_PRODUCT_UNRESOLVED' });
    // The quote step turns that into the custom-quote line, not a pass.
    process.env.GATE_AREA_ADDONS = 'true';
    const quoted = await service.quoteAreaAddOnHistory(fakeDb(world({ products_catalog: catalog })), { entries: [{ key: 'bed_pre_emergent' }], customerId: CUSTOMER, propertyId: PROPERTY, requesterRole: 'admin' });
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
    const v1 = await service.attachQuoteAreaAddOnHistory(db, { ...HOME, services: { areaAddOns: entries } }, { existingCustomerId: CUSTOMER, propertyId: PROPERTY }, { requesterRole: 'admin' });
    const est = generateEstimate(v1);
    expect(est.lineItems.filter((l) => l.service === 'area_addon').map((l) => [l.addOnKey, l.price, l.customQuoteReason || null]))
      .toEqual([['bed_pre_emergent', null, 'area_addon_yearly_limit_reached'], ['web_sweep', 89, null]]);
  });

  test('an unknown property or a new lead (no customer): no history, priced normally', async () => {
    const db = fakeDb(world({ property_application_history: [ledger('p-snap', 25)] }));
    const v1 = await service.attachQuoteAreaAddOnHistory(db, { ...HOME, services: { areaAddOns: entries } }, {}, { requesterRole: 'admin' });
    expect(v1.services.areaAddOnHistory).toBeUndefined();
    expect(db.calls).toEqual([]);
    expect(generateEstimate(v1).lineItems.find((l) => l.addOnKey === 'bed_pre_emergent').price).toBe(99);
    // A customer with two properties and none named: the whole customer history counts (nothing can be proven elsewhere).
    const two = fakeDb(world({ customer_properties: [{ id: PROPERTY, customer_id: CUSTOMER, active: true }, { id: OTHER_PROPERTY, customer_id: CUSTOMER, active: true }], property_application_history: [ledger('p-snap', 25, { property_id: OTHER_PROPERTY })] }));
    const out = await service.attachQuoteAreaAddOnHistory(two, { ...HOME, services: { areaAddOns: entries } }, { existingCustomerId: CUSTOMER }, { requesterRole: 'admin' });
    expect(out.services.areaAddOnHistory.byKey.bed_pre_emergent.dates).toEqual([daysBefore(25)]);
  });

  test('a history read failure becomes the custom-quote line, never a silent pass', async () => {
    const broken = fakeDb(world({ property_application_history: () => { throw new Error('connection lost'); } }));
    const v1 = await service.attachQuoteAreaAddOnHistory(broken, { ...HOME, services: { areaAddOns: entries } }, { existingCustomerId: CUSTOMER, propertyId: PROPERTY }, { requesterRole: 'admin' });
    expect(v1.services.areaAddOnHistory).toEqual({ available: false, reason: 'history_unavailable' });
    expect(generateEstimate(v1).lineItems.filter((l) => l.service === 'area_addon').map((l) => [l.addOnKey, l.price, l.customQuoteReason || null]))
      .toEqual([['bed_pre_emergent', null, 'area_addon_history_unavailable'], ['web_sweep', 89, null]]);
  });

  test('gate off: no read at all (the engine refuses the add-on on its own)', async () => {
    delete process.env.GATE_AREA_ADDONS;
    const db = fakeDb(world());
    const v1 = await service.attachQuoteAreaAddOnHistory(db, { ...HOME, services: { areaAddOns: entries } }, { existingCustomerId: CUSTOMER }, { requesterRole: 'admin' });
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
    const out = await service.quoteAreaAddOnHistoryForSave(db, { engineRequest: { options: { areaAddOns: entries } } }, { customerId: CUSTOMER, propertyId: PROPERTY }, { technicianId: ADMIN_TECH });
    expect(out.byKey.bed_pre_emergent.dates).toEqual([daysBefore(25)]);
    expect(await service.quoteAreaAddOnHistoryForSave(db, { engineRequest: { options: { areaAddOns: entries } } }, {}, { technicianId: ADMIN_TECH })).toBeUndefined();
  });
});

function storedWith(keys, extra = {}) {
  return { result: { oneTime: { items: keys.map((addOnKey) => ({ service: 'area_addon', addOnKey, price: 99, ...extra })) } } };
}

describe('accept time: the recheck inside the transaction (history can change between quote and accept)', () => {
  const estimate = (keys, over = {}) => ({ id: ESTIMATE, customer_id: CUSTOMER, property_id: PROPERTY, estimate_data: storedWith(keys), ...over });

  test('quote vs accept race: priced at quote time, then another Snapshot application lands: the accept is refused with its own code', async () => {
    const before = fakeDb(world());
    const quoted = await service.attachQuoteAreaAddOnHistory(before, { ...HOME, services: { areaAddOns: [{ key: 'bed_pre_emergent', areaSqFt: 1000 }] } }, { existingCustomerId: CUSTOMER, propertyId: PROPERTY }, { requesterRole: 'admin' });
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
    await expect(service.assertAreaAddOnLimitsOpen(db, { estimate: estimate(['bed_pre_emergent'], { customer_id: null, property_id: null }), resolveCustomer: async () => null })).resolves.toBeUndefined();
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
    // Inside the transaction the recheck reads the row that transaction locked (assertLockedEstimateAddOns), never the preflight copy.
    expect(src).toMatch(/assertLockedEstimateAddOns\(trx, freshLinkedEstimate, \{\s+billingTerm: bookingBillingTerm, customerId, property: bookingProperty, appliedOn: scheduledDate,\s+postedServiceKeys: postedAreaAddOnLines\(pricing\)\.map\(\(line\) => line\.key\)\.filter\(Boolean\),\s+\}\)/);
    expect(src).toMatch(/assertAreaAddOnLimitsOpen\(trx, \{\s+estimate, customerId, property, appliedOn, staff: true, onlyServiceKeys: postedServiceKeys,\s+\}\)/);
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
      const out = await service.attachQuoteAreaAddOnHistory(fakeDb(snapHistory), input(), { ...options, propertyId: PROPERTY }, { requesterRole: 'admin' });
      expect(out.services.areaAddOnHistory).toMatchObject({ available: true });
      expect(generateEstimate(out).lineItems.find((l) => l.addOnKey === 'bed_pre_emergent')).toMatchObject({ quoteRequired: true });
    }
    const none = await service.attachQuoteAreaAddOnHistory(fakeDb(snapHistory), input(), { propertyId: PROPERTY }, { requesterRole: 'admin' });
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
  const theirs = (over = {}) => ({ id: OTHER_ESTIMATE, customer_phone: '(941) 555-0142', address: '1 test way, bradenton, fl 34202', customer_id: null, estimate_data: storedWith(['bed_pre_emergent']), ...over });
  const refusal = { code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' };
  const check = (tables, estimate = lead(['bed_pre_emergent']), extra = {}) => service.assertAreaAddOnLimitsOpen(fakeDb(world(tables)), { estimate, resolveCustomer: async () => null, ...extra });

  test('an unowned hold of another estimate with the same phone (any formatting) is a booked application: the second accept is refused', async () => {
    await expect(check({ scheduled_services: [hold()], estimates: [theirs()] })).rejects.toMatchObject(refusal);
    // the customer sees the office hand-off, staff the dates
    await expect(check({ scheduled_services: [hold()], estimates: [theirs()] }, lead(['bed_pre_emergent']), { staff: true })).rejects.toMatchObject({ message: expect.stringContaining('applied or booked') });
  });

  test('another place, a lapsed hold, a hold of the same estimate, another add-on or a hold with no sold add-on do not count; another phone at the same place does (Codex round 18)', async () => {
    await expect(check({ scheduled_services: [hold()], estimates: [theirs({ customer_phone: '941-555-0199', address: '9 Other St, Bradenton, FL 34202' })] })).resolves.toBeUndefined();
    await expect(check({ scheduled_services: [hold()], estimates: [theirs({ customer_phone: '941-555-0199' })] })).rejects.toMatchObject(refusal);
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

  test('a known customer also counts the holds of that customer\'s other estimates at the same address', async () => {
    const db = fakeDb(world({ scheduled_services: [hold()], estimates: [theirs({ customer_phone: '941-555-0199', customer_id: CUSTOMER })] }));
    await expect(service.assertAreaAddOnLimitsOpen(db, { estimate: lead(['bed_pre_emergent'], { customer_id: CUSTOMER, customer_phone: '+19415550150' }) })).rejects.toMatchObject(refusal);
    // ... and not those at the customer's other property
    const other = fakeDb(world({ scheduled_services: [hold()], estimates: [theirs({ customer_phone: '941-555-0199', customer_id: CUSTOMER, address: '9 Other St' })] }));
    await expect(service.assertAreaAddOnLimitsOpen(other, { estimate: lead(['bed_pre_emergent'], { customer_id: CUSTOMER, customer_phone: '+19415550150' }) })).resolves.toBeUndefined();
  });

  // Codex round 17 on #6135: a hold matched by phone alone counted at another property of the same phone.
  describe('an unowned hold counts at THIS property only (the treatment address, or the property ids)', () => {
    const P1 = PROPERTY;
    test('same phone + different address: not counted; same phone + same address: counted; no phone + same address: counted', async () => {
      await expect(check({ scheduled_services: [hold()], estimates: [theirs({ address: '9 Other St, Bradenton, FL 34202' })] })).resolves.toBeUndefined();
      await expect(check({ scheduled_services: [hold()], estimates: [theirs()] })).rejects.toMatchObject(refusal);
      const noPhone = lead(['bed_pre_emergent'], { customer_phone: null });
      await expect(check({ scheduled_services: [hold()], estimates: [theirs({ customer_phone: null })] }, noPhone)).rejects.toMatchObject(refusal);
    });

    test('a phone alone never places a hold: neither estimate names an address, no property id', async () => {
      await expect(check({ scheduled_services: [hold()], estimates: [theirs({ address: null })] }, lead(['bed_pre_emergent'], { address: null }))).resolves.toBeUndefined();
    });

    test('property ids on both sides decide: different ids are not counted, whatever the phone and the address say', async () => {
      const mine = lead(['bed_pre_emergent'], { property_id: P1 });
      await expect(check({ scheduled_services: [hold()], estimates: [theirs({ property_id: OTHER_PROPERTY })] }, mine)).resolves.toBeUndefined();
      await expect(check({ scheduled_services: [hold({ 's.property_id': OTHER_PROPERTY })], estimates: [theirs()] }, mine)).resolves.toBeUndefined();
    });

    test('the same property id is counted even when the address text differs (the id decides)', async () => {
      const mine = lead(['bed_pre_emergent'], { property_id: P1 });
      await expect(check({ scheduled_services: [hold()], estimates: [theirs({ property_id: P1, address: '1 Test Wy' })] }, mine)).rejects.toMatchObject(refusal);
      await expect(check({ scheduled_services: [hold({ 's.property_id': P1 })], estimates: [theirs({ address: '1 Test Wy' })] }, mine)).rejects.toMatchObject(refusal);
    });

    test('a property id on one side only: the address decides', async () => {
      // the hold's estimate has an id, the lead has none
      await expect(check({ scheduled_services: [hold()], estimates: [theirs({ property_id: P1 })] })).rejects.toMatchObject(refusal);
      await expect(check({ scheduled_services: [hold()], estimates: [theirs({ property_id: P1, address: '9 Other St' })] })).resolves.toBeUndefined();
      // the lead has an id, the hold's estimate has none
      const mine = lead(['bed_pre_emergent'], { property_id: P1 });
      await expect(check({ scheduled_services: [hold()], estimates: [theirs()] }, mine)).rejects.toMatchObject(refusal);
      await expect(check({ scheduled_services: [hold()], estimates: [theirs({ address: '9 Other St' })] }, mine)).resolves.toBeUndefined();
    });

    test('the identity lock keeps one phone serialized across addresses, and adds the property', async () => {
      const order = [];
      const trx = fakeDb(world());
      trx.isTransaction = true;
      trx.raw = jest.fn(async (sql, bindings) => { order.push([String(sql), bindings && bindings[0]]); return {}; });
      const wrapped = Object.assign((table) => trx(table), { isTransaction: true, raw: trx.raw });
      await service.assertAreaAddOnLimitsOpen(wrapped, { estimate: lead(['bed_pre_emergent'], { property_id: P1 }), resolveCustomer: async () => null });
      expect(order.slice(0, 3).map(([, key]) => key)).toEqual(['phone:9415550142', 'address:1testwaybradentonfl34202', `property:${P1}`]);
    });
  });

  test('the same-phone lock is taken inside the transaction before anything is read; a named customer takes the place keys but no phone key; outside a transaction nothing', async () => {
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
    // a customer already named is serialized by the customer lock, but not against another person at the same place: no phone key, the place keys
    trx.raw.mockClear(); order.length = 0;
    await service.assertAreaAddOnLimitsOpen(wrapped, { estimate: lead(['bed_pre_emergent'], { customer_id: CUSTOMER }) });
    expect(order.filter(([sql]) => sql.includes('advisory')).map(([, key]) => key)).toEqual(['address:1testwaybradentonfl34202', 'place:1testway34202']);
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
  const ADDON_OF = { 'p-arena': 'area_addon_lawn_insect_spot', 'p-round': 'area_addon_hardscape_weed' };
  const card = (id) => ({ id, rowId: `${id}::${ADDON_OF[id]}`, addOnKey: ADDON_OF[id], name: 'x', governed: { limit: 'Label limit text.' } });

  test('an add-on card gets "Application N of M in 12 months; last applied ..." from the property history; a host card of the same product gets none', async () => {
    const db = fakeDb(world({
      scheduled_services: [{ id: 'visit-1', customer_id: CUSTOMER, property_id: PROPERTY }],
      property_application_history: [ledger('p-arena', 90)],
    }));
    const host = { id: 'p-arena', rowId: 'p-arena', addOnKey: null, name: 'host' };
    const cards = await service.attachLimitUse([host, card('p-arena'), { id: 'p-other', name: 'y' }, card('p-round')], { serviceId: 'visit-1', visitDay: TODAY, dbh: db });
    expect(cards[0]).toEqual(host);
    expect(cards[1].governed).toEqual({ limit: 'Label limit text.', use: `Application 2 of 2 in 12 months; last applied ${daysBefore(90)}.` });
    expect(cards[2].governed).toBeUndefined();
    expect(cards[3].governed.use).toBe('Application 1 of 2 in 12 months.');
  });

  test('a failed read leaves the card as it was; a card with no governed text reads nothing', async () => {
    const broken = fakeDb(world({ scheduled_services: [{ id: 'visit-1', customer_id: CUSTOMER, property_id: PROPERTY }], property_application_history: () => { throw new Error('down'); } }));
    const cards = await service.attachLimitUse([card('p-arena')], { serviceId: 'visit-1', visitDay: TODAY, dbh: broken });
    expect(cards[0].governed).toEqual({ limit: 'Label limit text.' });
    const quiet = fakeDb(world());
    await service.attachLimitUse([{ id: 'p-arena', name: 'x' }], { serviceId: 'visit-1', visitDay: TODAY, dbh: quiet });
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
    // The recheck reads the handler's earlier copy of the estimate; the claim UPDATE just above it (after the FOR UPDATE) is a
    // compare-and-swap on that copy's updated_at, so a changed estimate is a 0-row 409 and the transaction rolls back before the recheck.
    expect(src).toContain("date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', ?::timestamptz)");
    expect(src.indexOf("const freshLinkRow = await trx('estimates').where({ id: estimate.id }).forUpdate()")).toBeLessThan(src.indexOf('.update(withServedDisclosurePreserved(trx, acceptedUpdates));'));
    expect(setupIntent).toBeGreaterThan(check);
    // ... and before the account step creates the customer the recheck must have judged.
    expect(account).toBeGreaterThan(check);
  });

  test('the reserve rechecks inside the reserve transaction on the selected slot day; the staff booking before AND inside its transaction (after the customer lock, before the visit insert); Mark Won in its transaction', () => {
    expect(read('routes/estimate-slots-public.js')).toMatch(/revalidateEstimate: async \(row, trx, \{ date \} = \{\}\) => \{[\s\S]{0,700}lockedAreaAddOnRuleRefusal\(row, requestedServiceMode\)[\s\S]{0,80}lockedAreaAddOnLimitRefusal\(row, trx, date\)/);
    expect(read('services/slot-reservation.js')).toContain('await revalidateEstimate(estimate, trx, { date });');
    const schedule = read('routes/admin-schedule.js');
    const book = schedule.indexOf('areaAddOnLimitRefusal(db, { estimate: linkedEstimate, customerId, property: bookingProperty, appliedOn: scheduledDate, staff: true })');
    expect(book).toBeGreaterThan(0);
    expect(book).toBeLessThan(schedule.indexOf('db.transaction', book));
    const customerLock = schedule.indexOf('await lockCustomerComms(trx, customerId);', book);
    const again = schedule.indexOf('await assertLockedEstimateAddOns(trx, freshLinkedEstimate, {', customerLock);
    const insert = schedule.indexOf("[svc] = await trx('scheduled_services').insert(adminCreateInsert).returning('*');", again);
    expect(customerLock).toBeGreaterThan(book);
    expect(again).toBeGreaterThan(customerLock);
    expect(insert).toBeGreaterThan(again);
    const won = read('services/estimate-manual-acceptance.js');
    expect(won).toContain('estimate, staff: true, excludeVisitIds: bookedAppointmentIds, fenceCustomer');
    // comms lock, then the estimate row FOR UPDATE, then the recheck on the locked row (Codex round 14): never the first read
    const commsAt = won.indexOf('await lockCustomerComms(trx, estimate.customer_id);');
    const rowLockAt = won.indexOf("const freshLinkRow = await trx('estimates').where({ id: estimateId }).forUpdate().first();");
    const recheckAt = won.indexOf('await assertAddOnsAcceptable(trx, estimate, {');
    expect(commsAt).toBeGreaterThan(0);
    expect(rowLockAt).toBeGreaterThan(commsAt);
    expect(recheckAt).toBeGreaterThan(rowLockAt);
    expect(won.indexOf('if (freshLinkRow) estimate = { ...estimate, ...freshLinkRow };')).toBeLessThan(recheckAt);
  });

  test('the quote steps attach the history; the engine file never queries', () => {
    expect(read('routes/property-lookup-v2.js')).toContain('attachQuoteAreaAddOnHistory(require(\'../models/db\'), v1Input, options, { requesterRole: req.techRole })');
    expect(read('services/admin-estimate-persistence.js')).toContain('quoteAreaAddOnHistoryForSave(database, trustedEstimateData, body, { technicianId })');
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
    expect(markWon.indexOf('await lockCustomerComms(trx, estimate.customer_id);')).toBeLessThan(markWon.indexOf('await assertAddOnsAcceptable(trx, estimate, {'));
    // Staff booking: the limits are read AFTER lockCustomerComms(trx, customerId) of the booking's customer
    const schedule = read('routes/admin-schedule.js');
    const lockAt = schedule.indexOf('await lockCustomerComms(trx, customerId);', schedule.indexOf('Rung 6 (scheduling/occupancy.js ORDERING CONTRACT) — BEFORE the'));
    const recheckAt = schedule.indexOf('await assertLockedEstimateAddOns(trx, freshLinkedEstimate, {');
    expect(lockAt).toBeGreaterThan(0);
    expect(recheckAt).toBeGreaterThan(lockAt);
    // The extend commits no application and runs no recheck; the card intents mint a SetupIntent and read no history
    const slots = read('routes/estimate-slots-public.js');
    const extend = slots.slice(slots.indexOf("router.post('/:token/reserve/:scheduledServiceId/extend'"));
    expect(extend).not.toContain('area-addon-limits');
    expect(slots.slice(slots.indexOf("router.post('/:token/card-hold-intent'"), slots.indexOf("router.delete('/:token/reserve/:scheduledServiceId'"))).not.toContain('area-addon-limits');
  });
});

describe('quote time: only an admin requester reads a customer\'s treatment history', () => {
  const entries = [{ key: 'bed_pre_emergent', areaSqFt: 1000 }];
  const history = () => world({ property_application_history: [ledger('p-snap', 25)] });
  const saved = process.env.GATE_AREA_ADDONS;
  beforeEach(() => { process.env.GATE_AREA_ADDONS = 'true'; });
  afterAll(() => { if (saved === undefined) delete process.env.GATE_AREA_ADDONS; else process.env.GATE_AREA_ADDONS = saved; });

  test.each([['technician'], [null], [undefined], ['ADMIN'], ['']])('a %s requester gets the history-unavailable line and no table is read', async (requesterRole) => {
    const calls = [];
    const out = await service.quoteAreaAddOnHistory(fakeDb(history(), calls), { entries, customerId: CUSTOMER, propertyId: PROPERTY, requesterRole });
    expect(out).toEqual({ available: false, reason: 'history_not_authorized' });
    expect(calls).toEqual([]);
  });

  test('the calculate step takes the role from the authenticated request, never from the posted options', async () => {
    const calls = [];
    const v1 = await service.attachQuoteAreaAddOnHistory(fakeDb(history(), calls), { ...HOME, services: { areaAddOns: entries } },
      { existingCustomerId: CUSTOMER, propertyId: PROPERTY, requesterRole: 'admin' }, { requesterRole: 'technician' });
    expect(v1.services.areaAddOnHistory).toEqual({ available: false, reason: 'history_not_authorized' });
    expect(calls).toEqual([]);
  });

  test('the save reads the saving technician\'s role: a technician, an unknown id and an inactive admin read no history', async () => {
    const data = { engineRequest: { options: { areaAddOns: entries } } };
    const body = { customerId: CUSTOMER, propertyId: PROPERTY };
    for (const technicianId of [FIELD_TECH, '77777777-7777-4777-8777-777777777777', null]) {
      const calls = [];
      const out = await service.quoteAreaAddOnHistoryForSave(fakeDb(history(), calls), data, body, { technicianId });
      expect(out).toEqual({ available: false, reason: 'history_not_authorized' });
      expect(calls).not.toContain('property_application_history');
    }
    const inactive = world({ technicians: [{ id: ADMIN_TECH, role: 'admin', active: false }], property_application_history: [ledger('p-snap', 25)] });
    expect(await service.quoteAreaAddOnHistoryForSave(fakeDb(inactive), data, body, { technicianId: ADMIN_TECH })).toEqual({ available: false, reason: 'history_not_authorized' });
    // An admin reads it.
    const ok = await service.quoteAreaAddOnHistoryForSave(fakeDb(history()), data, body, { technicianId: ADMIN_TECH });
    expect(ok.byKey.bed_pre_emergent.dates).toEqual([daysBefore(25)]);
  });

  test('with no limited add-on or no customer the save reads nothing, not even the role', async () => {
    const calls = [];
    expect(await service.quoteAreaAddOnHistoryForSave(fakeDb(history(), calls), { engineRequest: { options: { areaAddOns: [{ key: 'web_sweep' }] } } }, { customerId: CUSTOMER }, { technicianId: ADMIN_TECH })).toBeUndefined();
    expect(await service.quoteAreaAddOnHistoryForSave(fakeDb(history(), calls), { engineRequest: { options: { areaAddOns: entries } } }, {}, { technicianId: ADMIN_TECH })).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('the recheck finds the sold add-ons in every one-time shape the booking reads (Codex round 16)', () => {
  const row = (over = {}) => ({ service: 'area_addon', addOnKey: 'fire_ant_yard', ...over });
  test.each([
    ['mapped oneTime.items with price', { result: { oneTime: { items: [row({ price: 99 })] } } }],
    ['raw result.lineItems', { result: { lineItems: [row({ price: 99 })] } }],
    ['raw engineResult.lineItems', { engineResult: { lineItems: [row({ price: 99 })] } }],
    ['bare lineItems', { lineItems: [row({ price: 99 })] }],
    ['amount instead of price', { result: { oneTime: { items: [row({ amount: 99 })] } } }],
    ['total instead of price', { result: { oneTime: { items: [row({ total: '99' })] } } }],
    ['priceAfterDiscount', { result: { oneTime: { items: [row({ priceAfterDiscount: 99 })] } } }],
    ['a JSON string', JSON.stringify({ engineResult: { lineItems: [row({ price: 99 })] } })],
  ])('%s', (_label, data) => {
    expect(service.soldAddOnKeys(data)).toEqual(['fire_ant_yard']);
  });

  test('an unpriced or custom-quote row is not booked and is not rechecked; other services are ignored', () => {
    const data = { result: { oneTime: { items: [row({ price: null, requiresCustomQuote: true }), row({ price: 0 }), row({ price: 99, quoteRequired: true }), { service: 'one_time_pest', price: 199 }] } } };
    expect(service.soldAddOnKeys(data)).toEqual([]);
    expect(service.soldAddOnKeys('not json')).toEqual([]);
  });
});

// Codex round 18 on #6135: a label limit is about the treatment PLACE, not the customer record. Two estimate links at one
// address with two phones (two people, or one person with two numbers) are two customers, or one customer and one with
// none yet, with two customer_properties rows of ONE address_key; the first accept's booking must stop the second.
// Codex round 24: a staff booking judges only the add-ons it posts.
describe('onlyServiceKeys narrows the recheck to the posted add-ons', () => {
  const sold = { id: ESTIMATE, customer_id: CUSTOMER, property_id: PROPERTY, estimate_data: storedWith(['bed_pre_emergent']) };
  const atLimit = () => fakeDb(world({ property_application_history: [ledger('p-snap', 3)] }));
  test('the sold add-on at its limit stops a booking that posts it, not one that leaves it off', async () => {
    await expect(service.assertAreaAddOnLimitsOpen(atLimit(), { estimate: sold, staff: true })).rejects.toMatchObject({ code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' });
    await expect(service.assertAreaAddOnLimitsOpen(atLimit(), { estimate: sold, staff: true, onlyServiceKeys: ['area_addon_bed_pre_emergent'] })).rejects.toMatchObject({ code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' });
    await expect(service.assertAreaAddOnLimitsOpen(atLimit(), { estimate: sold, staff: true, onlyServiceKeys: ['one_time_pest'] })).resolves.toBeUndefined();
    await expect(service.assertAreaAddOnLimitsOpen(atLimit(), { estimate: sold, staff: true, onlyServiceKeys: [] })).resolves.toBeUndefined();
  });
});

describe('the history is the place\'s, whoever the customer record is (Codex round 18)', () => {
  const { addressKey: propertyKey } = require('../services/customer-property-address-keys');
  const CUSTOMER_B = '11111111-1111-4111-8111-1111111111b2';
  const PROPERTY_B = '22222222-2222-4222-8222-2222222222b2';
  const UNIT_PROPERTY = '55555555-5555-4555-8555-555555555552';
  const HOME_KEY = propertyKey({ address_line1: '1 Test Way', city: 'Bradenton', zip: '34202' });
  const props = () => [
    { id: PROPERTY, customer_id: CUSTOMER, active: true, address_key: HOME_KEY },
    { id: PROPERTY_B, customer_id: CUSTOMER_B, active: true, address_key: HOME_KEY },
    { id: OTHER_PROPERTY, customer_id: CUSTOMER, active: true, address_key: propertyKey({ address_line1: '9 Other St', city: 'Bradenton', zip: '34202' }) },
    { id: UNIT_PROPERTY, customer_id: CUSTOMER_B, active: true, address_key: propertyKey({ address_line1: '1 Test Way', address_line2: 'Apt 4', city: 'Bradenton', zip: '34202' }) },
  ];
  const placeWorld = (tables = {}) => world({ customer_properties: props(), ...tables });
  // The SECOND estimate: another phone, no customer yet, the address as free text.
  const second = (over = {}) => ({ id: ESTIMATE, customer_id: null, property_id: null, customer_phone: '+19415550199', address: '1 Test Way, Bradenton, FL 34202', estimate_data: storedWith(['bed_pre_emergent']), ...over });
  const check = (tables, estimate = second(), extra = {}) => service.assertAreaAddOnLimitsOpen(fakeDb(placeWorld(tables)), { estimate, resolveCustomer: async () => null, ...extra });
  const refused = { code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' };
  const soon = new Date(Date.now() + 600000).toISOString();

  describe('a booking made under the first phone stops the second estimate at the same place', () => {
    const FIRST = { own: () => ({ scheduled_services: [ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 5))] }), row: () => ({ scheduled_service_addons: [rowVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 5))] }) };

    test.each([['the visit itself', 'own'], ['an add-on row on another service\'s visit', 'row']])('%s: refused for a lead with no customer, and for a different customer record at the place', async (_label, shape) => {
      await expect(check(FIRST[shape]())).rejects.toMatchObject(refused);
      await expect(check(FIRST[shape](), second({ customer_id: CUSTOMER_B, property_id: PROPERTY_B }))).rejects.toMatchObject(refused);
      // customer B named, no property on the estimate: B's only property is the place
      await expect(check(FIRST[shape](), second(), { customerId: CUSTOMER_B })).rejects.toMatchObject(refused);
    });

    test('a completed or cancelled booking, another add-on, another property of the first customer, or another place is not counted', async () => {
      for (const extra of [{ 's.status': 'completed' }, { 's.status': 'cancelled' }, { 's.property_id': OTHER_PROPERTY }, { 's.property_id': UNIT_PROPERTY }]) {
        await expect(check({ scheduled_services: [ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 5), extra)] })).resolves.toBeUndefined();
      }
      await expect(check({ scheduled_services: [ownVisit('area_addon_fire_ant_yard', limits.addDays(TODAY, 5))] })).resolves.toBeUndefined();
      await expect(check(FIRST.own(), second({ address: '2 Test Way, Bradenton, FL 34202' }))).resolves.toBeUndefined();
    });

    test('the rows the caller is committing are still left out, for the other customer\'s estimate too', async () => {
      await expect(check(FIRST.own(), second(), { excludeVisitIds: ['v-1'.padEnd(36, '0')] })).rejects.toMatchObject(refused);
      const ADOPTED = '77777777-7777-4777-8777-777777777771';
      const adopted = { scheduled_services: [ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 5), { 's.id': ADOPTED })] };
      await expect(check(adopted, second(), { excludeVisitIds: [ADOPTED] })).resolves.toBeUndefined();
    });

    test('a visit with no property id of its own is placed by the address of the estimate it was booked from', async () => {
      const unplaced = (estimateAddress, over = {}) => ({
        scheduled_services: [ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 5), { 's.property_id': null, 's.source_estimate_id': OTHER_ESTIMATE, ...over })],
        estimates: [{ id: OTHER_ESTIMATE, address: estimateAddress }],
      });
      await expect(check(unplaced('1 test way, bradenton fl 34202'), second({ address: '1 Test Way, Bradenton, FL 34202' }))).rejects.toMatchObject(refused);
      // the same place in the canonical form (suffix, case, ZIP+4)
      await expect(check(unplaced('1 TEST WAY, Bradenton, FL 34202-1234'))).rejects.toMatchObject(refused);
      await expect(check(unplaced('9 Other St, Bradenton, FL 34202'))).resolves.toBeUndefined();
      // no source estimate: it cannot be placed, so another customer's visit is not counted
      await expect(check({ scheduled_services: [ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 5), { 's.property_id': null })] })).resolves.toBeUndefined();
    });
  });

  // Codex round 22: an existing customer's estimate with no property id that quotes ANOTHER address. The customer's only
  // property on file is not the treatment place: the quoted address's history is read, and the on-file one is not.
  describe('a known customer quoted at another address, no property id on the estimate', () => {
    const elsewhere = second({ customer_id: CUSTOMER_B, property_id: null, address: '9 Other St, Bradenton, FL 34202' });
    test('applications at the on-file property do not block; applications at the quoted address do', async () => {
      // CUSTOMER_B's rows at their own home (1 Test Way): another place than the quote
      const lone = { customer_properties: props().filter((row) => row.id !== UNIT_PROPERTY) };
      await expect(check({ ...lone, property_application_history: [ledger('p-snap', 25, { customer_id: CUSTOMER_B, property_id: PROPERTY_B })] }, elsewhere)).resolves.toBeUndefined();
      await expect(check({ ...lone, property_application_history: [ledger('p-snap', 25, { customer_id: CUSTOMER, property_id: OTHER_PROPERTY })] }, elsewhere)).rejects.toMatchObject(refused);
      // Codex round 24: SEVERAL properties and none named. The one at the quoted address is read, never the whole customer.
      const many = { customer_properties: props() };
      await expect(check({ ...many, property_application_history: [ledger('p-snap', 25, { customer_id: CUSTOMER_B, property_id: PROPERTY_B })] }, second({ customer_id: CUSTOMER_B, property_id: null, address: '1 Test Way, Apt 4, Bradenton, FL 34202' }))).resolves.toBeUndefined();
      await expect(check({ ...many, property_application_history: [ledger('p-snap', 25, { customer_id: CUSTOMER_B, property_id: UNIT_PROPERTY })] }, second({ customer_id: CUSTOMER_B, property_id: null, address: '1 Test Way, Apt 4, Bradenton, FL 34202' }))).rejects.toMatchObject(refused);
      await expect(check({ ...many, property_application_history: [ledger('p-snap', 25, { customer_id: CUSTOMER_B, property_id: PROPERTY_B })] }, second({ customer_id: CUSTOMER_B, property_id: null }))).rejects.toMatchObject(refused);
      // the quote at the on-file address still reads the on-file property
      await expect(check({ ...lone, property_application_history: [ledger('p-snap', 25, { customer_id: CUSTOMER_B, property_id: PROPERTY_B })] }, second({ customer_id: CUSTOMER_B, property_id: null }))).rejects.toMatchObject(refused);
    });
  });

  // Codex round 28: the estimate names a property AND carries an address text edited to another address. The property is the
  // place; an unplaced visit at the typed address is not at it.
  describe('a named property with a known address key: the estimate\'s typed address is no second identity', () => {
    const typedElsewhere = second({ customer_id: CUSTOMER, property_id: PROPERTY, address: '9 Other St, Bradenton, FL 34202' });
    const unplacedAt = (address) => ({
      scheduled_services: [ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 5), { 's.customer_id': CUSTOMER_B, 's.property_id': null, 's.source_estimate_id': OTHER_ESTIMATE })],
      estimates: [{ id: OTHER_ESTIMATE, address }],
    });
    test('an unplaced visit at the typed address does not count; one at the property\'s own address does', async () => {
      await expect(check(unplacedAt('9 Other St, Bradenton, FL 34202'), typedElsewhere)).resolves.toBeUndefined();
      await expect(check(unplacedAt('1 Test Way, Bradenton, FL 34202'), typedElsewhere)).rejects.toMatchObject(refused);
    });
  });

  // Codex round 19: one customer with an older (or inactive) property row of the same address_key. The estimate names the
  // current row; an application or a booking recorded against the older row is still at the place.
  describe('the same customer\'s older property row at the same place counts', () => {
    const OLD_PROPERTY = '22222222-2222-4222-8222-2222222222c3';
    const withOld = (tables) => ({ customer_properties: [...props(), { id: OLD_PROPERTY, customer_id: CUSTOMER, active: false, address_key: HOME_KEY }], ...tables });
    const mine = second({ customer_id: CUSTOMER, property_id: PROPERTY });

    test('a ledger row on the older row is counted once; a row at the customer\'s other address is not', async () => {
      await expect(check(withOld({ property_application_history: [ledger('p-snap', 25, { property_id: OLD_PROPERTY })] }), mine)).rejects.toMatchObject(refused);
      await expect(check(withOld({ property_application_history: [ledger('p-snap', 25, { property_id: OTHER_PROPERTY })] }), mine)).resolves.toBeUndefined();
      const out = await service.loadAreaAddOnHistory(fakeDb(placeWorld(withOld({ property_application_history: [ledger('p-snap', 25, { property_id: OLD_PROPERTY }), ledger('p-snap', 90)] }))), { customerId: CUSTOMER, propertyId: PROPERTY, asOf: TODAY, keys: ['bed_pre_emergent'] });
      expect(out.byKey.bed_pre_emergent.dates).toEqual([daysBefore(90), daysBefore(25)]);
    });

    test('a booked add-on visit on the older row is counted; one at the other address is not', async () => {
      await expect(check(withOld({ scheduled_services: [ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 5), { 's.property_id': OLD_PROPERTY })] }), mine)).rejects.toMatchObject(refused);
      await expect(check(withOld({ scheduled_services: [ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 5), { 's.property_id': OTHER_PROPERTY })] }), mine)).resolves.toBeUndefined();
    });
  });

  describe('a completed application (the ledger) under another customer record counts at the same place', () => {
    test('the application of the other customer at the place, program or add-on, stops the second estimate', async () => {
      await expect(check({ property_application_history: [ledger('p-snap', 25, { customer_id: CUSTOMER, property_id: PROPERTY })] })).rejects.toMatchObject(refused);
      await expect(check({ property_application_history: [ledger('p-snap', 25, { customer_id: CUSTOMER_B, property_id: PROPERTY_B })] }, second({ customer_id: CUSTOMER, property_id: PROPERTY }))).rejects.toMatchObject(refused);
      // the staff message names the property and never the other record
      await expect(check({ property_application_history: [ledger('p-snap', 25, { customer_id: CUSTOMER_B, property_id: PROPERTY_B })] }, second({ customer_id: CUSTOMER, property_id: PROPERTY }), { staff: true }))
        .rejects.toMatchObject({ message: expect.stringMatching(/applied or booked 1 time at this property in the 12 months up to/) });
      await expect(check({ property_application_history: [ledger('p-snap', 25, { customer_id: CUSTOMER_B, property_id: PROPERTY_B })] }, second({ customer_id: CUSTOMER, property_id: PROPERTY }), { staff: true }))
        .rejects.toMatchObject({ message: expect.not.stringContaining(CUSTOMER_B) });
    });

    test('a Tree & Shrub program application (Snapshot) recorded under another customer at the same property counts toward the bed add-on', async () => {
      const programRow = ledger('p-snap', 40, { customer_id: CUSTOMER_B, property_id: PROPERTY_B, service_record_id: 'sr-program' });
      await expect(check({ property_application_history: [programRow] }, second({ customer_id: CUSTOMER, property_id: PROPERTY }))).rejects.toMatchObject(refused);
      // ... and it opens again when the next one is allowed (60 days) and when the product differs
      await expect(check({ property_application_history: [programRow] }, second({ customer_id: CUSTOMER, property_id: PROPERTY }), { appliedOn: limits.addDays(TODAY, 30) })).resolves.toBeUndefined();
      await expect(check({ property_application_history: [{ ...programRow, product_id: 'p-other' }] }, second({ customer_id: CUSTOMER, property_id: PROPERTY }))).resolves.toBeUndefined();
    });

    test('older than 12 months, retracted, at another place, or another customer\'s row that cannot be placed: not counted', async () => {
      for (const row of [
        ledger('p-snap', 400, { customer_id: CUSTOMER_B, property_id: PROPERTY_B }),
        ledger('p-snap', 25, { customer_id: CUSTOMER_B, property_id: PROPERTY_B, retracted_at: '2026-09-01' }),
        ledger('p-snap', 25, { customer_id: CUSTOMER_B, property_id: OTHER_PROPERTY }),
        ledger('p-snap', 25, { customer_id: CUSTOMER_B, property_id: null }),
      ]) {
        await expect(check({ property_application_history: [row] }, second({ customer_id: CUSTOMER, property_id: PROPERTY }))).resolves.toBeUndefined();
      }
    });

    // Codex round 21: a completed legacy application with no property on the row or on the visit.
    test('a legacy row with no property anywhere is placed by the address of the estimate its visit was booked from', async () => {
      const legacy = ledger('p-snap', 25, { customer_id: CUSTOMER_B, property_id: null, service_record_id: 'sr-1' });
      const at = (address, over = {}) => ({
        property_application_history: [legacy],
        service_records: [{ 'sr.id': 'sr-1', record_id: 'sr-1', visit_id: 'v-legacy', source_estimate_id: OTHER_ESTIMATE, 'ss.property_id': null, 'ss.source_estimate_id': OTHER_ESTIMATE, ...over }],
        estimates: [{ id: OTHER_ESTIMATE, address }],
      });
      await expect(check(at('1 test way, bradenton fl 34202'))).rejects.toMatchObject(refused);
      await expect(check(at('9 Other St, Bradenton, FL 34202'))).resolves.toBeUndefined();
      // no source estimate: it cannot be placed
      await expect(check(at('1 Test Way, Bradenton, FL 34202', { 'ss.source_estimate_id': null }))).resolves.toBeUndefined();
    });

    test('a legacy row with no frozen property is placed by its visit\'s property', async () => {
      const legacy = ledger('p-snap', 25, { customer_id: CUSTOMER_B, property_id: null, service_record_id: 'sr-1' });
      await expect(check({ property_application_history: [legacy], service_records: [{ 'sr.id': 'sr-1', 'ss.property_id': PROPERTY_B }] })).rejects.toMatchObject(refused);
      await expect(check({ property_application_history: [legacy], service_records: [{ 'sr.id': 'sr-1', 'ss.property_id': OTHER_PROPERTY }] })).resolves.toBeUndefined();
    });

    test('the visit being displayed on the job card is left out of the other customers\' rows too', async () => {
      const VISIT = '55555555-5555-4555-8555-555555555551';
      const rows = [ledger('p-snap', 25, { customer_id: CUSTOMER_B, property_id: PROPERTY_B })];
      const read = (excludeVisitId) => service.loadAreaAddOnHistory(fakeDb(placeWorld({ property_application_history: rows })), { customerId: CUSTOMER, propertyId: PROPERTY, asOf: TODAY, keys: ['bed_pre_emergent'], excludeVisitId });
      expect((await read(VISIT)).byKey.bed_pre_emergent.dates).toEqual([daysBefore(25)]);
    });
  });

  describe('the same place in any spelling; a different place is not counted', () => {
    const booked = (propertyId) => ({ scheduled_services: [ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 5), { 's.property_id': propertyId })] });

    test.each([
      ['1 Test Way, Bradenton, FL 34202'],
      ['1 TEST WAY,  bradenton , fl 34202-1234'],
      ['1 Test Way, Bradenton, FL 34202, USA'],
    ])('%s is the place', async (address) => {
      await expect(check(booked(PROPERTY), second({ address }))).rejects.toMatchObject(refused);
    });

    test.each([
      ['1 Test Way #4, Bradenton, FL 34202'],
      ['Unit 4, 1 Test Way, Bradenton, FL 34202'],
      ['1 Test Way, Apt 4, Bradenton, FL 34202'],
      ['1 Test Way Apt. 4, Bradenton, FL 34202, USA'],
    ])('%s is the unit\'s place, not the building\'s', async (address) => {
      await expect(check(booked(UNIT_PROPERTY), second({ address }))).rejects.toMatchObject(refused);
      await expect(check(booked(PROPERTY), second({ address }))).resolves.toBeUndefined();
    });

    test('another house, another street number or another ZIP is another place', async () => {
      for (const address of ['9 Other St, Bradenton, FL 34202', '2 Test Way, Bradenton, FL 34202', '1 Test Way, Bradenton, FL 34203']) {
        await expect(check(booked(PROPERTY), second({ address }))).resolves.toBeUndefined();
      }
    });

    test('a property id on the estimate is the place: its address text is not consulted', async () => {
      await expect(check(booked(PROPERTY), second({ property_id: PROPERTY_B, address: '9 Other St, Bradenton, FL 34202' }))).rejects.toMatchObject(refused);
      await expect(check(booked(OTHER_PROPERTY), second({ property_id: PROPERTY_B }))).resolves.toBeUndefined();
    });
  });

  describe('a known customer with two properties counts only the property being treated', () => {
    const mine = (over = {}) => second({ customer_id: CUSTOMER, property_id: PROPERTY, ...over });
    test('the customer\'s own booking and application at the other property do not count', async () => {
      await expect(check({ scheduled_services: [ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 5), { 's.property_id': OTHER_PROPERTY })] }, mine())).resolves.toBeUndefined();
      await expect(check({ property_application_history: [ledger('p-snap', 25, { property_id: OTHER_PROPERTY })] }, mine())).resolves.toBeUndefined();
      // another customer's application at the other property is not this place either
      await expect(check({ property_application_history: [ledger('p-snap', 25, { customer_id: CUSTOMER_B, property_id: OTHER_PROPERTY })] }, mine())).resolves.toBeUndefined();
    });

    test('the same rows at the treated property count, and the customer\'s unplaced rows still count', async () => {
      await expect(check({ property_application_history: [ledger('p-snap', 25, { property_id: PROPERTY })] }, mine())).rejects.toMatchObject(refused);
      await expect(check({ property_application_history: [ledger('p-snap', 25, { property_id: null })] }, mine())).rejects.toMatchObject(refused);
      await expect(check({ scheduled_services: [ownVisit('area_addon_bed_pre_emergent', limits.addDays(TODAY, 5), { 's.property_id': null })] }, mine())).rejects.toMatchObject(refused);
    });
  });

  describe('holds at the place, whoever holds them', () => {
    const hold = (over = {}) => ({ 's.customer_id': null, 's.source_estimate_id': OTHER_ESTIMATE, 's.reservation_expires_at': soon, 's.status': 'pending', 's.id': HOLD_ID, 's.scheduled_date': limits.addDays(TODAY, 5), 's.property_id': null, ...over });
    const theirs = (over = {}) => ({ id: OTHER_ESTIMATE, customer_phone: '(941) 555-0142', address: '1 Test Way, Bradenton, FL 34202', customer_id: null, property_id: null, estimate_data: storedWith(['bed_pre_emergent']), ...over });

    test('a hold of another phone on the sibling property row, or at the same address, counts; at another property it does not', async () => {
      await expect(check({ scheduled_services: [hold({ 's.property_id': PROPERTY_B })], estimates: [theirs({ address: 'x' })] }, second({ property_id: PROPERTY }))).rejects.toMatchObject(refused);
      await expect(check({ scheduled_services: [hold()], estimates: [theirs({ address: '1 TEST WAY, Bradenton, FL 34202-1234' })] })).rejects.toMatchObject(refused);
      await expect(check({ scheduled_services: [hold({ 's.property_id': OTHER_PROPERTY })], estimates: [theirs()] }, second({ property_id: PROPERTY }))).resolves.toBeUndefined();
    });
  });

  describe('nothing is read when nothing can apply, and an unreadable place fails closed', () => {
    test('gate off, or no limited add-on, reads nothing even with an address and a property on the estimate', async () => {
      const db = fakeDb(placeWorld());
      expect(await service.areaAddOnLimitRefusal(db, { estimate: second({ property_id: PROPERTY, estimate_data: storedWith(['web_sweep']) }) })).toBeNull();
      process.env.GATE_AREA_ADDONS = '';
      delete process.env.GATE_AREA_ADDONS;
      expect(await service.areaAddOnLimitRefusal(db, { estimate: second({ property_id: PROPERTY }) })).toBeNull();
      expect(await service.quoteAreaAddOnHistory(db, { entries: [{ key: 'bed_pre_emergent' }], address: '1 Test Way, Bradenton, FL 34202', requesterRole: 'admin' })).toBeUndefined();
      expect(db.calls).toEqual([]);
    });

    test('a failed property lookup is the history-unavailable refusal, with a property id and with an address alone', async () => {
      for (const estimate of [second({ property_id: PROPERTY }), second()]) {
        const broken = fakeDb(placeWorld({ customer_properties: () => { throw new Error('connection lost'); } }));
        await expect(service.assertAreaAddOnLimitsOpen(broken, { estimate, resolveCustomer: async () => null })).rejects.toMatchObject({ status: 409, code: 'AREA_ADDON_HISTORY_UNAVAILABLE' });
      }
    });
  });

  describe('the lock: two different people at one place share a key', () => {
    const recorded = async (estimate, extra = {}) => {
      const order = [];
      const trx = fakeDb(placeWorld());
      trx.raw = jest.fn(async (sql, bindings) => { order.push(String(sql).startsWith('SELECT pg_advisory') ? bindings[0] : String(sql).split(' ')[0]); return {}; });
      const wrapped = Object.assign((table) => trx(table), { isTransaction: true, raw: trx.raw });
      await service.assertAreaAddOnLimitsOpen(wrapped, { estimate, resolveCustomer: async () => null, ...extra });
      return order.filter((key) => key !== 'SAVEPOINT' && key !== 'RELEASE');
    };

    test('two customers on two property rows of one address take the same place key, in a fixed class order', async () => {
      const a = await recorded(second({ customer_id: CUSTOMER, property_id: PROPERTY, customer_phone: '+19415550142' }));
      const b = await recorded(second({ customer_id: CUSTOMER_B, property_id: PROPERTY_B, customer_phone: '+19415550199' }));
      expect(a).toEqual([`property:${PROPERTY}`, `place:${HOME_KEY}`, 'address:1testwaybradentonfl34202'].sort((x, y) => ['address', 'property', 'place'].indexOf(x.split(':')[0]) - ['address', 'property', 'place'].indexOf(y.split(':')[0])));
      expect(b).toEqual(a.map((key) => (key === `property:${PROPERTY}` ? `property:${PROPERTY_B}` : key)));
      expect(a.filter((key) => b.includes(key))).toEqual([`place:${HOME_KEY}`, 'address:1testwaybradentonfl34202'].sort((x, y) => a.indexOf(x) - a.indexOf(y)));
    });

    test('a lead with no customer and an address in another spelling shares the place key; the phone key comes first and only then', async () => {
      const lead = await recorded(second({ address: '1 TEST WAY,  Bradenton , FL 34202-1234' }));
      expect(lead[0]).toBe('phone:9415550199');
      expect(lead).toContain(`place:${HOME_KEY}`);
      const named = await recorded(second({ customer_id: CUSTOMER_B }));
      expect(named.some((key) => key.startsWith('phone:'))).toBe(false);
      expect(named).toContain(`place:${HOME_KEY}`);
    });

    test('a caller\'s verified property (the staff booking\'s) is part of the place even when the estimate names none', async () => {
      const keys = await recorded(second({ address: null, customer_phone: null }), { customerId: CUSTOMER_B, property: { property_id: PROPERTY_B } });
      expect(keys).toEqual([`place:${HOME_KEY}`]);
    });

    test('a failed place lookup under the lock is the history-unavailable refusal', async () => {
      const trx = fakeDb(placeWorld({ customer_properties: () => { throw new Error('connection lost'); } }));
      trx.raw = jest.fn(async () => ({}));
      const wrapped = Object.assign((table) => trx(table), { isTransaction: true, raw: trx.raw });
      await expect(service.assertAreaAddOnLimitsOpen(wrapped, { estimate: second({ property_id: PROPERTY }), resolveCustomer: async () => null })).rejects.toMatchObject({ code: 'AREA_ADDON_HISTORY_UNAVAILABLE' });
    });
  });

  describe('the quote steps and the job card see the place too', () => {
    const entries = [{ key: 'bed_pre_emergent', areaSqFt: 1000 }];
    const history = () => placeWorld({ property_application_history: [ledger('p-snap', 25, { customer_id: CUSTOMER_B, property_id: PROPERTY_B })] });

    test('a new lead with no customer but an address at a property with history: the admin requester sees it', async () => {
      const out = await service.quoteAreaAddOnHistory(fakeDb(history()), { entries, address: '1 Test Way, Bradenton, FL 34202', requesterRole: 'admin' });
      expect(out.byKey.bed_pre_emergent.dates).toEqual([daysBefore(25)]);
      const v1 = await service.attachQuoteAreaAddOnHistory(fakeDb(history()), { ...HOME, services: { areaAddOns: entries } }, { address: '1 Test Way, Bradenton, FL 34202' }, { requesterRole: 'admin' });
      expect(generateEstimate(v1).lineItems.find((l) => l.addOnKey === 'bed_pre_emergent')).toMatchObject({ price: null, customQuoteReason: 'area_addon_yearly_limit_reached' });
      const other = await service.quoteAreaAddOnHistory(fakeDb(history()), { entries, address: '9 Other St, Bradenton, FL 34202', requesterRole: 'admin' });
      expect(other.byKey.bed_pre_emergent.dates).toEqual([]);
    });

    test('a requester who is not an admin reads nothing for a lead, and no address reads nothing', async () => {
      for (const requesterRole of ['technician', null, undefined]) {
        const db = fakeDb(history());
        expect(await service.quoteAreaAddOnHistory(db, { entries, address: '1 Test Way, Bradenton, FL 34202', requesterRole })).toBeUndefined();
        expect(db.calls).toEqual([]);
      }
      const none = fakeDb(history());
      expect(await service.quoteAreaAddOnHistory(none, { entries, requesterRole: 'admin' })).toBeUndefined();
      expect(none.calls).toEqual([]);
    });

    test('the save reads the lead\'s address from the body, for an admin saving technician only', async () => {
      const data = { engineRequest: { options: { areaAddOns: entries } } };
      const body = { address: '1 Test Way, Bradenton, FL 34202' };
      const out = await service.quoteAreaAddOnHistoryForSave(fakeDb(history()), data, body, { technicianId: ADMIN_TECH });
      expect(out.byKey.bed_pre_emergent.dates).toEqual([daysBefore(25)]);
      expect(await service.quoteAreaAddOnHistoryForSave(fakeDb(history()), data, body, { technicianId: FIELD_TECH })).toBeUndefined();
    });

    test('a known customer\'s quote counts the other customer record at the same property', async () => {
      const out = await service.quoteAreaAddOnHistory(fakeDb(history()), { entries, customerId: CUSTOMER, propertyId: PROPERTY, requesterRole: 'admin' });
      expect(out.byKey.bed_pre_emergent.dates).toEqual([daysBefore(25)]);
    });

    test('the job card "Application N of M" line counts the application made under the other record at the property', async () => {
      const db = fakeDb(placeWorld({
        scheduled_services: [{ id: 'visit-1', customer_id: CUSTOMER, property_id: PROPERTY }],
        property_application_history: [ledger('p-arena', 90, { customer_id: CUSTOMER_B, property_id: PROPERTY_B })],
      }));
      const cards = await service.attachLimitUse([{ id: 'p-arena', rowId: 'p-arena::x', addOnKey: 'area_addon_lawn_insect_spot', name: 'x', governed: { limit: 'Label limit text.' } }], { serviceId: 'visit-1', visitDay: TODAY, dbh: db });
      expect(cards[0].governed.use).toBe(`Application 2 of 2 in 12 months; last applied ${daysBefore(90)}.`);
    });
  });
});

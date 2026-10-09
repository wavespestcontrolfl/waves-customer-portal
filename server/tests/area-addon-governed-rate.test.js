/**
 * Codex round 8 P1 on #6135: the completion form prefilled the catalog default rate for an add-on product
 * (Arena 0.29 oz, Acelepryn 0.05 fl oz per 1,000 sq ft) where the governed add-on rates are 0.147 and 0.184.
 * The governed rate is numbers in protocols.json (area_addon labelFacts.ratePer1000 and rateUnit); the schedule
 * feed carries it on every add-on of the visit; the completion keeps which add-on a row belongs to and flags a
 * row recorded above it. No database: small fakes.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/area-addon-visit-rows', () => ({ areaAddOnKeysByVisit: jest.fn() }));

const fs = require('fs');
const path = require('path');
const rows = require('../services/area-addon-visit-rows');
const governed = require('../services/area-addon-governed-rate');

const VISIT = '11111111-1111-4111-8111-111111111111';
const ARENA = 'area_addon_lawn_insect_spot';
const ACEL = 'area_addon_lawn_insect_preventive';
const SNAP = 'area_addon_bed_pre_emergent';
const SWEEP = 'area_addon_web_sweep';

// A knex-like fake: knex(table) returns a thenable chain that resolves to `tables[table]`.
function fakeKnex(tables = {}, { columns = {} } = {}) {
  const k = (table) => {
    const q = { where: () => q, whereIn: () => q, whereNotNull: () => q, select: () => q, columnInfo: async () => columns[table] || {},
      then: (res, rej) => (tables[table] instanceof Error ? Promise.reject(tables[table]) : Promise.resolve(tables[table] || [])).then(res, rej) };
    return q;
  };
  return k;
}

describe('the governed rate, one place', () => {
  test('each chemical add-on resolves its numeric rate by catalog key', () => {
    expect(governed.governedRateFor(ARENA)).toEqual({ ratePer1000: 0.147, rateUnit: 'oz', productName: 'Arena 50 WDG' });
    expect(governed.governedRateFor(ACEL)).toEqual({ ratePer1000: 0.184, rateUnit: 'fl_oz', productName: 'Acelepryn Insecticide' });
    expect(governed.governedRateFor(SNAP)).toEqual({ ratePer1000: 3.45, rateUnit: 'lb', productName: 'Snapshot 2.5TG' });
    expect(governed.governedRateFor('area_addon_fire_ant_yard')).toEqual({ ratePer1000: 2, rateUnit: 'lb', productName: 'Topchoice Granular Insecticide' });
    expect(governed.governedRateFor('area_addon_hardscape_weed')).toEqual({ ratePer1000: 16, rateUnit: 'fl_oz', productName: 'Roundup QuikPro SC' });
    expect(governed.governedRateFor(SWEEP)).toBeNull();
    expect(governed.isGoverned(ARENA)).toBe(true);
    expect(governed.isGoverned(SWEEP)).toBe(false);
  });

  test('feedRate holds the rate back for the wrong grass or an unverified label, and says why', () => {
    const verified = new Set(['arena 50 wdg', 'acelepryn insecticide']);
    expect(governed.feedRate(ARENA, { grassType: 'st_augustine', verified })).toMatchObject({ ratePer1000: 0.147, rateUnit: 'oz', withheld: null });
    expect(governed.feedRate(ARENA, { grassType: 'bahia', verified }).withheld).toBe('The rate is for St. Augustine only and the grass on the estimate is not.');
    expect(governed.feedRate(ARENA, { grassType: null, verified }).withheld).toMatch(/St\. Augustine only/);
    expect(governed.feedRate(ACEL, { verified }).withheld).toBeNull();
    expect(governed.feedRate(SNAP, { verified }).withheld).toBe('The label rate is not verified yet.');
    // The label check failing (null) holds every rate back.
    expect(governed.feedRate(ACEL, { verified: null }).withheld).toBe('The label rate is not verified yet.');
    expect(governed.feedRate(SWEEP, { verified })).toBeNull();
  });
});

describe('the schedule feed', () => {
  test('every attached add-on carries its governed rate, the visit that IS an add-on carries its own, in ONE catalog read', async () => {
    const calls = [];
    const knex = (table) => { calls.push(table); return fakeKnex({ products_catalog: [{ name: 'Arena 50 WDG' }] })(table); };
    const byVisit = new Map([[VISIT, [{ key: ACEL, name: 'Yearly Lawn Insect Preventive' }, { key: SWEEP, name: 'Web Sweep' }]]]);
    const ownRow = { id: 'v-own', service_key_snapshot: ARENA, area_addon_scope: JSON.stringify({ grassType: 'st_augustine' }) };
    const own = await governed.areaAddOnFeed(knex, byVisit, [{ id: VISIT }, ownRow]);
    expect(calls).toEqual(['products_catalog']);
    const [acel, sweep] = byVisit.get(VISIT);
    // Arena is verified; Acelepryn is not in the verified set, so its rate is held back (not the catalog default).
    expect(acel.governed).toMatchObject({ ratePer1000: 0.184, rateUnit: 'fl_oz', productName: 'Acelepryn Insecticide', withheld: 'The label rate is not verified yet.' });
    expect(sweep.governed).toBeUndefined();
    expect(own.get('v-own')).toEqual({ key: ARENA, governed: { ratePer1000: 0.147, rateUnit: 'oz', productName: 'Arena 50 WDG', withheld: null } });
    expect(own.has(VISIT)).toBe(false);
  });

  test('no chemical add-on on any visit: no query at all, and nothing is added', async () => {
    const calls = [];
    const knex = (table) => { calls.push(table); return fakeKnex()(table); };
    const own = await governed.areaAddOnFeed(knex, new Map(), [{ id: VISIT, service_key_snapshot: 'pest_general_quarterly' }, { id: 'x' }]);
    expect(own.size).toBe(0);
    expect(calls).toEqual([]);
  });

  test('a failed label read never fails the feed: every rate is held back', async () => {
    const own = await governed.areaAddOnFeed(fakeKnex({ products_catalog: new Error('connection lost') }), new Map(), [{ id: 'v', service_key_snapshot: ACEL }]);
    expect(own.get('v').governed.withheld).toBe('The label rate is not verified yet.');
  });

  test('the route carries it on both feed payloads and only when the visit has an add-on', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    expect(src.match(/areaAddOnOwn: projectCompletionContext\.areaAddOnOwn,/g)).toHaveLength(2);
    expect(src).toContain('...(own ? { areaAddOnOwn: own } : {})');
  });
});

describe('which add-on each application row belongs to', () => {
  beforeEach(() => rows.areaAddOnKeysByVisit.mockReset());

  test('a tag is kept only for an add-on the visit carries; a forged or unknown tag is dropped', async () => {
    rows.areaAddOnKeysByVisit.mockResolvedValue(new Map([[VISIT, [ARENA, SWEEP]]]));
    const tags = await governed.resolveApplicationAddOnTags(fakeKnex(), { id: VISIT, service_key_snapshot: 'pest_general_quarterly' }, [
      { productId: 'p-arena', areaAddOnKey: ARENA },
      { productId: 'p-forged', areaAddOnKey: SNAP },
      { productId: 'p-sweep', areaAddOnKey: SWEEP },
      { productId: 'p-junk', areaAddOnKey: { $ne: 1 } },
      { productId: 'p-plain' },
    ]);
    expect([...tags]).toEqual([[`p-arena|${ARENA}`, ARENA]]);
  });

  test('on a visit whose own service is a chemical add-on, an untagged row is that add-on\'s and a forged tag falls back to it', async () => {
    rows.areaAddOnKeysByVisit.mockResolvedValue(new Map([[VISIT, [SNAP]]]));
    const tags = await governed.resolveApplicationAddOnTags(fakeKnex(), { id: VISIT, service_key_snapshot: ARENA }, [
      { productId: 'p-own' }, { productId: 'p-attached', areaAddOnKey: SNAP }, { productId: 'p-forged', areaAddOnKey: 'area_addon_fire_ant_yard' },
    ]);
    expect(Object.fromEntries(tags)).toEqual({ 'p-own|': ARENA, [`p-attached|${SNAP}`]: SNAP, 'p-forged|area_addon_fire_ant_yard': ARENA });
  });

  test('the own add-on is also read from the sold scope when the snapshot is missing', async () => {
    rows.areaAddOnKeysByVisit.mockResolvedValue(new Map());
    const tags = await governed.resolveApplicationAddOnTags(fakeKnex(), { id: VISIT, area_addon_scope: { catalogServiceKey: ACEL } }, [{ productId: 'p' }]);
    expect(Object.fromEntries(tags)).toEqual({ 'p|': ACEL });
  });

  test('an ordinary completion (no add-on claimed, not an add-on visit) runs no query at all', async () => {
    const tags = await governed.resolveApplicationAddOnTags(fakeKnex(), { id: VISIT, service_key_snapshot: 'pest_general_quarterly' }, [{ productId: 'p' }, null, { productId: 'q', areaAddOnKey: 5 }]);
    expect(tags.size).toBe(0);
    expect(rows.areaAddOnKeysByVisit).not.toHaveBeenCalled();
  });

  test('a host visit with no chemical add-on, and a visit whose read fails, tag nothing (a completion never fails for it)', async () => {
    rows.areaAddOnKeysByVisit.mockResolvedValue(new Map());
    expect((await governed.resolveApplicationAddOnTags(fakeKnex(), { id: VISIT, service_key_snapshot: 'lawn_standard' }, [{ productId: 'p', areaAddOnKey: ARENA }])).size).toBe(0);
    rows.areaAddOnKeysByVisit.mockRejectedValue(new Error('connection lost'));
    expect((await governed.resolveApplicationAddOnTags(fakeKnex(), { id: VISIT, service_key_snapshot: ARENA }, [{ productId: 'p' }])).size).toBe(0);
  });

  test('the column is written only when it exists and the row has a tag', () => {
    const tags = new Map([[`p|${ARENA}`, ARENA]]);
    expect(governed.addOnProductColumns({ area_addon_key: {} }, tags, { productId: 'p', areaAddOnKey: ARENA })).toEqual({ area_addon_key: ARENA });
    expect(governed.addOnProductColumns({}, tags, { productId: 'p', areaAddOnKey: ARENA })).toEqual({});
    expect(governed.addOnProductColumns({ area_addon_key: {} }, tags, { productId: 'other' })).toEqual({});
    // The host's row of the SAME product is another row: no tag.
    expect(governed.addOnProductColumns({ area_addon_key: {} }, tags, { productId: 'p' })).toEqual({});
  });

  test('a host row and an add-on row of the SAME product are two rows with two identities (Snapshot on a Tree & Shrub visit plus the bed add-on)', async () => {
    rows.areaAddOnKeysByVisit.mockResolvedValue(new Map([[VISIT, [SNAP]]]));
    const submitted = [{ productId: 'p-snap' }, { productId: 'p-snap', areaAddOnKey: SNAP }];
    const tags = await governed.resolveApplicationAddOnTags(fakeKnex(), { id: VISIT, service_key_snapshot: 'ts_standard_6x' }, submitted);
    expect(Object.fromEntries(tags)).toEqual({ [`p-snap|${SNAP}`]: SNAP });
    const identities = submitted.map((p) => governed.productRowIdentity(tags, p));
    expect(identities).toEqual(['p-snap|', `p-snap|${SNAP}`]);
    expect(new Set(identities).size).toBe(2);
    // Two untagged rows of one product, or two rows tagged for the same add-on, are the same row.
    const same = [{ productId: 'p-snap' }, { productId: 'p-snap' }].map((p) => governed.productRowIdentity(tags, p));
    expect(new Set(same).size).toBe(1);
    // On a visit whose own service is the add-on, an untagged row and a row tagged with that same add-on are one row.
    rows.areaAddOnKeysByVisit.mockResolvedValue(new Map());
    const ownTags = await governed.resolveApplicationAddOnTags(fakeKnex(), { id: VISIT, service_key_snapshot: SNAP }, [{ productId: 'p-snap' }, { productId: 'p-snap', areaAddOnKey: SNAP }]);
    expect(new Set([{ productId: 'p-snap' }, { productId: 'p-snap', areaAddOnKey: SNAP }].map((p) => governed.productRowIdentity(ownTags, p))).size).toBe(1);
  });

  test('the completion saves one row per identity, not per product', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');
    expect(src).toContain('const rowIdentity = areaAddOnGovernedRate.productRowIdentity(addOnTags, p);');
    expect(src).toContain('if (seenProductIds.has(rowIdentity)) continue;');
    expect(src).not.toContain('seenProductIds.has(p.productId)');
  });
});

// Codex round 11 P2 on #6135: a technician could POST the right productId and a valid areaAddOnKey with no rate, amount or
// treated area; the tag was saved, closeout counted the row, and the FDACS ledger held a null dose. A tagged row now
// carries its actuals or the completion is a 400, and the total is filled from the rate and the area.
describe('a row tagged to a chemical add-on must carry its application actuals', () => {
  const tagOf = (p, key = ARENA) => new Map([[governed.productRowKey(p), key]]);
  const names = fakeKnex({ services: [{ service_key: ARENA, name: 'Lawn Insect Spot Treatment' }] });
  const full = (over = {}) => ({ productId: 'p-arena', name: 'Arena 50 WDG', areaAddOnKey: ARENA, rate: '0.147', rateUnit: 'oz', areaValue: '2000', areaUnit: 'sqft', ...over });
  const check = (p, key) => governed.requireAddOnActuals(names, [p], tagOf(p, key));

  test('a row with every actual passes, and a missing total is filled from the rate and the area', async () => {
    const p = full();
    expect(await check(p)).toBeNull();
    expect(p).toMatchObject({ totalAmount: 0.294, amountUnit: 'oz' });
    // A total the client sent is kept, whatever the rate and area say.
    const sent = full({ totalAmount: '0.3', amountUnit: 'oz' });
    expect(await check(sent)).toBeNull();
    expect(sent).toMatchObject({ totalAmount: '0.3', amountUnit: 'oz' });
    // A per-acre rate: 160 lb per acre over 43,560 sq ft is 160 lb; a per-1,000-sq-ft unit written out is the same as a bare one.
    const acre = full({ rate: 160, rateUnit: 'lb/acre', areaValue: 43560 });
    expect(await check(acre)).toBeNull();
    expect(acre).toMatchObject({ totalAmount: 160, amountUnit: 'lb' });
    const written = full({ rate: 3.45, rateUnit: 'lb/1000sf', areaValue: 1000 });
    expect(await check(written)).toBeNull();
    expect(written).toMatchObject({ totalAmount: 3.45, amountUnit: 'lb' });
  });

  test.each([
    ['no rate', { rate: '' }, 'application rate'],
    ['a zero rate', { rate: 0 }, 'application rate'],
    ['a negative rate', { rate: '-1' }, 'application rate'],
    ['a rate with no unit', { rateUnit: '' }, 'rate unit'],
    ['no treated area', { areaValue: '' }, 'treated square feet'],
    ['a zero area', { areaValue: 0 }, 'treated square feet'],
    ['an area in the wrong unit', { areaUnit: 'linear_ft' }, 'treated square feet'],
    ['an area with no unit', { areaUnit: undefined }, 'treated square feet'],
  ])('%s is a 400 naming the add-on and the field', async (_label, over, field) => {
    const out = await check(full(over));
    expect(out).toMatchObject({ code: 'area_addon_actuals_required', addOnKey: ARENA });
    expect(out.error).toBe(`Lawn Insect Spot Treatment add-on: enter the ${field} for Arena 50 WDG, then complete the visit.`);
  });

  test('every missing field is named, and a mix-concentration rate with no total asks for the total', async () => {
    expect((await check(full({ rate: '', areaValue: '' }))).error).toBe('Lawn Insect Spot Treatment add-on: enter the application rate and treated square feet for Arena 50 WDG, then complete the visit.');
    // oz/gal has no area to multiply by: the total must come from the technician.
    expect((await check(full({ rateUnit: 'oz/gal' }))).error).toBe('Lawn Insect Spot Treatment add-on: enter the total amount for Arena 50 WDG, then complete the visit.');
    expect(await check(full({ rateUnit: 'oz/gal', totalAmount: 4 }))).toBeNull();
  });

  test('an untagged row, a row the visit does not carry, and an ordinary completion are not checked and run no query', async () => {
    const never = () => { throw new Error('must not query'); };
    const bare = { productId: 'p', rate: '', areaValue: '' };
    expect(await governed.requireAddOnActuals(never, [bare], new Map())).toBeNull();
    expect(await governed.requireAddOnActuals(never, [bare], tagOf({ productId: 'other' }))).toBeNull();
    expect(await governed.requireAddOnActuals(never, undefined, tagOf(bare))).toBeNull();
    expect(await governed.requireAddOnActuals(never, [full()], new Map())).toBeNull();
  });

  test('the host\'s untagged row of the same product is not an add-on row', async () => {
    const host = { productId: 'p-snap', rate: '', areaValue: '' };
    const addOn = { productId: 'p-snap', areaAddOnKey: SNAP, name: 'Snapshot 2.5TG', rate: 3.45, rateUnit: 'lb', areaValue: 1000, areaUnit: 'sqft' };
    expect(await governed.requireAddOnActuals(names, [host, addOn], tagOf(addOn, SNAP))).toBeNull();
    expect(host.totalAmount).toBeUndefined();
    expect(addOn.totalAmount).toBe(3.45);
  });

  test('a failed name lookup still names the add-on', async () => {
    const out = await governed.requireAddOnActuals(fakeKnex({ services: new Error('offline') }), [full({ rate: '' })], tagOf(full()));
    expect(out.error).toBe('Lawn Insect Spot add-on: enter the application rate for Arena 50 WDG, then complete the visit.');
  });

  test('the completion refuses a fresh closeout before any write, skips an incomplete visit, and the office alert reads the new finding', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');
    const refuse = src.indexOf('await areaAddOnGovernedRate.requireAddOnActuals(db, products, addOnTags)');
    expect(refuse).toBeGreaterThan(src.indexOf('areaAddOnGovernedRate.resolveApplicationAddOnTags(db, svc, products)'));
    expect(refuse).toBeLessThan(src.indexOf('const rowIdentity = areaAddOnGovernedRate.productRowIdentity(addOnTags, p);'));
    expect(src.slice(refuse - 120, refuse)).toContain("claim.action === 'proceed' && !isIncompleteVisit");
    expect(src).toContain('[areaAddOnGovernedRate.UNCHECKED_RATE_LIMIT_TYPE]: areaAddOnGovernedRate.uncheckedRateSentence');
  });
});

describe('a row recorded above the governed rate is flagged, never blocked', () => {
  const row = (over) => ({ product_id: 'p', product_name: 'Arena 50 WDG', application_rate: 0.29, rate_unit: 'oz', area_addon_key: ARENA, ...over });

  test('the catalog default rate (Arena 0.29 oz) and the catalog ceiling (Acelepryn 0.37 fl oz) are above the governed rates', () => {
    expect(governed.rateFindings([row({})])).toEqual([expect.objectContaining({
      code: 'application_limit_exceeded', limitType: 'area_addon_governed_rate', current: 0.29, max: 0.147, productName: 'Arena 50 WDG',
      message: 'Recorded. The office will review: Arena 50 WDG was recorded at 0.29 oz per 1,000 sq ft, above the governed add-on rate of 0.147.',
    })]);
    // The catalog's label range for Acelepryn tops out at 0.37 fl oz: still above the governed 0.184.
    expect(governed.rateFindings([row({ product_name: 'Acelepryn Insecticide', application_rate: 0.37, rate_unit: 'fl oz', area_addon_key: ACEL })])).toHaveLength(1);
  });

  test('the governed rate itself, and below it, are not flagged', () => {
    expect(governed.rateFindings([row({ application_rate: 0.147 }), row({ application_rate: 0.1 })])).toEqual([]);
  });

  // Codex round 11 P1: Number(null) is 0 and a different valid unit fell through the comparison: no finding, no office alert.
  test('a blank, zero or negative rate on the governed product is a finding, never a silent pass', () => {
    for (const rate of [null, undefined, '', 0, '0', -0.2]) {
      expect(governed.rateFindings([row({ application_rate: rate })])).toEqual([expect.objectContaining({
        code: 'application_limit_exceeded', limitType: 'area_addon_rate_unchecked', reason: 'rate_missing', productName: 'Arena 50 WDG', max: '0.147 oz',
        message: 'Recorded. The office will review: Arena 50 WDG was recorded for an add-on with no application rate, so it could not be held to the governed rate of 0.147 oz.',
      })]);
    }
  });

  test('a rate in a convertible unit is compared in the governed unit (lb to oz, g to oz, gal to fl oz, per acre)', () => {
    // Arena is governed in oz: 0.01 lb = 0.16 oz is over 0.147; 0.009 lb = 0.144 oz is under.
    expect(governed.rateFindings([row({ application_rate: 0.01, rate_unit: 'lb' })])).toEqual([expect.objectContaining({
      limitType: 'area_addon_governed_rate', current: 0.16, max: 0.147,
      message: 'Recorded. The office will review: Arena 50 WDG was recorded at 0.01 lb per 1,000 sq ft (0.16 oz per 1,000 sq ft), above the governed add-on rate of 0.147.',
    })]);
    expect(governed.rateFindings([row({ application_rate: 0.009, rate_unit: 'lb' })])).toEqual([]);
    // 5 g = 0.1764 oz is over; 4 g = 0.1411 oz is under.
    expect(governed.rateFindings([row({ application_rate: 5, rate_unit: 'g' })])).toHaveLength(1);
    expect(governed.rateFindings([row({ application_rate: 4, rate_unit: 'g' })])).toEqual([]);
    // Acelepryn is governed in fl oz: 0.002 gal = 0.256 fl oz is over; 0.001 gal = 0.128 fl oz is under.
    const acel = { product_name: 'Acelepryn Insecticide', area_addon_key: ACEL };
    expect(governed.rateFindings([row({ ...acel, application_rate: 0.002, rate_unit: 'gal' })])).toEqual([expect.objectContaining({ limitType: 'area_addon_governed_rate' })]);
    expect(governed.rateFindings([row({ ...acel, application_rate: 0.001, rate_unit: 'gal' })])).toEqual([]);
    // Snapshot is governed in lb: 60 oz = 3.75 lb is over 3.45, 50 oz = 3.125 lb is under.
    const snap = { product_name: 'Snapshot 2.5TG', area_addon_key: SNAP };
    expect(governed.rateFindings([row({ ...snap, application_rate: 60, rate_unit: 'oz' })])).toHaveLength(1);
    expect(governed.rateFindings([row({ ...snap, application_rate: 50, rate_unit: 'oz' })])).toEqual([]);
    // The same rate written per 1,000 sq ft ('lb/1000sf') or per acre ('lb/acre': 160 lb per acre = 3.67 lb per 1,000 sq ft, over).
    expect(governed.rateFindings([row({ ...snap, application_rate: 3.5, rate_unit: 'lb/1000sf' })])).toHaveLength(1);
    expect(governed.rateFindings([row({ ...snap, application_rate: 3.4, rate_unit: 'lb/1000sf' })])).toEqual([]);
    expect(governed.rateFindings([row({ ...snap, application_rate: 160, rate_unit: 'lb/acre' })])).toEqual([expect.objectContaining({
      limitType: 'area_addon_governed_rate',
      message: expect.stringContaining('was recorded at 160 lb per acre (3.6731 lb per 1,000 sq ft)'),
    })]);
    expect(governed.rateFindings([row({ ...snap, application_rate: 140, rate_unit: 'lb/acre' })])).toEqual([]);
  });

  test('a unit with no safe conversion is a finding naming both units, never a silent pass', () => {
    const unchecked = (over) => governed.rateFindings([row(over)]);
    // oz is weight or fluid: against fl oz it is not safe. Arena (oz) recorded in fl oz, Acelepryn (fl oz) recorded in oz.
    expect(unchecked({ rate_unit: 'fl_oz' })).toEqual([expect.objectContaining({
      limitType: 'area_addon_rate_unchecked', reason: 'unit_not_comparable', current: 'fl oz',
      message: 'Recorded. The office will review: Arena 50 WDG was recorded in fl oz, and the governed add-on rate is in oz.',
    })]);
    expect(governed.rateFindings([row({ product_name: 'Acelepryn Insecticide', area_addon_key: ACEL, rate_unit: 'oz', application_rate: 0.1 })])).toEqual([
      expect.objectContaining({ reason: 'unit_not_comparable', message: expect.stringContaining('recorded in oz, and the governed add-on rate is in fl oz') }),
    ]);
    // A mix concentration, a count, or no unit at all.
    expect(unchecked({ rate_unit: 'oz/gal' })[0]).toMatchObject({ reason: 'unit_not_comparable', current: 'oz/gal' });
    expect(unchecked({ rate_unit: 'each' })[0]).toMatchObject({ reason: 'unit_not_comparable' });
    expect(unchecked({ rate_unit: null })).toEqual([expect.objectContaining({
      reason: 'unit_not_comparable', current: null,
      message: 'Recorded. The office will review: Arena 50 WDG was recorded with no unit, and the governed add-on rate is in oz.',
    })]);
    // Weight against volume is not a conversion either (a gallon of Snapshot is not a pound).
    expect(governed.rateFindings([row({ product_name: 'Snapshot 2.5TG', area_addon_key: SNAP, rate_unit: 'gal' })])[0]).toMatchObject({ reason: 'unit_not_comparable' });
    // An untagged row, or a tag with no governed rate (the sweep), is not an add-on row at all.
    expect(governed.rateFindings([row({ area_addon_key: SWEEP }), row({ area_addon_key: 'pest_general_quarterly' })])).toEqual([]);
  });

  test('a tagged row recorded with a product other than the governed one is flagged (the add-on is governed to ONE product)', () => {
    const findings = governed.rateFindings([row({ product_name: 'Some other product', product_id: 'p-other' })]);
    expect(findings).toEqual([expect.objectContaining({
      code: 'application_limit_exceeded', limitType: 'area_addon_wrong_product', productName: 'Some other product', current: 'Some other product', max: 'Arena 50 WDG',
      message: 'Recorded. The office will review: Some other product was recorded for an add-on that uses Arena 50 WDG.',
    })]);
    // A catalog row the matcher resolved from the protocol's hint is the governed product, whatever its name says.
    expect(governed.rateFindings([row({ product_name: 'Arena 50 WDG Insecticide', product_id: 'p-arena', application_rate: 0.147 })], new Map([[ARENA, 'p-arena']]))).toEqual([]);
    expect(governed.rateFindings([row({ product_id: 'p-other', application_rate: 0.147 })], new Map([[ARENA, 'p-arena']]))).toHaveLength(1);
    // The wrong product is not ALSO compared with the rate.
    expect(governed.rateFindings([row({ product_name: 'Some other product', application_rate: 5 })])).toHaveLength(1);
  });

  test('the completion check merges the finding into the limit advisory, tells the office once, and never throws', async () => {
    const notify = jest.fn(async () => {});
    const db = fakeKnex({ service_products: [row({})] }, { columns: { service_products: { area_addon_key: {} } } });
    const advisory = { advisory: true, blocks: [{ code: 'application_limit_exceeded', message: 'earlier', productId: 'q' }] };
    const out = await governed.flagRatesAboveGoverned({ svc: { id: VISIT }, record: { id: 'r' }, database: db, advisory, notify });
    expect(out.advisory).toBe(true);
    expect(out.blocks.map((b) => b.message)).toEqual(['earlier', expect.stringContaining('above the governed add-on rate of 0.147')]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].findings).toHaveLength(1);

    // Nothing over, no column yet, no record, or a failed read: the advisory comes back as it was.
    const clean = fakeKnex({ service_products: [row({ application_rate: 0.147 })] }, { columns: { service_products: { area_addon_key: {} } } });
    expect(await governed.flagRatesAboveGoverned({ svc: {}, record: { id: 'r' }, database: clean, advisory, notify })).toBe(advisory);
    expect(await governed.flagRatesAboveGoverned({ svc: {}, record: { id: 'r' }, database: fakeKnex({ service_products: [row({})] }), advisory, notify })).toBe(advisory);
    expect(await governed.flagRatesAboveGoverned({ svc: {}, record: null, database: db, advisory, notify })).toBe(advisory);
    const broken = fakeKnex({ service_products: new Error('connection lost') }, { columns: { service_products: { area_addon_key: {} } } });
    expect(await governed.flagRatesAboveGoverned({ svc: {}, record: { id: 'r' }, database: broken, advisory, notify })).toBe(advisory);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('the completion wires it: the tags before the insert, the column on the row, the check after the limit findings', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');
    const tags = src.indexOf('areaAddOnGovernedRate.resolveApplicationAddOnTags(db, svc, products)');
    const insert = src.indexOf('Object.assign(serviceProductInsert, areaAddOnGovernedRate.addOnProductColumns(serviceProductCols, addOnTags, p));');
    const check = src.indexOf('areaAddOnGovernedRate.flagRatesAboveGoverned({');
    const limits = src.indexOf('await notifyOfficeOfLimitFindings({ svc, record, findings: limitFindings });');
    expect(tags).toBeGreaterThan(0);
    expect(insert).toBeGreaterThan(tags);
    expect(limits).toBeGreaterThan(insert);
    expect(check).toBeGreaterThan(limits);
    expect(src).toContain('notify: notifyOfficeOfLimitFindings');
  });
});

describe('the job card never prints the form\'s numbers', () => {
  test('governedForCard drops ratePer1000 and rateUnit from the card text', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'job-card.js'), 'utf8');
    expect(src).toContain('ratePer1000: _ratePer1000, rateUnit: _rateUnit, ...facts');
  });
});

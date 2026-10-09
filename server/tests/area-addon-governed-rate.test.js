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
    expect([...tags]).toEqual([['p-arena', ARENA]]);
  });

  test('on a visit whose own service is a chemical add-on, an untagged row is that add-on\'s and a forged tag falls back to it', async () => {
    rows.areaAddOnKeysByVisit.mockResolvedValue(new Map([[VISIT, [SNAP]]]));
    const tags = await governed.resolveApplicationAddOnTags(fakeKnex(), { id: VISIT, service_key_snapshot: ARENA }, [
      { productId: 'p-own' }, { productId: 'p-attached', areaAddOnKey: SNAP }, { productId: 'p-forged', areaAddOnKey: 'area_addon_fire_ant_yard' },
    ]);
    expect(Object.fromEntries(tags)).toEqual({ 'p-own': ARENA, 'p-attached': SNAP, 'p-forged': ARENA });
  });

  test('the own add-on is also read from the sold scope when the snapshot is missing', async () => {
    rows.areaAddOnKeysByVisit.mockResolvedValue(new Map());
    const tags = await governed.resolveApplicationAddOnTags(fakeKnex(), { id: VISIT, area_addon_scope: { catalogServiceKey: ACEL } }, [{ productId: 'p' }]);
    expect(Object.fromEntries(tags)).toEqual({ p: ACEL });
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
    const tags = new Map([['p', ARENA]]);
    expect(governed.addOnProductColumns({ area_addon_key: {} }, tags, { productId: 'p' })).toEqual({ area_addon_key: ARENA });
    expect(governed.addOnProductColumns({}, tags, { productId: 'p' })).toEqual({});
    expect(governed.addOnProductColumns({ area_addon_key: {} }, tags, { productId: 'other' })).toEqual({});
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
    expect(governed.rateFindings([row({ application_rate: 0.147 }), row({ application_rate: 0.1 }), row({ application_rate: null })])).toEqual([]);
  });

  test('only the governed product in the governed unit can be compared: another product or unit is not judged', () => {
    expect(governed.rateFindings([row({ product_name: 'Some other product' }), row({ rate_unit: 'lb' }), row({ rate_unit: null })])).toEqual([]);
    // An untagged row, or a tag with no governed rate (the sweep), is not an add-on row at all.
    expect(governed.rateFindings([row({ area_addon_key: SWEEP }), row({ area_addon_key: 'pest_general_quarterly' })])).toEqual([]);
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

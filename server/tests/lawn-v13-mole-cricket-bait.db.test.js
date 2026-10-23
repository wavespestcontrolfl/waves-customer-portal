// Lawn protocol v13 research lines (owner 2026-10-23, "do whatever is going to make the grass look its best, based on the
// research we did"): mole cricket nymph bait (Advion Insect Granule, June and the July scout visit, migrations 20261023140000
// and 20261023141000) and the Group 11 stacking fix (October large patch is Velista alone, December curative is Velista, on a
// lawn that also has take-all mapped). Synthetic data only.
//
// Pinned: the recipe lines on all three tracks; the catalog spec and its watering rule (a 72-hour hold, valid, in the watering
// coverage fixture, and a customer text that goes out); the guide skips the Group 11 large patch row when take-all is mapped;
// the catalog insert throws on ANY match and writes nothing; up, down, up through PostgreSQL; down is all or nothing.
const { createLawnHistoryDb } = require('./helpers/lawn-history-db');
const v13Recipe = require('../config/lawn-protocol-v13.json');
const catalogMigration = require('../models/migrations/20261023140000_lawn_v13_advion_insect_granule');
const rowsMigration = require('../models/migrations/20261023141000_lawn_v13_mole_cricket_bait_staged_rows');
const staged = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
const stampMigration = require('../models/migrations/20261023142000_lawn_v13_advion_label_verified');
const followMigration = require('../models/migrations/20261023143000_lawn_v13_advion_followups');
const { validateRule, rulesForTargets } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
const { approvedReportProductFacts } = require('../services/service-report/report-data');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const NAME = catalogMigration.NAME;
const N = staged.NAMES;
const V13 = staged.V13_VERSION;
const W = rowsMigration.WINDOWS;
const KEYS = ['fixture_mc_a', 'fixture_mc_b'];
const TRACKS = Object.keys(v13Recipe);
const visit = (grass, month) => v13Recipe[grass].visits.find((v) => v.month === month);
const lines = (text) => String(text || '').split('\n');
const lineFor = (text, name) => lines(text).find((line) => line.startsWith(`${name} — `));

describe('recipe: mole cricket nymphs move to June and the July scout visit, with Advion Insect Granule', () => {
  test.each(TRACKS)('%s: June and July carry the Advion line with the label rules; August and the notes no longer send nymphs to Talak', (grass) => {
    for (const month of ['Jun', 'Jul']) {
      const advion = lineFor(visit(grass, month).secondary, NAME);
      expect(advion).toMatch(/mole cricket nymph spots on the tunnel areas, 3 lb per 1,000 sq ft of treated area by hand shaker \(bait, not a whole-lawn tool\)/);
      expect(advion).toMatch(/soil dry: water the spot lightly before/);
      expect(advion).toMatch(/apply late in the day to dry grass/);
      expect(advion).toMatch(/then no irrigation or rain-dependent watering for 3 days/);
    }
    expect(lineFor(visit(grass, 'Jun').secondary, NAME)).toMatch(/put on after the micronutrient pass has dried/);
    expect(visit(grass, 'Jun').notes).toMatch(/Advion bait goes on after the micronutrient pass has dried/);
    expect(lineFor(visit(grass, 'Jul').secondary, NAME)).toMatch(/new tunnel areas that were not baited in June \(once per spot per year; label yearly maximum 4\.6 lb per 1,000 sq ft\)/);
    expect(JSON.stringify(v13Recipe)).not.toMatch(/1\.6 lb/);
    // Acelepryn is the second product: watered in (the opposite of the Advion direction), June and July.
    expect(lineFor(visit(grass, 'Jun').secondary, N.ACE)).toMatch(/mole cricket nymph spots, second product after Advion, label rate, watered in right after application/);
    // July's Acelepryn line stays the caterpillar use (its row carries the 24-hour hold); mole crickets are June's offer, with their own staged row.
    expect(lineFor(visit(grass, 'Jul').secondary, N.ACE)).not.toMatch(/mole cricket/);
    // Talak stays where it belongs (chinch bugs, caterpillars) and is gone as the nymph product.
    expect(lineFor(visit(grass, 'Jul').secondary, N.TAL)).toBe(`${N.TAL} — bifenthrin for chinch bugs, second product after Arena, or for caterpillars if Acelepryn does not hold at the 7-day recheck; delay watering 24 hours`);
    expect(lineFor(visit(grass, 'Aug').secondary, N.TAL)).toBeUndefined();
    expect(visit(grass, 'Aug').notes).toMatch(/Mole crickets seen: note them for Dylox 6\.2 G on the next spreader visit/);
    expect(visit(grass, 'Aug').notes).not.toMatch(/Talak/);
    expect(lineFor(visit(grass, 'Oct').secondary, N.DYL)).toBe(`${N.DYL} — grubs or mole crickets, spreader visit only, water in`);
    const notes = v13Recipe[grass].notes.join('\n');
    expect(notes).toMatch(/Mole cricket nymphs, June and the July scout visit/);
    expect(notes).toMatch(/Advion Insect Granule \(indoxacarb, Group 22A\) on the tunnel areas, 3 lb per 1,000 sq ft of treated area by hand shaker/);
    expect(notes).toMatch(/so the one-tool rule holds/);
    expect(notes).toMatch(/Label yearly maximum: 4\.6 lb per 1,000 sq ft, so Advion goes on a spot once a year, at 3 lb\. The July visit is for new tunnel areas that were not baited in June\./);
    expect(notes).toMatch(/the opposite of Acelepryn, which is watered in/);
    expect(notes).toMatch(/Fall adults and bigger mole crickets go to Dylox 6\.2 G/);
    expect(notes).not.toMatch(/Mole cricket nymphs, July and August/);
    const safety = v13Recipe[grass].safety_rules.join('\n');
    expect(safety).toMatch(/Bifenthrin \(Atticus Talak 7\.9 F\): delay watering 24 hours\.(\n|$)/);
    expect(safety).not.toMatch(/waters it in right after application with the hose/);
    expect(safety).toMatch(/Advion Insect Granule \(mole cricket bait, indoxacarb, label EPA Reg\. No\. 100-1483\)/);
    expect(safety).toMatch(/A spot is baited once a year, at 3 lb; label yearly maximum 4\.6 lb per 1,000 sq ft/);
  });

  test('the notes keep one whole-lawn tool per visit: the bait is a spot tool and no month lists it as a primary', () => {
    for (const grass of TRACKS) {
      expect(v13Recipe[grass].notes[1]).toBe('One whole-lawn tool per visit: hose (110-gal skid tank and reel) or spreader, plus backpack spots.');
      for (const v of v13Recipe[grass].visits) expect(String(v.primary)).not.toMatch(/Advion/);
    }
  });
});

describe('recipe: Group 11 stacking (Headway label: no more than 2 consecutive QoI applications)', () => {
  test.each(TRACKS)('%s: October large patch is Velista alone on a take-all lawn; December is Velista; large patch alone keeps Artavia then Velista', (grass) => {
    const oct = visit(grass, 'Oct').secondary;
    expect(lineFor(oct, N.ART)).toMatch(/mapped large patch with Velista at 2 gal per 1,000 sq ft, only on a lawn mapped for large patch alone; a lawn also mapped for take-all had Artavia in September and gets Headway today/);
    expect(lineFor(oct, N.VEL)).toMatch(/^Velista — mapped large patch at 2 gal per 1,000 sq ft, with Artavia on a lawn mapped for large patch alone, and alone on a lawn also mapped for take-all; fairy ring/);
    expect(lineFor(oct, 'Headway Fungicide')).toMatch(/mapped take-all areas, second fall application/);
    const dec = visit(grass, 'Dec').secondary;
    expect(lineFor(dec, N.VEL)).toMatch(/active large patch, mapped areas, on a lawn also mapped for take-all/);
    expect(lineFor(dec, N.ART)).toBe(`${N.ART} — active large patch, mapped areas, on a lawn mapped for large patch alone`);
    expect(lines(dec).findIndex((line) => line.startsWith('Velista')) ).toBeLessThan(lines(dec).findIndex((line) => line.startsWith('Artavia')));
    const notes = v13Recipe[grass].notes.join('\n');
    expect(notes).toMatch(/Large patch: Artavia, then Velista\./);
    expect(notes).toMatch(/its October large patch pass is Velista alone and its December curative is Velista/);
    expect(notes).toMatch(/A lawn mapped for large patch only keeps Artavia, then Velista\./);
    expect(notes).toMatch(/Velista \(Group 7\) works on large patch, not take-all; azoxystrobin does nothing on dollar spot\./);
    // The rotation check stays advisory: the take-all pair exception text is unchanged.
    expect(notes).toMatch(/Artavia then Headway is the planned take-all pair/);
  });
});

describe('catalog spec and watering rule', () => {
  const { CATALOG } = catalogMigration;

  test('the figures: 3 lb is inside the label range (1.15 to 4.6) and under the 4.6 lb yearly maximum; two 3 lb passes on one spot would not be', () => {
    expect(CATALOG.default_rate_per_1000).toBe(3);
    expect(CATALOG.min_label_rate_per_1000).toBeLessThanOrEqual(3);
    expect(CATALOG.max_label_rate_per_1000).toBe(4.6);
    expect(CATALOG.max_annual_per_1000).toBe(4.6);
    expect(3 + 3).toBeGreaterThan(CATALOG.max_annual_per_1000); // a second 3 lb pass on one spot is over the label's yearly maximum
    expect(CATALOG).toMatchObject({
      name: NAME, category: 'insecticide', product_type: 'pesticide', formulation: 'granular bait', container_size: '25 lb', unit_size_oz: 400,
      siteone_sku: '53202', epa_reg_number: '100-1483', moa_group: 'Group 22A', irac_group: '22A', rate_unit: 'lb', approved_for_service_report: true,
    });
    for (const field of ['best_price', 'best_vendor', 'cost_per_unit', 'cost_unit', 'needs_pricing', 'mow_hold_days']) expect(CATALOG).not.toHaveProperty(field);
    expect(catalogMigration.INSERT_DEFAULTS).toEqual({ active: true, needs_pricing: true, content_status: 'draft', customer_visibility: 'internal_only' });
    expect(CATALOG.name.length).toBeLessThanOrEqual(150);
    expect(CATALOG.container_size.length).toBeLessThanOrEqual(50);
    expect(CATALOG.irac_group.length).toBeLessThanOrEqual(10);
    expect(CATALOG.label_source_note).toMatch(/100-1483/);
  });

  test('the watering rule is a valid 72-hour hold, owner-sourced, and the coverage fixture carries it', () => {
    const checked = validateRule(catalogMigration.WATERING_RULE);
    expect(checked.errors).toEqual([]);
    expect(checked.rule).toMatchObject({ mode: 'hold', hold_hours: 72, source: 'owner' });
    expect(catalogMigration.WATERING_RULE.label_note.length).toBeLessThanOrEqual(500);
    const { mode, hold_hours: hours, source } = catalogMigration.WATERING_RULE;
    expect(require('./fixtures/lawn-watering-rules-v13-2026-10-22.json')[NAME]).toEqual({ mode, hold_hours: hours, source });
  });

  test('the report freezes the product with its hold and the customer copy, and the customer text goes out (no mow hold)', () => {
    const facts = approvedReportProductFacts({ ...CATALOG });
    expect(facts).toMatchObject({ name: NAME, epaRegNumber: '100-1483', serviceReportSummary: catalogMigration.SUMMARY, precautionSummary: catalogMigration.PRECAUTION });
    expect(facts.wateringRule).toMatchObject({ mode: 'hold', hold_hours: 72 });
    const rules = rulesForTargets(validateRule(catalogMigration.WATERING_RULE).rule, ['mole crickets']).map((rule) => ({ name: NAME, rule }));
    const ins = buildWateringInstruction({ rules, completedAt: '2026-06-23T20:00:00Z', plainWhenNoSetup: true, labelFirst: true });
    expect(ins.state).toBe('hold');
    expect(ins.lines[0]).toMatch(/^Skip your turf watering until /);
    expect(Date.parse(ins.holdUntil) - Date.parse('2026-06-23T20:00:00Z')).toBe(72 * 3600 * 1000);
    expect(ins.mowHold).toBeNull();
  });

  test('the 4.6 lb yearly maximum is a runtime limit: a v13 amount entry in the product\'s own unit, hard block, program rate as the unsized fallback', () => {
    const caps = require('../config/lawn-v13-count-caps');
    const entry = caps.v13CountCapFor(NAME);
    expect(entry.annualAmount).toMatchObject({ cap: 4.6, unit: 'lb/1000sf/year', fallbackRate: 3 });
    expect(entry.annualAmount.cap).toBe(CATALOG.max_annual_per_1000);
    expect(entry.annualAmount.fallbackRate).toBe(CATALOG.default_rate_per_1000);
    expect(caps.v13CountCapFor('Advion WDG Granular')).toBeNull();
  });

  test('pricing: the import row carries SiteOne 25 lb at $166.01; the migration writes no price', () => {
    const { parse } = require('csv-parse/sync');
    const rows = parse(require('fs').readFileSync(require('path').join(__dirname, '../data/pricing.csv'), 'utf8'), { columns: true, skip_empty_lines: true, relax_column_count: true });
    const hits = rows.filter((row) => row.Product === NAME);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ Vendor: 'SiteOne', Size: '25 lb', Price: '$166.01', Category: 'Insecticide' });
  });
});

describe('treatment guide: the Group 11 large patch row is passed over when take-all is mapped', () => {
  const { pickAddOns } = require('../services/lawn-treatment-guide');
  const cand = (id, name) => ({ raw: { product: { id, name } }, item: { productId: id, name } });
  const rows = new Map([
    ['art', { productName: N.ART, role: 'fungicide_spot', gates: { trigger: 'active_large_patch' } }],
    ['vel', { productName: N.VEL, role: 'fungicide_spot', gates: { trigger: 'active_large_patch_take_all_mapped' } }],
  ]);
  const candidates = [cand('vel', N.VEL), cand('art', N.ART)];

  test('no take-all area: the first fungicide in program order (Artavia); take-all mapped: Velista', () => {
    expect(pickAddOns(candidates, rows).fungus.item.productId).toBe('art');
    expect(pickAddOns(candidates, rows, { takeAllMapped: false }).fungus.item.productId).toBe('art');
    expect(pickAddOns(candidates, rows, { takeAllMapped: true }).fungus.item.productId).toBe('vel');
  });

  test('the passed-over Artavia row is returned as held (governed, never listed or searched); empty unless take-all is mapped', () => {
    const { group11HeldAddOns } = require('../services/lawn-treatment-guide');
    expect(group11HeldAddOns(candidates, rows)).toEqual([]);
    expect(group11HeldAddOns(candidates, rows, { takeAllMapped: false })).toEqual([]);
    expect(group11HeldAddOns(candidates, rows, { takeAllMapped: true }).map((c) => c.item.productId)).toEqual(['art']);
    const other = new Map([['art', { productName: N.ART, role: 'fungicide_spot', gates: { trigger: 'gray_leaf_spot_pythium_root_rot' } }]]);
    expect(group11HeldAddOns([cand('art', N.ART)], other, { takeAllMapped: true })).toEqual([]);
  });

  test('a take-all or gray leaf spot Artavia row is not a large patch row, so it is never passed over', () => {
    const other = new Map([['art', { productName: N.ART, role: 'fungicide_spot', gates: { trigger: 'gray_leaf_spot_pythium_root_rot' } }]]);
    expect(pickAddOns([cand('art', N.ART)], other, { takeAllMapped: true }).fungus.item.productId).toBe('art');
    const takeAll = new Map([['art', { productName: N.ART, role: 'fungicide_spot', gates: { trigger: 'mapped_take_all_fall_1' } }]]);
    expect(pickAddOns([cand('art', N.ART)], takeAll, { takeAllMapped: true }).fungus.item.productId).toBe('art');
  });
});

describe('treatment guide: a failed take-all lookup is read as mapped, never as an unmapped lawn', () => {
  const featureGates = require('../config/feature-gates');
  const areas = require('../services/lawn-trouble-areas');
  const { takeAllMappedOn } = require('../services/lawn-fast-complete');
  const svc = { id: 'visit-1', customer_id: 'cust-1', property_id: '00000000-0000-4000-8000-000000000001' };
  afterEach(() => jest.restoreAllMocks());

  test('places gate off: unknown, so mapped (true) with no read; take-all area on file: true; fungus only: false', async () => {
    const loadActive = jest.spyOn(areas, 'loadActive');
    jest.spyOn(featureGates, 'lawnTroubleAreasLive').mockReturnValue(false);
    expect(await takeAllMappedOn({ svc, knex: {} })).toBe(true);
    expect(loadActive).not.toHaveBeenCalled();
    featureGates.lawnTroubleAreasLive.mockReturnValue(true);
    jest.spyOn(areas, 'propertyOf').mockResolvedValue(svc.property_id);
    loadActive.mockResolvedValueOnce([{ type: 'fungus', place: 'front' }, { type: 'take_all', place: 'back' }]);
    expect(await takeAllMappedOn({ svc, knex: {} })).toBe(true);
    loadActive.mockResolvedValueOnce([{ type: 'fungus', place: 'front' }]);
    expect(await takeAllMappedOn({ svc, knex: {} })).toBe(false);
  });

  test('group11PassOver: only October to December; a lawn with no take-all in those months is the one that keeps Artavia', async () => {
    const { group11PassOver } = require('../services/lawn-fast-complete');
    jest.spyOn(featureGates, 'lawnTroubleAreasLive').mockReturnValue(true);
    jest.spyOn(areas, 'propertyOf').mockResolvedValue(svc.property_id);
    const loadActive = jest.spyOn(areas, 'loadActive').mockResolvedValue([]);
    for (const [date, expected] of [['2026-01-15', false], ['2026-09-15', false], ['2026-10-05', false], ['2026-12-10', false]]) {
      expect(await group11PassOver({ svc: { ...svc, scheduled_date: date }, knex: {} })).toBe(expected);
    }
    loadActive.mockResolvedValue([{ type: 'take_all', place: 'back' }]);
    for (const [date, expected] of [['2026-01-15', false], ['2026-03-10', false], ['2026-09-15', false], ['2026-10-05', true], ['2026-11-12', true], ['2026-12-10', true]]) {
      expect(await group11PassOver({ svc: { ...svc, scheduled_date: date }, knex: {} })).toBe(expected);
    }
    // The places gate off: unknown counts as mapped in the window, and January is untouched.
    featureGates.lawnTroubleAreasLive.mockReturnValue(false);
    expect(await group11PassOver({ svc: { ...svc, scheduled_date: '2026-10-05' }, knex: {} })).toBe(true);
    expect(await group11PassOver({ svc: { ...svc, scheduled_date: '2026-01-15' }, knex: {} })).toBe(false);
  });

  test('the context\'s guided picks use the same decision: Velista is the pick, and the passed-over Artavia row rides takeAllProductIds (held)', () => {
    const { guidedProductIds } = require('../services/lawn-fast-complete');
    jest.spyOn(featureGates, 'lawnTreatmentGuideLive').mockReturnValue(true);
    const rows = new Map([
      ['art', { productName: N.ART, role: 'fungicide_spot', gates: { trigger: 'active_large_patch' } }],
      ['vel', { productName: N.VEL, role: 'fungicide_spot', gates: { trigger: 'active_large_patch_take_all_mapped' } }],
    ]);
    jest.spyOn(require('../services/waveguard-plan-engine'), 'v13ProtocolRows').mockReturnValue(rows);
    const loaded = { eligible: true, plan: { protocol: { structured: {} } }, addOns: [{ product: { id: 'vel', name: N.VEL } }, { product: { id: 'art', name: N.ART } }] };
    const sheet = { addOns: [{ productId: 'vel', name: N.VEL }, { productId: 'art', name: N.ART }] };
    expect(guidedProductIds(loaded, sheet, false)).toEqual({ guidedProductIds: ['art'], takeAllProductIds: [], group11HeldProductIds: [] });
    // The held row is also named on its own, so the sheet blocks it from the start (no list, no search) whatever the guide read does.
    expect(guidedProductIds(loaded, sheet, true)).toEqual({ guidedProductIds: ['vel'], takeAllProductIds: ['art'], group11HeldProductIds: ['art'] });
  });

  test('the active-area read throws (or the property cannot be resolved): the lawn counts as mapped, so the guide suggests Velista and never Artavia', async () => {
    jest.spyOn(featureGates, 'lawnTroubleAreasLive').mockReturnValue(true);
    const loadActive = jest.spyOn(areas, 'loadActive').mockRejectedValue(new Error('db down'));
    expect(await takeAllMappedOn({ svc, knex: {} })).toBe(true);
    loadActive.mockResolvedValue([]);
    jest.spyOn(areas, 'propertyOf').mockRejectedValue(new Error('resolver down'));
    expect(await takeAllMappedOn({ svc, knex: {} })).toBe(true);
  });

  test('the visit property does not resolve (null): the take-all status is unknown, so the lawn counts as mapped and no area is read', async () => {
    jest.spyOn(featureGates, 'lawnTroubleAreasLive').mockReturnValue(true);
    jest.spyOn(areas, 'propertyOf').mockResolvedValue(null);
    const loadActive = jest.spyOn(areas, 'loadActive').mockResolvedValue([]);
    expect(await takeAllMappedOn({ svc, knex: {} })).toBe(true);
    expect(loadActive).not.toHaveBeenCalled();
  });
});

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const TABLES = ['property_application_history', 'products_catalog', 'product_aliases', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_product_actuals',
  'lawn_protocol_audit_log', 'lawn_protocol_service_completions', 'product_limits'];
const PRICES = ['best_price', 'best_vendor', 'cost_per_unit', 'cost_unit', 'best_vendor_pricing_id', 'best_price_amount_cached'];

describeDb('mole cricket bait migrations through PostgreSQL', () => {
  let owned;
  let knex;
  const ids = {};

  beforeAll(async () => {
    owned = await createLawnHistoryDb(); knex = owned.knex;
    for (const table of TABLES) {
      await knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [owned.schema, table, table]);
      const columns = await knex(table).columnInfo();
      if (String(columns.id?.defaultValue || '').includes('nextval(')) {
        await knex.raw('ALTER TABLE ??.?? ALTER COLUMN id DROP DEFAULT', [owned.schema, table]);
        await knex.raw('ALTER TABLE ??.?? ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY', [owned.schema, table]);
      }
    }
    // LIKE copies no foreign keys; the product reference check reads them.
    await knex.raw('ALTER TABLE ??.product_limits ADD CONSTRAINT fixture_limits_product FOREIGN KEY (product_id) REFERENCES ??.products_catalog (id)', [owned.schema, owned.schema]);
    await knex.raw('ALTER TABLE ??.lawn_protocol_products ADD CONSTRAINT fixture_lpp_product FOREIGN KEY (product_id) REFERENCES ??.products_catalog (id) ON DELETE SET NULL', [owned.schema, owned.schema]);
    await knex.raw('ALTER TABLE ??.lawn_protocol_product_actuals ADD CONSTRAINT fixture_lppa_row FOREIGN KEY (protocol_product_id) REFERENCES ??.lawn_protocol_products (id) ON DELETE SET NULL', [owned.schema, owned.schema]);
    await knex.raw('ALTER TABLE ??.lawn_protocol_audit_log ALTER COLUMN lawn_protocol_id DROP NOT NULL', [owned.schema]).catch(() => {});
  }, 60000);
  afterAll(async () => { if (owned) await owned.dispose(); });

  const newRow = () => knex('products_catalog').where({ name: NAME }).first();
  const rowsIn = (windowKey, name) => knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'w.window_key': windowKey, 'p.product_name': name })
    .orderBy('l.protocol_key').select('p.*', 'l.protocol_key');
  const ours = () => knex('lawn_protocol_audit_log').whereIn('action', [catalogMigration.CATALOG_ACTION, rowsMigration.ACTION]);
  const strip = (rows) => rows.map(({ updated_at: _u, ...rest }) => rest);
  const snapshot = async () => ({
    products: strip(await knex('lawn_protocol_products').orderBy('id')),
    catalog: strip(await knex('products_catalog').orderBy('id')),
    audit: (await knex('lawn_protocol_audit_log').orderBy('id')).map(({ id: _i, created_at: _c, ...rest }) => rest),
  });
  const upBoth = async () => { await catalogMigration.up(knex); await rowsMigration.up(knex); };
  const downBoth = async () => { await rowsMigration.down(knex); await catalogMigration.down(knex); };

  // A clean fixture: the catalog as main leaves it (Acelepryn, Velista, Talak, Artavia, and the pest-control Advion WDG Granular),
  // two staged v13 protocols with the windows this touches.
  async function reset() {
    for (const table of ['product_limits', 'lawn_protocol_product_actuals', 'lawn_protocol_audit_log', 'lawn_protocol_products', 'lawn_protocol_windows',
      'lawn_protocol_service_completions', 'lawn_protocols', 'product_aliases', 'products_catalog']) await knex(table).del();
    await knex('scheduled_services').update({ lawn_protocol_key: null, lawn_protocol_version: null });
    const make = async (name, extra = {}) => (await knex('products_catalog').insert({ name, category: 'insecticide', active: true, ...extra }).returning('*'))[0];
    ids.ace = (await make(N.ACE)).id; ids.vel = (await make(N.VEL, { category: 'fungicide' })).id; ids.tal = (await make(N.TAL)).id; ids.art = (await make(N.ART, { category: 'fungicide' })).id;
    ids.wdg = (await make('Advion WDG Granular', { epa_reg_number: '100-1483' })).id;
    for (const key of KEYS) {
      await knex('lawn_protocols').insert({ protocol_key: key, version: '2026.06', name: 'Fixture old', status: 'active', grass_track: 'bermuda', region: 'swfl' });
      const [protocol] = await knex('lawn_protocols').insert({ protocol_key: key, version: V13, name: 'Fixture v13', status: 'staged', grass_track: 'bermuda', region: 'swfl', effective_from: '2000-01-01' }).returning('*');
      const win = {};
      for (const [windowKey, month] of [[W.JUN, 6], [W.JUL, 7], [W.AUG, 8], [W.OCT, 10], [W.DEC, 12]]) {
        [win[windowKey]] = await knex('lawn_protocol_windows').insert({ lawn_protocol_id: protocol.id, month, window_key: windowKey, title: windowKey, visit_type: 'fixture', production_mode: 'hose', goal: 'fixture' }).returning('*');
      }
      const spot = (windowKey, productId, name, role, gates, sort, extra = {}) => ({ lawn_protocol_window_id: win[windowKey].id, product_id: productId, product_name: name, role, application_mode: 'spot', default_in_plan: false, sort_order: sort, gates: JSON.stringify(gates), ...extra });
      await knex('lawn_protocol_products').insert([
        spot(W.JUN, ids.art, N.ART, 'fungicide_spot', { trigger: 'gray_leaf_spot_pythium_root_rot' }, 32, { rate_unit: 'label_rate', carrier_gal_per_1000: 2 }),
        spot(W.JUL, ids.ace, N.ACE, 'insecticide_spot', { trigger: 'caterpillars', delayWateringOrMowingHours: 24 }, 34, { rate_unit: 'fl oz', carrier_gal_per_1000: 2 }),
        spot(W.JUL, ids.tal, N.TAL, 'insecticide_spot', { trigger: rowsMigration.TALAK_OLD_TRIGGER, delayWateringHours: 24 }, 36, { rate_per_1000: 1, rate_unit: 'fl oz', carrier_gal_per_1000: 4 }),
        spot(W.AUG, ids.tal, N.TAL, 'insecticide_spot', rowsMigration.AUG_TALAK_GATES, 41, { rate_per_1000: 1, rate_unit: 'fl oz', carrier_gal_per_1000: 4 }),
        spot(W.OCT, ids.vel, N.VEL, 'fungicide_spot', { trigger: 'mapped_large_patch_with_artavia_fairy_ring_dollar_spot_rust_leaf_spot' }, 45, { rate_unit: 'label_rate', carrier_gal_per_1000: 2 }),
        spot(W.DEC, ids.art, N.ART, 'fungicide_spot', { trigger: 'active_large_patch' }, 54, { rate_unit: 'label_rate', carrier_gal_per_1000: 2 }),
      ]);
    }
  }

  describe('fresh path: no catalog row matches', () => {
    beforeAll(async () => { await reset(); await upBoth(); });

    test('one catalog row is inserted, unpriced, pending pricing, approved for the report; the pest-control Advion WDG Granular row is untouched', async () => {
      const rows = await knex('products_catalog').where({ name: NAME });
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toMatchObject({
        category: 'insecticide', product_type: 'pesticide', formulation: 'granular bait', container_size: '25 lb', siteone_sku: '53202', epa_reg_number: '100-1483',
        moa_group: 'Group 22A', irac_group: '22A', rate_unit: 'lb', active: true, needs_pricing: true, content_status: 'draft', customer_visibility: 'internal_only',
        approved_for_service_report: true, public_summary: catalogMigration.SUMMARY, service_report_summary: catalogMigration.SUMMARY, customer_precaution_summary: catalogMigration.PRECAUTION,
      });
      expect([row.default_rate_per_1000, row.min_label_rate_per_1000, row.max_label_rate_per_1000, row.max_annual_per_1000, row.unit_size_oz].map(Number)).toEqual([3, 1.15, 4.6, 4.6, 400]);
      expect(PRICES.map((column) => row[column])).toEqual([null, null, null, null, null, null]);
      expect(row.mow_hold_days).toBeNull();
      expect(row.post_application_watering).toEqual(catalogMigration.WATERING_RULE);
      expect(validateRule(row.post_application_watering).valid).toBe(true);
      expect(approvedReportProductFacts(row).wateringRule).toMatchObject({ mode: 'hold', hold_hours: 72 });
      const wdg = await knex('products_catalog').where({ id: ids.wdg }).first();
      expect(wdg).toMatchObject({ name: 'Advion WDG Granular', epa_reg_number: '100-1483', post_application_watering: null });
    });

    test('every protocol: Advion in June and July, Acelepryn in June, Velista in December; the July Talak trigger is the old one; the August Talak row is gone', async () => {
      const product = await newRow();
      for (const windowKey of [W.JUN, W.JUL]) {
        const found = await rowsIn(windowKey, NAME);
        expect(found).toHaveLength(KEYS.length);
        for (const row of found) {
          expect(row).toMatchObject({ product_id: product.id, role: 'insecticide_spot', application_mode: 'spot', rate_unit: 'lb', default_in_plan: false });
          expect(Number(row.rate_per_1000)).toBe(3);
          expect(row.gates).toEqual({ trigger: 'mole_cricket_nymphs' });
        }
      }
      const ace = await rowsIn(W.JUN, N.ACE);
      expect(ace).toHaveLength(KEYS.length);
      for (const row of ace) expect(row).toMatchObject({ product_id: ids.ace, role: 'insecticide_spot', default_in_plan: false, gates: { trigger: 'mole_cricket_nymphs' } });
      const vel = await rowsIn(W.DEC, N.VEL);
      expect(vel).toHaveLength(KEYS.length);
      for (const row of vel) expect(row).toMatchObject({ product_id: ids.vel, role: 'fungicide_spot', default_in_plan: false, gates: { trigger: 'active_large_patch_take_all_mapped' } });
      const talak = await rowsIn(W.JUL, N.TAL);
      for (const row of talak) expect(row.gates).toEqual({ trigger: rowsMigration.TALAK_NEW_TRIGGER, delayWateringHours: 24 });
      expect(await rowsIn(W.AUG, N.TAL)).toEqual([]);
      // October's Velista and December's Artavia stay as they were.
      expect((await rowsIn(W.OCT, N.VEL)).length).toBe(KEYS.length);
      const decArt = await rowsIn(W.DEC, N.ART);
      for (const row of decArt) expect(row.gates).toEqual({ trigger: 'active_large_patch' });
    });

    test('audit: one catalog row naming the inserted product, one row per protocol recording inserted, updated and deleted', async () => {
      const catalogLogs = await knex('lawn_protocol_audit_log').where({ action: catalogMigration.CATALOG_ACTION });
      expect(catalogLogs).toHaveLength(1);
      expect(catalogLogs[0].lawn_protocol_id).toBeNull();
      expect(catalogLogs[0].after_snapshot).toMatchObject({ productId: (await newRow()).id });
      const logs = await knex('lawn_protocol_audit_log').where({ action: rowsMigration.ACTION });
      expect(logs).toHaveLength(KEYS.length);
      for (const log of logs) {
        expect(log.after_snapshot.inserted.map((e) => `${e.windowKey}:${e.product_name}`).sort()).toEqual([`${W.DEC}:${N.VEL}`, `${W.JUL}:${NAME}`, `${W.JUN}:${N.ACE}`, `${W.JUN}:${NAME}`].sort());
        expect(log.after_snapshot.updated).toHaveLength(1);
        expect(log.after_snapshot.deleted).toHaveLength(1);
      }
    });

    test('a second up changes nothing: no second catalog row, no second protocol row, no new audit row', async () => {
      const once = await snapshot();
      await upBoth();
      expect(await snapshot()).toEqual(once);
    });
  });

  describe('the yearly maximum through the limit reader', () => {
    beforeAll(async () => { await reset(); await upBoth(); });
    afterAll(() => { delete process.env.GATE_LAWN_V13; });

    test('v13 on: a hard-block annual_max_rate row of 4.6 lb for the inserted product; v13 off: none', async () => {
      const { applyV13CountCaps, V13_AMOUNT } = require('../config/lawn-v13-count-caps');
      const product = await newRow();
      process.env.GATE_LAWN_V13 = 'true';
      const on = await applyV13CountCaps(knex, { id: product.id, name: NAME }, [], product.id);
      expect(on.filter((r) => r.match_type === V13_AMOUNT).map((r) => [r.limit_type, Number(r.limit_value), r.limit_unit, r.severity])).toEqual([['annual_max_rate', 4.6, 'lb/1000sf/year', 'hard_block']]);
      delete process.env.GATE_LAWN_V13;
      expect((await applyV13CountCaps(knex, { id: product.id, name: NAME }, [], product.id)).filter((r) => r.match_type === V13_AMOUNT)).toEqual([]);
    });
  });

  describe('label verified (20261023142000): the job card shows the 3 lb amount', () => {
    beforeEach(async () => { await reset(); await upBoth(); });
    const stamp = async () => (await newRow()).label_verified_at;
    const audits = () => knex('lawn_protocol_audit_log').where({ action: stampMigration.ACTION });

    test('the inserted row has no stamp until the migration runs; then it carries exactly the wired value and nothing else changed', async () => {
      expect(await stamp()).toBeNull();
      const before = await newRow();
      await stampMigration.up(knex);
      const after = await newRow();
      expect(new Date(after.label_verified_at).toISOString()).toBe(stampMigration.VERIFIED_AT);
      const { label_verified_at: _a, updated_at: _u, ...rest } = after;
      const { label_verified_at: _b, updated_at: _v, ...restBefore } = before;
      expect(rest).toEqual(restBefore);
      expect(await audits()).toHaveLength(1);
      // The pest-control Advion WDG Granular row is not the inserted row and is never stamped.
      expect((await knex('products_catalog').where({ id: ids.wdg }).first()).label_verified_at).toBeNull();
    });

    test('a second up changes nothing; a row someone stamped first is left exactly as it is', async () => {
      await stampMigration.up(knex);
      const once = await snapshot();
      await stampMigration.up(knex);
      expect(await snapshot()).toEqual(once);
      await stampMigration.down(knex);
      const staffDate = '2026-11-01T12:00:00.000Z';
      await knex('products_catalog').where({ name: NAME }).update({ label_verified_at: staffDate });
      await stampMigration.up(knex);
      expect(new Date(await stamp()).toISOString()).toBe(staffDate);
      expect(await audits()).toHaveLength(0);
    });

    test('with no inserted row (no catalog audit marker) nothing is stamped', async () => {
      await downBoth();
      const [other] = await knex('products_catalog').insert({ name: NAME, category: 'insecticide', active: true }).returning('*');
      await stampMigration.up(knex);
      expect((await knex('products_catalog').where({ id: other.id }).first()).label_verified_at).toBeNull();
    });

    test('down clears the stamp only while it is still the written value; a changed stamp stays', async () => {
      await stampMigration.up(knex);
      await stampMigration.down(knex);
      expect(await stamp()).toBeNull();
      expect(await audits()).toHaveLength(0);
      await stampMigration.up(knex);
      await knex('products_catalog').where({ name: NAME }).update({ label_verified_at: '2026-11-01T12:00:00.000Z' });
      await stampMigration.down(knex);
      expect(new Date(await stamp()).toISOString()).toBe('2026-11-01T12:00:00.000Z');
      expect(await audits()).toHaveLength(0);
    });

    test('the full rollback in reverse order (stamp, rows, catalog) returns to the start; the catalog down is not blocked by the stamp', async () => {
      await reset();
      const start = await snapshot();
      await upBoth();
      await stampMigration.up(knex);
      await stampMigration.down(knex);
      await downBoth();
      expect(await snapshot()).toEqual(start);
    });
  });

  describe('follow-ups (20261023143000): service_lines on the Advion row, a mole cricket entry on the Acelepryn rule', () => {
    const fixtureRule = () => JSON.parse(JSON.stringify(require('./fixtures/lawn-watering-rules-v13-2026-10-22.json')[N.ACE]));
    const withoutMoleCricket = () => { const rule = fixtureRule(); rule.by_target = rule.by_target.filter((e) => !e.match.includes('mole cricket')); return rule; };
    const ace = () => knex('products_catalog').where({ id: ids.ace }).first();
    const audits = () => knex('lawn_protocol_audit_log').where({ action: followMigration.ACTION });
    beforeEach(async () => {
      await reset(); await upBoth();
      await knex('products_catalog').where({ id: ids.ace }).update({ post_application_watering: JSON.stringify(withoutMoleCricket()) });
    });

    test('service_lines becomes ["lawn"] on the inserted row only; the pest-control row and the rest of the row are untouched', async () => {
      const before = await newRow();
      const wdgBefore = await knex('products_catalog').where({ id: ids.wdg }).first();
      await followMigration.up(knex);
      const after = await newRow();
      expect(after.service_lines).toEqual(['lawn']);
      const { service_lines: _a, updated_at: _u, ...rest } = after;
      const { service_lines: _b, updated_at: _v, ...restBefore } = before;
      expect(rest).toEqual(restBefore);
      expect(await knex('products_catalog').where({ id: ids.wdg }).first()).toEqual(wdgBefore);
    });

    test('a service_lines value someone set first is left alone', async () => {
      await knex('products_catalog').where({ name: NAME }).update({ service_lines: JSON.stringify(['pest']) });
      await followMigration.up(knex);
      expect((await newRow()).service_lines).toEqual(['pest']);
    });

    test('Acelepryn gets the mole cricket water-in entry appended, nothing else in the rule changes; a second up changes nothing', async () => {
      await followMigration.up(knex);
      const rule = (await ace()).post_application_watering;
      expect(rule).toEqual(fixtureRule());
      expect(validateRule(rule).valid).toBe(true);
      const once = await snapshot();
      await followMigration.up(knex);
      expect(await snapshot()).toEqual(once);
      expect(await audits()).toHaveLength(1);
    });

    test('an Acelepryn rule with no by_target list, or with an entry that already covers mole crickets, is left alone', async () => {
      await knex('products_catalog').where({ id: ids.ace }).update({ post_application_watering: JSON.stringify({ mode: 'hold', hold_hours: 24, source: 'label' }) });
      await followMigration.up(knex);
      expect((await ace()).post_application_watering).toEqual({ mode: 'hold', hold_hours: 24, source: 'label' });
      await knex('lawn_protocol_audit_log').where({ action: followMigration.ACTION }).del();
      await knex('products_catalog').where({ id: ids.ace }).update({ post_application_watering: JSON.stringify(fixtureRule()) });
      await followMigration.up(knex);
      expect((await ace()).post_application_watering).toEqual(fixtureRule());
    });

    test('down puts both back exactly; a rule or service_lines staff changed since makes down a full no-op', async () => {
      const start = await snapshot();
      await followMigration.up(knex);
      await followMigration.down(knex);
      expect(await snapshot()).toEqual(start);
      await followMigration.up(knex);
      await knex('products_catalog').where({ id: ids.ace }).update({ post_application_watering: JSON.stringify({ ...fixtureRule(), source: 'label' }) });
      const edited = await snapshot();
      await followMigration.down(knex);
      expect(await snapshot()).toEqual(edited);
      await knex('products_catalog').where({ id: ids.ace }).update({ post_application_watering: JSON.stringify(fixtureRule()) });
      await knex('products_catalog').where({ name: NAME }).update({ service_lines: JSON.stringify(['lawn', 'pest']) });
      const edited2 = await snapshot();
      await followMigration.down(knex);
      expect(await snapshot()).toEqual(edited2);
    });

    test('with the entry, a blank chip on the mole cricket offer reads water-in text; without the default target it would read the caterpillar hold', () => {
      const { rulesForTargets } = require('../services/service-report/lawn-watering-rule');
      const rule = validateRule(fixtureRule()).rule;
      const text = (targets) => buildWateringInstruction({ rules: rulesForTargets(rule, targets).map((r) => ({ name: N.ACE, rule: r })), completedAt: '2026-06-23T20:00:00Z', plainWhenNoSetup: true, labelFirst: true });
      expect(text([]).state).toBe('hold'); // the caterpillar hold: what a blank chip read before
      const moleCricket = text(['Tawny mole crickets']);
      expect(moleCricket.state).toBe('water_in');
      expect(moleCricket.waterInInches).toBe(0.25);
    });
  });

  describe('a blank Treating chip on the mole cricket offer records the target by default', () => {
    const { withProtocolDefaultTargets, resolveForCompletion, MOLE_CRICKET_TARGET } = require('../services/lawn-spot-target');
    const plan = { protocol: { structured: { products: [
      { productId: 'ACE-ID', gates: { trigger: 'mole_cricket_nymphs' } },
      { productId: 'CAT-ID', gates: { trigger: 'caterpillars', delayWateringOrMowingHours: 24 } },
    ] } } };
    const plain = async (rows, lawnFast = null) => resolveForCompletion({ rows, lawnFast, catalog: new Map(), canonicalId: (id) => id, inferMethod: () => 'spot_treatment', serviceLine: 'lawn', confirm: async () => ({ takeAll: new Set(), chinch: new Set(), chinchOnly: new Set() }) });

    test('the staged mole cricket row gets the target when none was chosen; a chosen target and every other row are untouched', async () => {
      const rows = [{ productId: 'ACE-ID', targets: [] }, { productId: 'CAT-ID', targets: [] }, { productId: 'ACE-ID-2', targets: [] }];
      const out = withProtocolDefaultTargets(await plain(rows), { plan, canonicalId: (id) => id });
      expect(out.of(rows[0])).toEqual([MOLE_CRICKET_TARGET]);
      expect(out.of(rows[1])).toEqual([]);
      expect(out.of(rows[2])).toEqual([]);
      expect(out.submitted(rows).map((r) => r.targets)).toEqual([[MOLE_CRICKET_TARGET], [], []]);
      const chosen = [{ productId: 'ACE-ID', targets: ['White grubs'] }];
      const kept = withProtocolDefaultTargets(await plain(chosen), { plan, canonicalId: (id) => id });
      expect(kept.of(chosen[0])).toEqual(['White grubs']);
      expect(kept.submitted(chosen)).toEqual(chosen);
    });

    test('a plan with no mole cricket row changes nothing at all', async () => {
      const rows = [{ productId: 'CAT-ID', targets: [] }];
      const base = await plain(rows);
      expect(withProtocolDefaultTargets(base, { plan: { protocol: { structured: { products: [plan.protocol.structured.products[1]] } } }, canonicalId: (id) => id })).toBe(base);
      expect(withProtocolDefaultTargets(base, { plan: null })).toBe(base);
    });

    test('the frozen report facts read the default: Acelepryn on the mole cricket offer freezes the water-in direction', async () => {
      const { freezeReportProductFacts } = require('../services/complete-scheduled-service');
      const aceId = '7f1e2d3c-0000-4000-8000-0000000000bb';
      const catalogRow = { id: aceId, name: N.ACE, category: 'insecticide', epa_reg_number: '100-1489', active: true, label_verified_at: new Date(), approved_for_service_report: true,
        content_status: 'approved', customer_visibility: 'public', post_application_watering: JSON.parse(JSON.stringify(require('./fixtures/lawn-watering-rules-v13-2026-10-22.json')[N.ACE])) };
      const stagedPlan = { protocol: { structured: { products: [{ productId: aceId, gates: { trigger: 'mole_cricket_nymphs' } }] } } };
      const rows = [{ productId: aceId, targets: [] }];
      const spot = withProtocolDefaultTargets(await plain(rows), { plan: stagedPlan, canonicalId: (id) => id });
      const frozen = freezeReportProductFacts({ productIds: [aceId], submitted: spot.submitted(rows), catalogById: new Map([[aceId, catalogRow]]), plan: stagedPlan })[aceId];
      expect(frozen.wateringRule.by_target.some((e) => e.mode === 'water_in' && e.match.includes('mole cricket'))).toBe(true);
      const { rulesForTargets } = require('../services/service-report/lawn-watering-rule');
      expect(rulesForTargets(frozen.wateringRule, spot.of(rows[0])).map((r) => r.mode)).toEqual(['water_in']);
    });
  });

  describe('Advion once per spot per year: June baits a spot, July baits a NEW spot (owner 2026-10-23)', () => {
    const applicationLimits = require('../services/application-limits');
    const featureGates = require('../config/feature-gates');
    const caps = require('../config/lawn-v13-count-caps');
    const { fixture } = require('./helpers/lawn-history-db');
    const JULY = new Date('2026-07-14T16:00:00Z');
    let customerId;
    let product;

    beforeAll(async () => { await reset(); await upBoth(); product = await newRow(); });
    beforeEach(async () => {
      process.env.GATE_LAWN_V13 = 'true';
      caps.resetV13CapIdentity();
      await knex('property_application_history').del();
      ({ customerId } = await fixture(knex));
      // June: 3 lb at the FRONT of the lawn.
      await knex('property_application_history').insert({
        customer_id: customerId, product_id: product.id, application_date: '2026-06-23', application_rate: 3, rate_unit: 'lb', treated_place: 'front',
      });
    });
    afterEach(() => { delete process.env.GATE_LAWN_V13; jest.restoreAllMocks(); });
    const check = (opts) => applicationLimits.checkLimits(customerId, product.id, JULY, knex, { proposed: { ratePer1000: 3, unit: 'lb' }, ...opts });
    const amount = (result) => result.blocks.filter((b) => b.type === 'annual_max_rate');

    test('places on: a July pass at a NEW place (back) is allowed', async () => {
      jest.spyOn(featureGates, 'lawnTroubleAreasLive').mockReturnValue(true);
      const result = await check({ place: 'back' });
      expect(amount(result)).toEqual([]);
      expect(result.allowed).toBe(true);
    });

    test('places on: a July pass at the SAME place (front) is blocked with the yearly-amount reason', async () => {
      jest.spyOn(featureGates, 'lawnTroubleAreasLive').mockReturnValue(true);
      const result = await check({ place: 'front' });
      expect(result.allowed).toBe(false);
      expect(amount(result)).toHaveLength(1);
      expect(amount(result)[0].message).toMatch(/yearly label amount \(4\.6 lb per 1,000 sq ft\).*THIS APPLICATION WOULD EXCEED IT/);
    });

    describe('one yearly cap across both catalog rows of the granule (EPA 100-1483)', () => {
      const oldRow = (rate, place, unit = 'lb') => knex('property_application_history').insert({
        customer_id: customerId, product_id: ids.wdg, application_date: '2026-05-20', application_rate: rate, rate_unit: unit, treated_place: place,
      });
      beforeEach(async () => { await knex('property_application_history').del(); });

      test('earlier use under the pest-control row (Advion WDG Granular) counts against a new-row application at the same place; another place is open', async () => {
        jest.spyOn(featureGates, 'lawnTroubleAreasLive').mockReturnValue(true);
        await oldRow(3, 'front');
        const same = await check({ place: 'front' });
        expect(same.allowed).toBe(false);
        expect(amount(same)[0].message).toMatch(/total 65\.2% of the yearly label amount \(4\.6 lb per 1,000 sq ft\).*THIS APPLICATION WOULD EXCEED IT/);
        expect((await check({ place: 'back' })).allowed).toBe(true);
      });

      test('the old row\'s ounces convert (48 oz = 3 lb); a use that cannot be sized counts at the program rate; another EPA number does not count', async () => {
        await oldRow(48, null, 'oz');
        expect((await check({})).allowed).toBe(false);
        await knex('property_application_history').del();
        await oldRow(null, null, null);
        expect((await check({})).allowed).toBe(false);
        await knex('property_application_history').del();
        const [other] = await knex('products_catalog').insert({ name: 'Some other indoxacarb bait', category: 'insecticide', epa_reg_number: '100-1484', active: true }).returning('*');
        await knex('property_application_history').insert({ customer_id: customerId, product_id: other.id, application_date: '2026-05-20', application_rate: 3, rate_unit: 'lb' });
        expect((await check({})).allowed).toBe(true);
        await knex('products_catalog').where({ id: other.id }).del();
      });

      test('the closeout audit counts the old row too (the same history set): 3 lb under each row is over the yearly maximum', async () => {
        process.env.GATE_LAWN_V13 = 'true';
        const [limit] = (await caps.applyV13CountCaps(knex, { id: product.id, name: NAME }, [], product.id)).filter((l) => l.match_type === caps.V13_AMOUNT);
        expect(limit.history_epa_reg_number).toBe(catalogMigration.CATALOG.epa_reg_number);
        await oldRow(3, null);
        expect(await applicationLimits.auditAmount(knex, customerId, product, '2026-07-14', limit, {})).toBeNull();
        await knex('property_application_history').insert({ customer_id: customerId, product_id: product.id, application_date: '2026-07-14', application_rate: 3, rate_unit: 'lb' });
        const found = await applicationLimits.auditAmount(knex, customerId, product, '2026-07-14', limit, {});
        expect(found).toMatchObject({ type: 'annual_max_rate' });
        expect(found.current).toBeGreaterThan(100);
      });
    });

    test('a whole-lawn check (no place) after June\'s 3 lb is blocked too: 3 + 3 lb is over 4.6', async () => {
      const result = await check({});
      expect(result.allowed).toBe(false);
      expect(amount(result)[0].message).toMatch(/THIS APPLICATION WOULD EXCEED IT/);
    });
  });

  describe('a catalog row that already matches, in ANY state: up throws and writes nothing', () => {
    beforeEach(async () => { await reset(); });
    const GOOD = { name: NAME, category: 'insecticide', active: true, epa_reg_number: '100-1483' };
    const everything = async () => ({ catalog: strip(await knex('products_catalog').orderBy('id')), products: strip(await knex('lawn_protocol_products').orderBy('id')), audit: await knex('lawn_protocol_audit_log').orderBy('id') });

    test.each([
      ['a correct active row', {}],
      ['an inactive row', { active: false }],
      ['an active-unset row', { active: null }],
      ['a bare name-only row', { epa_reg_number: null, category: null }],
      ['a priced row', { best_price: 150 }],
    ])('%s: throws, nothing linked, nothing changed, no audit row', async (_label, change) => {
      await knex('products_catalog').insert({ ...GOOD, ...change });
      const before = await everything();
      await expect(catalogMigration.up(knex)).rejects.toThrow(/already exists; this migration only inserts/);
      expect(await everything()).toEqual(before);
      // The second migration finds no inserted row of ours and writes nothing either.
      await rowsMigration.up(knex);
      expect(await everything()).toEqual(before);
    });

    test('an alias-only match (even a correct row under another name) throws', async () => {
      const [other] = await knex('products_catalog').insert({ ...GOOD, name: 'Advion Mole Cricket Bait' }).returning('*');
      await knex('product_aliases').insert({ product_id: other.id, alias_name: NAME });
      const before = await everything();
      await expect(catalogMigration.up(knex)).rejects.toThrow(/already exists/);
      expect(await everything()).toEqual(before);
    });

    test('a row whose name differs only in case or spacing or punctuation still throws', async () => {
      await knex('products_catalog').insert({ ...GOOD, name: 'ADVION  insect-granule' });
      await expect(catalogMigration.up(knex)).rejects.toThrow(/already exists/);
    });

    test('a failed up leaves the database as it was, and a second try after the row is removed inserts normally', async () => {
      const [stray] = await knex('products_catalog').insert({ ...GOOD, active: false }).returning('*');
      await expect(catalogMigration.up(knex)).rejects.toThrow();
      await knex('products_catalog').where({ id: stray.id }).del();
      await upBoth();
      expect(await newRow()).toBeTruthy();
      expect((await rowsIn(W.JUN, NAME)).length).toBe(KEYS.length);
    });
  });

  describe('rows the second migration skips or keeps', () => {
    beforeEach(async () => { await reset(); });

    test('a June window that already has an Acelepryn row, and a changed August Talak row, are left alone', async () => {
      const [julAce] = await rowsIn(W.JUL, N.ACE);
      const jun = await knex('lawn_protocol_windows').where({ window_key: W.JUN }).first();
      await knex('lawn_protocol_products').insert({ lawn_protocol_window_id: jun.id, product_id: ids.ace, product_name: N.ACE, role: 'insecticide_spot', application_mode: 'spot', default_in_plan: false, sort_order: 99, gates: JSON.stringify({ trigger: 'caterpillars' }) });
      const [augTalak] = await rowsIn(W.AUG, N.TAL);
      await knex('lawn_protocol_products').where({ id: augTalak.id }).update({ gates: JSON.stringify({ trigger: 'mole_cricket_nymphs', retuned: true }) });
      await upBoth();
      expect((await rowsIn(W.JUN, N.ACE)).length).toBe(KEYS.length);
      expect((await rowsIn(W.AUG, N.TAL)).map((r) => r.id)).toContain(augTalak.id);
      expect(julAce).toBeTruthy();
    });

    test.each([
      ['re-rated', { rate_per_1000: 1.5 }],
      ['given another carrier volume', { carrier_gal_per_1000: 2 }],
      ['given another mode', { application_mode: 'broadcast' }],
      ['put in the plan', { default_in_plan: true }],
      ['re-linked to another product', () => ({ product_id: ids.ace })],
    ])('an August Talak row staff %s is kept (the whole row is compared, not only its gates)', async (_label, change) => {
      const [augTalak] = await rowsIn(W.AUG, N.TAL);
      await knex('lawn_protocol_products').where({ id: augTalak.id }).update(typeof change === 'function' ? change() : change);
      await upBoth();
      expect((await rowsIn(W.AUG, N.TAL)).map((r) => r.id)).toContain(augTalak.id);
    });

    test('an August Talak row a completion references is kept', async () => {
      const [augTalak] = await rowsIn(W.AUG, N.TAL);
      const columns = await knex('lawn_protocol_product_actuals').columnInfo();
      const row = { protocol_product_id: augTalak.id };
      for (const [column, info] of Object.entries(columns)) {
        if (column in row || column === 'id' || info.nullable || info.defaultValue != null) continue;
        row[column] = info.type.includes('uuid') ? require('crypto').randomUUID() : info.type.includes('int') ? 1 : info.type.includes('timestamp') ? new Date() : info.type === 'date' ? '2027-07-15' : info.type.includes('json') ? '{}' : info.type.includes('bool') ? false : 'x';
      }
      await knex('lawn_protocol_product_actuals').insert(row);
      await upBoth();
      expect((await rowsIn(W.AUG, N.TAL)).map((r) => r.id)).toContain(augTalak.id);
    });
  });

  describe('down: all or nothing', () => {
    beforeEach(async () => { await reset(); });

    test('clean up then down is the starting state exactly; up again gives the same rows', async () => {
      const start = await snapshot();
      await upBoth();
      const upped = await snapshot();
      await downBoth();
      expect(await snapshot()).toEqual(start);
      await upBoth();
      const again = await snapshot();
      const byName = (rows) => rows.map(({ id: _i, created_at: _c, ...rest }) => rest).sort((x, y) => `${x.name || x.product_name}${x.sort_order ?? ''}`.localeCompare(`${y.name || y.product_name}${y.sort_order ?? ''}`));
      const unlinked = (rows) => byName(rows.map(({ product_id: _p, lawn_protocol_window_id: _w, ...rest }) => rest));
      expect(unlinked(again.products)).toEqual(unlinked(upped.products));
      expect(byName(again.catalog)).toEqual(byName(upped.catalog));
      expect(await ours()).toHaveLength(KEYS.length + 1);
    });

    test('the deleted August Talak row comes back exactly as it was, with its original id', async () => {
      const [before] = await rowsIn(W.AUG, N.TAL);
      await upBoth();
      expect(await rowsIn(W.AUG, N.TAL)).toEqual([]);
      await downBoth();
      const restored = (await rowsIn(W.AUG, N.TAL)).find((r) => r.id === before.id);
      expect(restored).toBeTruthy();
      const clean = ({ updated_at: _u, ...rest }) => rest;
      expect(clean(restored)).toEqual(clean(before));
    });

    test('a visit pinned to ANY v13 protocol makes both downs a full no-op', async () => {
      await upBoth();
      const upped = await snapshot();
      const { fixture } = require('./helpers/lawn-history-db');
      const f = await fixture(knex);
      const row = await f.visit(1, {});
      await knex('scheduled_services').where({ id: row.id }).update({ lawn_protocol_key: KEYS[0], lawn_protocol_version: V13 });
      await downBoth();
      expect(await snapshot()).toEqual(upped);
    });

    test('a completion that references a v13 protocol makes both downs a full no-op', async () => {
      await upBoth();
      const upped = await snapshot();
      const [protocol] = await knex('lawn_protocols').where({ version: V13, protocol_key: KEYS[1] });
      const completionColumns = await knex('lawn_protocol_service_completions').columnInfo();
      const row = { lawn_protocol_id: protocol.id, protocol_key: KEYS[1], protocol_version: V13 };
      for (const [column, info] of Object.entries(completionColumns)) {
        if (column in row || column === 'id' || info.nullable || info.defaultValue != null) continue;
        row[column] = info.type.includes('uuid') ? require('crypto').randomUUID() : info.type.includes('int') ? 1 : info.type.includes('timestamp') ? new Date() : info.type === 'date' ? '2027-07-15' : info.type.includes('json') ? '{}' : info.type.includes('bool') ? false : 'x';
      }
      await knex('lawn_protocol_service_completions').insert(row);
      await downBoth();
      expect(await snapshot()).toEqual(upped);
    });

    test.each([
      ['an inserted Advion row re-rated', async () => { const [r] = await rowsIn(W.JUN, NAME); await knex('lawn_protocol_products').where({ id: r.id }).update({ rate_per_1000: 2 }); }],
      ['an inserted row re-gated', async () => { const [r] = await rowsIn(W.JUL, NAME); await knex('lawn_protocol_products').where({ id: r.id }).update({ gates: JSON.stringify({ trigger: 'x' }) }); }],
      ['an inserted row deleted', async () => { const [r] = await rowsIn(W.DEC, N.VEL); await knex('lawn_protocol_products').where({ id: r.id }).del(); }],
      ['an inserted row given another carrier volume', async () => { const [r] = await rowsIn(W.JUN, N.ACE); await knex('lawn_protocol_products').where({ id: r.id }).update({ carrier_gal_per_1000: 4 }); }],
      ['an inserted row re-linked to another product', async () => { const [r] = await rowsIn(W.JUL, NAME); await knex('lawn_protocol_products').where({ id: r.id }).update({ product_id: ids.wdg }); }],
      ['an inserted row moved to another unit', async () => { const [r] = await rowsIn(W.JUN, NAME); await knex('lawn_protocol_products').where({ id: r.id }).update({ rate_unit: 'oz' }); }],
      ['the July Talak trigger changed again', async () => { const [r] = await rowsIn(W.JUL, N.TAL); await knex('lawn_protocol_products').where({ id: r.id }).update({ gates: JSON.stringify({ trigger: 'edited' }) }); }],
    ])('%s by staff makes both downs a full no-op', async (_label, edit) => {
      await upBoth();
      await edit();
      const edited = await snapshot();
      await downBoth();
      expect(await snapshot()).toEqual(edited);
    });

    test.each([
      ['priced', { best_price: 41 }],
      ['marked priced', { needs_pricing: false }],
      ['published', { content_status: 'approved_for_portal' }],
      ['re-rated', { default_rate_per_1000: 2.5 }],
      ['given a different EPA number', { epa_reg_number: '100-1484' }],
    ])('a catalog row staff %s: the catalog down does nothing (the row and its audit row stay)', async (_label, change) => {
      await upBoth();
      await rowsMigration.down(knex);
      await knex('products_catalog').where({ name: NAME }).update(change);
      await catalogMigration.down(knex);
      expect(await newRow()).toBeTruthy();
      expect(await knex('lawn_protocol_audit_log').where({ action: catalogMigration.CATALOG_ACTION })).toHaveLength(1);
    });

    test('a catalog row something references (an application limit) is kept; a re-run after that finds its own row and quietly carries on', async () => {
      await upBoth();
      await rowsMigration.down(knex);
      const product = await newRow();
      await knex('product_limits').insert({ product_id: product.id, limit_type: 'annual_max_apps', limit_value: 2, limit_unit: 'applications', severity: 'warning' });
      await catalogMigration.down(knex);
      expect(await newRow()).toBeTruthy();
      const kept = await snapshot();
      await catalogMigration.up(knex);
      expect(await snapshot()).toEqual(kept);
    });

    test('the catalog down refuses while the staged rows still link to the product (they are in use); after the rows go, it deletes', async () => {
      await upBoth();
      await catalogMigration.down(knex);
      expect(await newRow()).toBeTruthy();
      await rowsMigration.down(knex);
      await catalogMigration.down(knex);
      expect(await newRow()).toBeFalsy();
    });
  });

  describe('nothing to do', () => {
    beforeEach(async () => { await reset(); });

    test('without a v13 protocol the catalog row is still inserted and no protocol row is written', async () => {
      await knex('lawn_protocol_audit_log').del();
      await knex('lawn_protocol_products').del();
      await knex('lawn_protocol_windows').del();
      await knex('lawn_protocols').where({ version: V13 }).del();
      await upBoth();
      expect(await newRow()).toBeTruthy();
      expect(await knex('lawn_protocol_products')).toEqual([]);
    });
  });
});

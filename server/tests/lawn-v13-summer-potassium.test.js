// Lawn protocol v13 summer potassium: a liquid potassium on the August and September hose visits,
// migration 20261029170000, owner 2026-10-29. Synthetic data only. No database: a small in-memory fake knex.
//
// Pinned: the recipe lines and notes on every track; the catalog spec (no price, no vendor, approved with plain copy); the
// North Port hold reads the row exactly as it reads the Nutra-TECH rows; the readers (expectations, readiness list, pricing
// import, schedule description, watering fixture); the migration inserts once, places the row directly after Nutra-TECH,
// moves a later row down one place, and rolls back all or nothing.
const fs = require('fs');
const path = require('path');
const engine = require('../services/waveguard-plan-engine');
const v13Recipe = require('../config/lawn-protocol-v13.json');
const migration = require('../models/migrations/20261029170000_lawn_v13_summer_potassium');
const staged = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
const fieldRules = require('../models/migrations/20261007150000_lawn_v13_field_rules');
const { visitForCadence } = require('../services/lawn-program');
const { validateRule } = require('../services/service-report/lawn-watering-rule');
const { approvedReportProductFacts } = require('../services/service-report/report-data');
const { PRODUCT_CLASS, FAMILY, normalizeProductName } = require('../config/lawn-expectations');

// Every product-specific value is read from the migration's PRODUCT block, so a product switch changes that block, the recipe
// lines and the name-keyed maps only.
const P = migration.PRODUCT;
const NAME = migration.NAME;
const NUTRA = staged.NAMES.NT;
const V13 = staged.V13_VERSION;
const visit = (grass, month) => v13Recipe[grass].visits.find((v) => v.month === month);

describe('summer potassium: the recipe and the catalog spec', () => {
  test('the audit action strings fit varchar(96), with room for the longest catalog column', () => {
    const longest = Math.max(...Object.keys(migration.CATALOG).map((column) => column.length));
    for (const action of [migration.ACTION, migration.CATALOG_ACTION, `migration:${migration.MIGRATION}:${'x'.repeat(longest)}`]) {
      expect(action.length).toBeLessThanOrEqual(96);
    }
    expect(migration.MIGRATION.length).toBeLessThanOrEqual(48);
  });

  test('the rate sits inside the label range, and the constants agree with the block', () => {
    expect([NAME, migration.RATE, migration.MIN_LABEL, migration.MAX_LABEL]).toEqual([P.name, P.rate, P.minLabel, P.maxLabel]);
    expect(P.rate).toBeGreaterThanOrEqual(P.minLabel);
    expect(P.rate).toBeLessThanOrEqual(P.maxLabel);
    expect(NAME.toLowerCase()).toContain(P.descriptionKey);
    expect(migration.LINE).toBe(`${NAME} — ${P.rate} ${P.rateUnit} per 1,000 sq ft, hose`);
  });

  test('the catalog spec: a liquid 0-0-K fertilizer with no price and no vendor, approved with plain copy', () => {
    const { CATALOG } = migration;
    expect(CATALOG).toMatchObject({
      name: NAME, category: 'fertilizer', formulation: 'liquid', container_size: P.containerSize, unit_size_oz: P.unitSizeOz,
      analysis_n: 0, analysis_p: 0, analysis_k: P.analysisK, default_rate_per_1000: P.rate, min_label_rate_per_1000: P.minLabel, max_label_rate_per_1000: P.maxLabel,
      rate_unit: 'fl_oz', inventory_unit: 'fl_oz', label_url: P.labelUrl, active_ingredient: P.activeIngredient, manufacturer: P.manufacturer,
      approved_for_service_report: true, siteone_sku: P.siteoneSku, signal_word: P.signalWord, ppe_text: P.ppeText, display_name: P.displayName,
    });
    for (const field of ['best_price', 'best_vendor', 'cost_per_unit', 'cost_unit', 'needs_pricing']) expect(CATALOG).not.toHaveProperty(field);
    expect(migration.INSERT_DEFAULTS).toEqual({ active: true, needs_pricing: true, content_status: 'draft', customer_visibility: 'internal_only' });
    expect(CATALOG.name.length).toBeLessThanOrEqual(150);
    expect(CATALOG.display_name.length).toBeLessThanOrEqual(80);
    expect(CATALOG.label_source_note).toBe(P.labelSourceNote);
    expect(CATALOG.compatibility_notes).toBe(P.compatibilityNote);
    if (P.sdsUrl) expect(CATALOG.sds_url).toBe(P.sdsUrl); else expect(CATALOG).not.toHaveProperty('sds_url');
    expect(CATALOG.service_report_summary).toBe(migration.SUMMARY);
    expect(CATALOG.customer_precaution_summary).toBe(migration.PRECAUTION);
  });

  test('the watering rule is valid, owner-sourced and says no watering change (as K-Flow and Nutra-TECH)', () => {
    const checked = validateRule(migration.WATERING_RULE);
    expect(checked.errors).toEqual([]);
    expect(checked.rule).toMatchObject({ mode: 'none', source: 'owner', verified_by: P.verifiedBy, label_note: P.wateringLabelNote });
    const fixture = require('./fixtures/lawn-watering-rules-v13-2026-10-22.json');
    expect(fixture[NAME]).toEqual({ mode: 'none', source: 'owner' });
    expect(fixture[NAME]).toEqual(fixture['LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer']);
  });

  test('the report freezes the product as a fertilizer with the rule and the approved liquid fertilizer wording', () => {
    const facts = approvedReportProductFacts({ ...migration.CATALOG, post_application_watering: migration.WATERING_RULE });
    expect(facts).toMatchObject({ productType: 'fertilizer', name: NAME, serviceReportSummary: migration.SUMMARY, precautionSummary: migration.PRECAUTION });
    expect(facts.wateringRule).toMatchObject({ mode: 'none' });
  });

  test('every track: August and September list the product on its own line after Nutra-TECH', () => {
    for (const grass of Object.keys(v13Recipe)) {
      for (const month of ['Aug', 'Sep']) {
        const lines = visit(grass, month).primary.split('\n');
        expect(lines).toEqual([`${NUTRA} — 12 fl oz per 1,000 sq ft, hose`, migration.LINE]);
        expect(engine.parseVisitNutrientTargets(visit(grass, month).notes).targetNPer1000).toBe(0);
        expect(visit(grass, month).notes).toMatch(/^N rate: 0 lb N\./);
        expect(visit(grass, month).notes).toMatch(/No N or P from June 1 through September 30\./);
        expect(visit(grass, month).notes).toContain(P.visitSkip);
        expect(visit(grass, month).notes).toContain('North Port: skip the Nutra-TECH micronutrients and the Nutra-TECH potassium on this visit until the city confirms.');
        const parsed = engine.parseProtocolLines(visit(grass, month).primary, 'base', { exactName: true });
        expect(parsed.map((line) => line.scope)).toEqual(['BROADCAST_FULL', 'BROADCAST_FULL']);
      }
      // No other visit lists it, and the 9x cadence variant (April only) is untouched.
      for (const other of v13Recipe[grass].visits.filter((v) => !['Aug', 'Sep'].includes(v.month))) {
        expect(`${other.primary}\n${other.secondary}`).not.toContain(NAME);
      }
      expect(visitForCadence(visit(grass, 'Aug'), 9).visit).toBe(visit(grass, 'Aug'));
    }
  });

  test('the track text is unchanged: "no Nutra-TECH" in North Port already covers both Nutra-TECH products', () => {
    for (const grass of Object.keys(v13Recipe)) {
      expect(v13Recipe[grass].notes.find((line) => line.startsWith('North Port: no Nutra-TECH'))).toMatch(/June, August and September visits until the city confirms\. The April Nutra-TECH pass stays\. The plan holds/);
      expect(v13Recipe[grass].safety_rules.find((line) => line.startsWith('North Port: no Nutra-TECH'))).toBe('North Port: no Nutra-TECH June through September until the city confirms.');
      // June has no potassium row, so its note keeps the short sentence.
      expect(visit(grass, 'Jun').notes).toContain('North Port: skip Nutra-TECH on this visit until the city confirms.');
      expect(visit(grass, 'Jun').primary).not.toContain(NAME);
    }
  });

  test('the readers: potassium family, readiness list, pricing import with no price, schedule description', () => {
    expect(PRODUCT_CLASS.get(normalizeProductName(NAME))).toMatchObject({ family: FAMILY.POTASSIUM });
    const inventory = fs.readFileSync(path.join(__dirname, '../routes/admin-inventory.js'), 'utf8');
    expect(inventory).toContain(`'${NAME}', 'fertilizer', 'potassium support']`);
    const { parse } = require('csv-parse/sync');
    const rows = parse(fs.readFileSync(path.join(__dirname, '../data/pricing.csv'), 'utf8'), { columns: true, skip_empty_lines: true, relax_column_count: true });
    const hits = rows.filter((row) => row.Product === NAME);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ Product: NAME, Vendor: 'SiteOne', Size: P.containerSize, Price: '', 'Unit Price': '', Category: 'Fertilizer' });
    expect(hits[0].Status).toBe('Added for lawn program v13 summer potassium (owner 2026-10-29; SiteOne 511644, Available by Request); price set in Inventory');
    const page = fs.readFileSync(path.join(__dirname, '../../client/src/pages/admin/SchedulePage.jsx'), 'utf8');
    expect(page).toContain(`"${P.descriptionKey}":\n    "potassium that helps the lawn handle summer heat and stress",`);
  });

  // The product name starts like the T&O micronutrient package, so every name-keyed reader is checked for a lump-in.
  test('name traps: no broader key, pattern or family takes the product for the Nutra-TECH T&O micronutrient package', () => {
    const T_AND_O = NUTRA;
    // 1. The schedule description map: the first key that matches the line (word-boundary, in map order) is this product's own.
    const page = fs.readFileSync(path.join(__dirname, '../../client/src/pages/admin/SchedulePage.jsx'), 'utf8');
    const block = (start) => page.slice(page.indexOf(start), page.indexOf('\n};', page.indexOf(start)));
    const keysOf = (text) => [...text.matchAll(/^\s+"?([a-z0-9][^":\n]*?)"?:/gm)].map((m) => m[1]);
    const order = [...new Set([...keysOf(block('const PRODUCT_DESCRIPTIONS = {')), ...keysOf(block('const PRODUCT_DESCRIPTIONS_V13 = {'))])];
    const firstKey = (line) => order.find((key) => new RegExp(`(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(line.toLowerCase()));
    expect(firstKey(migration.LINE)).toBe(P.descriptionKey);
    expect(firstKey(`${T_AND_O} \u2014 12 fl oz per 1,000 sq ft, hose`)).not.toBe(P.descriptionKey);
    // 2. Expectations: the exact name maps to potassium; the micronutrient package keeps its own family.
    expect(PRODUCT_CLASS.get(normalizeProductName(NAME)).family).toBe(FAMILY.POTASSIUM);
    expect(PRODUCT_CLASS.get(normalizeProductName(T_AND_O)).family).toBe(FAMILY.IRON_MICROS);
    // 3. The report wording: a fertilizer, not a supplement (the "micro" and "iron" word tests do not hit the name).
    const { classifyProduct } = require('../services/service-report/lawn-report-v2');
    expect(classifyProduct({ product: { name: NAME, category: migration.CATALOG.category, active_ingredient: P.activeIngredient } }).kind).toBe('fertilizer');
    expect(classifyProduct({ product: { name: T_AND_O, category: 'fertilizer' } }).kind).toBe('supplement');
    // 4. The email division reads the recorded ingredient and the "0-0-" analysis: nutrition, the same family as K-Flow.
    const { classifyProduct: classifyForEmail } = require('../services/email-division/visit-products');
    expect(classifyForEmail({ name: NAME, active_ingredient: P.activeIngredient, category: 'fertilizer' })).toBe(classifyForEmail({ name: 'LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer', active_ingredient: 'Potassium', category: 'fertilizer' }));
    // 5. The plan matches each recipe line to its own catalog row by exact name, whichever way the catalog is ordered.
    const catalog = [{ id: 'a', name: T_AND_O, active: true }, { id: 'b', name: NAME, active: true }];
    for (const rows of [catalog, [...catalog].reverse()]) {
      const lines = engine.parseProtocolLines(visit('bermuda', 'Aug').primary, 'base', { exactName: true });
      expect(lines.map((line) => engine.matchCatalogProduct(line, rows).name)).toEqual([T_AND_O, NAME]);
    }
  });
});

describe('summer potassium: the customer outline', () => {
  afterEach(() => { delete process.env.GATE_LAWN_V13; delete process.env.GATE_LAWN_OUTLINE_V13; });

  test('August and September read as the micronutrient pass, with no Fertilizer step drawn for the 0-0-K analysis', () => {
    process.env.GATE_LAWN_V13 = 'true';
    process.env.GATE_LAWN_OUTLINE_V13 = 'true';
    const { customerProtocolBullets } = require('../services/lawn-service-outline');
    for (const grass of Object.keys(v13Recipe)) {
      for (const month of ['Aug', 'Sep']) {
        const withPotassium = customerProtocolBullets(visit(grass, month));
        const nutraOnly = customerProtocolBullets({ ...visit(grass, month), primary: visit(grass, month).primary.split('\n')[0] });
        expect(withPotassium).toEqual(nutraOnly);
        expect(withPotassium.join(' ')).toMatch(/Micronutrients/);
        expect(withPotassium.join(' ')).not.toMatch(/Fertilizer and nutrition/);
      }
    }
  });
});

describe('summer potassium: North Port holds the row exactly as it holds Nutra-TECH', () => {
  test('the gates match the Nutra-TECH rows of the same window, plus nothing the Nutra-TECH row lacks', () => {
    const stagedNutra = (windowKey) => staged.PRODUCTS.find(([key, spec]) => key === windowKey && spec[0] === NUTRA)[1][7];
    for (const windowSpec of migration.WINDOWS) {
      const nutraGates = { ...stagedNutra(windowSpec.key), northPortProductWindow: true }; // 20261007150000 adds the key
      expect(windowSpec.gates).toEqual(nutraGates);
      expect(fieldRules.NORTH_PORT_WINDOWS).toContain(windowSpec.key);
    }
    expect(migration.WINDOWS.map((w) => w.key)).toEqual([migration.AUG_WINDOW, migration.SEP_WINDOW]);
    expect(migration.WINDOWS[1].gates.holdForTropicalWatch).toBe(true);
    expect(migration.WINDOWS[0].gates).not.toHaveProperty('holdForTropicalWatch');
  });

  test('the plan holds the row back in North Port (not selected, no amount) and not elsewhere', () => {
    const rows = new Map([['k', { gates: migration.WINDOWS[0].gates }], ['nt', { gates: { requiresZeroNP: true, northPortProductWindow: true } }]]);
    const items = [{ product: { id: 'k' }, selected: true }, { product: { id: 'nt' }, selected: true }];
    const held = engine.holdNorthPortProducts(items, rows, 'North Port');
    expect(held.map((item) => [item.selected, item.selectionReason])).toEqual([[false, 'north_port_product_window'], [false, 'north_port_product_window']]);
    expect(engine.holdNorthPortProducts(items, rows, 'Parrish')).toEqual(items);
    expect(engine.v13NorthPortHold(rows.get('k'), 'North Port')).toBe(true);
    expect(engine.v13NorthPortHold(rows.get('k'), 'Sarasota')).toBe(false);
    expect(engine.v13GateNotes(migration.WINDOWS[1].gates, { municipality: 'North Port' }).map((n) => n.key)).toEqual(expect.arrayContaining(['northPortProductWindow', 'holdForTropicalWatch']));
  });

  test('the ordinance check cannot see it (no N or P), so the row key is the whole rule', () => {
    const northPort = { jurisdiction_name: 'North Port', restricted_nitrogen: true, restricted_phosphorus: true, restricted_start_month: 4, restricted_start_day: 1, restricted_end_month: 9, restricted_end_day: 30 };
    const product = { id: 'k', name: NAME, analysis_n: 0, analysis_p: 0, analysis_k: P.analysisK };
    const status = engine.summarizeOrdinanceStatus({ date: new Date('2027-08-12T16:00:00Z'), ordinances: [northPort], candidateItems: [{ product }] });
    expect(status.blocks).toEqual([]);
  });
});

// ── a small in-memory knex ───────────────────────────────────────────────────

function fakeKnex(seed = {}) {
  const tables = {
    products_catalog: [], product_aliases: [], lawn_protocols: [], lawn_protocol_windows: [], lawn_protocol_products: [],
    lawn_protocol_audit_log: [], scheduled_services: [], lawn_protocol_service_completions: [], product_limits: [], ...seed,
  };
  let next = 1;
  const matches = (row, filters) => filters.length === 0 || filters.some((group) => group.every(([k, v]) => String(row[k]) === String(v)));
  const knex = (name) => {
    expect(tables).toHaveProperty(name);
    const groups = [];
    let sort = null;
    const rowsNow = () => {
      const hit = tables[name].filter((row) => matches(row, groups));
      return sort ? [...hit].sort((a, b) => Number(a[sort]) - Number(b[sort])) : hit;
    };
    const builder = {
      where(a, b) {
        const pairs = typeof a === 'object' ? Object.entries(a) : [[a, b]];
        if (groups.length === 0) groups.push(pairs); else groups.forEach((g) => g.push(...pairs));
        return builder;
      },
      orWhere(a) { groups.push(Object.entries(a)); return builder; },
      orderBy(column) { sort = column; return builder; },
      select(...columns) {
        const out = rowsNow().map((row) => (columns.length ? Object.fromEntries(columns.map((c) => [c, row[c]])) : { ...row }));
        return Promise.resolve(out);
      },
      async first(...columns) {
        const [row] = rowsNow();
        if (!row) return undefined;
        return columns.length ? Object.fromEntries(columns.map((c) => [c, row[c]])) : { ...row };
      },
      insert(values) {
        const list = Array.isArray(values) ? values : [values];
        const made = list.map((value) => {
          const row = { id: `id-${next++}`, ...value };
          tables[name].push(row);
          return row;
        });
        const result = Promise.resolve(made.map(({ id }) => ({ id })));
        result.returning = () => Promise.resolve(made.map(({ id }) => ({ id })));
        return result;
      },
      async update(values) {
        const hit = rowsNow();
        hit.forEach((row) => Object.assign(row, values));
        return hit.length;
      },
      async del() {
        const hit = new Set(rowsNow());
        tables[name] = tables[name].filter((row) => !hit.has(row));
        return hit.size;
      },
      async columnInfo() {
        const columns = new Set(['id', 'created_at', 'updated_at', ...Object.keys(migration.CATALOG), ...Object.keys(migration.INSERT_DEFAULTS), 'best_price', 'best_vendor', 'cost_per_unit', 'cost_unit']);
        return Object.fromEntries([...columns].map((c) => [c, {}]));
      },
    };
    return builder;
  };
  knex.fn = { now: () => 'now()' };
  knex.schema = { hasTable: async (t) => t in tables };
  knex.raw = async () => ({ rows: tables.product_limits.length ? [{ tbl: 'product_limits', col: 'product_id' }] : [] });
  knex.tables = () => tables;
  return knex;
}

const json = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
const NUTRA_GATES = {
  aug_v13_hose_blackout: { requiresZeroNP: true, northPortProductWindow: true },
  sep_v13_hose_blackout: { requiresZeroNP: true, holdForTropicalWatch: true, northPortProductWindow: true },
};

// Two v13 protocols with their August and September windows: Nutra-TECH, then Artavia and Acelepryn spot rows.
function seeded() {
  const knex = fakeKnex();
  const t = knex.tables();
  for (const key of ['fixture_a', 'fixture_b']) {
    t.lawn_protocols.push({ id: `p-${key}`, protocol_key: key, version: V13 });
    let sort = key === 'fixture_a' ? 100 : 500;
    for (const [windowKey, gates] of Object.entries(NUTRA_GATES)) {
      const windowId = `w-${key}-${windowKey}`;
      t.lawn_protocol_windows.push({ id: windowId, lawn_protocol_id: `p-${key}`, window_key: windowKey });
      for (const [product, role, defaultInPlan, rowGates] of [[NUTRA, 'micronutrients', true, gates], ['Artavia 2 SC (Azoxy)', 'fungicide_spot', false, { trigger: 'x' }], ['Acelepryn Insecticide', 'insecticide_spot', false, { trigger: 'y' }]]) {
        sort += 1;
        t.lawn_protocol_products.push({
          id: `r-${key}-${windowKey}-${sort}`, lawn_protocol_window_id: windowId, product_id: null, product_name: product, role,
          application_mode: defaultInPlan ? 'broadcast' : 'spot', rate_per_1000: defaultInPlan ? 12 : null, rate_unit: 'fl oz', carrier_gal_per_1000: 1,
          default_in_plan: defaultInPlan, gates: JSON.stringify(rowGates), annual_counter: '{}', mixing: '{}', report_copy: JSON.stringify({ role }), sort_order: sort,
        });
      }
    }
  }
  return knex;
}
const ours = (knex, windowKey) => knex.tables().lawn_protocol_products.filter((r) => r.product_name === NAME && (!windowKey || r.lawn_protocol_window_id.endsWith(windowKey)));
const order = (knex, key, windowKey) => knex.tables().lawn_protocol_products
  .filter((r) => r.lawn_protocol_window_id === `w-${key}-${windowKey}`).sort((a, b) => a.sort_order - b.sort_order).map((r) => r.product_name);
const snapshot = (knex) => JSON.parse(JSON.stringify(knex.tables()));

describe('summer potassium migration (in-memory knex)', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  test('up: one catalog row, no price, and a row in the August and September window of every v13 protocol, right after Nutra-TECH', async () => {
    const knex = seeded();
    await migration.up(knex);
    const catalog = knex.tables().products_catalog;
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ name: NAME, active: true, needs_pricing: true, content_status: 'draft', customer_visibility: 'internal_only', approved_for_service_report: true, analysis_k: P.analysisK });
    for (const field of ['best_price', 'best_vendor', 'cost_per_unit', 'cost_unit']) expect(catalog[0][field]).toBeUndefined();
    expect(json(catalog[0].post_application_watering)).toEqual(migration.WATERING_RULE);
    const rows = ours(knex);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const gatesFor = Object.entries(NUTRA_GATES).find(([key]) => row.lawn_protocol_window_id.endsWith(key))[1];
      expect(row).toMatchObject({ product_id: catalog[0].id, role: 'potassium', application_mode: 'broadcast', rate_per_1000: P.rate, rate_unit: P.rateUnit, carrier_gal_per_1000: 1, default_in_plan: true });
      expect(json(row.gates)).toEqual(gatesFor);
      expect(json(row.report_copy)).toEqual({ role: 'potassium' });
    }
    for (const key of ['fixture_a', 'fixture_b']) {
      for (const windowKey of Object.keys(NUTRA_GATES)) {
        expect(order(knex, key, windowKey)).toEqual([NUTRA, NAME, 'Artavia 2 SC (Azoxy)', 'Acelepryn Insecticide']);
        const places = knex.tables().lawn_protocol_products.filter((r) => r.lawn_protocol_window_id === `w-${key}-${windowKey}`).map((r) => r.sort_order);
        expect(new Set(places).size).toBe(places.length);
      }
    }
  });

  test('audit: one row per protocol with the inserted rows and moves, and one catalog row naming the product', async () => {
    const knex = seeded();
    await migration.up(knex);
    const logs = knex.tables().lawn_protocol_audit_log;
    expect(logs.filter((l) => l.action === migration.ACTION)).toHaveLength(2);
    expect(logs.filter((l) => l.action === migration.CATALOG_ACTION)).toHaveLength(1);
    const [first] = logs.filter((l) => l.action === migration.ACTION).map((l) => json(l.after_snapshot));
    expect(first.rows).toHaveLength(2);
    expect(first.shifted).toHaveLength(4);
    expect(json(logs.find((l) => l.action === migration.CATALOG_ACTION).after_snapshot)).toMatchObject({ productId: knex.tables().products_catalog[0].id });
    for (const action of logs.map((l) => l.action)) expect(action.length).toBeLessThanOrEqual(96);
  });

  test('a window that already has the product, or has no Nutra-TECH row, is skipped; no v13 protocol writes nothing', async () => {
    const skipped = seeded();
    const t = skipped.tables();
    t.lawn_protocol_products = t.lawn_protocol_products.filter((r) => !(r.product_name === NUTRA && r.lawn_protocol_window_id === 'w-fixture_a-aug_v13_hose_blackout'));
    await migration.up(skipped);
    expect(ours(skipped, 'aug_v13_hose_blackout').map((r) => r.lawn_protocol_window_id)).toEqual(['w-fixture_b-aug_v13_hose_blackout']);
    expect(ours(skipped, 'sep_v13_hose_blackout')).toHaveLength(2);

    const none = fakeKnex();
    await migration.up(none);
    expect(none.tables().products_catalog).toEqual([]);
    expect(none.tables().lawn_protocol_audit_log).toEqual([]);
  });

  test.each([
    ['a correct active row', { active: true }],
    ['an inactive row', { active: false }],
    ['a bare name-only row', {}],
  ])('a catalog row that already has the name (%s): up throws and writes nothing', async (_label, extra) => {
    const knex = seeded();
    knex.tables().products_catalog.push({ id: 'old', name: NAME.toUpperCase().replace(/ /g, '  '), ...extra });
    const before = snapshot(knex);
    await expect(migration.up(knex)).rejects.toThrow(/already exists; this migration only inserts/);
    expect(snapshot(knex)).toEqual(before);
  });

  test('an alias-only match throws', async () => {
    const knex = seeded();
    knex.tables().products_catalog.push({ id: 'other', name: 'Some Other Potassium' });
    knex.tables().product_aliases.push({ product_id: 'other', alias_name: NAME });
    await expect(migration.up(knex)).rejects.toThrow(/already exists/);
    expect(knex.tables().lawn_protocol_products.filter((r) => r.product_name === NAME)).toEqual([]);
  });

  test('re-running after a no-op rollback finds its own row and adds nothing', async () => {
    const knex = seeded();
    await migration.up(knex);
    knex.tables().scheduled_services.push({ id: 's', lawn_protocol_key: 'fixture_a', lawn_protocol_version: V13 });
    await migration.down(knex); // a no-op: a visit references v13
    const once = snapshot(knex);
    await migration.up(knex);
    expect(snapshot(knex)).toEqual(once);
  });

  test('down: clean up then down is the starting state exactly', async () => {
    const knex = seeded();
    const start = snapshot(knex);
    await migration.up(knex);
    await migration.down(knex);
    const strip = (state) => ({ ...state, lawn_protocol_products: state.lawn_protocol_products.map(({ updated_at: _u, ...rest }) => rest) });
    expect(strip(snapshot(knex))).toEqual(strip(start));
  });

  test('down: a visit or a completion that references ANY v13 protocol makes it a full no-op', async () => {
    for (const reference of [
      (t) => t.scheduled_services.push({ id: 's', lawn_protocol_key: 'fixture_b', lawn_protocol_version: V13 }),
      (t) => t.lawn_protocol_service_completions.push({ id: 'c', lawn_protocol_id: 'p-fixture_a', protocol_key: 'fixture_a', protocol_version: V13 }),
    ]) {
      const knex = seeded();
      await migration.up(knex);
      reference(knex.tables());
      const upped = snapshot(knex);
      await migration.down(knex);
      expect(snapshot(knex)).toEqual(upped);
    }
  });

  test.each([
    ['re-rated', () => ({ rate_per_1000: P.rate + 1 })],
    ['re-gated', (row) => ({ gates: JSON.stringify({ ...json(row.gates), extra: true }) })],
    ['lost its North Port key', (row) => ({ gates: JSON.stringify({ requiresZeroNP: true }) })],
    ['moved', () => ({ sort_order: 9999 })],
    ['renamed', () => ({ product_name: 'Renamed by staff' })],
    ['switched off the default', () => ({ default_in_plan: false })],
  ])('one inserted row %s makes down a full no-op (no other row is reverted, the catalog row stays)', async (_label, change) => {
    const knex = seeded();
    await migration.up(knex);
    Object.assign(ours(knex)[0], change(ours(knex)[0]));
    const edited = snapshot(knex);
    await migration.down(knex);
    expect(snapshot(knex)).toEqual(edited);
  });

  test('an inserted row staff deleted makes down a full no-op', async () => {
    const knex = seeded();
    await migration.up(knex);
    const [gone] = ours(knex);
    knex.tables().lawn_protocol_products = knex.tables().lawn_protocol_products.filter((r) => r !== gone);
    const edited = snapshot(knex);
    await migration.down(knex);
    expect(snapshot(knex)).toEqual(edited);
  });

  test('down puts a moved row back only while it still reads the place up gave it', async () => {
    const knex = seeded();
    await migration.up(knex);
    const artavia = knex.tables().lawn_protocol_products.find((r) => r.id.startsWith('r-fixture_a-aug_v13_hose_blackout') && r.product_name === 'Artavia 2 SC (Azoxy)');
    const acelepryn = knex.tables().lawn_protocol_products.find((r) => r.id.startsWith('r-fixture_a-aug_v13_hose_blackout') && r.product_name === 'Acelepryn Insecticide');
    expect([artavia.sort_order, acelepryn.sort_order]).toEqual([103, 104]);
    acelepryn.sort_order = 777; // staff moved it
    await migration.down(knex);
    expect(ours(knex)).toEqual([]);
    expect([artavia.sort_order, acelepryn.sort_order]).toEqual([102, 777]);
  });

  test.each([
    ['priced', { best_price: 41 }],
    ['marked priced', { needs_pricing: false }],
    ['published', { content_status: 'approved_for_portal' }],
    ['made public', { customer_visibility: 'public' }],
    ['re-rated', { default_rate_per_1000: P.rate + 1 }],
    ['given a stray analysis', { analysis_n: 3 }],
  ])('a catalog row staff %s is kept with its audit row; the staged rows still go, and up() runs again', async (_label, change) => {
    const knex = seeded();
    await migration.up(knex);
    Object.assign(knex.tables().products_catalog[0], change);
    await migration.down(knex);
    expect(ours(knex)).toEqual([]);
    expect(knex.tables().products_catalog).toHaveLength(1);
    // The catalog audit row stays with the kept row; the per-protocol audit rows go with the staged rows.
    expect(knex.tables().lawn_protocol_audit_log.map((log) => log.action)).toEqual([migration.CATALOG_ACTION]);
    // A later up() knows the row is its own: no "already exists" throw, no second catalog row, the staged rows come back.
    await migration.up(knex);
    expect(knex.tables().products_catalog).toHaveLength(1);
    expect(ours(knex).length).toBeGreaterThan(0);
  });

  test('a catalog row something references (an application limit) is kept; the staged rows still go', async () => {
    const knex = seeded();
    await migration.up(knex);
    knex.tables().product_limits.push({ id: 'l', product_id: knex.tables().products_catalog[0].id });
    await migration.down(knex);
    expect(ours(knex)).toEqual([]);
    expect(knex.tables().products_catalog).toHaveLength(1);
    expect(knex.tables().lawn_protocol_audit_log.map((log) => log.action)).toEqual([migration.CATALOG_ACTION]);
    await expect(migration.up(knex)).resolves.toBeUndefined();
    expect(knex.tables().products_catalog).toHaveLength(1);
  });
});

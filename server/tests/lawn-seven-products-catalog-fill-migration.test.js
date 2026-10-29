// The seven lawn products the 2026-10-28 garage count added get their label data (label and SDS links, lawn rates,
// target pests, label note, service lines), and three label corrections (owner 2026-10-29, "fill the gaps on these").
// No database: a small fake knex.
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20261029060000_lawn_seven_products_catalog_fill');
const newProducts = require('../models/migrations/20261029030000_lawn_new_products_rules_and_approvals');
const surfactant = require('../models/migrations/20261029040000_lawn_surfactant_rule_and_approval');
const imidacloprid = require('../models/migrations/20261029050000_lawn_imidacloprid_2f_rule_and_approval');
const { SERVICE_LINE_IDS } = require('../services/service-report/service-line-configs');
const { rulesForTargets } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
const { approvedReportProductFacts } = require('../services/service-report/report-data');

const DIMENSION = { name: 'LESCO Dimension 18-0-10', rule: { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 336, source: 'owner' } };
const IMID = 'Quali-Pro Imidacloprid 2F T&O';
const MICRO = 'LESCO Spar-TECH Micro Mix';
const THIRTEEN = 'LESCO Spar-TECH 13-0-0';
const ANDERSONS = 'The Andersons 17-0-3 Fertilizer with Grubout Plus';
const THURICIDE = 'Thuricide BT Caterpillar Control';

// The seven rows as production held them on 2026-10-29 (catalog fields only).
const LIVE = {
  [ANDERSONS]: { category: 'insecticide', epa_reg_number: '228-610-9198', active_ingredient: 'Imidacloprid 0.20% + Lambda-cyhalothrin 0.04%', label_url: 'https://assets.theandersons.com/m/769d028ced11dbd9/original/10007777_17-0-3-GrubOut-Plus-pdf.pdf', service_lines: ['lawn'], unit_size_oz: '288.00' },
  [MICRO]: { category: 'fertilizer', epa_reg_number: 'N/A', active_ingredient: 'Micronutrient mix (analysis pending label read)' },
  [THIRTEEN]: { category: 'fertilizer', epa_reg_number: 'N/A', active_ingredient: '13-0-0 with 6% Fe, 1% Mn (per SiteOne listing)' },
  [THURICIDE]: { category: 'insecticide', epa_reg_number: '70051-106-829', active_ingredient: 'Bacillus thuringiensis subsp. kurstaki strain SA-12 98.35%' },
  'Blue Planet Nutrients Liquid Seaweed .3-.2-1': { category: 'fertilizer', epa_reg_number: 'N/A', active_ingredient: 'Liquid seaweed (kelp) .3-.2-1' },
  'Southern Ag Surfactant for Herbicides (Non-Ionic)': { category: 'adjuvant', epa_reg_number: 'N/A', active_ingredient: 'Nonionic surfactant (wetting agent, spreader, penetrant)' },
  [IMID]: { category: 'insecticide', epa_reg_number: '66222-203', active_ingredient: 'Imidacloprid 21.4% (2 lb/gal)', label_url: 'https://www3.epa.gov/pesticides/chem_search/ppls/066222-00203-20131203.pdf' },
};
const FILL_COLUMNS = [...new Set(migration.ITEMS.flatMap((item) => Object.keys(item.fill)))];
const COLUMNS = ['id', 'name', 'category', 'epa_reg_number', 'active_ingredient', 'unit_size_oz', ...FILL_COLUMNS,
  'label_verified_at', 'label_verified_by', 'updated_at'];

// The report fields the three earlier migrations wrote (rule, approval, copy), by product name.
function reportFields() {
  const out = {};
  const values = (fields) => Object.fromEntries(Object.entries(fields).map(([column, { value }]) => [column, value]));
  for (const item of newProducts.ITEMS) out[item.name] = values(item.fields);
  out[surfactant.NAME] = values(surfactant.FIELDS);
  out[imidacloprid.NAME] = values(imidacloprid.FIELDS);
  return out;
}

function liveRows(overrides = {}) {
  return Object.entries(LIVE).map(([name, row], i) => {
    const base = Object.fromEntries(COLUMNS.map((column) => [column, null]));
    return { ...base, id: `id-${i}`, name, ...row, ...(overrides[name] || {}) };
  });
}

function fakeKnex({ rows, columns = COLUMNS, tables = ['products_catalog', 'audit_log'] }) {
  const table = rows.map((row) => ({ ...row }));
  const knex = (name) => {
    expect(name).toBe('products_catalog');
    const filters = [];
    const builder = {
      where(a, b) {
        if (typeof a === 'object') Object.entries(a).forEach(([k, v]) => filters.push((r) => r[k] === v));
        else filters.push((r) => r[a] === b);
        return builder;
      },
      whereNull(column) { filters.push((r) => r[column] == null); return builder; },
      select() { return Promise.resolve(table.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }))); },
      async update(values) {
        Object.keys(values).forEach((column) => expect(columns).toContain(column));
        const hit = table.filter((r) => filters.every((f) => f(r)));
        hit.forEach((r) => Object.assign(r, values));
        return hit.length;
      },
    };
    return builder;
  };
  knex.fn = { now: () => 'now()' };
  knex.schema = {
    hasTable: async (t) => tables.includes(t),
    hasColumn: async (t, c) => t === 'products_catalog' && columns.includes(c),
  };
  knex.table = table;
  return knex;
}
const byName = (knex, name) => knex.table.find((r) => r.name === name);
const parsed = (v) => (typeof v === 'string' && /^[[{]/.test(v) ? JSON.parse(v) : v);

beforeEach(() => {
  recordAuditEvent.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('the label data is well formed and leaves pack size and prices alone', () => {
  expect(migration.ITEMS.map((item) => item.name).sort()).toEqual(Object.keys(LIVE).sort());
  for (const { name, fill } of migration.ITEMS) {
    expect(Object.keys(fill).filter((c) => /price|vendor|unit_size|container|cost/.test(c))).toEqual([]);
    for (const column of ['label_url', 'sds_url']) if (fill[column]) expect(fill[column]).toMatch(/^https:\/\/\S+$/);
    if (fill.default_rate_per_1000 != null) {
      expect(['fl_oz', 'lb', 'oz']).toContain(fill.rate_unit);
      expect(fill.min_label_rate_per_1000).toBeLessThanOrEqual(fill.default_rate_per_1000);
      expect(fill.default_rate_per_1000).toBeLessThanOrEqual(fill.max_label_rate_per_1000);
    }
    if (fill.target_pests) expect(fill.target_pests.every((t) => typeof t === 'string' && t.trim() === t && t)).toBe(true);
    expect(fill.service_lines.every((line) => SERVICE_LINE_IDS.includes(line))).toBe(true);
    expect(fill.label_source_note).toMatch(/^Label read 2026-10-29 \(/);
    expect(fill.label_source_note.length).toBeLessThanOrEqual(600);
    expect(name === THURICIDE ? fill.service_lines : ['lawn']).toEqual(fill.service_lines);
  }
});

test('after the fill every product still builds a customer watering text for each target a tech can log', () => {
  const fields = reportFields();
  const knex = fakeKnex({ rows: liveRows() });
  return migration.up(knex).then(() => {
    for (const name of Object.keys(LIVE)) {
      const row = { ...byName(knex, name), ...fields[name] };
      row.target_pests = parsed(row.target_pests);
      const facts = approvedReportProductFacts(row);
      expect(facts && facts.wateringRule).toBeTruthy();
      const targets = row.target_pests || [];
      const labelTargets = Array.isArray(facts.wateringRule.by_target) ? targets : null;
      const cases = [[], targets.slice(0, 3), targets, ...targets.map((t) => [t])];
      for (const logged of cases) {
        const mine = rulesForTargets(facts.wateringRule, logged, { labelTargets }).map((rule) => ({ name, rule }));
        expect(mine.length).toBeGreaterThan(0);
        for (const rules of [mine, [DIMENSION, ...mine]]) {
          const ins = buildWateringInstruction({ rules, completedAt: '2026-10-28T15:00:00Z', runtime: null, plainWhenNoSetup: true, labelFirst: true });
          expect(ins.state).toBeTruthy();
        }
      }
    }
  });
});

test('fills each empty field and makes the three corrections, one audit row per write; a second run writes nothing', async () => {
  const knex = fakeKnex({ rows: liveRows() });
  const before = knex.table.map((r) => ({ ...r }));
  await migration.up(knex);

  const imid = byName(knex, IMID);
  expect(imid).toMatchObject({ epa_reg_number: '53883-514', label_url: 'https://www.agrian.com/pdfs/Quali-Pro_IMIDACLOPRID_2F_Label.pdf', active_ingredient: 'Imidacloprid 21.8% (2 lb/gal)', rate_unit: 'fl_oz', default_rate_per_1000: 0.46 });
  expect(byName(knex, MICRO).active_ingredient).toBe('2.5%Mg 0.05%Cu 1%Fe 1.3%Mn 0.05%Zn');
  expect(byName(knex, THIRTEEN).active_ingredient).toBe('13-0-0 6%Fe 1%Mn');
  expect(parsed(byName(knex, THURICIDE).service_lines)).toEqual(['tree_shrub']);
  expect(byName(knex, THURICIDE).default_rate_per_1000).toBeNull();
  const andersons = byName(knex, ANDERSONS);
  expect(andersons).toMatchObject({ label_url: LIVE[ANDERSONS].label_url, unit_size_oz: '288.00', rate_unit: 'lb', default_rate_per_1000: 3.3, label_verified_by: 'label-check-2026-10-29' });
  expect(andersons.service_lines).toEqual(['lawn']); // set before: not rewritten
  for (const row of knex.table) expect(row.label_source_note).toMatch(/^Label read 2026-10-29/);

  // Exactly one audit row for each (product, column) the migration changed, carrying the before and after values.
  const changed = [];
  knex.table.forEach((row, i) => {
    for (const column of Object.keys(row)) {
      if (column !== 'updated_at' && JSON.stringify(row[column]) !== JSON.stringify(before[i][column])) changed.push(`${row.name}|${column}`);
    }
  });
  const audited = recordAuditEvent.mock.calls.map(([e]) => `${e.metadata.product}|${e.metadata.column}`);
  expect(audited.sort()).toEqual(changed.sort());
  for (const [e] of recordAuditEvent.mock.calls) {
    const row = knex.table.find((r) => r.name === e.metadata.product);
    expect(parsed(row[e.metadata.column])).toEqual(e.metadata.after);
    expect(e.action).toBe(`migration:20261029060000_lawn_seven_products_catalog_fill:${e.metadata.column}`);
  }

  recordAuditEvent.mockClear();
  await migration.up(knex);
  expect(recordAuditEvent).not.toHaveBeenCalled();
});

test('a value an admin set first stands, corrections included', async () => {
  const knex = fakeKnex({ rows: liveRows({
    [IMID]: { epa_reg_number: '53883-999', active_ingredient: 'Imidacloprid 21.6%', label_url: 'https://example.invalid/label.pdf' },
    [MICRO]: { active_ingredient: 'Micros (admin text)', service_lines: ['pest'], target_pests: ['Admin target'] },
  }) });
  await migration.up(knex);
  expect(byName(knex, IMID)).toMatchObject({ epa_reg_number: '53883-999', active_ingredient: 'Imidacloprid 21.6%', label_url: 'https://example.invalid/label.pdf' });
  expect(byName(knex, MICRO)).toMatchObject({ active_ingredient: 'Micros (admin text)', service_lines: ['pest'], target_pests: ['Admin target'] });
  const written = recordAuditEvent.mock.calls.map(([e]) => `${e.metadata.product}|${e.metadata.column}`);
  for (const key of [`${IMID}|epa_reg_number`, `${IMID}|active_ingredient`, `${IMID}|label_url`, `${MICRO}|active_ingredient`, `${MICRO}|service_lines`, `${MICRO}|target_pests`]) {
    expect(written).not.toContain(key);
  }
});

test('no row, no table, a missing column or no audit_log does not fail; down is a no-op', async () => {
  await expect(migration.up(fakeKnex({ rows: [] }))).resolves.toBeUndefined();
  await expect(migration.up(fakeKnex({ rows: [], tables: [] }))).resolves.toBeUndefined();
  const noSds = fakeKnex({ rows: liveRows().map(({ sds_url, ...row }) => row), columns: COLUMNS.filter((c) => c !== 'sds_url') });
  await migration.up(noSds);
  expect(noSds.table.every((row) => !('sds_url' in row))).toBe(true);
  expect(byName(noSds, IMID).epa_reg_number).toBe('53883-514');
  recordAuditEvent.mockClear();
  const noAudit = fakeKnex({ rows: liveRows(), tables: ['products_catalog'] });
  await migration.up(noAudit);
  expect(recordAuditEvent).not.toHaveBeenCalled();
  expect(byName(noAudit, IMID).epa_reg_number).toBe('53883-514');
  const snapshot = JSON.stringify(noAudit.table);
  await migration.down(noAudit);
  expect(JSON.stringify(noAudit.table)).toBe(snapshot);
});

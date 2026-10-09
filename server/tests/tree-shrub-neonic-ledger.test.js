// T&S yearly neonicotinoid cap per property (GATE_TS_NEONIC_CAP): the share math across Zylam + Safari,
// the separate Merit cap, unsized rows, no bed area, and which ledger rows count. The hold is the sheet's.
// Synthetic data; a table-keyed fake database (the SQL scoping itself is application-limits' own, reused).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');
const knexFactory = require('knex');
const {
  computeNeonicLedger, isTreeShrubLedgerRow, loadNeonicLedgerRows, loadBedSqft, buildNeonicCapContext,
} = require('../services/tree-shrub-neonic-ledger');
const { NEONIC_CAPS, SQFT_PER_ACRE } = require('../config/tree-shrub-neonic-caps');

const ZYLAM = { id: 'cat-zylam', name: 'Zylam Insecticide', active_ingredient: 'Dinotefuran' };
const SAFARI = { id: 'cat-safari', name: 'Safari 20 SG', active_ingredient: 'Dinotefuran 20%' };
const MERIT = { id: 'cat-merit', name: 'Merit 2F', active_ingredient: 'Imidacloprid' };
const ALPINE = { id: 'cat-alpine', name: 'Alpine WSG', active_ingredient: 'Dinotefuran 40.0%' };
const CATALOG = [ZYLAM, SAFARI, MERIT, ALPINE];

// 10,890 sq ft of bed is a quarter acre: Zylam 19.725 fl oz, Safari 10.8 oz, Merit 6.4 fl oz a year.
const BED = SQFT_PER_ACRE / 4;
const row = (product, quantity, unit, extra = {}) => ({
  product_name: product.name, active_ingredient: product.active_ingredient, quantity_applied: quantity, quantity_unit: unit, service_line: 'tree_shrub', ...extra,
});
const entryOf = (ledger, key) => ledger.find((entry) => entry.key === key);

describe('config: the label figures', () => {
  test('per acre per year, with the per-1,000 sq ft figures they come to', () => {
    const per = (shortName) => NEONIC_CAPS.flatMap((cap) => cap.products).find((p) => p.shortName === shortName);
    expect(per('Zylam')).toMatchObject({ unit: 'fl_oz', perAcreYear: 78.9 });
    expect(per('Safari')).toMatchObject({ unit: 'oz', perAcreYear: 43.2 });
    expect(per('Merit')).toMatchObject({ unit: 'fl_oz', perAcreYear: 25.6 });
    expect((78.9 / 43.56).toFixed(3)).toBe('1.811');
    expect((43.2 / 43.56).toFixed(3)).toBe('0.992');
    expect((25.6 / 43.56).toFixed(3)).toBe('0.588');
    for (const cap of NEONIC_CAPS) for (const p of cap.products) expect(p.source).toBeTruthy();
    // Codex r5 #6204: Dominion 2L is the same strength and limit as Merit 2F; Zylam has a count limit too.
    expect(per('Dominion 2L')).toMatchObject({ unit: 'fl_oz', perAcreYear: 25.6 });
    expect(per('Dominion 2L').namePattern.test('Dominion 2L 27.5 oz')).toBe(true);
    expect(per('Zylam').maxApplicationsPerYear).toBe(3);
    expect(per('Safari').maxApplicationsPerYear).toBeUndefined();
  });
});

describe('Codex r5 #6204: the count limit and products with no limit on file', () => {
  const DOMINION = { id: 'cat-dominion', name: 'Dominion 2L 1 gal', active_ingredient: 'Imidacloprid 21.4%' };
  const GENERIC = { id: 'cat-generic', name: 'Generic imidacloprid 75 WSP', active_ingredient: 'Imidacloprid 75%' };
  const zylamOn = (date, qty = 0.5) => row(ZYLAM, qty, 'fl_oz', { application_date: date });
  const zylamCap = (rows) => entryOf(computeNeonicLedger({ rows, bedSqft: BED, catalog: CATALOG }), 'dinotefuran')
    .capByProduct.find((p) => p.productId === 'cat-zylam');

  test('Zylam carries the days it was applied this year against the label\'s three', () => {
    expect(zylamCap([])).toMatchObject({ maxApplications: 3, applicationsUsed: 0 });
    expect(zylamCap([zylamOn('2026-02-01'), zylamOn('2026-05-01'), zylamOn('2026-08-01')])).toMatchObject({ maxApplications: 3, applicationsUsed: 3 });
  });

  test('two rows on one day are one application; an unsized row still counts', () => {
    expect(zylamCap([zylamOn('2026-02-01'), zylamOn('2026-02-01'), zylamOn('2026-05-01', null)]).applicationsUsed).toBe(2);
  });

  test('Safari applications do not spend Zylam\'s count, and Safari has no count limit', () => {
    const dino = entryOf(computeNeonicLedger({
      rows: [row(SAFARI, 1, 'oz', { application_date: '2026-02-01' }), zylamOn('2026-03-01')], bedSqft: BED, catalog: CATALOG,
    }), 'dinotefuran');
    expect(dino.capByProduct.find((p) => p.productId === 'cat-zylam').applicationsUsed).toBe(1);
    expect(dino.capByProduct.find((p) => p.productId === 'cat-safari')).toMatchObject({ maxApplications: null, applicationsUsed: null });
  });

  test('Dominion 2L shares the imidacloprid cap with Merit', () => {
    const imi = entryOf(computeNeonicLedger({
      rows: [row(DOMINION, 3.2, 'fl_oz')], bedSqft: BED, catalog: [MERIT, DOMINION],
    }), 'imidacloprid');
    expect(imi.usedShare).toBeCloseTo(0.5, 6);
    expect(imi.capByProduct.map((p) => [p.productId, p.remainingAmount])).toEqual([['cat-merit', 3.2], ['cat-dominion', 3.2]]);
    expect(imi.uncapped).toEqual([]);
  });

  test('a catalog product of a capped ingredient with no strength on file is named as uncapped, never dropped', () => {
    const ledger = computeNeonicLedger({ rows: [], bedSqft: BED, catalog: [...CATALOG, GENERIC] });
    expect(entryOf(ledger, 'imidacloprid').uncapped).toEqual([{ productId: 'cat-generic', name: 'Generic imidacloprid 75 WSP' }]);
    expect(entryOf(ledger, 'dinotefuran').uncapped).toEqual([{ productId: 'cat-alpine', name: 'Alpine WSG' }]);
    expect(entryOf(computeNeonicLedger({ rows: [], bedSqft: null, catalog: [GENERIC] }), 'imidacloprid').uncapped).toHaveLength(1);
  });

  test('only Merit 2F takes the 2F amount; another Merit formulation is uncapped (pre-push audit)', () => {
    const wsp = { id: 'cat-wsp', name: 'Merit 75 WSP', active_ingredient: 'Imidacloprid 75%' };
    const imi = entryOf(computeNeonicLedger({ rows: [row(wsp, 1.6, 'oz')], bedSqft: BED, catalog: [MERIT, wsp] }), 'imidacloprid');
    expect(imi).toMatchObject({ usedShare: 0, unsized: 1 });
    expect(imi.capByProduct.map((p) => p.productId)).toEqual(['cat-merit']);
    expect(imi.uncapped).toEqual([{ productId: 'cat-wsp', name: 'Merit 75 WSP' }]);
  });

  test('a trunk-injection product is named as injection, and its rows are not bed applications', () => {
    const ima = { id: 'cat-ima', name: 'Arborjet Ima-Jet 10', active_ingredient: 'Imidacloprid 10%' };
    const imi = entryOf(computeNeonicLedger({ rows: [row(ima, 40, 'ml')], bedSqft: BED, catalog: [MERIT, ima] }), 'imidacloprid');
    expect(imi).toMatchObject({ usedShare: 0, unsized: 0 });
    expect(imi.uncapped).toEqual([{ productId: 'cat-ima', name: 'Arborjet Ima-Jet 10', injection: true }]);
  });

  test('the ledger query reads the application date', async () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/tree-shrub-neonic-ledger.js'), 'utf8');
    expect(src).toMatch(/'pah\.quantity_applied', 'pah\.quantity_unit', 'pah\.application_date'/);
  });
});

describe('computeNeonicLedger', () => {
  test('yearly amounts scale to the bed area', () => {
    const dino = entryOf(computeNeonicLedger({ rows: [], bedSqft: BED, catalog: CATALOG }), 'dinotefuran');
    expect(dino.capByProduct.map(({ name, unit, yearlyAmount, remainingAmount }) => ({ name, unit, yearlyAmount, remainingAmount }))).toEqual([
      { name: 'Zylam', unit: 'fl_oz', yearlyAmount: 19.725, remainingAmount: 19.725 },
      { name: 'Safari', unit: 'oz', yearlyAmount: 10.8, remainingAmount: 10.8 },
    ]);
    expect(dino).toMatchObject({ usedShare: 0, unsized: 0, reason: null });
  });

  test('Zylam and Safari add up as shares of ONE dinotefuran cap', () => {
    // Half the Zylam year (9.8625 fl oz) + a quarter of the Safari year (2.7 oz) = 0.75 used.
    const dino = entryOf(computeNeonicLedger({
      rows: [row(ZYLAM, 9.8625, 'fl_oz'), row(SAFARI, 2.7, 'oz')], bedSqft: BED, catalog: CATALOG,
    }), 'dinotefuran');
    expect(dino.usedShare).toBeCloseTo(0.75, 6);
    const left = Object.fromEntries(dino.capByProduct.map((p) => [p.name, p.remainingAmount]));
    expect(left).toEqual({ Zylam: 4.9313, Safari: 2.7 });
  });

  test('units convert to the product unit (lb of Safari, a gallon of Zylam)', () => {
    const dino = entryOf(computeNeonicLedger({ rows: [row(SAFARI, 0.3375, 'lb')], bedSqft: BED, catalog: CATALOG }), 'dinotefuran');
    expect(dino.usedShare).toBeCloseTo(0.5, 6);
    expect(entryOf(computeNeonicLedger({ rows: [row(ZYLAM, 1, 'gal')], bedSqft: BED, catalog: CATALOG }), 'dinotefuran').usedShare).toBeGreaterThan(6);
  });

  test('Merit is its own imidacloprid cap and never touches dinotefuran', () => {
    const ledger = computeNeonicLedger({ rows: [row(MERIT, 3.2, 'fl_oz')], bedSqft: BED, catalog: CATALOG });
    expect(entryOf(ledger, 'imidacloprid')).toMatchObject({ unsized: 0 });
    expect(entryOf(ledger, 'imidacloprid').usedShare).toBeCloseTo(0.5, 6);
    expect(entryOf(ledger, 'imidacloprid').capByProduct[0]).toMatchObject({ name: 'Merit', yearlyAmount: 6.4, remainingAmount: 3.2 });
    expect(entryOf(ledger, 'dinotefuran').usedShare).toBe(0);
  });

  test('a row that cannot be sized is counted as unsized, never as zero in silence', () => {
    const dino = entryOf(computeNeonicLedger({
      rows: [
        row(ZYLAM, null, null), // no quantity recorded
        row(ZYLAM, 4, 'oz/1000sf'), // a rate unit, not an amount
        row(ALPINE, 2, 'oz'), // dinotefuran with no strength in the config
        row({ name: 'Unlinked drench', active_ingredient: 'Dinotefuran' }, 2, 'fl_oz'),
        row(ZYLAM, 1.9725, 'fl_oz'),
      ],
      bedSqft: BED, catalog: CATALOG,
    }), 'dinotefuran');
    expect(dino.unsized).toBe(4);
    expect(dino.usedShare).toBeCloseTo(0.1, 6);
  });

  test('another imidacloprid product with no strength is unsized, not a Merit share', () => {
    const imi = entryOf(computeNeonicLedger({
      rows: [row({ name: 'Generic imidacloprid 2F', active_ingredient: 'Imidacloprid 21.4%' }, 2, 'fl_oz')], bedSqft: BED, catalog: CATALOG,
    }), 'imidacloprid');
    expect(imi).toMatchObject({ usedShare: 0, unsized: 1 });
  });

  test('no usable bed area: the cap cannot be computed, with the reason, and the products are still named', () => {
    for (const bedSqft of [null, undefined, 0, -5, 'abc']) {
      const ledger = computeNeonicLedger({ rows: [row(ZYLAM, 2, 'fl_oz')], bedSqft, catalog: CATALOG });
      const dino = entryOf(ledger, 'dinotefuran');
      expect(dino).toMatchObject({ usedShare: null, reason: 'bed_area_needed' });
      expect(dino.capByProduct.map((p) => [p.name, p.yearlyAmount, p.remainingAmount])).toEqual([['Zylam', null, null], ['Safari', null, null]]);
    }
  });

  test('a year over the cap leaves nothing, never a negative amount', () => {
    const dino = entryOf(computeNeonicLedger({ rows: [row(ZYLAM, 40, 'fl_oz')], bedSqft: BED, catalog: CATALOG }), 'dinotefuran');
    expect(dino.usedShare).toBeGreaterThan(1);
    expect(dino.capByProduct.map((p) => p.remainingAmount)).toEqual([0, 0]);
  });
});

describe('the ledger scope: which rows spend the bed allowance', () => {
  test('imidacloprid counts from a tree & shrub visit only; a lawn or pest visit\'s does not', () => {
    const merit = { product_name: 'Merit 2F', active_ingredient: 'Imidacloprid' };
    expect(isTreeShrubLedgerRow({ ...merit, service_line: 'tree_shrub' })).toBe(true);
    expect(isTreeShrubLedgerRow({ ...merit, service_line: null, service_type: 'Tree & Shrub Care' })).toBe(true);
    expect(isTreeShrubLedgerRow({ ...merit, service_line: 'lawn' })).toBe(false);
    expect(isTreeShrubLedgerRow({ ...merit, service_line: 'pest' })).toBe(false);
    expect(isTreeShrubLedgerRow({ ...merit, service_line: null, service_type: 'Every 6 Weeks Lawn Care Service' })).toBe(false);
    expect(isTreeShrubLedgerRow({})).toBe(false);
  });

  // Dinotefuran is an ornamental product only here: a lawn visit that also treated the shrubs
  // (a combined lawn + tree & shrub stop) spent the same allowance (Codex r2 #6204).
  test('Zylam and Safari count from any visit', () => {
    for (const service_line of ['tree_shrub', 'lawn', 'pest', null]) {
      expect(isTreeShrubLedgerRow({ product_name: 'Zylam Insecticide', active_ingredient: 'Dinotefuran', service_line })).toBe(true);
      expect(isTreeShrubLedgerRow({ product_name: 'Safari 20 SG', active_ingredient: 'Dinotefuran 20%', service_line })).toBe(true);
    }
  });

  // Alpine WSG on a pest visit is a structural application: not an ornamental one, and never an
  // "earlier application not counted" on the tree & shrub sheet (Codex r3 #6204).
  test('a dinotefuran product with no cap entry counts only from a tree & shrub visit', () => {
    const alpine = { product_name: ALPINE.name, active_ingredient: ALPINE.active_ingredient };
    expect(isTreeShrubLedgerRow({ ...alpine, service_line: 'pest' })).toBe(false);
    expect(isTreeShrubLedgerRow({ ...alpine, service_line: null })).toBe(false);
    expect(isTreeShrubLedgerRow({ ...alpine, service_line: 'tree_shrub' })).toBe(true);
  });

  // A database whose ledger query answers `rows`, remembering the first query it built so its SQL can be read.
  function ledgerDb(rows, other = {}) {
    const real = knexFactory({ client: 'pg' });
    const built = {};
    const database = (table) => {
      if (table in other) return { where: () => ({ first: async () => other[table] }), whereIn: () => ({ select: async () => other[table] }) };
      const qb = real(table);
      if (!built.query) {
        built.query = qb;
        qb.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      }
      return qb;
    };
    database.raw = real.raw.bind(real);
    return { database, built };
  }
  const svc = { id: 'visit-1', customer_id: 'cust-1', property_id: 'prop-1', scheduled_date: '2026-10-09' };

  test('loadNeonicLedgerRows keeps the T&S rows and drops a lawn visit\'s imidacloprid', async () => {
    const { database } = ledgerDb([
      row(MERIT, 3, 'fl_oz'),
      row(MERIT, 9, 'fl_oz', { service_line: 'lawn' }),
      row(ZYLAM, 1, 'fl_oz', { service_line: null, service_type: 'Shrub Care' }),
      row(ZYLAM, 2, 'fl_oz', { service_line: 'lawn' }),
      // No service record at all: dinotefuran still counts, imidacloprid cannot be placed.
      row(ZYLAM, 4, 'fl_oz', { service_line: null, service_type: null }),
      row(MERIT, 7, 'fl_oz', { service_line: null, service_type: null }),
    ]);
    const kept = await loadNeonicLedgerRows(database, svc, '2026-10-09');
    expect(kept.map((r) => [r.product_name, r.quantity_applied])).toEqual([['Merit 2F', 3], ['Zylam Insecticide', 1], ['Zylam Insecticide', 2], ['Zylam Insecticide', 4]]);
    const ledger = computeNeonicLedger({ rows: kept, bedSqft: BED, catalog: CATALOG });
    expect(entryOf(ledger, 'imidacloprid').usedShare).toBeCloseTo(0.46875, 6);
  });

  test('the ledger query: this customer, the calendar year, retracted rows out, this visit\'s rows out, the property scope', async () => {
    const { database, built } = ledgerDb([]);
    await loadNeonicLedgerRows(database, svc, '2026-10-09');
    const { sql, bindings } = built.query.toSQL();
    expect(sql).toContain('"pah"."retracted_at" is null');
    expect(sql).toContain('"pah"."customer_id" = ?');
    // A row with no service record stays in the read (dinotefuran counts from any source).
    expect(sql).toContain('left join "service_records" as "sr"');
    expect(sql).not.toContain('inner join "service_records" as "sr"');
    expect(sql).toMatch(/"pah"\."property_id" is null or "pah"\."property_id" = \?/);
    expect(sql).toContain('not exists');
    expect(sql).toMatch(/"pah"\."service_record_id" is null or "pah"\."service_record_id" not in/);
    // The name and ingredient frozen on the application win over the catalog's current ones:
    // renaming a product or editing its ingredient must not re-class its history (Codex r2 #6204).
    expect(sql).toContain('COALESCE(pah.active_ingredient, sp.active_ingredient, pc.active_ingredient) ILIKE ?');
    expect(sql).toContain('COALESCE(sp.product_name, pc.name) as product_name');
    expect(sql).toContain('COALESCE(pah.active_ingredient, sp.active_ingredient, pc.active_ingredient) as active_ingredient');
    expect(bindings).toEqual(expect.arrayContaining(['cust-1', 'prop-1', '2026-01-01', '2026-12-31', 'dinotefuran%', 'imidacloprid%', 'visit-1']));
  });

  test('the year follows the visit date in ET', async () => {
    const { database, built } = ledgerDb([]);
    await loadNeonicLedgerRows(database, svc, '2027-01-02');
    expect(built.query.toSQL().bindings).toEqual(expect.arrayContaining(['2027-01-01', '2027-12-31']));
  });
});

describe('buildNeonicCapContext (the sheet)', () => {
  const svc = { id: 'visit-1', customer_id: 'cust-1', property_id: 'prop-1' };
  test('reports what is left per capped product and the bed area it used', async () => {
    const database = (table) => {
      const chain = { first: async () => ({ bed_sqft: BED }), select: async () => (table === 'property_application_history' ? [row(ZYLAM, 9.8625, 'fl_oz')] : []) };
      for (const m of ['join', 'leftJoin', 'where', 'whereNull', 'whereNotExists', 'whereRaw']) chain[m] = () => chain;
      return chain;
    };
    database.raw = (sql) => sql;
    const out = await buildNeonicCapContext(svc, '2026-10-09', CATALOG, database);
    expect(out).toMatchObject({ available: true, year: 2026, bedSqft: BED });
    expect(entryOf(out.ingredients, 'dinotefuran')).toMatchObject({ reason: null });
  });
  // No property link: no one bed area, and the history would span every property of the customer.
  test('a visit with no property answers available:false without a read (Codex r2 #6204)', async () => {
    const database = jest.fn(() => { throw new Error('must not read'); });
    expect(await buildNeonicCapContext({ ...svc, property_id: null }, '2026-10-09', CATALOG, database))
      .toEqual({ available: false, reason: 'property_needed', year: 2026, ingredients: [] });
    expect(database).not.toHaveBeenCalled();
  });
  test('the bed area is the visit property\'s own', async () => {
    const where = jest.fn(() => ({ first: async () => ({ bed_sqft: 2500 }) }));
    expect(await loadBedSqft(() => ({ where }), svc)).toBe(2500);
    expect(where).toHaveBeenCalledWith({ id: 'prop-1' });
    expect(await loadBedSqft(() => ({ where: () => ({ first: async () => ({ bed_sqft: null }) }) }), svc)).toBeNull();
  });
  test('a failed read answers available:false (the sheet shows nothing and blocks nothing)', async () => {
    const database = () => { throw new Error('boom'); };
    database.raw = (sql) => sql;
    expect(await buildNeonicCapContext(svc, '2026-10-09', CATALOG, database)).toEqual({ available: false, reason: 'ledger_unavailable', year: 2026, ingredients: [] });
  });
});

describe('wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  test('/complete does not refuse on the cap: the hold is the sheet\'s, like the live-insect check', () => {
    expect(source).not.toMatch(/neonic/i);
  });
  test('the gate is a strict opt-in with its own reader', () => {
    const gates = require('../config/feature-gates');
    const saved = process.env.GATE_TS_NEONIC_CAP;
    try {
      delete process.env.GATE_TS_NEONIC_CAP;
      expect(gates.tsNeonicCapLive()).toBe(false);
      process.env.GATE_TS_NEONIC_CAP = '1';
      expect(gates.tsNeonicCapLive()).toBe(false);
      process.env.GATE_TS_NEONIC_CAP = 'true';
      expect(gates.tsNeonicCapLive()).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GATE_TS_NEONIC_CAP; else process.env.GATE_TS_NEONIC_CAP = saved;
    }
  });
});

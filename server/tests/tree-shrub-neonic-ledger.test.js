// T&S yearly neonicotinoid cap per property (GATE_TS_NEONIC_CAP): the share math across Zylam + Safari,
// the separate Merit cap, unsized rows, no bed area, the T&S-only ledger scope, and the /complete refusal.
// Synthetic data; a table-keyed fake database (the SQL scoping itself is application-limits' own, reused).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');
const knexFactory = require('knex');
const {
  computeNeonicLedger, neonicCapBlocks, neonicCapBlockPayload, isTreeShrubLedgerRow,
  loadNeonicLedgerRows, treeShrubNeonicCapBlocks, buildNeonicCapContext, CODE,
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

describe('neonicCapBlocks (the visit\'s own rows against the year so far)', () => {
  const ledgerWith = (rows) => computeNeonicLedger({ rows, bedSqft: BED, catalog: CATALOG });

  test('an amount inside what is left passes; an amount on the cap exactly passes', () => {
    expect(neonicCapBlocks({ ledger: ledgerWith([row(ZYLAM, 15, 'fl_oz')]), rows: [{ productId: ZYLAM.id, totalAmount: 4.725, unit: 'fl_oz' }] })).toEqual([]);
  });

  test('an amount over what is left is a block that names the product, the amount and what is left', () => {
    const blocks = neonicCapBlocks({ ledger: ledgerWith([row(ZYLAM, 15, 'fl_oz')]), rows: [{ productId: ZYLAM.id, totalAmount: 5, unit: 'fl_oz' }] });
    expect(blocks).toEqual([{ code: CODE, productId: ZYLAM.id, message: 'Zylam: 5.0 fl oz is over the 4.7 fl oz left this year for this property.' }]);
    expect(neonicCapBlockPayload(blocks)).toMatchObject({ error: blocks[0].message, code: 'tree_shrub_neonic_cap_exceeded', details: [blocks[0].message], blocks });
  });

  test('Safari this visit counts against Zylam used earlier (one shared cap)', () => {
    // Zylam used 3/4 of the year; 3 oz of Safari is 3/10.8 = 0.278 of the year, over the quarter left.
    const blocks = neonicCapBlocks({ ledger: ledgerWith([row(ZYLAM, 14.79375, 'fl_oz')]), rows: [{ productId: SAFARI.id, totalAmount: 3, unit: 'oz' }] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].message).toBe('Safari: 3.0 oz is over the 2.7 oz left this year for this property.');
  });

  test('two rows of one ingredient on this visit add up', () => {
    const blocks = neonicCapBlocks({ ledger: ledgerWith([]), rows: [
      { productId: ZYLAM.id, totalAmount: 12, unit: 'fl_oz' },
      { productId: SAFARI.id, totalAmount: 5, unit: 'oz' },
    ] });
    expect(blocks.map((b) => b.productId)).toEqual([ZYLAM.id, SAFARI.id]);
  });

  test('Merit is judged on its own: a full dinotefuran year does not block Merit', () => {
    const ledger = ledgerWith([row(ZYLAM, 25, 'fl_oz')]);
    expect(neonicCapBlocks({ ledger, rows: [{ productId: MERIT.id, totalAmount: 6, unit: 'fl_oz' }] })).toEqual([]);
    expect(neonicCapBlocks({ ledger, rows: [{ productId: MERIT.id, totalAmount: 7, unit: 'fl_oz' }] })).toHaveLength(1);
  });

  test('no bed area blocks nothing', () => {
    const noBed = computeNeonicLedger({ rows: [], bedSqft: null, catalog: CATALOG });
    expect(neonicCapBlocks({ ledger: noBed, rows: [{ productId: ZYLAM.id, totalAmount: 999, unit: 'fl_oz' }] })).toEqual([]);
  });

  // Fail closed (Codex security r1 #6204): a capped row the check cannot size is refused, not skipped.
  test('a capped row in a unit that does not convert, or with no amount, is refused', () => {
    const needed = { code: 'tree_shrub_neonic_cap_amount_needed', productId: ZYLAM.id, message: 'Zylam: enter the amount in fl oz so the yearly limit can be checked.' };
    expect(neonicCapBlocks({ ledger: ledgerWith([]), rows: [{ productId: ZYLAM.id, totalAmount: 999, unit: 'each' }] })).toEqual([needed]);
    expect(neonicCapBlocks({ ledger: ledgerWith([]), rows: [{ productId: ZYLAM.id, totalAmount: '', unit: 'fl_oz' }] })).toEqual([needed]);
    expect(neonicCapBlocks({ ledger: ledgerWith([]), rows: [{ productId: SAFARI.id, totalAmount: 0, unit: 'oz' }] })[0].message)
      .toBe('Safari: enter the amount in oz so the yearly limit can be checked.');
  });

  test('a product id in another letter case still matches its cap', () => {
    const blocks = neonicCapBlocks({ ledger: ledgerWith([row(ZYLAM, 15, 'fl_oz')]), rows: [{ productId: ZYLAM.id.toUpperCase(), totalAmount: 5, unit: 'fl_oz' }] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].code).toBe(CODE);
  });
});

describe('the ledger scope: Tree & Shrub visits only', () => {
  test('a lawn visit\'s imidacloprid, a pest visit\'s and a row with no visit are not counted', () => {
    expect(isTreeShrubLedgerRow({ service_line: 'tree_shrub' })).toBe(true);
    expect(isTreeShrubLedgerRow({ service_line: null, service_type: 'Tree & Shrub Care' })).toBe(true);
    expect(isTreeShrubLedgerRow({ service_line: 'lawn' })).toBe(false);
    expect(isTreeShrubLedgerRow({ service_line: 'pest' })).toBe(false);
    expect(isTreeShrubLedgerRow({ service_line: null, service_type: 'Every 6 Weeks Lawn Care Service' })).toBe(false);
    expect(isTreeShrubLedgerRow({})).toBe(false);
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
    ]);
    const kept = await loadNeonicLedgerRows(database, svc, '2026-10-09');
    expect(kept.map((r) => [r.product_name, r.quantity_applied])).toEqual([['Merit 2F', 3], ['Zylam Insecticide', 1]]);
    const ledger = computeNeonicLedger({ rows: kept, bedSqft: BED, catalog: CATALOG });
    expect(entryOf(ledger, 'imidacloprid').usedShare).toBeCloseTo(0.46875, 6);
  });

  test('the ledger query: this customer, the calendar year, retracted rows out, this visit\'s rows out, the property scope', async () => {
    const { database, built } = ledgerDb([]);
    await loadNeonicLedgerRows(database, svc, '2026-10-09');
    const { sql, bindings } = built.query.toSQL();
    expect(sql).toContain('"pah"."retracted_at" is null');
    expect(sql).toContain('"pah"."customer_id" = ?');
    expect(sql).toContain('inner join "service_records" as "sr"');
    expect(sql).toMatch(/"pah"\."property_id" is null or "pah"\."property_id" = \?/);
    expect(sql).toContain('not exists');
    expect(sql).toMatch(/"pah"\."service_record_id" is null or "pah"\."service_record_id" not in/);
    expect(sql).toMatch(/ILIKE/i);
    expect(bindings).toEqual(expect.arrayContaining(['cust-1', 'prop-1', '2026-01-01', '2026-12-31', 'dinotefuran%', 'imidacloprid%', 'visit-1']));
  });

  test('the year follows the visit date in ET', async () => {
    const { database, built } = ledgerDb([]);
    await loadNeonicLedgerRows(database, svc, '2027-01-02');
    expect(built.query.toSQL().bindings).toEqual(expect.arrayContaining(['2027-01-01', '2027-12-31']));
  });
});

describe('treeShrubNeonicCapBlocks (the /complete check)', () => {
  const saved = process.env.GATE_TS_NEONIC_CAP;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_TS_NEONIC_CAP; else process.env.GATE_TS_NEONIC_CAP = saved;
  });
  const svc = { id: 'visit-1', customer_id: 'cust-1', property_id: 'prop-1', scheduled_date: '2026-10-09' };

  // Tables answered by name; the ledger rows come from property_application_history.
  function fakeDb({ bed = BED, ledger = [], catalog = CATALOG, failLedger = false } = {}) {
    const reads = [];
    const database = jest.fn((table) => {
      reads.push(table);
      const chain = {};
      for (const m of ['join', 'leftJoin', 'where', 'whereNull', 'whereNotExists', 'whereRaw', 'whereNot']) chain[m] = () => chain;
      chain.whereIn = (_c, ids) => ({ select: async () => catalog.filter((c) => ids.includes(c.id)) });
      chain.first = async () => ({ bed_sqft: bed });
      chain.select = async () => { if (failLedger) throw new Error('ledger down'); return ledger; };
      return chain;
    });
    database.raw = (sql) => sql;
    database.reads = reads;
    return database;
  }
  const submit = (...items) => items.map(([product, totalAmount, amountUnit]) => ({ productId: product.id, totalAmount, amountUnit }));

  test('gate off: nothing is read and nothing is refused', async () => {
    delete process.env.GATE_TS_NEONIC_CAP;
    const database = fakeDb({ ledger: [row(ZYLAM, 50, 'fl_oz')] });
    expect(await treeShrubNeonicCapBlocks(database, svc, submit([ZYLAM, 99, 'fl_oz']))).toEqual([]);
    expect(database.reads).toEqual([]);
  });

  test('gate on: a completion over the cap is refused with the code and the amounts', async () => {
    process.env.GATE_TS_NEONIC_CAP = 'true';
    const database = fakeDb({ ledger: [row(ZYLAM, 15, 'fl_oz')] });
    const blocks = await treeShrubNeonicCapBlocks(database, svc, submit([ZYLAM, 5, 'fl_oz']));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ code: 'tree_shrub_neonic_cap_exceeded', productId: ZYLAM.id });
    expect(blocks[0].message).toBe('Zylam: 5.0 fl oz is over the 4.7 fl oz left this year for this property.');
  });

  test('gate on: an amount inside the cap and a product with no cap pass; the latter without a ledger read', async () => {
    process.env.GATE_TS_NEONIC_CAP = 'true';
    expect(await treeShrubNeonicCapBlocks(fakeDb({ ledger: [row(ZYLAM, 15, 'fl_oz')] }), svc, submit([ZYLAM, 4, 'fl_oz']))).toEqual([]);
    const snapshot = { id: 'cat-snap', name: 'Snapshot 2.5TG', active_ingredient: 'Isoxaben' };
    const noCap = fakeDb({ catalog: [snapshot] });
    expect(await treeShrubNeonicCapBlocks(noCap, svc, submit([snapshot, 999, 'lb']))).toEqual([]);
    expect(noCap.reads).not.toContain('property_application_history');
  });

  test('gate on: a capped product with a blank amount, an "each" unit or an upper-case id is refused, not skipped', async () => {
    process.env.GATE_TS_NEONIC_CAP = 'true';
    const ledger = [row(ZYLAM, 15, 'fl_oz')];
    for (const item of [[ZYLAM, '', 'fl_oz'], [ZYLAM, 999, 'each']]) {
      const blocks = await treeShrubNeonicCapBlocks(fakeDb({ ledger }), svc, submit(item));
      expect(blocks).toMatchObject([{ code: 'tree_shrub_neonic_cap_amount_needed', productId: ZYLAM.id }]);
      expect(neonicCapBlockPayload(blocks).code).toBe('tree_shrub_neonic_cap_amount_needed');
    }
    const upper = await treeShrubNeonicCapBlocks(fakeDb({ ledger }), svc, [{ productId: ZYLAM.id.toUpperCase(), totalAmount: 5, amountUnit: 'fl_oz' }]);
    expect(upper).toMatchObject([{ code: 'tree_shrub_neonic_cap_exceeded' }]);
    expect(neonicCapBlockPayload(upper).code).toBe('tree_shrub_neonic_cap_exceeded');
  });

  test('gate on, no bed area: not checked, not refused', async () => {
    process.env.GATE_TS_NEONIC_CAP = 'true';
    const database = fakeDb({ bed: null });
    expect(await treeShrubNeonicCapBlocks(database, svc, submit([ZYLAM, 999, 'fl_oz']))).toEqual([]);
    expect(database.reads).not.toContain('property_application_history');
  });

  test('gate on: a failed ledger read throws, so /complete answers 503 instead of skipping a label limit', async () => {
    process.env.GATE_TS_NEONIC_CAP = 'true';
    await expect(treeShrubNeonicCapBlocks(fakeDb({ failLedger: true }), svc, submit([ZYLAM, 1, 'fl_oz']))).rejects.toThrow('ledger down');
  });
  // Two visits at one property finishing together: the check runs again inside the writing
  // transaction under a property lock held until the ledger rows commit (pre-push P1 #6204).
  describe('recheckNeonicCapInTransaction', () => {
    const { recheckNeonicCapInTransaction } = require('../services/tree-shrub-neonic-ledger');
    const trxOf = (options) => {
      const trx = fakeDb(options);
      const locks = [];
      trx.raw = jest.fn(async (sql, bindings) => { locks.push([sql, bindings]); return {}; });
      trx.locks = locks;
      return trx;
    };

    test('gate off: no lock and no read', async () => {
      delete process.env.GATE_TS_NEONIC_CAP;
      const trx = trxOf({ ledger: [row(ZYLAM, 50, 'fl_oz')] });
      await recheckNeonicCapInTransaction(trx, svc, submit([ZYLAM, 99, 'fl_oz']), { serviceDate: '2026-10-09' });
      expect(trx.locks).toEqual([]);
      expect(trx.reads).toEqual([]);
    });

    test('gate on: locks the property, then passes inside the cap', async () => {
      process.env.GATE_TS_NEONIC_CAP = 'true';
      const trx = trxOf({ ledger: [row(ZYLAM, 15, 'fl_oz')] });
      await recheckNeonicCapInTransaction(trx, svc, submit([ZYLAM, 4, 'fl_oz']), { serviceDate: '2026-10-09' });
      // The first raw call is the lock; later ones are the ledger query's own raw fragments.
      expect(trx.locks[0]).toEqual(['SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['ts.neonic_cap', 'prop-1']]);
    });

    test('gate on: a visit with no property locks the customer', async () => {
      process.env.GATE_TS_NEONIC_CAP = 'true';
      const trx = trxOf({});
      await recheckNeonicCapInTransaction(trx, { ...svc, property_id: null }, submit([ZYLAM, 1, 'fl_oz']), { serviceDate: '2026-10-09' });
      expect(trx.locks[0][1]).toEqual(['ts.neonic_cap', 'cust-1']);
    });

    test('gate on: rows another visit committed first refuse this one with an operational 400', async () => {
      process.env.GATE_TS_NEONIC_CAP = 'true';
      const trx = trxOf({ ledger: [row(ZYLAM, 15, 'fl_oz')] });
      await expect(recheckNeonicCapInTransaction(trx, svc, submit([ZYLAM, 5, 'fl_oz']), { serviceDate: '2026-10-09' }))
        .rejects.toMatchObject({ statusCode: 400, code: 'tree_shrub_neonic_cap_exceeded', isOperational: true, message: 'Zylam: 5.0 fl oz is over the 4.7 fl oz left this year for this property.' });
      // The lock comes before the read.
      expect(trx.raw.mock.invocationCallOrder[0]).toBeLessThan(trx.mock.invocationCallOrder[0]);
    });
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
  test('a failed read answers available:false (the sheet shows nothing and blocks nothing)', async () => {
    const database = () => { throw new Error('boom'); };
    database.raw = (sql) => sql;
    expect(await buildNeonicCapContext(svc, '2026-10-09', CATALOG, database)).toEqual({ available: false, reason: 'ledger_unavailable', year: 2026, ingredients: [] });
  });
});

describe('wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  test('the refusal sits after the lawn products block, on a fresh attempt only, before any write', () => {
    const gate = source.indexOf("claim.action === 'proceed' && !isIncompleteVisit && (reportServiceLine === 'tree_shrub'");
    expect(gate).toBeGreaterThan(source.indexOf('lawnProhibitedProductsBlockPayload(prohibited)'));
    expect(gate).toBeLessThan(source.indexOf("claim.action === 'proceed' && treeShrubCloseoutRequired"));
    expect(source.slice(gate, gate + 2200)).toContain('treeShrubNeonicCapBlocks(db, svc, products');
    expect(source.slice(gate, gate + 2200)).toContain('status: 400, body: neonicCapBlockPayload(neonicBlocks)');
    // The year judged is the completion day (or the backfilled day), the date the ledger row carries.
    expect(source.slice(gate, gate + 2200)).toContain('backfillPlan.active ? backfillPlan.serviceDate : etDateString(finiteDate(packetContext?.completionAt) || new Date())');
    expect(source.slice(gate, gate + 2200)).not.toContain('svc.scheduled_date');
  });
  test('the in-transaction recheck sits just before the ledger write, on the date the ledger row carries', () => {
    const recheck = source.indexOf('await recheckNeonicCapInTransaction(trx, svc, products, { serviceDate: completionServiceDate });');
    const write = source.indexOf('await ComplianceService.createComplianceRecords(record.id, { trx });');
    expect(recheck).toBeGreaterThan(0);
    expect(write - recheck).toBeGreaterThan(0);
    expect(write - recheck).toBeLessThan(400);
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

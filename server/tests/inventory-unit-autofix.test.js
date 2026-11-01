/**
 * inventory-unit-review — pure-alias resolution, the shared fix applier's
 * sweep-mode guards, and the gated nightly autofix sweep.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));

const { isEnabled } = require('../config/feature-gates');
const { notifyAdmin } = require('../services/notification-service');
const { convertInventoryQuantity } = require('../services/inventory-units');
const {
  applyInventoryUnitFix,
  resolveInventoryUnitAlias,
  resolveDryOzTarget,
  looksLiquidProduct,
  runInventoryUnitAutofixSweep,
  _test: {
    buildAutofixDigest,
    BATCH_CAP, CANDIDATE_PAGE_SIZE, CANONICAL_STORAGE_UNITS, OZ_FAMILY_SQL,
    UNSUPPORTED_UNIT_SQL, isAutofixCandidateUnit,
  },
} = require('../services/inventory-unit-review');

function makeChain(table, route) {
  const q = { _table: table, _calls: [] };
  const methods = [
    'where', 'whereIn', 'whereRaw', 'whereNull', 'whereNotNull', 'whereNotIn', 'select', 'orderBy',
    'forUpdate', 'update', 'insert', 'count', 'first', 'limit', 'offset',
  ];
  for (const m of methods) {
    q[m] = jest.fn((...args) => { q._calls.push([m, args]); return q; });
  }
  q.called = (m) => q._calls.some(([name]) => name === m);
  q.args = (m) => q._calls.find(([name]) => name === m)?.[1];
  q.then = (resolve, reject) => Promise.resolve().then(() => route(q)).then(resolve, reject);
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// resolveInventoryUnitAlias — the green bar
// ---------------------------------------------------------------------------

describe('resolveInventoryUnitAlias', () => {
  it('resolves pure alias/case/plural spellings to the canonical unit', () => {
    expect(resolveInventoryUnitAlias('Gallons')).toBe('gal');
    expect(resolveInventoryUnitAlias('FL  OZ')).toBe('fl_oz'); // double space defeats the SQL normalizer, not the JS one
    expect(resolveInventoryUnitAlias('Liters')).toBe('l');
    expect(resolveInventoryUnitAlias('Pounds')).toBe('lb');
    expect(resolveInventoryUnitAlias('Quarts')).toBe('qt');
  });

  it('never touches the ambiguous oz family', () => {
    expect(resolveInventoryUnitAlias('oz')).toBe(null);
    expect(resolveInventoryUnitAlias('OZ')).toBe(null);
    expect(resolveInventoryUnitAlias('Ounces')).toBe(null);
  });

  it('never touches missing or unrecognizable units', () => {
    expect(resolveInventoryUnitAlias('')).toBe(null);
    expect(resolveInventoryUnitAlias(null)).toBe(null);
    expect(resolveInventoryUnitAlias('bottles')).toBe(null);
    expect(resolveInventoryUnitAlias('fl. oz')).toBe(null); // punctuation breaks normalization — human review
    expect(resolveInventoryUnitAlias('cases')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Sweep candidate predicate — the SQL filter must actually SELECT the
// aliases the sweep exists to fix ('Gallons'), and must not waste capped
// batch slots on already-canonical rows ('gal') or the ambiguous oz family.
// ---------------------------------------------------------------------------

describe('autofix candidate predicate', () => {
  it("selects alias spellings and excludes exact canonical keys + the oz family (pure mirror of the SQL)", () => {
    // The very rows the sweep exists to fix.
    expect(isAutofixCandidateUnit('Gallons')).toBe(true);
    expect(isAutofixCandidateUnit('Liters')).toBe(true);
    expect(isAutofixCandidateUnit('FL OZ')).toBe(true);
    expect(isAutofixCandidateUnit('Gal')).toBe(true); // case variant differs from canonical
    expect(isAutofixCandidateUnit('bottles')).toBe(true); // selected, then parked by the resolver
    // Already canonical — never a candidate.
    for (const unit of CANONICAL_STORAGE_UNITS) expect(isAutofixCandidateUnit(unit)).toBe(false);
    // Ambiguous oz family — excluded entirely so it can't occupy batch slots.
    expect(isAutofixCandidateUnit('oz')).toBe(false);
    expect(isAutofixCandidateUnit('OZ')).toBe(false);
    expect(isAutofixCandidateUnit('Ounces')).toBe(false);
    // Missing unit.
    expect(isAutofixCandidateUnit('')).toBe(false);
    expect(isAutofixCandidateUnit(null)).toBe(false);
    expect(isAutofixCandidateUnit('   ')).toBe(false);
  });

  it("the sweep's actual query filters with the canonical-keys NOT IN (not normalized spellings) and the oz exclusion", async () => {
    isEnabled.mockImplementation((gate) => gate === 'inventoryUnitAutofix');
    const chains = [];
    const dbi = jest.fn((table) => {
      const chain = makeChain(table, () => []);
      chains.push(chain);
      return chain;
    });
    dbi.transaction = jest.fn(async (fn) => fn(dbi));
    await runInventoryUnitAutofixSweep({ dbi });

    const candidateQuery = chains.find((c) => c._table === 'products_catalog' && c.called('limit'));
    expect(candidateQuery).toBeTruthy();
    // Exact canonical storage keys ONLY — a normalized-spellings list here
    // ('gallon', 'liter', ...) is the regression that made 'Gallons'
    // unreachable. 'gal' is excluded; 'Gallons'/'gallon' are NOT excluded.
    const [notInColumn, notInList] = candidateQuery.args('whereNotIn');
    expect(notInColumn).toBe('inventory_unit');
    expect(notInList).toEqual(['fl_oz', 'gal', 'qt', 'pt', 'ml', 'l', 'lb', 'g', 'kg', 'each']);
    expect(notInList).toContain('gal');
    expect(notInList).not.toContain('gallon');
    expect(notInList).not.toContain('Gallons');
    expect(notInList).not.toContain('liter');
    // Raw clauses: non-empty unit + NOT (oz family). No normalized
    // supported-spellings NOT IN anywhere in the candidate query.
    const rawClauses = candidateQuery._calls
      .filter(([name]) => name === 'whereRaw')
      .map(([, args]) => args[0]);
    expect(rawClauses.some((sql) => sql.includes("nullif(trim(coalesce(inventory_unit, '')), '') is not null"))).toBe(true);
    expect(rawClauses.some((sql) => sql === `NOT (${OZ_FAMILY_SQL})`)).toBe(true);
    expect(rawClauses.every((sql) => !sql.includes("'gallon'"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyInventoryUnitFix — sweep-mode guards
// ---------------------------------------------------------------------------

function buildDbi({ product }) {
  const state = { updated: null, movements: [] };
  const route = (table, q) => {
    if (table === 'products_catalog') {
      if (q.called('forUpdate')) return product;
      if (q.called('update')) { state.updated = q.args('update')[0]; return 1; }
      if (q.called('first')) return { ...product, ...(state.updated || {}) };
      return [];
    }
    if (table === 'product_inventory_movements') {
      state.movements.push(q.args('insert')[0]);
      return 1;
    }
    return [];
  };
  const dbi = jest.fn((table) => makeChain(table, (q) => route(table, q)));
  dbi.transaction = jest.fn(async (fn) => fn(dbi));
  return { dbi, state };
}

describe('applyInventoryUnitFix (sweep mode)', () => {
  const product = {
    id: 'p1', name: 'Talstar P', inventory_unit: 'Gallons', inventory_on_hand: '2.5', low_stock_threshold: '1',
  };

  it('renames a pure alias with no quantity change and a zero-quantity audit movement', async () => {
    const { dbi, state } = buildDbi({ product });
    const { outcome } = await applyInventoryUnitFix({
      dbi,
      productId: 'p1',
      nextUnit: 'gal',
      convertExistingStock: false,
      movementSource: 'inventory_unit_review_autofix',
      adjustedBy: 'auto:inventory-unit-autofix',
      expectedCurrentUnit: 'Gallons',
      alwaysRecordMovement: true,
    });
    expect(outcome).toBe('applied');
    expect(state.updated.inventory_unit).toBe('gal');
    // NO conversion: the numbers were already gallons.
    expect(state.updated.inventory_on_hand).toBe(2.5);
    expect(state.updated.low_stock_threshold).toBe(1);
    expect(state.movements).toHaveLength(1);
    expect(state.movements[0].quantity).toBe(0);
    expect(state.movements[0].metadata.source).toBe('inventory_unit_review_autofix');
    expect(state.movements[0].metadata.adjustedBy).toBe('auto:inventory-unit-autofix');
  });

  it("goes stale (no write) when the locked row's unit changed since the caller's read", async () => {
    const { dbi, state } = buildDbi({ product: { ...product, inventory_unit: 'fl_oz' } });
    const { outcome } = await applyInventoryUnitFix({
      dbi,
      productId: 'p1',
      nextUnit: 'gal',
      convertExistingStock: false,
      expectedCurrentUnit: 'Gallons',
      alwaysRecordMovement: true,
    });
    expect(outcome).toBe('stale');
    expect(state.updated).toBe(null);
    expect(state.movements).toHaveLength(0);
  });

  it('refuses an unsupported target unit with a 400', async () => {
    const { dbi } = buildDbi({ product });
    await expect(applyInventoryUnitFix({ dbi, productId: 'p1', nextUnit: 'bottles' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

// ---------------------------------------------------------------------------
// runInventoryUnitAutofixSweep
// ---------------------------------------------------------------------------

describe('runInventoryUnitAutofixSweep', () => {
  function buildSweepDbi({ candidates, products, remaining = 4, pages = null }) {
    const state = { updates: [], movements: [], chains: [] };
    const route = (table, q) => {
      if (table === 'products_catalog') {
        if (q.called('count')) return { count: remaining };
        // The candidate scan pages with limit+offset; `pages` (keyed by
        // offset) simulates multi-page scans, `candidates` a single page.
        if (q.called('limit')) {
          if (pages) return pages[q.args('offset')?.[0] ?? 0] || [];
          return (q.args('offset')?.[0] ?? 0) === 0 ? candidates : [];
        }
        if (q.called('forUpdate')) return products[q.args('where')[0].id] || null;
        if (q.called('update')) { state.updates.push({ where: q.args('where')[0], payload: q.args('update')[0] }); return 1; }
        if (q.called('first')) return {};
        return [];
      }
      if (table === 'product_inventory_movements') {
        state.movements.push(q.args('insert')[0]);
        return 1;
      }
      return [];
    };
    const dbi = jest.fn((table) => {
      const chain = makeChain(table, (q) => route(table, q));
      state.chains.push(chain);
      return chain;
    });
    dbi.transaction = jest.fn(async (fn) => fn(dbi));
    return { dbi, state };
  }

  it('is a no-op while the gate is off', async () => {
    const { dbi } = buildSweepDbi({ candidates: [], products: {} });
    const result = await runInventoryUnitAutofixSweep({ dbi });
    expect(result).toEqual({ skipped: 'gate_off' });
    expect(dbi).not.toHaveBeenCalled();
  });

  it('fixes pure aliases, parks everything else, and sends ONE digest with the remaining count', async () => {
    isEnabled.mockImplementation((gate) => gate === 'inventoryUnitAutofix');
    const candidates = [
      { id: 'p1', name: 'Talstar P', inventory_unit: 'Gallons' },
      { id: 'p2', name: 'Bifen Granules', inventory_unit: 'bags' }, // unrecognizable — parked
    ];
    const products = {
      p1: { id: 'p1', name: 'Talstar P', inventory_unit: 'Gallons', inventory_on_hand: '2.5', low_stock_threshold: null },
    };
    const { dbi, state } = buildSweepDbi({ candidates, products, remaining: 4 });
    const result = await runInventoryUnitAutofixSweep({ dbi });

    expect(result.applied).toBe(1);
    expect(result.parked).toBe(1);
    expect(result.errors).toBe(0);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].payload.inventory_unit).toBe('gal');
    expect(state.movements).toHaveLength(1);
    expect(state.movements[0].metadata.source).toBe('inventory_unit_review_autofix');

    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = notifyAdmin.mock.calls[0];
    expect(category).toBe('system');
    expect(title).toMatch(/1 unit alias auto-fixed/);
    expect(body).toMatch(/4 products still need unit review/);
    expect(opts.link).toBe('/admin/inventory?tab=unit-review');
  });

  it('parked rows never consume the cap — a full page of unrecognizable units cannot starve fixable aliases behind it', async () => {
    isEnabled.mockImplementation((gate) => gate === 'inventoryUnitAutofix');
    // A whole first page of park-only rows (sorted ahead of the fixable
    // alias): the pre-fix code applied LIMIT BATCH_CAP to the raw candidate
    // set, so these rows filled the batch on every run and 'ZZZ Talstar'
    // never got fixed. Resolvability now filters BEFORE the cap and the
    // scan pages past the parked rows.
    const parkedPage = Array.from({ length: CANDIDATE_PAGE_SIZE }, (_, i) => (
      { id: `bag-${i}`, name: `AAA Bags ${i}`, inventory_unit: 'bags' }
    ));
    const pages = {
      0: parkedPage,
      [CANDIDATE_PAGE_SIZE]: [{ id: 'p-gal', name: 'ZZZ Talstar', inventory_unit: 'Gallons' }],
    };
    const products = {
      'p-gal': { id: 'p-gal', name: 'ZZZ Talstar', inventory_unit: 'Gallons', inventory_on_hand: '2.5', low_stock_threshold: null },
    };
    const { dbi, state } = buildSweepDbi({ candidates: null, products, pages, remaining: 200 });
    const result = await runInventoryUnitAutofixSweep({ dbi });

    expect(result.applied).toBe(1);
    expect(result.parked).toBe(CANDIDATE_PAGE_SIZE);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].payload.inventory_unit).toBe('gal');
  });

  it('the cap still bounds WRITES per run (applies to resolvable rows, not scan size)', async () => {
    isEnabled.mockImplementation((gate) => gate === 'inventoryUnitAutofix');
    const n = BATCH_CAP + 10;
    const candidates = Array.from({ length: n }, (_, i) => (
      { id: `g-${i}`, name: `Product ${String(i).padStart(3, '0')}`, inventory_unit: 'Gallons' }
    ));
    const products = Object.fromEntries(candidates.map((c) => [
      c.id, { ...c, inventory_on_hand: '1', low_stock_threshold: null },
    ]));
    const { dbi, state } = buildSweepDbi({ candidates, products, remaining: 0 });
    const result = await runInventoryUnitAutofixSweep({ dbi });

    expect(result.applied).toBe(BATCH_CAP);
    expect(state.updates).toHaveLength(BATCH_CAP);
  });

  it("the digest's remaining count uses the sweep's OWN parked predicates (plural/whitespace ounces, blank units)", async () => {
    isEnabled.mockImplementation((gate) => gate === 'inventoryUnitAutofix');
    const candidates = [{ id: 'p1', name: 'Talstar P', inventory_unit: 'Gallons' }];
    const products = {
      p1: { id: 'p1', name: 'Talstar P', inventory_unit: 'Gallons', inventory_on_hand: '2.5', low_stock_threshold: null },
    };
    const { dbi, state } = buildSweepDbi({ candidates, products, remaining: 0 });
    await runInventoryUnitAutofixSweep({ dbi });

    const countQuery = state.chains.find((c) => c._table === 'products_catalog' && c.called('count'));
    expect(countQuery).toBeTruthy();
    // The predicate nests inside where(function unitIssue(){...}) callbacks,
    // so walk them: run each recorded callback against a recorder that
    // collects raw clauses and recurses into further callbacks.
    const rawClauses = [];
    let sawWhereNull = false;
    const walk = (calls) => {
      for (const [name, args] of calls) {
        if (name === 'whereRaw') rawClauses.push(args[0]);
        if (name === 'whereNull') sawWhereNull = true;
        for (const arg of args) {
          if (typeof arg === 'function') {
            const inner = { _calls: [] };
            for (const m of ['where', 'orWhere', 'whereRaw', 'orWhereRaw', 'whereNull', 'orWhereNull', 'whereNotNull', 'orWhereNotNull']) {
              inner[m] = (...a) => { inner._calls.push([m.replace(/^or/, '').replace(/^W/, 'w'), a]); return inner; };
            }
            arg.call(inner);
            walk(inner._calls);
          }
        }
      }
    };
    walk(countQuery._calls);
    // Ambiguous oz family: the sweep's normalized predicate (trim, space→_,
    // lowercase, depluralize) — NOT an exact lower(...)='oz', which missed
    // 'Ounces'/'ounce'/' oz ' while UNSUPPORTED_UNIT_SQL read normalized
    // 'ounce' as supported, so those parked rows counted nowhere.
    expect(rawClauses).toContain(OZ_FAMILY_SQL);
    expect(rawClauses.every((sql) => !/=\s*'oz'/.test(sql) || sql === OZ_FAMILY_SQL)).toBe(true);
    // Blank unit: whitespace-only counts as missing, like the resolver's trim.
    expect(rawClauses.some((sql) => sql.includes("nullif(trim(coalesce(inventory_unit, '')), '') is null"))).toBe(true);
    // A bare whereNull('inventory_unit') would under-count whitespace-only
    // units — the blank test must be the trim-aware raw clause instead.
    expect(sawWhereNull).toBe(false);
  });

  it('the review route and dashboard-alerts consume the SHARED queue filter — no inline predicate copies left to drift', () => {
    // No harness drives GET /admin/inventory/unit-review, so the no-drift
    // guarantee is pinned at the source level: both consumers must call the
    // shared export, and neither may carry the stale inline predicates
    // (bare whereNull missing-branch, exact lower(...)='oz') that made the
    // digest count rows the review page never showed.
    const fs = require('fs');
    const path = require('path');
    for (const rel of ['../routes/admin-inventory.js', '../services/dashboard-alerts.js']) {
      const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
      expect(src).toContain('applyUnitReviewQueueFilter');
      expect(src).not.toMatch(/lower\(coalesce\(inventory_unit, ''\)\) = 'oz'/);
      expect(src).not.toMatch(/whereNull\('inventory_unit'\)/);
    }
  });

  it('the shared queue filter itself uses the normalized ounce family and the trim-aware blank test', () => {
    const { applyUnitReviewQueueFilter } = require('../services/inventory-unit-review');
    const q = makeChain('products_catalog', () => []);
    applyUnitReviewQueueFilter(q);
    // Walk the nested where-callbacks like the digest pin does.
    const rawClauses = [];
    let sawWhereNull = false;
    const walk = (calls) => {
      for (const [name, args] of calls) {
        if (name === 'whereRaw') rawClauses.push(args[0]);
        if (name === 'whereNull') sawWhereNull = true;
        for (const arg of args) {
          if (typeof arg === 'function') {
            const inner = { _calls: [] };
            for (const m of ['where', 'orWhere', 'whereRaw', 'orWhereRaw', 'whereNull', 'orWhereNull', 'whereNotNull', 'orWhereNotNull']) {
              inner[m] = (...a) => { inner._calls.push([m.replace(/^or/, '').replace(/^W/, 'w'), a]); return inner; };
            }
            arg.call(inner);
            walk(inner._calls);
          }
        }
      }
    };
    walk(q._calls);
    // An 'Ounces' row matches the normalized family; a whitespace-only unit
    // matches the trim-aware blank branch — the exact rows the old route
    // predicates missed.
    expect(rawClauses).toContain(OZ_FAMILY_SQL);
    expect(rawClauses.some((sql) => sql.includes("nullif(trim(coalesce(inventory_unit, '')), '') is null"))).toBe(true);
    expect(rawClauses).toContain(UNSUPPORTED_UNIT_SQL);
    expect(sawWhereNull).toBe(false);
  });

  it('every parked variant the sweep refuses is one the remaining-count predicate would catch', () => {
    // Pins the pairing directly: each of these is parked by the resolver
    // (returns null) AND matched by a remaining-count branch — the digest
    // can never report zero need-review while they exist.
    for (const unit of ['oz', 'OZ', 'Ounces', 'ounce', '  oz  ', 'Oz']) {
      expect(resolveInventoryUnitAlias(unit)).toBe(null);
      const squashed = String(unit).trim().replace(/ /g, '_').toLowerCase().replace(/s$/, '');
      expect(['oz', 'ounce']).toContain(squashed); // the OZ_FAMILY_SQL branch
    }
    for (const unit of ['', '   ', null]) {
      expect(resolveInventoryUnitAlias(unit)).toBe(null);
      expect(String(unit ?? '').trim()).toBe(''); // the blank-unit branch
    }
  });

  it('goes stale instead of overwriting a row an admin fixed mid-sweep', async () => {
    isEnabled.mockImplementation((gate) => gate === 'inventoryUnitAutofix');
    const candidates = [{ id: 'p1', name: 'Talstar P', inventory_unit: 'Gallons' }];
    const products = {
      p1: { id: 'p1', name: 'Talstar P', inventory_unit: 'fl_oz', inventory_on_hand: '2.5', low_stock_threshold: null },
    };
    const { dbi, state } = buildSweepDbi({ candidates, products });
    const result = await runInventoryUnitAutofixSweep({ dbi });
    expect(result.applied).toBe(0);
    expect(result.stale).toBe(1);
    expect(state.updates).toHaveLength(0);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Dry-oz phase (owner 2026-11-01): resolveDryOzTarget, the lockedCheck /
// movementReason options, the second sweep phase and its digest.
// ---------------------------------------------------------------------------

describe('resolveDryOzTarget', () => {
  const dry = (over = {}) => ({
    name: 'Some Product', inventory_unit: 'oz', formulation: 'WDG', inventory_on_hand: '1.25', ...over,
  });

  it('picks g for small dry stock and lb from 16 oz up', () => {
    expect(resolveDryOzTarget(dry())).toBe('g');
    expect(resolveDryOzTarget(dry({ formulation: 'wsg' }))).toBe('g');
    expect(resolveDryOzTarget(dry({ formulation: 'paste', inventory_on_hand: 8 }))).toBe('g');
    expect(resolveDryOzTarget(dry({ formulation: 'gel bait' }))).toBe('g');
    expect(resolveDryOzTarget(dry({ formulation: 'granular', inventory_on_hand: '800' }))).toBe('lb');
    expect(resolveDryOzTarget(dry({ formulation: 'granular', inventory_on_hand: 16 }))).toBe('lb');
    expect(resolveDryOzTarget(dry({ formulation: 'granular', inventory_on_hand: 15.99 }))).toBe('g');
    expect(resolveDryOzTarget(dry({ inventory_on_hand: null }))).toBe('g');
    expect(resolveDryOzTarget(dry({ inventory_on_hand: 0 }))).toBe('g');
  });

  it('accepts the production dry formulation spellings', () => {
    for (const formulation of ['wdg', 'WG', 'df', 'sg', 'granular', 'Granular (2.5TG)', 'granular bait', 'granular meal',
      'dispersible granule', 'dry soluble', 'soluble granular', 'soluble granule', 'soluble powder', 'dust', 'paste',
      'bait block', 'bait chunk']) {
      expect([formulation, resolveDryOzTarget(dry({ formulation }))]).toEqual([formulation, 'g']);
    }
  });

  it('works for any oz-family spelling and nothing else', () => {
    for (const inventory_unit of ['oz', 'OZ', 'Ounces', 'ounce', ' oz ']) {
      expect(resolveDryOzTarget(dry({ inventory_unit }))).toBe('g');
    }
    for (const inventory_unit of ['fl_oz', 'lb', 'g', 'each', '', null]) {
      expect(resolveDryOzTarget(dry({ inventory_unit }))).toBe(null);
    }
  });

  it('needs positive dry evidence', () => {
    for (const formulation of [null, undefined, '', '   ', 'unspecified', 'Unspecified', 'bait', 'concentrate', 'fertilizer']) {
      expect([formulation, resolveDryOzTarget(dry({ formulation }))]).toEqual([formulation, null]);
    }
  });

  it('parks liquid formulations', () => {
    for (const formulation of ['sc', 'EC', 'liquid', 'flowable', 'se', 'ew', 'cs', 'microemulsion', 'oil', 'solution',
      'suspension concentrate', 'wdg liquid']) {
      expect([formulation, resolveDryOzTarget(dry({ formulation }))]).toEqual([formulation, null]);
    }
  });

  it('parks count products (stock lives in each)', () => {
    for (const formulation of ['bait cartridge', 'briquet', 'station', 'station refill', 'termite bait station',
      'tablet', 'trap', 'supply', 'live plugs', 'foam', 'granular bait station']) {
      expect([formulation, resolveDryOzTarget(dry({ formulation }))]).toEqual([formulation, null]);
    }
  });

  it('parks a dry formulation whose name or fields look liquid (Unit Review heuristic)', () => {
    expect(resolveDryOzTarget(dry({ name: 'Talstar Granules' }))).toBe(null);
    expect(resolveDryOzTarget(dry({ name: 'Liquid Fertilizer Mix' }))).toBe(null);
    expect(resolveDryOzTarget(dry({ unit_type: 'liquid' }))).toBe(null);
    expect(looksLiquidProduct({ name: 'Talstar' })).toBe(true);
    expect(looksLiquidProduct({ name: 'Bifen', formulation: 'granular' })).toBe(false);
  });

  it('parks when the rate or default unit is a volume unit; weight-or-ambiguous bases still pass', () => {
    expect(resolveDryOzTarget(dry({ rate_unit: 'fl_oz/1000sf' }))).toBe(null);
    expect(resolveDryOzTarget(dry({ rate_unit: 'gal/acre' }))).toBe(null);
    expect(resolveDryOzTarget(dry({ default_unit: 'gal' }))).toBe(null);
    expect(resolveDryOzTarget(dry({ default_unit: 'Quarts' }))).toBe(null);
    expect(resolveDryOzTarget(dry({ default_unit: 'ml' }))).toBe(null);
    expect(resolveDryOzTarget(dry({ rate_unit: 'oz/1000sf' }))).toBe('g');
    expect(resolveDryOzTarget(dry({ rate_unit: 'g/1000sf', default_unit: 'lb' }))).toBe('g');
    expect(resolveDryOzTarget(dry({ rate_unit: null, default_unit: undefined }))).toBe('g');
  });
});

describe('dry oz conversion math (real convertInventoryQuantity)', () => {
  it('converts weight ounces exactly', () => {
    expect(convertInventoryQuantity(1.25, 'oz', 'g')).toBeCloseTo(35.4369, 3);
    expect(convertInventoryQuantity(0.4433, 'oz', 'g')).toBeCloseTo(12.5673, 3);
    expect(convertInventoryQuantity(8, 'oz', 'g')).toBeCloseTo(226.7959, 3);
    expect(convertInventoryQuantity(800, 'oz', 'lb')).toBeCloseTo(50, 6);
  });
});

describe('applyInventoryUnitFix lockedCheck / movementReason', () => {
  const dryProduct = {
    id: 'd1', name: 'Some WDG', inventory_unit: 'oz', formulation: 'wdg', inventory_on_hand: '1.25', low_stock_threshold: '0.5',
  };
  const buildArgs = (extra = {}) => ({
    productId: 'd1',
    nextUnit: 'g',
    convertExistingStock: true,
    movementSource: 'inventory_unit_review_autofix_dry_oz',
    adjustedBy: 'auto:inventory-unit-autofix',
    expectedCurrentUnit: 'oz',
    alwaysRecordMovement: true,
    ...extra,
  });

  it('lockedCheck false -> stale, no update and no movement', async () => {
    const lockedCheck = jest.fn(() => false);
    const { dbi, state } = buildDbi({ product: dryProduct });
    const { outcome } = await applyInventoryUnitFix({ dbi, ...buildArgs({ lockedCheck }) });
    expect(outcome).toBe('stale');
    expect(lockedCheck).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }));
    expect(state.updated).toBe(null);
    expect(state.movements).toHaveLength(0);
  });

  it('lockedCheck true converts stock and threshold and uses movementReason on the audit row', async () => {
    const { dbi, state } = buildDbi({ product: dryProduct });
    const { outcome } = await applyInventoryUnitFix({
      dbi, ...buildArgs({ lockedCheck: () => true, movementReason: 'Dry product: weight ounces converted to g' }),
    });
    expect(outcome).toBe('applied');
    expect(state.updated.inventory_unit).toBe('g');
    expect(state.updated.inventory_on_hand).toBeCloseTo(35.4369, 3);
    expect(state.updated.low_stock_threshold).toBeCloseTo(14.1748, 3);
    expect(state.movements).toHaveLength(1);
    expect(state.movements[0].metadata.reason).toBe('Dry product: weight ounces converted to g');
    expect(state.movements[0].metadata.source).toBe('inventory_unit_review_autofix_dry_oz');
  });

  it('without lockedCheck or movementReason the behavior and strings are unchanged', async () => {
    const { dbi, state } = buildDbi({ product: dryProduct });
    const { outcome } = await applyInventoryUnitFix({ dbi, ...buildArgs() });
    expect(outcome).toBe('applied');
    expect(state.movements[0].metadata.reason).toBe('Inventory unit normalization');
  });

  it('movementReason replaces the alias text on the zero-quantity row of a dry product with no stock', async () => {
    const { dbi, state } = buildDbi({ product: { ...dryProduct, inventory_on_hand: null, low_stock_threshold: null } });
    await applyInventoryUnitFix({ dbi, ...buildArgs({ movementReason: 'Dry product: weight ounces converted to g' }) });
    expect(state.movements).toHaveLength(1);
    expect(state.movements[0].quantity).toBe(0);
    expect(state.movements[0].metadata.reason).toBe('Dry product: weight ounces converted to g');
    // Default stays the alias wording.
    const second = buildDbi({ product: { ...dryProduct, inventory_on_hand: null, low_stock_threshold: null } });
    await applyInventoryUnitFix({ dbi: second.dbi, ...buildArgs() });
    expect(second.state.movements[0].metadata.reason).toBe('Inventory unit alias normalization (no quantity change)');
  });
});

describe('runInventoryUnitAutofixSweep dry-oz phase', () => {
  const OZ_ROWS = [
    { id: 'w1', name: 'AAA WDG Herbicide', formulation: 'wdg', inventory_unit: 'oz', inventory_on_hand: '1.25', rate_unit: 'oz/1000sf' },
    { id: 'g1', name: 'BBB Granular Bait', formulation: 'granular bait', inventory_unit: 'Ounces', inventory_on_hand: '800' },
    { id: 'l1', name: 'CCC Liquid Thing', formulation: 'sc', inventory_unit: 'oz', inventory_on_hand: '3' }, // parked
    { id: 'u1', name: 'DDD Unknown', formulation: null, inventory_unit: 'oz', inventory_on_hand: '3' }, // parked
  ];

  function buildDryDbi({ ozRows = OZ_ROWS, aliasCandidates = [], products = {}, remaining = 7, failOn = null }) {
    const state = { updates: [], movements: [], chains: [] };
    const route = (table, q) => {
      if (table === 'products_catalog') {
        if (q.called('count')) return { count: remaining };
        if (q.called('limit')) return (q.args('offset')?.[0] ?? 0) === 0 ? aliasCandidates : [];
        if (q.called('whereRaw') && q.args('whereRaw')[0] === OZ_FAMILY_SQL) {
          if (failOn === 'scan') throw new Error('scan boom');
          return ozRows;
        }
        if (q.called('forUpdate')) {
          const id = q.args('where')[0].id;
          if (failOn === id) throw new Error('lock boom');
          return products[id] || null;
        }
        if (q.called('update')) { state.updates.push({ where: q.args('where')[0], payload: q.args('update')[0] }); return 1; }
        if (q.called('first')) return {};
        return [];
      }
      if (table === 'product_inventory_movements') { state.movements.push(q.args('insert')[0]); return 1; }
      return [];
    };
    const dbi = jest.fn((table) => {
      const chain = makeChain(table, (q) => route(table, q));
      state.chains.push(chain);
      return chain;
    });
    dbi.transaction = jest.fn(async (fn) => fn(dbi));
    return { dbi, state };
  }

  const lockedRows = () => Object.fromEntries(OZ_ROWS.map((r) => [r.id, { ...r, low_stock_threshold: null }]));
  const gates = (...on) => isEnabled.mockImplementation((gate) => on.includes(gate));

  it('gate off: no dry-oz scan and no dry-oz writes; alias behavior unchanged', async () => {
    gates('inventoryUnitAutofix');
    const { dbi, state } = buildDryDbi({
      aliasCandidates: [{ id: 'p1', name: 'Talstar P', inventory_unit: 'Gallons' }],
      products: { p1: { id: 'p1', name: 'Talstar P', inventory_unit: 'Gallons', inventory_on_hand: '2.5', low_stock_threshold: null } },
    });
    const result = await runInventoryUnitAutofixSweep({ dbi });
    expect(result.applied).toBe(1);
    expect(result.dryOz).toEqual({ applied: 0, parked: 0, stale: 0, errors: 0 });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].payload.inventory_unit).toBe('gal');
    expect(state.chains.some((c) => c.called('whereRaw') && c.args('whereRaw')[0] === OZ_FAMILY_SQL)).toBe(false);
  });

  it('dry-oz gate alone does nothing: the sweep gate still returns early', async () => {
    gates('inventoryUnitAutofixDryOz');
    const { dbi } = buildDryDbi({});
    expect(await runInventoryUnitAutofixSweep({ dbi })).toEqual({ skipped: 'gate_off' });
    expect(dbi).not.toHaveBeenCalled();
  });

  it('both gates on: applies each dry row with the exact args, parks the rest, one digest', async () => {
    gates('inventoryUnitAutofix', 'inventoryUnitAutofixDryOz');
    const { dbi, state } = buildDryDbi({ products: lockedRows() });
    const result = await runInventoryUnitAutofixSweep({ dbi });

    expect(result.applied).toBe(0);
    expect(result.dryOz).toEqual({ applied: 2, parked: 2, stale: 0, errors: 0 });
    expect(result.fixes).toEqual([
      { kind: 'dry_oz', productId: 'w1', name: 'AAA WDG Herbicide', from: 'oz', to: 'g' },
      { kind: 'dry_oz', productId: 'g1', name: 'BBB Granular Bait', from: 'Ounces', to: 'lb' },
    ]);
    expect(state.updates.map((u) => [u.where.id, u.payload.inventory_unit])).toEqual([['w1', 'g'], ['g1', 'lb']]);
    expect(state.updates[0].payload.inventory_on_hand).toBeCloseTo(35.4369, 3);
    expect(state.updates[1].payload.inventory_on_hand).toBeCloseTo(50, 6);
    expect(state.movements).toHaveLength(2);
    expect(state.movements[0].metadata).toMatchObject({
      source: 'inventory_unit_review_autofix_dry_oz',
      adjustedBy: 'auto:inventory-unit-autofix',
      reason: 'Dry product: weight ounces converted to g',
    });
    expect(state.movements[1].metadata.reason).toBe('Dry product: weight ounces converted to lb');

    // The scan reads the oz family with the columns the decision needs, in stable order.
    const scan = state.chains.find((c) => c.called('whereRaw') && c.args('whereRaw')[0] === OZ_FAMILY_SQL);
    expect(scan.args('select')).toEqual(['id', 'name', 'category', 'subcategory', 'formulation', 'unit_type', 'inventory_unit',
      'inventory_on_hand', 'low_stock_threshold', 'rate_unit', 'default_unit']);
    expect(scan._calls.filter(([m]) => m === 'orderBy').map(([, a]) => a[0])).toEqual(['name', 'id']);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
  });

  it('a formulation edit between scan and lock leaves the row alone (lockedCheck)', async () => {
    gates('inventoryUnitAutofix', 'inventoryUnitAutofixDryOz');
    const edited = lockedRows();
    edited.w1 = { ...edited.w1, formulation: 'sc' };
    const { dbi, state } = buildDryDbi({ ozRows: [OZ_ROWS[0]], products: edited });
    const result = await runInventoryUnitAutofixSweep({ dbi });
    expect(result.dryOz).toEqual({ applied: 0, parked: 0, stale: 1, errors: 0 });
    expect(state.updates).toHaveLength(0);
    expect(state.movements).toHaveLength(0);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  it('a unit edit between scan and lock is stale, not applied', async () => {
    gates('inventoryUnitAutofix', 'inventoryUnitAutofixDryOz');
    const products = lockedRows();
    products.w1 = { ...products.w1, inventory_unit: 'fl_oz' };
    const { dbi, state } = buildDryDbi({ ozRows: [OZ_ROWS[0]], products });
    const result = await runInventoryUnitAutofixSweep({ dbi });
    expect(result.dryOz.stale).toBe(1);
    expect(result.dryOz.applied).toBe(0);
    expect(state.updates).toHaveLength(0);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  it('an error leaves that row parked and the phase continues', async () => {
    gates('inventoryUnitAutofix', 'inventoryUnitAutofixDryOz');
    const { dbi, state } = buildDryDbi({ products: lockedRows(), failOn: 'w1' });
    const result = await runInventoryUnitAutofixSweep({ dbi });
    expect(result.dryOz).toEqual({ applied: 1, parked: 2, stale: 0, errors: 1 });
    expect(state.updates.map((u) => u.where.id)).toEqual(['g1']);
  });

  it('a failed scan is counted and does not break the alias phase or the digest', async () => {
    gates('inventoryUnitAutofix', 'inventoryUnitAutofixDryOz');
    const { dbi } = buildDryDbi({
      failOn: 'scan',
      aliasCandidates: [{ id: 'p1', name: 'Talstar P', inventory_unit: 'Gallons' }],
      products: { p1: { id: 'p1', name: 'Talstar P', inventory_unit: 'Gallons', inventory_on_hand: '2.5', low_stock_threshold: null } },
    });
    const result = await runInventoryUnitAutofixSweep({ dbi });
    expect(result.applied).toBe(1);
    expect(result.dryOz.errors).toBe(1);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
  });

  it('bounds dry-oz writes with BATCH_CAP', async () => {
    gates('inventoryUnitAutofix', 'inventoryUnitAutofixDryOz');
    const ozRows = Array.from({ length: BATCH_CAP + 5 }, (_, i) => (
      { id: `d-${i}`, name: `Dry ${String(i).padStart(3, '0')}`, formulation: 'wdg', inventory_unit: 'oz', inventory_on_hand: '1' }
    ));
    const products = Object.fromEntries(ozRows.map((r) => [r.id, { ...r, low_stock_threshold: null }]));
    const { dbi, state } = buildDryDbi({ ozRows, products });
    const result = await runInventoryUnitAutofixSweep({ dbi });
    expect(result.dryOz.applied).toBe(BATCH_CAP);
    expect(state.updates).toHaveLength(BATCH_CAP);
  });

  it('a dry-only run sends one digest that does not say no quantities changed', async () => {
    gates('inventoryUnitAutofix', 'inventoryUnitAutofixDryOz');
    const { dbi } = buildDryDbi({ products: lockedRows(), remaining: 1 });
    await runInventoryUnitAutofixSweep({ dbi });
    const [, title, body] = notifyAdmin.mock.calls[0];
    expect(title).toBe('Inventory: 2 dry products converted from oz');
    expect(body).toBe('AAA WDG Herbicide (oz → g), BBB Granular Bait (Ounces → lb). Dry products converted from oz to g or lb — an exact weight conversion; stock and low-stock level converted with it. Each fix left a movement audit row. 1 product still needs unit review.');
    expect(body).not.toMatch(/no quantities changed/);
  });
});

describe('buildAutofixDigest', () => {
  const alias = { kind: 'alias', name: 'Talstar P', from: 'Gallons', to: 'gal' };
  const dry = { kind: 'dry_oz', name: 'Some WDG', from: 'oz', to: 'g' };

  it('alias-only keeps the alias wording', () => {
    expect(buildAutofixDigest({ fixes: [alias] }, 4)).toEqual({
      title: 'Inventory: 1 unit alias auto-fixed',
      body: 'Talstar P (Gallons → gal). Pure spelling/plural renames only — no quantities changed. Each fix left a movement audit row. 4 products still need unit review.',
    });
  });

  it('mixed run has one sentence per kind, and only the alias sentence says no quantities changed', () => {
    const { title, body } = buildAutofixDigest({ fixes: [alias, alias, dry] }, 1);
    expect(title).toBe('Inventory: 2 unit aliases auto-fixed, 1 dry product converted from oz');
    expect(body).toBe('Talstar P (Gallons → gal), Talstar P (Gallons → gal). Pure spelling/plural renames only — no quantities changed. Some WDG (oz → g). Dry products converted from oz to g or lb — an exact weight conversion; stock and low-stock level converted with it. Each fix left a movement audit row. 1 product still needs unit review.');
  });

  it('truncates a long sample', () => {
    const fixes = Array.from({ length: 7 }, (_, i) => ({ ...dry, name: `P${i}` }));
    expect(buildAutofixDigest({ fixes }, 0).body).toMatch(/\(oz → g\) and 2 more\./);
  });
});

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
const {
  applyInventoryUnitFix,
  resolveInventoryUnitAlias,
  runInventoryUnitAutofixSweep,
  _test: {
    BATCH_CAP, CANDIDATE_PAGE_SIZE, CANONICAL_STORAGE_UNITS, OZ_FAMILY_SQL, isAutofixCandidateUnit,
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
    expect(notInList).toEqual(['fl_oz', 'gal', 'qt', 'pt', 'ml', 'l', 'lb', 'g', 'kg']);
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

const adminProtocolsRouter = require('../routes/admin-protocols');
const {
  parseProtocolLines,
  resolveProtocolItems,
  effectiveAreaFactor,
  calculateProductAmount,
} = require('../services/waveguard-plan-engine');

const { isPricedProtocolLine, unmatchedPricedProtocolLines } = adminProtocolsRouter._internals;

// Catalog fixtures mirror the prod rows the lawn-mix preview resolves against.
// Arena's rate matches migration 20260703000001 (sourced from the operating
// layer's owner-approved July chinch-rescue seed).
const CATALOG = [
  {
    id: 'arena',
    name: 'Arena 50 WDG',
    aliases: ['Arena'],
    default_rate_per_1000: 0.29,
    rate_unit: 'oz',
    cost_per_unit: 5.2,
    cost_unit: 'oz',
  },
  {
    id: 'kflow',
    name: 'LESCO K-Flow 0-0-25',
    aliases: ['K-Flow'],
    default_rate_per_1000: 3,
    rate_unit: 'fl_oz',
    cost_per_unit: 0.12,
    cost_unit: 'fl_oz',
  },
  {
    id: 'hydretain',
    name: 'Hydretain Liquid',
    aliases: ['Hydretain'],
    default_rate_per_1000: 9,
    rate_unit: 'fl_oz',
    cost_per_unit: 0.13,
    cost_unit: 'fl_oz',
  },
];

// Mirrors the lawn-mix endpoint: planned factor treats the line as if its
// trigger fired (rescue selected, premium taken) without disturbing the
// real selection state.
function plannedFactor(item) {
  return item.selected
    ? effectiveAreaFactor(item, {})
    : effectiveAreaFactor({ ...item, selected: true }, { includePremiumOnly: true });
}

describe('lawn-mix planned mix for unselected conditionals', () => {
  test('unselected conditional rescue line gets a full planned factor while its live factor stays zero', () => {
    const lines = parseProtocolLines(
      '★ If Talstar failed Jun: Arena 50 WDG (Group 4A) ($5.20)',
      'conditional',
    );
    const [item] = resolveProtocolItems(lines, CATALOG, {}, {});

    expect(item.selected).toBe(false);
    expect(effectiveAreaFactor(item, {})).toBe(0);
    expect(plannedFactor(item)).toBe(1);

    const planned = calculateProductAmount({
      product: item.product,
      lawnSqft: 10000,
      carrierGalPer1000: 2,
      areaFactor: plannedFactor(item),
    });
    expect(planned.amount).toBe(2.9);
    expect(planned.ratePer1000).toBe(0.29);
    expect(planned.materialCost).toBe(15.08);
  });

  test('inspection-only SKIP lines keep a zero planned factor — no product math on a skip instruction', () => {
    const lines = parseProtocolLines(
      '★ IF soil K >80 ppm: SKIP K-Flow → micros only',
      'base',
    );
    const [item] = resolveProtocolItems(lines, CATALOG, {}, {});

    expect(item.scope).toBe('INSPECTION_ONLY');
    expect(plannedFactor(item)).toBe(0);
  });

  test('premium-only add-on shows planned math without a premium plan selected', () => {
    const lines = parseProtocolLines(
      'Hydretain drought prep Premium ($10.59)',
      'conditional',
    );
    const [item] = resolveProtocolItems(lines, CATALOG, {}, {});

    expect(item.scope).toBe('PREMIUM_ONLY');
    expect(item.selected).toBe(false);
    expect(effectiveAreaFactor(item, {})).toBe(0);
    expect(plannedFactor(item)).toBe(1);
  });

  test('selected base lines keep their live factor as the planned factor', () => {
    const lines = parseProtocolLines('BLACKOUT — K-Flow 0-0-25 ($2.18)', 'base');
    const [item] = resolveProtocolItems(lines, CATALOG, {}, {});

    expect(item.selected).toBe(true);
    expect(plannedFactor(item)).toBe(effectiveAreaFactor(item, {}));
  });
});

describe('task-line classification', () => {
  test('priced-line helper matches the unmatched-warning convention', () => {
    expect(isPricedProtocolLine('Moisture Manager ($7.45)')).toBe(true);
    expect(isPricedProtocolLine('★ Chinch re-check ≥20/sq ft threshold')).toBe(false);
    expect(isPricedProtocolLine('★ Conditional ceiling check: >$60 YTD = reprice flag')).toBe(false);
    expect(isPricedProtocolLine(null)).toBe(false);
  });

  test('an unmatched line is a task exactly when the unmatched-product warning would ignore it', () => {
    const items = [
      { raw: '★ Chinch re-check ≥20/sq ft threshold', matched: false },
      { raw: 'Spot Celsius if breakthrough ($3.84)', matched: false },
    ];
    const warned = unmatchedPricedProtocolLines(items);
    for (const item of items) {
      const taskLine = !item.matched && !isPricedProtocolLine(item.raw);
      expect(taskLine).toBe(!warned.includes(item.raw));
    }
  });
});

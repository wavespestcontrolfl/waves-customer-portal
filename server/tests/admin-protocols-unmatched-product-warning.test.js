const adminProtocolsRouter = require('../routes/admin-protocols');
const {
  matchCatalogProduct,
  parseProtocolLines,
} = require('../services/waveguard-plan-engine');

const { unmatchedPricedProtocolLines } = adminProtocolsRouter._internals;

describe('admin protocols unmatched product warning', () => {
  test('flags only unmatched lines that carry a ($N) cost tag', () => {
    const items = [
      { raw: 'Spot Celsius if breakthrough ($3.84)', matched: false },
      { raw: 'Soil sample ALL accounts yr 1 ($15)', matched: false },
      { raw: '★ THATCH MEASUREMENT #1: 3-point probe, >0.75" = dethatch upsell', matched: false },
      { raw: '★ Conditional ceiling check: >$60 YTD = reprice flag', matched: false },
      { raw: 'Dismiss if sedge ($4.36)', matched: true },
    ];

    expect(unmatchedPricedProtocolLines(items)).toEqual([
      'Spot Celsius if breakthrough ($3.84)',
      'Soil sample ALL accounts yr 1 ($15)',
    ]);
  });

  test('tolerates items with missing raw text', () => {
    expect(unmatchedPricedProtocolLines([
      { raw: null, matched: false },
      { matched: false },
    ])).toEqual([]);
  });

  test('seeded alias gaps resolve Celsius and chlorantraniliprole lines', () => {
    // Mirrors migration 20260611000008_protocol_product_alias_gaps.
    const catalog = [
      { id: 'celsius', name: 'Celsius WG', aliases: ['Celsius'] },
      { id: 'acelepryn', name: 'Acelepryn Insecticide', aliases: ['chlorantraniliprole'] },
      { id: 'speedzone', name: 'SpeedZone Southern EW', aliases: ['SpeedZone'] },
    ];

    const [celsiusLine] = parseProtocolLines('Spot Celsius if breakthrough ($3.84)', 'conditional');
    expect(matchCatalogProduct(celsiusLine, catalog)?.name).toBe('Celsius WG');

    const [rotationLine] = parseProtocolLines('rotate to chlorantraniliprole (Group 28) ($4.50)', 'conditional');
    expect(matchCatalogProduct(rotationLine, catalog)?.name).toBe('Acelepryn Insecticide');
  });
});

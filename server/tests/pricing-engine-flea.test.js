const {
  generateEstimate,
  priceFlea,
  priceFleaExterior,
} = require('../services/pricing-engine');

describe('flea treatment pricing', () => {
  test('default base package stays at two visits and $350', () => {
    const result = priceFlea({
      services: { flea: true },
      footprintSqFt: 2000,
      lotSqFt: 7500,
    });

    expect(result).toMatchObject({
      service: 'flea_package',
      initial: 225,
      followUp: 125,
      total: 350,
      visits: 2,
      requiresCustomQuote: false,
    });
  });

  test.each([
    [0, 0],
    [2500, 125],
    [5000, 155],
    [7500, 195],
    [10000, 240],
    [15000, 325],
    [20000, 395],
  ])('prices exterior tier helper for %s sq ft', (area, total) => {
    expect(priceFleaExterior(area, { source: 'CONFIRMED_SQ_FT' }).total).toBe(total);
  });

  test('default package plus 5,000 sf exterior totals $505', () => {
    const result = priceFlea({
      services: { flea: true, fleaExterior: true },
      footprintSqFt: 2000,
      lotSqFt: 7500,
      fleaExteriorAreaSqFt: 5000,
      fleaExteriorAreaSource: 'CONFIRMED_SQ_FT',
    });

    expect(result.initial).toBe(320);
    expect(result.followUp).toBe(185);
    expect(result.total).toBe(505);
    expect(result.adjustments.exteriorArea.total).toBe(155);
    expect(result.display.exteriorDetail).toBe('Exterior flea spray — 5,000 sf');
  });

  test('suppresses lot-size adjustment when exterior spray has a valid priced area', () => {
    const largeLot = priceFlea({
      services: { flea: true, fleaExterior: true },
      footprintSqFt: 2000,
      lotSqFt: 25000,
      fleaExteriorAreaSqFt: 5000,
      fleaExteriorAreaSource: 'CONFIRMED_SQ_FT',
    });
    const defaultLot = priceFlea({
      services: { flea: true, fleaExterior: true },
      footprintSqFt: 2000,
      lotSqFt: 7500,
      fleaExteriorAreaSqFt: 5000,
      fleaExteriorAreaSource: 'CONFIRMED_SQ_FT',
    });

    expect(largeLot.total).toBe(defaultLot.total);
    expect(largeLot.adjustments.lot).toEqual({ initial: 0, followUp: 0 });
  });

  test('requires custom quote over 20,000 sq ft exterior spray area', () => {
    const result = priceFlea({
      services: { flea: true, fleaExterior: true },
      fleaExteriorAreaSqFt: 25000,
      fleaExteriorAreaSource: 'CONFIRMED_SQ_FT',
    });

    expect(result.requiresCustomQuote).toBe(true);
    expect(result.customQuoteReason).toContain('20,000');
    expect(result.customQuoteReason).toContain('custom quote');
  });

  test('unknown source does not auto-price exterior spray and returns confirmation warning', () => {
    const result = priceFlea({
      services: { flea: true, fleaExterior: true },
      footprintSqFt: 2000,
      lotSqFt: 7500,
      fleaExteriorAreaSqFt: 5000,
      fleaExteriorAreaSource: 'UNKNOWN',
    });

    expect(result.adjustments.exteriorArea.total).toBe(0);
    expect(result.total).toBe(350);
    expect(result.warning).toContain('confirmed treatable lawn area');
  });

  test('urgency and recurring-customer modifiers apply after exterior add-on', () => {
    const result = priceFlea({
      services: { flea: true, fleaExterior: true },
      footprintSqFt: 2000,
      lotSqFt: 7500,
      fleaExteriorAreaSqFt: 5000,
      fleaExteriorAreaSource: 'CONFIRMED_SQ_FT',
      urgency: 'SOON',
      isRecurringCustomer: true,
    });

    expect(result.raw.total).toBe(505);
    expect(result.modifiers).toEqual({
      urgencyMultiplier: 1.25,
      recurringCustomerMultiplier: 0.85,
    });
    expect(result.total).toBe(Math.round(505 * 1.25 * 0.85));
  });

  test('generateEstimate keeps server flea total authoritative without a second discount pass', () => {
    const estimate = generateEstimate({
      homeSqFt: 2000,
      stories: 1,
      lotSqFt: 7500,
      propertyType: 'single_family',
      services: {
        flea: {
          fleaExterior: true,
          fleaExteriorAreaSqFt: 5000,
          fleaExteriorAreaSource: 'CONFIRMED_SQ_FT',
        },
      },
    });
    const item = estimate.lineItems.find((line) => line.service === 'flea_package');

    expect(item.total).toBe(505);
    expect(item.totalAfterDiscount).toBe(505);
    expect(estimate.summary.oneTimeTotal).toBe(0);
    expect(estimate.summary.specialtyTotal).toBe(505);
  });
});

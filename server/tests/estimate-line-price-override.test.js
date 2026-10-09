/**
 * Per-line operator price override (owner ask 2026-10-09: a carpenter-ant
 * job the engine priced at $240 is worth $400, and the builder had no way to
 * change the number on an arbitrary service — only the roach fee and the
 * palm $/palm had manual inputs).
 *
 * `input.linePriceOverrides = { [service]: { price, reason } }` rides the
 * engine itself (applyLinePriceOverrides), so the estimator calculate call,
 * the persisted-engineRequest replay and the pricing bundles all reprice
 * identically. These tests pin:
 *   - the typed amount replacing the engine price on a one-time line, with
 *     the engine number kept as `enginePrice` + the reason on the line,
 *   - the typed amount being the FINAL line price (the recurring-customer
 *     one-time perk is not re-applied on top of it), for both a pricer that
 *     bakes the perk in (one_time_pest) and one discounted by service key
 *     (wdo_inspection),
 *   - recurring lines, pest_initial_roach and unknown keys being refused
 *     with an estimate-level warning (never silently),
 *   - a present-but-invalid amount leaving the engine price with a line
 *     warning,
 *   - the v2→v1 translator forwarding the option, and
 *   - the legacy mapper carrying the override fields onto the stored item.
 */
const { generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');

const PROFILE = { homeSqFt: 2000, lotSqFt: 9000, address: '1 Test St' };

function price(selected, options = {}) {
  const input = translateV2CallToV1Input(PROFILE, selected, { urgency: 'ROUTINE', ...options });
  return generateEstimate(input);
}

function line(result, service) {
  return result.lineItems.find((li) => li.service === service);
}

describe('linePriceOverrides', () => {
  test('replaces the engine price of a one-time line and keeps the engine number + reason', () => {
    const baseline = line(price(['OT_PEST']), 'one_time_pest');
    expect(baseline.price).toBeGreaterThan(0);
    expect(baseline.priceOverridden).toBeUndefined();

    const result = price(['OT_PEST'], {
      linePriceOverrides: { one_time_pest: { price: 400, reason: 'carpenter ant infestation' } },
    });
    const li = line(result, 'one_time_pest');
    expect(li.price).toBe(400);
    expect(li.enginePrice).toBe(baseline.price);
    expect(li.priceOverridden).toBe(true);
    expect(li.priceOverrideReason).toBe('carpenter ant infestation');
    expect(li.priceBeforeDiscount).toBe(400);
    expect(li.priceAfterDiscount).toBe(400);
    expect(result.pricingMetadata.warnings.filter((w) => /override/i.test(w))).toEqual([]);
  });

  test('a bare number is accepted as the price', () => {
    const li = line(price(['OT_PEST'], { linePriceOverrides: { one_time_pest: '350.505' } }), 'one_time_pest');
    expect(li.price).toBe(350.51);
    expect(li.priceOverrideReason).toBeNull();
  });

  test('the typed amount is the final line price — the recurring-customer perk is not re-applied', () => {
    const member = price(['PEST', 'OT_PEST', 'WDO'], { recurringCustomer: true });
    // Precondition: without an override the member perk discounts both lines.
    expect(line(member, 'wdo_inspection').priceAfterDiscount).toBeLessThan(line(member, 'wdo_inspection').price);
    expect(line(member, 'one_time_pest').recurringCustomerDiscountRate).toBeGreaterThan(0);

    const overridden = price(['PEST', 'OT_PEST', 'WDO'], {
      recurringCustomer: true,
      linePriceOverrides: { one_time_pest: { price: 400 }, wdo_inspection: { price: 300 } },
    });
    const otp = line(overridden, 'one_time_pest');
    expect(otp.price).toBe(400);
    expect(otp.priceAfterDiscount).toBe(400);
    expect(otp.recurringCustomerDiscountAmount).toBe(0);
    const wdo = line(overridden, 'wdo_inspection');
    expect(wdo.price).toBe(300);
    expect(wdo.priceBeforeDiscount).toBe(300);
    expect(wdo.priceAfterDiscount).toBe(300);
    expect(wdo.discount.appliedDiscounts).toEqual([]);
  });

  test('an estimate-level manual discount still applies on top of the override', () => {
    const result = price(['OT_PEST'], {
      linePriceOverrides: { one_time_pest: { price: 400 } },
      manualDiscount: { type: 'PERCENT', value: 10, label: 'Test', internalReason: 'test' },
    });
    expect(line(result, 'one_time_pest').price).toBe(400);
    expect(result.summary.manualDiscount.oneTimeAmount).toBe(40);
  });

  test('recurring lines, the roach fee line and unknown keys are refused with a warning', () => {
    const baseline = price(['PEST', 'ROACH'], { roachModifier: 'GERMAN', roachType: 'GERMAN' });
    const roachBaseline = line(baseline, 'pest_initial_roach');
    expect(roachBaseline).toBeTruthy();

    const result = price(['PEST', 'ROACH'], {
      roachModifier: 'GERMAN',
      roachType: 'GERMAN',
      linePriceOverrides: { pest_control: 999, pest_initial_roach: 999, no_such_line: 5 },
    });
    expect(line(result, 'pest_control').annual).toBe(line(baseline, 'pest_control').annual);
    expect(line(result, 'pest_initial_roach').price).toBe(roachBaseline.price);
    expect(line(result, 'pest_initial_roach').priceOverridden).toBe(false);
    const warnings = result.pricingMetadata.warnings;
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Price override for pest_control ignored'),
      expect.stringContaining('Price override for pest_initial_roach ignored'),
      expect.stringContaining('Price override for no_such_line ignored'),
    ]));
  });

  test.each([
    ['non-numeric', 'abc'],
    ['negative', -50],
    ['zero', 0],
    ['sub-cent (rounds to $0.00)', 0.004],
  ])('present-but-invalid amount (%s) keeps the engine price with a line warning', (_name, bad) => {
    const baseline = line(price(['OT_PEST']), 'one_time_pest');
    const result = price(['OT_PEST'], { linePriceOverrides: { one_time_pest: { price: bad } } });
    const li = line(result, 'one_time_pest');
    expect(li.price).toBe(baseline.price);
    expect(li.priceOverridden).toBeUndefined();
    expect(li.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Ignoring invalid price override for one_time_pest'),
    ]));
    expect(result.pricingMetadata.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Ignoring invalid price override for one_time_pest'),
    ]));
  });

  test('a blank entry is a no-op', () => {
    const baseline = line(price(['OT_PEST']), 'one_time_pest');
    const li = line(price(['OT_PEST'], { linePriceOverrides: { one_time_pest: { price: '' } } }), 'one_time_pest');
    expect(li.price).toBe(baseline.price);
    expect(li.priceOverridden).toBeUndefined();
  });

  test('translator forwards the option only when present', () => {
    const withIt = translateV2CallToV1Input(PROFILE, ['OT_PEST'], {
      linePriceOverrides: { one_time_pest: { price: 400, reason: 'x' } },
    });
    expect(withIt.linePriceOverrides).toEqual({ one_time_pest: { price: 400, reason: 'x' } });
    const without = translateV2CallToV1Input(PROFILE, ['OT_PEST'], {});
    expect(without).not.toHaveProperty('linePriceOverrides');
  });

  test('legacy mapper carries the override fields onto the stored one-time and specialty items', () => {
    const result = price(['OT_PEST', 'WDO'], {
      linePriceOverrides: {
        one_time_pest: { price: 400, reason: 'carpenter ant infestation' },
        wdo_inspection: { price: 300 },
      },
    });
    const mapped = mapV1ToLegacyShape(result);
    const otp = mapped.oneTime.items.find((i) => i.service === 'one_time_pest');
    expect(otp).toMatchObject({ price: 400, priceOverridden: true, enginePrice: expect.any(Number), priceOverrideReason: 'carpenter ant infestation' });
    const wdo = mapped.specItems.find((i) => i.service === 'wdo_inspection');
    expect(wdo).toMatchObject({ price: 300, priceOverridden: true, enginePrice: 250 });
    expect(mapped.oneTime.total).toBe(700);
  });
});

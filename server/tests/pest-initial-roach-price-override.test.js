/**
 * Per-estimate operator override for the pest_initial_roach fee (owner ask
 * 2026-08-05: the estimator's one-time Cockroach Treatment dollar amount
 * looked editable but wasn't).
 *
 * The override rides the engine itself — pricePestInitialRoach accepts a
 * `priceOverride` option — so every caller (estimator calculate, persisted
 * engineRequest replay, engine-invocation pricing bundles) reprices
 * identically. These tests pin:
 *   - the override replacing the bracket price while `bracketPrice` keeps
 *     the engine number for the audit trail,
 *   - a present-but-invalid override falling back to the bracket price WITH
 *     a warning (never silently),
 *   - the v2→v1 translator forwarding the option on both the recurring
 *     auto-fire and standalone-native paths, and
 *   - the legacy mapper carrying priceOverridden/bracketPrice onto the
 *     persisted one-time item.
 */
const { pricePestInitialRoach, generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');

const PROPERTY = { homeSqFt: 2000 };

const OVERRIDE_WARNING = 'Ignoring invalid initial roach fee override — the bracket price applies. Enter a positive dollar amount to override.';

describe('pricePestInitialRoach priceOverride', () => {
  test('valid override replaces the bracket price and keeps the bracket for audit', () => {
    const line = pricePestInitialRoach(PROPERTY, {
      roachType: 'german',
      autoFiredFromRecurringPest: true,
      priceOverride: 275,
    });
    expect(line.price).toBe(275);
    expect(line.bracketPrice).toBe(199);
    expect(line.priceOverridden).toBe(true);
    expect(line.warnings).not.toContain(OVERRIDE_WARNING);
  });

  test('override rounds to cents and accepts numeric strings', () => {
    const line = pricePestInitialRoach(PROPERTY, {
      roachType: 'german',
      priceOverride: '225.505',
    });
    expect(line.price).toBe(225.51);
    expect(line.priceOverridden).toBe(true);
  });

  test('margin reflects the overridden price, not the bracket price', () => {
    const bracket = pricePestInitialRoach(PROPERTY, { roachType: 'german' });
    const overridden = pricePestInitialRoach(PROPERTY, {
      roachType: 'german',
      priceOverride: 400,
    });
    expect(overridden.margin).toBeGreaterThan(bracket.margin);
  });

  test('standalone native scale honors the override', () => {
    const line = pricePestInitialRoach(PROPERTY, {
      roachType: 'regular',
      standalone: true,
      priceOverride: 300,
    });
    expect(line.scaleKey).toBe('regular_standalone');
    expect(line.price).toBe(300);
    expect(line.bracketPrice).toBe(239);
    expect(line.priceOverridden).toBe(true);
  });

  test.each([
    ['non-numeric', 'abc'],
    ['negative', -50],
    ['zero', 0],
    ['sub-cent (rounds to $0.00)', 0.004],
  ])('present-but-invalid override (%s) falls back to the bracket price with a warning', (_name, bad) => {
    const line = pricePestInitialRoach(PROPERTY, {
      roachType: 'german',
      priceOverride: bad,
    });
    expect(line.price).toBe(199);
    expect(line.priceOverridden).toBe(false);
    expect(line.warnings).toContain(OVERRIDE_WARNING);
  });

  test('absent/blank override is not an error and carries no warning', () => {
    for (const absent of [undefined, null, '', '   ']) {
      const line = pricePestInitialRoach(PROPERTY, {
        roachType: 'german',
        priceOverride: absent,
      });
      expect(line.price).toBe(199);
      expect(line.priceOverridden).toBe(false);
      expect(line.warnings).not.toContain(OVERRIDE_WARNING);
    }
  });
});

describe('generateEstimate override plumbing', () => {
  test('recurring-pest auto-fire uses services.pest.initialRoachPriceOverride', () => {
    const v1 = generateEstimate({
      homeSqFt: 2000,
      services: {
        pest: { frequency: 'quarterly', roachType: 'german', initialRoachPriceOverride: 250 },
      },
    });
    const line = (v1.lineItems || []).find((li) => li.service === 'pest_initial_roach');
    expect(line).toBeTruthy();
    expect(line.autoFiredFromRecurringPest).toBe(true);
    expect(line.price).toBe(250);
    expect(line.bracketPrice).toBe(199);
    expect(line.priceOverridden).toBe(true);
  });

  test('standalone service uses services.pestInitialRoach.priceOverride', () => {
    const v1 = generateEstimate({
      homeSqFt: 2000,
      services: {
        pestInitialRoach: { roachType: 'regular', priceOverride: 260 },
      },
    });
    const line = (v1.lineItems || []).find((li) => li.service === 'pest_initial_roach');
    expect(line).toBeTruthy();
    expect(line.standalone).toBe(true);
    expect(line.price).toBe(260);
    expect(line.bracketPrice).toBe(239);
    expect(line.priceOverridden).toBe(true);
  });

  test('recurring and standalone lines on ONE estimate price from their own overrides', () => {
    // Recurring German auto-fire + standalone native both produce a
    // pest_initial_roach line — each must honor only its own override
    // (codex P2 #3223: a shared field silently repriced both lines).
    const v1 = generateEstimate({
      homeSqFt: 2000,
      services: {
        pest: { frequency: 'quarterly', roachType: 'german', initialRoachPriceOverride: 275 },
        pestInitialRoach: { roachType: 'regular', priceOverride: 300 },
      },
    });
    const lines = (v1.lineItems || []).filter((li) => li.service === 'pest_initial_roach');
    expect(lines).toHaveLength(2);
    const auto = lines.find((li) => li.autoFiredFromRecurringPest);
    const standalone = lines.find((li) => li.standalone);
    expect(auto.price).toBe(275);
    expect(auto.bracketPrice).toBe(199);
    expect(standalone.price).toBe(300);
    expect(standalone.bracketPrice).toBe(239);
  });

  test('legacy mapper carries the override flags onto the persisted one-time item', () => {
    const v1 = generateEstimate({
      homeSqFt: 2000,
      services: {
        pest: { frequency: 'quarterly', roachType: 'german', initialRoachPriceOverride: 250 },
      },
    });
    const mapped = mapV1ToLegacyShape(v1);
    const item = (mapped.oneTime?.items || []).find((it) => it.service === 'pest_initial_roach');
    expect(item).toBeTruthy();
    expect(item.price).toBe(250);
    expect(item.priceOverridden).toBe(true);
    expect(item.bracketPrice).toBe(199);
  });
});

describe('translateV2CallToV1Input override forwarding', () => {
  const PROFILE = { homeSqFt: 2000, lotSqFt: 8000 };

  test('recurring auto-fire path forwards initialRoachPriceOverride raw', () => {
    const v1Input = translateV2CallToV1Input(PROFILE, ['PEST'], {
      roachModifier: 'GERMAN',
      initialRoachPriceOverride: 250,
    });
    expect(v1Input.services.pest.initialRoachPriceOverride).toBe(250);
  });

  test('standalone native path forwards standaloneRoachPriceOverride as priceOverride', () => {
    const v1Input = translateV2CallToV1Input(PROFILE, ['ROACH'], {
      roachType: 'REGULAR',
      standaloneRoachPriceOverride: 260,
    });
    expect(v1Input.services.pestInitialRoach.priceOverride).toBe(260);
  });

  test('each option maps ONLY to its own branch — never crosses over', () => {
    const v1Input = translateV2CallToV1Input(PROFILE, ['PEST', 'ROACH'], {
      roachModifier: 'GERMAN',
      roachType: 'REGULAR',
      initialRoachPriceOverride: 275,
      standaloneRoachPriceOverride: 300,
    });
    expect(v1Input.services.pest.initialRoachPriceOverride).toBe(275);
    expect(v1Input.services.pestInitialRoach.priceOverride).toBe(300);

    const recurringOnly = translateV2CallToV1Input(PROFILE, ['PEST', 'ROACH'], {
      roachModifier: 'GERMAN',
      roachType: 'REGULAR',
      initialRoachPriceOverride: 275,
    });
    expect('priceOverride' in recurringOnly.services.pestInitialRoach).toBe(false);

    const standaloneOnly = translateV2CallToV1Input(PROFILE, ['PEST', 'ROACH'], {
      roachModifier: 'GERMAN',
      roachType: 'REGULAR',
      standaloneRoachPriceOverride: 300,
    });
    expect('initialRoachPriceOverride' in standaloneOnly.services.pest).toBe(false);
  });

  test('absent or blank override adds no keys', () => {
    const noneGiven = translateV2CallToV1Input(PROFILE, ['PEST'], { roachModifier: 'GERMAN' });
    expect('initialRoachPriceOverride' in noneGiven.services.pest).toBe(false);

    const blank = translateV2CallToV1Input(PROFILE, ['ROACH'], {
      roachType: 'REGULAR',
      standaloneRoachPriceOverride: '   ',
    });
    expect('priceOverride' in blank.services.pestInitialRoach).toBe(false);
  });

  test('invalid entry is forwarded raw so the engine can warn instead of a silent drop', () => {
    const v1Input = translateV2CallToV1Input(PROFILE, ['PEST'], {
      roachModifier: 'GERMAN',
      initialRoachPriceOverride: 'abc',
    });
    expect(v1Input.services.pest.initialRoachPriceOverride).toBe('abc');
    const v1 = generateEstimate(v1Input);
    const line = (v1.lineItems || []).find((li) => li.service === 'pest_initial_roach');
    expect(line.price).toBe(199);
    expect(line.priceOverridden).toBe(false);
    expect(line.warnings).toContain(OVERRIDE_WARNING);
  });
});

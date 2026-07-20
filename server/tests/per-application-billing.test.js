/**
 * Per-application billing must charge the plan's TRUE per-visit price.
 *
 * T&S audit 2026-07-18 P1: tier plans present a monthly price
 * (billingFrequencyKey 'monthly') but deliver a non-monthly visit count
 * (tree & shrub 6x/4x). Stamping the monthly cadence amount as the
 * per_application_fee / row estimated_price collected visits/12 of the
 * accepted annual (six completions x annual/12 = half). These tests pin the
 * corrected derivation and the T&S follow-up seeding gate.
 */

const {
  perApplicationChargeAmount,
  resolveBillingCadence,
} = require('../services/billing-cadence');
const EstimateConverter = require('../services/estimate-converter');

describe('perApplicationChargeAmount', () => {
  const tsStandardCadence = resolveBillingCadence({
    monthlyRate: 51.75,
    annualRate: 621,
    frequencyKey: 'monthly',
  });

  test('tree & shrub 6x standard: monthly-billed plan charges annual/6 per application, not annual/12', () => {
    expect(tsStandardCadence.amount).toBe(51.75); // the monthly display rate — NOT the visit price
    const amount = perApplicationChargeAmount({
      billingCadence: tsStandardCadence,
      annualRate: 621,
      monthlyRate: 51.75,
      visitsPerYear: 6,
    });
    expect(amount).toBe(103.5);
    // Six completions collect exactly the accepted annual.
    expect(Math.round(amount * 6 * 100) / 100).toBe(621);
  });

  test('tree & shrub 4x light: quarterly-visit plan billed monthly charges annual/4', () => {
    const cadence = resolveBillingCadence({ monthlyRate: 33.33, annualRate: 400, frequencyKey: 'monthly' });
    const amount = perApplicationChargeAmount({
      billingCadence: cadence,
      annualRate: 400,
      monthlyRate: 33.33,
      visitsPerYear: 4,
    });
    expect(amount).toBe(100);
  });

  test('cadence-matched plan (quarterly pest) is byte-identical to the cadence amount', () => {
    const cadence = resolveBillingCadence({ monthlyRate: 32.67, annualRate: 392, frequencyKey: 'quarterly' });
    expect(cadence.amount).toBe(98);
    const amount = perApplicationChargeAmount({
      billingCadence: cadence,
      annualRate: 392,
      monthlyRate: 32.67,
      visitsPerYear: 4,
    });
    expect(amount).toBe(98);
  });

  test('unknown visit count falls back to the cadence amount', () => {
    expect(perApplicationChargeAmount({
      billingCadence: tsStandardCadence,
      annualRate: 621,
      monthlyRate: 51.75,
      visitsPerYear: null,
    })).toBe(51.75);
    expect(perApplicationChargeAmount({
      billingCadence: tsStandardCadence,
      annualRate: 621,
      monthlyRate: 51.75,
      visitsPerYear: 0,
    })).toBe(51.75);
  });

  test('an annual that diverges from monthly x 12 is not the plan annual — derives from the monthly', () => {
    const cadence = resolveBillingCadence({ monthlyRate: 51.75, annualRate: 900, frequencyKey: 'monthly' });
    const amount = perApplicationChargeAmount({
      billingCadence: cadence,
      annualRate: 900, // e.g. includes a one-time line — not the recurring annual
      monthlyRate: 51.75,
      visitsPerYear: 6,
    });
    expect(amount).toBe(103.5); // 51.75 * 12 / 6
  });

  test('no rates at all returns 0, never NaN', () => {
    expect(perApplicationChargeAmount({ visitsPerYear: 6 })).toBe(0);
    expect(perApplicationChargeAmount({})).toBe(0);
  });
});

describe('resolveFirstApplicationAmount — per-application precedence', () => {
  test('explicit amount always wins', () => {
    expect(EstimateConverter.resolveFirstApplicationAmount({
      firstApplicationAmount: 120,
      perApplicationAmount: 103.5,
      billingCadence: { amount: 51.75 },
    })).toBe(120);
  });

  test('per-application amount outranks the cadence fallback', () => {
    expect(EstimateConverter.resolveFirstApplicationAmount({
      firstApplicationAmount: null,
      perApplicationAmount: 103.5,
      billingCadence: { amount: 51.75 },
      monthlyRate: 51.75,
    })).toBe(103.5);
  });

  test('cadence fallback still applies when no per-application amount exists', () => {
    expect(EstimateConverter.resolveFirstApplicationAmount({
      firstApplicationAmount: null,
      billingCadence: { amount: 98 },
      monthlyRate: 32.67,
    })).toBe(98);
  });

  test('allowFallback:false returns 0 regardless (public-accept contract)', () => {
    expect(EstimateConverter.resolveFirstApplicationAmount({
      firstApplicationAmount: null,
      perApplicationAmount: 103.5,
      billingCadence: { amount: 51.75 },
      allowFallback: false,
    })).toBe(0);
  });
});

describe('supportsConverterFollowUpSeeding — tree & shrub series (six-visit mandate)', () => {
  const { supportsConverterFollowUpSeeding } = EstimateConverter;
  const standardRow = {
    name: 'Bi-Monthly Tree & Shrub Care Service',
    frequency: 'bi_monthly',
    visitsPerYear: 6,
  };
  const lightRow = {
    name: 'Quarterly Tree & Shrub Care Service',
    frequency: 'quarterly',
    visitsPerYear: 4,
  };

  test('6x standard (bimonthly) seeds its series', () => {
    expect(supportsConverterFollowUpSeeding(standardRow, {}, 'bimonthly')).toBe(true);
  });

  test('4x light (quarterly) seeds its series', () => {
    expect(supportsConverterFollowUpSeeding(lightRow, {}, 'quarterly')).toBe(true);
  });

  test('visit count missing still seeds for the restamped catalog cadences', () => {
    expect(supportsConverterFollowUpSeeding(
      { name: 'Bi-Monthly Tree & Shrub Care Service', frequency: 'bi_monthly' }, {}, 'bimonthly',
    )).toBe(true);
  });

  test('retired 9-visit 6-week tier does NOT seed — no month-interval pattern represents it', () => {
    // Visit-count inference maps 9 visits to 'bimonthly'; seeding that would
    // schedule 2-month gaps for a 6-week program. Scheduling stays manual.
    expect(supportsConverterFollowUpSeeding(
      { name: 'Every 6 Weeks Tree & Shrub Care Service', visitsPerYear: 9 }, {}, 'bimonthly',
    )).toBe(false);
  });

  test('non-T&S behavior unchanged: pest quarterly seeds, pest bimonthly does not', () => {
    expect(supportsConverterFollowUpSeeding({ name: 'Quarterly Pest Control' }, {}, 'quarterly')).toBe(true);
    expect(supportsConverterFollowUpSeeding({ name: 'Quarterly Pest Control' }, {}, 'bimonthly')).toBe(false);
  });
});

describe('durationMinutesForRecurringService — tree & shrub', () => {
  test('T&S follow-ups book the flat 60-minute slot (matches estimate-slot-availability)', () => {
    expect(EstimateConverter.durationMinutesForRecurringService(
      { name: 'Bi-Monthly Tree & Shrub Care Service' }, 'bimonthly', {},
    )).toBe(60);
  });

  test('explicit duration still wins', () => {
    expect(EstimateConverter.durationMinutesForRecurringService(
      { name: 'Bi-Monthly Tree & Shrub Care Service', estimatedDurationMinutes: 90 }, 'bimonthly', {},
    )).toBe(90);
  });
});

describe('termite bait per-application billing (owner 2026-07-20)', () => {
  const { supportsConverterFollowUpSeeding } = EstimateConverter;
  const { inferFrequencyKeyFromEstimateData } = require('../services/billing-cadence');

  // The persisted recurring row as the v1 mapper now emits it — the pricer's
  // visitsPerYear/perApp forwarded onto the line as visitsPerYear/perTreatment.
  const newTermiteRow = {
    name: 'Termite Bait', service: 'termite_bait', mo: 35, monthly: 35,
    perTreatment: 105, visitsPerYear: 4,
  };
  // Pre-change payloads carry the flat monthly only.
  const legacyTermiteRow = { name: 'Termite Bait', service: 'termite_bait', mo: 35, monthly: 35 };
  const estimateDataWith = (row) => ({ result: { recurring: { services: [row] } } });

  test('new payload infers a quarterly billing cadence from the persisted visitsPerYear', () => {
    expect(inferFrequencyKeyFromEstimateData(estimateDataWith(newTermiteRow))).toBe('quarterly');
  });

  test('legacy payload infers nothing — the flat-monthly fallback is preserved byte-identically', () => {
    expect(inferFrequencyKeyFromEstimateData(estimateDataWith(legacyTermiteRow))).toBeNull();
  });

  test('quarterly cadence charges the exact per-application price: $420/yr -> $105/application', () => {
    const cadence = resolveBillingCadence({
      monthlyRate: 35,
      annualRate: 420,
      frequencyKey: null,
      estimateData: estimateDataWith(newTermiteRow),
    });
    expect(cadence.frequencyKey).toBe('quarterly');
    expect(cadence.amount).toBe(105);
    const amount = perApplicationChargeAmount({
      billingCadence: cadence, annualRate: 420, monthlyRate: 35, visitsPerYear: 4,
    });
    expect(amount).toBe(105);
    // Four completions collect exactly the accepted annual — the flat-monthly
    // fee stamped before this change collected 4 x $35 = $140 of the $420.
    expect(Math.round(amount * 4 * 100) / 100).toBe(420);
  });

  test('standalone termite quarterly seeds its follow-up series; legacy pattern-less rows do not', () => {
    expect(supportsConverterFollowUpSeeding(newTermiteRow, {}, 'quarterly')).toBe(true);
    expect(supportsConverterFollowUpSeeding(legacyTermiteRow, {}, 'monthly')).toBe(false);
    expect(supportsConverterFollowUpSeeding(newTermiteRow, {}, 'monthly')).toBe(false);
    // Codex P2 (#2911): a legacy row can reach the gate with pattern
    // 'quarterly' inherited from the accept flow's selected/inferred
    // frequency rather than from the row itself — the persisted explicit
    // visits are the seeding license, not the pattern.
    expect(supportsConverterFollowUpSeeding(legacyTermiteRow, {}, 'quarterly')).toBe(false);
  });
});

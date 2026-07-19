const {
  lawnFrequenciesFromResultStats,
  lawnFrequenciesFromEngineResult,
  applySelectedLawnTierToEstimateData,
  recurringLawnRowAtRetiredCadence,
  storedLawnRowBelowProgramFloor,
  resolveEstimateQuoteRequirement,
  buildRenderFlags,
  sectionTierEligibleFromKeys,
} = require('../routes/estimate-public');
const { LAWN_PRICING_V2 } = require('../services/pricing-engine/constants');

// Lawn cost-floor tiers as the engine stores them in result.results.lawn
// (4/6/9/12 visits = Basic/Standard/Enhanced/Premium). The builder turns
// these into the customer-facing cadence options shown in the estimate
// frequency slider.
function lawnEstData({ recommendedVisits = 9 } = {}) {
  return {
    results: {
      lawn: [
        { name: 'Basic', v: 4, mo: 35, ann: 420, pa: 105, recommended: recommendedVisits === 4 },
        { name: 'Standard', v: 6, mo: 55.5, ann: 666, pa: 111, recommended: recommendedVisits === 6 },
        { name: 'Enhanced', v: 9, mo: 66.75, ann: 801, pa: 89, recommended: recommendedVisits === 9 },
        { name: 'Premium', v: 12, mo: 89, ann: 1068, pa: 89, recommended: recommendedVisits === 12 },
      ],
    },
  };
}

describe('lawnFrequenciesFromResultStats — customer-facing lawn cadences', () => {
  test('maps the sold tiers to Bi-monthly / 9 visits / yr / Monthly and drops the retired Quarterly cadence', () => {
    // basic/Quarterly is retired for new sales (owner directive 2026-07-09) —
    // stored rows still carry it, but it must never be re-offered.
    const freqs = lawnFrequenciesFromResultStats(lawnEstData());
    expect(freqs.map((f) => [f.key, f.label, f.visitsPerYear])).toEqual([
      ['standard', 'Bi-monthly', 6],
      ['enhanced', '9 visits / yr', 9],
      ['premium', 'Monthly', 12],
    ]);
  });

  test('emits a perServiceTreatments row so the price card shows the rich per-visit detail block', () => {
    const freqs = lawnFrequenciesFromResultStats(lawnEstData());
    for (const f of freqs) {
      expect(Array.isArray(f.perServiceTreatments)).toBe(true);
      expect(f.perServiceTreatments).toHaveLength(1);
      const row = f.perServiceTreatments[0];
      expect(row.service).toBe('lawn_care');
      expect(row.label).toBe('Lawn Care');
      expect(row.visitsPerYear).toBe(f.visitsPerYear);
      expect(row.displayPrice).toBe(f.perTreatment); // per-visit price drives "$X / application"
    }
  });

  test('carries the cost-floor prices through unchanged and tags lawn_care', () => {
    const freqs = lawnFrequenciesFromResultStats(lawnEstData());
    const enhanced = freqs.find((f) => f.key === 'enhanced');
    expect(enhanced).toMatchObject({
      serviceCategory: 'lawn_care',
      monthly: 66.75,
      annual: 801,
      perTreatment: 89,
      billingFrequencyKey: 'monthly',
    });
    // No manual discount in the fixture → prices equal the base.
    expect(enhanced.monthly).toBe(enhanced.monthlyBase);
  });

  test('the recommended cadence follows the engine row (default = enhanced / 9 visits)', () => {
    const freqs = lawnFrequenciesFromResultStats(lawnEstData({ recommendedVisits: 9 }));
    expect(freqs.filter((f) => f.recommended).map((f) => f.key)).toEqual(['enhanced']);
  });

  test('honors a different recommended tier when the rep selected one', () => {
    const freqs = lawnFrequenciesFromResultStats(lawnEstData({ recommendedVisits: 12 }));
    expect(freqs.filter((f) => f.recommended).map((f) => f.key)).toEqual(['premium']);
  });

  test('returns [] when there is no lawn result', () => {
    expect(lawnFrequenciesFromResultStats({ results: {} })).toEqual([]);
    expect(lawnFrequenciesFromResultStats({})).toEqual([]);
  });

  test('a leading Basic (4-visit) row neither aliases onto Standard nor survives the retirement filter', () => {
    // Basic listed BEFORE Standard — must NOT alias onto standard and drop the
    // real 6-visit Standard row; and being retired, it must not render at all.
    const freqs = lawnFrequenciesFromResultStats({
      results: {
        lawn: [
          { name: 'Basic', v: 4, mo: 35, ann: 420, pa: 105, recommended: false },
          { name: 'Standard', v: 6, mo: 55.5, ann: 666, pa: 111, recommended: false },
          { name: 'Enhanced', v: 9, mo: 66.75, ann: 801, pa: 89, recommended: true },
          { name: 'Premium', v: 12, mo: 89, ann: 1068, pa: 89, recommended: false },
        ],
      },
    });
    expect(freqs.map((f) => f.key)).toEqual(['standard', 'enhanced', 'premium']);
    const std = freqs.find((f) => f.key === 'standard');
    expect(std.label).toBe('Bi-monthly');
    expect(std.visitsPerYear).toBe(6);
    expect(std.monthly).toBe(55.5); // the real 6-visit price, not Basic's $35
  });

  test('each cadence lists the program + treatments as included', () => {
    const std = lawnFrequenciesFromResultStats(lawnEstData()).find((f) => f.key === 'standard');
    expect(std.included.map((i) => i.key)).toEqual(['lawn_care_standard', 'lawn_care_treatments']);
    expect(std.included[0].detail).toBe('6 visits per year');
  });

  test('below-floor stored rows flow through UNCLAMPED at the disarmed config (owner ruling 2026-07-17)', () => {
    // "Forget all pricing floors": programMinimumMonthly is 0 (the designed
    // disarm value), so pre-floor stored prices (e.g. the $38/mo bi-monthly
    // bottom cell) render — and bill — exactly as stored.
    const freqs = lawnFrequenciesFromResultStats({
      results: {
        lawn: [
          { name: 'Standard', v: 6, mo: 38, ann: 456, pa: 76 },
          { name: 'Enhanced', v: 9, mo: 52, ann: 624, pa: 69.33, recommended: true },
          { name: 'Premium', v: 12, mo: 60, ann: 720, pa: 60 },
        ],
      },
    });
    const std = freqs.find((f) => f.key === 'standard');
    expect(std.monthly).toBe(38);
    expect(std.annual).toBe(456);
    expect(std.perTreatment).toBe(76);
    expect(std.monthlyBase).toBe(38);
    const enhanced = freqs.find((f) => f.key === 'enhanced');
    expect(enhanced.monthly).toBe(52);
    expect(enhanced.annual).toBe(624);
  });

  test('a manual discount applies IN FULL — no floor shrinks the surfaced savings (owner ruling 2026-07-17)', () => {
    // Pre-ruling the $50 floor held enhanced at $50 and shrank the surfaced
    // discount to the $2/mo it let through. Floors disarmed: the $120/yr
    // ($10/mo) manual discount lands whole on every tier.
    const freqs = lawnFrequenciesFromResultStats({
      manualDiscount: { type: 'FIXED', value: 120, amount: 120, scope: 'recurring_annual_after_waveguard' },
      results: {
        lawn: [
          { name: 'Enhanced', v: 9, mo: 52, ann: 624, pa: 69.33, recommended: true },
          { name: 'Premium', v: 12, mo: 89, ann: 1068, pa: 89 },
        ],
      },
    });
    const enhanced = freqs.find((f) => f.key === 'enhanced');
    expect(enhanced.monthly).toBe(42); // 52 − 120/12
    expect(enhanced.annual).toBe(504);
    expect(enhanced.manualDiscount).toMatchObject({ capped: false, capReason: null });
    expect(enhanced.manualDiscount.monthlyAmount).toBe(10);
    expect(enhanced.manualDiscount.amount).toBe(120);
    const premium = freqs.find((f) => f.key === 'premium');
    expect(premium.monthly).toBe(79); // 89 − 120/12
    expect(premium.manualDiscount.capReason).not.toBe('lawn_program_minimum');
  });

  test('accept backstop: a recurring lawn row still at a retired cadence is detected (explicit data only)', () => {
    const withLawnRow = (svc) => ({
      result: { recurring: { services: [{ name: 'Pest Control', service: 'pest_control', mo: 50 }, svc] } },
    });
    // Explicit 4-visit / quarterly lawn rows are flagged — the converter
    // would schedule the retired program even though the price was floored.
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', mo: 45, visitsPerYear: 4 },
    ))).toBe(true);
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Quarterly Lawn Care Service', service: 'lawn_care', mo: 45, frequency: 'quarterly' },
    ))).toBe(true);
    // Sold cadences pass.
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', mo: 45, visitsPerYear: 6 },
    ))).toBe(false);
    // A lawn row with NO cadence data stays unflagged — never inferred as
    // quarterly by default.
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', mo: 45 },
    ))).toBe(false);
    // Pest quarterly alone never trips the lawn backstop.
    expect(recurringLawnRowAtRetiredCadence({
      result: { recurring: { services: [{ name: 'Pest Control', service: 'pest_control', mo: 50, frequency: 'quarterly' }] } },
    })).toBe(false);
    // A retired cadence encoded ONLY in the label/service key is flagged too —
    // the appointment seeder schedules from the label when fields are absent.
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Quarterly Lawn Care Service', service: 'lawn_care', mo: 50 },
    ))).toBe(true);
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', serviceKey: 'lawn_care_quarterly', mo: 50 },
    ))).toBe(true);
    // An explicit SOLD cadence field wins over a stale quarterly label.
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Quarterly Lawn Care Service', service: 'lawn_care', mo: 50, visitsPerYear: 6 },
    ))).toBe(false);
    // NUMERIC cadence fields (legacy quote-wizard rows): the seeder parses
    // numeric frequency values as visits/yr, so frequency: 4 (or '4') is the
    // retired program and must be flagged; a sold numeric cadence passes.
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', mo: 45, frequency: 4 },
    ))).toBe(true);
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', mo: 45, frequency: '4' },
    ))).toBe(true);
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', mo: 45, frequency: 6 },
    ))).toBe(false);
    // frequencyKey participates in both the numeric and string checks.
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', mo: 45, frequencyKey: 4 },
    ))).toBe(true);
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', mo: 45, frequencyKey: 'quarterly' },
    ))).toBe(true);
    // Every alias the CONVERTER's explicitServiceCadence reads must flag —
    // the backstop mirrors the exact reader scheduling uses.
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', mo: 45, appsPerYear: 4 },
    ))).toBe(true);
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', mo: 45, apps: 4 },
    ))).toBe(true);
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', mo: 45, recurringPattern: 'quarterly' },
    ))).toBe(true);
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', mo: 45, frequency_key: 'quarterly' },
    ))).toBe(true);
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', mo: 45, treatmentsPerYear: 6 },
    ))).toBe(false);
    // Converter precedence: a cadence FIELD beats a visit count (that is the
    // order explicitServiceCadence resolves — and therefore how the program
    // would actually schedule), unlike quarterly LABEL text which visits win.
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', mo: 45, frequency: 'quarterly', visitsPerYear: 6 },
    ))).toBe(true);
    // Bare `v` tier-row shorthand still flags (converter-skipped alias).
    expect(recurringLawnRowAtRetiredCadence(withLawnRow(
      { name: 'Lawn Care', service: 'lawn_care', mo: 45, v: 4 },
    ))).toBe(true);
  });

  test('quote gate: an explicitly-quarterly lawn row with NO lawn tier rows is quote-required UP FRONT', () => {
    // Legacy/mixed shape with no results.lawn ladder to inspect but a stored
    // recurring lawn row explicitly at the retired cadence: /data and
    // /deposit-intent must enter the quote-required state BEFORE the deposit
    // step — the accept-time backstop alone would 409 only after the
    // customer had already paid the deposit.
    const quarterlyRowNoLadder = {
      result: {
        recurring: {
          services: [
            { name: 'Pest Control', service: 'pest_control', mo: 50 },
            { name: 'Lawn Care', service: 'lawn_care', mo: 45, frequency: 'quarterly' },
          ],
        },
      },
    };
    const quoteState = resolveEstimateQuoteRequirement(null, quarterlyRowNoLadder);
    expect(quoteState.quoteRequired).toBe(true);
    expect(quoteState.reason).toBe('retired_lawn_cadence_requote');
    // A lawn row with NO provable cadence and no ladder is UNINSPECTABLE —
    // the v1/no-engine bundle paths fall back to a generic quarterly-keyed
    // frequency, so it must requote too (accept could otherwise schedule
    // the retired 4-visit program with only its price clamped).
    expect(resolveEstimateQuoteRequirement(null, {
      result: {
        recurring: {
          services: [{ name: 'Lawn Care', service: 'lawn_care', mo: 55 }],
        },
      },
    }).quoteRequired).toBe(true);
    // A row with an explicit SOLD cadence keeps self-serve — the converter
    // schedules lawn from the row itself, never the accepted selection.
    expect(resolveEstimateQuoteRequirement(null, {
      result: {
        recurring: {
          services: [{ name: 'Lawn Care', service: 'lawn_care', mo: 55, visitsPerYear: 6 }],
        },
      },
    }).quoteRequired).toBe(false);
    // Engine-invocation estimates rebuild the live 6/9/12 ladder, so a sold
    // restamp is available — no requote even for a sparse row.
    expect(resolveEstimateQuoteRequirement(null, {
      engineInputs: { services: { lawn: { grassType: 'A' } } },
      result: {
        recurring: {
          services: [{ name: 'Lawn Care', service: 'lawn_care', mo: 55 }],
        },
      },
    }).quoteRequired).toBe(false);
    // ...but the engine carve-out is LAWN-ONLY: a mixed pest+lawn engine
    // estimate exposes only pest frequencies (no lawn axis is rebuilt), so
    // accept never restamps a sparse lawn row and the converter would fall
    // back to the accepted pest cadence — typically the retired quarterly.
    // Sparse mixed rows requote; a provable sold cadence keeps self-serve.
    expect(resolveEstimateQuoteRequirement(null, {
      engineInputs: { services: { pest: { frequency: 'quarterly' }, lawn: { grassType: 'A' } } },
      result: {
        recurring: {
          services: [
            { name: 'Pest Control', service: 'pest_control', mo: 50 },
            { name: 'Lawn Care', service: 'lawn_care', mo: 55 },
          ],
        },
      },
    }).quoteRequired).toBe(true);
    expect(resolveEstimateQuoteRequirement(null, {
      engineInputs: { services: { pest: { frequency: 'quarterly' }, lawn: { grassType: 'A' } } },
      result: {
        recurring: {
          services: [
            { name: 'Pest Control', service: 'pest_control', mo: 50 },
            { name: 'Lawn Care', service: 'lawn_care', mo: 55, visitsPerYear: 9 },
          ],
        },
      },
    }).quoteRequired).toBe(false);
  });

  test('SSR floor guard is INERT at the disarmed config — no row routes to requote (owner ruling 2026-07-17)', () => {
    // storedLawnRowBelowProgramFloor guards on programMinimumMonthly > 0 and
    // goes inert at the disarmed 0 — even a $34/mo stored row is a valid
    // sold price now, never a requote trigger.
    const withRows = (services) => ({ result: { recurring: { services } } });
    expect(storedLawnRowBelowProgramFloor(withRows([
      { name: 'Lawn Care', service: 'lawn_care', mo: 34, visitsPerYear: 6 },
    ]))).toBe(false);
    expect(storedLawnRowBelowProgramFloor(withRows([
      { name: 'Lawn Care', service: 'lawn_care', ann: 408, visitsPerYear: 6 },
    ]))).toBe(false);
    expect(storedLawnRowBelowProgramFloor(withRows([
      { name: 'Lawn Care', service: 'lawn_care', mo: 50, visitsPerYear: 6 },
    ]))).toBe(false);
    expect(storedLawnRowBelowProgramFloor(withRows([
      { name: 'Pest Control', service: 'pest_control', mo: 34 },
    ]))).toBe(false);
    expect(storedLawnRowBelowProgramFloor(withRows([
      { name: 'Lawn Care', service: 'lawn_care', visitsPerYear: 6 },
    ]))).toBe(false);
  });

  test('annual-only lawn tier rows pass through unclamped (monthly stays null — accept falls back to stored monthly_total)', () => {
    // Floors disarmed (owner ruling 2026-07-17): the clamp that used to
    // re-derive a monthly for annual-only rows is inert, so the stored
    // annual flows through and monthly stays null — accept's fallback to
    // the stored monthly_total is now the correct (unclamped) price anyway.
    const freqs = lawnFrequenciesFromResultStats({
      results: {
        lawn: [
          { name: 'Standard', v: 6, ann: 408, recommended: true },
        ],
      },
    });
    const std = freqs.find((f) => f.key === 'standard');
    expect(std.annual).toBe(408);
    expect(std.monthly).toBeNull();
  });

  test('an at-$50 row takes a manual discount IN FULL — nothing is suppressed at the disarmed config (owner ruling 2026-07-17)', () => {
    // Pre-ruling this exact fixture had zero discount room at the floor and
    // set manualDiscountSuppressed. Floors disarmed: the $10/mo discount
    // lands whole and the discount surfaces uncapped.
    const freqs = lawnFrequenciesFromResultStats({
      manualDiscount: { type: 'FIXED', value: 120, amount: 120, scope: 'recurring_annual_after_waveguard' },
      results: {
        lawn: [
          { name: 'Standard', v: 6, mo: 50, ann: 600, pa: 100, recommended: true },
        ],
      },
    });
    const std = freqs.find((f) => f.key === 'standard');
    expect(std.monthly).toBe(40); // 50 − 120/12
    expect(std.annual).toBe(480);
    expect(std.manualDiscount).toMatchObject({ capped: false, capReason: null, monthlyAmount: 10 });
    expect(std.manualDiscountSuppressed).toBeUndefined();
  });
});

describe('program-minimum machinery re-armed at $50 — kept for potential re-arm (disarmed by default, owner ruling 2026-07-17)', () => {
  // The clamp/guard machinery stays in the code, inert at the shipped
  // programMinimumMonthly = 0. These pins re-arm the pre-ruling $50 so the
  // machinery keeps working if the owner ever re-arms the floor.
  // Snapshot/restore pattern per tests/lawn-pricing-ladder-invariants.test.js.
  let priorProgramMinimum;
  beforeEach(() => {
    priorProgramMinimum = LAWN_PRICING_V2.programMinimumMonthly;
    LAWN_PRICING_V2.programMinimumMonthly = 50;
  });
  afterEach(() => {
    LAWN_PRICING_V2.programMinimumMonthly = priorProgramMinimum;
  });

  test('re-armed: clamps below-floor stored rows to the $50/mo program minimum (annual/per-app re-derived)', () => {
    const freqs = lawnFrequenciesFromResultStats({
      results: {
        lawn: [
          { name: 'Standard', v: 6, mo: 38, ann: 456, pa: 76 },
          { name: 'Enhanced', v: 9, mo: 52, ann: 624, pa: 69.33, recommended: true },
          { name: 'Premium', v: 12, mo: 60, ann: 720, pa: 60 },
        ],
      },
    });
    const std = freqs.find((f) => f.key === 'standard');
    expect(std.monthly).toBe(50);
    expect(std.annual).toBe(600);
    expect(std.perTreatment).toBe(100);
    expect(std.monthlyBase).toBe(50); // anchor never sits below the net price
    // Above-floor rows keep their stored numbers exactly.
    const enhanced = freqs.find((f) => f.key === 'enhanced');
    expect(enhanced.monthly).toBe(52);
    expect(enhanced.annual).toBe(624);
  });

  test('re-armed: SSR floor guard detects stored below-floor lawn rows; compliant and non-lawn rows pass', () => {
    const withRows = (services) => ({ result: { recurring: { services } } });
    expect(storedLawnRowBelowProgramFloor(withRows([
      { name: 'Lawn Care', service: 'lawn_care', mo: 34, visitsPerYear: 6 },
    ]))).toBe(true);
    // Annual-only rows count via annual/12.
    expect(storedLawnRowBelowProgramFloor(withRows([
      { name: 'Lawn Care', service: 'lawn_care', ann: 408, visitsPerYear: 6 },
    ]))).toBe(true);
    expect(storedLawnRowBelowProgramFloor(withRows([
      { name: 'Lawn Care', service: 'lawn_care', mo: 50, visitsPerYear: 6 },
    ]))).toBe(false);
    expect(storedLawnRowBelowProgramFloor(withRows([
      { name: 'Pest Control', service: 'pest_control', mo: 34 },
    ]))).toBe(false);
    expect(storedLawnRowBelowProgramFloor(withRows([
      { name: 'Lawn Care', service: 'lawn_care', visitsPerYear: 6 },
    ]))).toBe(false);
  });

  test('re-armed: annual-only lawn tier rows clamped by the floor derive a monthly too', () => {
    const freqs = lawnFrequenciesFromResultStats({
      results: {
        lawn: [
          { name: 'Standard', v: 6, ann: 408, recommended: true },
        ],
      },
    });
    const std = freqs.find((f) => f.key === 'standard');
    expect(std.annual).toBe(600);
    expect(std.monthly).toBe(50);
  });

  test('re-armed: a manual discount fully blocked by the floor is SUPPRESSED, not just dropped', () => {
    const freqs = lawnFrequenciesFromResultStats({
      manualDiscount: { type: 'FIXED', value: 120, amount: 120, scope: 'recurring_annual_after_waveguard' },
      results: {
        lawn: [
          { name: 'Standard', v: 6, mo: 50, ann: 600, pa: 100, recommended: true },
        ],
      },
    });
    const std = freqs.find((f) => f.key === 'standard');
    expect(std.monthly).toBe(50);
    expect(std.annual).toBe(600);
    expect(std.manualDiscount).toBeNull();
    expect(std.manualDiscountSuppressed).toBe(true);
  });

  test('re-armed: a floor-capped selected tier keeps the requested WaveGuard discount on above-floor tiers', () => {
    // Standard (660 gross) at the floor: Silver 10% caps back to 600, so
    // annualAfter/annualBefore reads ~0.91 and would strip the discount from
    // the other tiers. The ladder must use the engine's requested rate —
    // Enhanced/Premium keep their 10% off; Standard re-clamps at the floor.
    const line = {
      service: 'lawn_care', tier: 'standard', monthly: 62.25, annual: 747,
      tiers: [
        { tier: 'basic', label: '4x applications/yr', monthly: 35, annual: 420, perApp: 105, visits: 4, freq: 4, recommended: false },
        { tier: 'standard', label: '6x applications/yr', monthly: 55, annual: 660, perApp: 110, visits: 6, freq: 6, recommended: false },
        { tier: 'enhanced', label: '9x applications/yr', monthly: 62.25, annual: 747, perApp: 83, visits: 9, freq: 9, recommended: true },
        { tier: 'premium', label: '12x applications/yr', monthly: 84, annual: 1008, perApp: 84, visits: 12, freq: 12, recommended: false },
      ],
      annualBeforeDiscount: 660,
      annualAfterDiscount: 600, // program minimum capped the Silver 10%
      programMinimumGuardApplied: true,
      requestedDiscountPct: 0.10,
    };
    const freqs = lawnFrequenciesFromEngineResult({ lineItems: [line] });
    const std = freqs.find((f) => f.key === 'standard');
    expect(std.monthly).toBe(50); // 660 * 0.9 = 594 → floor holds at $50/$600
    const enhanced = freqs.find((f) => f.key === 'enhanced');
    expect(enhanced.annual).toBe(672.3); // 747 * 0.9 — discount preserved
    expect(enhanced.monthly).toBe(56.03);
    const premium = freqs.find((f) => f.key === 'premium');
    expect(premium.annual).toBe(907.2); // 1008 * 0.9
  });
});

describe('lawnFrequenciesFromEngineResult — engine-invocation lawn-only ladder', () => {
  // Server-authoritative / IB estimates store engineInputs, not a precomputed
  // result.results.lawn. The lawn line item the engine emits carries its tier
  // ladder (4/6/9/12), which must expand into the same cadence options instead
  // of collapsing into one Quarterly entry.
  function lawnLineItem() {
    return {
      service: 'lawn_care',
      tier: 'enhanced',
      monthly: 62.25,
      annual: 747,
      tiers: [
        { tier: 'basic', label: '4x applications/yr', monthly: 35, annual: 420, perApp: 105, visits: 4, freq: 4, recommended: false },
        { tier: 'standard', label: '6x applications/yr', monthly: 55, annual: 660, perApp: 110, visits: 6, freq: 6, recommended: false },
        { tier: 'enhanced', label: '9x applications/yr', monthly: 62.25, annual: 747, perApp: 83, visits: 9, freq: 9, recommended: true },
        { tier: 'premium', label: '12x applications/yr', monthly: 84, annual: 1008, perApp: 84, visits: 12, freq: 12, recommended: false },
      ],
    };
  }

  test('expands the lawn line item tiers into the sold cadences, in order (Quarterly retired)', () => {
    const freqs = lawnFrequenciesFromEngineResult({ lineItems: [lawnLineItem()] });
    expect(freqs.map((f) => [f.key, f.label, f.visitsPerYear, f.monthly])).toEqual([
      ['standard', 'Bi-monthly', 6, 55],
      ['enhanced', '9 visits / yr', 9, 62.25],
      ['premium', 'Monthly', 12, 84],
    ]);
    expect(freqs.find((f) => f.key === 'enhanced').selected).toBe(true);
  });

  function marginFlooredLine() {
    return {
      service: 'lawn_care',
      tier: 'enhanced',
      monthly: 57.5,
      annual: 747,
      annualBeforeDiscount: 747,
      annualAfterDiscount: 690,
      marginFloorGuardApplied: true,
      requestedDiscountPct: 0.10,
      tiers: [
        { tier: 'standard', label: '6x applications/yr', monthly: 55, annual: 660, perApp: 110, visits: 6, freq: 6, minimumCollectedAnnualPrice: 640 },
        { tier: 'enhanced', label: '9x applications/yr', monthly: 62.25, annual: 747, perApp: 83, visits: 9, freq: 9, recommended: true, minimumCollectedAnnualPrice: 690 },
        { tier: 'premium', label: '12x applications/yr', monthly: 84, annual: 1008, perApp: 84, visits: 12, freq: 12, minimumCollectedAnnualPrice: 700 },
      ],
    };
  }

  test('margin floors on tier rows do NOT re-clamp the ladder while disarmed (owner 2026-07-17)', () => {
    // minimumCollectedAnnualPrice rides every tier row for margin REPORTING;
    // with the cost floor disarmed (useLawnCostFloor false) its presence must
    // never move a ladder price — the 640 "floor" on standard reports only
    // and the requested 10% survives on every cadence.
    const freqs = lawnFrequenciesFromEngineResult({ lineItems: [marginFlooredLine()] });
    const byKey = Object.fromEntries(freqs.map((f) => [f.key, f]));
    expect(byKey.standard.monthly).toBeCloseTo(49.5, 2);
    expect(byKey.premium.monthly).toBeCloseTo(75.6, 2);
    expect(byKey.standard.flooredAtMinimum).toBe(false);
    expect(freqs.map((f) => f.key)).toEqual(['standard', 'enhanced', 'premium']);
  });

  test('a per-estimate cost-floor re-arm (stored engine inputs) clamps the ladder while the global switch is off', () => {
    // The adapter forwards options.useLawnCostFloor into the lawn service,
    // so an individual estimate can be floor-priced/capped by the engine
    // while lawn_pricing_v2.useLawnCostFloor stays false. View/accept must
    // clamp that estimate's cadences the same way (save == accept) — the
    // arm state is read off the stored engine inputs (codex P2 on the
    // #2827 main-merge).
    const estData = {
      engineInputs: {
        services: { lawn: { track: 'st_augustine', lawnFreq: 9, useLawnCostFloor: true } },
      },
    };
    const freqs = lawnFrequenciesFromEngineResult({ lineItems: [marginFlooredLine()] }, estData);
    const byKey = Object.fromEntries(freqs.map((f) => [f.key, f]));
    // Standard clamps at its own 640 floor (CEIL to cents) exactly as under
    // a global re-arm; premium keeps its headroom.
    expect(byKey.standard.monthly).toBeCloseTo(53.34, 2);
    expect(byKey.premium.monthly).toBeCloseTo(75.6, 2);
  });

  test('an admin V2 estimate re-armed via engineRequest.options clamps the ladder too', () => {
    // Admin V2 saves persist the exact /calculate-estimate payload under
    // engineRequest — the arm signal lives on options.useLawnCostFloor
    // there, not under engineInputs (codex P2, round 6 on #2827).
    const estData = {
      engineRequest: {
        profile: { measuredTurfSf: 5012 },
        selectedServices: ['LAWN'],
        options: { useLawnCostFloor: true, lawnFreq: 9 },
      },
    };
    const freqs = lawnFrequenciesFromEngineResult({ lineItems: [marginFlooredLine()] }, estData);
    const byKey = Object.fromEntries(freqs.map((f) => [f.key, f]));
    expect(byKey.standard.monthly).toBeCloseTo(53.34, 2);
    expect(byKey.premium.monthly).toBeCloseTo(75.6, 2);

    // An explicit false on the payload is a deliberate disarm — no clamp.
    const disarmed = lawnFrequenciesFromEngineResult({ lineItems: [marginFlooredLine()] }, {
      engineRequest: {
        profile: { measuredTurfSf: 5012 },
        selectedServices: ['LAWN'],
        options: { useLawnCostFloor: false, lawnFreq: 9 },
      },
    });
    const disarmedByKey = Object.fromEntries(disarmed.map((f) => [f.key, f]));
    expect(disarmedByKey.standard.monthly).toBeCloseTo(49.5, 2);
  });

  test('an explicit per-estimate disarm beats a global re-arm (save == accept both directions)', () => {
    // generateEstimate resolves the flag with ?? — an estimate deliberately
    // saved with useLawnCostFloor: false was priced WITHOUT the floor, so a
    // later global re-arm must not re-clamp it above its saved price
    // (codex P2, round 7 on #2827).
    const priorUseFloor = LAWN_PRICING_V2.useLawnCostFloor;
    LAWN_PRICING_V2.useLawnCostFloor = true;
    try {
      const freqs = lawnFrequenciesFromEngineResult({ lineItems: [marginFlooredLine()] }, {
        engineRequest: {
          profile: { measuredTurfSf: 5012 },
          selectedServices: ['LAWN'],
          options: { useLawnCostFloor: false, lawnFreq: 9 },
        },
      });
      const byKey = Object.fromEntries(freqs.map((f) => [f.key, f]));
      expect(byKey.standard.monthly).toBeCloseTo(49.5, 2);
    } finally {
      LAWN_PRICING_V2.useLawnCostFloor = priorUseFloor;
    }
  });

  test('the result pricingMetadata arm stamp beats the global switch in both directions', () => {
    // Stamped true + global off: a save the global switch armed keeps its
    // clamp after the switch is turned back off…
    const armedStamp = lawnFrequenciesFromEngineResult({ lineItems: [marginFlooredLine()] }, {
      result: { pricingMetadata: { lawnCostFloorArmed: true } },
    });
    expect(Object.fromEntries(armedStamp.map((f) => [f.key, f])).standard.monthly)
      .toBeCloseTo(53.34, 2);

    // …and a stamped-disarmed save survives a later global re-arm.
    const priorUseFloor = LAWN_PRICING_V2.useLawnCostFloor;
    LAWN_PRICING_V2.useLawnCostFloor = true;
    try {
      const disarmedStamp = lawnFrequenciesFromEngineResult({ lineItems: [marginFlooredLine()] }, {
        result: { pricingMetadata: { lawnCostFloorArmed: false } },
      });
      expect(Object.fromEntries(disarmedStamp.map((f) => [f.key, f])).standard.monthly)
        .toBeCloseTo(49.5, 2);
    } finally {
      LAWN_PRICING_V2.useLawnCostFloor = priorUseFloor;
    }
  });

  test('the result pricingMetadata program-minimum stamp beats the global value in both directions', () => {
    // Stamped $50 + global 0: a quote saved while the minimum was re-armed
    // keeps its clamp after the global returns to 0 — the customer accepts
    // exactly what was saved (pre-push codex P0, round 9 on #2827)…
    const stamped = lawnFrequenciesFromEngineResult({ lineItems: [marginFlooredLine()] }, {
      result: { pricingMetadata: { lawnProgramMinimumMonthly: 50 } },
    });
    expect(Object.fromEntries(stamped.map((f) => [f.key, f])).standard.monthly)
      .toBeCloseTo(50, 2);

    // …and a quote stamped disarmed (0) is never clamped UP by a later
    // global re-arm.
    const prior = LAWN_PRICING_V2.programMinimumMonthly;
    LAWN_PRICING_V2.programMinimumMonthly = 50;
    try {
      const disarmedStamp = lawnFrequenciesFromEngineResult({ lineItems: [marginFlooredLine()] }, {
        result: { pricingMetadata: { lawnProgramMinimumMonthly: 0 } },
      });
      expect(Object.fromEntries(disarmedStamp.map((f) => [f.key, f])).standard.monthly)
        .toBeCloseTo(49.5, 2);
    } finally {
      LAWN_PRICING_V2.programMinimumMonthly = prior;
    }
  });

  test('a legacy pre-stamp estimate keeps its saved program-minimum clamp via stored row evidence', () => {
    // Pre-stamp saves made while the minimum was armed carry it on the
    // stored rows (mapper prov.programMinimumMonthly, or the applied flag on
    // value-less client-fallback rows). With the global now 0, the ladder
    // must still clamp at the saved $50 — a $600 saved line must not render
    // or accept at $594 (pre-push codex P0, round 9 on #2827).
    const provStamp = lawnFrequenciesFromEngineResult({ lineItems: [marginFlooredLine()] }, {
      result: { results: { lawn: [{ v: 6, mo: 50, ann: 600, prov: { programMinimumMonthly: 50 } }] } },
    });
    expect(Object.fromEntries(provStamp.map((f) => [f.key, f])).standard.monthly)
      .toBeCloseTo(50, 2);

    // Client-fallback legacy row: applied flag only — its clamped monthly IS
    // the minimum it was held at.
    const appliedFlag = lawnFrequenciesFromEngineResult({ lineItems: [marginFlooredLine()] }, {
      result: { results: { lawn: [{ v: 6, mo: 50, ann: 600, programMinimumApplied: true, pricingSource: 'PROGRAM_MINIMUM' }] } },
    });
    expect(Object.fromEntries(appliedFlag.map((f) => [f.key, f])).standard.monthly)
      .toBeCloseTo(50, 2);

    // Cadence rounding must not inflate the inference: the historical $50
    // minimum produced $50 (6x) AND $50.25 (9x — annual ceil'd to a whole
    // per-app multiple). The MIN over applied rows recovers $50; max would
    // re-price $50 tiers to $50.25 (pre-push codex P0, round 9).
    const roundedRows = lawnFrequenciesFromEngineResult({ lineItems: [marginFlooredLine()] }, {
      result: {
        results: {
          lawn: [
            { v: 6, mo: 50, ann: 600, programMinimumApplied: true },
            { v: 9, mo: 50.25, ann: 603, programMinimumApplied: true },
          ],
        },
      },
    });
    expect(Object.fromEntries(roundedRows.map((f) => [f.key, f])).standard.monthly)
      .toBeCloseTo(50, 2);

    // A post-disarm stamp (0) BEATS row evidence — deliberate disarm wins.
    const disarmedStamp = lawnFrequenciesFromEngineResult({ lineItems: [marginFlooredLine()] }, {
      result: {
        pricingMetadata: { lawnProgramMinimumMonthly: 0 },
        results: { lawn: [{ v: 6, mo: 50, ann: 600, prov: { programMinimumMonthly: 50 } }] },
      },
    });
    expect(Object.fromEntries(disarmedStamp.map((f) => [f.key, f])).standard.monthly)
      .toBeCloseTo(49.5, 2);
  });

  test('a legacy pre-disarm estimate keeps its floor re-clamp via stored enforcement stamps', () => {
    // Pre-disarm saves never persisted the flag (the engine armed by
    // default) — the evidence is the enforcement stamps on the stored rows.
    // With no flag anywhere and the global switch off, a COST_FLOOR-stamped
    // row arms the whole estimate's ladder so the sent snapshot cannot be
    // discounted below the floor it was priced on (codex P2, round 7).
    const line = marginFlooredLine();
    line.tiers = line.tiers.map((t) => (
      t.tier === 'enhanced' ? { ...t, pricingSource: 'COST_FLOOR', costFloorApplied: true } : t
    ));
    const freqs = lawnFrequenciesFromEngineResult({ lineItems: [line] }, {});
    const byKey = Object.fromEntries(freqs.map((f) => [f.key, f]));
    expect(byKey.standard.monthly).toBeCloseTo(53.34, 2);
    expect(byKey.premium.monthly).toBeCloseTo(75.6, 2);

    // Reporting fields alone (minimumCollectedAnnualPrice on every row of
    // the base fixture) remain NON-evidence — the disarmed pin above stays
    // unclamped.
  });

  test('re-armed: a margin-floor-capped selected line keeps the requested discount per cadence and re-clamps each at ITS floor', () => {
    const priorUseFloor = LAWN_PRICING_V2.useLawnCostFloor;
    LAWN_PRICING_V2.useLawnCostFloor = true;
    try {
      const freqs = lawnFrequenciesFromEngineResult({ lineItems: [marginFlooredLine()] });
      const byKey = Object.fromEntries(freqs.map((f) => [f.key, f]));
      // Standard: 10% off 660 = 594 breaches its own 640 margin floor -> clamped
      // there (monthly CEILs to cents so the reconstructed annual never lands
      // below the floor).
      expect(byKey.standard.monthly).toBeCloseTo(53.34, 2);
      // Premium has headroom: the full requested 10% survives instead of the
      // selected line's capped after/before ratio.
      expect(byKey.premium.monthly).toBeCloseTo(75.6, 2);
      // A margin-floored cadence is a real, distinctly-priced choice - it is
      // NOT flagged as a program-minimum decoy for hiding.
      expect(byKey.standard.flooredAtMinimum).toBe(false);
      expect(freqs.map((f) => f.key)).toEqual(['standard', 'enhanced', 'premium']);
    } finally {
      LAWN_PRICING_V2.useLawnCostFloor = priorUseFloor;
    }
  });

  test('returns [] for mixed bundles so lawn keeps pricing inside the pest cadence', () => {
    const mixed = {
      lineItems: [
        { service: 'pest_control', perApp: 40, monthly: 55, annual: 660 },
        lawnLineItem(),
      ],
    };
    expect(lawnFrequenciesFromEngineResult(mixed)).toEqual([]);
  });

  test('returns [] when there is no lawn line item', () => {
    expect(lawnFrequenciesFromEngineResult({ lineItems: [{ service: 'mosquito', tiers: [] }] })).toEqual([]);
    expect(lawnFrequenciesFromEngineResult({})).toEqual([]);
  });

  test('still expands the ladder when a one-time add-on rides alongside recurring lawn', () => {
    // one_time_pest aliases to pest_control via recurringServiceKey — it must be
    // dropped before the lawn-only check so the ladder is not suppressed.
    const withOneTime = {
      lineItems: [
        lawnLineItem(),
        { service: 'one_time_pest', perApp: 250 },
        { service: 'one_time_mosquito', perApp: 120 },
      ],
    };
    expect(lawnFrequenciesFromEngineResult(withOneTime).map((f) => f.key))
      .toEqual(['standard', 'enhanced', 'premium']);
  });

  test('carries the WaveGuard membership discount into every tier price — no program-minimum clamp (owner ruling 2026-07-17)', () => {
    // Existing-customer reprice: the engine discounted the lawn line 15%
    // (annualBeforeDiscount → annualAfterDiscount). Each tier must reflect that,
    // since accept bills selectedFrequency.monthly/annual directly. Floors are
    // disarmed — the full 15% lands on every tier, even below the old $50 line.
    const discounted = lawnLineItem();
    discounted.annualBeforeDiscount = 747; // enhanced gross annual
    discounted.annualAfterDiscount = 634.95; // 15% off
    const freqs = lawnFrequenciesFromEngineResult({ lineItems: [discounted] });
    const enhanced = freqs.find((f) => f.key === 'enhanced');
    expect(enhanced.annual).toBe(634.95); // 747 * 0.85
    expect(enhanced.monthly).toBe(52.91); // 634.95 / 12
    const std = freqs.find((f) => f.key === 'standard');
    // 660 gross * 0.85 = 561 → $46.75/mo, unclamped.
    expect(std.monthly).toBe(46.75);
    expect(std.annual).toBe(561);
    expect(std.perTreatment).toBe(93.5);
  });

  test('applies a manual recurring discount surfaced on the live engine summary', () => {
    // engineInputs carry a 10% manual discount the stored blob doesn't record;
    // the engine summary surfaces it. Each tier must price after that discount.
    const engineResult = {
      lineItems: [lawnLineItem()],
      summary: { manualDiscount: { type: 'PERCENT', value: 10, amount: 74.7, scope: 'recurring_annual_after_waveguard' } },
    };
    const freqs = lawnFrequenciesFromEngineResult(engineResult, {});
    const enhanced = freqs.find((f) => f.key === 'enhanced');
    expect(enhanced.manualDiscount).toBeTruthy();
    expect(enhanced.monthly).toBe(56.02); // 62.25/mo base − 6.23 (10% of 747, /12)
  });

  test('honors the accepted tier from customerSelection over the engine default', () => {
    // Stored as Enhanced but accepted as Standard: the re-rendered ladder must
    // mark Standard selected, not the engine's resolved Enhanced tier.
    const freqs = lawnFrequenciesFromEngineResult(
      { lineItems: [lawnLineItem()] },
      { customerSelection: { serviceTierKey: 'standard' } },
    );
    expect(freqs.find((f) => f.selected)).toMatchObject({ key: 'standard' });
    expect(freqs.find((f) => f.key === 'enhanced').selected).toBe(false);
  });

  test('a legacy guard-capped stored line still spreads the requested WaveGuard rate — now uncapped everywhere (owner ruling 2026-07-17)', () => {
    // A pre-ruling stored line carries programMinimumGuardApplied +
    // requestedDiscountPct (the floor had capped Silver 10% back to $600).
    // The requestedDiscountPct machinery must still spread the engine's
    // requested rate across the ladder — and with floors disarmed, Standard
    // takes the full 10% too instead of re-clamping at $50.
    // (Re-armed behavior is pinned in the machinery describe above.)
    const line = lawnLineItem();
    line.tier = 'standard';
    line.annualBeforeDiscount = 660;
    line.annualAfterDiscount = 600; // legacy: program minimum had capped the Silver 10%
    line.programMinimumGuardApplied = true;
    line.requestedDiscountPct = 0.10;
    const freqs = lawnFrequenciesFromEngineResult({ lineItems: [line] });
    const std = freqs.find((f) => f.key === 'standard');
    expect(std.monthly).toBe(49.5); // 660 * 0.9 = 594/yr — full discount, no floor
    expect(std.annual).toBe(594);
    const enhanced = freqs.find((f) => f.key === 'enhanced');
    expect(enhanced.annual).toBe(672.3); // 747 * 0.9 — discount preserved
    expect(enhanced.monthly).toBe(56.03);
    const premium = freqs.find((f) => f.key === 'premium');
    expect(premium.annual).toBe(907.2); // 1008 * 0.9
  });

  test('a legacy accepted Basic selection no longer resolves to a selectable cadence', () => {
    // Quarterly is retired: an old estimate accepted at Basic re-renders the
    // ladder without it (and without any selected row — the view falls back to
    // its default), so the $30/mo cadence can never be re-accepted.
    const freqs = lawnFrequenciesFromEngineResult(
      { lineItems: [lawnLineItem()] },
      { customerSelection: { serviceTierKey: 'basic' } },
    );
    expect(freqs.map((f) => f.key)).toEqual(['standard', 'enhanced', 'premium']);
    expect(freqs.find((f) => f.selected)).toBeUndefined();
  });

  test('still expands the ladder beside a specialty one-time row (rodent_trapping)', () => {
    // rodent_trapping has no recurring monthly/annual and fuzzily maps to the
    // 'rodent' family — it must not count as a second recurring service.
    const withSpecialty = {
      lineItems: [
        lawnLineItem(),
        { service: 'rodent_trapping', name: 'Rodent Trapping', price: 450, finalPrice: 450 },
      ],
    };
    expect(lawnFrequenciesFromEngineResult(withSpecialty).map((f) => f.key))
      .toEqual(['standard', 'enhanced', 'premium']);
  });

  test('still returns [] for a genuine recurring bundle (lawn + rodent_bait)', () => {
    const bundle = {
      lineItems: [
        lawnLineItem(),
        { service: 'rodent_bait', monthly: 35, annual: 420 },
      ],
    };
    expect(lawnFrequenciesFromEngineResult(bundle)).toEqual([]);
  });
});

describe('applySelectedLawnTierToEstimateData — accept re-stamps the picked cadence', () => {
  function estDataWithRecurringLawn() {
    return {
      result: {
        recurring: {
          monthlyTotal: 66.75,
          services: [{ name: 'Lawn Care', service: 'lawn_care', mo: 66.75, ann: 801, v: 9, visitsPerYear: 9 }],
        },
        results: {
          lawn: [
            { name: 'Standard', v: 6, mo: 55.5, ann: 666, pa: 111, recommended: false },
            { name: 'Enhanced', v: 9, mo: 66.75, ann: 801, pa: 89, recommended: true },
            { name: 'Premium', v: 12, mo: 89, ann: 1068, pa: 89, recommended: false },
          ],
        },
      },
    };
  }

  test('selecting Bi-monthly rewrites the recurring lawn line to 6 visits + that price', () => {
    const freq = lawnFrequenciesFromResultStats({ results: estDataWithRecurringLawn().result.results })
      .find((f) => f.key === 'standard');
    const out = applySelectedLawnTierToEstimateData(estDataWithRecurringLawn(), freq);
    const svc = out.result.recurring.services[0];
    expect(svc.visitsPerYear).toBe(6);
    expect(svc.monthly).toBe(55.5);
    expect(svc.annual).toBe(666);
    expect(svc.cadence).toBe('bi_monthly');
    expect(out.result.recurring.monthlyTotal).toBe(55.5);
    // results.lawn marks standard as the selected row
    expect(out.result.results.lawn.filter((r) => r.selected).map((r) => r.name)).toEqual(['Standard']);
  });

  test('is a no-op for a non-lawn (e.g. pest) selection', () => {
    const pestFreq = { key: 'monthly', serviceCategory: 'pest_control', monthly: 99 };
    const input = estDataWithRecurringLawn();
    expect(applySelectedLawnTierToEstimateData(input, pestFreq)).toBe(input);
  });

  test('selecting Monthly schedules 12 visits', () => {
    const freq = lawnFrequenciesFromResultStats({ results: estDataWithRecurringLawn().result.results })
      .find((f) => f.key === 'premium');
    const out = applySelectedLawnTierToEstimateData(estDataWithRecurringLawn(), freq);
    expect(out.result.recurring.services[0].visitsPerYear).toBe(12);
    expect(out.result.recurring.services[0].cadence).toBe('monthly');
  });
});

// Build a section the way buildServiceSection does: waveGuardTierEligible is the
// per-section flag derived from the section's member service keys.
const sectionWith = (key, memberKeys = [key]) => ({
  isRecurring: true,
  isPest: key === 'pest_control',
  key,
  setupFee: null,
  waveGuardTierEligible: sectionTierEligibleFromKeys(true, memberKeys),
});

describe('buildRenderFlags — estimate-wide tier UI gate (derived from per-section)', () => {
  test.each(['lawn_care', 'tree_shrub', 'termite_bait', 'mosquito'])(
    'recurring %s turns the tier UI on',
    (key) => {
      expect(buildRenderFlags({}, [sectionWith(key)], { qualifyingCount: 1 }).showWaveGuardTierUi).toBe(true);
    },
  );

  test('the tier badge does NOT enable pest-only setup fee / perks / add-ons', () => {
    const flags = buildRenderFlags({}, [sectionWith('lawn_care')], { qualifyingCount: 1 });
    expect(flags.showWaveGuardSetupFee).toBe(false);
    expect(flags.showWaveGuardPerks).toBe(false);
    expect(flags.showPestRecurringAddOns).toBe(false);
  });

  test('palm-only and rodent-only estimates keep the tier UI off', () => {
    expect(buildRenderFlags({}, [sectionWith('palm_injection')], { qualifyingCount: 1 }).showWaveGuardTierUi).toBe(false);
    expect(buildRenderFlags({}, [sectionWith('rodent_bait')], { qualifyingCount: 1 }).showWaveGuardTierUi).toBe(false);
  });

  test('a bundle with an eligible service turns the tier UI on; an excluded-only bundle does not', () => {
    expect(buildRenderFlags({}, [sectionWith('bundle', ['tree_shrub', 'palm_injection'])], { qualifyingCount: 1 }).showWaveGuardTierUi).toBe(true);
    expect(buildRenderFlags({}, [sectionWith('bundle', ['palm_injection', 'rodent_bait'])], { qualifyingCount: 1 }).showWaveGuardTierUi).toBe(false);
  });
});

describe('sectionTierEligibleFromKeys — per-section badge (single source of truth)', () => {
  test.each(['pest_control', 'lawn_care', 'tree_shrub', 'termite_bait', 'mosquito'])(
    'a single %s section is badge-eligible',
    (key) => {
      expect(sectionTierEligibleFromKeys(true, [key])).toBe(true);
    },
  );

  test('palm / rodent single sections are NOT eligible (key not in allow-list)', () => {
    expect(sectionTierEligibleFromKeys(true, ['palm_injection'])).toBe(false);
    expect(sectionTierEligibleFromKeys(true, ['rodent_bait'])).toBe(false);
  });

  test('a bundle keeps the badge iff it contains an eligible service', () => {
    expect(sectionTierEligibleFromKeys(true, ['tree_shrub', 'palm_injection'])).toBe(true);   // T&S + Palm → badge (P2a/P2b)
    expect(sectionTierEligibleFromKeys(true, ['palm_injection', 'rodent_bait'])).toBe(false);  // excluded-only bundle → no badge (Codex round-5)
  });

  test('one-time (non-recurring) sections never badge', () => {
    expect(sectionTierEligibleFromKeys(false, ['lawn_care'])).toBe(false);
  });
});

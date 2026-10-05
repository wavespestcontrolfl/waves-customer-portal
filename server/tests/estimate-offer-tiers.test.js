/**
 * Good / Better / Best offer tiers (GATE_ESTIMATE_OFFER_TIERS, owner
 * 2026-10-05). Two halves:
 *   1. the pure module — eligibility, payload shape, accept-side resolution;
 *   2. the pricing bundle — an eligible one-time-toggle pest + lawn bundle
 *      carries a 'best' ladder priced with the companions kept, while the
 *      bundle's own ladder stays pest-only (today's behavior), and the gate
 *      off / an ineligible estimate serves a byte-identical bundle.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const OfferTiers = require('../services/estimate-offer-tiers');
const { buildPricingBundle } = require('../routes/estimate-public');
const estimateSlotAvailability = require('../services/estimate-slot-availability');

const GATE = 'GATE_ESTIMATE_OFFER_TIERS';

function pestLawnOneTimeToggleEstimate(overrides = {}) {
  return {
    id: `offer-tiers-${Math.random().toString(36).slice(2)}`,
    status: 'sent',
    category: 'RESIDENTIAL',
    show_one_time_option: true,
    monthly_total: 84.08,
    annual_total: 1008.9,
    onetime_total: 99,
    waveguard_tier: 'Silver',
    estimate_data: {
      inputs: {
        svcPest: true, svcLawn: true, svcOnetimePest: true, pestFreq: '4', lawnFreq: '9',
        grassType: 'st_augustine', homeSqFt: '2309', lotSqFt: '9423', stories: '1', isCommercial: 'NO',
      },
      result: {
        hasRecurring: true,
        hasOneTime: true,
        manualDiscount: null,
        oneTime: {
          total: 363,
          membershipFee: 99,
          items: [{ service: 'one_time_pest', name: 'One-Time Pest Control', price: 264 }],
        },
        recurring: {
          tier: 'Silver',
          waveGuardTier: 'Silver',
          discount: 0.1,
          serviceCount: 2,
          monthlyTotal: 84.08,
          annualBeforeDiscount: 1121,
          annualAfterDiscount: 1008.9,
          services: [
            {
              name: 'Pest Control', service: 'pest_control', mo: 35.67, monthly: 35.67,
              basePrice: 107, perTreatment: 107, visitsPerYear: 4,
            },
            {
              name: 'Lawn Care', service: 'lawn_care', mo: 57.75, monthly: 57.75,
              perTreatment: 77, visitsPerYear: 9, grassType: 'St. Augustine',
              discountable: true, discountEligible: true,
              waveGuardDiscountEligible: true, countsTowardWaveGuardTier: true,
            },
          ],
        },
        results: {
          pestTiers: [
            { label: 'Quarterly', mo: 35.67, pa: 107, ann: 428, apps: 4, init: 99, recommended: true, ot: 264 },
            { label: 'Bi-Monthly', mo: 45.48, pa: 90.95, ann: 545.7, apps: 6, init: 99 },
            { label: 'Monthly', mo: 74.9, pa: 74.9, ann: 898.8, apps: 12, init: 99 },
          ],
          lawn: [
            { name: '9x applications/yr', v: 9, mo: 57.75, pa: 77, ann: 693, recommended: true },
            { name: '12x applications/yr', v: 12, mo: 79, pa: 79, ann: 948 },
          ],
        },
      },
    },
    ...overrides,
  };
}

describe('estimate-offer-tiers module', () => {
  const eligible = {
    gateOn: true,
    estimate: { show_one_time_option: true, category: 'RESIDENTIAL' },
    recurringKeys: ['pest_control', 'lawn_care'],
    optedOutKeys: [],
    memberEvidence: false,
    oneTimeChoicePrice: 264,
    hasPestLadder: true,
  };

  test('eligibility names every refusal, and passes only the pest + companion one-time-toggle shape', () => {
    expect(OfferTiers.offerTierEligibility(eligible)).toEqual({ eligible: true, reason: null });
    expect(OfferTiers.offerTierEligibility({ ...eligible, gateOn: false }).reason).toBe('gate_off');
    expect(OfferTiers.offerTierEligibility({ ...eligible, estimate: { show_one_time_option: false } }).reason).toBe('no_one_time_option');
    expect(OfferTiers.offerTierEligibility({ ...eligible, estimate: { ...eligible.estimate, category: 'COMMERCIAL' } }).reason).toBe('not_residential');
    expect(OfferTiers.offerTierEligibility({ ...eligible, estimate: { ...eligible.estimate, source: 'plan_restart' } }).reason).toBe('plan_restart');
    expect(OfferTiers.offerTierEligibility({ ...eligible, hasPestLadder: false }).reason).toBe('no_pest_ladder');
    expect(OfferTiers.offerTierEligibility({ ...eligible, recurringKeys: ['lawn_care'] }).reason).toBe('no_recurring_pest');
    expect(OfferTiers.offerTierEligibility({ ...eligible, recurringKeys: ['pest_control', 'commercial_lawn'] }).reason).toBe('commercial_line');
    // Mosquito alone is not a companion for this ladder (owner: lawn first, tree & shrub second).
    expect(OfferTiers.offerTierEligibility({ ...eligible, recurringKeys: ['pest_control', 'mosquito'] }).reason).toBe('no_companion');
    expect(OfferTiers.offerTierEligibility({ ...eligible, recurringKeys: ['pest_control', 'tree_shrub'] }).eligible).toBe(true);
    expect(OfferTiers.offerTierEligibility({ ...eligible, optedOutKeys: ['lawn_care'] }).reason).toBe('opted_out_line');
    expect(OfferTiers.offerTierEligibility({ ...eligible, memberEvidence: true }).reason).toBe('member');
    expect(OfferTiers.offerTierEligibility({ ...eligible, oneTimeChoicePrice: 0 }).reason).toBe('no_one_time_price');
  });

  test('payload: good carries the one-time total, better references the bundle ladder, best carries its own', () => {
    const bestFrequencies = [{ key: 'quarterly', monthly: 84.08 }];
    const combos = [{ key: 'lawn_care:enhanced|pest_control:quarterly', selection: { pest_control: 'quarterly', lawn_care: 'enhanced' } }];
    const out = OfferTiers.buildOfferTiers({
      oneTimeChoicePrice: 264.004,
      recurringKeys: ['pest_control', 'lawn_care', 'tree_shrub'],
      bestFrequencies,
      bestServiceCadenceCombos: combos,
    });
    expect(out.offerTierDefaultKey).toBe('better');
    expect(out.offerTiers.map((t) => t.key)).toEqual(['good', 'better', 'best']);
    expect(out.offerTiers[0]).toEqual(expect.objectContaining({ serviceMode: 'one_time', services: ['one_time_pest'], oneTimeTotal: 264 }));
    expect(out.offerTiers[1]).toEqual(expect.objectContaining({ serviceMode: 'recurring', services: ['pest_control'], usesBundleFrequencies: true }));
    expect(out.offerTiers[1].frequencies).toBeUndefined();
    expect(out.offerTiers[2]).toEqual(expect.objectContaining({
      serviceMode: 'recurring',
      services: ['pest_control', 'lawn_care', 'tree_shrub'],
      frequencies: bestFrequencies,
      serviceCadenceCombos: combos,
    }));
    // No combos → the key is absent, never an empty array.
    expect(OfferTiers.buildOfferTiers({ oneTimeChoicePrice: 1, recurringKeys: ['pest_control', 'lawn_care'], bestFrequencies, bestServiceCadenceCombos: null })
      .offerTiers[2].serviceCadenceCombos).toBeUndefined();
  });

  test('accept resolution: absent = today, unknown or off-gate or missing tier = 400 text, mode must agree', () => {
    const bundle = OfferTiers.buildOfferTiers({ oneTimeChoicePrice: 264, recurringKeys: ['pest_control', 'lawn_care'], bestFrequencies: [{ key: 'quarterly' }] });
    expect(OfferTiers.resolveSelectedOfferTier(bundle, undefined, { gateOn: true })).toEqual({ tier: null, error: null });
    expect(OfferTiers.resolveSelectedOfferTier(bundle, '', { gateOn: true })).toEqual({ tier: null, error: null });
    expect(OfferTiers.resolveSelectedOfferTier(bundle, 'platinum', { gateOn: true }).error).toMatch(/good, better, best/);
    expect(OfferTiers.resolveSelectedOfferTier(bundle, 'best', { gateOn: false }).error).toMatch(/not available/);
    expect(OfferTiers.resolveSelectedOfferTier({}, 'best', { gateOn: true }).error).toMatch(/not available/);
    // Mode mismatch both ways.
    expect(OfferTiers.resolveSelectedOfferTier(bundle, 'good', { gateOn: true, serviceMode: 'recurring' }).error).toMatch(/service mode/);
    expect(OfferTiers.resolveSelectedOfferTier(bundle, 'best', { gateOn: true, serviceMode: 'one_time' }).error).toMatch(/service mode/);
    expect(OfferTiers.resolveSelectedOfferTier(bundle, ' BEST ', { gateOn: true, serviceMode: 'recurring' }).tier.key).toBe('best');
    expect(OfferTiers.resolveSelectedOfferTier(bundle, 'good', { gateOn: true, serviceMode: 'one_time' }).tier.key).toBe('good');
  });

  test('bundle view: only best swaps the ladder and combos in; good and better leave the bundle untouched', () => {
    const base = { frequencies: [{ key: 'quarterly', monthly: 35.67 }], serviceCadenceCombos: [{ key: 'pest-only' }], anchorOneTimePrice: 264 };
    const best = { key: 'best', frequencies: [{ key: 'quarterly', monthly: 84.08 }], serviceCadenceCombos: [{ key: 'full' }] };
    const swapped = OfferTiers.pricingBundleForOfferTier(base, best);
    expect(swapped.frequencies[0].monthly).toBe(84.08);
    expect(swapped.serviceCadenceCombos).toEqual([{ key: 'full' }]);
    expect(swapped.anchorOneTimePrice).toBe(264);
    expect(swapped.offerTierApplied).toBe('best');
    // A best tier with no combos drops the pest-only combos rather than keeping a wrong set.
    expect(OfferTiers.pricingBundleForOfferTier(base, { key: 'best', frequencies: [] }).serviceCadenceCombos).toBeUndefined();
    expect(OfferTiers.pricingBundleForOfferTier(base, { key: 'better' })).toBe(base);
    expect(OfferTiers.pricingBundleForOfferTier(base, null)).toBe(base);
    expect(OfferTiers.offerTierKeepsCompanions({ key: 'best' })).toBe(true);
    expect(OfferTiers.offerTierKeepsCompanions({ key: 'better' })).toBe(false);
    expect(OfferTiers.offerTierKeepsCompanions(null)).toBe(false);
  });
});

describe('pricing bundle offer tiers', () => {
  const originalGate = process.env[GATE];
  afterEach(() => {
    if (originalGate === undefined) delete process.env[GATE];
    else process.env[GATE] = originalGate;
  });

  test('gate on: the bundle ladder stays pest-only and best carries the full pest + lawn ladder', async () => {
    process.env[GATE] = 'true';
    const bundle = await buildPricingBundle(pestLawnOneTimeToggleEstimate(), { monthlyBilled: false });
    expect(bundle.source).toBe('v1_engine_shape');
    // Today's one-time-toggle behavior is untouched: the served ladder is
    // pest-only (pest 35.67 at the stored Silver 10% = 32.10, as before).
    const quarterly = bundle.frequencies.find((f) => f.key === 'quarterly');
    expect(quarterly.monthly).toBeCloseTo(32.10, 2);
    expect(quarterly.perServiceTreatments.map((r) => r.service)).toEqual(['pest_control']);
    expect(bundle.offerTierDefaultKey).toBe('better');
    const [good, better, best] = bundle.offerTiers;
    expect(good).toEqual(expect.objectContaining({ key: 'good', serviceMode: 'one_time', oneTimeTotal: 264 }));
    expect(better).toEqual(expect.objectContaining({ key: 'better', services: ['pest_control'], usesBundleFrequencies: true }));
    expect(best.services).toEqual(['pest_control', 'lawn_care']);
    expect(best.frequencies.map((f) => f.key)).toEqual(['quarterly', 'bi_monthly', 'monthly']);
    const bestQuarterly = best.frequencies.find((f) => f.key === 'quarterly');
    // Pest 35.67 + lawn 57.75, both at the Silver 10% the stored bundle carries.
    expect(bestQuarterly.monthly).toBeGreaterThan(quarterly.monthly);
    expect(bestQuarterly.monthly).toBeCloseTo(84.08, 2);
    expect(bestQuarterly.perServiceTreatments.map((r) => r.service).sort()).toEqual(['lawn_care', 'pest_control']);
    // Combos: the pest-only bundle's combos price pest alone (today's
    // shape); best's combos carry the lawn treatment on every entry.
    const pestOnlyCombo = bundle.serviceCadenceCombos.find((c) => c.key === 'lawn_care:enhanced|pest_control:quarterly');
    expect(pestOnlyCombo.perServiceTreatments.map((r) => r.service)).toEqual(['pest_control']);
    expect(pestOnlyCombo.monthly).toBeCloseTo(32.10, 2);
    const bestCombo = best.serviceCadenceCombos.find((c) => c.key === 'lawn_care:enhanced|pest_control:quarterly');
    expect(bestCombo.perServiceTreatments.map((r) => r.service).sort()).toEqual(['lawn_care', 'pest_control']);
    expect(bestCombo.monthly).toBeCloseTo(84.08, 2);
    expect(best.serviceCadenceCombos.every((c) => c.perServiceTreatments.some((r) => r.service === 'lawn_care'))).toBe(true);
    // The page renders Best's section cards and summary from the tier itself
    // (`sections`, beside the `services` key list); the bundle's own sections
    // stay the pest-only view.
    expect(best.services).toEqual(['pest_control', 'lawn_care']);
    expect(best.sections.map((s) => s.key)).toEqual(['pest_control', 'lawn_care']);
    expect(best.combinedRecurring).toBeTruthy();
    expect(best.waveGuardTier).toBe('Silver');
    expect(bundle.services.some((s) => s.key === 'lawn_care')).toBe(false);
  });

  test('gate off: byte-identical bundle, no tier fields', async () => {
    delete process.env[GATE];
    const bundle = await buildPricingBundle(pestLawnOneTimeToggleEstimate(), { monthlyBilled: false });
    expect(bundle.offerTiers).toBeUndefined();
    expect(bundle.offerTierDefaultKey).toBeUndefined();
  });

  test('gate off: a row already accepted on best still builds its tier view, so the accepted recap keeps what was booked', async () => {
    delete process.env[GATE];
    const accepted = pestLawnOneTimeToggleEstimate({ status: 'accepted' });
    accepted.estimate_data.customerSelection = { offerTier: 'best', frequencyKey: 'quarterly' };
    const bundle = await buildPricingBundle(accepted, { monthlyBilled: false });
    const best = (bundle.offerTiers || []).find((t) => t.key === 'best');
    expect(best).toBeTruthy();
    const view = OfferTiers.acceptedBestPricingView(bundle, accepted.estimate_data);
    expect(view.frequencies.find((f) => f.key === 'quarterly').monthly).toBeCloseTo(84.08, 2);
    expect(view.services.map((s) => s.key)).toEqual(['pest_control', 'lawn_care']);
    expect(view.combinedRecurring).toBeTruthy();
    expect(view.acceptedOfferTier).toBe('best');
    expect(view.offerTiers).toBeUndefined();
  });

  test('ineligible shapes carry no tiers: no one-time toggle, pest-only, member snapshot, manual discount', async () => {
    process.env[GATE] = 'true';
    const noToggle = await buildPricingBundle(pestLawnOneTimeToggleEstimate({ show_one_time_option: false }), { monthlyBilled: false });
    expect(noToggle.offerTiers).toBeUndefined();

    const pestOnly = pestLawnOneTimeToggleEstimate();
    pestOnly.estimate_data.result.recurring.services = pestOnly.estimate_data.result.recurring.services.filter((s) => s.service === 'pest_control');
    delete pestOnly.estimate_data.result.results.lawn;
    expect((await buildPricingBundle(pestOnly, { monthlyBilled: false })).offerTiers).toBeUndefined();

    const member = pestLawnOneTimeToggleEstimate();
    member.estimate_data.membershipSnapshot = { isExistingCustomer: true };
    expect((await buildPricingBundle(member, { monthlyBilled: false })).offerTiers).toBeUndefined();

    const discounted = pestLawnOneTimeToggleEstimate();
    discounted.estimate_data.result.manualDiscount = { type: 'PERCENT', value: 10, amount: 100.89, label: 'Neighbor' };
    expect((await buildPricingBundle(discounted, { monthlyBilled: false })).offerTiers).toBeUndefined();
  });
});

describe('slot profile for the best tier', () => {
  test("offerTier 'best' sizes the visit from every quoted program; anything else keeps the pest-only sizing", () => {
    const estimate = pestLawnOneTimeToggleEstimate();
    const pestOnly = estimateSlotAvailability.resolveEstimateSlotProfile(estimate, { serviceMode: 'recurring' });
    expect(pestOnly.services.map((s) => s.service)).toEqual(['pest_control']);
    expect(pestOnly.offerTier).toBeNull();

    const best = estimateSlotAvailability.resolveEstimateSlotProfile(estimate, { serviceMode: 'recurring', offerTier: 'best' });
    expect(best.services.map((s) => s.service).sort()).toEqual(['lawn_care', 'pest_control']);
    expect(best.offerTier).toBe('best');
    expect(best.durationMinutes).toBeGreaterThanOrEqual(pestOnly.durationMinutes);

    const better = estimateSlotAvailability.resolveEstimateSlotProfile(estimate, { serviceMode: 'recurring', offerTier: 'better' });
    expect(better.services.map((s) => s.service)).toEqual(['pest_control']);
    expect(better.offerTier).toBeNull();
  });
});

describe('resolveBestOfferTierForSlots (slot routes)', () => {
  const row = { id: 'est-1', customer_id: null };
  const dbFor = (found) => () => ({ where: () => ({ first: async () => (found ? row : null) }) });
  const bundleWithBest = async () => ({ offerTiers: [{ key: 'good' }, { key: 'better' }, { key: 'best', frequencies: [] }] });

  test("returns 'best' only with the gate on, a stored best tier and no live member; fails closed otherwise", async () => {
    const base = { db: dbFor(true), estimateId: 'est-1', raw: 'best', gateOn: true, buildPricingBundle: bundleWithBest, isActiveMember: async () => false };
    await expect(OfferTiers.resolveBestOfferTierForSlots(base)).resolves.toBe('best');
    await expect(OfferTiers.resolveBestOfferTierForSlots({ ...base, raw: 'better' })).resolves.toBeNull();
    await expect(OfferTiers.resolveBestOfferTierForSlots({ ...base, gateOn: false })).resolves.toBeNull();
    await expect(OfferTiers.resolveBestOfferTierForSlots({ ...base, buildPricingBundle: async () => ({ frequencies: [] }) })).resolves.toBeNull();
    await expect(OfferTiers.resolveBestOfferTierForSlots({ ...base, db: dbFor(false) })).resolves.toBeNull();
    await expect(OfferTiers.resolveBestOfferTierForSlots({ ...base, buildPricingBundle: async () => { throw new Error('boom'); } })).resolves.toBeNull();
    // A linked customer: a live member, or an unreadable membership, withholds the tier.
    const memberDb = () => ({ where: () => ({ first: async () => ({ ...row, customer_id: 'cust-1' }) }) });
    await expect(OfferTiers.resolveBestOfferTierForSlots({ ...base, db: memberDb, isActiveMember: async () => true })).resolves.toBeNull();
    await expect(OfferTiers.resolveBestOfferTierForSlots({ ...base, db: memberDb, isActiveMember: async () => { throw new Error('db'); } })).resolves.toBeNull();
    await expect(OfferTiers.resolveBestOfferTierForSlots({ ...base, db: memberDb, isActiveMember: async () => false })).resolves.toBe('best');
  });
});

describe('accepted Best view', () => {
  test('a row accepted on best serves the tier view with the picker fields dropped; anything else is untouched', () => {
    const best = { key: 'best', frequencies: [{ key: 'quarterly', monthly: 84.08 }], serviceCadenceCombos: [{ key: 'c' }], waveGuardTier: 'Silver' };
    const bundle = { frequencies: [{ key: 'quarterly', monthly: 32.1 }], waveGuardTier: 'Bronze', offerTiers: [{ key: 'good' }, { key: 'better' }, best], offerTierDefaultKey: 'better' };
    const view = OfferTiers.acceptedBestPricingView(bundle, { customerSelection: { offerTier: 'best' } });
    expect(view.frequencies[0].monthly).toBe(84.08);
    expect(view.waveGuardTier).toBe('Silver');
    expect(view.acceptedOfferTier).toBe('best');
    expect(view.offerTiers).toBeUndefined();
    expect(view.offerTierDefaultKey).toBeUndefined();
    expect(OfferTiers.acceptedBestPricingView(bundle, { customerSelection: { offerTier: 'better' } })).toBe(bundle);
    expect(OfferTiers.acceptedBestPricingView(bundle, {})).toBe(bundle);
    expect(OfferTiers.acceptedOfferTierKey({ customerSelection: { offerTier: ' BEST ' } })).toBe('best');
    expect(OfferTiers.acceptedOfferTierKey({ customerSelection: { offerTier: 'gold' } })).toBeNull();
  });
});

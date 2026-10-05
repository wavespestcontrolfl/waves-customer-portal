/**
 * Good / Better / Best on a pest + lawn estimate (GATE_ESTIMATE_OFFER_TIERS).
 * The picker is a view over the service opt-out rail, so these tests pin the
 * three small things that are new: who may be marked for tiers, what the
 * rail does with the one-time option, and what the tile block shows.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const OfferTiers = require('../services/estimate-offer-tiers');
const { recordServiceOptOutEvent } = require('../services/estimate-service-opt-out');
const { buildOfferTiersBlock } = require('../routes/estimate-public');

const GATE = 'GATE_ESTIMATE_OFFER_TIERS';
const OPT_OUT_GATE = 'GATE_ESTIMATE_SERVICE_OPT_OUT';

const pestLawnData = (overrides = {}) => ({
  offerTiersRequested: true,
  // A replayable input carrier: the rail only offers a removal it can replay.
  engineRequest: {
    profile: { homeSqFt: 2000, lotSqFt: 8000, lawnSqFt: 4000 },
    selectedServices: ['PEST', 'LAWN'],
    options: { pestFreq: 4 },
  },
  result: {
    recurring: {
      discount: 0.1,
      waveGuardTier: 'Silver',
      services: [
        { name: 'Pest Control', service: 'pest_control', mo: 35.67, perTreatment: 107, visitsPerYear: 4 },
        { name: 'Lawn Care', service: 'lawn_care', mo: 57.75, perTreatment: 77, visitsPerYear: 9 },
      ],
    },
    results: { pestTiers: [{ label: 'Quarterly', mo: 35.67, pa: 107, ann: 428, apps: 4 }] },
  },
  ...overrides,
});

describe('who may be marked for tiers', () => {
  test('residential pest + lawn, no member evidence, gate on — and every refusal is named', () => {
    const data = pestLawnData();
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: true, estData: data })).toEqual({ eligible: true, reason: null });
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: false, estData: data }).reason).toBe('gate_off');
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: true, estData: data, commercial: true }).reason).toBe('not_residential');
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: true, estData: data, memberEvidence: true }).reason).toBe('member');
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: true, estData: { ...data, membershipSnapshot: { isExistingCustomer: true } } }).reason).toBe('member');
    const rows = (services) => ({ ...data, result: { ...data.result, recurring: { ...data.result.recurring, services } } });
    const [pest, lawn] = data.result.recurring.services;
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: true, estData: rows([lawn]) }).reason).toBe('no_recurring_pest');
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: true, estData: rows([pest]) }).reason).toBe('no_lawn');
    // Tree & shrub cannot be removed through the rail, so it is not a tier companion.
    const ts = { name: 'Tree & Shrub', service: 'tree_shrub', mo: 40, perTreatment: 80, visitsPerYear: 6 };
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: true, estData: rows([pest, ts]) }).reason).toBe('no_lawn');
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: true, estData: rows([pest, lawn, ts]) }).reason).toBe('other_recurring_services');
  });
});

describe('the one-time option follows the lawn line on a marked row', () => {
  const next = { monthlyTotal: 35.67, annualTotal: 428, onetimeTotal: 99 };
  const base = { actor: 'customer', serviceKey: 'lawn_care', estData: pestLawnData(), next };
  const allow = () => null;
  const refuse = () => 'Offer one-time option is only supported for pest-only recurring estimates.';

  test('lawn removed: on, when the gate is on and the validator allows it on the repriced row', () => {
    expect(OfferTiers.oneTimeOptionUpdateForMixChange({ ...base, mode: 'remove', gateOn: true, validate: allow })).toEqual({ show_one_time_option: true });
    expect(OfferTiers.oneTimeOptionUpdateForMixChange({ ...base, mode: 'remove', gateOn: true, validate: refuse })).toEqual({});
    expect(OfferTiers.oneTimeOptionUpdateForMixChange({ ...base, mode: 'remove', gateOn: false, validate: allow })).toEqual({});
  });

  test('lawn added back: ALWAYS off, even with the gate off — the option never sits beside a companion program', () => {
    expect(OfferTiers.oneTimeOptionUpdateForMixChange({ ...base, mode: 'restore', gateOn: true })).toEqual({ show_one_time_option: false });
    expect(OfferTiers.oneTimeOptionUpdateForMixChange({ ...base, mode: 'restore', gateOn: false })).toEqual({ show_one_time_option: false });
  });

  test('untouched: an unmarked row, another service, a staff action, a priced add', () => {
    const unmarked = pestLawnData({ offerTiersRequested: undefined });
    expect(OfferTiers.oneTimeOptionUpdateForMixChange({ ...base, estData: unmarked, mode: 'remove', gateOn: true, validate: allow })).toEqual({});
    expect(OfferTiers.oneTimeOptionUpdateForMixChange({ ...base, estData: unmarked, mode: 'restore', gateOn: true })).toEqual({});
    expect(OfferTiers.oneTimeOptionUpdateForMixChange({ ...base, serviceKey: 'mosquito', mode: 'remove', gateOn: true, validate: allow })).toEqual({});
    expect(OfferTiers.oneTimeOptionUpdateForMixChange({ ...base, actor: 'staff', mode: 'remove', gateOn: true, validate: allow })).toEqual({});
    expect(OfferTiers.oneTimeOptionUpdateForMixChange({ ...base, mode: 'add', gateOn: true, validate: allow })).toEqual({});
  });

  test('the real validator allows the option on the repriced pest-only row and refuses it while lawn is still there', () => {
    const pestOnly = pestLawnData();
    pestOnly.result.recurring.services = pestOnly.result.recurring.services.filter((s) => s.service === 'pest_control');
    expect(OfferTiers.oneTimeOptionUpdateForMixChange({ ...base, estData: pestOnly, mode: 'remove', gateOn: true })).toEqual({ show_one_time_option: true });
    expect(OfferTiers.oneTimeOptionUpdateForMixChange({ ...base, mode: 'remove', gateOn: true })).toEqual({});
  });
});

describe('the tile block on /data', () => {
  const originalGate = process.env[GATE];
  const originalOptOut = process.env[OPT_OUT_GATE];
  afterEach(() => {
    for (const [name, value] of [[GATE, originalGate], [OPT_OUT_GATE, originalOptOut]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const future = new Date(Date.now() + 7 * 86400000).toISOString();
  const estimate = (overrides = {}) => ({
    id: 'tier-est', status: 'sent', category: 'RESIDENTIAL', expires_at: future,
    onetime_total: 0, waveguard_tier: 'Silver', show_one_time_option: false, ...overrides,
  });
  const bundle = {
    waveGuardTier: 'Silver',
    services: [
      { key: 'pest_control', isRecurring: true, frequencies: [{ key: 'quarterly' }] },
      { key: 'lawn_care', isRecurring: true, frequencies: [{ key: 'enhanced' }] },
    ],
    frequencies: [{
      key: 'quarterly',
      perServiceTreatments: [
        { service: 'pest_control', label: 'Pest Control (Quarterly)', perTreatment: 107, displayPrice: 96.3, visitsPerYear: 4 },
        { service: 'lawn_care', label: 'Lawn Care', perTreatment: 77, displayPrice: 69.3, visitsPerYear: 9 },
      ],
    }],
  };
  // The rail's dry run for "remove lawn": pest at Bronze, the $99 solo setup.
  const removeDryRun = async ({ body }) => ({ status: 200, body: {
    success: true, dryRun: true, serviceKey: body.serviceKey, included: body.included,
    next: { monthlyTotal: 35.67, annualTotal: 428, onetimeTotal: 99, waveGuardTier: 'Bronze' },
    perApplication: [{ s: 'pest_control', pa: 107 }],
    previewBasis: 'digest',
  } });

  test('as quoted: Best is the bundle on the page, Better is the rail\'s own dry run, Good is the one-time visit', async () => {
    process.env[GATE] = 'true'; process.env[OPT_OUT_GATE] = 'true';
    const calls = [];
    const block = await buildOfferTiersBlock({
      estimate: estimate(), estData: pestLawnData(), pricingBundle: bundle,
      mixChange: async (args) => { calls.push(args.body); return removeDryRun(args); },
    });
    expect(calls).toEqual([{ serviceKey: 'lawn_care', included: false, dryRun: true }]);
    expect(block.state).toBe('best');
    expect(block.best.rows.map((r) => [r.service, r.perApplication])).toEqual([['pest_control', 96.3], ['lawn_care', 69.3]]);
    expect(block.best.waveGuardTier).toBe('Silver');
    // Better is the TRUE one-service price: list pest, Bronze, the solo setup — never the bundle discount.
    expect(block.better.rows).toEqual([{ service: 'pest_control', perApplication: 107 }]);
    expect(block.better.oneTimeTotal).toBe(99);
    expect(block.better.waveGuardTier).toBe('Bronze');
    expect(block.good.oneTimeTotal).toBeGreaterThan(0);
  });

  test('lawn already removed: Better is the row on the page and Best is the rail\'s add-back dry run', async () => {
    process.env[GATE] = 'true'; process.env[OPT_OUT_GATE] = 'true';
    const removed = pestLawnData();
    removed.result.recurring.services = removed.result.recurring.services.filter((s) => s.service === 'pest_control');
    recordServiceOptOutEvent(removed, { serviceKey: 'lawn_care', included: false, mode: 'remove', actor: 'customer', at: 'now', removedInputs: {} }, {});
    // What the rail's commit stamps: the repriced row's own tier.
    removed.serviceOptOut.engineTier = 'Bronze';
    removed.result.recurring.waveGuardTier = 'Bronze';
    const pestBundle = {
      waveGuardTier: 'Bronze', anchorOneTimePrice: 235,
      services: [{ key: 'pest_control', isRecurring: true, frequencies: [{ key: 'quarterly' }] }],
      frequencies: [{ key: 'quarterly', perServiceTreatments: [{ service: 'pest_control', perTreatment: 107, displayPrice: 107, visitsPerYear: 4 }] }],
    };
    const calls = [];
    const block = await buildOfferTiersBlock({
      estimate: estimate({ show_one_time_option: true, onetime_total: 99, waveguard_tier: 'Bronze' }),
      estData: removed, pricingBundle: pestBundle,
      mixChange: async (args) => {
        calls.push(args.body);
        return { status: 200, body: { dryRun: true, next: { onetimeTotal: 0, waveGuardTier: 'Silver' },
          perApplication: [{ s: 'pest_control', pa: 96.3 }, { s: 'lawn_care', pa: 69.3 }] } };
      },
    });
    expect(calls).toEqual([{ serviceKey: 'lawn_care', included: true, dryRun: true }]);
    expect(block.state).toBe('pest_only');
    expect(block.better.rows.map((r) => r.perApplication)).toEqual([107]);
    expect(block.best.rows.map((r) => [r.service, r.perApplication])).toEqual([['pest_control', 96.3], ['lawn_care', 69.3]]);
    expect(block.best.waveGuardTier).toBe('Silver');
  });

  test('no picker when a gate is off, the row is unmarked, a draft preview, accepted, or the rail refuses', async () => {
    const args = () => ({ estimate: estimate(), estData: pestLawnData(), pricingBundle: bundle, mixChange: removeDryRun });
    delete process.env[GATE]; process.env[OPT_OUT_GATE] = 'true';
    await expect(buildOfferTiersBlock(args())).resolves.toBeNull();
    process.env[GATE] = 'true'; delete process.env[OPT_OUT_GATE];
    await expect(buildOfferTiersBlock(args())).resolves.toBeNull();
    process.env[OPT_OUT_GATE] = 'true';
    await expect(buildOfferTiersBlock({ ...args(), estData: pestLawnData({ offerTiersRequested: undefined }) })).resolves.toBeNull();
    await expect(buildOfferTiersBlock({ ...args(), adminDraftPreview: true })).resolves.toBeNull();
    await expect(buildOfferTiersBlock({ ...args(), estimate: estimate({ status: 'accepted' }) })).resolves.toBeNull();
    await expect(buildOfferTiersBlock({ ...args(), mixChange: async () => ({ status: 400, body: { error: 'service_not_removable' } }) })).resolves.toBeNull();
    await expect(buildOfferTiersBlock({ ...args(), mixChange: async () => { throw new Error('recompute down'); } })).resolves.toBeNull();
  });
});

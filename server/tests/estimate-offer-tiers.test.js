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
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: true, railGateOn: true, estData: data })).toEqual({ eligible: true, reason: null });
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: false, estData: data }).reason).toBe('gate_off');
    // The picker is a view over the opt-out rail: without that gate the office must not be told tiers are on offer.
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: true, railGateOn: false, estData: data }).reason).toBe('opt_out_gate_off');
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: true, railGateOn: true, estData: data, commercial: true }).reason).toBe('not_residential');
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: true, railGateOn: true, estData: data, memberEvidence: true }).reason).toBe('member');
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: true, railGateOn: true, estData: { ...data, membershipSnapshot: { isExistingCustomer: true } } }).reason).toBe('member');
    const rows = (services) => ({ ...data, result: { ...data.result, recurring: { ...data.result.recurring, services } } });
    const [pest, lawn] = data.result.recurring.services;
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: true, railGateOn: true, estData: rows([lawn]) }).reason).toBe('no_recurring_pest');
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: true, railGateOn: true, estData: rows([pest]) }).reason).toBe('no_lawn');
    // Tree & shrub cannot be removed through the rail, so it is not a tier companion.
    const ts = { name: 'Tree & Shrub', service: 'tree_shrub', mo: 40, perTreatment: 80, visitsPerYear: 6 };
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: true, railGateOn: true, estData: rows([pest, ts]) }).reason).toBe('no_lawn');
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: true, railGateOn: true, estData: rows([pest, lawn, ts]) }).reason).toBe('other_recurring_services');
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

  test('the staff send-time park ("lead with one service") gets the same treatment, and its failed-send restore turns the option off', () => {
    expect(OfferTiers.oneTimeOptionUpdateForMixChange({ ...base, actor: 'staff', mode: 'remove', gateOn: true, validate: allow })).toEqual({ show_one_time_option: true });
    expect(OfferTiers.oneTimeOptionUpdateForMixChange({ ...base, actor: 'staff', mode: 'restore', gateOn: false })).toEqual({ show_one_time_option: false });
    expect(OfferTiers.oneTimeOptionUpdateForMixChange({ ...base, actor: 'system', mode: 'remove', gateOn: true, validate: allow })).toEqual({});
  });

  test('untouched: an unmarked row, another service, a priced add', () => {
    const unmarked = pestLawnData({ offerTiersRequested: undefined });
    expect(OfferTiers.oneTimeOptionUpdateForMixChange({ ...base, estData: unmarked, mode: 'remove', gateOn: true, validate: allow })).toEqual({});
    expect(OfferTiers.oneTimeOptionUpdateForMixChange({ ...base, estData: unmarked, mode: 'restore', gateOn: true })).toEqual({});
    expect(OfferTiers.oneTimeOptionUpdateForMixChange({ ...base, serviceKey: 'mosquito', mode: 'remove', gateOn: true, validate: allow })).toEqual({});
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
  const notMember = async () => false;
  const removeDryRun = async ({ body }) => ({ status: 200, body: {
    success: true, dryRun: true, serviceKey: body.serviceKey, included: body.included,
    next: { monthlyTotal: 35.67, annualTotal: 428, onetimeTotal: 99, waveGuardTier: 'Bronze' },
    perApplication: [{ s: 'pest_control', pa: 107 }],
    oneTimeChoiceAmount: 235,
    previewBasis: 'digest',
  } });

  test('as quoted: Best is the bundle on the page, Better is the rail\'s own dry run, Good is the one-time visit', async () => {
    process.env[GATE] = 'true'; process.env[OPT_OUT_GATE] = 'true';
    const calls = [];
    const block = await buildOfferTiersBlock({
      estimate: estimate(), estData: pestLawnData(), pricingBundle: bundle, memberBlock: notMember,
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
      estData: removed, pricingBundle: pestBundle, memberBlock: notMember,
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
    const args = () => ({ estimate: estimate(), estData: pestLawnData(), pricingBundle: bundle, mixChange: removeDryRun, memberBlock: notMember });
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
    // A line added since the mark (the priced-add rail's mosquito): "Better" would no longer be the pest plan.
    const withMosquito = pestLawnData();
    withMosquito.result.recurring.services.push({ name: 'Mosquito Control', service: 'mosquito', mo: 79, perTreatment: 79, visitsPerYear: 12 });
    await expect(buildOfferTiersBlock({ ...args(), estData: withMosquito })).resolves.toBeNull();
    // A member — linked, OR an unlinked estimate whose phone matches one — gets no picker; an unreadable judgement fails closed.
    await expect(buildOfferTiersBlock({ ...args(), memberBlock: async () => true })).resolves.toBeNull();
    await expect(buildOfferTiersBlock({ ...args(), memberBlock: async () => { throw new Error('db'); } })).resolves.toBeNull();
    // The default judge with no database behind it fails closed too.
    await expect(buildOfferTiersBlock({ ...args(), memberBlock: undefined, estimate: estimate({ customer_id: '00000000-0000-0000-0000-000000000001' }) })).resolves.toBeNull();
  });
});

describe('send path: a marked estimate leads with pest', () => {
  test('the lead-service park keeps pest and parks lawn on a row marked for tiers, whatever the selection order', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-estimates.js'), 'utf8');
    expect(src).toMatch(/offerTiersRequested\(estData\)\s*\n\s*&& recurringKeys\.includes\('pest_control'\)\s*\n\s*\? 'pest_control'/);
  });
});

describe('Codex r2 on #5970', () => {
  test('the Good tile is priced by the acceptance breakdown: pest visit plus a preserved one-time add-on', async () => {
    process.env.GATE_ESTIMATE_OFFER_TIERS = 'true'; process.env.GATE_ESTIMATE_SERVICE_OPT_OUT = 'true';
    const future = new Date(Date.now() + 7 * 86400000).toISOString();
    const withRoach = pestLawnData();
    withRoach.result.oneTime = { total: 218, membershipFee: 99, items: [{ service: 'pest_initial_roach', name: 'Initial Roach Knockdown', price: 119 }] };
    const bundle = {
      waveGuardTier: 'Silver',
      services: [{ key: 'pest_control', isRecurring: true, frequencies: [{ key: 'quarterly' }] }, { key: 'lawn_care', isRecurring: true, frequencies: [{ key: 'enhanced' }] }],
      frequencies: [{ key: 'quarterly', perServiceTreatments: [
        { service: 'pest_control', perTreatment: 107, displayPrice: 96.3, visitsPerYear: 4 },
        { service: 'lawn_care', perTreatment: 77, displayPrice: 69.3, visitsPerYear: 9 },
      ] }],
      oneTimeBreakdown: { total: 218, items: [{ service: 'pest_initial_roach', label: 'Initial Roach Knockdown', amount: 119 }, { service: 'waveguard_setup', label: 'WaveGuard setup', amount: 99 }] },
    };
    const block = await buildOfferTiersBlock({
      estimate: { id: 'g', status: 'sent', category: 'RESIDENTIAL', expires_at: future, onetime_total: 218, waveguard_tier: 'Silver', show_one_time_option: false },
      estData: withRoach, pricingBundle: bundle, memberBlock: async () => false,
      // The dry run resolves the POST-removal one-time choice itself (pest 107 x 2.2 = 235 + the $119 roach row).
      mixChange: async () => ({ status: 200, body: { dryRun: true, next: { onetimeTotal: 218, waveGuardTier: 'Bronze' }, perApplication: [{ s: 'pest_control', pa: 107 }], oneTimeChoiceAmount: 354 } }),
    });
    expect(block.good.oneTimeTotal).toBe(354);
    // Whatever the served bundle says, Good in the as-quoted state is the dry run's post-change figure.
    const reallocated = await buildOfferTiersBlock({
      estimate: { id: 'g2', status: 'sent', category: 'RESIDENTIAL', expires_at: future, onetime_total: 218, waveGuardTier: 'Silver', show_one_time_option: false },
      estData: withRoach, pricingBundle: bundle, memberBlock: async () => false,
      mixChange: async () => ({ status: 200, body: { dryRun: true, next: { onetimeTotal: 199, waveGuardTier: 'Bronze' }, perApplication: [{ s: 'pest_control', pa: 107 }], oneTimeChoiceAmount: 335 } }),
    });
    expect(reallocated.good.oneTimeTotal).toBe(335);
    // The rail's own dry run computes that figure with acceptance's resolver on the post-change result.
    const { applyServiceMixChange } = require('../routes/estimate-public');
    expect(typeof applyServiceMixChange).toBe('function');
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/estimate-public.js'), 'utf8');
    // Gate on only, computed BEFORE the digest and bound into it (`g`), on the post-change result.
    expect(src).toMatch(/const offerTierChoice = require\('\.\.\/services\/estimate-offer-tiers'\)\.offerTiersGateLive\(\)\s*\n\s*\? \(oneTimeChoiceAmountForEstimate\(\s*\n\s*\{ \.\.\.estimate, show_one_time_option: true, onetime_total: next\.onetimeTotal \},\s*\n\s*\{ \.\.\.parsedData, result: afterResult \},/);
    expect(src).toMatch(/optOutPreviewDigest\(next, impact, offerTierChoice\)/);
    expect(src).toMatch(/\.\.\.\(oneTimeChoice != null \? \{ g: oneTimeChoice \} : \{\}\),/);
    expect(src).toMatch(/\.\.\.\(offerTierChoice != null \? \{ oneTimeChoiceAmount: offerTierChoice \} : \{\}\),/);
    delete process.env.GATE_ESTIMATE_OFFER_TIERS; delete process.env.GATE_ESTIMATE_SERVICE_OPT_OUT;
  });

  test('a marked row already on the pest plan keeps its mark and its office checkbox', () => {
    const parked = pestLawnData();
    parked.result.recurring.services = parked.result.recurring.services.filter((s) => s.service === 'pest_control');
    recordServiceOptOutEvent(parked, { serviceKey: 'lawn_care', included: false, mode: 'remove', actor: 'staff', at: 'now', removedInputs: {} }, {});
    const live = { gateOn: true, railGateOn: true };
    expect(OfferTiers.offerTiersMarkedPestOnlyState(parked, live)).toBe(true);
    expect(OfferTiers.offerTiersSaveEligibility({ gateOn: true, railGateOn: true, estData: parked }).reason).toBe('no_lawn');
    expect(OfferTiers.offerTiersMarkedPestOnlyState(pestLawnData(), live)).toBe(false);
    expect(OfferTiers.offerTiersMarkedPestOnlyState(pestLawnData({ offerTiersRequested: undefined }), live)).toBe(false);
    // Dark feature: either gate off and the parked state no longer resurfaces the mark.
    expect(OfferTiers.offerTiersMarkedPestOnlyState(parked, { gateOn: false, railGateOn: true })).toBe(false);
    expect(OfferTiers.offerTiersMarkedPestOnlyState(parked, { gateOn: true, railGateOn: false })).toBe(false);
  });

  test('the lead-service send overrides the lead only while the tier gate is live', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-estimates.js'), 'utf8');
    // Both gates: with the rail dark the picker and the add-back path are dark too, so the ordinary lead order stands.
    expect(src).toMatch(/OfferTiersForSend\.offerTiersGateLive\(\)\s*\n\s*&& OfferTiersForSend\.optOutRailGateLive\(\)\s*\n\s*&& OfferTiersForSend\.offerTiersRequested\(estData\)/);
  });
});

describe('member judgement order for an unlinked estimate', () => {
  test('a property-group sibling that already belongs to a member blocks the picker before any phone match', async () => {
    const { offerTierMemberBlock } = require('../routes/estimate-public');
    const member = { id: 'm1', active: true, waveguard_tier: 'Silver', monthly_rate: 80 };
    const database = (table) => ({
      where: () => ({
        whereNot: () => ({ whereNotNull: () => ({ orderBy: () => ({ first: async () => (table === 'estimates' ? { customer_id: 'm1' } : null) }) }) }),
        // The live-owner read (whereNull('deleted_at')) and the member read both land here.
        whereNull: () => ({ first: async () => (table === 'customers' ? { id: 'm1' } : null) }),
        first: async () => (table === 'customers' ? member : null),
      }),
    });
    await expect(offerTierMemberBlock({ id: 'e1', customer_id: null, estimate_group_id: 'g1', customer_phone: '9415550100' }, database)).resolves.toBe(true);
    const { resolveProspectiveOwnerId } = require('../routes/estimate-public');
    await expect(resolveProspectiveOwnerId({ id: 'e1', customer_id: null, estimate_group_id: 'g1' }, database)).resolves.toBe('m1');
    await expect(resolveProspectiveOwnerId({ id: 'e3', customer_id: 'linked' }, database)).resolves.toBe('linked');
    await expect(resolveProspectiveOwnerId({ id: 'e4', customer_id: null, estimate_group_id: 'g9' }, () => { throw new Error('db'); })).rejects.toThrow('prospective_owner_lookup_failed');
    // One resolver with the accept's policy readers.
    const src2 = require('fs').readFileSync(require('path').join(__dirname, '../routes/estimate-public.js'), 'utf8');
    expect(src2).toMatch(/resolveProspectiveAcceptCustomer\(estimate, database, \{ authoritative: true \}\)/);
    // The sibling owner counts only while its customer row is live; a soft-deleted owner falls through to the phone match (pinned).
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/estimate-public.js'), 'utf8');
    expect(src).toMatch(/resolveGroupedEstimateOwnerId\(estimate, database, \{ throwOnError: true \}\)/);
    // A read error anywhere fails closed.
    await expect(offerTierMemberBlock({ id: 'e2', customer_id: null, estimate_group_id: 'g1' }, () => { throw new Error('db'); })).resolves.toBe(true);
  });
});

describe('revising a parked row keeps its opt-out history', () => {
  test('the write payload carries the ROW\'s serviceOptOut into a pest-only revision and keeps the mark; a revision that puts lawn back does not', async () => {
    process.env.GATE_ESTIMATE_OFFER_TIERS = 'true'; process.env.GATE_ESTIMATE_SERVICE_OPT_OUT = 'true';
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/admin-estimate-persistence.js'), 'utf8');
    // History carried on the gate-free predicate; the mark on the gated one; a staff decline drops the mark.
    expect(src).toMatch(/const storedParkedHistory = OfferTiers\.lawnParkedPestOnly\(storedEstimateData\);/);
    expect(src).toMatch(/const markedPestOnly = parkedNow && storedHadMark/);
    expect(src).toMatch(/if \(storedParkedHistory && newResultPestOnly && !trustedEstimateData\.serviceOptOut && storedEstimateData\?\.serviceOptOut\) \{\s*\n\s*trustedEstimateData\.serviceOptOut = storedEstimateData\.serviceOptOut;/);
    expect(src).toMatch(/const tiersOk = markedPestOnly\s*\n\s*\? body\.offerTiersDeclined !== true/);
    // The predicates the write uses on the stored row.
    const parked = pestLawnData();
    parked.result.recurring.services = parked.result.recurring.services.filter((s) => s.service === 'pest_control');
    recordServiceOptOutEvent(parked, { serviceKey: 'lawn_care', included: false, mode: 'remove', actor: 'staff', at: 'now', removedInputs: {} }, {});
    expect(OfferTiers.offerTiersMarkedPestOnlyState(parked)).toBe(true);
    // The history is a fact about the row: read true with every gate off, and with the mark gone.
    expect(OfferTiers.offerTiersParkedHistory(parked)).toBe(true);
    expect(OfferTiers.lawnParkedPestOnly(parked)).toBe(true);
    expect(OfferTiers.lawnParkedPestOnly({ ...parked, offerTiersRequested: undefined })).toBe(true);
    expect(OfferTiers.offerTiersParkedHistory({ ...parked, offerTiersRequested: undefined })).toBe(false);
    expect(OfferTiers.lawnParkedPestOnly(pestLawnData())).toBe(false);
    delete process.env.GATE_ESTIMATE_OFFER_TIERS;
    expect(OfferTiers.offerTiersParkedHistory(parked)).toBe(true);
    expect(OfferTiers.offerTiersMarkedPestOnlyState(parked)).toBe(false);
    process.env.GATE_ESTIMATE_OFFER_TIERS = 'true';
    delete process.env.GATE_ESTIMATE_OFFER_TIERS; delete process.env.GATE_ESTIMATE_SERVICE_OPT_OUT;
  });
});

describe('the plain opt-out rail for an unlinked prospective member', () => {
  test('the write refuses before pricing and /data stamps no removable control', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/estimate-public.js'), 'utf8');
    expect(src).toMatch(/if \(!estimate\.customer_id && !\(actor === 'staff' && mode === 'restore'\)\) \{\s*\n\s*let prospectiveMember = true;/);
    expect(src).toMatch(/if \(unlinkedMemberHidesMixChange\) return \{\};/);
    // The add lane reads the same verdict; the write re-resolves and locks the prospective owner.
    expect(src).toMatch(/let addStampBlockedByMembership = unlinkedMemberHidesMixChange;/);
    // The grouped-owner re-resolution takes the accept path's group lock first, after the estimate lock and before the customer lock.
    const txStart = src.indexOf('let memberActivatedMidWrite = false;');
    const block = src.slice(txStart, txStart + 6000);
    const fence = block.indexOf('await lockCustomerComms(trx, expectedProspectiveOwnerId);');
    const estimateLock = block.indexOf('await lockEstimateOwnerForUpdate(trx, estimate)');
    const groupLock = block.indexOf("['estimate-group-accept', String(estimate.estimate_group_id)]");
    expect(fence).toBeGreaterThan(0);
    expect(estimateLock).toBeGreaterThan(fence);
    // Drift between the pre-read owner and the one under the lock aborts.
    expect(block).toMatch(/if \(String\(ownerIdToLock \|\| ''\) !== String\(expectedProspectiveOwnerId \|\| ''\)\) \{\s*\n\s*memberActivatedMidWrite = true;/);
    const resolve = block.indexOf('ownerIdToLock = await resolveProspectiveOwnerId(estimate, trx)');
    const customerLock = block.indexOf("trx('customers').where({ id: ownerIdToLock }).forUpdate().first()");
    expect(estimateLock).toBeGreaterThan(0);
    expect(groupLock).toBeGreaterThan(estimateLock);
    expect(resolve).toBeGreaterThan(groupLock);
    expect(customerLock).toBeGreaterThan(resolve);
    expect(block).toMatch(/\} catch \(_\) \{ memberActivatedMidWrite = true; return; \}/);
    expect(src).toMatch(/await trx\('customers'\)\.where\(\{ id: ownerIdToLock \}\)\.forUpdate\(\)\.first\(\)/);
  });
});

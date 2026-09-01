/**
 * Customer service opt-out — the blob half.
 *
 * The route owns the recompute and the guarded write; this pins the surgery:
 * which sections may be dropped, that the prune reaches EVERY replayable input
 * carrier, and that a restore puts back the customer's own quote-time
 * configuration rather than a defaulted guess.
 */
const {
  serviceOptOutRemovableKeys,
  serviceIsPresentInInputs,
  applyServiceOptOutToEstimateData,
  captureServiceOptOutProvenance,
  recordServiceOptOutEvent,
  currentlyOptedOutKeys,
  SERVICE_OPT_OUT_KEYS,
} = require('../services/estimate-service-opt-out');

// A pest + lawn estimate in all three carriers, plus a one-time lawn line that
// must survive a recurring-lawn removal.
const pestAndLawn = () => ({
  engineInputs: {
    services: { pest: { apps: 4, version: 'v1' }, lawn: { track: 'st_augustine', tier: 'enhanced' } },
  },
  inputs: {
    services: { pest: { apps: 4 }, lawn: { track: 'st_augustine', tier: 'enhanced' } },
  },
  engineRequest: {
    profile: { homeSqFt: 2000 },
    selectedServices: ['PEST', 'LAWN', 'OT_LAWN'],
    options: { useLawnCostFloor: true, grassType: 'st_augustine', commercialInteriorService: null },
  },
});

const sections = [
  { key: 'pest_control', isRecurring: true },
  { key: 'lawn_care', isRecurring: true },
];

describe('serviceOptOutRemovableKeys', () => {
  it('offers each mapped recurring section when more than one remains', () => {
    expect([...serviceOptOutRemovableKeys(pestAndLawn(), sections)].sort())
      .toEqual(['lawn_care', 'pest_control']);
  });

  it('offers nothing when only one recurring line remains — that is a decline', () => {
    expect(serviceOptOutRemovableKeys(pestAndLawn(), [{ key: 'pest_control', isRecurring: true }]).size).toBe(0);
  });

  it('refuses an ITEMIZED proposal even when proposal.enabled is false', () => {
    // normalizeProposal keys authority on itemization PRESENCE, not `enabled`,
    // so a scaffold with enabled:false and $0 program lines still overrides the
    // engine rows on every renderer and BILLS from them at mark-won. This is
    // deliberately stricter than PUT /:token/interior-service.
    for (const shape of [{ programs: [] }, { buildings: [{}] }, { correctiveWork: [{}] }]) {
      const data = { ...pestAndLawn(), proposal: { enabled: false, ...shape } };
      expect(serviceOptOutRemovableKeys(data, sections).size).toBe(0);
    }
  });

  it('never offers tree_shrub or a commercial line', () => {
    const data = pestAndLawn();
    data.engineInputs.services.treeShrub = { plants: 20 };
    const withTs = [...sections, { key: 'tree_shrub', isRecurring: true }, { key: 'commercial_pest', isRecurring: true }];
    const removable = serviceOptOutRemovableKeys(data, withTs);
    expect(removable.has('tree_shrub')).toBe(false);
    expect(removable.has('commercial_pest')).toBe(false);
    expect(SERVICE_OPT_OUT_KEYS.tree_shrub).toBeUndefined();
  });

  it('never offers a one-time section, a quote-required section, or a multi-service card', () => {
    const data = pestAndLawn();
    const mixed = [
      ...sections,
      { key: 'mosquito', isRecurring: false },
      { key: 'termite_bait', isRecurring: true, quoteRequired: true },
      { key: 'rodent_bait', isRecurring: true, memberKeys: ['rodent_bait', 'pest_control'] },
    ];
    const removable = serviceOptOutRemovableKeys(data, mixed);
    expect(removable.has('mosquito')).toBe(false);
    expect(removable.has('termite_bait')).toBe(false);
    expect(removable.has('rodent_bait')).toBe(false);
  });

  it('never offers a section the inputs do not actually carry — the prune would be a no-op', () => {
    const data = pestAndLawn();
    delete data.engineInputs.services.lawn;
    delete data.inputs.services.lawn;
    data.engineRequest.selectedServices = ['PEST', 'OT_LAWN'];
    expect(serviceOptOutRemovableKeys(data, sections).has('lawn_care')).toBe(false);
    expect(serviceIsPresentInInputs(data, 'lawn_care')).toBe(false);
  });
});

describe('applyServiceOptOutToEstimateData — the prune', () => {
  it('reaches EVERY replayable carrier in one call', () => {
    // Pruning one carrier only lets the next authoritative reprice — or accept —
    // resurrect the line, displaying the reduced price while billing the full one.
    // serverRecomputeFromEstimateData PREFERS engineRequest over engineInputs.
    const data = pestAndLawn();
    const out = applyServiceOptOutToEstimateData(data, { serviceKey: 'lawn_care', included: false });
    expect(out.ok).toBe(true);
    expect(Object.keys(data.engineInputs.services)).toEqual(['pest']);
    expect(Object.keys(data.inputs.services)).toEqual(['pest']);
    expect(data.engineRequest.selectedServices).not.toContain('LAWN');
  });

  it('leaves the ONE-TIME lawn token alone', () => {
    const data = pestAndLawn();
    applyServiceOptOutToEstimateData(data, { serviceKey: 'lawn_care', included: false });
    expect(data.engineRequest.selectedServices).toContain('OT_LAWN');
  });

  it('leaves the estimate-WIDE options intact', () => {
    // useLawnCostFloor and commercialInteriorService are estimate-wide, never
    // service-keyed — clearing either on a service removal would be actively wrong.
    const data = pestAndLawn();
    applyServiceOptOutToEstimateData(data, { serviceKey: 'lawn_care', included: false });
    expect(data.engineRequest.options.useLawnCostFloor).toBe(true);
    expect('commercialInteriorService' in data.engineRequest.options).toBe(true);
  });

  it('refuses an unmapped service key', () => {
    expect(applyServiceOptOutToEstimateData(pestAndLawn(), { serviceKey: 'tree_shrub', included: false }))
      .toEqual({ ok: false, reason: 'service_not_removable' });
  });

  it('refuses when the prune would touch nothing', () => {
    const empty = { engineInputs: { services: {} }, inputs: { services: {} }, engineRequest: { selectedServices: [] } };
    expect(applyServiceOptOutToEstimateData(empty, { serviceKey: 'lawn_care', included: false }).ok).toBe(false);
  });
});

describe('applyServiceOptOutToEstimateData — the restore', () => {
  it('round-trips the customer OWN configuration exactly', () => {
    const data = pestAndLawn();
    const before = JSON.parse(JSON.stringify(data));
    const out = applyServiceOptOutToEstimateData(data, { serviceKey: 'lawn_care', included: false });
    const back = applyServiceOptOutToEstimateData(data, {
      serviceKey: 'lawn_care', included: true, removedInputs: out.removedInputs,
    });
    expect(back.ok).toBe(true);
    expect(data.engineInputs.services.lawn).toEqual(before.engineInputs.services.lawn);
    expect(data.inputs.services.lawn).toEqual(before.inputs.services.lawn);
    expect(data.engineRequest.selectedServices.sort()).toEqual(before.engineRequest.selectedServices.sort());
  });

  it('re-plants the captured pest curve, which the stored result no longer carries', () => {
    // resolveStoredPestPricingVersion: "No stored pest line = pest was just
    // added: genuinely new, caller keeps the live default." Restoring an
    // unstamped pest input would therefore reprice on the LIVE v2 curve rather
    // than the v1 curve the customer was quoted.
    const { resolveStoredPestPricingVersion } = require('../services/estimate-pricing-bundle-utils');
    const data = {
      // Unstamped pest INPUT (no services.pest.version) with a priced stored
      // pest line — the shape that replays on the line's curve.
      engineInputs: { services: { pest: { apps: 4 }, lawn: { track: 'st_augustine' } } },
      result: { recurring: { services: [{ service: 'pest_control', mo: 62 }] } },
    };
    const provenance = captureServiceOptOutProvenance(data, 'pest_control');
    expect(provenance.pestPricingVersion).toBe('v1');

    const out = applyServiceOptOutToEstimateData(data, { serviceKey: 'pest_control', included: false });
    // The write-back replaces `result` WHOLESALE with the reduced engine
    // output, so the stored pest line — the only provenance evidence — is gone.
    data.result = { recurring: { services: [{ service: 'lawn_care', mo: 90 }] } };
    expect(resolveStoredPestPricingVersion(data)).toBeNull();

    applyServiceOptOutToEstimateData(data, {
      serviceKey: 'pest_control', included: true, removedInputs: out.removedInputs, provenance,
    });
    // An explicit stamp WINS in the recompute, which derives one only when the
    // input has none. Without the capture this input would be unstamped against
    // an evidence-less result and reprice on the live v2 default.
    expect(data.engineInputs.services.pest.version).toBe('v1');
  });

  it('refuses a restore with nothing captured', () => {
    expect(applyServiceOptOutToEstimateData(pestAndLawn(), { serviceKey: 'lawn_care', included: true }))
      .toEqual({ ok: false, reason: 'nothing_to_restore' });
  });
});

describe('the audit record', () => {
  const event = (serviceKey, included) => ({ serviceKey, included, at: '2026-08-31T12:00:00.000Z' });

  it('captures the baseline ONCE, serialized and with serviceOptOut stripped', () => {
    const data = pestAndLawn();
    const baselineSource = JSON.parse(JSON.stringify(data));
    recordServiceOptOutEvent(data, event('lawn_care', false), baselineSource);
    const firstBaseline = data.serviceOptOut.baseline;
    // A STRING, not an object: the baseline carries the complete pre-removal
    // rows/inputs, and recursive detectors that walk every object in
    // estimate_data (collectTermiteFacts) would read the removed service back
    // out of a traversable one (codex #3684 r3 P1).
    expect(typeof firstBaseline).toBe('string');
    expect(JSON.parse(firstBaseline).serviceOptOut).toBeUndefined();

    // A second change must not nest a blob inside a blob, or re-baseline onto
    // the already-reduced estimate.
    recordServiceOptOutEvent(data, event('mosquito', false), JSON.parse(JSON.stringify(data)));
    expect(data.serviceOptOut.baseline).toBe(firstBaseline);
    expect(data.serviceOptOut.events).toHaveLength(2);
  });

  it('serializes the event removedInputs, and readRemovedInputs round-trips them', () => {
    const { readRemovedInputs } = require('../services/estimate-service-opt-out');
    const data = pestAndLawn();
    const applied = applyServiceOptOutToEstimateData(data, { serviceKey: 'lawn_care', included: false });
    recordServiceOptOutEvent(data, { ...event('lawn_care', false), removedInputs: applied.removedInputs }, { ...data });
    const stored = data.serviceOptOut.events[0];
    // Opaque to recursive detectors, exactly like the baseline.
    expect(typeof stored.removedInputs).toBe('string');
    const roundTripped = readRemovedInputs(stored);
    expect(roundTripped.engineInputs.lawn).toEqual({ track: 'st_augustine', tier: 'enhanced' });
    // And a restore from the round-tripped shape is exact.
    const restored = applyServiceOptOutToEstimateData(data, {
      serviceKey: 'lawn_care', included: true, removedInputs: roundTripped,
    });
    expect(restored.ok).toBe(true);
    expect(data.engineInputs.services.lawn).toEqual({ track: 'st_augustine', tier: 'enhanced' });
  });

  it('readRemovedInputs tolerates legacy object-shaped events and garbage', () => {
    const { readRemovedInputs } = require('../services/estimate-service-opt-out');
    expect(readRemovedInputs({ removedInputs: { engineInputs: { lawn: {} } } }))
      .toEqual({ engineInputs: { lawn: {} } });
    expect(readRemovedInputs({ removedInputs: 'not json{' })).toBeNull();
    expect(readRemovedInputs(undefined)).toBeNull();
  });

  it('recognizes the snake_case termite_bait engine key (codex r3 P1)', () => {
    // estimate-add-service-request writes services.termite_bait and the engine
    // consumes that alias — presence detection and the prune must too. The
    // prune also cleans a mirrored `inputs` copy of the same alias.
    const data = {
      engineInputs: { services: { termite_bait: { stations: 12 } } },
      inputs: { services: { termite_bait: { stations: 12 } } },
    };
    expect(serviceIsPresentInInputs(data, 'termite_bait')).toBe(true);
    const applied = applyServiceOptOutToEstimateData(data, { serviceKey: 'termite_bait', included: false });
    expect(applied.ok).toBe(true);
    expect(data.engineInputs.services.termite_bait).toBeUndefined();
    expect(data.inputs.services.termite_bait).toBeUndefined();
    expect(applied.removedInputs.engineInputs.termite_bait).toEqual({ stations: 12 });
  });

  it('a profile-less engineRequest is NOT eligible — the recompute refuses that carrier (r4 P1)', () => {
    // serverRecomputeFromEstimateData translates engineRequest only when
    // req.profile exists; selectedServices alone would advertise a control
    // whose every dry-run 409s.
    const data = { engineRequest: { selectedServices: ['PEST'] } };
    expect(serviceIsPresentInInputs(data, 'pest_control')).toBe(false);
    const withProfile = { engineRequest: { profile: { homeSqFt: 2000 }, selectedServices: ['PEST'] } };
    expect(serviceIsPresentInInputs(withProfile, 'pest_control')).toBe(true);
  });

  it('an inputs-only estimate is NOT eligible — the canonical recompute cannot replay it', () => {
    // serverRecomputeFromEstimateData accepts only engineRequest/engineInputs;
    // advertising removability off `inputs` alone would 409 every preview
    // (pre-push codex P1 on 15ca6d3).
    const data = { inputs: { services: { pest: { apps: 4 } } } };
    expect(serviceIsPresentInInputs(data, 'pest_control')).toBe(false);
  });

  it('currentlyOptedOutKeys reflects the LATEST state per service', () => {
    const data = pestAndLawn();
    recordServiceOptOutEvent(data, event('lawn_care', false), { ...data });
    expect(currentlyOptedOutKeys(data)).toEqual(['lawn_care']);
    recordServiceOptOutEvent(data, event('lawn_care', true), { ...data });
    expect(currentlyOptedOutKeys(data)).toEqual([]);
    expect(currentlyOptedOutKeys({})).toEqual([]);
  });
});

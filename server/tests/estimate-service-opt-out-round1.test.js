/**
 * Codex #3684 r1 regressions — the opt-out guards on ENGINE-BACKED estimates.
 *
 * The recurring class in this round: estimates whose original pricing lives in
 * the raw carriers (engineResult / engineRequest) slipped past guards written
 * against the mapped `result`. Each test here fails on the pre-fix code.
 */
const { resolveOptOutBeforeResult, optOutImpact } = require('../routes/estimate-public');
const { resolveStoredPestPricingVersion } = require('../services/estimate-pricing-bundle-utils');

describe('resolveOptOutBeforeResult (r1 P1 — bundled-charge guard blind on engine-only estimates)', () => {
  const rawWithBundledWasp = () => ({
    lineItems: [
      {
        service: 'stinging_insect',
        name: 'Paper Wasp Removal',
        price: 0,
        includedOnProgram: true,
      },
    ],
  });

  it('returns the mapped result verbatim when one is stored', () => {
    const result = { recurring: { waveGuardTier: 'Gold' } };
    expect(resolveOptOutBeforeResult({ result, engineResult: rawWithBundledWasp() })).toBe(result);
  });

  it('maps a raw-only engineResult so the bundled-free row is visible to the guard', () => {
    const before = resolveOptOutBeforeResult({ engineResult: rawWithBundledWasp() });
    expect(before).toBeTruthy();
    const bundledRows = (before.specItems || []).filter((r) => r.onProg === true);
    expect(bundledRows.map((r) => r.service)).toContain('stinging_insect');
  });

  it('returns null when no carrier holds a before-state', () => {
    expect(resolveOptOutBeforeResult({})).toBeNull();
    expect(resolveOptOutBeforeResult({ engineResult: null })).toBeNull();
  });

  it('feeds the refusal: an engine-only before-state still trips bundled_item_would_be_charged', () => {
    const beforeResult = resolveOptOutBeforeResult({ engineResult: rawWithBundledWasp() });
    // After the removal the same job is a paid line — the exact move the owner
    // ruled must route to the office instead of self-serve.
    const afterResult = {
      specItems: [{ service: 'stinging_insect', name: 'Paper Wasp Removal', price: 249, onProg: false }],
    };
    const impact = optOutImpact({
      beforeResult, afterResult, beforeData: {}, afterData: {}, label: 'Pest Control',
    });
    expect(impact.wouldChargeBundled).toHaveLength(1);
    expect(impact.wouldChargeBundled[0].price).toBe(249);
  });
});

describe('resolveStoredPestPricingVersion opt-out fallback (r1 P1 — curve provenance on engineRequest restores)', () => {
  const removalEvent = (version) => ({
    serviceKey: 'pest_control',
    included: false,
    provenance: version ? { pestPricingVersion: version } : {},
  });

  it('still prefers the stored pest line when one exists', () => {
    const data = {
      result: { recurring: { services: [{ service: 'pest_control', pricingVersion: 'v2' }] } },
      serviceOptOut: { events: [removalEvent('v1')] },
    };
    expect(resolveStoredPestPricingVersion(data)).toBe('v2');
  });

  it('falls back to the latest removal event provenance when the stored line is gone', () => {
    // The opt-out deleted the stored rows; the removal event captured this
    // resolver's own answer while the evidence still existed. Without the
    // fallback an engineRequest-sourced restore reprices pest on the live
    // default curve.
    const data = { serviceOptOut: { events: [removalEvent('v1')] } };
    expect(resolveStoredPestPricingVersion(data)).toBe('v1');
  });

  it('the LATEST pest removal wins across a remove → restore → remove history', () => {
    const data = {
      serviceOptOut: {
        events: [
          removalEvent('v1'),
          { serviceKey: 'pest_control', included: true },
          removalEvent('v2'),
        ],
      },
    };
    expect(resolveStoredPestPricingVersion(data)).toBe('v2');
  });

  it('an event without a captured version keeps the live-default behaviour', () => {
    expect(resolveStoredPestPricingVersion({ serviceOptOut: { events: [removalEvent(null)] } })).toBeNull();
  });

  it('estimates with no opt-out history keep the live-default behaviour', () => {
    expect(resolveStoredPestPricingVersion({})).toBeNull();
    expect(resolveStoredPestPricingVersion({ serviceOptOut: {} })).toBeNull();
  });

  it('a removal of a DIFFERENT service never supplies pest provenance', () => {
    const data = {
      serviceOptOut: {
        events: [{ serviceKey: 'lawn_care', included: false, provenance: { pestPricingVersion: 'v1' } }],
      },
    };
    expect(resolveStoredPestPricingVersion(data)).toBeNull();
  });
});

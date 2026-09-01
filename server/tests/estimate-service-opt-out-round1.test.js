/**
 * Codex #3684 r1 regressions — the opt-out guards on ENGINE-BACKED estimates.
 *
 * The recurring class in this round: estimates whose original pricing lives in
 * the raw carriers (engineResult / engineRequest) slipped past guards written
 * against the mapped `result`. Each test here fails on the pre-fix code.
 */
const { resolveOptOutBeforeResult, optOutImpact, optOutResultHasPricingRows } = require('../routes/estimate-public');
const { resolveStoredPestPricingVersion } = require('../services/estimate-pricing-bundle-utils');
const { serviceOptOutBlockedByProposal } = require('../services/estimate-service-opt-out');

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

  it('returns a stored result with pricing rows verbatim', () => {
    const result = { recurring: { waveGuardTier: 'Gold', services: [{ service: 'pest_control' }] } };
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

describe('optOutImpact per-application disclosures (owner price-copy rule — no combined plan totals)', () => {
  const mk = (tier, pestPA) => ({
    recurring: {
      waveGuardTier: tier,
      services: [{ service: 'pest_control', name: 'Pest Control', perTreatment: pestPA }],
    },
  });

  it('discloses a kept line whose per-application price moved', () => {
    const impact = optOutImpact({
      beforeResult: mk('Gold', 103), afterResult: mk('Silver', 114),
      beforeData: {}, afterData: {}, label: 'Lawn Care',
    });
    const messages = impact.disclosures.map((d) => d.message);
    expect(messages).toContain('Pest Control changes from $103.00 to $114.00 per application.');
    expect(messages.some((m) => m.includes('/mo') || m.includes('/yr'))).toBe(false);
  });

  it('derives dollars from the effective post-discount amount, not the list perTreatment', () => {
    // Tier collapse changes the DISCOUNT, not the list price — perTreatment is
    // identical on both sides, and comparing it would report "no change" on
    // the very move being confirmed (pre-push codex P0 on 9389704).
    const withDiscount = (tier, annualAfterDiscount) => ({
      recurring: {
        waveGuardTier: tier,
        services: [{
          service: 'pest_control', name: 'Pest Control',
          perTreatment: 120, visitsPerYear: 4, annualAfterDiscount,
        }],
      },
    });
    const impact = optOutImpact({
      beforeResult: withDiscount('Gold', 412), afterResult: withDiscount('Silver', 456),
      beforeData: {}, afterData: {}, label: 'Lawn Care',
    });
    const pa = impact.disclosures.find((d) => d.code === 'recurring_per_application');
    expect(pa.message).toBe('Pest Control changes from $103.00 to $114.00 per application.');
  });

  it('prefers manualFinalAnnual — the operator-discounted FINAL amount — over annualAfterDiscount (r4 P1)', () => {
    // annualAfterDiscount is only post-WaveGuard; on an operator-discounted
    // quote the customer's real amount is manualFinalAnnual, and disclosing
    // the higher figure would overstate the confirmed dollars.
    const side = (manualFinalAnnual, annualAfterDiscount) => ({
      recurring: {
        services: [{
          service: 'lawn_care', name: 'Lawn Care',
          perTreatment: 120, visitsPerYear: 6, annualAfterDiscount, manualFinalAnnual,
        }],
      },
    });
    const impact = optOutImpact({
      beforeResult: side(600, 660), afterResult: side(636, 700),
      beforeData: {}, afterData: {}, label: 'Mosquito',
    });
    const pa = impact.disclosures.find((d) => d.code === 'recurring_per_application');
    expect(pa.message).toBe('Lawn Care changes from $100.00 to $106.00 per application.');
  });

  it('stays silent on a line whose per-application price did not move', () => {
    const impact = optOutImpact({
      beforeResult: mk('Gold', 103), afterResult: mk('Gold', 103),
      beforeData: {}, afterData: {}, label: 'Lawn Care',
    });
    expect(impact.disclosures.filter((d) => d.code === 'recurring_per_application')).toHaveLength(0);
  });

  it('restore mode flips the tier wording to "Adding … back"', () => {
    const impact = optOutImpact({
      beforeResult: mk('Silver', 114), afterResult: mk('Gold', 103),
      beforeData: {}, afterData: {}, label: 'Lawn Care', mode: 'restore',
    });
    const tier = impact.disclosures.find((d) => d.code === 'waveguard_tier_change');
    expect(tier.message).toMatch(/^Adding Lawn Care back moves your WaveGuard tier from Silver to Gold/);
  });

  it('pest per-application disclosures honor stored preference discounts (r3 P1)', () => {
    // Declined interior spray = $10/visit off pest. The persisted totals carry
    // that discount, so the disclosed pest dollars must too — quarterly pest
    // at $114 gross discloses at $104 on both sides, and here only the
    // tier-driven move remains visible net of the same pref discount.
    const side = (annualAfterDiscount) => ({
      recurring: {
        services: [{
          service: 'pest_control', name: 'Pest Control',
          perTreatment: 120, visitsPerYear: 4, annualAfterDiscount,
          mo: 60, pricingVersion: 'v1',
        }],
      },
    });
    const prefs = { interior_spray: false };
    const impact = optOutImpact({
      beforeResult: side(412), afterResult: side(456),
      beforeData: { preferences: prefs }, afterData: { preferences: prefs },
      label: 'Lawn Care',
    });
    const pa = impact.disclosures.find((d) => d.code === 'recurring_per_application');
    expect(pa.message).toMatch(/changes from \$9[0-9.]+ to \$10[0-9.]+ per application\./);
    // Net of the SAME pref discount on both sides: the spread stays $11.
    const [, from, to] = pa.message.match(/\$([0-9.]+) to \$([0-9.]+)/);
    expect(Number(to) - Number(from)).toBeCloseTo(11, 2);
    expect(Number(from)).toBeLessThan(103);
  });

  it('restore mode prices the restored line itself — the after-only row (r2 P1)', () => {
    const impact = optOutImpact({
      beforeResult: {
        recurring: { waveGuardTier: 'Silver', services: [{ service: 'pest_control', name: 'Pest Control', perTreatment: 114 }] },
      },
      afterResult: {
        recurring: {
          waveGuardTier: 'Gold',
          services: [
            { service: 'pest_control', name: 'Pest Control', perTreatment: 114 },
            { service: 'lawn_care', name: 'Lawn Care', perTreatment: 120, visitsPerYear: 6, annualAfterDiscount: 636 },
          ],
        },
      },
      beforeData: {}, afterData: {}, label: 'Lawn Care', mode: 'restore',
    });
    const restored = impact.disclosures.find((d) => d.code === 'restored_per_application');
    expect(restored.message).toBe('Lawn Care comes back at $106.00 per application.');
  });

  it('remove mode never emits a restored-line disclosure', () => {
    const impact = optOutImpact({
      beforeResult: { recurring: { services: [] } },
      afterResult: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control', perTreatment: 114 }] } },
      beforeData: {}, afterData: {}, label: 'Lawn Care',
    });
    expect(impact.disclosures.filter((d) => d.code === 'restored_per_application')).toHaveLength(0);
  });

  it('restore mode discloses the setup fee going away', () => {
    const impact = optOutImpact({
      beforeResult: { ...mk('Silver', 114), oneTime: { membershipFee: 99 } },
      afterResult: { ...mk('Gold', 103), oneTime: { membershipFee: 0 } },
      beforeData: {}, afterData: {}, label: 'Lawn Care', mode: 'restore',
    });
    const fee = impact.disclosures.find((d) => d.code === 'membership_setup_fee');
    expect(fee.message).toBe('The $99.00 WaveGuard setup fee no longer applies.');
  });
});

describe('serviceOptOutTierSelectionActive (pre-push P0 — a hand-picked tier exits self-serve)', () => {
  const { serviceOptOutTierSelectionActive, serviceOptOutRemovableKeys } = require('../services/estimate-service-opt-out');
  const engineGold = { result: { recurring: { waveGuardTier: 'Gold' } } };

  it('detects a row tier differing from the stored result engine tier', () => {
    expect(serviceOptOutTierSelectionActive(engineGold, 'Silver')).toBe(true);
    expect(serviceOptOutTierSelectionActive(engineGold, 'Gold')).toBe(false);
  });

  it('prefers the last opt-out commit stamp as the engine reference', () => {
    const data = { ...engineGold, serviceOptOut: { engineTier: 'Silver' } };
    // Customer dipped to Bronze via the clamped select-tier after an opt-out:
    // row Bronze vs stamped engine Silver = selection active.
    expect(serviceOptOutTierSelectionActive(data, 'Bronze')).toBe(true);
    expect(serviceOptOutTierSelectionActive(data, 'Silver')).toBe(false);
  });

  it('reads the raw engineResult tier when no mapped result exists (r2 P1)', () => {
    const engineOnly = { engineResult: { waveGuard: { tier: 'Gold' } } };
    expect(serviceOptOutTierSelectionActive(engineOnly, 'Silver')).toBe(true);
    expect(serviceOptOutTierSelectionActive(engineOnly, 'Gold')).toBe(false);
  });

  it('never blocks on unknown or missing tiers', () => {
    expect(serviceOptOutTierSelectionActive(engineGold, null)).toBe(false);
    expect(serviceOptOutTierSelectionActive(engineGold, 'Copper')).toBe(false);
    expect(serviceOptOutTierSelectionActive({}, 'Silver')).toBe(false);
  });

  it('empties the removable set, so /data never advertises what the write refuses', () => {
    const data = {
      ...engineGold,
      engineInputs: { services: { pest: { apps: 4 }, lawn: { track: 'st_augustine' } } },
    };
    const sections = [
      { key: 'pest_control', isRecurring: true },
      { key: 'lawn_care', isRecurring: true },
    ];
    expect(serviceOptOutRemovableKeys(data, sections, 'Gold').size).toBeGreaterThan(0);
    expect(serviceOptOutRemovableKeys(data, sections, 'Silver').size).toBe(0);
  });
});

describe('sparse before-state (pre-push P0 — empty result must not shadow engineResult)', () => {
  it('falls through an empty result scaffold to the mapped engineResult', () => {
    const before = resolveOptOutBeforeResult({
      result: {},
      engineResult: { lineItems: [{ service: 'stinging_insect', price: 0, includedOnProgram: true }] },
    });
    expect((before.specItems || []).some((r) => r.onProg === true)).toBe(true);
  });

  it('yields a rows-less before-state when neither carrier holds pricing rows — the route fails closed on removals', () => {
    // The route's removal guard is optOutResultHasPricingRows(beforeResult),
    // so what matters is that no path can dress up an empty scaffold as a
    // trustworthy before-state.
    expect(optOutResultHasPricingRows(resolveOptOutBeforeResult({ result: {} }))).toBe(false);
    expect(optOutResultHasPricingRows(resolveOptOutBeforeResult({}))).toBe(false);
    expect(optOutResultHasPricingRows(
      resolveOptOutBeforeResult({ result: {}, engineResult: { lineItems: [] } }),
    )).toBe(false);
  });
});

describe('serviceOptOutBlockedByProposal (pre-push P0 — restores must refuse itemized proposals)', () => {
  it('blocks on itemization presence, not proposal.enabled', () => {
    expect(serviceOptOutBlockedByProposal({ proposal: { enabled: false, programs: [{}] } })).toBe(true);
    expect(serviceOptOutBlockedByProposal({ proposal: { buildings: [{}] } })).toBe(true);
    expect(serviceOptOutBlockedByProposal({ proposal: { correctiveWork: [{}] } })).toBe(true);
  });

  it('does not block a scaffold with no itemization, or no proposal at all', () => {
    expect(serviceOptOutBlockedByProposal({ proposal: { enabled: true } })).toBe(false);
    expect(serviceOptOutBlockedByProposal({})).toBe(false);
    expect(serviceOptOutBlockedByProposal(null)).toBe(false);
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

describe('refuseFrozenRestartMutation (PR #3671 GH r21 P1 — restart quotes are frozen offers)', () => {
  const { refuseFrozenRestartMutation } = require('../routes/estimate-public');
  const resStub = () => {
    const r = { statusCode: null, body: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
  };

  it('409s a plan_restart row with the frozen code and reports handled', () => {
    const res = resStub();
    expect(refuseFrozenRestartMutation({ source: 'plan_restart' }, res)).toBe(true);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('restart_quote_frozen');
  });

  it('passes every other source through untouched (NULL included)', () => {
    const res = resStub();
    expect(refuseFrozenRestartMutation({ source: null }, res)).toBe(false);
    expect(refuseFrozenRestartMutation({ source: 'manual' }, res)).toBe(false);
    expect(refuseFrozenRestartMutation(undefined, res)).toBe(false);
    expect(res.statusCode).toBe(null);
  });

  it('is wired into every public reprice route (select-tier, bond, service-opt-out, preferences)', () => {
    // Source-level wiring assertion: the guard only protects routes that
    // actually call it, and a refactor that drops a call site must fail
    // loudly here rather than silently reopen public repricing.
    const src = require('fs').readFileSync(require.resolve('../routes/estimate-public'), 'utf8');
    const count = (src.match(/refuseFrozenRestartMutation\(estimate, res\)/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(4);
  });
});

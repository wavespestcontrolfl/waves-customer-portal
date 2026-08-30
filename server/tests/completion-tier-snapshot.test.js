/**
 * The ONE completion-time tier/callback snapshot builder both completion
 * paths (heavy /complete and pest-recap) share — codex #3617 r4 P1.
 */
const { completionTierSnapshotFields } = require('../services/completion-tier-snapshot');

const COLS = { service_tier: {}, service_tier_source: {}, is_callback: {} };

describe('completionTierSnapshotFields', () => {
  test('freezes tier + the CANONICAL label decision + callback identity', () => {
    // True label: auto source, no paid rate, label-only lane → frozen 'auto'.
    expect(completionTierSnapshotFields({
      serviceRecordCols: COLS, waveguardTier: 'Gold', waveguardTierSource: 'auto', monthlyRate: 0, billingMode: null, isCallback: true,
    })).toEqual({ service_tier: 'Gold', service_tier_source: 'auto', is_callback: true });
    // PAYING member whose raw source is still 'auto' is NOT a label
    // (isAutoDerivedTierLabelRow) — the freeze records a real membership,
    // never 'auto' (codex GH-r2 P2).
    expect(completionTierSnapshotFields({
      serviceRecordCols: COLS, waveguardTier: 'Gold', waveguardTierSource: 'auto', monthlyRate: 120, billingMode: null, isCallback: true,
    })).toEqual({ service_tier: 'Gold', service_tier_source: 'manual', is_callback: true });
  });

  test("pre-provenance member rows freeze 'manual'; no tier freezes NULL source", () => {
    expect(completionTierSnapshotFields({
      serviceRecordCols: COLS, waveguardTier: 'Silver', waveguardTierSource: null, isCallback: false,
    })).toEqual({ service_tier: 'Silver', service_tier_source: 'manual', is_callback: false });
    expect(completionTierSnapshotFields({
      serviceRecordCols: COLS, waveguardTier: null, waveguardTierSource: null, isCallback: false,
    })).toEqual({ service_tier: null, service_tier_source: null, is_callback: false });
  });

  test('column-guarded: pre-migration schemas keep the legacy shape; unknown callback stays unset', () => {
    expect(completionTierSnapshotFields({ serviceRecordCols: {}, waveguardTier: 'Gold', isCallback: true })).toEqual({});
    expect(completionTierSnapshotFields({ serviceRecordCols: COLS, waveguardTier: 'Gold', waveguardTierSource: 'manual', isCallback: null })).toEqual({ service_tier: 'Gold', service_tier_source: 'manual' });
  });
});

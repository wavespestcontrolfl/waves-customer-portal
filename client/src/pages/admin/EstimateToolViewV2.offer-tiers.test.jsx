// Good / Better / Best default in the estimate tool (owner 2026-10-05): a
// generated estimate the server marks offerTiersAvailable turns the carrier
// option on, the operator's manual off sticks, and losing eligibility clears
// an auto-set option without touching a manual or pest-only one.
import { describe, expect, it } from 'vitest';
import { nextFormForOfferTiers } from './EstimateToolViewV2';

describe('nextFormForOfferTiers', () => {
  const base = { svcPest: true, svcLawn: true, showOneTimeOption: false };

  it('turns the option on for a tier-eligible estimate and marks it auto-owned', () => {
    expect(nextFormForOfferTiers(base, { offerTiersAvailable: true }))
      .toEqual({ ...base, showOneTimeOption: true, _autoOneTimeOwned: true });
  });

  it('respects an operator who switched it off for this estimate', () => {
    const declined = { ...base, _offerTiersDeclined: true };
    expect(nextFormForOfferTiers(declined, { offerTiersAvailable: true })).toBe(declined);
  });

  it('clears an auto-set option when the regenerated estimate no longer qualifies', () => {
    const auto = { ...base, showOneTimeOption: true, _autoOneTimeOwned: true };
    expect(nextFormForOfferTiers(auto, { offerTiersAvailable: false }))
      .toEqual({ ...auto, showOneTimeOption: false, _autoOneTimeOwned: false });
  });

  it('leaves a manual option and the pest-only one-time bundle alone', () => {
    const manual = { ...base, showOneTimeOption: true, _autoOneTimeOwned: false };
    expect(nextFormForOfferTiers(manual, {})).toBe(manual);
    const pestOnlyBundle = { svcPest: true, svcOnetimePest: true, showOneTimeOption: true, _autoOneTimeOwned: true };
    expect(nextFormForOfferTiers(pestOnlyBundle, {})).toBe(pestOnlyBundle);
    const already = { ...base, showOneTimeOption: true };
    expect(nextFormForOfferTiers(already, { offerTiersAvailable: true })).toBe(already);
  });
});

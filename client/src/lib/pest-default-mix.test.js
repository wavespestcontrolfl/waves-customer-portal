import { describe, expect, it } from 'vitest';
import { PEST_DEFAULT_MIX, isPestDefaultMixVisit } from './pest-default-mix';

describe('isPestDefaultMixVisit: trap-only retainer plans (owner 2026-11-19)', () => {
  it.each([
    'Monthly Trap-Only Retainer Service',
    'Trap-Only Retainer Plus',
    'Trap-Only Retainer Standard',
  ])('"%s" gets no pest house mix', (serviceType) => {
    expect(isPestDefaultMixVisit({ serviceType })).toBe(false);
  });

  it.each([
    'Monthly Pest Control Service',
    'Quarterly Pest Control Service',
    'One-Time Pest Control Service',
    'Pest Control Re-Service',
  ])('"%s" still gets the pest house mix', (serviceType) => {
    expect(isPestDefaultMixVisit({ serviceType })).toBe(true);
  });

  it('the house mix: Taurus SC 1.6 (0.03% in a 4-gal tank, owner 2026-11-19), Crosscheck 2.5, surfactant 0.25', () => {
    expect(PEST_DEFAULT_MIX.map((entry) => entry.totalAmount)).toEqual([1.6, 2.5, 0.25]);
  });

  // Crosscheck Plus label (EPA 10404-120): at most 1 fl oz per 1,000 sq ft. The tank goes out at the Taurus label's volume,
  // 2 qt per 160 ft of a 2-ft band (owner 2026-11-25, protocols page D21).
  it('the Crosscheck in a 4-gal tank stays at or under 1 fl oz per 1,000 sq ft at the tank\'s spray volume', () => {
    const gallonsPer1000 = 0.5 / ((160 * 2) / 1000);
    const crosscheck = PEST_DEFAULT_MIX.find((entry) => entry.pattern.test('LESCO Crosscheck Plus')).totalAmount;
    expect(gallonsPer1000).toBeCloseTo(1.5625, 4);
    expect((crosscheck / 4) * gallonsPer1000).toBeLessThanOrEqual(1);
  });
});

// No card = inspection only (owner pick D18): a callback whose name says nothing has no protocol card on the server, so the
// close-out prefills no house mix. A callback whose name says pest work keeps it.
describe('isPestDefaultMixVisit: a callback booking', () => {
  it.each(['Courtesy Visit', 'Service Visit', 'Mud Dauber Removal'])('a callback named "%s" gets no house mix', (serviceType) => {
    expect(isPestDefaultMixVisit({ serviceType, isCallback: true })).toBe(false);
  });

  it.each(['Pest Control Service', 'Quarterly Pest Control', 'Re-Service'])('a callback named "%s" keeps the house mix', (serviceType) => {
    expect(isPestDefaultMixVisit({ serviceType, isCallback: true })).toBe(true);
  });
});

describe('isPestDefaultMixVisit: a re-service follows the server card by key', () => {
  it('a callback named "Courtesy Visit" keeps the mix under a general pest key, and gets none with no key or another key', () => {
    expect(isPestDefaultMixVisit({ serviceType: 'Courtesy Visit', isCallback: true, completionProfile: { serviceKey: 'pest_re_service' } })).toBe(true);
    expect(isPestDefaultMixVisit({ serviceType: 'Courtesy Visit', isCallback: true })).toBe(false);
    expect(isPestDefaultMixVisit({ serviceType: 'Courtesy Visit', isCallback: true, serviceKey: 'web_sweep' })).toBe(false);
  });

  it('a bare "Re-Service" keeps the mix with no key or a general pest key, and gets none under another service\'s key', () => {
    expect(isPestDefaultMixVisit({ serviceType: 'Re-Service' })).toBe(true);
    expect(isPestDefaultMixVisit({ serviceType: 'Re-Service', serviceKey: 'pest_general_quarterly' })).toBe(true);
    expect(isPestDefaultMixVisit({ serviceType: 'Re-Service', serviceKey: 'web_sweep' })).toBe(false);
    expect(isPestDefaultMixVisit({ serviceType: 'Pest Control Re-Service', serviceKey: 'web_sweep' })).toBe(true);
  });
});

/**
 * Pricing audit — rodent bait rows (codex #3591 r11).
 *
 * (P2) The one-time bait-station setup is not separately COGS-applicable —
 * hardware is costed under the recurring rodent program — so a standalone
 * non-member rodent quote must not read as missing_cogs.
 * (P2) A pinned pre-realignment rodent row carries the legacy no-discount
 * posture; the audit must honor it rather than apply the plan-wide %.
 */
const {
  keyFromName,
  normalizeOneTimeLines,
  normalizeRecurringLines,
} = require('../services/estimate-pricing-audit');

describe('estimate pricing audit — rodent bait (codex #3591 r11)', () => {
  test('the bait-station setup keys to rodent_bait_setup (never termite) and is COGS not-applicable', () => {
    expect(keyFromName('Bait Station Setup')).toBe('rodent_bait_setup');
    expect(keyFromName('Rodent Bait Stations')).toBe('rodent_bait');
    expect(keyFromName('Termite Bait Station Monitoring')).toBe('termite_bait');
    const lines = normalizeOneTimeLines({
      oneTime: { items: [{ service: 'rodent_bait_setup', name: 'Bait Station Setup', price: 99 }] },
    });
    expect(lines).toEqual([expect.objectContaining({ serviceKey: 'rodent_bait_setup', price: 99, skipCogs: true })]);
    // Legacy shape without a service key resolves by name the same way.
    expect(normalizeOneTimeLines({ oneTime: { items: [{ name: 'Bait Station Setup', price: 99 }] } })[0])
      .toMatchObject({ serviceKey: 'rodent_bait_setup', skipCogs: true });
  });

  test('a pinned legacy rodent row keeps its disclosed rate under a plan-wide tier discount; a new-model row takes it', () => {
    const result = {
      recurring: {
        discount: 0.1,
        services: [
          { service: 'pest_control', name: 'Pest Control', mo: 100 },
          {
            service: 'rodent_bait', name: 'Rodent Bait Stations', mo: 49,
            legacyPinnedReplay: true, discountable: false, waveGuardDiscountEligible: false, excludeFromPctDiscount: true,
          },
        ],
      },
    };
    const lines = normalizeRecurringLines(result);
    expect(lines.find((l) => l.serviceKey === 'pest_control')).toMatchObject({ monthly: 90, price: 1080, discount: 0.1 });
    expect(lines.find((l) => l.serviceKey === 'rodent_bait')).toMatchObject({ monthly: 49, price: 588, discount: 0 });
    // A 2026-08-29+ row (marker, no exclusion flags) is discounted like any plan row.
    const fresh = normalizeRecurringLines({
      recurring: { discount: 0.1, services: [{ service: 'rodent_bait', name: 'Rodent Bait Stations', mo: 29.67, perApplicationBilled: true, stations: 5 }] },
    });
    expect(fresh[0]).toMatchObject({ discount: 0.1, monthly: 26.7 });
  });
});

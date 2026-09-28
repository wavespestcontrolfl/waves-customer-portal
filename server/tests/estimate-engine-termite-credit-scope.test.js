// Owner 2026-09-28: the WaveGuard member perk is a free annual TERMITE
// inspection, never a free real-estate WDO inspection. A service credit
// scoped to one must never match the other.
const { _test: { serviceCreditTargetsLine } } = require('../services/pricing-engine/estimate-engine');

const WDO = { service: 'wdo_inspection', name: 'WDO Inspection Service' };
const TERMITE = { service: 'termite_inspection', name: 'Termite Inspection Service' };

describe('service credit scope: termite inspection vs WDO', () => {
  test('a termite_inspection credit never targets a WDO line', () => {
    expect(serviceCreditTargetsLine({ service: 'termite_inspection' }, WDO)).toBe(false);
    expect(serviceCreditTargetsLine({ service_key_filter: 'termite_inspection' }, WDO)).toBe(false);
  });

  test('a wdo_inspection credit never targets a termite inspection line', () => {
    expect(serviceCreditTargetsLine({ service: 'wdo_inspection' }, TERMITE)).toBe(false);
  });

  test('each credit still targets its own service', () => {
    expect(serviceCreditTargetsLine({ service: 'termite_inspection' }, TERMITE)).toBe(true);
    expect(serviceCreditTargetsLine({ service: 'wdo_inspection' }, WDO)).toBe(true);
  });

  test('name-only credits stay on their own side', () => {
    const perk = { catalogName: 'WaveGuard Member Free Annual Termite Inspection' };
    expect(serviceCreditTargetsLine(perk, WDO)).toBe(false);
    expect(serviceCreditTargetsLine(perk, TERMITE)).toBe(true);
    expect(serviceCreditTargetsLine({ catalogName: 'Free WDO Inspection' }, TERMITE)).toBe(false);
    expect(serviceCreditTargetsLine({ catalogName: 'Free WDO Inspection' }, WDO)).toBe(true);
  });
});

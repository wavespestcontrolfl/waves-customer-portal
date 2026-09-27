/**
 * The callback classifier is the ONE place scheduling (is_callback) and
 * completion (no monthly-dues fallback) agree on what a free callback is.
 * rodent_trapping_followup is a callback under the Standard-only trapping
 * plan (unlimited included callbacks, owner 2026-08-26).
 */
const { isReService, RE_SERVICE_SERVICE_KEYS } = require('../services/re-service');

describe('re-service callback keys', () => {
  test('rodent_trapping_followup classifies as a callback by key', () => {
    expect(RE_SERVICE_SERVICE_KEYS.has('rodent_trapping_followup')).toBe(true);
    expect(isReService({ serviceKey: 'rodent_trapping_followup', serviceName: 'Rodent Trapping Follow-Up Visit' })).toBe(true);
  });

  test('the original keys and the name safety net are unchanged', () => {
    expect(isReService({ serviceKey: 'pest_re_service' })).toBe(true);
    expect(isReService({ serviceKey: 'lawn_re_service' })).toBe(true);
    expect(isReService({ serviceType: 'Pest Re-Service' })).toBe(true);
    expect(isReService({ serviceKey: 'rodent_trapping', serviceName: 'Rodent Trapping Service' })).toBe(false);
  });
});

// Owner ruling 2026-09-26: visit 3+ of a trapping job is the $95
// rodent_trap_check_additional row. It must bill at completion — members
// included — so it can be neither a callback (is_callback skips every
// completion invoice lane and zeroes member bookings) nor an always-free
// service type by name.
describe('rodent_trap_check_additional is a billable visit', () => {
  const { isAlwaysFreeServiceType } = require('../services/no-cost-visit-types');
  const NAME = 'Rodent Trap Check - Additional';

  test('not a callback by key or by name', () => {
    expect(RE_SERVICE_SERVICE_KEYS.has('rodent_trap_check_additional')).toBe(false);
    expect(isReService({ serviceKey: 'rodent_trap_check_additional', serviceName: NAME, serviceType: NAME })).toBe(false);
  });

  test('its catalog name is not an always-free service type', () => {
    expect(isAlwaysFreeServiceType(NAME)).toBe(false);
    const migration = require('../models/migrations/20260927000001_rodent_trap_check_additional');
    expect(migration.NEW_KEY).toBe('rodent_trap_check_additional');
  });
});

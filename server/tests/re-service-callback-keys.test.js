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

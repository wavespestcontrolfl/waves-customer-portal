/**
 * Rodent trapping: $350 covers setup + 1 trap check; visit 3+ is the
 * "Rodent Trap Check - Additional" catalog row (owner ruling 2026-09-26).
 * Pins the pricing-side guards and the customer copy.
 */
const { RODENT } = require('../services/pricing-engine/constants');
const copy = require('../services/estimate-one-time-copy');

describe('rodent trap check pricing + copy', () => {
  test('the engine allows one included check and a $95 code-default extra', () => {
    expect(RODENT.trapping.includedFollowUps).toBe(1);
    expect(RODENT.trapping.additionalCheckPrice).toBe(95);
  });

  test('the extra check is excluded from every % discount', () => {
    const { serviceExcludedFromPercentDiscount } = require('../services/pricing-engine/discount-engine');
    expect(serviceExcludedFromPercentDiscount('rodent_trap_check_additional')).toBe(true);
  });

  test('Pricing Logic refuses any trapping allowance other than 1', () => {
    const { validatePricingConfigData } = require('../routes/admin-pricing-config');
    const base = { emergency_multiplier: 1.2, emergency_minimum_surcharge: 75 };
    expect(validatePricingConfigData('rodent_trapping', { ...base, included_followups: 1 }).ok).toBe(true);
    expect(validatePricingConfigData('rodent_trapping', { ...base, included_followups: 2 }).ok).toBe(false);
    expect(validatePricingConfigData('rodent_trapping', { ...base, included_followups: 'unlimited' }).ok).toBe(false);
  });

  test('saved estimates render the allowance they were priced with', () => {
    const legacy = { service: 'rodent_trapping', price: 350, unlimitedCallbacks: true, includedFollowUps: 'unlimited' };
    const current = { service: 'rodent_trapping', price: 350, unlimitedCallbacks: false, includedFollowUps: 1 };
    const twoChecks = { service: 'rodent_trapping', price: 350, includedFollowUps: 2 };

    expect(copy.resolveOneTimeServiceCopy(legacy).includes.join(' ')).not.toMatch(/trap-check visit|billed separately/);
    expect(copy.oneTimeOnlyIntelligenceCopy([legacy]).aiBody).not.toMatch(/one trap check/);
    expect(copy.oneTimeOnlyIntelligenceCopy([legacy]).hero.sub).toMatch(/until the activity stops/);

    expect(copy.resolveOneTimeServiceCopy(current).includes).toContain('Setup visit plus 1 trap-check visit — additional checks are billed separately if the job needs them');
    expect(copy.oneTimeOnlyIntelligenceCopy([current]).aiBody).toMatch(/the setup visit and one trap check for/);

    expect(copy.resolveOneTimeServiceCopy(twoChecks).includes).toContain('Setup visit plus 2 trap-check visits — additional checks are billed separately if the job needs them');
    expect(copy.oneTimeOnlyIntelligenceCopy([twoChecks]).aiBody).toMatch(/the setup visit and two trap checks for/);
  });

  test('no copy carries an unfilled placeholder', () => {
    const current = { service: 'rodent_trapping', price: 350, includedFollowUps: 1 };
    const all = JSON.stringify([copy.resolveOneTimeServiceCopy(current), copy.oneTimeOnlyIntelligenceCopy([current])]);
    expect(all).not.toMatch(/\{checks\}|\{Checks\}/);
  });
});

// Non-pest wizard series seeding (owner GO 2026-08-26): the QUOTE is the
// cadence authority. resolveWizardSeriesPlan is pure — real unit coverage —
// plus source contracts pinning the booking route's all-or-nothing wiring.
const fs = require('fs');
const path = require('path');
const { resolveWizardSeriesPlan, derivePerApplicationAmount, wizardPlanServiceKey } = require('../services/booking-pay-at-visit');

const booking = fs.readFileSync(path.join(__dirname, '..', 'routes', 'booking.js'), 'utf8');

// Minimal estimate shape the converter's extractor understands: engineResult
// lineItems with a priced recurring mosquito line.
function mosquitoEstimate({ visits = 12, frequency, monthly = 60, annual = 720, perVisit = 60 } = {}) {
  return {
    id: 'est-1',
    annual_total: annual,
    monthly_total: monthly,
    estimate_data: {
      engineResult: {
        lineItems: [{
          service: 'mosquito',
          name: 'WaveGuard Mosquito',
          monthly,
          annual,
          perVisit,
          visits,
          ...(frequency !== undefined ? { frequency } : {}),
        }],
      },
    },
  };
}

describe('resolveWizardSeriesPlan', () => {
  test('monthly-12 mosquito quote resolves to a monthly 12-visit plan', () => {
    const plan = resolveWizardSeriesPlan(mosquitoEstimate({ visits: 12 }), 'mosquito');
    expect(plan).toEqual({ pattern: 'monthly', visits: 12 });
  });

  test('the booked service family must match the quoted line', () => {
    expect(resolveWizardSeriesPlan(mosquitoEstimate(), 'lawn_care')).toBeNull();
    expect(resolveWizardSeriesPlan(mosquitoEstimate(), null)).toBeNull();
  });

  test('a 9-visit mosquito line maps to the seasonal program by the engine tier table', () => {
    expect(resolveWizardSeriesPlan(mosquitoEstimate({ visits: 9 }), 'mosquito'))
      .toEqual({ pattern: 'seasonal_feb_oct', visits: 9 });
  });

  test('an off-tier mosquito visit count fails closed', () => {
    expect(resolveWizardSeriesPlan(mosquitoEstimate({ visits: 10 }), 'mosquito')).toBeNull();
  });

  test('an explicit seasonal cadence resolves at 9 visits', () => {
    const plan = resolveWizardSeriesPlan(
      mosquitoEstimate({ visits: 9, frequency: 'seasonal_feb_oct' }),
      'mosquito',
    );
    expect(plan).toEqual({ pattern: 'seasonal_feb_oct', visits: 9 });
  });

  test('the engine tier table outranks the persisted label for mosquito (seasonal9 rows carry every_6_weeks)', () => {
    expect(resolveWizardSeriesPlan(
      mosquitoEstimate({ visits: 9, frequency: 'every_6_weeks' }),
      'mosquito',
    )).toEqual({ pattern: 'seasonal_feb_oct', visits: 9 });
    expect(resolveWizardSeriesPlan(
      mosquitoEstimate({ visits: 12, frequency: 'quarterly' }),
      'mosquito',
    )).toEqual({ pattern: 'monthly', visits: 12 });
  });

  test('pricing divides the quoted annual across the plan visits (monthly-12)', () => {
    expect(derivePerApplicationAmount(mosquitoEstimate({ annual: 720 }), 12)).toBe(60);
  });
});

// Palm-only quotes ride the tree_shrub funnel service for availability while
// quoting Palm Injections (public-quote's bookingServiceId mapping) — the
// plan family must follow the trusted estimate's own line (codex #3504 r2).
function palmEstimate({ visits = 2, frequency = 'semiannual', monthly = 50, annual = 600 } = {}) {
  return {
    id: 'est-palm-1',
    annual_total: annual,
    monthly_total: monthly,
    estimate_data: {
      engineResult: {
        lineItems: [{
          service: 'palm_injection',
          name: 'Palm Injections',
          monthly,
          annual,
          perVisit: annual / visits,
          visits,
          frequency,
        }],
      },
    },
  };
}

describe('wizardPlanServiceKey (palm identity through the tree_shrub funnel)', () => {
  test('a palm-only quote signed as tree_shrub binds the plan to palm_injection', () => {
    expect(wizardPlanServiceKey(palmEstimate(), 'tree_shrub')).toBe('palm_injection');
  });

  test('a real tree/shrub quote keeps the signed tree_shrub key', () => {
    const treeEstimate = {
      id: 'est-ts-1',
      annual_total: 900,
      monthly_total: 75,
      estimate_data: {
        engineResult: {
          lineItems: [{ service: 'tree_shrub', name: 'Tree & Shrub', monthly: 75, annual: 900, perVisit: 100, visits: 9 }],
        },
      },
    };
    expect(wizardPlanServiceKey(treeEstimate, 'tree_shrub')).toBe('tree_shrub');
  });

  test('non-tree funnel keys pass through untouched', () => {
    expect(wizardPlanServiceKey(palmEstimate(), 'mosquito')).toBe('mosquito');
  });

  test('the palm plan then resolves at the quoted semiannual cadence', () => {
    expect(resolveWizardSeriesPlan(palmEstimate(), wizardPlanServiceKey(palmEstimate(), 'tree_shrub')))
      .toEqual({ pattern: 'semiannual', visits: 2 });
    // The signed key alone still refuses — the identity preservation is
    // what makes palm reachable at all.
    expect(resolveWizardSeriesPlan(palmEstimate(), 'tree_shrub')).toBeNull();
  });
});

describe('booking route wiring (source contracts)', () => {
  test('the pricing divisor comes from the plan only under the trusted-handoff bind', () => {
    expect(booking).toMatch(/if \(!bookingVisits && pricingTrusted[\s\S]{0,1500}resolveWizardSeriesPlan\(pricingEstimate, wizardPlanKey\)/);
    expect(booking).toMatch(/bookedServiceKey !== 'pest_control'/);
  });

  test('palm identity is preserved from the trusted estimate and persisted on the parent', () => {
    expect(booking).toMatch(/wizardPlanServiceKey\(pricingEstimate, bookedServiceKey\)/);
    expect(booking).toMatch(/wizardPlanKey === 'palm_injection'[\s\S]{0,600}resolvedServiceType = 'Palm Injections';/);
  });

  test('a duplicate confirmation reads a completed activation as success, never as drift', () => {
    // The under-lock is_recurring re-check must run BEFORE the locked-draft
    // drift comparison, or the loser strips the winner's activated parent.
    expect(booking).toMatch(/lockedParent && lockedParent\.is_recurring[\s\S]{0,80}alreadyActivated: true/);
    const recheckAt = booking.indexOf('alreadyActivated: true');
    const driftAt = booking.indexOf('freshPlan.pattern !== wizardSeriesPlan.pattern');
    expect(recheckAt).toBeGreaterThan(0);
    expect(driftAt).toBeGreaterThan(recheckAt);
  });

  test('series, price, and fee are all-or-nothing: seeding requires the priced plan', () => {
    expect(booking).toMatch(/wizardSeriesPlan && paymentPref === 'pay_at_visit'/);
    // The seeding transaction guards duplicates and stamps atomically.
    expect(booking).toMatch(/pattern: wizardSeriesPlan\.pattern,\s*\n\s*plannedCount: wizardSeriesPlan\.visits,/);
    expect(booking).toMatch(/wizard-series seeding failed/);
  });

  test('unplanned bookings keep the waiver-only disposition (stamp stays off)', () => {
    expect(booking).toMatch(/\} else if \(!shouldSeedQuarterlyPestFollowUps && setupFeeHandoffEligible && !isOneTimeEstimateBooking\) \{/);
  });

  test('seasonal plans refuse winter (Nov-Jan) parent starts', () => {
    expect(booking).toMatch(/startMonth >= 2 && startMonth <= 10/);
  });

  test('the plan and price re-resolve against the LOCKED draft before seeding', () => {
    expect(booking).toMatch(/freshPlan\.pattern !== wizardSeriesPlan\.pattern/);
    expect(booking).toMatch(/freshPriced\.followUpAmount !== followUpVisitPrice/);
    expect(booking).toMatch(/return \{ stale: true \};/);
  });

  test('replay activation keys on the live-draft marker (annual plans seed no children; insert-time correlation is not activation)', () => {
    expect(booking).toMatch(/draftStillLive\s*\n\s*&& !hasChildren/);
    expect(booking).toMatch(/whereNull\('archived_at'\)/);
  });

  test('a drifted plan strips the parent pricing atomically with the skip', () => {
    expect(booking).toMatch(/estimated_price: null,\s*\n\s*payment_method_preference: null,\s*\n\s*create_invoice_on_complete: false,/);
  });

  test('seeded occurrences run the SHARED tech-blind occupancy guard', () => {
    // codex #3504 r2 P1: a custom tech-scoped predicate missed conflicts
    // with a different technician's visit — the repository backstop is
    // findConflictingVisits (services/scheduling/occupancy.js).
    expect(booking).toMatch(/require\('\.\.\/services\/scheduling\/occupancy'\)/);
    expect(booking).toMatch(/findConflictingVisits\(\{\s*\n\s*db: trx,/);
    expect(booking).toMatch(/office to place/);
  });

  test('fee-exempt seeded bookings still correlate the parent and retire the draft', () => {
    expect(booking).toMatch(/whereNull\('source_estimate_id'\)\s*\n\s*\.update\(\{ source_estimate_id: pricing_estimate_id/);
    expect(booking).toMatch(/source: 'quote_wizard', status: 'draft' \}\)\s*\n\s*\.whereNull\('archived_at'\)/);
  });
});

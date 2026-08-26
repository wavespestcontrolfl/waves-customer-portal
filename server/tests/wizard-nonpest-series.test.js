// Non-pest wizard series seeding (owner GO 2026-08-26): the QUOTE is the
// cadence authority. resolveWizardSeriesPlan is pure — real unit coverage —
// plus source contracts pinning the booking route's all-or-nothing wiring.
const fs = require('fs');
const path = require('path');
const { resolveWizardSeriesPlan, derivePerApplicationAmount } = require('../services/booking-pay-at-visit');

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

describe('booking route wiring (source contracts)', () => {
  test('the pricing divisor comes from the plan only under the trusted-handoff bind', () => {
    expect(booking).toMatch(/if \(!bookingVisits && pricingTrusted[\s\S]{0,400}resolveWizardSeriesPlan\(pricingEstimate, bookedServiceKey\)/);
    expect(booking).toMatch(/bookedServiceKey !== 'pest_control'/);
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

  test('seeded occurrences run the conflict guard incl. the technician-NULL mirror', () => {
    expect(booking).toMatch(/orWhereNull\('technician_id'\)/);
    expect(booking).toMatch(/office to place/);
  });

  test('fee-exempt seeded bookings still correlate the parent and retire the draft', () => {
    expect(booking).toMatch(/whereNull\('source_estimate_id'\)\s*\n\s*\.update\(\{ source_estimate_id: pricing_estimate_id/);
    expect(booking).toMatch(/source: 'quote_wizard', status: 'draft' \}\)\s*\n\s*\.whereNull\('archived_at'\)/);
  });
});

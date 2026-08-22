/**
 * Public quote wizard — one-time pest shoppers can self-serve a price.
 *
 * The website form's intake asks "Ongoing / One-Time / Not sure", but its
 * confirm step only ever sent `services.pest` with a recurring frequency
 * (the one-time choice was silently reset to quarterly), and this route
 * accepted no one-time pest key at all — so a one-time shopper could not get
 * a one-time number anywhere in the flow. `oneTimePest` is now a public quote
 * service, priced by the engine's one-time pest line (quarterly anchor ×
 * multiplier, floor), with urgency/after-hours forced off on this
 * unauthenticated route.
 */

const { generateEstimate } = require('../services/pricing-engine');
const { _internals, PUBLIC_QUOTE_SERVICE_KEYS } = require('../routes/public-quote');

const {
  buildPublicQuoteServiceInterest,
  buildCompactPublicQuoteServiceInterest,
  derivePerApplication,
  derivePerApplicationBreakdown,
} = _internals;

const BASE_PROPERTY = { homeSqFt: 1800, lotSqFt: 8783, stories: 1, yearBuilt: 2005 };

describe('oneTimePest as a public quote service', () => {
  test('is an accepted service key', () => {
    expect(PUBLIC_QUOTE_SERVICE_KEYS).toContain('oneTimePest');
  });

  test('labels read as a one-time treatment, never a recurring program', () => {
    expect(buildPublicQuoteServiceInterest({ oneTimePest: {} })).toBe('One-Time Pest Treatment');
    expect(buildCompactPublicQuoteServiceInterest({ oneTimePest: {} })).toBe('One-Time Pest');
    expect(buildPublicQuoteServiceInterest({ oneTimePest: {}, lawn: {} }))
      .toBe('One-Time Pest Treatment + Recurring Lawn Care');
  });

  test('the engine prices it as a single one-time charge with no recurring spread', () => {
    const estimate = generateEstimate({
      ...BASE_PROPERTY,
      services: { oneTimePest: { urgency: 'NONE', afterHours: false } },
    });
    const line = estimate.lineItems.find((l) => l.service === 'one_time_pest');
    expect(line).toBeDefined();
    expect(line.price).toBeGreaterThan(0);
    expect(Number(estimate.summary.oneTimeTotal)).toBeGreaterThan(0);
    expect(Number(estimate.summary.recurringMonthlyAfterDiscount || 0)).toBe(0);
    // The result widget's recurring shapes stay empty, so it falls through to
    // the "$X one-time" presentation instead of inventing a cadence.
    expect(derivePerApplication(estimate)).toBeNull();
    expect(derivePerApplicationBreakdown(estimate)).toBeNull();
  });

  test('one-time pest stays strictly above a recurring customer\'s first visit (incentive to commit)', () => {
    const oneTime = generateEstimate({
      ...BASE_PROPERTY,
      services: { oneTimePest: { urgency: 'NONE', afterHours: false } },
    });
    const recurring = generateEstimate({
      ...BASE_PROPERTY,
      services: { pest: { frequency: 'quarterly' } },
    });
    const oneTimeLine = oneTime.lineItems.find((l) => l.service === 'one_time_pest');
    const pestLine = recurring.lineItems.find((l) => l.service === 'pest_control');
    expect(oneTimeLine.price).toBeGreaterThan(Number(pestLine.basePrice));
  });
});

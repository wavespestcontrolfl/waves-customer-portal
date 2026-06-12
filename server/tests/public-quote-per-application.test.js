/**
 * Public quote wizard — per-application price derivation + booking-invite
 * SMS template wiring (owner reports, 2026-06-12):
 *
 *   1. The wizard result caption showed "$432/yr"; the owner wants the
 *      per-application price ("$108 per application"). derivePerApplication
 *      returns {amount, visitsPerYear} only when exactly one recurring line
 *      carries per-app pricing — mixed cadences fall back to the annual
 *      caption client-side.
 *
 *   2. The post-quote booking SMS must use quote_wizard_booking_invite, NOT
 *      estimate_accepted_onetime ("Thanks for booking…") — nothing is booked
 *      at the quote moment.
 */

const { generateEstimate } = require('../services/pricing-engine');
const { _internals } = require('../routes/public-quote');

const { derivePerApplication } = _internals;

describe('derivePerApplication', () => {
  test('single recurring service (quarterly pest) yields per-app amount and cadence', () => {
    const estimate = generateEstimate({
      homeSqFt: 1800,
      lotSqFt: 8783,
      stories: 1,
      yearBuilt: 2005,
      services: { pest: { frequency: 'quarterly' } },
    });
    const result = derivePerApplication(estimate);
    expect(result).not.toBeNull();
    expect(result.visitsPerYear).toBe(4);
    expect(result.amount).toBeGreaterThan(0);
    // Per-app × visits reconciles with the engine's annual (rounding aside).
    const annual = Number(estimate.summary.recurringAnnualAfterDiscount);
    expect(Math.abs(result.amount * result.visitsPerYear - annual)).toBeLessThanOrEqual(result.visitsPerYear);
  });

  test('two recurring services with different cadences returns null (ambiguous)', () => {
    const estimate = {
      lineItems: [
        { service: 'pest_control', perApp: 108, visitsPerYear: 4 },
        { service: 'lawn_care', perApp: 90, visitsPerYear: 9 },
      ],
    };
    expect(derivePerApplication(estimate)).toBeNull();
  });

  test('one-time-only line items (no visitsPerYear) return null', () => {
    const estimate = {
      lineItems: [
        { service: 'bed_bug', price: 850, perApp: null, visitsPerYear: null },
      ],
    };
    expect(derivePerApplication(estimate)).toBeNull();
  });

  test('missing or empty estimate returns null', () => {
    expect(derivePerApplication(null)).toBeNull();
    expect(derivePerApplication({})).toBeNull();
    expect(derivePerApplication({ lineItems: [] })).toBeNull();
  });

  test('amount is rounded to whole dollars', () => {
    const estimate = {
      lineItems: [{ service: 'pest_control', perApp: 107.5, visitsPerYear: 4 }],
    };
    expect(derivePerApplication(estimate).amount).toBe(108);
  });
});

describe('booking SMS template wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const routeSource = fs.readFileSync(
    path.join(__dirname, '../routes/public-quote.js'),
    'utf8'
  );

  test('quote-moment SMS renders quote_wizard_booking_invite, not estimate_accepted_onetime', () => {
    // estimate_accepted_onetime stays in use elsewhere (estimate-accept flow,
    // admin resend) — but the wizard route itself must not send it.
    expect(routeSource).toContain("'quote_wizard_booking_invite'");
    expect(routeSource).not.toContain("'estimate_accepted_onetime'");
  });

  test('migration seeds the new template with the booking_url variable', () => {
    const migration = require('../models/migrations/20260612000001_quote_wizard_booking_invite_sms.js');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
    const source = fs.readFileSync(
      path.join(__dirname, '../models/migrations/20260612000001_quote_wizard_booking_invite_sms.js'),
      'utf8'
    );
    expect(source).toContain('quote_wizard_booking_invite');
    expect(source).toContain('{booking_url}');
    expect(source).not.toContain('Thanks for booking');
  });
});

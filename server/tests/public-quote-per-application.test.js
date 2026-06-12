/**
 * Public quote wizard — per-application price derivation + booking-invite
 * SMS template wiring (owner reports, 2026-06-12):
 *
 *   1. The wizard result caption showed "$432/yr"; the owner wants the
 *      per-application price ("$108 per application"). derivePerApplication
 *      returns {amount, visitsPerYear} only when the quote has exactly one
 *      recurring line (counted by positive monthly) AND that line's per-app
 *      price + cadence are derivable — anything else falls back to the
 *      annual caption client-side. Cadence quirk (Codex r1): pest lines
 *      expose visitsPerYear with a STRING frequency ('quarterly'); lawn
 *      lines expose a NUMERIC frequency (apps/year) and no visitsPerYear.
 *
 *   2. The post-quote booking SMS must use quote_wizard_booking_invite, NOT
 *      estimate_accepted_onetime ("Thanks for booking…") — nothing is booked
 *      at the quote moment.
 */

const { generateEstimate } = require('../services/pricing-engine');
const { _internals } = require('../routes/public-quote');

const { derivePerApplication } = _internals;

const BASE_PROPERTY = { homeSqFt: 1800, lotSqFt: 8783, stories: 1, yearBuilt: 2005 };

describe('derivePerApplication', () => {
  test('single recurring service (quarterly pest) yields per-app amount and cadence', () => {
    const estimate = generateEstimate({
      ...BASE_PROPERTY,
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

  test('lawn-only quote derives cadence from numeric frequency (no visitsPerYear on lawn lines)', () => {
    const estimate = generateEstimate({
      ...BASE_PROPERTY,
      services: { lawn: { track: 'st_augustine', tier: 'enhanced' } },
    });
    const result = derivePerApplication(estimate);
    expect(result).not.toBeNull();
    expect(result.amount).toBeGreaterThan(0);
    expect([6, 9, 12]).toContain(result.visitsPerYear);
  });

  test("pest+lawn returns null — never present one line's per-app as the whole quote's", () => {
    const estimate = generateEstimate({
      ...BASE_PROPERTY,
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', tier: 'enhanced' },
      },
    });
    expect(derivePerApplication(estimate)).toBeNull();
  });

  test('pest+mosquito returns null even though only the pest line has perApp', () => {
    const estimate = generateEstimate({
      ...BASE_PROPERTY,
      services: {
        pest: { frequency: 'quarterly' },
        mosquito: { tier: 'monthly12' },
      },
    });
    expect(derivePerApplication(estimate)).toBeNull();
  });

  test('single recurring line without per-app pricing returns null', () => {
    const estimate = {
      lineItems: [{ service: 'mosquito', monthly: 54 }],
    };
    expect(derivePerApplication(estimate)).toBeNull();
  });

  test('one-time-only line items (no monthly) return null', () => {
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
      lineItems: [{ service: 'pest_control', monthly: 35.83, perApp: 107.5, visitsPerYear: 4 }],
    };
    expect(derivePerApplication(estimate).amount).toBe(108);
  });

  test('string frequency (pest shape) never coerces into a cadence', () => {
    const estimate = {
      lineItems: [{ service: 'pest_control', monthly: 36, perApp: 108, frequency: 'quarterly' }],
    };
    // No visitsPerYear and non-numeric frequency → underivable, fall back.
    expect(derivePerApplication(estimate)).toBeNull();
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

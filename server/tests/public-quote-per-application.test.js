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

const { derivePerApplication, resolveRealLotSqFt } = _internals;

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

describe('resolveRealLotSqFt — trusted lot gate for commercial mosquito', () => {
  test('a lookup-measured parcel lot is trusted (enriched.lotSqFt)', () => {
    expect(resolveRealLotSqFt({ enrichedLotSqFt: 32000, lotSqFt: 8000, lotSizeConfirmed: false })).toBe(32000);
  });

  test('a customer-confirmed (hand-edited) lot is trusted', () => {
    expect(resolveRealLotSqFt({ enrichedLotSqFt: null, lotSqFt: 25000, lotSizeConfirmed: true })).toBe(25000);
  });

  test('a customer-confirmed edit wins over a stale lookup parcel (used as the engine lot)', () => {
    // The customer corrected the lookup on the confirm step — their value must be
    // what we both trust AND feed to the pricer, not the stale enriched value.
    expect(resolveRealLotSqFt({ enrichedLotSqFt: 20000, lotSqFt: 25000, lotSizeConfirmed: true })).toBe(25000);
  });

  test('the synthetic default lot (posted but never measured/confirmed) is NOT trusted → null', () => {
    // The wizard seeds lotSqFt='8000' when the lookup has no parcel; without a
    // confirm flag this must NOT count as a measured lot (else commercial mosquito
    // auto-prices off a fabricated area). Regression for the PR bot's P1.
    expect(resolveRealLotSqFt({ enrichedLotSqFt: undefined, lotSqFt: 8000, lotSizeConfirmed: false })).toBeNull();
    expect(resolveRealLotSqFt({ enrichedLotSqFt: 0, lotSqFt: 8000, lotSizeConfirmed: undefined })).toBeNull();
  });

  test('a confirmed-but-zero lot is not trusted', () => {
    expect(resolveRealLotSqFt({ enrichedLotSqFt: null, lotSqFt: 0, lotSizeConfirmed: true })).toBeNull();
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

  test('one-time quote SMS uses the regular booking invite path', () => {
    const retiredTemplateKey = ['estimate', 'onetime', 'followup'].join('_');
    expect(routeSource).not.toContain(retiredTemplateKey);
    expect(routeSource).toContain('if (normalizedPhone && !quoteRequired && bookingUrl)');
    expect(routeSource).toContain('bookingServiceFor(serviceInterest)');
    expect(routeSource).toContain("'quote-wizard-onetime'");
    expect(routeSource).toContain("bookingParams.set('service_label', bookingServiceLabel)");
    expect(routeSource).toContain('bookingServiceLabel = serviceInterest || bookingService.label');
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

describe('one-time quote booking source', () => {
  test('quote-wizard one-time links are treated as non-recurring booking sources', () => {
    const bookingRoute = require('../routes/booking');

    expect(bookingRoute._internals.isOneTimeBookingSource('estimate-accept')).toBe(true);
    expect(bookingRoute._internals.isOneTimeBookingSource('quote-wizard-onetime')).toBe(true);
    expect(bookingRoute._internals.isOneTimeBookingSource('quote-wizard')).toBe(false);
    expect(bookingRoute._internals.cleanBookingServiceLabel('  Wasp   & Hornet Control  ')).toBe('Wasp & Hornet Control');
  });

  test('public booking page posts the quoted one-time service label when present', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '../../client/src/pages/PublicBookingPage.jsx'),
      'utf8'
    );

    expect(source).toContain("searchParams.get('service_label')");
    expect(source).toContain('service_type: quotedServiceLabel || service.label');
    expect(source).toContain('quoted_service_label: quotedServiceLabel || null');
  });
});

describe('treeShrub count mapping — omitted count must reach the engine as ABSENT (2026-07-05)', () => {
  // The /calculate mapping used `treeCount: services.treeShrub.treeCount ?? 0`,
  // and priceTreeShrub's density fallback runs ONLY when the field is absent/
  // null/empty — an explicit 0 is treated as a real count. So every
  // blank-count public quote priced zero trees. These pin the engine contract
  // the fixed mapping relies on.

  const TREED_PROPERTY = { ...BASE_PROPERTY, treeDensity: 'moderate' };

  test('omitted treeCount → density fallback estimates the count', () => {
    const estimate = generateEstimate({
      ...TREED_PROPERTY,
      services: { treeShrub: { access: 'easy' } },
    });
    const line = (estimate.lineItems || []).find((l) => /tree/i.test(l.service || l.label || ''));
    expect(line).toBeTruthy();
    expect(JSON.stringify(estimate.warnings || line.warnings || [])).toMatch(/estimated 6 trees/i);
  });

  test('explicit treeCount: 0 suppresses the fallback (why the mapping must omit the key)', () => {
    const withZero = generateEstimate({
      ...TREED_PROPERTY,
      services: { treeShrub: { access: 'easy', treeCount: 0 } },
    });
    const withOmitted = generateEstimate({
      ...TREED_PROPERTY,
      services: { treeShrub: { access: 'easy' } },
    });
    const total = (e) => Number(e.summary?.recurringAnnualAfterDiscount || 0) + Number(e.summary?.oneTimeTotal || 0);
    expect(total(withOmitted)).toBeGreaterThan(total(withZero));
  });

  test('route mapping omits treeCount unless a positive number was sent', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../routes/public-quote.js'), 'utf8');
    expect(source).not.toContain('treeCount ?? 0');
    expect(source).toMatch(/Number\.isFinite\(treeShrubCount\) && treeShrubCount > 0/);
  });
});

describe('lawnPestControl — one-time turf-pest knockdown (owner decision 2026-07-05)', () => {
  test('services.lawnPestControl produces a priced one-time pest line', () => {
    const estimate = generateEstimate({
      ...BASE_PROPERTY,
      services: { lawnPestControl: {} },
    });
    const line = (estimate.lineItems || []).find((l) => l.service === 'one_time_lawn' && l.treatmentType === 'pest');
    expect(line).toBeTruthy();
    // Persistence compacts lines to service + name — without the distinct
    // name a lawn-pest row renders as generic one_time_lawn downstream.
    expect(line.name).toBe('Lawn Pest Knockdown');
    // ONE_TIME.lawn floor ($115) is the engine's owner-set minimum.
    expect(line.price).toBeGreaterThanOrEqual(115);
    expect(Number(estimate.summary?.oneTimeTotal || 0)).toBeGreaterThanOrEqual(line.price);
  });

  test('coexists with a weed-type oneTimeLawn line (separate line items)', () => {
    const estimate = generateEstimate({
      ...BASE_PROPERTY,
      services: { oneTimeLawn: { treatmentType: 'weed' }, lawnPestControl: {} },
    });
    const types = (estimate.lineItems || [])
      .filter((l) => l.service === 'one_time_lawn')
      .map((l) => l.treatmentType)
      .sort();
    expect(types).toEqual(['pest', 'weed']);
  });
});

describe('cockroach chip path — roachType reaches the engine (2026-07-05)', () => {
  test('roachType regular auto-adds the one-time Initial Roach Knockdown line', () => {
    // The engine deliberately does NOT raise the recurring price for roach
    // activity (the multiplicative roachModifier is zeroed) — it recovers the
    // heavier visit-1 cost via an auto-added one-time pest_initial_roach line.
    const plain = generateEstimate({
      ...BASE_PROPERTY,
      services: { pest: { frequency: 'quarterly' } },
    });
    const roach = generateEstimate({
      ...BASE_PROPERTY,
      services: { pest: { frequency: 'quarterly', roachType: 'regular' } },
    });
    expect((plain.lineItems || []).find((l) => l.service === 'pest_initial_roach')).toBeUndefined();
    const knockdown = (roach.lineItems || []).find((l) => l.service === 'pest_initial_roach');
    expect(knockdown).toBeTruthy();
    expect(knockdown.autoFiredFromRecurringPest).toBe(true);
    expect(knockdown.price).toBeGreaterThan(0);
    const oneTime = (e) => Number(e.summary?.oneTimeTotal || 0);
    expect(oneTime(roach)).toBeGreaterThanOrEqual(oneTime(plain) + knockdown.price);
  });

  test('route mapping forwards roachType (the label must never outrun the price)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../routes/public-quote.js'), 'utf8');
    expect(source).toMatch(/services\.pest\.roachType \? \{ roachType: services\.pest\.roachType \}/);
  });

  test('label uses ENGINE normalization — raw truthy junk must not label an unpriced knockdown (codex rd2)', () => {
    const { publicQuotePestLabel } = _internals;
    expect(publicQuotePestLabel({ frequency: 'quarterly', roachType: 'regular' })).toBe('Quarterly Pest Control + Roach Knockdown');
    expect(publicQuotePestLabel({ frequency: 'quarterly', roachType: 'palmetto' })).toBe('Quarterly Pest Control + Roach Knockdown');
    expect(publicQuotePestLabel({ frequency: 'quarterly', roachType: 'german' })).toBe('Quarterly Pest Control + Roach Knockdown');
    // The engine normalizes these to 'none' and prices NO knockdown line —
    // a raw truthiness check would still have appended the label.
    for (const junk of ['false', 'no', 'NONE', 'not-a-roach-type']) {
      expect(publicQuotePestLabel({ frequency: 'quarterly', roachType: junk })).toBe('Quarterly Pest Control');
    }
    expect(publicQuotePestLabel({ frequency: 'quarterly' })).toBe('Quarterly Pest Control');
  });
});

describe('palm-only booking link — routes to tree_shrub, not lawn_care (codex rd2, 2026-07-05)', () => {
  test('palm engine line is recurring service palm_injection (so the recurring resolver, not bookingServiceFor, decides)', () => {
    const estimate = generateEstimate({
      ...BASE_PROPERTY,
      services: { palm: { palmCount: 4, treatmentType: 'nutrition' } },
    });
    const line = (estimate.lineItems || []).find((l) => l.service === 'palm_injection');
    expect(line).toBeTruthy();
    expect(Number(line.monthlyBeforeCredits || 0)).toBeGreaterThan(0);
  });

  test('recurring booking resolver counts palm_injection toward the tree_shrub booking bucket', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../routes/public-quote.js'), 'utf8');
    expect(source).toMatch(/pricedServiceKeys\.has\('palm_injection'\)/);
  });
});

describe('bed bug public mapping — engine enum keys only, never a public 500 (codex rd3, 2026-07-05)', () => {
  const { publicQuoteBedBugInput } = _internals;

  test('defaults are the chat-gate product AND valid engine keys (old residential default threw)', () => {
    expect(publicQuoteBedBugInput({})).toEqual({
      method: 'CHEMICAL', rooms: 2, severity: 'moderate', prepStatus: 'ready', occupancyType: 'singleFamily',
    });
    // Junk/label-ish values collapse to the defaults instead of reaching assertEnum.
    expect(publicQuoteBedBugInput({ occupancyType: 'residential', severity: 'bad', prepStatus: 'nope', method: 'HEAT' }))
      .toEqual({ method: 'CHEMICAL', rooms: 2, severity: 'moderate', prepStatus: 'ready', occupancyType: 'singleFamily' });
  });

  test('valid keys pass through case-insensitively', () => {
    const out = publicQuoteBedBugInput({ occupancyType: 'HOTEL', severity: 'heavy', prepStatus: 'partial', rooms: 5 });
    expect(out).toEqual({ method: 'CHEMICAL', rooms: 5, severity: 'heavy', prepStatus: 'partial', occupancyType: 'hotel' });
  });

  test('mapped default shape actually prices through the engine without throwing', () => {
    const estimate = generateEstimate({
      ...BASE_PROPERTY,
      services: { bedBug: publicQuoteBedBugInput({}) },
    });
    const line = (estimate.lineItems || []).find((l) => l.service === 'bed_bug');
    expect(line).toBeTruthy();
    expect(Number(line.price || line.total || 0)).toBeGreaterThan(0);
  });
});

describe('roach knockdown blocks the quote→book handoff (codex rd3 P1, 2026-07-05)', () => {
  const { estimateBlocksBookingHandoff } = _internals;

  test('estimate with an auto-added pest_initial_roach line blocks handoff; plain pest does not', () => {
    const plain = generateEstimate({
      ...BASE_PROPERTY,
      services: { pest: { frequency: 'quarterly' } },
    });
    const roach = generateEstimate({
      ...BASE_PROPERTY,
      services: { pest: { frequency: 'quarterly', roachType: 'regular' } },
    });
    expect(estimateBlocksBookingHandoff(plain)).toBe(false);
    expect(estimateBlocksBookingHandoff(roach)).toBe(true);
  });

  test('handoffPriceable mint site consults the blocker (confirm bills annual/4 only — the one-time roach fee would vanish)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../routes/public-quote.js'), 'utf8');
    expect(source).toMatch(/handoffPriceable = !estimateBlocksBookingHandoff\(estimate\) && !!resolveBookingVisitPrice\(/);
  });
});

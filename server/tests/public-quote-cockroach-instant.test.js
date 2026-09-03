/**
 * Owner ruling 2026-09-03: catalog cockroach_control (the two-treatment
 * package, follow-up at no charge) prices instantly on the website as ONE
 * standalone knockdown (engine pestInitialRoach, regular_standalone scale).
 * The menu ⇄ route parity test in public-services-menu.test.js pins the
 * pair; this file pins the route's side and the package presentation.
 */
const { generateEstimate } = require('../services/pricing-engine');
const { PEST } = require('../services/pricing-engine/constants');
const { _internals, PUBLIC_QUOTE_SERVICE_KEYS } = require('../routes/public-quote');
const { quoteServicesForKey, PUBLIC_INSTANT_QUOTE_KEYS, COCKROACH_PACKAGE_VISITS, cockroachPackageDisplayCurrent } = require('../services/public-services-menu');
const { buildPublicQuoteServiceInterest, buildCompactPublicQuoteServiceInterest, derivePerApplication, isManualQuoteLine, estimateBlocksSelfBookLink, keyedLeadLabel, dropKeyedOnlyServices } = _internals;

const BASE_PROPERTY = { homeSqFt: 1800, lotSqFt: 8783, stories: 1, yearBuilt: 2005 };
const roachLine = (input) => generateEstimate(input).lineItems.find((l) => l.service === 'pest_initial_roach');

describe('cockroach_control as a public instant quote', () => {
  test('is advertised instant and reachable ONLY through the verified catalog key', () => {
    expect(PUBLIC_INSTANT_QUOTE_KEYS.has('cockroach_control')).toBe(true);
    expect(quoteServicesForKey('cockroach_control')).toEqual({ pestInitialRoach: { roachType: 'regular' } });
    // A site-composed body cannot name the engine key: it would skip the
    // catalog-row + live-display eligibility checks (pre-push codex P0).
    expect(PUBLIC_QUOTE_SERVICE_KEYS).not.toContain('pestInitialRoach');
    expect(dropKeyedOnlyServices({ pest: { frequency: 'quarterly' }, pestInitialRoach: { roachType: 'german' } })).toEqual({ pest: { frequency: 'quarterly' } });
    expect(dropKeyedOnlyServices({ pestInitialRoach: {} })).toEqual({});
    const untouched = { pest: { frequency: 'quarterly' } };
    expect(dropKeyedOnlyServices(untouched)).toBe(untouched);
    expect(dropKeyedOnlyServices(undefined)).toBeUndefined();
  });
  test('labels carry the STANDALONE scale\'s configured display name; compact label stays short', () => {
    expect(buildPublicQuoteServiceInterest({ pestInitialRoach: {} })).toBe('Cockroach Treatment Service');
    expect(buildCompactPublicQuoteServiceInterest({ pestInitialRoach: {} })).toBe('Roach');
    // The two names are admin-editable independently — the lead label must
    // follow regular_standalone (the scale the engine prices and renders),
    // not the recurring add-on's name (pre-push codex P1).
    const original = PEST.pestInitialRoach.display.regular_standalone;
    PEST.pestInitialRoach.display.regular_standalone = { ...original, name: 'Roach Package' };
    try {
      expect(buildPublicQuoteServiceInterest({ pestInitialRoach: {} })).toBe('Roach Package');
      expect(buildPublicQuoteServiceInterest({ pest: { frequency: 'quarterly', roachType: 'regular' } })).not.toContain('Roach Package');
    } finally {
      PEST.pestInitialRoach.display.regular_standalone = original;
    }
  });
  test('prices one standalone knockdown line on the regular_standalone scale with no recurring spread', () => {
    const estimate = generateEstimate({ ...BASE_PROPERTY, services: quoteServicesForKey('cockroach_control') });
    const line = estimate.lineItems.find((l) => l.service === 'pest_initial_roach');
    expect(line).toBeDefined();
    expect(line.standalone).toBe(true);
    expect(line.scaleKey).toBe('regular_standalone');
    expect(line.roachType).toBe('regular');
    expect(Number(line.price)).toBeGreaterThan(0);
    expect(isManualQuoteLine(line)).toBe(false);
    expect(Number(estimate.summary.recurringMonthlyAfterDiscount || 0)).toBe(0);
    expect(derivePerApplication(estimate)).toBeNull();
  });
  test('the line presents the two-treatment package (visit 2 included, no charge)', () => {
    const line = roachLine({ ...BASE_PROPERTY, services: quoteServicesForKey('cockroach_control') });
    expect(PEST.pestInitialRoach.display.regular_standalone.treatments).toBe(2);
    // The menu's catalog-row guard and the estimate copy describe the same package.
    expect(COCKROACH_PACKAGE_VISITS).toBe(PEST.pestInitialRoach.display.regular_standalone.treatments);
    expect(line.treatments).toBe(2);
    expect(line.detail).toMatch(/Includes 2 treatment visits\./);
    // ONE knockdown fee — the package count never multiplies the price.
    const bracket = PEST.pestInitialRoach.regular_standalone.find((b) => 1800 < b.sqft);
    expect(Number(line.price)).toBe(Number(bracket.price));
  });
  test('keyed lead labels read the standalone display name the estimate line renders, not the catalog name (codex r1 P2)', () => {
    const catalogRow = { service_key: 'cockroach_control', name: 'Cockroach Treatment', instant: true, booking_enabled: true };
    const services = quoteServicesForKey('cockroach_control');
    // Null ⇒ the route derives both labels from the expanded services.
    expect(keyedLeadLabel(catalogRow, services)).toBeNull();
    expect(buildPublicQuoteServiceInterest(services)).toBe('Cockroach Treatment Service');
    expect(buildCompactPublicQuoteServiceInterest(services)).toBe('Roach');
    const original = PEST.pestInitialRoach.display.regular_standalone;
    PEST.pestInitialRoach.display.regular_standalone = { ...original, name: 'Roach Package' };
    try {
      expect(buildPublicQuoteServiceInterest(services)).toBe('Roach Package');
      // The compact customer interest is derived from the SAME configured
      // name through the shared compactor, never a literal (codex r2 P2).
      expect(buildCompactPublicQuoteServiceInterest(services)).toBe(_internals.compactServiceInterestPart('Roach Package'));
      expect(buildCompactPublicQuoteServiceInterest(services)).toBe('Roach');
    } finally {
      PEST.pestInitialRoach.display.regular_standalone = original;
    }
    // Every other keyed product keeps the catalog name — identity wins.
    expect(keyedLeadLabel({ service_key: 'mosquito_one_time', name: 'One-Time Mosquito' }, quoteServicesForKey('mosquito_one_time'))).toBe('One-Time Mosquito');
    expect(keyedLeadLabel({ service_key: 'palm_injection', name: 'Palm Injection' }, {})).toBe('Palm Injection');
    expect(keyedLeadLabel(null, services)).toBeNull();
  });
  test('prices instantly but never mints a self-book slot — the funnel cannot carry the identity visit 2 needs (codex r1 P1)', () => {
    const estimate = generateEstimate({ ...BASE_PROPERTY, services: quoteServicesForKey('cockroach_control') });
    expect(estimateBlocksSelfBookLink(estimate)).toBe(true);
    // The block is the roach line itself, not a quote-required / handoff flag.
    expect(estimateBlocksSelfBookLink({ lineItems: [{ service: 'pest_initial_roach', price: 250 }] })).toBe(true);
    expect(estimateBlocksSelfBookLink({ lineItems: [{ service: 'mosquito', price: 250 }] })).toBe(false);
  });
  test('the live display-count gate the route re-checks before the engine follows the mutable constants (codex r2 P1)', () => {
    const original = PEST.pestInitialRoach.display.regular_standalone;
    expect(cockroachPackageDisplayCurrent()).toBe(true);
    try {
      PEST.pestInitialRoach.display.regular_standalone = { ...original, treatments: 3 };
      expect(cockroachPackageDisplayCurrent()).toBe(false);
      PEST.pestInitialRoach.display.regular_standalone = { name: original.name };
      expect(cockroachPackageDisplayCurrent()).toBe(false);
    } finally {
      PEST.pestInitialRoach.display.regular_standalone = original;
    }
    expect(cockroachPackageDisplayCurrent()).toBe(true);
  });
  test('the footprint drives the bracket, not the lot', () => {
    const small = roachLine({ ...BASE_PROPERTY, homeSqFt: 1200, services: quoteServicesForKey('cockroach_control') });
    const large = roachLine({ ...BASE_PROPERTY, homeSqFt: 3200, lotSqFt: 4000, services: quoteServicesForKey('cockroach_control') });
    expect(Number(large.price)).toBeGreaterThan(Number(small.price));
  });
});

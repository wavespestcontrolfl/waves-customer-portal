/**
 * isRecognizedServiceType — the allowlist predicate a display surface that
 * must never show unrecognized free text (server/services/review-reply/
 * grounding.js's public-safe servicesPerformed) checks BEFORE calling
 * normalizeServiceType at all (2026-09-25 round-4 P1 fix). Free internal
 * scheduling labels — "Owner Custom Booking Label", "Customer Complained
 * Reservice", "Dog In Home Call Before Arrival" — are not products or
 * brands, so a blacklist never caught them; normalizeServiceType returned
 * them VERBATIM (its documented fallback), and that free text reached
 * servicesPerformed. isRecognizedServiceType returns true only for the
 * three paths normalizeServiceType itself recognizes: a real catalog
 * identity, a mapped SERVICE_TYPE_MAP family, or the foam-label passthrough.
 */

const { isRecognizedServiceType, normalizeServiceType } = require('../utils/service-normalizer');
const { __setCatalogNamesForTest } = require('../services/service-catalog-names');

afterEach(() => __setCatalogNamesForTest([]));

describe('isRecognizedServiceType — unmatched free text', () => {
  test('internal scheduling labels that name no known service are not recognized', () => {
    expect(isRecognizedServiceType('Owner Custom Booking Label')).toBe(false);
    expect(isRecognizedServiceType('Customer Complained Reservice')).toBe(false);
    expect(isRecognizedServiceType('Dog In Home Call Before Arrival')).toBe(false);
  });

  test('blank/empty/null input is not recognized', () => {
    expect(isRecognizedServiceType('')).toBe(false);
    expect(isRecognizedServiceType(null)).toBe(false);
    expect(isRecognizedServiceType(undefined)).toBe(false);
    expect(isRecognizedServiceType('   ')).toBe(false);
  });

  // Confirms these really do fall through to normalizeServiceType's verbatim
  // path — the exact leak isRecognizedServiceType exists to gate.
  test('the same free-text labels normalizeServiceType returns verbatim', () => {
    expect(normalizeServiceType('Owner Custom Booking Label')).toBe('Owner Custom Booking Label');
    expect(normalizeServiceType('Customer Complained Reservice')).toBe('Customer Complained Reservice');
  });
});

describe('isRecognizedServiceType — SERVICE_TYPE_MAP family matches', () => {
  test('common prod labels are recognized', () => {
    expect(isRecognizedServiceType('Cockroach Treatment')).toBe(true);
    expect(isRecognizedServiceType('Quarterly Pest Control Service')).toBe(true);
    expect(isRecognizedServiceType('Monthly Pest Control')).toBe(true);
    expect(isRecognizedServiceType('WDO Inspection Service')).toBe(true);
    expect(isRecognizedServiceType('General Pest Control (Quarterly)')).toBe(true);
  });

  test('a price/duration suffix does not block recognition when the base label matches', () => {
    expect(isRecognizedServiceType('Pest Control Service - 1 hour - $117')).toBe(true);
    expect(normalizeServiceType('Pest Control Service - 1 hour - $117')).toBe('Pest Control Service');
  });

  test('a family match on a brand-carrying label is still "recognized" — the brand exclusion is a separate, later concern', () => {
    // service-normalizer's own map emits a brand name for these two; whether
    // that brand name is then dropped is grounding.js's SERVICE_PRODUCT_WORD_RE
    // backstop, not this predicate.
    expect(isRecognizedServiceType('Bora-Care Wood Treatment Service')).toBe(true);
    expect(isRecognizedServiceType('Arborjet Treatment')).toBe(true);
  });
});

describe('isRecognizedServiceType — foam-label passthrough', () => {
  test('a foam-family label is recognized without any SERVICE_TYPE_MAP entry', () => {
    expect(isRecognizedServiceType('Recurring Termite Foam Service (Quarterly)')).toBe(true);
    expect(isRecognizedServiceType('Foam Drill Treatment')).toBe(true);
  });
});

describe('isRecognizedServiceType — catalog identities', () => {
  test('unrecognized without a matching catalog row', () => {
    expect(isRecognizedServiceType('Rodent Trapping Service')).toBe(false);
  });

  test('recognized once the live catalog cache (service-catalog-names.js) carries the row — the production path', () => {
    __setCatalogNamesForTest(['Rodent Trapping Service']);
    expect(isRecognizedServiceType('Rodent Trapping Service')).toBe(true);
    expect(isRecognizedServiceType('rodent trapping service')).toBe(true);
    // Still false for a name the primed catalog does not carry.
    expect(isRecognizedServiceType('Owner Custom Booking Label')).toBe(false);
  });
});

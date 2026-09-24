/**
 * mappedServiceLabel — the allowlist function a display surface that must
 * never show unrecognized free text (server/services/review-reply/
 * grounding.js's public-safe servicesPerformed) calls INSTEAD of
 * normalizeServiceType (2026-09-25 round-5 P1 fix, replacing round-4's
 * isRecognizedServiceType predicate). It returns the FIRST matching
 * SERVICE_TYPE_MAP entry's fixed `type` string, or null — deliberately
 * narrower than normalizeServiceType: no catalog branch and no foam
 * passthrough, because both of those can return arbitrary text:
 *
 *   - canonicalCatalogName is populated from historical scheduled_services
 *     labels, so a hand-edited free-text label like "Dog In Home Call
 *     Before Arrival" can enter that cache and would pass through verbatim
 *     under the old isRecognizedServiceType (which trusted any catalog
 *     hit). mappedServiceLabel has no catalog branch at all, so priming the
 *     cache with a garbage label has zero effect on it.
 *   - the foam branch returned any larger string merely CONTAINING a foam
 *     token, e.g. "Foam Drill Customer Complained Reservice".
 *
 * The tests below check mappedServiceLabel's own raw return value — the
 * SERVICE_TYPE_MAP entry's `type` string exactly as written (e.g.
 * "Cockroach Treatment Service", not "Cockroach Treatment") — since the
 * trailing-suffix strip and brand exclusion are grounding.js's
 * normalizeServiceName's job, covered in review-reply-grounding.test.js.
 */

const { mappedServiceLabel } = require('../utils/service-normalizer');
const { __setCatalogNamesForTest } = require('../services/service-catalog-names');

afterEach(() => __setCatalogNamesForTest([]));

describe('mappedServiceLabel — unmatched free text is never trusted', () => {
  test('internal scheduling labels that name no known service map to null', () => {
    expect(mappedServiceLabel('Owner Custom Booking Label')).toBeNull();
    expect(mappedServiceLabel('Customer Complained Reservice')).toBeNull();
    expect(mappedServiceLabel('Dog In Home Call Before Arrival')).toBeNull();
  });

  test('"Dog In Home Call Before Arrival" stays null even when primed into the catalog cache', () => {
    // The old isRecognizedServiceType trusted any canonicalCatalogName hit,
    // so a hand-edited free-text label entering that cache would leak
    // through. mappedServiceLabel has no catalog branch — priming the cache
    // has no effect on it at all.
    __setCatalogNamesForTest(['Dog In Home Call Before Arrival']);
    expect(mappedServiceLabel('Dog In Home Call Before Arrival')).toBeNull();
    expect(mappedServiceLabel('dog in home call before arrival')).toBeNull();
  });

  test('a foam-token-carrying garbage label is not recognized (no foam passthrough)', () => {
    // The old foam branch matched FOAM_LABEL_RE against the WHOLE string
    // and returned it VERBATIM, so any larger string merely containing a
    // foam token leaked through unmodified. mappedServiceLabel has no such
    // branch: "foam", "drill", "customer", "complained", and "reservice"
    // match no SERVICE_TYPE_MAP entry, so pure noise text is null.
    expect(mappedServiceLabel('Foam Drill Customer Complained Reservice')).toBeNull();
  });

  test('a foam label that also carries a recognized family word still only ever yields that family\'s fixed label, never the raw foam text', () => {
    // "Recurring Termite Foam Service (Quarterly)" used to pass through
    // VERBATIM, cadence and all, under the old foam branch. mappedServiceLabel
    // has no foam branch, so the generic /termite/i family entry is what
    // matches here — the fixed label "Termite Service", never the raw string.
    expect(mappedServiceLabel('Recurring Termite Foam Service (Quarterly)')).toBe('Termite Service');
  });

  test('blank/empty/null input maps to null', () => {
    expect(mappedServiceLabel('')).toBeNull();
    expect(mappedServiceLabel(null)).toBeNull();
    expect(mappedServiceLabel(undefined)).toBeNull();
    expect(mappedServiceLabel('   ')).toBeNull();
  });
});

describe('mappedServiceLabel — SERVICE_TYPE_MAP family matches return the fixed type string', () => {
  test('common prod labels map to their family\'s exact fixed label', () => {
    expect(mappedServiceLabel('Cockroach Treatment')).toBe('Cockroach Treatment Service');
    // "Quarterly" appears BEFORE "Pest Control" here, so the
    // pest-control-then-quarterly entry (which needs that word order) does
    // not match; it falls through to the more general "pest control…service"
    // entry instead.
    expect(mappedServiceLabel('Quarterly Pest Control Service')).toBe('Pest Control Service');
    expect(mappedServiceLabel('Monthly Pest Control Service')).toBe('Pest Control Service');
    expect(mappedServiceLabel('Monthly Pest Control')).toBe('Pest Control');
    expect(mappedServiceLabel('WDO Inspection Service')).toBe('WDO Inspection');
    // Here "Pest Control" comes before "(Quarterly)", so the
    // pest-control-then-quarterly entry — checked first in the map — does
    // match, and wins over the more general "pest control" entry below it.
    expect(mappedServiceLabel('General Pest Control (Quarterly)')).toBe('Quarterly Pest Control');
  });

  test('a price/duration suffix is stripped before matching, and does not block recognition', () => {
    // stripServiceSuffixes removes " - 1 hour" and " - $117" first, so the
    // match runs against "Pest Control Service".
    expect(mappedServiceLabel('Pest Control Service - 1 hour - $117')).toBe('Pest Control Service');
  });

  test('a family match on a brand-carrying label still returns that family\'s type string — brand exclusion is grounding.js\'s later, separate concern', () => {
    // mappedServiceLabel has no brand filtering; SERVICE_TYPE_MAP itself
    // emits a brand name for these two. grounding.js's
    // SERVICE_PRODUCT_WORD_RE backstop is what turns them into null for
    // display, not this function.
    expect(mappedServiceLabel('Bora-Care Wood Treatment Service')).toBe('Bora-Care Wood Treatment Service');
    expect(mappedServiceLabel('Arborjet Treatment')).toBe('Arborjet Treatment');
  });
});

describe('mappedServiceLabel — no catalog branch at all', () => {
  test('a real catalog identity with no SERVICE_TYPE_MAP family still maps to null, primed or not', () => {
    expect(mappedServiceLabel('Rodent Trapping Service')).toBeNull();
    __setCatalogNamesForTest(['Rodent Trapping Service']);
    expect(mappedServiceLabel('Rodent Trapping Service')).toBeNull();
  });
});

describe('tree & shrub labels keep their family (2026-09-24 round-6 P1)', () => {
  test.each([
    ['Tree & Shrub Fertilization', 'Tree & Shrub Care'],
    ['Tree & Shrub Weed & Feed', 'Tree & Shrub Care'],
    ['Palm Fertilization', 'Tree & Shrub Care'],
    ['Palm Injection', 'Palm Injection'],
    ['Arborjet Tree Injection', 'Arborjet Treatment'],
  ])('%s → %s, never a lawn service', (raw, expected) => {
    expect(mappedServiceLabel(raw)).toBe(expected);
  });
  test('lawn fertilization itself is unchanged', () => {
    expect(mappedServiceLabel('Lawn Fertilization')).toBe('Lawn Fertilization');
    expect(mappedServiceLabel('Fertilization - 1 hour - $85')).toBe('Lawn Fertilization');
  });
});

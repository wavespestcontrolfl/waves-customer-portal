const { deriveStatus, buildAddressLines, STATUSES } = require('../services/address-validation');

describe('buildAddressLines', () => {
  test('street + city/state/zip → two lines', () => {
    expect(buildAddressLines({ street_line_1: '17451 State Road 62', city: 'Parrish', state: 'FL', postal_code: '34219' }))
      .toEqual(['17451 State Road 62', 'Parrish FL 34219']);
  });
  test('includes street_line_2 on line 1', () => {
    expect(buildAddressLines({ street_line_1: '100 Main St', street_line_2: 'Apt 4', city: 'Bradenton', state: 'FL' }))
      .toEqual(['100 Main St Apt 4', 'Bradenton FL']);
  });
  test('city only (no street) still validates (locality-level)', () => {
    expect(buildAddressLines({ city: 'Sarasota', state: 'FL' })).toEqual(['Sarasota FL']);
  });
  test('nothing usable → [] (validateAddress will no-op to not_attempted)', () => {
    expect(buildAddressLines({ street_line_1: null, city: null, postal_code: null })).toEqual([]);
    expect(buildAddressLines(null)).toEqual([]);
    expect(buildAddressLines({ postal_code: '34219' })).toEqual([]); // zip alone isn't worth an API call
  });
});

// Minimal Google AV `result` shapes for the pure status mapper.
function result({ complete = true, granularity = 'PREMISE', inferred = false, replaced = false, unconfirmed = false, missing = undefined } = {}) {
  return {
    verdict: {
      addressComplete: complete,
      validationGranularity: granularity,
      hasInferredComponents: inferred,
      hasReplacedComponents: replaced,
      hasUnconfirmedComponents: unconfirmed,
    },
    address: {
      ...(missing ? { missingComponentTypes: missing } : {}),
      addressComponents: [
        { componentType: 'street_number', componentName: { text: '17451' } },
        { componentType: 'route', componentName: { text: 'Florida 62' } },
        { componentType: 'locality', componentName: { text: 'Parrish' } },
        { componentType: 'administrative_area_level_1', componentName: { text: 'FL' } },
        { componentType: 'postal_code', componentName: { text: '34219' } },
      ],
    },
  };
}

describe('deriveStatus (Google AV → provider-neutral status)', () => {
  test('clean in-area premise → validated_accept', () => {
    const r = deriveStatus(result(), 'Manatee County');
    expect(r.status).toBe(STATUSES.VALIDATED_ACCEPT);
    expect(r.inServiceArea).toBe(true);
    expect(r.normalized.postal_code).toBe('34219');
  });

  test('inferred-only (benign normalization / missing zip filled) in-area → validated_accept', () => {
    // Google sets hasInferred on nearly every clean address (expands abbreviations,
    // fills a missing zip). That is NOT a correction — it stays validated_accept.
    expect(deriveStatus(result({ inferred: true }), 'Sarasota County').status).toBe(STATUSES.VALIDATED_ACCEPT);
  });

  test('replaced material (bad zip rewritten) in-area → corrected (trust the correction)', () => {
    const r = deriveStatus(result({ replaced: true }), 'Manatee County');
    expect(r.status).toBe(STATUSES.CORRECTED);
  });

  test('unconfirmed material → confirm_needed (genuinely unverified, never auto-route)', () => {
    expect(deriveStatus(result({ unconfirmed: true }), 'Charlotte County').status).toBe(STATUSES.CONFIRM_NEEDED);
  });

  test('replaced AND unconfirmed → confirm_needed (uncertainty dominates a correction)', () => {
    expect(deriveStatus(result({ replaced: true, unconfirmed: true }), 'Manatee County').status).toBe(STATUSES.CONFIRM_NEEDED);
  });

  test('in-area unknown county (null) → confirm_needed, never accept', () => {
    expect(deriveStatus(result(), null).status).toBe(STATUSES.CONFIRM_NEEDED);
  });

  test('complete premise but out-of-area county → out_of_service_area', () => {
    const r = deriveStatus(result(), 'Fulton County');
    expect(r.status).toBe(STATUSES.OUT_OF_SERVICE_AREA);
    expect(r.inServiceArea).toBe(false);
  });

  test('not premise-level (ROUTE) → missing_component', () => {
    expect(deriveStatus(result({ granularity: 'ROUTE' }), 'Manatee County').status).toBe(STATUSES.MISSING_COMPONENT);
  });

  test('premise-level but flagged incomplete → ambiguous', () => {
    expect(deriveStatus(result({ complete: false, granularity: 'PREMISE' }), 'Manatee County').status).toBe(STATUSES.AMBIGUOUS);
  });

  test('incomplete / garbage geocoded out-of-area → missing_component, not out_of_service_area', () => {
    const r = deriveStatus(result({ complete: false, granularity: 'OTHER' }), 'Gunnison County');
    expect(r.status).toBe(STATUSES.MISSING_COMPONENT);
  });

  test('missingComponentTypes surfaces as missingComponents (condo building without a unit)', () => {
    const r = deriveStatus(result({ complete: false, granularity: 'PREMISE', missing: ['subpremise'] }), 'Manatee County');
    expect(r.status).toBe(STATUSES.AMBIGUOUS);
    expect(r.missingComponents).toEqual(['subpremise']);
  });

  test('no missingComponentTypes in the provider payload → missingComponents []', () => {
    expect(deriveStatus(result(), 'Manatee County').missingComponents).toEqual([]);
  });

  test('county normalization handles "X County" and case', () => {
    expect(deriveStatus(result(), 'manatee').status).toBe(STATUSES.VALIDATED_ACCEPT);
    expect(deriveStatus(result(), 'DESOTO COUNTY').status).toBe(STATUSES.VALIDATED_ACCEPT);
  });
});

describe('buildAddressLines — spoken raw_text with conversational state-code words', () => {
  // Synthetic transcripts in the extractor's shape. A spoken tail like
  // "so, or it could be Ellenton" used to read as Oregon, the lines went
  // to Google as "Palmetto OR 34221", and the non-Florida override marked
  // a served Manatee County address out_of_service_area.
  test('"or" in the spoken tail does not become Oregon', () => {
    expect(buildAddressLines({
      street_line_1: '1200 Harbor Ln', city: 'Palmetto', state: 'FL', postal_code: '34221',
      raw_text: "1200 Harbor Lane. It's Palmetto, so, or it could be Ellenton, but it's 34221",
    })).toEqual(['1200 Harbor Ln', 'Palmetto FL 34221']);
  });
  test('"in" in the spoken tail does not become Indiana', () => {
    expect(buildAddressLines({
      street_line_1: '300 Seaglass Cir', city: 'Ellenton', state: 'FL', postal_code: '34222',
      raw_text: "300 Seaglass, that's one word, S-E-A-G-L-A-S-S Circle. That's in Ellenton, 34222.",
    })).toEqual(['300 Seaglass Cir', 'Ellenton FL 34222']);
  });
  test('an abbreviated other state followed by trailing speech still overrides the FL default (codex r1 P1)', () => {
    expect(buildAddressLines({
      street_line_1: '123 Main St', city: 'Venice', state: null,
      raw_text: "123 Main Street, Venice, CA, but I don't know the ZIP",
    })).toEqual(['123 Main St', 'Venice CA']);
    expect(buildAddressLines({
      street_line_1: '123 Main St', city: 'Venice', state: null,
      raw_text: "123 Main Street, Venice, CA; but I don't know the ZIP",
    })).toEqual(['123 Main St', 'Venice CA']);
  });
  test('an abbreviated other state before a trailing country still overrides the FL default (codex r3 P1)', () => {
    expect(buildAddressLines({
      street_line_1: '123 Main St', city: 'Portland', state: null,
      raw_text: '123 Main Street, Portland, OR United States',
    })).toEqual(['123 Main St', 'Portland OR']);
  });
  test('an explicit other state in raw_text still overrides the FL default', () => {
    expect(buildAddressLines({
      street_line_1: '123 Main St', city: 'Louisville', state: null,
      raw_text: '123 Main Street, Louisville, Kentucky',
    })).toEqual(['123 Main St', 'Louisville KY']);
    expect(buildAddressLines({
      street_line_1: '123 Main St', city: 'Portland', state: null, postal_code: '97201',
      raw_text: '123 Main Street, Portland, OR 97201',
    })).toEqual(['123 Main St', 'Portland OR 97201']);
  });
});

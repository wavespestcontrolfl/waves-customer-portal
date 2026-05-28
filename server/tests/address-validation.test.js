const { deriveStatus, STATUSES } = require('../services/address-validation');

// Minimal Google AV `result` shapes for the pure status mapper.
function result({ complete = true, granularity = 'PREMISE', inferred = false, replaced = false, unconfirmed = false } = {}) {
  return {
    verdict: {
      addressComplete: complete,
      validationGranularity: granularity,
      hasInferredComponents: inferred,
      hasReplacedComponents: replaced,
      hasUnconfirmedComponents: unconfirmed,
    },
    address: {
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

  test('inferred-only (e.g. missing zip filled) in-area → validated_accept', () => {
    expect(deriveStatus(result({ inferred: true }), 'Sarasota County').status).toBe(STATUSES.VALIDATED_ACCEPT);
  });

  test('replaced material (bad zip rewritten) → confirm_needed', () => {
    const r = deriveStatus(result({ replaced: true }), 'Manatee County');
    expect(r.status).toBe(STATUSES.CONFIRM_NEEDED);
  });

  test('unconfirmed material → confirm_needed', () => {
    expect(deriveStatus(result({ unconfirmed: true }), 'Charlotte County').status).toBe(STATUSES.CONFIRM_NEEDED);
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

  test('county normalization handles "X County" and case', () => {
    expect(deriveStatus(result(), 'manatee').status).toBe(STATUSES.VALIDATED_ACCEPT);
    expect(deriveStatus(result(), 'DESOTO COUNTY').status).toBe(STATUSES.VALIDATED_ACCEPT);
  });
});

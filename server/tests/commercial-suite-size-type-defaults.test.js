const { defaultSuiteSqftFor, SUITE_TYPE_DEFAULT_SQFT } = require('../services/commercial-suite-size/type-defaults');

describe('defaultSuiteSqftFor', () => {
  test('restaurant/food -> 1800', () => {
    expect(defaultSuiteSqftFor({ commercialRiskType: 'restaurant_food' })).toBe(1800);
    expect(defaultSuiteSqftFor({ commercialSubtype: 'restaurant_food_service' })).toBe(1800);
  });

  test('salon/personal service -> 1200', () => {
    expect(defaultSuiteSqftFor({ commercialRiskType: 'personal_service' })).toBe(1200);
  });

  test('medical/healthcare -> 2500', () => {
    expect(defaultSuiteSqftFor({ commercialRiskType: 'healthcare_childcare' })).toBe(2500);
  });

  test('retail/office and the catch-all both resolve to 1500', () => {
    expect(defaultSuiteSqftFor({ commercialRiskType: 'retail_standard' })).toBe(SUITE_TYPE_DEFAULT_SQFT.retailOffice);
    expect(defaultSuiteSqftFor({ commercialRiskType: 'office_low' })).toBe(1500);
    expect(defaultSuiteSqftFor({})).toBe(1500);
  });

  // A model-reported businessType must NEVER pick the default (AGENTS.md: an
  // LLM proposes intent, never a price/size field) — the param was removed
  // entirely from the function's signature, not merely deprioritized. A
  // stray businessType key on the input object is silently ignored, never
  // read.
  test('a businessType field on the input is ignored entirely — only commercialRiskType/commercialSubtype key the default', () => {
    expect(defaultSuiteSqftFor({ businessType: 'restaurant' })).toBe(1500);
    expect(defaultSuiteSqftFor({ businessType: 'medical office' })).toBe(1500);
    expect(defaultSuiteSqftFor({ businessType: 'hair salon', commercialRiskType: 'restaurant_food' })).toBe(1800);
  });
});

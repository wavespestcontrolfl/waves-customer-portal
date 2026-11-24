// The lookup's rule for the answer of its model on the use of a property
// (services/property-lookup/commercial-ai-signal.js). Two readers ask it: the
// lookup route, for the category it saves, and the plan-start proof, of an
// answer a payload kept. A change of the rule changes both, so its behavior
// is fixed here, word by word.
const { hasStructuredCommercialAiSignal } = require('../services/property-lookup/commercial-ai-signal');

describe("the lookup's rule for its model's answer on the use of a property", () => {
  test.each([
    ['COMMERCIAL', true], ['MIXED', true], [' mixed ', true], ['commercial', true],
    ['RESIDENTIAL', false], ['UNKNOWN', false], ['', false], [null, false], [undefined, false],
  ])('the use %j, with no use type: a business %j', (propertyUse, expected) => {
    expect(hasStructuredCommercialAiSignal({ propertyUse })).toBe(expected);
  });

  // The use type counts beside a use that is no business. Every word of the model's enum, and the words for "no".
  test.each([
    ['OFFICE_RETAIL', true], ['WAREHOUSE_LIGHT', true], ['RESTAURANT_FOOD_SERVICE', true], ['MEDICAL_OFFICE', true], ['INDUSTRIAL', true],
    ['SCHOOL_DAYCARE', true], ['GOVERNMENT_MUNICIPAL', true], ['HOA_COMMON_AREA', true], ['MULTIFAMILY_COMMON_AREA', true], ['OTHER', true],
    [' office_retail ', true], ['other', true],
    ['NONE', false], ['UNKNOWN', false], ['RESIDENTIAL', false], ['NO', false], ['FALSE', false], ['N/A', false], ['NA', false],
    // The pricing engine normalizes these two to commercial (they hold the word): the list of words for "no" is what keeps them out.
    ['NOT_COMMERCIAL', false], ['NON_COMMERCIAL', false], [' not_commercial ', false],
    ['SINGLE_FAMILY', false], ['CONDO', false], ['YES', false], ['', false], [null, false], [undefined, false],
  ])('the use type %j, beside a residential use: a business %j', (commercialUseType, expected) => {
    expect(hasStructuredCommercialAiSignal({ propertyUse: 'RESIDENTIAL', commercialUseType })).toBe(expected);
    expect(hasStructuredCommercialAiSignal({ commercialUseType })).toBe(expected);
  });

  test('a business use wins over a use type that says no', () => {
    expect(hasStructuredCommercialAiSignal({ propertyUse: 'MIXED', commercialUseType: 'NONE' })).toBe(true);
    expect(hasStructuredCommercialAiSignal({ propertyUse: 'COMMERCIAL', commercialUseType: 'NOT_COMMERCIAL' })).toBe(true);
  });

  test.each([[undefined], [null], [{}], ['COMMERCIAL'], [7]])('no answer of the model (%j) is no business, and never a throw', (answer) => {
    expect(hasStructuredCommercialAiSignal(answer)).toBe(false);
  });
});

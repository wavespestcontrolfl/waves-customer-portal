const { isSmsMobileLineType } = require('../services/messaging/compliance-contact-checks');

describe('SMS contact compliance checks', () => {
  test.each([
    [null, true],
    ['', true],
    ['mobile', true],
    ['Mobile', true],
    ['wireless', true],
    ['WIRELESS', true],
    ['fixed_wireless', false],
    ['landline', false],
    ['voip', false],
  ])('classifies line type %s', (lineType, expected) => {
    expect(isSmsMobileLineType(lineType)).toBe(expected);
  });
});

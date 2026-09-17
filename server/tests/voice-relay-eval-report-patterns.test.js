const { SPOKEN_CHECK_VALUE_RULES: rules } = require('../services/eval/voice-relay-spoken-checks');
const validate = rules.report_readback_confirms();

test.each([
  '(?=Talstar(?: P))',
  '(?!(Talstar P))',
  '(?<=exterior(?: perimeter))',
  '(?<!(exterior perimeter))',
  '(?:(?=Talstar(?: P))|(?<=perimeter))',
  '(?=Talstar[()] P)',
  '(?=Talstar\\( P\\))',
  '(?:(?=Talstar(?: P)))?',
  '(?:(?=Talstar(?: P))){0,2}',
])('nested assertion-only report patterns are rejected in either field: %s', (pattern) => {
  expect(validate({ subject: pattern, location: 'perimeter' })).not.toBeNull();
  expect(validate({ subject: 'Talstar', location: pattern })).not.toBeNull();
});

test.each([
  '(?=Talstar(?: P))Talstar P',
  'Talstar(?= P(?: applied))',
  '(?:(?=Talstar(?: P))|Talstar P)',
  '(Talstar P)?',
  '[(?=)]',
  '\\(\\?=Talstar\\)',
  '(?=(Talstar P))\\1',
])('consuming report patterns remain valid: %s', (pattern) => {
  expect(validate({ subject: pattern, location: 'perimeter' })).toBeNull();
  expect(validate({ subject: 'Talstar', location: pattern })).toBeNull();
});

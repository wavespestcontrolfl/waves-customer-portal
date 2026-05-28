jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));

const { __private } = require('../routes/admin-triage');
const { sanitizeWrongFields, WRONG_FIELDS, VERDICTS } = __private;

describe('route-feedback wrong_fields sanitization', () => {
  test('keeps only whitelisted field keys', () => {
    expect(sanitizeWrongFields(['name', 'address', 'bogus', 'service'])).toEqual(['name', 'address', 'service']);
  });

  test('dedupes repeated keys', () => {
    expect(sanitizeWrongFields(['name', 'name', 'address'])).toEqual(['name', 'address']);
  });

  test('non-array input → []', () => {
    expect(sanitizeWrongFields(undefined)).toEqual([]);
    expect(sanitizeWrongFields(null)).toEqual([]);
    expect(sanitizeWrongFields('name')).toEqual([]);
    expect(sanitizeWrongFields({ name: true })).toEqual([]);
  });

  test('all-bogus input → []', () => {
    expect(sanitizeWrongFields(['nope', 'huh'])).toEqual([]);
  });

  test('every whitelisted key survives a round-trip', () => {
    expect(sanitizeWrongFields([...WRONG_FIELDS])).toEqual(WRONG_FIELDS);
  });

  test('verdicts whitelist is exactly accept/deny', () => {
    expect(VERDICTS).toEqual(['accept', 'deny']);
  });
});

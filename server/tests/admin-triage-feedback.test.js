jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));

const { __private } = require('../routes/admin-triage');
const { sanitizeWrongFields, denyRejectsUnitEvidence, WRONG_FIELDS, VERDICTS } = __private;

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

describe('denyRejectsUnitEvidence (codex r15 P1 on #3804)', () => {
  test('a whole-call deny (no wrong_fields) rejects the unit evidence', () => {
    expect(denyRejectsUnitEvidence([])).toBe(true);
  });

  test('a deny naming the address rejects it, alone or beside other fields', () => {
    expect(denyRejectsUnitEvidence(['address'])).toBe(true);
    expect(denyRejectsUnitEvidence(['service', 'address'])).toBe(true);
  });

  test('a field-scoped deny that never names the address leaves the customer\'s accepted unit standing', () => {
    for (const field of WRONG_FIELDS.filter((f) => f !== 'address')) expect(denyRejectsUnitEvidence([field])).toBe(false);
    expect(denyRejectsUnitEvidence(['service', 'scheduling'])).toBe(false);
  });
});

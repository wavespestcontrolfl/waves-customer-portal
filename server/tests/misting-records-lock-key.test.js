// Misting records (GATE_MOSQUITO_MISTING): every writer for one customer takes the same advisory lock,
// whatever case the customer uuid arrives in (Postgres reads an uppercase uuid as the same customer).
const { _test: { lockKey } } = require('../services/misting-records');

describe('misting records lock key', () => {
  test('an uppercase customer uuid locks the same key as the lowercase one', () => {
    const lower = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    expect(lockKey(lower.toUpperCase())).toBe(lockKey(lower));
    expect(lockKey(lower)).toBe(`misting-records:${lower}`);
  });
});

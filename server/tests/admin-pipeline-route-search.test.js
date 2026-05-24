jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));

const { __private } = require('../routes/admin-pipeline');

function fakeQuery() {
  const calls = [];
  const scope = {
    whereILike(column, value) {
      calls.push(['whereILike', column, value]);
      return this;
    },
    orWhereILike(column, value) {
      calls.push(['orWhereILike', column, value]);
      return this;
    },
    orWhereRaw(sql, bindings) {
      calls.push(['orWhereRaw', sql, bindings]);
      return this;
    },
  };

  return {
    calls,
    where(fn) {
      fn.call(scope);
      return this;
    },
  };
}

describe('admin pipeline route search prefilter', () => {
  test('lead search includes normalized phone digits and lead/estimate refs', () => {
    const query = fakeQuery();

    __private.applyLeadSearch(query, '5551234567');

    expect(query.calls).toContainEqual(['orWhereRaw', 'leads.id::text ILIKE ?', ['%5551234567%']]);
    expect(query.calls).toContainEqual(['orWhereRaw', 'leads.estimate_id::text ILIKE ?', ['%5551234567%']]);
    expect(query.calls).toContainEqual([
      'orWhereRaw',
      "regexp_replace(COALESCE(leads.phone, ''), '[^0-9]', '', 'g') LIKE ?",
      ['%5551234567%'],
    ]);
  });

  test('estimate search includes normalized phone digits and estimate/customer refs', () => {
    const query = fakeQuery();

    __private.applyEstimateSearch(query, '#abc123');

    expect(query.calls).toContainEqual(['orWhereRaw', 'estimates.id::text ILIKE ?', ['%abc123%']]);
    expect(query.calls).toContainEqual(['orWhereRaw', 'estimates.customer_id::text ILIKE ?', ['%abc123%']]);
    expect(query.calls).not.toContainEqual([
      'orWhereRaw',
      "regexp_replace(COALESCE(estimates.customer_phone, ''), '[^0-9]', '', 'g') LIKE ?",
      ['%123%'],
    ]);
  });

  test('search does not add broad id predicates for empty hash refs', () => {
    const leadQuery = fakeQuery();
    const estimateQuery = fakeQuery();

    __private.applyLeadSearch(leadQuery, '#');
    __private.applyEstimateSearch(estimateQuery, '#');

    expect(leadQuery.calls.some((call) => call[0] === 'orWhereRaw' && call[1].includes('id::text'))).toBe(false);
    expect(estimateQuery.calls.some((call) => call[0] === 'orWhereRaw' && call[1].includes('id::text'))).toBe(false);
  });
});

// codex #5187 follow-up: an admin's active=false on a knowledge_base row hides
// it from search and from the recommendation context. A NULL `active` counts
// as on (IS NOT FALSE), matching the register's planFactSync.
const mockCalls = [];

jest.mock('../models/db', () => {
  const makeQuery = () => {
    const query = {};
    for (const m of ['where', 'whereIn', 'whereNot', 'whereRaw', 'select', 'orderBy', 'limit']) {
      query[m] = jest.fn((...args) => { mockCalls.push([m, ...args]); return query; });
    }
    return query;
  };
  const db = jest.fn(() => makeQuery());
  db.raw = jest.fn((sql) => sql);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { _test: { kbFtsQuery, kbIlikeQuery } } = require('../services/knowledge-bridge');

const filtersActive = () => mockCalls.some(([m, sql]) => m === 'whereRaw' && sql === 'active IS NOT FALSE');

describe('knowledge_base reads skip admin-deactivated rows', () => {
  beforeEach(() => { mockCalls.length = 0; });

  test('full-text search filters active IS NOT FALSE', () => {
    kbFtsQuery('large patch', false, 5);
    expect(filtersActive()).toBe(true);
  });

  test('ILIKE search filters active IS NOT FALSE', () => {
    kbIlikeQuery('%large patch%', false, 5);
    expect(filtersActive()).toBe(true);
  });

  test('the filter is not `active = true` (a NULL row stays visible)', () => {
    kbFtsQuery('large patch', true, 5);
    expect(mockCalls.some(([m, arg]) => m === 'where' && arg && arg.active === true)).toBe(false);
  });
});

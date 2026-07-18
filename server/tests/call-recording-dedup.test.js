// Regression: a call whose AI-extracted name is wrong (e.g. the technician's
// name) must NOT spawn a duplicate customer when the phone already maps to one.
// Fixtures are fictitious; phone is a reserved 555-01xx test number.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const CallRecordingProcessor = require('../services/call-recording-processor');
const { findCustomerForCallContact } = CallRecordingProcessor._test;

// Minimal thenable knex-builder mock: chain methods return `this`, awaiting the
// builder resolves to the next queued result array (in call order).
function mockDbWithResults(resultArrays) {
  const queue = [...resultArrays];
  db.mockImplementation(() => {
    const builder = {
      where: () => builder,
      whereNull: () => builder,
      whereRaw: () => builder,
      orderBy: () => builder,
      orderByRaw: () => builder,
      limit: () => builder,
      count: () => builder,
      first: () => Promise.resolve(null),
      then: (resolve, reject) => Promise.resolve(queue.shift() ?? []).then(resolve, reject),
    };
    return builder;
  });
}

const PHONE = '+15555550123'; // reserved fictitious test number
const KEEPER = { id: 'cust-keeper', first_name: 'Jordan', last_name: 'Rivers', phone: PHONE };
const WRONG_NAME = { first_name: 'Sam' }; // AI mis-extracted (e.g. the tech's name)

describe('findCustomerForCallContact phone fallback', () => {
  beforeEach(() => jest.clearAllMocks());

  test('wrong extracted name falls back to the single phone match (no duplicate)', async () => {
    // named query (phone + first_name="sam") → no match; phone-only → one match.
    mockDbWithResults([[], [KEEPER]]);
    const result = await findCustomerForCallContact(PHONE, WRONG_NAME);
    expect(result).toBe(KEEPER);
  });

  test('exact name match still wins', async () => {
    mockDbWithResults([[KEEPER]]);
    const result = await findCustomerForCallContact(PHONE, { first_name: 'Jordan', last_name: 'Rivers' });
    expect(result).toBe(KEEPER);
  });

  test('does NOT auto-link when 2+ customers share the phone and no name matches', async () => {
    const other = { id: 'cust-other', first_name: 'Alex', phone: PHONE };
    mockDbWithResults([[], [KEEPER, other]]); // named → none; phone-only → two
    const result = await findCustomerForCallContact(PHONE, WRONG_NAME);
    expect(result).toBeNull();
  });

  test('no extracted name uses phone-only single match (unchanged behavior)', async () => {
    mockDbWithResults([[KEEPER]]);
    const result = await findCustomerForCallContact(PHONE, {});
    expect(result).toBe(KEEPER);
  });
});

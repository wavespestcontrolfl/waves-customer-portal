// Regression: a call whose AI-extracted name is wrong (e.g. the technician's
// name) must NOT spawn a duplicate customer when the phone already maps to one.
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
      first: () => Promise.resolve(null),
      then: (resolve, reject) => Promise.resolve(queue.shift() ?? []).then(resolve, reject),
    };
    return builder;
  });
}

const robert = { id: 'robert-1', first_name: 'Robert', last_name: 'Lammon', phone: '+18475258420' };

describe('findCustomerForCallContact phone fallback', () => {
  beforeEach(() => jest.clearAllMocks());

  test('wrong extracted name falls back to the single phone match (no duplicate)', async () => {
    // named query (phone + first_name="adam") → no match; phone-only → one match.
    mockDbWithResults([[], [robert]]);
    const result = await findCustomerForCallContact('+18475258420', { first_name: 'Adam' });
    expect(result).toBe(robert);
  });

  test('exact name match still wins', async () => {
    mockDbWithResults([[robert]]);
    const result = await findCustomerForCallContact('+18475258420', { first_name: 'Robert', last_name: 'Lammon' });
    expect(result).toBe(robert);
  });

  test('does NOT auto-link when 2+ customers share the phone and no name matches', async () => {
    const other = { id: 'other-1', first_name: 'Carla', phone: '+18475258420' };
    mockDbWithResults([[], [robert, other]]); // named → none; phone-only → two
    const result = await findCustomerForCallContact('+18475258420', { first_name: 'Adam' });
    expect(result).toBeNull();
  });

  test('no extracted name uses phone-only single match (unchanged behavior)', async () => {
    mockDbWithResults([[robert]]);
    const result = await findCustomerForCallContact('+18475258420', {});
    expect(result).toBe(robert);
  });
});

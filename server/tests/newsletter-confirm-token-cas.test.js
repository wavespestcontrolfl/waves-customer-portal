/**
 * confirmByToken's activation flip is an atomic CAS on the confirmation
 * token AND the pending status (Codex #3084 r41): an email correction can
 * rotate a subscriber's tokens between the confirm handler's lookup and
 * its write — the old link was DELIVERED to a rejected/typo mailbox, and
 * an id-only update would let that stale link activate the freshly
 * retargeted row (a third party confirming an address that isn't theirs).
 */

let mockFirstQueue = [];
let mockUpdateQueue = [];
let mockNsUpdates = [];
let mockRawCalls = [];

jest.mock('../models/db', () => {
  const handler = (table) => {
    const wheres = [];
    const chain = {
      where: jest.fn((arg) => { wheres.push(arg); return chain; }),
      whereNull: jest.fn(() => chain),
      whereRaw: jest.fn(() => chain),
      first: jest.fn(async () => mockFirstQueue.shift() ?? null),
      update: jest.fn(async (patch) => {
        mockNsUpdates.push({ table, wheres: [...wheres], patch });
        return mockUpdateQueue.length ? mockUpdateQueue.shift() : 1;
      }),
    };
    return chain;
  };
  const db = jest.fn(handler);
  db.raw = jest.fn(async (...a) => { mockRawCalls.push(a); return { rowCount: 0 }; });
  return db;
});

const { confirmByToken } = require('../services/newsletter-subscribers');

const PENDING_ROW = {
  id: 41,
  email: 'samtypo@example.com',
  status: 'pending',
  confirmation_token: 'tok-old',
  confirmation_sent_at: new Date(),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFirstQueue = [];
  mockUpdateQueue = [];
  mockNsUpdates = [];
  mockRawCalls = [];
});

test('the activation flip CASes on token AND pending status, not id alone', async () => {
  mockFirstQueue = [
    { ...PENDING_ROW },            // lookupByToken
    { ...PENDING_ROW, status: 'active' }, // post-flip reread
  ];
  const result = await confirmByToken('tok-old');
  expect(result.action).toBe('confirmed');
  const flip = mockNsUpdates.find((u) => u.patch.status === 'active');
  expect(flip.wheres).toContainEqual({ id: 41, confirmation_token: 'tok-old', status: 'pending' });
});

test('a token rotated between lookup and flip never activates the row', async () => {
  // The correction's rotation committed after our lookup: the CAS matches
  // zero rows, the re-lookup sees the token matching nothing, and the
  // stale link neither activates nor links the row.
  mockFirstQueue = [
    { ...PENDING_ROW }, // lookupByToken saw the pre-rotation row
    null,               // re-lookup: the rotated row no longer carries tok-old
  ];
  mockUpdateQueue = [0]; // the CAS missed
  const result = await confirmByToken('tok-old');
  expect(result.action).toBe('not_found');
  expect(mockRawCalls).toHaveLength(0); // linkToCustomer never ran
});

test('a concurrent same-token confirm reads back already_active instead of double-flipping', async () => {
  mockFirstQueue = [
    { ...PENDING_ROW },
    { ...PENDING_ROW, status: 'active' }, // the sibling confirm won the CAS
  ];
  mockUpdateQueue = [0];
  const result = await confirmByToken('tok-old');
  expect(result.action).toBe('already_active');
  expect(mockRawCalls).toHaveLength(0);
});

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
// One shared timeline (raw calls AND updates) so a test can prove ORDER —
// the lock must precede the write it fences — not just that both happened.
let mockEvents = [];

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
        mockEvents.push({ type: 'update', table, wheres: [...wheres], patch });
        return mockUpdateQueue.length ? mockUpdateQueue.shift() : 1;
      }),
    };
    return chain;
  };
  const db = jest.fn(handler);
  db.raw = jest.fn(async (...a) => {
    mockRawCalls.push(a);
    mockEvents.push({ type: 'raw', sql: a[0], bindings: a[1] });
    return { rowCount: 0 };
  });
  // confirmByToken now opens a transaction to take the per-mailbox lock
  // (codex #5165 P1) before its write — `trx` is the same mocked `db`,
  // matching the convention other suites use for this mock shape.
  db.transaction = jest.fn(async (fn) => fn(db));
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
  mockEvents = [];
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

// Codex #5165 P1 (:393): confirmByToken must take the SAME per-mailbox lock
// subscribeOrResubscribe and the reconcile take, on the subscriber's OWN
// address, BEFORE the CAS write — otherwise a signup/unsubscribe for a
// differently-spelled alias of the same mailbox could commit in the gap
// between this function's lookup and its write.
test('the per-mailbox lock is taken on the subscriber\'s address before the CAS write', async () => {
  mockFirstQueue = [
    { ...PENDING_ROW },
    { ...PENDING_ROW, status: 'active' },
  ];
  await confirmByToken('tok-old');
  const lockIndex = mockEvents.findIndex((e) => e.type === 'raw' && String(e.sql).includes('pg_advisory_xact_lock'));
  const flipIndex = mockEvents.findIndex((e) => e.type === 'update' && e.patch.status === 'active');
  expect(lockIndex).toBeGreaterThanOrEqual(0);
  expect(flipIndex).toBeGreaterThanOrEqual(0);
  // customerEmailLockKeys' exact-address key for this subscriber.
  expect(mockEvents[lockIndex].bindings?.[0]).toBe(`customer-email:${PENDING_ROW.email}`);
  // One shared timeline — the lock genuinely precedes the write it fences.
  expect(lockIndex).toBeLessThan(flipIndex);
});

// linkToCustomer's own raw call is its UPDATE ... FROM (twin subselect) —
// distinct SQL from the per-mailbox lock (codex #5165 P1) confirmByToken now
// always takes before its write, whether or not the CAS lands.
const nonLockRawCalls = () => mockRawCalls.filter(([sql]) => !String(sql).includes('pg_advisory_xact_lock'));

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
  expect(nonLockRawCalls()).toHaveLength(0); // linkToCustomer never ran
});

test('a concurrent same-token confirm reads back already_active instead of double-flipping', async () => {
  mockFirstQueue = [
    { ...PENDING_ROW },
    { ...PENDING_ROW, status: 'active' }, // the sibling confirm won the CAS
  ];
  mockUpdateQueue = [0];
  const result = await confirmByToken('tok-old');
  expect(result.action).toBe('already_active');
  expect(nonLockRawCalls()).toHaveLength(0);
});

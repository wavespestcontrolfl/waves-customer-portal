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
      // One argument is kept as it is; a (column, operator, value) call is kept as that list.
      where: jest.fn((...args) => { wheres.push(args.length === 1 ? args[0] : args); return chain; }),
      whereNull: jest.fn(() => chain),
      whereRaw: jest.fn((sql) => { wheres.push(sql); return chain; }),
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

// The raw queries that ran: every db.raw call but the 'LOWER(email)' fragment, which is a value in the
// flip's UPDATE payload (the reader-confirmed address), not a query of its own.
const linkCalls = () => mockRawCalls.filter(([sql]) => sql !== 'LOWER(email)');

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
  // The click is also the reader's own proof for this address (reader_confirmed_*), one instant with confirmed_at.
  expect(flip.patch.reader_confirmed_at).toBe(flip.patch.confirmed_at);
  // The address is taken in SQL from the row the UPDATE flips (LOWER(email)): no address is bound into the
  // query, so a failed update's message (knex puts bound values in it) cannot carry one.
  expect(mockRawCalls).toContainEqual(['LOWER(email)']);
  expect(Object.values(flip.patch)).not.toContain('samtypo@example.com');
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
  expect(linkCalls()).toHaveLength(0); // linkToCustomer never ran
});

test('a concurrent same-token confirm reads back already_active instead of double-flipping', async () => {
  mockFirstQueue = [
    { ...PENDING_ROW },
    { ...PENDING_ROW, status: 'active' }, // the sibling confirm won the CAS
  ];
  // The flip missed. The proof write for an active row then finds the sibling's stamp
  // (reader_confirmed_at = confirmed_at) and writes nothing.
  mockUpdateQueue = [0, 0];
  const result = await confirmByToken('tok-old');
  expect(result.action).toBe('already_active');
  expect(result.subscriber.status).toBe('active');
  expect(mockNsUpdates).toHaveLength(2);
  expect(mockNsUpdates[1].wheres).toContain('(reader_confirmed_at IS NULL OR reader_confirmed_at < confirmed_at)');
  expect(linkCalls()).toHaveLength(0);
});

// A trusted add can activate a pending row after the confirmation email went out and before the
// reader presses the button. The click must still leave the reader's proof.
describe('a confirm click on a row a trusted add activated first', () => {
  const ACTIVE_ROW = { ...PENDING_ROW, status: 'active', confirmed_at: new Date() };
  const STAMPED = { ...ACTIVE_ROW, reader_confirmed_at: new Date(), reader_confirmed_email: 'samtypo@example.com' };
  const expectProofWrite = (write) => {
    // Only the two proof columns and updated_at: status, confirmed_at and every opt-out stamp stay.
    expect(Object.keys(write.patch).sort()).toEqual(['reader_confirmed_at', 'reader_confirmed_email', 'updated_at']);
    expect(write.patch.reader_confirmed_at).toBeInstanceOf(Date);
    expect(mockRawCalls).toContainEqual(['LOWER(email)']);
    // The row's own unexpired link, with no opt-out, sunset or comeback after it, and no click on record.
    expect(write.wheres).toContainEqual({ id: 41, confirmation_token: 'tok-old', status: 'active' });
    const ttl = write.wheres.find((w) => Array.isArray(w));
    expect(ttl.slice(0, 2)).toEqual(['confirmation_sent_at', '>']);
    expect(Date.now() - ttl[2].getTime()).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000);
    expect(Date.now() - ttl[2].getTime()).toBeLessThan(7 * 24 * 60 * 60 * 1000 + 60 * 1000);
    expect(write.wheres).toEqual(expect.arrayContaining([
      '(unsubscribed_at IS NULL OR confirmation_sent_at > unsubscribed_at)',
      '(deactivated_at IS NULL OR confirmation_sent_at > deactivated_at)',
      '(resubscribed_at IS NULL OR confirmation_sent_at > resubscribed_at)',
      '(reader_confirmed_at IS NULL OR reader_confirmed_at < confirmed_at)',
    ]));
  };

  test('the row is active when the click arrives: the proof is written, the answer stays already_active', async () => {
    mockFirstQueue = [{ ...ACTIVE_ROW }, { ...STAMPED }]; // lookupByToken, then the reread
    const result = await confirmByToken('tok-old');
    expect(result.action).toBe('already_active');
    expect(result.subscriber.reader_confirmed_email).toBe('samtypo@example.com');
    expect(mockNsUpdates).toHaveLength(1);
    expectProofWrite(mockNsUpdates[0]);
    expect(linkCalls()).toHaveLength(0);
  });

  test('the trusted add lands between the lookup and the flip: the flip misses, the proof is written', async () => {
    mockFirstQueue = [{ ...PENDING_ROW }, { ...ACTIVE_ROW }, { ...STAMPED }];
    mockUpdateQueue = [0, 1];
    const result = await confirmByToken('tok-old');
    expect(result.action).toBe('already_active');
    expect(mockNsUpdates).toHaveLength(2);
    expect(mockNsUpdates[0].patch.status).toBe('active'); // the missed flip
    expectProofWrite(mockNsUpdates[1]);
  });

  test('a link the rule refuses (expired, older than an opt-out or comeback, or already used) writes nothing and reads the row as it is', async () => {
    mockFirstQueue = [{ ...ACTIVE_ROW }];
    mockUpdateQueue = [0];
    const result = await confirmByToken('tok-old');
    expect(result).toEqual({ subscriber: ACTIVE_ROW, action: 'already_active' });
    expect(mockFirstQueue).toHaveLength(0);
  });
});

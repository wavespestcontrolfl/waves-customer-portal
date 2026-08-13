// enrollPromoter atomicity (codex #3379 r1 P1): the public report's
// referral tap made concurrent first-enrollments reachable, and the
// unlocked path could split customers.referral_code from the surviving
// promoter's code. Enrollment now runs inside ONE transaction opened by a
// customer-row lock. These tests pin the shape: every enroll read/write
// rides the transaction, the customer read takes the row lock, and the
// second (serialized) caller lands on the already-enrolled path with the
// winner's code instead of minting its own.

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.transaction = jest.fn();
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const engine = require('../services/referral-engine');

// Minimal knex-transaction fake: trx('table') returns a chain; every chain
// records itself so assertions can prove which connection ran the query.
function makeTrx(state) {
  const trx = jest.fn((table) => {
    const chain = {
      table,
      _forUpdate: false,
      _excludesId: false,
      where: jest.fn(function where(...args) {
        // The already-enrolled conflict probe excludes the promoter's own
        // id — the fake must honor that or it reports the row as its own
        // "conflict" and the engine regenerates a code that isn't there.
        if (args[0] === 'id' && args[1] === '!=') chain._excludesId = true;
        return chain;
      }),
      forUpdate: jest.fn(function forUpdate() { chain._forUpdate = true; return chain; }),
      first: jest.fn(async () => {
        if (table === 'customers') {
          state.customerReadLocked = chain._forUpdate;
          return state.customer;
        }
        if (table === 'referral_promoters') return chain._excludesId ? null : (state.promoter || null);
        return null;
      }),
      update: jest.fn(async (values) => {
        state.updates.push({ table, values });
        if (table === 'customers') state.customer = { ...state.customer, ...values };
        return 1;
      }),
      insert: jest.fn((values) => ({
        returning: jest.fn(async () => {
          state.inserts.push({ table, values });
          state.promoter = { id: 'promo-1', ...values };
          return [state.promoter];
        }),
      })),
    };
    state.trxTables.push(table);
    return chain;
  });
  return trx;
}

function primeDb(state) {
  db.transaction.mockImplementation(async (cb) => cb(makeTrx(state)));
  // Bare-connection queries outside the transaction: getSettings reads
  // referral_program_settings; generateUniqueCode collision-checks codes.
  db.mockImplementation((table) => ({
    where: jest.fn().mockReturnThis(),
    first: jest.fn(async () => {
      if (table === 'referral_program_settings') {
        return { id: 1, program_active: true, base_url: 'https://portal.wavespestcontrol.com/r/' };
      }
      return null; // no code collisions
    }),
  }));
}

function freshState(overrides = {}) {
  return {
    customer: { id: 'cust-1', phone: '+15555550100', email: 'x@example.com', first_name: 'Casey', last_name: 'Placeholder', referral_code: null },
    promoter: null,
    updates: [],
    inserts: [],
    trxTables: [],
    customerReadLocked: false,
    ...overrides,
  };
}

beforeEach(() => jest.clearAllMocks());

test('first enrollment runs entirely inside one transaction with the customer row locked', async () => {
  const state = freshState();
  primeDb(state);
  const { promoter, alreadyEnrolled } = await engine.enrollPromoter('cust-1');
  expect(alreadyEnrolled).toBe(false);
  expect(db.transaction).toHaveBeenCalledTimes(1);
  expect(state.customerReadLocked).toBe(true);
  // The code write on customers and the promoter insert are both trx-side.
  expect(state.updates.some((u) => u.table === 'customers' && u.values.referral_code)).toBe(true);
  expect(state.inserts).toHaveLength(1);
  expect(state.inserts[0].values.referral_code).toBe(promoter.referral_code);
  // customers.referral_code and the promoter row carry the SAME code — the
  // divergence the race produced.
  expect(state.customer.referral_code).toBe(promoter.referral_code);
});

test('code collision checks run on the TRANSACTION connection, never the global pool (round-2 P1)', async () => {
  // A trx holding one pool connection while generateUniqueCode queries via
  // the global db needs a SECOND connection per enrollment — concurrent
  // enrollments then starve the pool. The bare-db fake here throws on any
  // referral_promoters read to prove the collision check rides the trx.
  const state = freshState();
  primeDb(state);
  db.mockImplementation((table) => ({
    where: jest.fn().mockReturnThis(),
    first: jest.fn(async () => {
      if (table === 'referral_program_settings') {
        return { id: 1, program_active: true, base_url: 'https://portal.wavespestcontrol.com/r/' };
      }
      throw new Error(`global-pool query during enrollment: ${table}`);
    }),
  }));
  const { promoter } = await engine.enrollPromoter('cust-1');
  expect(promoter.referral_code).toMatch(/^WAVES-/);
});

test('a serialized second caller takes the already-enrolled path with the winner\'s code — no second insert', async () => {
  const state = freshState();
  primeDb(state);
  const first = await engine.enrollPromoter('cust-1');
  // The row lock releases; the second caller now SEES the winner's rows
  // (this is exactly what FOR UPDATE guarantees the loser observes).
  const second = await engine.enrollPromoter('cust-1');
  expect(second.alreadyEnrolled).toBe(true);
  expect(second.promoter.referral_code).toBe(first.promoter.referral_code);
  expect(state.inserts).toHaveLength(1);
});

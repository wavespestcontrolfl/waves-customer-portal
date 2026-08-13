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
      _phoneScope: null,
      _accountScope: null,
      join: jest.fn().mockReturnThis(),
      _where: null,
      where: jest.fn(function where(...args) {
        // The already-enrolled conflict probe excludes the promoter's own
        // id — the fake must honor that or it reports the row as its own
        // "conflict" and the engine regenerates a code that isn't there.
        if (args[0] === 'id' && args[1] === '!=') chain._excludesId = true;
        else if (args[0] === 'rp.customer_phone') chain._phoneScope = args[1];
        else if (args[0] === 'c.account_id') chain._accountScope = args[1];
        else if (args.length === 1 && args[0] && typeof args[0] === 'object') chain._where = args[0];
        return chain;
      }),
      forUpdate: jest.fn(function forUpdate() { chain._forUpdate = true; return chain; }),
      first: jest.fn(async () => {
        if (table === 'customers') {
          state.customerReadLocked = chain._forUpdate;
          return state.customer;
        }
        if (table === 'referral_promoters' || table === 'referral_promoters as rp') {
          if (chain._excludesId) return null;
          // Honor whichever key the engine queried by: profile id first,
          // then the account-scoped shared-phone join (multi-property
          // fallback). The fake enforces the account boundary: a phone
          // match WITHOUT the matching account resolves nothing.
          if (chain._phoneScope) {
            state.phoneFallbacks.push({ phone: chain._phoneScope, account: chain._accountScope, locked: chain._forUpdate });
            const p = state.promoter;
            if (!p || p.customer_phone !== chain._phoneScope) return null;
            return (state.promoterAccountId && state.promoterAccountId === chain._accountScope) ? p : null;
          }
          const wanted = chain._where || {};
          if (wanted.customer_id) {
            // Record the lock on every by-id lookup, hit or miss — the
            // engine must take it BEFORE knowing whether the row exists.
            state.ownLookupLocked = chain._forUpdate;
            if (state.promoter && state.promoter.customer_id === wanted.customer_id) {
              return state.promoter;
            }
            return null;
          }
          return state.promoter || null;
        }
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
    customer: { id: 'cust-1', account_id: 'acct-1', phone: '+15555550100', email: 'x@example.com', first_name: 'Casey', last_name: 'Placeholder', referral_code: null },
    promoter: null,
    updates: [],
    inserts: [],
    trxTables: [],
    customerReadLocked: false,
    ownLookupLocked: false,
    phoneFallbacks: [],
    promoterAccountId: null,
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

test('a sibling profile sharing the phone reuses the household promoter — no insert, no 503 (r2 P2)', async () => {
  const state = freshState();
  primeDb(state);
  const first = await engine.enrollPromoter('cust-1');
  // Second property profile: different customer_id, same phone.
  state.promoterAccountId = 'acct-1';
  state.customer = { id: 'cust-2', account_id: 'acct-1', phone: '+15555550100', email: 'x@example.com', first_name: 'Casey', last_name: 'Placeholder', referral_code: null };
  const sibling = await engine.enrollPromoter('cust-2');
  expect(sibling.alreadyEnrolled).toBe(true);
  expect(sibling.promoter.referral_code).toBe(first.promoter.referral_code);
  expect(state.inserts).toHaveLength(1);
  // The sibling's own customer row stays CODELESS (pre-push r3 P1):
  // customers.referral_code is UNIQUE and the winning profile's row
  // already holds this code — copying it would 23505 forever.
  expect(state.customer.referral_code).toBeNull();
  expect(state.updates.filter((u) => u.table === 'customers')).toHaveLength(1); // the winner's write only
});

test('a sibling losing the insert race retries once and lands on the winner (23505)', async () => {
  const state = freshState();
  primeDb(state);
  // First attempt: lookups miss (the winner commits between this caller's
  // lookups and its insert) and the insert hits the unique phone constraint.
  let raced = false;
  const trxRacing = makeTrx(state);
  const trxAfter = makeTrx(state);
  db.transaction.mockImplementation(async (cb) => {
    if (!raced) {
      raced = true;
      // Simulate the winner's committed row appearing only AFTER this
      // attempt's lookups: hide it during the callback, then fail the insert.
      state.promoterAccountId = 'acct-1';
      const winner = { id: 'promo-w', customer_id: 'cust-0', customer_phone: '+15555550100', referral_code: 'WAVES-WINNER01', referral_link: 'https://portal.wavespestcontrol.com/r/WAVES-WINNER01' };
      const hidden = { ...state, promoter: null };
      const trx = makeTrx(hidden);
      const result = cb(new Proxy(trx, {
        apply(target, thisArg, args) {
          const chain = Reflect.apply(target, thisArg, args);
          if (args[0] === 'referral_promoters') {
            chain.insert = jest.fn(() => ({
              returning: jest.fn(async () => {
                state.promoter = winner; // winner is now visible to the retry
                const err = new Error('duplicate key value violates unique constraint');
                err.code = '23505';
                throw err;
              }),
            }));
          }
          return chain;
        },
      }));
      return result;
    }
    return cb(trxAfter);
  });
  const { promoter, alreadyEnrolled } = await engine.enrollPromoter('cust-1');
  expect(alreadyEnrolled).toBe(true);
  expect(promoter.referral_code).toBe('WAVES-WINNER01');
});

test('P0 guard: a phone match in a DIFFERENT account is never reused — foreign codes stay foreign', async () => {
  const state = freshState();
  primeDb(state);
  await engine.enrollPromoter('cust-1');
  // Unrelated customer, same (recycled) phone, different account.
  state.promoterAccountId = 'acct-1';
  state.customer = { id: 'cust-9', account_id: 'acct-OTHER', phone: '+15555550100', email: 'y@example.com', first_name: 'Riley', last_name: 'Fixture', referral_code: null };
  // The fallback finds nothing (account mismatch) → first-enroll path →
  // insert (the real DB would 23505 on the shared phone → 503 = manual
  // resolution, the correct money posture; the fake just records the path).
  const second = await engine.enrollPromoter('cust-9');
  expect(second.alreadyEnrolled).toBe(false);
  expect(state.phoneFallbacks.some((f) => f.account === 'acct-OTHER')).toBe(true);
  expect(second.promoter.referral_code).not.toBe('');
});

test('no account_id → no phone fallback at all (legacy single-profile rows)', async () => {
  const state = freshState();
  primeDb(state);
  state.customer = { ...state.customer, account_id: null };
  await engine.enrollPromoter('cust-1');
  expect(state.phoneFallbacks).toHaveLength(0);
});

test('both promoter lookups take FOR UPDATE — the repair path is serialized on the row (r4 P1)', async () => {
  const state = freshState();
  primeDb(state);
  const first = await engine.enrollPromoter('cust-1');
  expect(state.ownLookupLocked).toBe(true);
  state.promoterAccountId = 'acct-1';
  state.customer = { id: 'cust-2', account_id: 'acct-1', phone: '+15555550100', email: 'x@example.com', first_name: 'Casey', last_name: 'Placeholder', referral_code: null };
  const sibling = await engine.enrollPromoter('cust-2');
  expect(sibling.promoter.referral_code).toBe(first.promoter.referral_code);
  expect(state.phoneFallbacks.every((f) => f.locked)).toBe(true);
});

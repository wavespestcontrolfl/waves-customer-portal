// enrollPromoter atomicity (codex #3379 r1 P1): the public report's
// referral tap made concurrent first-enrollments reachable, and the
// unlocked path could split customers.referral_code from the surviving
// promoter's code. Enrollment now runs inside ONE transaction opened by a
// customer-row lock — and identity stays STRICTLY per-customer (r5): the
// multi-property household case is resolved read-only by resolvePromoter
// (below), never by teaching enrollPromoter a second identity model.

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
          // Multi-profile states key customers by id; single-profile states
          // answer the one customer whatever the id.
          const wantedId = chain._where?.id;
          if (wantedId && state.customersById) return state.customersById[wantedId] || null;
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
          // generateUniqueCode collision probe: only an EXACT code match is a collision.
          if (wanted.referral_code) {
            return (state.promoter && state.promoter.referral_code === wanted.referral_code) ? state.promoter : null;
          }
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
          // UNIQUE (customer_phone): a promoter already owning the phone
          // rejects the insert exactly as Postgres does (the multi-property
          // sibling case resolvePromoter handles).
          if (table === 'referral_promoters' && state.promoter && state.promoter.customer_phone === values.customer_phone) {
            throw Object.assign(new Error('duplicate key value violates unique constraint "referral_promoters_customer_phone_unique"'), { code: '23505' });
          }
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





test('the promoter lookup takes FOR UPDATE — concurrent legacy repairs serialize on the row', async () => {
  const state = freshState();
  primeDb(state);
  await engine.enrollPromoter('cust-1');
  await engine.enrollPromoter('cust-1'); // second call hits the found path
  expect(state.ownLookupLocked).toBe(true);
});

describe('resolvePromoter — enroll-or-resolve the household promoter (the one path every caller uses)', () => {
  // cust-2 is a multi-property sibling: cust-1's promoter already owns the
  // household phone under the same account.
  const owner = { id: 'cust-1', account_id: 'acct-1', phone: '+15555550100', email: 'x@example.com', first_name: 'Casey', last_name: 'Placeholder', referral_code: 'WAVES-HOUSE01' };
  const sibling = { id: 'cust-2', account_id: 'acct-1', phone: '+15555550100', email: 'y@example.com', first_name: 'Sam', last_name: 'Placeholder', referral_code: null };
  const siblingState = (over = {}) => freshState({
    customer: sibling,
    customersById: { 'cust-1': owner, 'cust-2': sibling },
    promoter: { id: 'promo-house', customer_id: 'cust-1', customer_phone: '+15555550100', referral_code: 'WAVES-HOUSE01', referral_link: 'https://portal.wavespestcontrol.com/r/WAVES-HOUSE01' },
    promoterAccountId: 'acct-1',
    ...over,
  });

  test('a first enrollment resolves exactly like enrollPromoter', async () => {
    const state = freshState();
    primeDb(state);
    const out = await engine.resolvePromoter('cust-1', { database: makeTrx(state) });
    expect(out.alreadyEnrolled).toBe(false);
    expect(out.household).toBeUndefined();
    expect(state.inserts).toHaveLength(1);
    expect(state.phoneFallbacks).toHaveLength(0);
  });

  test('a sibling whose phone already backs a promoter resolves the household promoter, scoped to the account — the owner row is handed back untouched', async () => {
    const state = siblingState();
    primeDb(state);
    const out = await engine.resolvePromoter('cust-2', { database: makeTrx(state) });
    expect(out.promoter.id).toBe('promo-house');
    expect(out.promoter.referral_code).toBe('WAVES-HOUSE01');
    expect(out.household).toBe(true);
    expect(state.inserts).toHaveLength(0); // the insert lost to the unique phone
    // The household read is read-only and account-scoped; the owner's row is
    // then handed back through its own enrollment — nothing to repair, so it
    // is not rewritten. (The sibling's pre-insert customers.referral_code
    // write is rolled back with the failed transaction in Postgres; the fake
    // keeps it, so it is not asserted on here.)
    expect(state.phoneFallbacks).toEqual([{ phone: '+15555550100', account: 'acct-1', locked: false }]);
    expect(state.updates.filter((u) => u.table === 'referral_promoters')).toHaveLength(0);
  });

  test('a legacy household promoter with no code/link is repaired before the sibling gets it (GH codex #3850 r1 P2)', async () => {
    const state = siblingState({
      customersById: { 'cust-1': { ...owner, referral_code: null }, 'cust-2': sibling },
      promoter: { id: 'promo-house', customer_id: 'cust-1', customer_phone: '+15555550100', referral_code: null, referral_link: null },
    });
    primeDb(state);
    const out = await engine.resolvePromoter('cust-2', { database: makeTrx(state) });
    expect(out.promoter.id).toBe('promo-house');
    expect(out.promoter.referral_code).toMatch(/^WAVES-/);
    expect(out.promoter.referral_link).toContain(out.promoter.referral_code);
    const repaired = state.updates.find((u) => u.table === 'referral_promoters');
    expect(repaired.values.referral_code).toBe(out.promoter.referral_code);
    expect(state.inserts).toHaveLength(0);
  });

  test('no account-scoped match → the 23505 rethrows (never a guessed attribution)', async () => {
    const state = siblingState({ promoterAccountId: 'acct-other' });
    primeDb(state);
    await expect(engine.resolvePromoter('cust-2', { database: makeTrx(state) })).rejects.toMatchObject({ code: '23505' });
    expect(state.phoneFallbacks).toHaveLength(1);
  });

  test('a non-conflict failure passes through with no fallback read', async () => {
    const state = freshState({ customer: null });
    primeDb(state);
    await expect(engine.resolvePromoter('cust-x', { database: makeTrx(state) })).rejects.toThrow('Customer not found');
    expect(state.phoneFallbacks).toHaveLength(0);
  });

  test('under an outer transaction the enroll runs in a savepoint and the fallback reads ride the outer connection', async () => {
    const state = siblingState();
    primeDb(state);
    const conn = makeTrx(state);
    // knex nests a transaction as a SAVEPOINT: the enroll runs on it so the
    // 23505 rolls back only the savepoint and the fallback can still read.
    conn.transaction = jest.fn(async (fn) => fn(makeTrx(state)));
    const settings = { program_active: true, base_url: 'https://portal.wavespestcontrol.com/r/' };
    const out = await engine.resolvePromoter('cust-2', { conn, settings });
    expect(out.promoter.id).toBe('promo-house');
    // Two savepoints: the sibling's attempt, then the owner's enrollment.
    expect(conn.transaction).toHaveBeenCalledTimes(2);
    expect(db.transaction).not.toHaveBeenCalled(); // never a second pool transaction
    expect(db).not.toHaveBeenCalledWith('referral_program_settings'); // preset settings, no second read
    expect(conn).toHaveBeenCalledWith('customers');
    expect(conn).toHaveBeenCalledWith('referral_promoters as rp');
    expect(state.phoneFallbacks).toHaveLength(1);
  });
});

describe('findHouseholdPromoter — the read-only household resolution read paths share', () => {
  const house = { id: 'promo-house', customer_id: 'cust-1', customer_phone: '+15555550100', referral_code: 'WAVES-HOUSE01' };
  const sibling = { id: 'cust-2', account_id: 'acct-1', phone: '+15555550100', email: 'y@example.com', first_name: 'Sam', last_name: 'Placeholder', referral_code: null };

  test('a same-account promoter on the sibling phone resolves, read-only (no lock, no write)', async () => {
    const state = freshState({ customer: sibling, promoter: house, promoterAccountId: 'acct-1' });
    const out = await engine.findHouseholdPromoter('cust-2', makeTrx(state));
    expect(out.id).toBe('promo-house');
    expect(state.phoneFallbacks).toEqual([{ phone: '+15555550100', account: 'acct-1', locked: false }]);
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  test('a different account on the same phone resolves nothing (never a foreign code)', async () => {
    const state = freshState({ customer: sibling, promoter: house, promoterAccountId: 'acct-other' });
    expect(await engine.findHouseholdPromoter('cust-2', makeTrx(state))).toBeNull();
  });

  test('no phone or no account on the profile → null without the join', async () => {
    for (const customer of [{ ...sibling, phone: null }, { ...sibling, account_id: null }]) {
      const state = freshState({ customer, promoter: house, promoterAccountId: 'acct-1' });
      expect(await engine.findHouseholdPromoter('cust-2', makeTrx(state))).toBeNull();
      expect(state.phoneFallbacks).toHaveLength(0);
    }
  });
});

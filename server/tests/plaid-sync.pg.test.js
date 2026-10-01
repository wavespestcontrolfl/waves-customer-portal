/**
 * Plaid bank sync against a real PostgreSQL (PLAID_SYNC_TEST_DATABASE_URL;
 * skipped when unset). The Plaid HTTP client is mocked; everything below it —
 * pgcrypto token storage, the staging insert/dedupe, cursor CAS, the
 * label→type invariant and the modified/removed policy — runs for real.
 */
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction']) db[name] = (...args) => mockPg[name](...args);
  Object.defineProperty(db, 'fn', { get: () => mockPg.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/bank-import', () => ({
  ...jest.requireActual('../services/bank-import'),
  runDeterministicMatching: jest.fn(async () => ({ payoutsLinked: 0, expensesLinked: 0, ambiguous: 0 })),
  // the list route heals first; those passes have their own suites
  resetDanglingLinks: jest.fn(async () => 0),
  healEditedExpenseLinks: jest.fn(async () => 0),
  healUnreconciledLinks: jest.fn(async () => ({})),
  healOrphanRefunds: jest.fn(async () => 0),
  verifyPendingExpenseClaims: jest.fn(async () => ({})),
  verifyPendingPayoutClaims: jest.fn(async () => ({})),
  retryPendingEchoes: jest.fn(async () => ({})),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'tech-1'; next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/plaid-client', () => {
  const actual = jest.requireActual('../services/plaid-client');
  return {
    PlaidError: actual.PlaidError,
    isConfigured: jest.fn(() => true),
    plaidEnv: jest.fn(() => 'sandbox'),
    createLinkToken: jest.fn(),
    exchangePublicToken: jest.fn(),
    getAccounts: jest.fn(),
    transactionsSync: jest.fn(),
    removeItem: jest.fn(async () => ({})),
  };
});

const knex = require('knex');
const plaid = require('../services/plaid-client');
const plaidSync = require('../services/plaid-sync');

const connection = process.env.PLAID_SYNC_TEST_DATABASE_URL;
const SCHEMA = 'plaid_sync_test';
let mockPg;
jest.setTimeout(60000);

const ACCOUNTS = [
  { account_id: 'acc-chk', name: 'Business Checking', mask: '0001', type: 'depository', subtype: 'checking' },
  { account_id: 'acc-card', name: 'Spark Card', mask: '1234', type: 'credit', subtype: 'credit card' },
  { account_id: 'acc-loan', name: 'Truck Loan', mask: '9999', type: 'loan', subtype: 'auto' },
];

function txn(id, account, amount, date, extra = {}) {
  return { transaction_id: id, account_id: account, amount, date, name: `TXN ${id}`, pending: false, iso_currency_code: 'USD', ...extra };
}

function page(added = [], modified = [], removed = [], nextCursor = 'c1') {
  return { added, modified, removed, next_cursor: nextCursor, has_more: false };
}

async function connect(suffix = '') {
  plaid.exchangePublicToken.mockResolvedValueOnce({ accessToken: 'access-sandbox-secret', itemId: `item-${Date.now()}-${Math.random()}` });
  plaid.getAccounts.mockResolvedValueOnce({ accounts: ACCOUNTS.map(x => ({ ...x, account_id: `${x.account_id}${suffix}` })), institutionId: 'ins_128026' });
  return plaidSync.connectItem({ publicToken: 'public-sandbox-x', institutionName: 'Capital One' });
}

async function accountsOf(itemId) {
  return mockPg('plaid_accounts').where({ plaid_item_id: itemId }).orderBy('account_id');
}

async function activate(itemId, overrides = {}) {
  const accts = await accountsOf(itemId);
  await plaidSync.setupItem(itemId, accts.map(a => ({
    id: a.id,
    accountLabel: a.account_label,
    accountType: a.account_type,
    syncFrom: '2026-09-01',
    enabled: a.plaid_type !== 'loan',
    ...(overrides[a.account_id] || {}),
  })));
}

(connection ? describe : describe.skip)('plaid sync on PostgreSQL', () => {
  beforeAll(async () => {
    process.env.PLAID_TOKEN_KEY = 'test-plaid-token-key';
    // Own schema: the CI database is shared with other suites and already
    // migrated — these tables are created (and dropped) only in SCHEMA.
    const setup = knex({ client: 'pg', connection });
    await setup.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public');
    await setup.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await setup.raw(`CREATE SCHEMA ${SCHEMA}`);
    await setup.destroy();
    mockPg = knex({ client: 'pg', connection, searchPath: [SCHEMA, 'public'], pool: { min: 0, max: 6 } });
    await mockPg.schema.createTable('expenses', t => { t.uuid('id').primary().defaultTo(mockPg.raw('gen_random_uuid()')); });
    await mockPg.schema.createTable('stripe_payouts', t => { t.uuid('id').primary().defaultTo(mockPg.raw('gen_random_uuid()')); });
    for (const m of [
      '20260813000030_bank_transactions',
      '20260813000031_bank_txn_force_identity',
      '20260813000032_bank_txn_refund_status',
      '20260928020000_plaid_bank_sync',
      '20260928020100_bank_txn_plaid_account_id',
    ]) {
      await require(`../models/migrations/${m}`).up(mockPg);
    }
  });

  afterAll(async () => {
    delete process.env.PLAID_TOKEN_KEY;
    if (mockPg) {
      await mockPg.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await mockPg.destroy();
    }
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    // clearAllMocks keeps queued mockResolvedValueOnce values — a test that
    // queues one it never consumes would hand it to the next test
    for (const fn of [plaid.exchangePublicToken, plaid.getAccounts, plaid.transactionsSync]) fn.mockReset();
    await mockPg('bank_transactions').del();
    await mockPg('plaid_accounts').del();
    await mockPg('plaid_items').del();
  });

  test('migration down/up round-trips', async () => {
    const m = require('../models/migrations/20260928020000_plaid_bank_sync');
    await m.down(mockPg);
    expect(await mockPg.schema.hasTable('plaid_items')).toBe(false);
    expect(await mockPg.schema.hasColumn('bank_transactions', 'plaid_transaction_id')).toBe(false);
    await m.up(mockPg);
    await m.up(mockPg); // idempotent
    expect(await mockPg.schema.hasColumn('bank_transactions', 'plaid_transaction_id')).toBe(true);
    const m2 = require('../models/migrations/20260928020100_bank_txn_plaid_account_id');
    await m2.down(mockPg);
    expect(await mockPg.schema.hasColumn('bank_transactions', 'plaid_account_id')).toBe(false);
    await m2.up(mockPg);
    await m2.up(mockPg); // idempotent
    expect(await mockPg.schema.hasColumn('bank_transactions', 'plaid_account_id')).toBe(true);
  });

  test('connect stores the token encrypted and seeds account defaults; nothing syncs during setup', async () => {
    await mockPg('bank_transactions').insert({
      account_label: 'capital-one-card-1234', account_type: 'card', txn_date: '2026-09-10',
      description: 'CSV row', amount: 5, direction: 'debit', row_hash: 'a'.repeat(64),
    });
    const itemId = await connect();
    const item = await mockPg('plaid_items').where({ id: itemId }).first();
    expect(item.status).toBe('setup');
    expect(item.access_token_enc).toMatch(/BEGIN PGP MESSAGE/);
    expect(item.access_token_enc).not.toContain('access-sandbox-secret');
    const accts = await accountsOf(itemId);
    const byId = Object.fromEntries(accts.map(a => [a.account_id, a]));
    expect(byId['acc-card']).toMatchObject({ account_label: 'capital-one-card-1234', account_type: 'card', enabled: true });
    expect(plaidSync.toDateOnly(byId['acc-card'].sync_from)).toBe('2026-09-11'); // day after the CSV series
    expect(byId['acc-chk']).toMatchObject({ account_label: 'capital-one-checking-0001', account_type: 'bank', enabled: true });
    expect(byId['acc-loan'].enabled).toBe(false);

    expect(await plaidSync.syncItem(itemId)).toEqual({ itemId, skipped: 'setup' });
    expect(plaid.transactionsSync).not.toHaveBeenCalled();
  });

  test('connect fails closed without a key and revokes a token it could not save', async () => {
    const saved = process.env.PLAID_TOKEN_KEY;
    delete process.env.PLAID_TOKEN_KEY;
    await expect(connect()).rejects.toMatchObject({ status: 503 });
    expect(plaid.exchangePublicToken).not.toHaveBeenCalled();
    process.env.PLAID_TOKEN_KEY = saved;
  });

  test('a failure after the token exchange (before the connection is stored) revokes it at Plaid', async () => {
    plaid.exchangePublicToken.mockResolvedValueOnce({ accessToken: 'access-orphan', itemId: 'item-orphan' });
    plaid.getAccounts.mockResolvedValueOnce({ accounts: ACCOUNTS, institutionId: 'ins_1' });
    // make the account-default read (a bank_transactions query) fail
    const real = mockPg;
    const failing = (...args) => {
      if (args[0] === 'bank_transactions') throw Object.assign(new Error('connection terminated'), { code: '57P01' });
      return real(...args);
    };
    failing.raw = real.raw.bind(real);
    failing.transaction = real.transaction.bind(real);
    failing.fn = real.fn;
    mockPg = failing;
    try {
      await expect(plaidSync.connectItem({ publicToken: 'public-x', institutionName: 'Bank' })).rejects.toThrow(/could not save the bank connection: database error 57P01/);
    } finally {
      mockPg = real;
    }
    expect(plaid.removeItem).toHaveBeenCalledWith('access-orphan');
    expect(await mockPg('plaid_items').where({ item_id: 'item-orphan' }).first()).toBeUndefined();
  });

  test('when revoking also fails, the stored connection stays visible so Disconnect can retry', async () => {
    plaid.exchangePublicToken.mockResolvedValueOnce({ accessToken: 'access-stuck', itemId: 'item-stuck' });
    plaid.getAccounts.mockRejectedValueOnce(new plaid.PlaidError('Plaid /accounts/get: INTERNAL_SERVER_ERROR — try later', { errorCode: 'INTERNAL_SERVER_ERROR' }));
    plaid.removeItem.mockRejectedValueOnce(new plaid.PlaidError('Plaid /item/remove: INTERNAL_SERVER_ERROR', { errorCode: 'INTERNAL_SERVER_ERROR' }));
    await expect(plaidSync.connectItem({ publicToken: 'public-x', institutionName: 'Bank' })).rejects.toThrow(/accounts\/get/);
    const kept = await mockPg('plaid_items').where({ item_id: 'item-stuck' }).first();
    expect(kept).toMatchObject({ status: 'setup' });
    expect(kept.access_token_enc).toMatch(/BEGIN PGP MESSAGE/);
    expect(kept.last_error).toMatch(/could not be revoked automatically/);
    await plaidSync.disconnectItem(kept.id);
    expect(plaid.removeItem).toHaveBeenLastCalledWith('access-stuck');
    expect((await mockPg('plaid_items').where({ id: kept.id }).first()).status).toBe('removed');
  });

  test('setup refuses an account id that is not one UUID (no delimiter collapsing stored ids)', async () => {
    const itemId = await connect();
    const accts = await accountsOf(itemId);
    const joined = { id: accts.map(a => a.id).join(','), accountLabel: 'x', accountType: 'bank', syncFrom: '2026-09-01', enabled: false };
    await expect(plaidSync.setupItem(itemId, [joined])).rejects.toMatchObject({ status: 400 });
    // same count, one id repeated: still not the stored set
    const dup = accts.map(a => ({ id: accts[0].id, accountLabel: `${a.account_label}`, accountType: a.account_type, syncFrom: '2026-09-01', enabled: false }));
    await expect(plaidSync.setupItem(itemId, dup)).rejects.toMatchObject({ status: 400 });
    expect(await mockPg('plaid_items').where({ id: itemId }).first('status')).toEqual({ status: 'setup' });
    await plaidSync.disconnectItem(itemId);
  });

  test('setup enforces the label→type invariant and unique labels', async () => {
    await mockPg('bank_transactions').insert({
      account_label: 'capone-checking', account_type: 'bank', txn_date: '2026-08-01',
      description: 'CSV row', amount: 5, direction: 'debit', row_hash: 'b'.repeat(64),
    });
    const itemId = await connect();
    await expect(activate(itemId, { 'acc-card': { accountLabel: 'CAPONE-CHECKING ' } }))
      .rejects.toThrow(/already imported as a bank account/);
    await expect(activate(itemId, { 'acc-card': { accountLabel: 'same' }, 'acc-chk': { accountLabel: 'same' } }))
      .rejects.toThrow(/cannot share a label/);
    await expect(activate(itemId, { 'acc-card': { syncFrom: '2999-01-01' } })).rejects.toThrow(/at most tomorrow/);
    // the same account twice (and another left out) is refused before any write
    const accts = await accountsOf(itemId);
    const dup = accts.map(x => ({ id: accts[0].id, accountLabel: `l-${x.account_id}`, accountType: 'bank', syncFrom: '2026-09-01', enabled: true }));
    await expect(plaidSync.setupItem(itemId, dup)).rejects.toThrow(/does not match this connection/);
    expect((await mockPg('plaid_items').where({ id: itemId }).first()).status).toBe('setup');
    await activate(itemId, { 'acc-chk': { accountLabel: 'capone-checking' } });
    expect((await mockPg('plaid_items').where({ id: itemId }).first()).status).toBe('active');
  });

  test('two connections set up concurrently cannot both claim one label', async () => {
    const a = await connect();
    const b = await connect('-b');
    const results = await Promise.allSettled([
      activate(a, { 'acc-card': { accountLabel: 'shared-label' } }),
      activate(b, { 'acc-card-b': { accountLabel: 'shared-label' }, 'acc-chk-b': { accountLabel: 'b-checking' } }),
    ]);
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find(r => r.status === 'rejected').reason.message).toMatch(/already fed by another bank connection/);
    const owners = await mockPg('plaid_accounts').where({ account_label: 'shared-label', enabled: true });
    expect(owners).toHaveLength(1);
  });

  test('sync imports posted transactions only, maps direction, dedupes, and saves the cursor', async () => {
    const itemId = await connect();
    await activate(itemId);
    const added = [
      txn('t-purchase', 'acc-card', 42.5, '2026-09-05'),
      txn('t-refund', 'acc-card', -10, '2026-09-06'),
      txn('t-deposit', 'acc-chk', -1200, '2026-09-07'),
      txn('t-pending', 'acc-chk', 5, '2026-09-08', { pending: true }),
      txn('t-old', 'acc-chk', 5, '2026-08-31'),
      txn('t-loan', 'acc-loan', 300, '2026-09-08'),
      txn('t-eur', 'acc-chk', 5, '2026-09-08', { iso_currency_code: 'EUR' }),
    ];
    plaid.transactionsSync.mockResolvedValueOnce(page(added, [], [], 'cursor-1'));
    const out = await plaidSync.syncItem(itemId);
    expect(out).toMatchObject({ inserted: 3 });
    expect(out.skipped).toBeUndefined(); // a whole-run skip only
    expect(out.skips).toEqual({ pending: 1, before_sync_from: 1, account_disabled: 1, currency: 1 });
    // the token handed to Plaid is the decrypted one
    expect(plaid.transactionsSync).toHaveBeenCalledWith('access-sandbox-secret', null);

    const rows = await mockPg('bank_transactions').orderBy('plaid_transaction_id');
    expect(rows.map(r => [r.plaid_transaction_id, r.direction, Number(r.amount), r.account_type, r.source])).toEqual([
      ['t-deposit', 'credit', 1200, 'bank', 'plaid'],
      ['t-purchase', 'debit', 42.5, 'card', 'plaid'],
      ['t-refund', 'credit', 10, 'card', 'plaid'],
    ]);
    const item = await mockPg('plaid_items').where({ id: itemId }).first();
    expect(item.sync_cursor).toBe('cursor-1');
    expect(item.last_synced_at).not.toBeNull();
    expect(require('../services/bank-import').runDeterministicMatching).toHaveBeenCalledWith({ limit: 500 });

    // replaying the same transactions is a no-op
    plaid.transactionsSync.mockResolvedValueOnce(page(added.slice(0, 3), [], [], 'cursor-2'));
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ inserted: 0 });
    expect(plaid.transactionsSync).toHaveBeenLastCalledWith('access-sandbox-secret', 'cursor-1');
    expect(await mockPg('bank_transactions').count('* as n').first()).toEqual({ n: '3' });
  });

  test('modified/removed rewrite unreviewed rows and only flag reviewed ones', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockResolvedValueOnce(page([
      txn('t-a', 'acc-card', 10, '2026-09-05'),
      txn('t-b', 'acc-card', 20, '2026-09-05'),
      txn('t-c', 'acc-card', 30, '2026-09-05'),
      txn('t-d', 'acc-card', 40, '2026-09-05'),
    ], [], [], 'cursor-1'));
    await plaidSync.syncItem(itemId);
    const [exp1] = await mockPg('expenses').insert({}).returning(['id']);
    const [exp2] = await mockPg('expenses').insert({}).returning(['id']);
    await mockPg('bank_transactions').where({ plaid_transaction_id: 't-b' }).update({ status: 'matched_expense', matched_expense_id: exp1.id });
    await mockPg('bank_transactions').where({ plaid_transaction_id: 't-d' }).update({ status: 'matched_expense', matched_expense_id: exp2.id });

    plaid.transactionsSync.mockResolvedValueOnce(page([], [
      txn('t-a', 'acc-card', 11, '2026-09-06', { name: 'CORRECTED' }),
      txn('t-b', 'acc-card', 21, '2026-09-06'),
    ], [{ transaction_id: 't-c' }, { transaction_id: 't-d' }], 'cursor-2'));
    const out = await plaidSync.syncItem(itemId);
    expect(out).toMatchObject({ updated: 1, deleted: 1, flagged: 2 });

    const rows = Object.fromEntries((await mockPg('bank_transactions')).map(r => [r.plaid_transaction_id, r]));
    expect(Number(rows['t-a'].amount)).toBe(11);
    expect(rows['t-a'].description).toBe('CORRECTED');
    expect(Number(rows['t-b'].amount)).toBe(20); // reviewed row untouched…
    expect(rows['t-b'].suggestion.plaidModified).toMatchObject({ amount: 21 }); // …change parked
    expect(rows['t-c']).toBeUndefined();
    expect(rows['t-d'].suggestion).toEqual({ plaidRemoved: true });
    expect(rows['t-d'].matched_expense_id).toBe(exp2.id);
  });

  test('a newer correction on an unlinked row supersedes the one parked while it was reviewed', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockResolvedValueOnce(page([txn('t-a', 'acc-card', 10, '2026-09-05')], [], [], 'cursor-1'));
    await plaidSync.syncItem(itemId);
    const [exp] = await mockPg('expenses').insert({}).returning(['id']);
    await mockPg('bank_transactions').where({ plaid_transaction_id: 't-a' }).update({ status: 'matched_expense', matched_expense_id: exp.id });
    plaid.transactionsSync.mockResolvedValueOnce(page([], [txn('t-a', 'acc-card', 11, '2026-09-05')], [], 'cursor-2'));
    await plaidSync.syncItem(itemId); // correction A parks
    await mockPg('bank_transactions').where({ plaid_transaction_id: 't-a' }).update({ status: 'unmatched', matched_expense_id: null });
    plaid.transactionsSync.mockResolvedValueOnce(page([], [txn('t-a', 'acc-card', 12, '2026-09-05')], [], 'cursor-3'));
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ updated: 1, flagged: 0 }); // correction B applies
    const row = await mockPg('bank_transactions').where({ plaid_transaction_id: 't-a' }).first();
    expect(Number(row.amount)).toBe(12);
    expect(row.suggestion?.plaidModified).toBeUndefined(); // A can no longer be re-applied
  });

  test('a manual sync that only corrected rows still runs the matching pass', async () => {
    const bankImport = require('../services/bank-import');
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockResolvedValueOnce(page([txn('t-a', 'acc-card', 10, '2026-09-05')], [], [], 'cursor-1'));
    await plaidSync.syncItem(itemId);
    bankImport.runDeterministicMatching.mockClear();
    plaid.transactionsSync.mockResolvedValueOnce(page([], [txn('t-a', 'acc-card', 11, '2026-09-05')], [], 'cursor-2'));
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ inserted: 0, updated: 1 });
    expect(bankImport.runDeterministicMatching).toHaveBeenCalledTimes(1);
    await plaidSync.disconnectItem(itemId);
  });

  test('a correction to a staged row applies even before the start date or after the feed is switched off', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockResolvedValueOnce(page([txn('t-a', 'acc-card', 10, '2026-09-02')], [], [], 'cursor-1'));
    await plaidSync.syncItem(itemId);
    await activate(itemId, { 'acc-card': { enabled: false } });
    plaid.transactionsSync.mockResolvedValueOnce(page([], [
      txn('t-a', 'acc-card', 10, '2026-08-30'),            // staged: moved before sync_from
      txn('t-new', 'acc-card', 5, '2026-09-05'),           // never staged: new-row gates apply
    ], [], 'cursor-2'));
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ updated: 1, inserted: 0, skips: { account_disabled: 1 } });
    const row = await mockPg('bank_transactions').where({ plaid_transaction_id: 't-a' }).first();
    expect(plaidSync.toDateOnly(row.txn_date)).toBe('2026-08-30');
    expect(row.account_label).toBe('capital-one-card-1234');
  });

  test('a row claimed while the sync waits on it still gets its correction parked', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockResolvedValueOnce(page([txn('t-a', 'acc-card', 10, '2026-09-05')], [], [], 'cursor-1'));
    await plaidSync.syncItem(itemId);
    const [exp] = await mockPg('expenses').insert({}).returning(['id']);
    // a concurrent claim holds the row lock when the sync reaches it…
    const claim = await mockPg.transaction();
    await claim('bank_transactions').where({ plaid_transaction_id: 't-a' }).update({ status: 'matched_expense', matched_expense_id: exp.id });
    plaid.transactionsSync.mockResolvedValueOnce(page([], [txn('t-a', 'acc-card', 11, '2026-09-05')], [], 'cursor-2'));
    const syncing = plaidSync.syncItem(itemId);
    await new Promise(r => setTimeout(r, 300));
    await claim.commit(); // …and commits first
    expect(await syncing).toMatchObject({ updated: 0, flagged: 1 });
    const row = await mockPg('bank_transactions').where({ plaid_transaction_id: 't-a' }).first();
    expect(row.status).toBe('matched_expense');
    expect(Number(row.amount)).toBe(10);
    expect(row.suggestion.plaidModified).toMatchObject({ amount: 11 });
  });

  test('a correction replaces the unmatched row: a racing status-CAS claim misses; review history carries over, derived suggestions do not', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockResolvedValueOnce(page([txn('t-a', 'acc-card', 10, '2026-09-05')], [], [], 'cursor-1'));
    await plaidSync.syncItem(itemId);
    const before = await mockPg('bank_transactions').where({ plaid_transaction_id: 't-a' }).first();
    await mockPg('bank_transactions').where({ id: before.id }).update({ suggestion: {
      rejectedExpenseIds: ['x'], lastUnlink: { expenseId: 'y' },
      // derived from the $10 version — obsolete once the bank corrects it
      categoryId: 'c1', noMatch: true, ignore: true, candidates: [{ id: 'z' }],
    } });
    // create-expense has READ the row at $10 (unlocked) and is about to claim it
    plaid.transactionsSync.mockResolvedValueOnce(page([], [txn('t-a', 'acc-card', 25, '2026-09-05')], [], 'cursor-2'));
    await plaidSync.syncItem(itemId);
    const [exp] = await mockPg('expenses').insert({}).returning(['id']);
    const claimed = await mockPg('bank_transactions')
      .where({ id: before.id, status: 'unmatched' })
      .update({ status: 'created_expense', matched_expense_id: exp.id });
    expect(claimed).toBe(0); // the stale claim loses — its $10 expense rolls back
    const now = await mockPg('bank_transactions').where({ plaid_transaction_id: 't-a' }).first();
    expect(now.id).not.toBe(before.id);
    expect(Number(now.amount)).toBe(25);
    expect(now.row_hash).toBe(before.row_hash);
    expect(now.suggestion).toEqual({ rejectedExpenseIds: ['x'], lastUnlink: { expenseId: 'y' } });
  });

  test('setup accepts tomorrow as the start date (CSV already covers today)', async () => {
    const itemId = await connect();
    const etToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const next = new Date(`${etToday}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    await activate(itemId, { 'acc-card': { syncFrom: next.toISOString().slice(0, 10) } });
    const next2 = new Date(next); next2.setUTCDate(next2.getUTCDate() + 1);
    await expect(activate(itemId, { 'acc-card': { syncFrom: next2.toISOString().slice(0, 10) } })).rejects.toThrow(/at most tomorrow/);
  });

  test('a correction that zeroes a staged transaction withdraws it (unmatched: removed; reviewed: flagged)', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockResolvedValueOnce(page([txn('t-u', 'acc-card', 10, '2026-09-05'), txn('t-r', 'acc-card', 20, '2026-09-05')], [], [], 'cursor-1'));
    await plaidSync.syncItem(itemId);
    const [exp] = await mockPg('expenses').insert({}).returning(['id']);
    await mockPg('bank_transactions').where({ plaid_transaction_id: 't-r' }).update({ status: 'matched_expense', matched_expense_id: exp.id });
    plaid.transactionsSync.mockResolvedValueOnce(page([], [txn('t-u', 'acc-card', 0, '2026-09-05'), txn('t-r', 'acc-card', 0, '2026-09-05')], [], 'cursor-2'));
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ deleted: 1, flagged: 1, skips: { zero_amount: 2 } });
    expect(await mockPg('bank_transactions').where({ plaid_transaction_id: 't-u' }).first()).toBeUndefined();
    expect((await mockPg('bank_transactions').where({ plaid_transaction_id: 't-r' }).first()).suggestion).toEqual({ plaidRemoved: true });

    // the bank restores a valid amount: the withdrawal flag gives way to the correction
    plaid.transactionsSync.mockResolvedValueOnce(page([], [txn('t-r', 'acc-card', 22, '2026-09-05')], [], 'cursor-3'));
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ flagged: 1 });
    const restored = await mockPg('bank_transactions').where({ plaid_transaction_id: 't-r' }).first();
    expect(restored.suggestion.plaidRemoved).toBeUndefined();
    expect(restored.suggestion.plaidModified).toMatchObject({ amount: 22 });
    // …and restoring the ORIGINAL values clears every flag
    await mockPg('bank_transactions').where({ id: restored.id }).update({ suggestion: { plaidRemoved: true } });
    plaid.transactionsSync.mockResolvedValueOnce(page([], [txn('t-r', 'acc-card', 20, '2026-09-05')], [], 'cursor-4'));
    await plaidSync.syncItem(itemId);
    expect((await mockPg('bank_transactions').where({ id: restored.id }).first()).suggestion).toEqual({});
  });

  test('a concurrent run that already moved the cursor wins', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockImplementationOnce(async () => {
      await mockPg('plaid_items').where({ id: itemId }).update({ sync_cursor: 'someone-else' });
      return page([txn('t-x', 'acc-card', 5, '2026-09-05')], [], [], 'cursor-1');
    });
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ skipped: 'concurrent' });
    expect((await mockPg('plaid_items').where({ id: itemId }).first()).sync_cursor).toBe('someone-else');
    expect(await mockPg('bank_transactions').count('* as n').first()).toEqual({ n: '0' });
  });

  test('a mapping edit that commits while Plaid is answering governs the batch', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockImplementationOnce(async () => {
      // operator turns the card feed off mid-request (cursor unchanged)
      await activate(itemId, { 'acc-card': { enabled: false } });
      return page([txn('t-card', 'acc-card', 5, '2026-09-05'), txn('t-chk', 'acc-chk', 7, '2026-09-05')], [], [], 'cursor-1');
    });
    const out = await plaidSync.syncItem(itemId);
    expect(out).toMatchObject({ inserted: 1, skips: { account_disabled: 1 } });
    expect((await mockPg('bank_transactions').select('plaid_transaction_id')).map(r => r.plaid_transaction_id)).toEqual(['t-chk']);
  });

  test('bank-change routes: list filter, dismiss, and apply only on an unlinked row', async () => {
    process.env.GATE_BANK_IMPORT = 'true';
    process.env.GATE_PLAID_SYNC = 'true';
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/admin/tax', require('../routes/admin-tax'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}/admin/tax/bank-import`;
    const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const itemId = await connect();
      await activate(itemId);
      plaid.transactionsSync.mockResolvedValueOnce(page([
        txn('t-m', 'acc-card', 10, '2026-09-05'), txn('t-r', 'acc-card', 20, '2026-09-05'), txn('t-plain', 'acc-card', 30, '2026-09-05'),
      ], [], [], 'cursor-1'));
      await plaidSync.syncItem(itemId);
      const [e1] = await mockPg('expenses').insert({}).returning(['id']);
      const [e2] = await mockPg('expenses').insert({}).returning(['id']);
      await mockPg('bank_transactions').where({ plaid_transaction_id: 't-m' }).update({ status: 'matched_expense', matched_expense_id: e1.id });
      await mockPg('bank_transactions').where({ plaid_transaction_id: 't-r' }).update({ status: 'matched_expense', matched_expense_id: e2.id });
      plaid.transactionsSync.mockResolvedValueOnce(page([], [txn('t-m', 'acc-card', 12.34, '2026-09-06', { name: 'FIXED' })], [{ transaction_id: 't-r' }], 'cursor-2'));
      await plaidSync.syncItem(itemId);

      const status = await (await fetch(`${base}/status`)).json();
      expect(status.bankChanges).toBe(2);
      const listed = await (await fetch(`${base}/transactions?status=bank_change`)).json();
      expect(listed.transactions.map(r => r.plaid_transaction_id).sort()).toEqual(['t-m', 't-r']);

      const mRow = await mockPg('bank_transactions').where({ plaid_transaction_id: 't-m' }).first();
      const rRow = await mockPg('bank_transactions').where({ plaid_transaction_id: 't-r' }).first();
      const plain = await mockPg('bank_transactions').where({ plaid_transaction_id: 't-plain' }).first();
      const seen = (row) => ({ plaidModified: row.suggestion.plaidModified || null, plaidRemoved: row.suggestion.plaidRemoved || null });
      expect((await post(`/plaid/rows/${plain.id}/bank-change`, { action: 'dismiss', expected: { plaidRemoved: true } })).status).toBe(404);
      expect((await post(`/plaid/rows/${mRow.id}/bank-change`, { action: 'apply' })).status).toBe(400); // no version
      expect((await post(`/plaid/rows/${mRow.id}/bank-change`, { action: 'apply', expected: seen(mRow) })).status).toBe(409); // still linked
      expect((await post(`/plaid/rows/${rRow.id}/bank-change`, { action: 'apply', expected: seen(rRow) })).status).toBe(409); // withdrawn

      await mockPg('bank_transactions').where({ id: mRow.id }).update({ status: 'unmatched', matched_expense_id: null });
      // unlinked but unresolved: still the OLD $10 values, so no manual claim
      for (const [path, body] of [['create-expense', {}], ['link-expense', { expenseId: e1.id }]]) {
        const r = await post(`/${mRow.id}/${path}`, body);
        expect([path, r.status]).toEqual([path, 409]);
        expect((await r.json()).error).toMatch(/apply or dismiss the bank change first/);
      }
      expect(await mockPg('bank_transactions').where({ id: mRow.id }).first('status')).toEqual({ status: 'unmatched' });
      // a correction the operator never saw lands after the page loaded
      const shown = seen(mRow);
      await mockPg('bank_transactions').where({ id: mRow.id }).update({
        suggestion: mockPg.raw("suggestion || ?::jsonb", [JSON.stringify({ plaidModified: { ...shown.plaidModified, amount: 99 } })]),
      });
      expect((await post(`/plaid/rows/${mRow.id}/bank-change`, { action: 'apply', expected: shown })).status).toBe(409);
      expect((await post(`/plaid/rows/${mRow.id}/bank-change`, { action: 'dismiss', expected: shown })).status).toBe(409);
      const latest = await mockPg('bank_transactions').where({ id: mRow.id }).first();
      expect((await post(`/plaid/rows/${mRow.id}/bank-change`, { action: 'apply', expected: seen(latest) })).status).toBe(200);
      expect(await mockPg('bank_transactions').where({ id: mRow.id }).first()).toBeUndefined(); // replaced, not edited
      const applied = await mockPg('bank_transactions').where({ plaid_transaction_id: 't-m' }).first();
      expect([Number(applied.amount), plaidSync.toDateOnly(applied.txn_date), applied.description]).toEqual([99, '2026-09-06', 'FIXED']);
      expect(applied.suggestion?.plaidModified).toBeUndefined();

      expect((await post(`/plaid/rows/${rRow.id}/bank-change`, { action: 'dismiss', expected: seen(rRow) })).status).toBe(200);
      const dismissed = await mockPg('bank_transactions').where({ id: rRow.id }).first();
      expect(dismissed).toMatchObject({ status: 'matched_expense', matched_expense_id: e2.id });
      expect(dismissed.suggestion.plaidRemoved).toBeUndefined();
      expect(dismissed.suggestion.plaidDismissed).toEqual({ removed: true });
      expect((await (await fetch(`${base}/status`)).json()).bankChanges).toBe(0);
    } finally {
      server.close();
      delete process.env.GATE_BANK_IMPORT;
      delete process.env.GATE_PLAID_SYNC;
    }
  });

  test('a dismissed bank change is not raised again when a re-sync replays that same version', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockResolvedValueOnce(page([txn('t-a', 'acc-card', 10, '2026-09-05'), txn('t-b', 'acc-card', 20, '2026-09-05')], [], [], 'cursor-1'));
    await plaidSync.syncItem(itemId);
    const [e1] = await mockPg('expenses').insert({}).returning(['id']);
    const [e2] = await mockPg('expenses').insert({}).returning(['id']);
    await mockPg('bank_transactions').where({ plaid_transaction_id: 't-a' }).update({
      status: 'matched_expense', matched_expense_id: e1.id,
      suggestion: { plaidDismissed: { txn_date: '2026-09-06', amount: 11, direction: 'debit', description: 'TXN t-a' } },
    });
    await mockPg('bank_transactions').where({ plaid_transaction_id: 't-b' }).update({
      status: 'matched_expense', matched_expense_id: e2.id, suggestion: { plaidDismissed: { removed: true } },
    });
    // a cursor reset replays the bank's current version / withdrawal
    plaid.transactionsSync.mockResolvedValueOnce(page([], [txn('t-a', 'acc-card', 11, '2026-09-06')], [{ transaction_id: 't-b' }], 'cursor-2'));
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ flagged: 0 });
    // a genuinely different version is raised
    plaid.transactionsSync.mockResolvedValueOnce(page([], [txn('t-a', 'acc-card', 12, '2026-09-06')], [], 'cursor-3'));
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ flagged: 1 });
    const row = await mockPg('bank_transactions').where({ plaid_transaction_id: 't-a' }).first();
    expect(row.suggestion.plaidModified).toMatchObject({ amount: 12 });
    // …and the bank returning to the dismissed version makes that $12 obsolete
    plaid.transactionsSync.mockResolvedValueOnce(page([], [txn('t-a', 'acc-card', 11, '2026-09-06')], [], 'cursor-4'));
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ flagged: 0 });
    const back = await mockPg('bank_transactions').where({ plaid_transaction_id: 't-a' }).first();
    expect(back.suggestion.plaidModified).toBeUndefined();
    expect(Number(back.amount)).toBe(10);
    // same for a dismissed withdrawal: re-added (flagged), then withdrawn again
    plaid.transactionsSync.mockResolvedValueOnce(page([], [txn('t-b', 'acc-card', 25, '2026-09-05')], [], 'cursor-5'));
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ flagged: 1 });
    plaid.transactionsSync.mockResolvedValueOnce(page([], [], [{ transaction_id: 't-b' }], 'cursor-6'));
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ flagged: 0 });
    const gone = await mockPg('bank_transactions').where({ plaid_transaction_id: 't-b' }).first();
    expect(gone.suggestion).toEqual({ plaidDismissed: { removed: true } });
  });

  test('the hourly run keeps matching while work remains, even when nothing new synced', async () => {
    const bankImport = require('../services/bank-import');
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockResolvedValueOnce(page([], [], [], 'cursor-1'));
    bankImport.runDeterministicMatching.mockClear();
    bankImport.runDeterministicMatching
      .mockResolvedValueOnce({ moreRemaining: true })
      .mockResolvedValueOnce({ moreRemaining: true })
      .mockResolvedValueOnce({ moreRemaining: false });
    const out = await plaidSync.syncAllItems();
    expect(out).toMatchObject({ items: 1, matchingPasses: 3, matchingError: null });
    expect(out.results[0]).toMatchObject({ inserted: 0, matching: null }); // no per-item pass in the cron
    expect(bankImport.runDeterministicMatching).toHaveBeenCalledTimes(3);
    await plaidSync.disconnectItem(itemId);
  });

  test('CSV and feed never cover the same days for one label', async () => {
    await mockPg('bank_transactions').insert({
      account_label: 'capone-card', account_type: 'card', txn_date: '2026-09-10', source: 'csv',
      description: 'CSV row', amount: 5, direction: 'debit', row_hash: 'c'.repeat(64),
    });
    const itemId = await connect();
    // setup: the feed must start after the statement series' last day
    await expect(activate(itemId, { 'acc-card': { accountLabel: 'capone-card', syncFrom: '2026-09-10' } }))
      .rejects.toThrow(/through 2026-09-10 — start the feed on 2026-09-11/);
    await activate(itemId, { 'acc-card': { accountLabel: 'capone-card', syncFrom: '2026-09-11' } });

    // upload: statement rows on/after the feed's start are skipped + reported
    process.env.GATE_BANK_IMPORT = 'true';
    const express = require('express');
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/admin/tax', require('../routes/admin-tax'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    const server = await new Promise(r => { const sv = app.listen(0, () => r(sv)); });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/tax/bank-import/upload`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountLabel: 'capone-card', accountType: 'card', filename: 'sept.csv',
          csv: 'Date,Description,Amount\n2026-09-09,EARLY,-4.00\n2026-09-11,COVERED,-6.00\n2026-09-12,COVERED TOO,-7.00',
        }),
      });
      const out = await res.json();
      expect(out).toMatchObject({ imported: 1, feedCovered: 2, feedLiveFrom: '2026-09-11', feedDays: [], duplicates: 0 });
      const csvRows = await mockPg('bank_transactions').where({ source: 'csv' }).orderBy('txn_date');
      expect(csvRows.map(r => r.description)).toEqual(['EARLY', 'CSV row']);

      // the feed imports 09-12..09-15, then is disconnected: those days stay
      // covered (the rows remain), later days are open to statements again
      plaid.transactionsSync.mockResolvedValueOnce(page([
        txn('t-12', 'acc-card', 7, '2026-09-12'), txn('t-15', 'acc-card', 8, '2026-09-15'),
      ], [], [], 'cursor-1'));
      await plaidSync.syncItem(itemId);
      await plaidSync.disconnectItem(itemId);
      const res2 = await fetch(`http://127.0.0.1:${server.address().port}/admin/tax/bank-import/upload`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountLabel: 'capone-card', accountType: 'card', filename: 'oct.csv',
          csv: 'Date,Description,Amount\n2026-09-12,FEED DAY,-7.00\n2026-09-13,GAP DAY,-6.00\n2026-09-15,FEED DAY 2,-8.00\n2026-09-16,AFTER FEED,-9.00',
        }),
      });
      // 09-12 and 09-15 were fed (skipped); 09-13 (no feed rows) and 09-16 import
      expect(await res2.json()).toMatchObject({ imported: 2, feedCovered: 2, feedLiveFrom: null, feedDays: ['2026-09-12', '2026-09-15'] });
      expect((await mockPg('bank_transactions').where({ source: 'csv' }).whereIn('description', ['GAP DAY', 'AFTER FEED'])).length).toBe(2);

      // a configured feed with no rows yet still fixes the label's type
      const other = await connect('-t');
      const tomorrow = new Date(`${new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })}T00:00:00Z`);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      await activate(other, { 'acc-card-t': { accountLabel: 'fresh-card', syncFrom: tomorrow.toISOString().slice(0, 10) }, 'acc-chk-t': { accountLabel: 'fresh-chk' } });
      const res3 = await fetch(`http://127.0.0.1:${server.address().port}/admin/tax/bank-import/upload`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountLabel: 'fresh-card', accountType: 'bank', filename: 'x.csv', csv: 'Date,Description,Amount\n2026-08-01,OLD,-1.00' }),
      });
      expect(res3.status).toBe(400);
      expect((await res3.json()).error).toMatch(/fed by a live bank connection as a credit card/);
    } finally {
      server.close();
      delete process.env.GATE_BANK_IMPORT;
    }
  });

  test('a re-issued account id pauses the connection for confirmation instead of skipping its transactions', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockResolvedValueOnce(page([
      txn('t-new-acct', 'acc-card-v2', 9, '2026-09-05'), txn('t-chk', 'acc-chk', 4, '2026-09-05'),
    ], [], [], 'cursor-1'));
    plaid.getAccounts.mockResolvedValueOnce({ accounts: [...ACCOUNTS, { account_id: 'acc-card-v2', name: 'Spark Card', mask: '1234', type: 'credit', subtype: 'credit card' }] });
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ skipped: 'new_accounts' });
    const item = await mockPg('plaid_items').where({ id: itemId }).first();
    expect(item).toMatchObject({ status: 'setup', sync_cursor: null });
    expect(item.last_error).toMatch(/new or re-issued account/);
    expect(await mockPg('bank_transactions').count('* as n').first()).toEqual({ n: '0' });
    const added = await mockPg('plaid_accounts').where({ account_id: 'acc-card-v2' }).first();
    expect(added).toMatchObject({ enabled: false, plaid_item_id: itemId });
    expect(added.account_label).not.toBe('capital-one-card-1234'); // no clash with the old account's label

    // operator retires the old card and feeds the re-issued one under the old label
    await activate(itemId, { 'acc-card': { enabled: false }, 'acc-card-v2': { enabled: true, accountLabel: 'capital-one-card-1234' } });
    plaid.transactionsSync.mockResolvedValueOnce(page([
      txn('t-new-acct', 'acc-card-v2', 9, '2026-09-05'), txn('t-chk', 'acc-chk', 4, '2026-09-05'),
    ], [], [], 'cursor-1'));
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ inserted: 2 });
  });

  test('a stale new-account discovery cannot pause a connection updated while it waited on Plaid', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockResolvedValueOnce(page([txn('t-new-acct', 'acc-card-v3', 9, '2026-09-05')], [], [], 'cursor-1'));
    // while this run awaits /accounts/get, a faster run registered the
    // account and the operator confirmed it (the item row moved on)
    plaid.getAccounts.mockImplementationOnce(async () => {
      await mockPg('plaid_items').where({ id: itemId }).update({ status: 'active', updated_at: mockPg.fn.now() });
      return { accounts: [...ACCOUNTS, { account_id: 'acc-card-v3', name: 'Spark Card', mask: '1234', type: 'credit', subtype: 'credit card' }] };
    });
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ skipped: 'concurrent' });
    expect(await mockPg('plaid_items').where({ id: itemId }).first('status')).toEqual({ status: 'active' });
    expect(await mockPg('plaid_accounts').where({ account_id: 'acc-card-v3' }).first()).toBeUndefined();
    await plaidSync.disconnectItem(itemId);
  });

  test('a sync that finishes after a concurrent run paused the connection for new accounts applies nothing', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockImplementationOnce(async () => {
      // the other run discovered an account and returned the item to setup
      await mockPg('plaid_items').where({ id: itemId }).update({ status: 'setup' });
      return page([txn('t-x', 'acc-chk', 4, '2026-09-05')], [], [], 'cursor-1');
    });
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ skipped: 'setup' });
    const item = await mockPg('plaid_items').where({ id: itemId }).first();
    expect(item).toMatchObject({ status: 'setup', sync_cursor: null });
    expect(await mockPg('bank_transactions').count('* as n').first()).toEqual({ n: '0' });
  });

  test('a replacement connection cannot re-import days an earlier feed of the label already covered', async () => {
    const first = await connect();
    await activate(first);
    plaid.transactionsSync.mockResolvedValueOnce(page([txn('t-old', 'acc-card', 5, '2026-09-08')], [], [], 'cursor-1'));
    await plaidSync.syncItem(first);
    await plaidSync.disconnectItem(first);

    const second = await connect('-new');
    await expect(activate(second, { 'acc-card-new': { accountLabel: 'capital-one-card-1234', syncFrom: '2026-09-01' } }))
      .rejects.toThrow(/earlier feed through 2026-09-08 — start the feed on 2026-09-09/);
    await activate(second, { 'acc-card-new': { accountLabel: 'capital-one-card-1234', syncFrom: '2026-09-09' } });
    // the feed's OWN earlier rows never block its own start date
    await mockPg('bank_transactions').where({ plaid_transaction_id: 't-old' }).update({ plaid_account_id: 'acc-card-new' });
    await activate(second, { 'acc-card-new': { accountLabel: 'capital-one-card-1234', syncFrom: '2026-09-02' } });
  });

  test('bank login errors park the item; the hourly run skips it until re-login', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockRejectedValueOnce(new plaid.PlaidError('Plaid /transactions/sync: ITEM_LOGIN_REQUIRED — log in again', { errorCode: 'ITEM_LOGIN_REQUIRED' }));
    const out = await plaidSync.syncItem(itemId);
    expect(out).toMatchObject({ status: 'login_required' });
    const item = await mockPg('plaid_items').where({ id: itemId }).first();
    expect(item.status).toBe('login_required');
    expect(item.last_error).toMatch(/ITEM_LOGIN_REQUIRED/);

    expect(await plaidSync.syncAllItems()).toEqual({ items: 0, results: [], matchingPasses: 0, matchingError: null });
    expect(await plaidSync.markReconnected(itemId)).toBe(true);
    expect((await mockPg('plaid_items').where({ id: itemId }).first()).status).toBe('active');
  });

  test('a stale login-required failure cannot re-park a connection that recovered meanwhile', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockImplementationOnce(async () => {
      // while this request hangs, another sync succeeds / the operator reconnects
      await mockPg('plaid_items').where({ id: itemId }).update({ status: 'active', last_error: null, sync_cursor: 'newer', updated_at: mockPg.fn.now() });
      throw new plaid.PlaidError('Plaid /transactions/sync: ITEM_LOGIN_REQUIRED — stale', { errorCode: 'ITEM_LOGIN_REQUIRED' });
    });
    const out = await plaidSync.syncItem(itemId);
    expect(out.status).toBeNull(); // superseded, not recorded
    const item = await mockPg('plaid_items').where({ id: itemId }).first();
    expect(item).toMatchObject({ status: 'active', last_error: null, sync_cursor: 'newer' });
  });

  test('a connection still in setup does not count as live CSV coverage', async () => {
    const itemId = await connect();
    const cov = await plaidSync.feedCoverageForLabel(mockPg, 'capital-one-card-1234', ['2026-09-20']);
    expect(cov.liveFrom).toBeNull();
    expect(cov.isCovered('2026-09-20')).toBe(false);
    await activate(itemId, { 'acc-card': { syncFrom: '2026-09-01' } });
    expect((await plaidSync.feedCoverageForLabel(mockPg, 'capital-one-card-1234', ['2026-09-20'])).isCovered('2026-09-20')).toBe(true);
  });

  test('pagination restarts from the starting cursor on a mid-pagination mutation', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync
      .mockResolvedValueOnce({ added: [txn('t-1', 'acc-card', 1, '2026-09-05')], modified: [], removed: [], next_cursor: 'p1', has_more: true })
      .mockRejectedValueOnce(new plaid.PlaidError('mutation', { errorCode: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' }))
      .mockResolvedValueOnce({ added: [txn('t-1', 'acc-card', 1, '2026-09-05')], modified: [], removed: [], next_cursor: 'p1', has_more: true })
      .mockResolvedValueOnce({ added: [txn('t-2', 'acc-card', 2, '2026-09-05')], modified: [], removed: [], next_cursor: 'p2', has_more: false });
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ inserted: 2 });
    expect(plaid.transactionsSync.mock.calls.map(c => c[1])).toEqual([null, 'p1', null, 'p1']);
    expect((await mockPg('plaid_items').where({ id: itemId }).first()).sync_cursor).toBe('p2');
  });

  test('a withdrawal for a row unlinked mid-sync is still handled (rows locked before deciding)', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockResolvedValueOnce(page([txn('t-w', 'acc-card', 10, '2026-09-05')], [], [], 'cursor-1'));
    await plaidSync.syncItem(itemId);
    const [exp] = await mockPg('expenses').insert({}).returning(['id']);
    await mockPg('bank_transactions').where({ plaid_transaction_id: 't-w' }).update({ status: 'matched_expense', matched_expense_id: exp.id });
    // an unlink holds the row when the sync reaches it, then commits
    const unlink = await mockPg.transaction();
    await unlink('bank_transactions').where({ plaid_transaction_id: 't-w' }).update({ status: 'unmatched', matched_expense_id: null });
    plaid.transactionsSync.mockResolvedValueOnce(page([], [], [{ transaction_id: 't-w' }], 'cursor-2'));
    const syncing = plaidSync.syncItem(itemId);
    await new Promise(r => setTimeout(r, 300));
    await unlink.commit();
    expect(await syncing).toMatchObject({ deleted: 1, flagged: 0 });
    expect(await mockPg('bank_transactions').where({ plaid_transaction_id: 't-w' }).first()).toBeUndefined();
  });

  test('a pagination run too large to finish commits nothing (no mid-run cursor)', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockResolvedValue({ added: [], modified: [], removed: [], next_cursor: 'mid', has_more: true });
    const out = await plaidSync.syncItem(itemId);
    plaid.transactionsSync.mockReset();
    expect(out).toMatchObject({ status: 'error' });
    expect(out.error).toMatch(/nothing applied/);
    expect((await mockPg('plaid_items').where({ id: itemId }).first()).sync_cursor).toBeNull();
  });

  test('an add and a later correction in ONE pagination run stage the final version; an unchanged re-send is a no-op', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync
      .mockResolvedValueOnce({ added: [txn('t-1', 'acc-card', 10, '2026-09-05'), txn('t-gone', 'acc-card', 3, '2026-09-05')], modified: [], removed: [], next_cursor: 'p1', has_more: true })
      .mockResolvedValueOnce({ added: [], modified: [txn('t-1', 'acc-card', 15, '2026-09-06', { name: 'FINAL' })], removed: [{ transaction_id: 't-gone' }], next_cursor: 'p2', has_more: false });
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ inserted: 1, updated: 0, flagged: 0 });
    const rows = await mockPg('bank_transactions');
    expect(rows.map(r => [r.plaid_transaction_id, Number(r.amount), r.description])).toEqual([['t-1', 15, 'FINAL']]);

    const [exp] = await mockPg('expenses').insert({}).returning(['id']);
    await mockPg('bank_transactions').where({ plaid_transaction_id: 't-1' }).update({ status: 'matched_expense', matched_expense_id: exp.id });
    plaid.transactionsSync.mockResolvedValueOnce(page([txn('t-1', 'acc-card', 15, '2026-09-06', { name: 'FINAL' })], [], [], 'p3'));
    expect(await plaidSync.syncItem(itemId)).toMatchObject({ inserted: 0, updated: 0, flagged: 0 });
    expect((await mockPg('bank_transactions').first()).suggestion).toBeNull();
  });

  test('disconnect keeps an unreadable token unless removal at Plaid is confirmed', async () => {
    const itemId = await connect();
    await activate(itemId);
    const saved = process.env.PLAID_TOKEN_KEY;
    process.env.PLAID_TOKEN_KEY = 'a-different-key';
    try {
      expect((await plaidSync.getStatus()).items[0].tokenReadable).toBe(false);
      await expect(plaidSync.disconnectItem(itemId)).rejects.toMatchObject({ status: 409 });
      const kept = await mockPg('plaid_items').where({ id: itemId }).first();
      expect(kept.status).not.toBe('removed');
      expect(kept.access_token_enc).toMatch(/BEGIN PGP MESSAGE/);
      expect(plaid.removeItem).not.toHaveBeenCalled();
      await plaidSync.disconnectItem(itemId, { confirmedRemovedAtPlaid: true });
      expect((await mockPg('plaid_items').where({ id: itemId }).first()).status).toBe('removed');
    } finally {
      process.env.PLAID_TOKEN_KEY = saved;
    }
  });

  test('enabling an account or moving its start date earlier restarts the feed from scratch', async () => {
    const itemId = await connect();
    await activate(itemId);
    await mockPg('plaid_items').where({ id: itemId }).update({ sync_cursor: 'cursor-9' });
    await activate(itemId, { 'acc-card': { syncFrom: '2026-09-02' } }); // later: keep cursor
    expect((await mockPg('plaid_items').where({ id: itemId }).first()).sync_cursor).toBe('cursor-9');
    await activate(itemId, { 'acc-loan': { enabled: true } });
    expect((await mockPg('plaid_items').where({ id: itemId }).first()).sync_cursor).toBeNull();
  });

  test('disconnect revokes at Plaid, drops the token, and keeps imported rows', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockResolvedValueOnce(page([txn('t-keep', 'acc-card', 5, '2026-09-05')]));
    await plaidSync.syncItem(itemId);
    await plaidSync.disconnectItem(itemId);
    expect(plaid.removeItem).toHaveBeenCalledWith('access-sandbox-secret');
    const item = await mockPg('plaid_items').where({ id: itemId }).first();
    expect(item).toMatchObject({ status: 'removed', access_token_enc: null, sync_cursor: null });
    expect(await mockPg('bank_transactions').count('* as n').first()).toEqual({ n: '1' });
    expect((await plaidSync.getStatus()).items).toEqual([]);
  });
});

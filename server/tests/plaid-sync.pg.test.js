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
  runDeterministicMatching: jest.fn(async () => ({ payoutsLinked: 0, expensesLinked: 0, ambiguous: 0 })),
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

async function connect() {
  plaid.exchangePublicToken.mockResolvedValueOnce({ accessToken: 'access-sandbox-secret', itemId: `item-${Date.now()}-${Math.random()}` });
  plaid.getAccounts.mockResolvedValueOnce({ accounts: ACCOUNTS, institutionId: 'ins_128026' });
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
    await expect(activate(itemId, { 'acc-card': { syncFrom: '2999-01-01' } })).rejects.toThrow(/future/);
    expect((await mockPg('plaid_items').where({ id: itemId }).first()).status).toBe('setup');
    await activate(itemId, { 'acc-chk': { accountLabel: 'capone-checking' } });
    expect((await mockPg('plaid_items').where({ id: itemId }).first()).status).toBe('active');
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
    expect(out).toMatchObject({ inserted: 3, complete: true });
    expect(out.skipped).toEqual({ pending: 1, before_sync_from: 1, account_disabled: 1, currency: 1 });
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

  test('bank login errors park the item; the hourly run skips it until re-login', async () => {
    const itemId = await connect();
    await activate(itemId);
    plaid.transactionsSync.mockRejectedValueOnce(new plaid.PlaidError('Plaid /transactions/sync: ITEM_LOGIN_REQUIRED — log in again', { errorCode: 'ITEM_LOGIN_REQUIRED' }));
    const out = await plaidSync.syncItem(itemId);
    expect(out).toMatchObject({ status: 'login_required' });
    const item = await mockPg('plaid_items').where({ id: itemId }).first();
    expect(item.status).toBe('login_required');
    expect(item.last_error).toMatch(/ITEM_LOGIN_REQUIRED/);

    expect(await plaidSync.syncAllItems()).toEqual({ items: 0, results: [] });
    expect(await plaidSync.markReconnected(itemId)).toBe(true);
    expect((await mockPg('plaid_items').where({ id: itemId }).first()).status).toBe('active');
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

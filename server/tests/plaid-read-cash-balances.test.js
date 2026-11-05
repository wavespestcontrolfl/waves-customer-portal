/**
 * readCashBalances (Cash today card, GATE_CASH_FORECAST): read-only balances
 * from Plaid's FREE /accounts/get. No DATABASE_URL needed: the db is a
 * chainable fake that fails the test on any write.
 */
process.env.PLAID_TOKEN_KEY = 'synthetic-test-key';

const mockState = { items: [], accounts: [], decrypt: {}, calls: [] };

function mockMakeChain(table) {
  const chain = {};
  const result = () => (table === 'plaid_items' ? mockState.items : mockState.accounts);
  chain.where = jest.fn((cond) => {
    if (table === 'plaid_accounts') {
      mockState.calls.push({ table, where: cond });
      const rows = mockState.accounts.filter(a => (
        (!cond.plaid_item_id || a.plaid_item_id === cond.plaid_item_id)
        && (cond.enabled === undefined || a.enabled === cond.enabled)
      ));
      return Object.assign(Promise.resolve(rows), {});
    }
    return chain;
  });
  chain.whereNotIn = jest.fn((col, vals) => {
    mockState.calls.push({ table, whereNotIn: [col, vals] });
    return chain;
  });
  chain.orderBy = jest.fn(() => Promise.resolve(result()));
  for (const w of ['insert', 'update', 'del', 'delete', 'truncate']) {
    chain[w] = jest.fn(() => { throw new Error(`write attempted: ${table}.${w}`); });
  }
  return chain;
}

jest.mock('../models/db', () => {
  const db = jest.fn((table) => mockMakeChain(table));
  db.raw = jest.fn(async (_sql, bindings) => ({ rows: [{ t: mockState.decrypt[bindings[0]] || null }] }));
  db.transaction = jest.fn(() => { throw new Error('write attempted: transaction'); });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/plaid-client', () => ({
  getAccounts: jest.fn(),
  transactionsSync: jest.fn(),
  isConfigured: jest.fn(() => true),
  plaidEnv: jest.fn(() => 'test'),
}));

const plaid = require('../services/plaid-client');
const plaidSync = require('../services/plaid-sync');

function item(over = {}) {
  return { id: 'item-1', institution_name: 'Synthetic Bank', status: 'active', access_token_enc: 'enc-1', ...over };
}
function stored(over = {}) {
  return {
    plaid_item_id: 'item-1', account_id: 'acc-1', name: 'Synthetic Checking', mask: '1111',
    account_label: 'Synthetic Checking', account_type: 'bank', enabled: true, ...over,
  };
}

describe('readCashBalances', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockState.items = [];
    mockState.accounts = [];
    mockState.decrypt = { 'enc-1': 'access-token-1', 'enc-2': 'access-token-2' };
    mockState.calls = [];
  });

  test('is exported', () => {
    expect(typeof plaidSync.readCashBalances).toBe('function');
  });

  test('skips removed and setup connections in the query', async () => {
    await plaidSync.readCashBalances();
    expect(mockState.calls[0].whereNotIn).toEqual(['status', ['removed', 'setup']]);
  });

  test('login_required skips the Plaid call', async () => {
    mockState.items = [item({ status: 'login_required' })];
    const out = await plaidSync.readCashBalances();
    expect(plaid.getAccounts).not.toHaveBeenCalled();
    expect(out).toEqual({ accounts: [], cards: [], unavailable: [{ institution_name: 'Synthetic Bank', reason: 'login_required' }] });
  });

  test('an unreadable token is token_unreadable and Plaid is not called', async () => {
    mockState.items = [item({ access_token_enc: 'enc-unknown' })];
    const out = await plaidSync.readCashBalances();
    expect(plaid.getAccounts).not.toHaveBeenCalled();
    expect(out.unavailable).toEqual([{ institution_name: 'Synthetic Bank', reason: 'token_unreadable' }]);
  });

  test('matches by account_id; disabled and unknown accounts are ignored', async () => {
    mockState.items = [item()];
    mockState.accounts = [
      stored(),
      stored({ account_id: 'acc-off', mask: '2222', enabled: false }),
      stored({ account_id: 'acc-card', mask: '3333', name: 'Synthetic Card', account_label: 'Synthetic Card', account_type: 'card' }),
      stored({ account_id: 'acc-missing', mask: '4444' }),
      stored({ plaid_item_id: 'other-item', account_id: 'acc-other', mask: '5555' }),
    ];
    plaid.getAccounts.mockResolvedValue({
      accounts: [
        { account_id: 'acc-1', balances: { available: 100.5, current: 120, iso_currency_code: 'USD', last_updated_datetime: '2026-11-05T13:00:00Z' } },
        { account_id: 'acc-off', balances: { available: 1, current: 1 } },
        { account_id: 'acc-card', balances: { available: 4000, current: 250.75, iso_currency_code: null } },
        { account_id: 'acc-unknown', balances: { available: 9, current: 9 } },
      ],
    });
    const out = await plaidSync.readCashBalances();
    expect(plaid.getAccounts).toHaveBeenCalledTimes(1);
    expect(plaid.getAccounts).toHaveBeenCalledWith('access-token-1');
    expect(out.unavailable).toEqual([]);
    expect(out.accounts).toEqual([{
      name: 'Synthetic Checking', mask: '1111', account_label: 'Synthetic Checking', account_type: 'bank',
      available: 100.5, current: 120, currency: 'USD', balance_as_of: '2026-11-05T13:00:00Z',
    }]);
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]).toMatchObject({ mask: '3333', account_type: 'card', current: 250.75, currency: 'USD', balance_as_of: null });
  });

  test('a null available balance stays null so the caller can fall back to current', async () => {
    mockState.items = [item()];
    mockState.accounts = [stored()];
    plaid.getAccounts.mockResolvedValue({ accounts: [{ account_id: 'acc-1', balances: { available: null, current: 42 } }] });
    const out = await plaidSync.readCashBalances();
    expect(out.accounts[0]).toMatchObject({ available: null, current: 42 });
  });

  test('a Plaid error is unavailable for that connection and the next one still reads', async () => {
    mockState.items = [item(), item({ id: 'item-2', institution_name: 'Second Bank', access_token_enc: 'enc-2' })];
    mockState.accounts = [stored({ plaid_item_id: 'item-2', account_id: 'acc-2', mask: '6666' })];
    plaid.getAccounts
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { errorCode: 'INTERNAL_SERVER_ERROR' }))
      .mockResolvedValueOnce({ accounts: [{ account_id: 'acc-2', balances: { available: 5, current: 5 } }] });
    const out = await plaidSync.readCashBalances();
    expect(out.unavailable).toEqual([{ institution_name: 'Synthetic Bank', reason: 'error' }]);
    expect(out.accounts.map(a => a.mask)).toEqual(['6666']);
  });

  test('a login-required Plaid error maps to login_required', async () => {
    mockState.items = [item()];
    plaid.getAccounts.mockRejectedValue(Object.assign(new Error('login'), { errorCode: 'ITEM_LOGIN_REQUIRED' }));
    const out = await plaidSync.readCashBalances();
    expect(out.unavailable).toEqual([{ institution_name: 'Synthetic Bank', reason: 'login_required' }]);
  });

  test('never calls the paid balance read and never writes', async () => {
    mockState.items = [item(), item({ id: 'item-2', status: 'login_required' })];
    mockState.accounts = [stored()];
    plaid.getAccounts.mockResolvedValue({ accounts: [{ account_id: 'acc-1', balances: { available: 1, current: 1 } }] });
    await expect(plaidSync.readCashBalances()).resolves.toBeDefined();
    // plaid-sync reaches Plaid only through the mocked client; the paid
    // /accounts/balance/get read is never called from plaid-sync (comments may name it).
    const fs = require('fs');
    const path = require('path');
    for (const f of ['../services/plaid-sync.js']) {
      expect(fs.readFileSync(path.join(__dirname, f), 'utf8')).not.toMatch(/['"`]\/accounts\/balance\/get['"`]|plaid\.getBalance\(/);
    }
  });
});

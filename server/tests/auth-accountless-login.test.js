/**
 * Login for customers created without the account layer (public estimate
 * accept, self-book, public quote, lead/twilio webhooks, call pipeline):
 * customers.account_id is NULL and no customer_accounts row exists. Since
 * 20260716000000 the refresh-session insert carries a NOT NULL FK on
 * account_id, so verify-code logins for these customers threw an FK
 * violation into the 500 handler AFTER Twilio approved the SMS code.
 * createRefreshSession must adopt the customer as their own account (the
 * 20260504000008 self-adoption) instead of failing the login.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { createRefreshSession } = require('../middleware/auth');

function matches(row, filters) {
  return filters.every(([kind, value]) => {
    if (kind === 'where') {
      return Object.entries(value).every(([key, expected]) => String(row[key]) === String(expected));
    }
    if (kind === 'null') return row[value] == null;
    return true;
  });
}

// In-memory db that ENFORCES the customer_refresh_tokens.account_id FK the
// way Postgres does, so the adoption path is exercised for real: without it,
// an account-less login must throw exactly like prod did.
function installMemoryDb({ customers, accounts }) {
  const refreshRows = [];

  class Builder {
    constructor(table) {
      this.table = table;
      this.filters = [];
    }

    rows() {
      if (this.table === 'customers') return customers;
      if (this.table === 'customer_accounts') return accounts;
      return refreshRows;
    }

    where(value, expected) {
      this.filters.push(['where', typeof value === 'object' ? value : { [value]: expected }]);
      return this;
    }

    whereNull(column) {
      this.filters.push(['null', column]);
      return this;
    }

    async first() {
      return this.rows().find((row) => matches(row, this.filters));
    }

    insert(value) {
      const perform = async () => {
        if (this.table === 'customer_accounts') {
          if (accounts.some((row) => String(row.id) === String(value.id))) {
            if (this.ignoreConflict) return [];
            throw new Error('duplicate customer_accounts id');
          }
          accounts.push({ ...value });
          return [value];
        }
        if (this.table === 'customer_refresh_tokens') {
          if (!accounts.some((row) => String(row.id) === String(value.account_id))) {
            const err = new Error(
              'insert or update on table "customer_refresh_tokens" violates foreign key constraint "customer_refresh_tokens_account_id_foreign"',
            );
            err.code = '23503';
            throw err;
          }
          refreshRows.push({ ...value });
          return [value];
        }
        throw new Error(`Unexpected insert ${this.table}`);
      };
      const chain = {
        onConflict: () => chain,
        ignore: () => { this.ignoreConflict = true; return chain; },
        returning: () => perform(),
        then: (resolve, reject) => perform().then(resolve, reject),
      };
      return chain;
    }

    async update(value) {
      const found = this.rows().filter((row) => matches(row, this.filters));
      found.forEach((row) => Object.assign(row, value));
      return found.length;
    }
  }

  db.mockImplementation((table) => new Builder(table));
  db.transaction = jest.fn(async (callback) => callback(db));
  return { refreshRows, accounts, customers };
}

describe('createRefreshSession for account-less customers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const accountlessCustomer = () => ({
    id: '22222222-2222-4222-8222-222222222222',
    account_id: null,
    first_name: 'Jordan',
    last_name: 'Rivera',
    email: 'jordan@example.com',
    phone: '+19096105433',
    company_name: null,
    profile_label: null,
    is_primary_profile: false,
    active: true,
    deleted_at: null,
  });

  test('adopts the customer as their own account instead of failing the FK', async () => {
    const customer = accountlessCustomer();
    const state = installMemoryDb({ customers: [customer], accounts: [] });

    const session = await createRefreshSession(customer.id, customer.account_id || customer.id);

    expect(session.refreshToken).toBeTruthy();
    expect(state.refreshRows).toHaveLength(1);
    expect(String(state.refreshRows[0].account_id)).toBe(customer.id);

    // The adoption mirrors the 20260504000008 backfill.
    expect(state.accounts).toHaveLength(1);
    expect(state.accounts[0]).toMatchObject({
      id: customer.id,
      first_name: 'Jordan',
      phone: '+19096105433',
    });
    expect(customer.account_id).toBe(customer.id);
    expect(customer.is_primary_profile).toBe(true);
    expect(customer.profile_label).toBe('Primary');
  });

  test('second login of an adopted customer does not duplicate the account', async () => {
    const customer = accountlessCustomer();
    const state = installMemoryDb({ customers: [customer], accounts: [] });

    await createRefreshSession(customer.id, customer.account_id || customer.id);
    await createRefreshSession(customer.id, customer.account_id || customer.id);

    expect(state.accounts).toHaveLength(1);
    expect(state.refreshRows).toHaveLength(2);
  });

  test('a customer with a real account is left untouched', async () => {
    const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const customer = { ...accountlessCustomer(), account_id: accountId, is_primary_profile: true, profile_label: 'Primary' };
    const state = installMemoryDb({
      customers: [customer],
      accounts: [{ id: accountId, first_name: 'Jordan' }],
    });

    const session = await createRefreshSession(customer.id, accountId);

    expect(session.refreshToken).toBeTruthy();
    expect(state.accounts).toHaveLength(1);
    expect(String(state.refreshRows[0].account_id)).toBe(accountId);
  });
});

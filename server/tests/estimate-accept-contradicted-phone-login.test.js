process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// B18 quarantine: a contradicted accept stores the new profile WITHOUT the disputed
// phone (customers.phone = ''), so portal login (activeCustomerByPhone) can never
// resolve it by that number, whether or not the other customer is active. This runs
// the REAL activeCustomerByPhone against an in-memory customers table that applies
// its filters (deleted_at, admissible, last-10 phone match, ordering). The accept
// itself is covered in estimate-public-accept-atomicity.test.js (new profile phone '').

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { activeCustomerByPhone } = require('../routes/auth')._private;

const digitsOf = (v) => String(v || '').replace(/\D/g, '');

function installCustomers(rows) {
  db.mockImplementation((table) => {
    if (table !== 'customers') throw new Error(`unexpected table ${table}`);
    const preds = [];
    const orders = [];
    let max = Infinity;
    const b = {
      whereNull(col) { preds.push((r) => r[col] == null); return b; },
      // The one function-form where is the admissible-status predicate.
      where() { preds.push((r) => r.active === true || (r.active === false && r.pipeline_stage === 'churned')); return b; },
      whereRaw(sql, [pattern]) {
        const want = String(pattern).replace(/^%/, '');
        preds.push((r) => digitsOf(r.phone).endsWith(want));
        return b;
      },
      orderBy(col, dir) { orders.push([col, dir]); return b; },
      limit(n) { max = n; return b; },
      then(resolve, reject) {
        const out = rows.filter((r) => preds.every((p) => p(r)));
        out.sort((x, y) => {
          for (const [col, dir] of orders) {
            const a = x[col]; const c = y[col];
            if (a === c) continue;
            const cmp = a > c ? 1 : -1;
            return dir === 'desc' ? -cmp : cmp;
          }
          return 0;
        });
        return Promise.resolve(out.slice(0, max)).then(resolve, reject);
      },
    };
    return b;
  });
}

// The two rows a contradicted accept leaves behind (new profile stored WITHOUT the phone).
const rejected = (overrides = {}) => ({
  id: 'cust-bob', account_id: 'acct-bob', first_name: 'Bob', phone: '(941) 555-0123', active: true,
  pipeline_stage: 'active_customer', is_primary_profile: true, created_at: '2026-01-01', deleted_at: null, ...overrides,
});
const quarantined = (overrides = {}) => ({
  id: 'cust-pat', account_id: 'acct-pat', first_name: 'Pat', phone: '', active: true,
  pipeline_stage: 'active_customer', is_primary_profile: true, created_at: '2026-10-03', deleted_at: null, ...overrides,
});

describe('login by the disputed phone after a contradicted accept', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejected customer active: login by that phone resolves the existing customer, never the new profile', async () => {
    installCustomers([rejected(), quarantined()]);
    const found = await activeCustomerByPhone('+19415550123');
    expect(found.id).toBe('cust-bob');
  });

  it('rejected customer INACTIVE: login by that phone resolves nobody (the new profile is not reachable by it)', async () => {
    installCustomers([rejected({ active: false, pipeline_stage: 'inactive' }), quarantined()]);
    expect(await activeCustomerByPhone('+19415550123')).toBeNull();
  });

  it('rejected customer later deactivated: still nobody', async () => {
    const bob = rejected();
    installCustomers([bob, quarantined()]);
    expect((await activeCustomerByPhone('+19415550123')).id).toBe('cust-bob');
    bob.active = false;
    bob.pipeline_stage = 'inactive';
    expect(await activeCustomerByPhone('+19415550123')).toBeNull();
  });

  it('control (the pre-quarantine shape): a new profile carrying the disputed phone WOULD win once the other customer is inactive', async () => {
    installCustomers([rejected({ active: false, pipeline_stage: 'inactive' }), quarantined({ phone: '9415550123' })]);
    expect((await activeCustomerByPhone('+19415550123')).id).toBe('cust-pat');
  });

  it('the new profile signs in normally once the office adds its real number', async () => {
    installCustomers([rejected(), quarantined({ phone: '(941) 555-0188' })]);
    expect((await activeCustomerByPhone('+19415550188')).id).toBe('cust-pat');
  });
});

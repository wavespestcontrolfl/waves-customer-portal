/**
 * Estimate hero contact block — read-time fallback to the linked customer /
 * lead record when the estimate row was minted without email/phone/address,
 * plus the legacy "First undefined" stored-name cleanup.
 */

const mockDb = jest.fn();
mockDb.schema = { hasTable: jest.fn(async () => true) };
jest.mock('../models/db', () => mockDb);

const { cleanStoredName, resolveEstimateContactFields } = require('../routes/estimate-public');

// Minimal knex-ish stub: conn(table).where(...).whereNull(...).orderBy(...)
// .first(...) resolves to the fixture row for that table (or null). Tracks
// which tables were queried and which columns got whereNull filters.
function makeConn(tables, queried = [], whereNullCols = []) {
  return (tableName) => {
    queried.push(tableName);
    const chain = {
      where: () => chain,
      whereNull: (col) => { whereNullCols.push(`${tableName}.${col}`); return chain; },
      orderBy: () => chain,
      first: async () => (tables[tableName] === undefined ? null : tables[tableName]),
    };
    return chain;
  };
}

describe('cleanStoredName', () => {
  test('strips literal undefined/null tokens baked into stored names', () => {
    expect(cleanStoredName('Deborah undefined')).toBe('Deborah');
    expect(cleanStoredName('Deborah null')).toBe('Deborah');
    expect(cleanStoredName('Deborah NULL')).toBe('Deborah');
    expect(cleanStoredName('undefined')).toBe('');
    expect(cleanStoredName(null)).toBe('');
    expect(cleanStoredName(undefined)).toBe('');
  });

  test('leaves real names alone', () => {
    expect(cleanStoredName('Deborah')).toBe('Deborah');
    expect(cleanStoredName('Mary Anne Smith')).toBe('Mary Anne Smith');
    expect(cleanStoredName('  Deborah  Smith ')).toBe('Deborah Smith');
  });
});

describe('resolveEstimateContactFields', () => {
  const CUSTOMER = {
    first_name: 'Deborah', last_name: null,
    email: 'deb@example.com', phone: '+19415551234',
    address_line1: '123 Palm Ave', address_line2: null,
    city: 'Venice', state: 'FL', zip: '34285',
  };

  test('estimate columns stay authoritative when fully set — no lookups fire', async () => {
    const queried = [];
    const out = await resolveEstimateContactFields({
      id: 'est-1', customer_id: 'cust-1',
      customer_name: 'Deborah', customer_email: 'other@example.com',
      customer_phone: '9415550000', address: '9 Beach Rd, Venice, FL 34285',
    }, { database: makeConn({ customers: CUSTOMER }, queried) });
    expect(out).toEqual({
      customerName: 'Deborah',
      customerEmail: 'other@example.com',
      customerPhone: '9415550000',
      address: '9 Beach Rd, Venice, FL 34285',
    });
    expect(queried).toEqual([]);
  });

  test('linked customer fills missing email/phone/address (first-name-only customer)', async () => {
    const out = await resolveEstimateContactFields({
      id: 'est-1', customer_id: 'cust-1',
      customer_name: 'Deborah', customer_email: null,
      customer_phone: null, address: null,
    }, { database: makeConn({ customers: CUSTOMER, leads: null }) });
    expect(out).toEqual({
      customerName: 'Deborah',
      customerEmail: 'deb@example.com',
      customerPhone: '+19415551234',
      address: '123 Palm Ave, Venice, FL 34285',
    });
  });

  test('linked lead fills gaps when there is no customer record', async () => {
    const out = await resolveEstimateContactFields({
      id: 'est-1', customer_id: null,
      customer_name: null, customer_email: null, customer_phone: '9415550000', address: null,
    }, {
      database: makeConn({
        leads: {
          first_name: 'Deborah', last_name: 'undefined',
          email: 'deb@example.com', phone: '9415550000',
          address: '123 Palm Ave, Venice, FL 34285',
        },
      }),
    });
    expect(out).toEqual({
      customerName: 'Deborah',
      customerEmail: 'deb@example.com',
      customerPhone: '9415550000',
      address: '123 Palm Ave, Venice, FL 34285',
    });
  });

  test('street-less customer address (default city/state only) does not block the lead fallback', async () => {
    const out = await resolveEstimateContactFields({
      id: 'est-1', customer_id: 'cust-1',
      customer_name: 'Deborah', customer_email: null, customer_phone: null, address: null,
    }, {
      database: makeConn({
        customers: { ...CUSTOMER, address_line1: '   ', city: 'Bradenton', state: 'FL', zip: null },
        leads: {
          first_name: 'Deborah', last_name: null,
          email: null, phone: null,
          address: '55 Shell Rd, Bradenton, FL 34205',
        },
      }),
    });
    expect(out.address).toBe('55 Shell Rd, Bradenton, FL 34205');
    expect(out.customerEmail).toBe('deb@example.com');
  });

  test('lead fallback excludes soft-deleted leads', async () => {
    const whereNullCols = [];
    await resolveEstimateContactFields({
      id: 'est-1', customer_id: null,
      customer_name: null, customer_email: null, customer_phone: null, address: null,
    }, { database: makeConn({ leads: null }, [], whereNullCols) });
    expect(whereNullCols).toContain('leads.deleted_at');
  });

  test('stored "First undefined" estimate name is cleaned even with no linked records', async () => {
    const out = await resolveEstimateContactFields({
      id: 'est-1', customer_id: null,
      customer_name: 'Deborah undefined', customer_email: 'deb@example.com',
      customer_phone: '9415550000', address: '123 Palm Ave, Venice, FL 34285',
    }, { database: makeConn({ leads: null }) });
    expect(out.customerName).toBe('Deborah');
  });

  test('fails open on lookup error — renders whatever the estimate row has', async () => {
    const throwingConn = () => { throw new Error('db down'); };
    const out = await resolveEstimateContactFields({
      id: 'est-1', customer_id: 'cust-1',
      customer_name: 'Deborah', customer_email: null, customer_phone: null, address: null,
    }, { database: throwingConn });
    expect(out).toEqual({
      customerName: 'Deborah',
      customerEmail: null,
      customerPhone: null,
      address: null,
    });
  });
});

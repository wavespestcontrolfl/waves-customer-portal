const knex = require('knex');
const {
  applyCustomerNameOrder,
  applyCustomerSearchFilter,
  applyStableCustomerOrder,
} = require('../services/customer-list-search');

const connection = process.env.C360_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;

const rows = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    first_name: 'Zoë-Exact',
    last_name: 'O’Test',
    email: 'exact@example.invalid',
    phone: '+1 202 555 0101',
    address_line1: '1 Synthetic Way',
    city: 'Fixture City',
    state: 'FL',
    zip: '00001',
    company_name: 'Exact Fixture',
    lead_score: 10,
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    first_name: 'O-Test',
    last_name: 'Alpha',
    email: 'first@example.invalid',
    phone: '+1 202 555 0102',
    address_line1: '2 Synthetic Way',
    city: 'Fixture City',
    state: 'FL',
    zip: '00002',
    company_name: 'First Fixture',
    lead_score: 20,
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    first_name: 'Prefix',
    last_name: "O'Testing",
    email: 'prefix@example.invalid',
    phone: '+1 202 555 0103',
    address_line1: '3 Synthetic Way',
    city: 'Fixture City',
    state: 'FL',
    zip: '00003',
    company_name: 'Prefix Fixture',
    lead_score: 10,
  },
  {
    id: '00000000-0000-4000-8000-000000000004',
    first_name: 'Incidental',
    last_name: 'Match',
    email: 'incidental@example.invalid',
    phone: '+1 202 555 0104',
    address_line1: '4 OTest Lane',
    city: 'Fixture City',
    state: 'FL',
    zip: '00004',
    company_name: 'Incidental Fixture',
    lead_score: 10,
  },
  {
    id: '00000000-0000-4000-8000-000000000005',
    first_name: 'Contact',
    last_name: 'Fallback',
    email: 'literal_%@example.invalid',
    phone: '+1 (941) 555-0100',
    address_line1: '5 Contact Lane',
    city: 'Fixture City',
    state: 'FL',
    zip: '00005',
    company_name: 'Contact Fixture',
    lead_score: 10,
  },
  {
    id: '00000000-0000-4000-8000-000000000006',
    first_name: 'Wildcard',
    last_name: 'Control',
    email: 'literal-ax@example.invalid',
    phone: '+1 202 555 0106',
    address_line1: '6 Synthetic Way',
    city: 'Fixture City',
    state: 'FL',
    zip: '00006',
    company_name: 'Wildcard Fixture',
    lead_score: 10,
  },
  {
    id: '00000000-0000-4000-8000-000000000010',
    first_name: 'Page',
    last_name: 'Boundary',
    email: 'page-10@example.invalid',
    phone: '+1 202 555 0110',
    address_line1: '10 Synthetic Way',
    city: 'Fixture City',
    state: 'FL',
    zip: '00010',
    company_name: 'Paging Fixture',
    lead_score: 30,
  },
  {
    id: '00000000-0000-4000-8000-000000000011',
    first_name: 'Page',
    last_name: 'Boundary',
    email: 'page-11@example.invalid',
    phone: '+1 202 555 0111',
    address_line1: '11 Synthetic Way',
    city: 'Fixture City',
    state: 'FL',
    zip: '00011',
    company_name: 'Paging Fixture',
    lead_score: 30,
  },
];

async function withCustomers(work) {
  return database.transaction(async (trx) => {
    await trx.raw(`
      CREATE TEMP TABLE customers (
        id uuid PRIMARY KEY,
        first_name text,
        last_name text,
        company_name text,
        phone text,
        email text,
        address_line1 text,
        address_line2 text,
        city text,
        state text,
        zip text,
        account_id text,
        profile_label text,
        lead_score integer
      ) ON COMMIT DROP
    `);
    await trx('customers').insert(rows);
    return work(trx);
  });
}

async function matchingIds(trx, search) {
  const query = applyCustomerSearchFilter(trx('customers').select('customers.id'), search);
  return (await applyCustomerNameOrder(query, search)).map((row) => row.id);
}

postgres('customer list search PostgreSQL behavior', () => {
  beforeAll(() => {
    const databaseName = decodeURIComponent(new URL(connection).pathname.replace(/^\/+/, ''));
    if (!/^waves_qa_[a-f0-9]{32}$/.test(databaseName) || process.env.RAILWAY_ENVIRONMENT === 'production') {
      throw new Error('Customer search integration tests require a verified private waves_qa_<32hex> database');
    }
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
  });

  afterAll(async () => {
    if (database) await database.destroy();
  });

  test('orders exact and reversed punctuation-normalized Unicode names ahead of lesser name and incidental matches', async () => {
    await withCustomers(async (trx) => {
      expect(await matchingIds(trx, "O'Test Zoë Exact")).toEqual([
        '00000000-0000-4000-8000-000000000001',
      ]);
      expect(await matchingIds(trx, "Zoë-Exact O'Test")).toEqual([
        '00000000-0000-4000-8000-000000000001',
      ]);
      expect(await matchingIds(trx, 'OTest')).toEqual([
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003',
        '00000000-0000-4000-8000-000000000004',
      ]);
      expect(await matchingIds(trx, 'Zoë Exact')).toEqual([
        '00000000-0000-4000-8000-000000000001',
      ]);
    });
  });

  test('keeps address, phone, and email fallbacks while treating wildcard characters literally', async () => {
    await withCustomers(async (trx) => {
      expect(await matchingIds(trx, '4 OTest Lane')).toEqual([
        '00000000-0000-4000-8000-000000000004',
      ]);
      expect(await matchingIds(trx, '9415550100')).toEqual([
        '00000000-0000-4000-8000-000000000005',
      ]);
      expect(await matchingIds(trx, 'literal_%')).toEqual([
        '00000000-0000-4000-8000-000000000005',
      ]);
      expect(await matchingIds(trx, 'literal-ax@example.invalid')).toEqual([
        '00000000-0000-4000-8000-000000000006',
      ]);
    });
  });

  test('uses stable id page boundaries and preserves an explicit non-name primary sort', async () => {
    await withCustomers(async (trx) => {
      const firstPage = await applyCustomerNameOrder(
        applyCustomerSearchFilter(trx('customers').select('customers.id'), 'Boundary'),
        'Boundary',
      ).limit(1);
      const secondPage = await applyCustomerNameOrder(
        applyCustomerSearchFilter(trx('customers').select('customers.id'), 'Boundary'),
        'Boundary',
      ).limit(1).offset(1);
      expect(firstPage[0].id).toBe('00000000-0000-4000-8000-000000000010');
      expect(secondPage[0].id).toBe('00000000-0000-4000-8000-000000000011');

      const scoreOrder = await applyStableCustomerOrder(
        trx('customers')
          .whereIn('customers.id', [
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000002',
            '00000000-0000-4000-8000-000000000010',
            '00000000-0000-4000-8000-000000000011',
          ])
          .select('customers.id', 'customers.lead_score')
          .orderBy('customers.lead_score', 'desc'),
      );
      expect(scoreOrder.map((row) => [row.lead_score, row.id])).toEqual([
        [30, '00000000-0000-4000-8000-000000000010'],
        [30, '00000000-0000-4000-8000-000000000011'],
        [20, '00000000-0000-4000-8000-000000000002'],
        [10, '00000000-0000-4000-8000-000000000001'],
      ]);
    });
  });
});

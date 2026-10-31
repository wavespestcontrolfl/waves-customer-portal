/**
 * Public quote wizard — GATE_QUOTE_SAME_PERSON_MATCH.
 *
 * 2026-10-30: one person ran the wizard 5 times in 15 minutes. The typed phone
 * already matched 2 rows of that person at the same address, so the ambiguity
 * rule (r88 P1) returned null and the post-pricing upsert inserted a new
 * customers row on every run. The route inserts only when the lookup returns
 * null, so the lookup result is the insert decision.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { _internals } = require('../routes/public-quote');

const { findExistingCustomerByContact } = _internals;
const CONTACT = { contactPhone: '(941) 555-0199', contactEmail: 'jane@example.com' };
const TYPED = {
  first_name: 'Jane', last_name: 'Sample', address_line1: '123 Sample St', address_line2: null, city: 'Parrish', zip: '34219',
};
const row = (id, over = {}) => ({
  id,
  first_name: 'Jane',
  last_name: 'Sample',
  address_line1: '123 Sample Street',
  address_line2: null,
  city: 'Parrish',
  zip: '34219',
  pipeline_stage: 'new_lead',
  active: true,
  deleted_at: null,
  created_at: '2026-10-01T00:00:00Z',
  ...over,
});

// Phone probe: limit(2) returns the first two, limit(11) the cluster fetch.
function fakeDb(phoneRows, emailRows = []) {
  const limits = [];
  const db = () => {
    let phoneQuery = false;
    let emailQuery = false;
    const chain = {
      whereRaw: (sql) => {
        phoneQuery = phoneQuery || sql.includes('regexp_replace');
        emailQuery = emailQuery || sql.includes('LOWER(email)');
        return chain;
      },
      whereNull: () => chain,
      limit: (n) => { limits.push(n); chain.n = n; return chain; },
      select: async () => (emailQuery ? emailRows : phoneRows.slice(0, chain.n)),
      whereIn: () => chain,
      groupBy: () => chain,
      count: async () => [],
    };
    return chain;
  };
  db.limits = limits;
  return db;
}

describe('findExistingCustomerByContact with GATE_QUOTE_SAME_PERSON_MATCH', () => {
  const saved = process.env.GATE_QUOTE_SAME_PERSON_MATCH;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_QUOTE_SAME_PERSON_MATCH;
    else process.env.GATE_QUOTE_SAME_PERSON_MATCH = saved;
  });

  const twoSamePerson = [
    row('web', { created_at: '2026-10-29T10:00:00Z' }),
    row('inspection', { created_at: '2026-10-28T10:00:00Z' }),
  ];

  test('gate off + 2 matches: null, so the route inserts a new customers row (old behavior)', async () => {
    delete process.env.GATE_QUOTE_SAME_PERSON_MATCH;
    const db = fakeDb(twoSamePerson);
    expect(await findExistingCustomerByContact(db, CONTACT, TYPED)).toBeNull();
    expect(db.limits).toEqual([2]);
    process.env.GATE_QUOTE_SAME_PERSON_MATCH = 'yes';
    expect(await findExistingCustomerByContact(fakeDb(twoSamePerson), CONTACT, TYPED)).toBeNull();
  });

  test('gate on + 2 same-person rows at the typed address: the winner row, so the route inserts nothing', async () => {
    process.env.GATE_QUOTE_SAME_PERSON_MATCH = 'true';
    const db = fakeDb(twoSamePerson);
    const found = await findExistingCustomerByContact(db, CONTACT, TYPED);
    expect(found.id).toBe('inspection'); // equal business weight: the older row
    expect(db.limits).toEqual([2, 11]);
  });

  test('gate on + rows that do not all match: null, so the route inserts as before', async () => {
    process.env.GATE_QUOTE_SAME_PERSON_MATCH = 'true';
    const otherName = [row('a'), row('b', { first_name: 'Joan' })];
    const otherStreet = [row('a'), row('b', { address_line1: '9 Other Ave' })];
    expect(await findExistingCustomerByContact(fakeDb(otherName), CONTACT, TYPED)).toBeNull();
    expect(await findExistingCustomerByContact(fakeDb(otherStreet), CONTACT, TYPED)).toBeNull();
    expect(await findExistingCustomerByContact(fakeDb(twoSamePerson), CONTACT, { ...TYPED, address_line1: '77 Elm Ct' })).toBeNull();
  });

  test('gate on + more than 10 phone matches: null', async () => {
    process.env.GATE_QUOTE_SAME_PERSON_MATCH = 'true';
    const eleven = Array.from({ length: 11 }, (_, i) => row(`r${i}`));
    expect(await findExistingCustomerByContact(fakeDb(eleven), CONTACT, TYPED)).toBeNull();
  });

  test('gate on without the typed argument (the rodent pre-pricing lookup): null, no cluster fetch', async () => {
    process.env.GATE_QUOTE_SAME_PERSON_MATCH = 'true';
    const db = fakeDb(twoSamePerson);
    expect(await findExistingCustomerByContact(db, CONTACT)).toBeNull();
    expect(db.limits).toEqual([2]);
  });

  test('a single phone match and the email fallback are unchanged with the gate on', async () => {
    process.env.GATE_QUOTE_SAME_PERSON_MATCH = 'true';
    expect(await findExistingCustomerByContact(fakeDb([row('only')]), CONTACT, TYPED)).toMatchObject({ id: 'only' });
    expect(await findExistingCustomerByContact(fakeDb([], [row('e')]), CONTACT, TYPED)).toMatchObject({ id: 'e' });
  });
});

describe('call-site wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/public-quote.js'), 'utf8');

  test('the post-pricing customer link passes the typed name and address; the rodent lookup stays inline', () => {
    const calls = src.match(/findExistingCustomerByContact\(db, \{[^}]*\}[^;]*\);/g) || [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/first_name: contactFirstName,\s*last_name: contactLastName,\s*address_line1: quoteAddress,/);
    expect(calls[0]).toMatch(/address_line2: normalizedAddress\.line2 \|\| null,\s*city: quoteCity \|\| '',\s*zip: quoteZip \|\| '',/);
  });
});

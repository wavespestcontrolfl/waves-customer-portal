/**
 * Real PostgreSQL: termPropertyLabelsForCustomer (annual-prepay-renewals.js),
 * the per-term property label behind the portal's termite annual renewal
 * cards (GET /api/property/termite-annual-plan) — pre-push audit P1: a
 * customer with several termite annual terms saw identical cards.
 *
 * Locks in the fallback chain (the source estimate's linked
 * customer_properties row -> the estimate's free-text address -> the
 * customer's own address) and the ownership scope at every hop: another
 * customer's term, estimate or property never contributes a label.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to a local throwaway
 * database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand --forceExit server/tests/termite-annual-plan-property-label-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `apt_prop_label_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw(`CREATE TABLE customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    address_line1 text, address_line2 text, city text, state text, zip text
  )`);
  await db.raw(`CREATE TABLE customer_properties (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    address_line1 text, address_line2 text, city text, state text, zip text
  )`);
  await db.raw('CREATE TABLE estimates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, property_id uuid, address text)');
  await db.raw(`CREATE TABLE annual_prepay_terms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    source_estimate_id uuid
  )`);
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('termPropertyLabelsForCustomer — per-term, ownership-scoped property label (real Postgres)', () => {
  let fixture;

  afterEach(async () => {
    jest.resetModules();
    if (fixture) await fixture.destroy();
  });

  async function load() {
    fixture = await createScratchDb();
    const { db } = fixture;
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
    const { termPropertyLabelsForCustomer } = require('../services/annual-prepay-renewals');
    return { db, termPropertyLabelsForCustomer };
  }

  const insert = async (db, table, row) => (await db(table).insert(row).returning('*'))[0];

  test('fallback chain: linked property -> estimate address -> customer address; two properties get two distinct labels', async () => {
    const { db, termPropertyLabelsForCustomer } = await load();
    const customer = await insert(db, 'customers', {
      address_line1: '1 Home St', city: 'Bradenton', state: 'FL', zip: '34202',
    });
    const propA = await insert(db, 'customer_properties', {
      customer_id: customer.id, address_line1: '12 Palm Ave', city: 'Bradenton', state: 'FL', zip: '34202',
    });
    const propB = await insert(db, 'customer_properties', {
      customer_id: customer.id, address_line1: '400 Gulf Dr', address_line2: 'Unit 3', city: 'Holmes Beach', state: 'FL', zip: '34217',
    });
    const estA = await insert(db, 'estimates', { customer_id: customer.id, property_id: propA.id, address: 'ignored snapshot A' });
    const estB = await insert(db, 'estimates', { customer_id: customer.id, property_id: propB.id });
    const estNoProperty = await insert(db, 'estimates', { customer_id: customer.id, address: '77 Quoted Ln, Sarasota, FL 34236' });
    const estBare = await insert(db, 'estimates', { customer_id: customer.id });
    const termA = await insert(db, 'annual_prepay_terms', { customer_id: customer.id, source_estimate_id: estA.id });
    const termB = await insert(db, 'annual_prepay_terms', { customer_id: customer.id, source_estimate_id: estB.id });
    const termQuoted = await insert(db, 'annual_prepay_terms', { customer_id: customer.id, source_estimate_id: estNoProperty.id });
    const termBare = await insert(db, 'annual_prepay_terms', { customer_id: customer.id, source_estimate_id: estBare.id });
    const termNoEstimate = await insert(db, 'annual_prepay_terms', { customer_id: customer.id, source_estimate_id: null });

    const labels = await termPropertyLabelsForCustomer(
      customer.id,
      [termA.id, termB.id, termQuoted.id, termBare.id, termNoEstimate.id],
      db,
    );

    // termTied: only the estimate's linked property or its quoted address
    // identifies WHICH plan this is; the profile fallback does not (r7).
    expect(labels.get(termA.id)).toEqual({ label: '12 Palm Ave, Bradenton, FL 34202', termTied: true });
    expect(labels.get(termB.id)).toEqual({ label: '400 Gulf Dr, Unit 3, Holmes Beach, FL 34217', termTied: true });
    expect(labels.get(termQuoted.id)).toEqual({ label: '77 Quoted Ln, Sarasota, FL 34236', termTied: true });
    expect(labels.get(termBare.id)).toEqual({ label: '1 Home St, Bradenton, FL 34202', termTied: false });
    expect(labels.get(termNoEstimate.id)).toEqual({ label: '1 Home St, Bradenton, FL 34202', termTied: false });
  });

  test("ownership scope: another customer's term, estimate or property never contributes a label", async () => {
    const { db, termPropertyLabelsForCustomer } = await load();
    const me = await insert(db, 'customers', {
      address_line1: '1 Home St', city: 'Bradenton', state: 'FL', zip: '34202',
    });
    const other = await insert(db, 'customers', {
      address_line1: '9 Elsewhere Rd', city: 'Tampa', state: 'FL', zip: '33601',
    });
    const othersProperty = await insert(db, 'customer_properties', {
      customer_id: other.id, address_line1: '9 Elsewhere Rd', city: 'Tampa', state: 'FL', zip: '33601',
    });
    // My estimate mislinked to ANOTHER customer's property: that property is
    // skipped, the estimate's own snapshot is used instead.
    const mislinked = await insert(db, 'estimates', { customer_id: me.id, property_id: othersProperty.id, address: '5 Mine Ct, Bradenton, FL 34205' });
    // A term of mine pointing at ANOTHER customer's estimate: neither that
    // estimate's address nor its property is used — my own address is.
    const othersEstimate = await insert(db, 'estimates', { customer_id: other.id, property_id: othersProperty.id, address: '9 Elsewhere Rd, Tampa, FL 33601' });
    const termMislinked = await insert(db, 'annual_prepay_terms', { customer_id: me.id, source_estimate_id: mislinked.id });
    const termForeignEstimate = await insert(db, 'annual_prepay_terms', { customer_id: me.id, source_estimate_id: othersEstimate.id });
    // Another customer's term asked for under MY id: never returned.
    const othersTerm = await insert(db, 'annual_prepay_terms', { customer_id: other.id, source_estimate_id: othersEstimate.id });

    const labels = await termPropertyLabelsForCustomer(me.id, [termMislinked.id, termForeignEstimate.id, othersTerm.id], db);

    expect(labels.get(termMislinked.id)).toEqual({ label: '5 Mine Ct, Bradenton, FL 34205', termTied: true });
    expect(labels.get(termForeignEstimate.id)).toEqual({ label: '1 Home St, Bradenton, FL 34202', termTied: false });
    expect(labels.has(othersTerm.id)).toBe(false);
    expect([...labels.values()].some(({ label }) => label.includes('Elsewhere'))).toBe(false);
  });

  test('no customer id or no term ids: empty map', async () => {
    const { db, termPropertyLabelsForCustomer } = await load();
    expect((await termPropertyLabelsForCustomer(null, ['x'], db)).size).toBe(0);
    expect((await termPropertyLabelsForCustomer(randomUUID(), [], db)).size).toBe(0);
  });
});

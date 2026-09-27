/**
 * Real PostgreSQL: a termite renewal SUCCESSOR's property identity (Codex
 * #4971 round-3, item 8). A successor never copies source_estimate_id
 * (createTermForAnnualPrepay treats it as creation identity — copying it
 * would find/overwrite the original term), so the renewal notice's
 * protected property (planPropertyForTerm → termNoticeAddress) and the
 * portal card's property label (termPropertyLabelsForCustomer) resolve the
 * ROOT estimate through the shared customer-scoped, cycle-safe lineage
 * resolver (termiteRenewalScope). The root estimate's quoted snapshot stays
 * the preferred address; a malformed lineage (a cycle, another customer's
 * ancestor) resolves nothing and falls back exactly like a term with no
 * estimate (customer address, termTied: false).
 *
 * '../models/db' is redirected to this scratch schema (termNoticeAddress
 * reads through the module-level handle).
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to a local throwaway
 * database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-renewal-successor-property-postgres.test.js
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
  const schema = `termite_succ_prop_${randomUUID().replace(/-/g, '')}`;
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
  await db.raw('CREATE TABLE estimates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL, property_id uuid, address text)');
  await db.raw(`CREATE TABLE annual_prepay_terms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    source_estimate_id uuid,
    renewed_from_term_id uuid,
    annual_plan_version text,
    status text NOT NULL DEFAULT 'active',
    term_start date NOT NULL DEFAULT '2025-10-01',
    term_end date NOT NULL DEFAULT '2026-09-30'
  )`);
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('termite renewal successor — property identity through its lineage (item 8), real Postgres', () => {
  let fixture;
  let db;
  let Renewals;

  beforeEach(async () => {
    jest.resetModules();
    fixture = await createScratchDb();
    db = fixture.db;
    jest.doMock('../models/db', () => db);
    Renewals = require('../services/annual-prepay-renewals');
  });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  async function insertCustomer(address) {
    const [row] = await db('customers').insert({
      address_line1: address, city: 'Billing City', state: 'FL', zip: '34219',
    }).returning('*');
    return row;
  }

  // original (with the quoted estimate) -> year-2 successor -> year-3 successor
  async function lineage(customer, estimateFields) {
    const [estimate] = await db('estimates').insert({ customer_id: customer.id, ...estimateFields }).returning('*');
    const [original] = await db('annual_prepay_terms').insert({
      customer_id: customer.id, source_estimate_id: estimate.id, annual_plan_version: 'v3', status: 'renewed',
    }).returning('*');
    const [year2] = await db('annual_prepay_terms').insert({
      customer_id: customer.id, renewed_from_term_id: original.id, annual_plan_version: 'v3', status: 'renewed',
      term_start: '2026-10-01', term_end: '2027-09-30',
    }).returning('*');
    const [year3] = await db('annual_prepay_terms').insert({
      customer_id: customer.id, renewed_from_term_id: year2.id, annual_plan_version: 'v3', status: 'payment_pending',
      term_start: '2027-10-01', term_end: '2028-09-30',
    }).returning('*');
    return { estimate, original, year2, year3 };
  }

  test('the renewal notice names the ROOT estimate\'s quoted property for a successor two renewals deep — not the billing address', async () => {
    const customer = await insertCustomer('1 Billing Way');
    const { year3 } = await lineage(customer, { address: '77 Protected Lane, Parrish, FL 34219' });

    const { addressShort, planAddress } = await Renewals._private.termNoticeAddress(true, year3, customer);

    expect(planAddress).toBe('77 Protected Lane, Parrish, FL 34219');
    expect(addressShort).toBe('77 Protected Lane, Parrish, FL 34219');
    expect(addressShort).not.toContain('Billing Way');
  });

  test('a snapshot-less root estimate falls back to its linked property, as for the original term', async () => {
    const customer = await insertCustomer('1 Billing Way');
    const [property] = await db('customer_properties').insert({
      customer_id: customer.id, address_line1: '12 Linked Ct', city: 'Palmetto', state: 'FL', zip: '34221',
    }).returning('*');
    const { year2 } = await lineage(customer, { property_id: property.id, address: null });

    await expect(Renewals._private.planPropertyForTerm(year2, db)).resolves.toMatchObject({ address_line1: '12 Linked Ct', city: 'Palmetto' });
  });

  test('the portal label of a successor is its root estimate\'s snapshot, termTied: true — the original keeps its own', async () => {
    const customer = await insertCustomer('1 Billing Way');
    const { original, year2, year3 } = await lineage(customer, { address: '77 Protected Lane, Parrish, FL 34219' });

    const labels = await Renewals.termPropertyLabelsForCustomer(customer.id, [original.id, year2.id, year3.id], db);

    for (const term of [original, year2, year3]) {
      expect(labels.get(term.id)).toEqual({ label: '77 Protected Lane, Parrish, FL 34219', termTied: true });
    }
  });

  test('a cyclic lineage fails closed: no plan property on the notice, and the label is the customer address with termTied: false', async () => {
    const customer = await insertCustomer('1 Billing Way');
    const { original, year2 } = await lineage(customer, { address: '77 Protected Lane, Parrish, FL 34219' });
    // Corrupt the chain: the original now points back at its own successor.
    await db('annual_prepay_terms').where({ id: original.id }).update({ renewed_from_term_id: year2.id });

    await expect(Renewals._private.planPropertyForTerm(year2, db)).resolves.toBeNull();
    const labels = await Renewals.termPropertyLabelsForCustomer(customer.id, [year2.id], db);
    expect(labels.get(year2.id)).toEqual({ label: '1 Billing Way, Billing City, FL 34219', termTied: false });
  });

  test('an ancestor owned by ANOTHER customer fails closed — that customer\'s property never leaks onto this notice or label', async () => {
    const other = await insertCustomer('9 Other Owner Rd');
    const { original: foreignOriginal } = await lineage(other, { address: '500 Someone Else Blvd, Sarasota, FL 34232' });
    const customer = await insertCustomer('1 Billing Way');
    const [successor] = await db('annual_prepay_terms').insert({
      customer_id: customer.id, renewed_from_term_id: foreignOriginal.id, annual_plan_version: 'v3', status: 'payment_pending',
    }).returning('*');

    await expect(Renewals._private.planPropertyForTerm(successor, db)).resolves.toBeNull();
    const { planAddress } = await Renewals._private.termNoticeAddress(true, successor, customer);
    expect(planAddress).toBeNull();
    const labels = await Renewals.termPropertyLabelsForCustomer(customer.id, [successor.id], db);
    expect(labels.get(successor.id)).toEqual({ label: '1 Billing Way, Billing City, FL 34219', termTied: false });
  });
});

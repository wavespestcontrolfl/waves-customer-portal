/**
 * Real PostgreSQL: the Taurus SC yearly count (services/taurus-yearly-count.js)
 * against a scratch schema. Home resolution (property, then customer), the ET
 * year window, distinct service dates, leaving out the visit being completed,
 * and both product matches (catalog product_id, older product_name rows) are
 * the database's own answers.
 *
 * Self-skips without DATABASE_URL (CI runs it in the server-db job), e.g.:
 *   DATABASE_URL=postgresql://localhost:5432/waves_test \
 *     ~/.claude/bin/jest-slot --runInBand tests/taurus-yearly-count-postgres.test.js
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knexLib = require('knex');
const { randomUUID } = require('crypto');
const { taurusYearlyCount } = require('../services/taurus-yearly-count');

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;
const NOW = new Date('2026-11-19T15:00:00Z');

describeOrSkip('taurus yearly count on PostgreSQL', () => {
  let db;
  let schema;
  let taurusId;
  let otherId;
  const customer = randomUUID();
  const propA = randomUUID();
  const propB = randomUUID();

  async function visit({ property = null, cust = customer, date = '2026-03-10', taurus = 'id', status = 'completed', record = true, ledgerProperty = null } = {}) {
    const ssId = randomUUID();
    await db('scheduled_services').insert({ id: ssId, customer_id: cust, property_id: property });
    if (!record) return { ssId };
    const srId = randomUUID();
    await db('service_records').insert({ id: srId, customer_id: cust, scheduled_service_id: ssId, service_date: date, status });
    const product = { id: randomUUID(), service_record_id: srId };
    if (taurus === 'id') await db('service_products').insert({ ...product, product_name: 'Taurus SC (renamed)', product_id: taurusId });
    if (taurus === 'name') await db('service_products').insert({ ...product, product_name: 'Taurus SC', product_id: null });
    if (taurus === 'upper') await db('service_products').insert({ ...product, product_name: '  TAURUS SC  ', product_id: null });
    if (taurus === 'suffixed') await db('service_products').insert({ ...product, product_name: 'Taurus SC 9.7%', product_id: null });
    if (taurus === 'lookalike') await db('service_products').insert({ ...product, product_name: 'Taurus SCX', product_id: null });
    if (taurus === 'none') await db('service_products').insert({ ...product, product_name: 'LESCO Crosscheck Plus', product_id: otherId });
    if (ledgerProperty) await db('property_application_history').insert({ service_product_id: product.id, property_id: ledgerProperty });
    return { ssId, srId };
  }

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/waves_test') {
      throw new Error('This test requires a local waves_test database');
    }
    schema = `taurus_yearly_${randomUUID().replace(/-/g, '')}`;
    db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
    await db.raw('CREATE SCHEMA ??', [schema]);
    await db.raw('CREATE TABLE products_catalog (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, active boolean DEFAULT true)');
    await db.raw('CREATE TABLE scheduled_services (id uuid PRIMARY KEY, customer_id uuid, property_id uuid)');
    await db.raw('CREATE TABLE service_records (id uuid PRIMARY KEY, customer_id uuid, scheduled_service_id uuid, service_date date NOT NULL, status text)');
    await db.raw('CREATE TABLE service_products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_record_id uuid, product_name text, product_id uuid)');
    await db.raw('CREATE TABLE property_application_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_product_id uuid, property_id uuid)');
    [taurusId] = (await db('products_catalog').insert({ name: 'Taurus SC' }).returning('id')).map((r) => r.id);
    [otherId] = (await db('products_catalog').insert({ name: 'LESCO Crosscheck Plus' }).returning('id')).map((r) => r.id);
  });

  afterAll(async () => {
    if (!db) return;
    await db.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await db.destroy();
  });

  it('counts distinct service dates of Taurus records at the home this ET year', async () => {
    await visit({ property: propA, date: '2026-02-01' });
    await visit({ property: propA, date: '2026-05-01', taurus: 'name' }); // older row, by name
    await visit({ property: propA, date: '2026-06-01', taurus: 'upper' }); // legacy casing and spacing
    await visit({ property: propA, date: '2026-06-15', taurus: 'suffixed' });
    await visit({ property: propA, date: '2026-06-20', taurus: 'lookalike' }); // another product
    await visit({ property: propA, date: '2026-08-01', taurus: 'none' }); // no Taurus
    await visit({ property: propA, date: '2026-09-01', status: 'cancelled' });
    await visit({ property: propB, date: '2026-06-01' }); // another home
    await visit({ property: propA, date: '2025-12-31' }); // last ET year
    await visit({ property: propA, date: '2027-01-01' }); // next year
    const current = await visit({ property: propA, date: '2026-11-19' });
    const out = await taurusYearlyCount({ id: current.ssId, customer_id: customer, property_id: propA }, { knex: db, now: NOW });
    // 02-01, 05-01 (by name), 06-01 (upper case) and 06-15 (suffixed); the lookalike product and the current visit are left out.
    expect(out).toEqual({ count: 4, limit: 4, year: 2026 });
  });

  it('counts two visits on the same day as two applications, and two records of one visit as one', async () => {
    const cust = randomUUID();
    await visit({ cust, property: propA, date: '2026-05-01' });
    await visit({ cust, property: propA, date: '2026-05-01' });
    const twice = await visit({ cust, property: propA, date: '2026-06-01' });
    // A second record (a re-save) of the same scheduled visit, also with Taurus.
    const srId = randomUUID();
    await db('service_records').insert({ id: srId, customer_id: cust, scheduled_service_id: twice.ssId, service_date: '2026-06-01', status: 'completed' });
    await db('service_products').insert({ service_record_id: srId, product_name: 'Taurus SC' });
    const probe = { id: randomUUID(), customer_id: cust, property_id: propA };
    expect((await taurusYearlyCount(probe, { knex: db, now: NOW })).count).toBe(3);
  });

  it('places an application at the property frozen on the ledger, not at the visit as corrected later', async () => {
    const cust = randomUUID();
    // The visit now says propB (an address correction), the ledger froze propA at completion.
    await visit({ cust, property: propB, ledgerProperty: propA, date: '2026-02-02' });
    await visit({ cust, property: propA, ledgerProperty: propB, date: '2026-03-03' });
    expect((await taurusYearlyCount({ id: randomUUID(), customer_id: cust, property_id: propA }, { knex: db, now: NOW })).count).toBe(1);
    expect((await taurusYearlyCount({ id: randomUUID(), customer_id: cust, property_id: propB }, { knex: db, now: NOW })).count).toBe(1);
  });

  it('leaves out only the record of the visit being completed', async () => {
    const cust = randomUUID();
    const first = await visit({ cust, property: propA, date: '2026-01-10' });
    const second = await visit({ cust, property: propA, date: '2026-04-10' });
    expect((await taurusYearlyCount({ id: first.ssId, customer_id: cust, property_id: propA }, { knex: db, now: NOW })).count).toBe(1);
    expect((await taurusYearlyCount({ id: second.ssId, customer_id: cust, property_id: propA }, { knex: db, now: NOW })).count).toBe(1);
    expect((await taurusYearlyCount({ id: randomUUID(), customer_id: cust, property_id: propA }, { knex: db, now: NOW })).count).toBe(2);
  });

  it('falls back to the whole customer when the visit has no property_id', async () => {
    const cust = randomUUID();
    await visit({ cust, property: propA, date: '2026-01-10' });
    await visit({ cust, property: propB, date: '2026-02-10' });
    await visit({ cust, property: null, date: '2026-03-10' });
    expect((await taurusYearlyCount({ id: randomUUID(), customer_id: cust, property_id: null }, { knex: db, now: NOW })).count).toBe(3);
    // A property visit counts its own home and the unattributed (null-property) records, not the other home.
    expect((await taurusYearlyCount({ id: randomUUID(), customer_id: cust, property_id: propA }, { knex: db, now: NOW })).count).toBe(2);
  });

  it('draws the year at ET midnight, not UTC', async () => {
    const cust = randomUUID();
    await visit({ cust, date: '2026-12-31' });
    await visit({ cust, date: '2027-01-01' });
    const probe = { id: randomUUID(), customer_id: cust, property_id: null };
    // 9 PM ET Dec 31 2026 = 02:00Z Jan 1 2027: still the 2026 year.
    expect((await taurusYearlyCount(probe, { knex: db, now: new Date('2027-01-01T02:00:00Z') })).count).toBe(1);
    // 1 AM ET Jan 1 2027: the 2027 year.
    expect((await taurusYearlyCount(probe, { knex: db, now: new Date('2027-01-01T06:00:00Z') })).count).toBe(1);
    expect((await taurusYearlyCount(probe, { knex: db, now: new Date('2027-06-01T12:00:00Z') })).year).toBe(2027);
    // A December visit closed out in January counts toward December's year.
    const december = { ...probe, scheduled_date: '2026-12-30' };
    expect(await taurusYearlyCount(december, { knex: db, now: new Date('2027-01-03T15:00:00Z') })).toMatchObject({ count: 1, year: 2026 });
  });

  it('records with no scheduled visit still count for the customer', async () => {
    const cust = randomUUID();
    const srId = randomUUID();
    await db('service_records').insert({ id: srId, customer_id: cust, scheduled_service_id: null, service_date: '2026-03-03', status: 'completed' });
    await db('service_products').insert({ service_record_id: srId, product_name: 'Taurus SC' });
    expect((await taurusYearlyCount({ id: randomUUID(), customer_id: cust, property_id: null }, { knex: db, now: NOW })).count).toBe(1);
  });
});

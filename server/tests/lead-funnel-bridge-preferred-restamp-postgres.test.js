/**
 * A /book preferred-time request that closed itself as 'handled' gave up its
 * funnel row; when staff reopen it (or win it) through ANY status writer (they
 * all call the funnel bridge), the row is re-stamped from the lead's stored
 * first-touch fields (codex #5477 r3 P2). Real PostgreSQL (skipped without
 * DATABASE_URL, like the other *-postgres suites).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/ads/call-attribution', () => ({
  attributionForSourceType: (t) => ({ website: { leadSource: 'website', isPaid: false } })[t] || null,
}));
jest.mock('../services/lead-source-resolver', () => ({
  resolveLeadSource: jest.fn(async () => ({ sourceType: 'website', leadSourceDetail: null, isPaidClick: false })),
}));

const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

(SKIP ? describe.skip : describe)('reopening a handled /book request restores its funnel row (PostgreSQL)', () => {
  const schema = `pt_restamp_${randomUUID().replaceAll('-', '')}`;
  let database;
  let bridge;
  const touch = { utm: { source: 'direct' }, referrer: null, landing_url: 'https://portal.test/book' };

  const lead = async (over = {}) => {
    const [row] = await database('leads').insert({
      first_name: 'Pat', phone: '+19415550100', lead_type: 'book_preferred_time', status: 'new',
      service_interest: 'Pest Control', first_contact_at: new Date(), extracted_data: JSON.stringify(touch), ...over,
    }).returning('*');
    return row;
  };
  const rows = (id) => database('ad_service_attribution').where({ lead_id: id });

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw(`CREATE TABLE ??.leads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), first_name text, phone text, lead_type text, status text, service_interest text,
      first_contact_at timestamptz, extracted_data jsonb, lead_source_id uuid, gclid text, wbraid text, gbraid text, fbclid text, fbc text, fbp text,
      customer_id uuid, deleted_at timestamptz, created_at timestamptz DEFAULT now())`, [schema]);
    await database.raw(`CREATE TABLE ??.ad_service_attribution (
      id serial PRIMARY KEY, lead_id uuid UNIQUE, customer_id uuid, service_line text, specific_service text, service_bucket text, lead_date date,
      lead_source text, lead_source_detail text, gclid text, wbraid text, gbraid text, fbclid text, fbc text, fbp text, utm_campaign text, utm_term text,
      funnel_stage text DEFAULT 'lead', is_paid boolean, updated_at timestamptz DEFAULT now())`, [schema]);
    bridge = require('../services/lead-funnel-bridge');
  });
  afterAll(async () => {
    if (!database) return;
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
    await database.destroy();
  });
  beforeEach(async () => {
    await database('ad_service_attribution').del();
    await database('leads').del();
  });

  test('reopened to new: the missing row is re-stamped at the lead stage from its stored touch', async () => {
    const l = await lead({ status: 'new' }); // staff just wrote 'new'; the row was dropped when it was handled
    await bridge.bridgeLeadFunnelStage(l.id, 'new', database);
    const r = await rows(l.id);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ funnel_stage: 'lead', lead_source: 'website' });
  });

  test('won: re-stamped straight at booked', async () => {
    const l = await lead({ status: 'won' });
    await bridge.bridgeLeadFunnelStage(l.id, 'won', database);
    expect((await rows(l.id))[0]).toMatchObject({ funnel_stage: 'booked' });
  });

  test('the bulk form re-stamps too, and a lead that already has a row is left alone (no duplicate)', async () => {
    const a = await lead({ status: 'contacted' });
    const b = await lead({ status: 'contacted' });
    await database('ad_service_attribution').insert({ lead_id: b.id, funnel_stage: 'contacted', lead_source: 'google_ads' });
    await bridge.bridgeLeadsFunnelStage([a.id, b.id], 'contacted', database);
    expect(await rows(a.id)).toHaveLength(1);
    const kept = await rows(b.id);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ lead_source: 'google_ads' });
  });

  test('only a /book request is restored: any other lead without a row has none on purpose', async () => {
    const other = await lead({ lead_type: 'phone_call', status: 'new' });
    await bridge.bridgeLeadFunnelStage(other.id, 'new', database);
    expect(await rows(other.id)).toHaveLength(0);
  });

  test('a close (handled, lost, spam) restores nothing', async () => {
    for (const status of ['handled', 'lost', 'spam', 'duplicate']) {
      const l = await lead({ status });
      await bridge.bridgeLeadFunnelStage(l.id, status, database);
      expect(await rows(l.id)).toHaveLength(0);
    }
  });

  test('inside a caller transaction a failure never dooms it (savepoint)', async () => {
    const l = await lead({ status: 'new' });
    await database.transaction(async (trx) => {
      await bridge.bridgeLeadFunnelStage(l.id, 'new', trx);
      await trx('leads').where({ id: l.id }).update({ first_name: 'After' });
    });
    expect((await database('leads').where({ id: l.id }).first()).first_name).toBe('After');
    expect(await rows(l.id)).toHaveLength(1);
  });
});

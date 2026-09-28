// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// Runs in the existing DB-gated CI step or the owning worktree's private QA DB.
//
// Covers the SQL-level behavior series-extend-address-anchor.test.js's
// in-memory fakes cannot honestly exercise: status three-valued logic
// (Postgres' NULL NOT IN (...) is UNKNOWN, never TRUE — round-1 Codex P1),
// the active-property JOIN condition, and that removing the old LIMIT(20)
// actually fixed the round-1 Codex P2 (a large series no longer truncates
// its evidence before the active-property filter gets to run).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => ({}), { virtual: false });
const { randomUUID } = require('node:crypto');
// seriesAddressEvidence's own module-level `db` default (mocked above, an
// unusable object) is never reached — every call below passes `trx` explicitly.
const { seriesAddressEvidence } = require('../services/customer-properties');

postgres('series address evidence against migrated PostgreSQL', () => {
  let database;
  let trx;
  let customerId;
  let cols;

  beforeAll(async () => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    cols = await database('scheduled_services').columnInfo();
  });

  beforeEach(async () => {
    trx = await database.transaction();
    customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Evidence',
      phone: `fixture-${customerId.slice(0, 8)}`, address_line1: '100 Test Lane', city: 'Test City',
      zip: '00000', active: true, pipeline_stage: 'active_customer' });
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function property(overrides = {}) {
    const id = randomUUID();
    await trx('customer_properties').insert({
      id, customer_id: customerId, address_line1: `${id.slice(0, 8)} Synthetic Ave`,
      city: 'Sarasota', state: 'FL', zip: '34231', active: true, ...overrides,
    });
    return id;
  }

  async function visit(overrides = {}) {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id, customer_id: customerId, service_type: 'Quarterly Pest Control',
      status: 'pending', scheduled_date: '2040-01-15', is_recurring: true, ...overrides,
    });
    return id;
  }

  test('a NULL-status addressed sibling IS evidence (NULL NOT IN (...) is UNKNOWN in Postgres — a bare whereNotIn would silently drop it)', async () => {
    const parentId = await visit({ scheduled_date: '2040-01-01', status: 'completed' });
    const propId = await property();
    await visit({ recurring_parent_id: parentId, scheduled_date: '2040-04-01', status: null, property_id: propId });
    const stamp = await seriesAddressEvidence(parentId, customerId, cols, trx);
    expect(stamp).toMatchObject({ property_id: propId });
  });

  test('cancelled and rescheduled siblings are not evidence, even when newer than the real one', async () => {
    const parentId = await visit({ scheduled_date: '2040-01-01', status: 'completed' });
    const propWrong = await property();
    const propReal = await property();
    await visit({ recurring_parent_id: parentId, scheduled_date: '2040-06-01', status: 'cancelled', property_id: propWrong });
    await visit({ recurring_parent_id: parentId, scheduled_date: '2040-05-01', status: 'rescheduled', property_id: propWrong });
    await visit({ recurring_parent_id: parentId, scheduled_date: '2040-03-01', status: 'pending', property_id: propReal });
    const stamp = await seriesAddressEvidence(parentId, customerId, cols, trx);
    expect(stamp.property_id).toBe(propReal);
  });

  test('a row whose property is no longer active is not evidence', async () => {
    const parentId = await visit({ scheduled_date: '2040-01-01', status: 'completed' });
    const propInactive = await property({ active: false });
    const propActive = await property();
    await visit({ recurring_parent_id: parentId, scheduled_date: '2040-07-01', status: 'pending', property_id: propInactive });
    await visit({ recurring_parent_id: parentId, scheduled_date: '2040-02-01', status: 'completed', property_id: propActive });
    const stamp = await seriesAddressEvidence(parentId, customerId, cols, trx);
    expect(stamp.property_id).toBe(propActive);
  });

  test('a series with >20 rows still resolves (no LIMIT truncation before the active-property filter)', async () => {
    const parentId = await visit({ scheduled_date: '2040-01-01', status: 'completed' });
    const propInactive = await property({ active: false });
    const propValid = await property();
    // 22 RECENT decoys that all pass the old candidacy check (property_id
    // set) but fail the active-property JOIN — under the old
    // .limit(20)-before-active-check code these alone would have filled the
    // fetched window and the one valid, OLDER row below would never even
    // have been read.
    for (let i = 1; i <= 22; i += 1) {
      await visit({
        recurring_parent_id: parentId, status: 'pending', property_id: propInactive,
        scheduled_date: `2040-09-${String(i).padStart(2, '0')}`,
      });
    }
    // The one real piece of evidence — oldest of all 23 sibling rows.
    await visit({ recurring_parent_id: parentId, scheduled_date: '2040-01-05', status: 'completed', property_id: propValid });
    const stamp = await seriesAddressEvidence(parentId, customerId, cols, trx);
    expect(stamp.property_id).toBe(propValid);
  });
});

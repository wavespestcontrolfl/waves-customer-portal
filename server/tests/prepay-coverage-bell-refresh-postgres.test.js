// A standing prepay-coverage bell written before the "who and what" copy (owner audit
// 2026-10-01) must pick up the new title, why, link and metadata on the next run, quietly:
// no new row, no re-ring, read state kept. A comeback after an auto-clear still rings.
// Real migrated PostgreSQL and the REAL notification service, synthetic records, rolled back
// after every test (same harness as prepaid-integrity-postgres.test.js).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/irrigation-weekly-email', () => ({
  findLawnEmailAudienceGaps: jest.fn(async () => []), findUnstampedRecurringLawnMembers: jest.fn(async () => []),
}));
const { randomUUID } = require('node:crypto');

postgres('prepay-coverage bell quiet refresh', () => {
  let database;
  let trx;
  let customerId;
  const now = new Date('2040-01-10T16:00:00Z');

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });
  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer' });
  });
  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  const visit = async (overrides = {}) => (await trx('scheduled_services').insert({ id: randomUUID(), customer_id: customerId,
    service_type: 'Monthly Pest Control Service', service_key_snapshot: 'pest_general_monthly',
    status: 'pending', scheduled_date: '2040-01-15', source_estimate_id: null,
    is_recurring: true, recurring_pattern: 'monthly', ...overrides }).returning('*'))[0];

  // The manual-series gap from prepaid-integrity-postgres: a child with no allocation.
  async function gapVisit() {
    const paidAt = new Date('2040-01-05T16:00:00Z');
    const root = await visit({ prepaid_method: 'check', prepaid_amount: 100, prepaid_at: paidAt });
    const child = await visit({ recurring_parent_id: root.id, created_at: new Date('2040-01-04T16:00:00Z'), estimated_price: 100 });
    await visit({ recurring_parent_id: root.id, scheduled_date: '2040-02-15', prepaid_method: 'check', prepaid_amount: 100, prepaid_at: paidAt });
    await visit({ recurring_parent_id: root.id, created_at: new Date('2040-01-06T16:00:00Z'), estimated_price: 100 });
    return child;
  }
  const bellsFor = (child) => trx('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'scheduled_service_id' = ?", [child.id]);

  test('a standing row from the old copy is rewritten in place, read state kept, no ring', async () => {
    const { runInner } = require('../services/schedule-integrity-watchdog');
    const child = await gapVisit();
    expect((await runInner({ now })).prepayCoverageGaps).toBe(1);
    const [first] = await bellsFor(child);
    expect(first.title).toBe("Schedule — check Synthetic Fixture's prepaid visit on Jan 15");
    // Age it back to what production holds today: the old copy, dispatch link, no area stamps, read.
    const readAt = new Date('2040-01-09T12:00:00Z');
    const { area: _a, severity: _s, subject: _sub, doneWhen: _d, who: _w, ...oldMeta } = first.metadata;
    await trx('notifications').where({ id: first.id }).update({
      title: 'Prepaid coverage needs review for 2040-01-15', body: 'old long body', detail: null, link: '/admin/dispatch',
      read_at: readAt, metadata: JSON.stringify({ ...oldMeta, rungAt: '2040-01-09T12:00:00.000Z' }),
    });

    expect((await runInner({ now })).prepayCoverageGaps).toBe(1);
    const rows = await bellsFor(child);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.id).toBe(first.id);
    expect(row.title).toBe("Schedule — check Synthetic Fixture's prepaid visit on Jan 15");
    expect(row.link).toBe(`/admin/dispatch?tab=schedule&date=2040-01-15&appointment=${child.id}`);
    expect(row.metadata).toMatchObject({ area: 'Schedule', severity: 'needs-you', subject: { type: 'visit', id: child.id }, doneWhen: 'coverage_reconciled' });
    expect(row.metadata.rungAt).toBe('2040-01-09T12:00:00.000Z');
    expect(new Date(row.read_at).toISOString()).toBe(readAt.toISOString());
    expect(row.done_at).toBeNull();

    // Identical content next run: still one row, still quiet.
    await runInner({ now });
    const again = await bellsFor(child);
    expect(again).toHaveLength(1);
    expect(again[0].metadata.rungAt).toBe('2040-01-09T12:00:00.000Z');
    expect(new Date(again[0].read_at).toISOString()).toBe(readAt.toISOString());
  });

  test('a comeback after an auto-clear still rings: the same row, unread again', async () => {
    const { runInner } = require('../services/schedule-integrity-watchdog');
    const child = await gapVisit();
    await runInner({ now });
    const [first] = await bellsFor(child);
    await trx('notifications').where({ id: first.id }).update({
      read_at: new Date('2040-01-09T12:00:00Z'),
      metadata: JSON.stringify({ ...first.metadata, autoCleared: true, autoClearedReason: 'gap resolved' }),
    });
    await runInner({ now });
    const rows = await bellsFor(child);
    expect(rows).toHaveLength(1);
    expect(rows[0].read_at).toBeNull();
    expect(rows[0].metadata).toMatchObject({ autoCleared: false, recurrenceGeneration: 1 });
  });
});

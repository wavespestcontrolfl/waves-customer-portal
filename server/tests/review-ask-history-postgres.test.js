// Picked up by the existing DB-gated CI step; all synthetic writes roll back.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  return db;
});
const { randomUUID } = require('node:crypto');
const history = require('../services/review-ask-history');

postgres('review ask history against migrated PostgreSQL', () => {
  let database;
  let trx;
  let customerId;
  const at = new Date('2040-01-10T16:00:00Z');
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!local && !ownedQA) throw new Error('Use disposable CI or this worktree’s private QA database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer' });
  });
  afterEach(async () => { await trx?.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function request(values = {}) {
    const [row] = await trx('review_requests').insert({ customer_id: customerId, token: randomUUID(),
      created_at: new Date('2039-01-01T16:00:00Z'), ...values }).returning('*');
    return row;
  }

  test('delivery time includes old queued rows and uses the later channel, excluding private check-ins', async () => {
    const latest = new Date(at.getTime() + 3600000);
    const row = await request({ sms_sent_at: at, sent_at: latest });
    await request({ sms_sent_at: new Date(latest.getTime() + 3600000), template_key: 'resolution_check' });
    await request();
    expect(await history.lastDeliveredAskAt(customerId, { since: at })).toEqual(latest);
    expect(await history.deliveredAskRows(customerId, { since: latest })).toEqual([]);
    expect(await history.lastDeliveredAskAt(customerId, { excludeRequestId: row.id })).toBeNull();
  });

  async function auditRow(reviewRequestId, values = {}) {
    return trx('messaging_audit_log').insert({
      to_hash: 'fixture-hash', to_last4: '0102', audience: 'customer', purpose: 'review_request',
      channel: 'sms', entry_point: 'review_request_followup', body_hash: 'fixture-body-hash', customer_id: customerId,
      metadata: JSON.stringify({ original_message_type: 'review_followup', review_request_id: reviewRequestId }),
      ...values,
    });
  }

  test('a genuinely delivered legacy follow-up is included and outranks the original ask time', async () => {
    // Mirrors processFollowups (review-request.js): the original ask stamps
    // sms_sent_at on review_requests, and the separate review_request_followup
    // SMS is delivered days later — recorded with a real sent_at in
    // messaging_audit_log, keyed back to this row via metadata.review_request_id.
    const followupAt = new Date(at.getTime() + 4 * 86400000);
    const row = await request({ sms_sent_at: at, followup_sent_at: followupAt });
    await auditRow(row.id, { sent_at: followupAt });
    expect(await history.lastDeliveredAskAt(customerId, { since: at })).toEqual(followupAt);
    const rows = await history.deliveredAskRows(customerId);
    expect(rows).toHaveLength(1);
    expect(rows[0].followup_delivered_at.toISOString()).toEqual(followupAt.toISOString());
  });

  test('a review_requests.followup_sent_at "handled" marker with no genuine send does not count', async () => {
    // processFollowups also stamps followup_sent_at for paths that never
    // reached the customer — dedup'd siblings, no-consent contacts,
    // soft-deleted customers, and blocked/failed sends — with NO
    // messaging_audit_log row at all (a blocked/pre-send attempt still
    // writes an audit row, but with sent_at left null). Either way, this
    // column alone must not be trusted as delivery evidence.
    const markerAt = new Date(at.getTime() + 4 * 86400000);
    const row = await request({ sms_sent_at: at, followup_sent_at: markerAt });
    const since = new Date(at.getTime() - 1);
    expect(await history.lastDeliveredAskAt(customerId, { since })).toEqual(at);
    await auditRow(row.id, { sent_at: null, blocked_code: 'CONSENT_LOOKUP_FAILED' });
    expect(await history.lastDeliveredAskAt(customerId, { since })).toEqual(at);
  });

  test("a delivered follow-up logged under another customer never counts as this customer's ask", async () => {
    const row = await request({ sms_sent_at: at, followup_sent_at: new Date(at.getTime() + 3 * 86400000) });
    await auditRow(row.id, { sent_at: new Date(at.getTime() + 3 * 86400000), customer_id: randomUUID() });
    expect(await history.lastDeliveredAskAt(customerId, { since: new Date(at.getTime() - 1) })).toEqual(at);
  });

  test('single-channel deliveries survive nulls and customer scoping', async () => {
    const row = await request({ sent_at: at });
    expect(await history.lastDeliveredAskAt(customerId)).toEqual(at);
    expect(await history.lastDeliveredAskAt(randomUUID())).toBeNull();
    await trx('review_requests').where({ id: row.id }).update({ sent_at: null, sms_sent_at: at });
    expect(await history.lastDeliveredAskAt(customerId)).toEqual(at);
  });

  test('only actual legacy follow-up delivery anchors history, not suppression', async () => {
    const row = await request({ sms_sent_at: at, followup_sent: true, followup_sent_at: new Date(at.getTime() + 86400000) });
    expect(await history.lastDeliveredAskAt(customerId)).toEqual(at);
    const deliveredAt = new Date(at.getTime() + 72 * 3600000);
    await trx('review_requests').where({ id: row.id }).update({ followup_delivered_at: deliveredAt });
    expect(await history.lastDeliveredAskAt(customerId, { since: at })).toEqual(deliveredAt);
    expect(await history.deliveredAskRows(customerId, { since: deliveredAt })).toEqual([]);
  });

  test('an unresolved follow-up reservation holds spacing without claiming delivery', async () => {
    const row = await request({ sms_sent_at: at });
    const reservedAt = new Date(at.getTime() + 80 * 3600000);
    await trx('review_requests').where({ id: row.id }).update({ followup_reserved_at: reservedAt });
    expect(await history.lastDeliveredAskAt(customerId, { since: at })).toEqual(reservedAt);
    expect(await history.lastDeliveredAskAt(customerId, { since: at, includeReservations: false })).toBeNull();
    expect((await trx('review_requests').where({ id: row.id }).first()).followup_delivered_at).toBeNull();
    await trx('review_requests').where({ id: row.id }).update({ followup_reserved_at: null });
    expect(await history.lastDeliveredAskAt(customerId)).toEqual(at);
  });

  test('retry eligibility excludes held rows before the batch limit and admits expired holds', async () => {
    const held = await request({ followup_sent: false, followup_next_attempt_at: new Date(at.getTime() + 60000) });
    const due = await request({ followup_sent: false, followup_next_attempt_at: null });
    const eligible = () => trx('review_requests').where({ customer_id: customerId, followup_sent: false })
      .whereRaw('(followup_next_attempt_at IS NULL OR followup_next_attempt_at <= ?)', [at]).limit(20);
    expect((await eligible()).map(row => row.id)).toEqual([due.id]);
    await trx('review_requests').where({ id: held.id }).update({ followup_next_attempt_at: at });
    expect((await eligible()).map(row => row.id).sort()).toEqual([held.id, due.id].sort());
    const migration = require('../models/migrations/20260909000011_review_followup_retry_at');
    await migration.down(trx);
    await migration.down(trx);
    await migration.up(trx);
    await migration.up(trx);
    expect(await trx.schema.hasColumn('review_requests', 'followup_next_attempt_at')).toBe(true);
    expect(await trx.schema.hasColumn('review_requests', 'followup_delivered_at')).toBe(true);
  });

  test('latest delivered manual ask excludes failed sends and acknowledgments', async () => {
    await request({ sms_sent_at: at });
    const manualAt = new Date(at.getTime() + 240000);
    await trx('sms_log').insert([
      { created_at: at, message_body: 'Please review us: https://g.page/r/example/review' },
      { created_at: manualAt, message_body: 'Please leave a Google review.' },
      { created_at: new Date(at.getTime() + 300000), message_body: 'Thanks for your Google review' },
      { created_at: new Date(at.getTime() + 360000), message_body: 'Please leave a Google review.', status: 'failed' },
    ].map(row => ({ customer_id: customerId, direction: 'outbound', from_phone: '+12025550101',
      to_phone: '+12025550102', status: 'sent', ...row })));
    expect(await history.lastManualAskAt(customerId, { since: at })).toEqual(manualAt);
  });
});

// Real PostgreSQL notifier/dedupe integration; synthetic rows roll back after each test.
const run = process.env.CALLBACK_ALERTS_POSTGRES === '1' ? describe : describe.skip;
jest.setTimeout(60000);
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => null) }));
run('callback reminder transitions on PostgreSQL', () => {
  const { randomUUID } = require('node:crypto');
  const db = require('../models/db');
  const gates = require('../config/feature-gates').gates;
  const ledger = require('../services/call-commitments');
  const notifications = require('../services/notification-service');
  const cards = require('../services/callback-cards');
  const now = new Date(), ago = new Date(now.getTime() - 86400000), future = new Date(now.getTime() + 3600000);
  let conn, trx, customerId, original, insert;
  beforeAll(() => {
    if (process.env.WAVES_LOCAL_DEV !== '1' || !/^\/waves_qa_[a-f0-9]+$/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('Managed synthetic QA database required');
    conn = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    original = { commitments: gates.callCommitments, card: process.env.GATE_CALLBACK_CARD };
    gates.callCommitments = true;
  });
  beforeEach(async () => {
    process.env.GATE_CALLBACK_CARD = 'true';
    trx = await conn.transaction();
    db.mockImplementation((...args) => trx(...args));
    db.raw = trx.raw.bind(trx); db.transaction = trx.transaction.bind(trx);
    customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Callback', phone: '+15555550176', email: `${customerId}@example.invalid` });
    const list = ledger.listOpenCommitments;
    jest.spyOn(ledger, 'listOpenCommitments').mockImplementation((c, opts) => list(c, { ...opts, customerId }));
    // Keep the production advisory lock/probe/refresh; replace delivery only.
    insert = jest.spyOn(notifications, 'create').mockImplementation(async ({ connection, recipientType, category, title, body, link, metadata }) => {
      const [row] = await connection('notifications').insert({ recipient_type: recipientType, category, title, body, link, metadata }).returning('*');
      return row;
    });
  });
  afterEach(async () => { jest.restoreAllMocks(); await trx.rollback(); });
  afterAll(async () => {
    gates.callCommitments = original.commitments;
    if (original.card === undefined) delete process.env.GATE_CALLBACK_CARD; else process.env.GATE_CALLBACK_CARD = original.card;
    await conn.destroy();
  });
  async function seed(patch = {}) {
    const callId = randomUUID(), id = randomUUID();
    await trx('call_log').insert({ id: callId, customer_id: customerId, direction: 'inbound', from_phone: '+15555550176', status: 'completed', created_at: ago });
    const [row] = await trx('call_commitments').insert({ id, call_log_id: callId, commitment_key: `fixture:${id}`, party: 'waves', kind: 'callback',
      status: 'open', source: 'human', description: 'Synthetic callback', callback_due_at: ago, created_at: ago, ...patch }).returning('*');
    return row;
  }
  const runSweep = () => require('../services/call-commitments-watchdog').runInner({ now });
  const bells = () => trx('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' LIKE 'call-commitment%'");
  const unread = () => bells().whereNull('read_at');

  test('five to six to five reminders preserves staff acknowledgments and repeats without duplicates', async () => {
    const rows = [];
    for (let i = 0; i < 5; i += 1) rows.push(await seed());
    await runSweep();
    expect(await unread()).toHaveLength(5);
    await bells().whereRaw("metadata->>'commitment_id' = ?", [rows[0].id]).update({ read_at: now });
    const extra = await seed();
    await runSweep();
    expect(await unread()).toHaveLength(1);
    expect((await unread())[0].metadata.overdue_count).toBe(6);
    await runSweep();
    expect(await unread()).toHaveLength(1);
    await trx('call_commitments').where({ id: extra.id }).update({ status: 'fulfilled' });
    await runSweep();
    const restored = await unread();
    expect(restored).toHaveLength(4);
    expect(restored.some((r) => r.metadata.commitment_id === rows[0].id)).toBe(false);
    await runSweep();
    expect(await unread()).toHaveLength(4);
    expect(await bells()).toHaveLength(6);
  });

  test.each(['owner', 'deadline', 'snooze', 'review'])('changing %s retires the old identity and persists one new bell', async (change) => {
    const row = await seed(); await runSweep();
    const [first] = await unread();
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    const patch = { owner: { assigned_to: staff.id }, deadline: { due_at: new Date(ago.getTime() + 1000) },
      snooze: { snoozed_until: new Date(ago.getTime() + 2000) }, review: { reviewed_at: now } }[change];
    await trx('call_commitments').where({ id: row.id }).update(patch);
    await runSweep();
    const active = await unread();
    expect(active).toHaveLength(1); expect(active[0].metadata.dedupeVersion).not.toBe(first.metadata.dedupeVersion);
    await runSweep(); expect(await unread()).toHaveLength(1);
  });

  test.each([{ due_at: future }, { snoozed_until: future }, { status: 'fulfilled' }])('no unread reminder remains after %j', async (patch) => {
    const row = await seed(); await runSweep();
    await trx('call_commitments').where({ id: row.id }).update(patch);
    await runSweep(); expect(await unread()).toHaveLength(0);
  });

  test('failed aggregate insertion leaves the existing individual reminders visible', async () => {
    for (let i = 0; i < 5; i += 1) await seed();
    await runSweep(); await seed(); insert.mockResolvedValueOnce(null);
    await expect(runSweep()).rejects.toThrow('admin notification insert failed');
    expect(await unread()).toHaveLength(5);
  });

  test('an overnight backlog replaces yesterday’s unread aggregate', async () => {
    for (let i = 0; i < 6; i += 1) await seed();
    await runSweep();
    const [first] = await unread();
    await require('../services/call-commitments-watchdog').runInner({ now: new Date(now.getTime() + 86400000) });
    const active = await unread();
    expect(active).toHaveLength(1); expect(active[0].id).not.toBe(first.id);
  });

  test('yesterday’s read aggregate does not acknowledge today’s individual reminders', async () => {
    const rows = [];
    for (let i = 0; i < 6; i += 1) rows.push(await seed());
    await runSweep();
    const [aggregate] = await unread();
    await trx('notifications').where({ id: aggregate.id }).update({ read_at: now });
    await trx('call_commitments').where({ id: rows[5].id }).update({ status: 'fulfilled' });
    await require('../services/call-commitments-watchdog').runInner({ now: new Date(now.getTime() + 86400000) });
    expect(await unread()).toHaveLength(5);
  });

  test('returning to a prior aggregate resurfaces it after individual reminders', async () => {
    const rows = [];
    for (let i = 0; i < 6; i += 1) rows.push(await seed());
    await runSweep();
    const [first] = await unread();
    await trx('call_commitments').where({ id: rows[0].id }).update({ status: 'fulfilled' });
    await runSweep(); expect(await unread()).toHaveLength(5);
    await trx('call_commitments').where({ id: rows[0].id }).update({ status: 'open' });
    await runSweep();
    const active = await unread();
    expect(active).toHaveLength(1); expect(active[0].id).toBe(first.id);
  });

  test('a failed fulfillment lookup preserves prior work while verified new work alerts', async () => {
    const failed = await seed();
    for (let i = 0; i < 5; i += 1) await seed();
    await runSweep(); const [first] = await unread();
    const refresh = ledger.refreshFulfillment;
    jest.spyOn(ledger, 'refreshFulfillment').mockImplementation((c, id) => id === failed.call_log_id ? Promise.resolve({ failed: 1 }) : refresh(c, id));
    await seed();
    expect(await runSweep()).toMatchObject({ alerted: 1, overdue: 7, unverified: 1 });
    const active = await unread();
    expect(active).toHaveLength(1); expect(active[0].id).toBe(first.id);
    expect(active[0].metadata.overdue_count).toBe(7);
    expect(active[0].metadata.overdue_commitment_ids).toEqual(expect.arrayContaining(first.metadata.overdue_commitment_ids));
  });

  test('a retired reminder is not prior evidence while proof is failing; the bell returns once proof recovers', async () => {
    const row = await seed();
    await runSweep(); expect(await unread()).toHaveLength(1);
    // Snoozed past now: no longer overdue, its bell is retired.
    await trx('call_commitments').where({ id: row.id }).update({ snoozed_until: new Date(now.getTime() + 3600000) });
    await runSweep(); expect(await unread()).toHaveLength(0);
    // Due again while fulfillment verification fails for its call.
    await trx('call_commitments').where({ id: row.id }).update({ snoozed_until: null });
    const refresh = ledger.refreshFulfillment;
    const spy = jest.spyOn(ledger, 'refreshFulfillment').mockImplementation((c, id) => id === row.call_log_id ? Promise.resolve({ failed: 1 }) : refresh(c, id));
    expect(await runSweep()).toMatchObject({ overdue: 0, unverified: 1 });
    expect(await unread()).toHaveLength(0);
    spy.mockRestore();
    expect(await runSweep()).toMatchObject({ overdue: 1, alerted: 1 });
    expect(await unread()).toHaveLength(1);
  });

  test.each([false, true])('failed proof does not suppress verified work (previous reminder: %s)', async (previous) => {
    const failed = await seed();
    if (previous) { await runSweep(); await unread().update({ read_at: now }); }
    const healthy = await seed();
    const refresh = ledger.refreshFulfillment;
    jest.spyOn(ledger, 'refreshFulfillment').mockImplementation((c, id) => id === failed.call_log_id ? Promise.resolve({ failed: 1 }) : refresh(c, id));
    expect(await runSweep()).toMatchObject({ unverified: 1 });
    expect((await unread()).map((n) => n.metadata.commitment_id)).toEqual([healthy.id]);
    await runSweep();
    expect((await unread()).map((n) => n.metadata.commitment_id)).toEqual([healthy.id]);
  });

  test('real customer conversation evidence closes a callback and retires its reminder', async () => {
    const row = await seed(); await runSweep();
    await trx('call_log').insert({ customer_id: customerId, direction: 'outbound', to_phone: '+15555550176',
      status: 'completed', v2_extraction_status: 'valid', ai_extraction_enriched: { meta: { is_voicemail: false } },
      metadata: { relatedCommitmentId: row.id, customer_leg: { status: 'completed', duration_seconds: 90 } } });
    await runSweep();
    expect((await trx('call_commitments').where({ id: row.id }).first()).status).toBe('fulfilled');
    expect(await unread()).toHaveLength(0);
  });

  test('claim then release refreshes a previously acknowledged individual identity', async () => {
    const row = await seed(); await runSweep(); const [first] = await unread();
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    const claimed = await cards.actOnCallback(trx, row.id, { action: 'claim', actorId: staff.id,
      expectedAt: row.updated_at, now: new Date(now.getTime() + 1000) });
    await runSweep();
    await cards.actOnCallback(trx, row.id, { action: 'release', actorId: staff.id,
      expectedAt: claimed.updated_at, now: new Date(now.getTime() + 2000) });
    await runSweep(); const active = await unread();
    expect(active).toHaveLength(1); expect(active[0].id).toBe(first.id);
    expect(active[0].metadata.dedupeVersion).not.toBe(first.metadata.dedupeVersion);
  });

  test.each([5, 6])('reading a backlog acknowledges unchanged individual versions after starting with %s', async (initial) => {
    const rows = [];
    for (let i = 0; i < initial; i += 1) rows.push(await seed());
    await runSweep();
    if (initial === 5) { rows.push(await seed()); await runSweep(); }
    const [aggregate] = await unread();
    await trx('notifications').where({ id: aggregate.id }).update({ read_at: now });
    await trx('call_commitments').where({ id: rows[5].id }).update({ status: 'fulfilled' });
    await runSweep(); expect(await unread()).toHaveLength(0);
    await runSweep(); expect(await unread()).toHaveLength(0);
    // A later staff transition is new work even though its prior version was read.
    await trx('call_commitments').where({ id: rows[0].id }).update({ updated_at: new Date(now.getTime() + 1000) });
    await runSweep(); expect(await unread()).toHaveLength(1);
  });

  test('mixed callback and non-callback backlogs share one identity through both gate transitions', async () => {
    const callbacks = [];
    for (let i = 0; i < 5; i += 1) callbacks.push(await seed());
    const other = await seed({ kind: 'other', due_at: ago });
    process.env.GATE_CALLBACK_CARD = 'false'; await runSweep();
    const [original] = await unread();
    process.env.GATE_CALLBACK_CARD = 'true'; await runSweep();
    expect((await unread()).map((r) => r.id)).toEqual([original.id]);
    process.env.GATE_CALLBACK_CARD = 'false'; await runSweep();
    expect((await unread()).map((r) => r.id)).toEqual([original.id]);
    process.env.GATE_CALLBACK_CARD = 'true';
    await trx('call_commitments').whereIn('id', callbacks.map((r) => r.id)).update({ status: 'fulfilled' });
    await runSweep(); const active = await unread();
    expect(active).toHaveLength(1); expect(active[0].metadata.commitment_id).toBe(other.id);
  });

  test('undated open cards keep the legacy digest fallback, while staff-closed cards stay closed', async () => {
    const row = await seed({ callback_due_at: null });
    await trx('call_log').where({ id: row.call_log_id }).update({ disposition: 'callback_task_created',
      created_at: new Date(now.getTime() - 60000), updated_at: ago });
    const load = require('../services/unworked-comms-watcher')._private.loadCallbackCalls;
    expect((await load()).some((r) => r.id === row.call_log_id)).toBe(true);
    // A dated sibling on the same call does not hide the undated one.
    const [sibling] = await trx('call_commitments').insert({ id: randomUUID(), call_log_id: row.call_log_id, commitment_key: `fixture:sibling:${row.id}`,
      party: 'waves', kind: 'callback', status: 'open', source: 'human', description: 'Sibling callback', callback_due_at: ago, created_at: ago, updated_at: ago }).returning('*');
    expect((await load()).some((r) => r.id === row.call_log_id)).toBe(true);
    await trx('call_commitments').where({ id: row.id }).update({ status: 'fulfilled' });
    expect((await load()).some((r) => r.id === row.call_log_id)).toBe(false);
    await trx('call_commitments').where({ id: sibling.id }).del();
  });

  test('a callback card the coach’s call_back task already carries is not counted again by the digest', async () => {
    const load = require('../services/unworked-comms-watcher')._private.loadCallbackCalls;
    const carried = await seed();
    const before = Number((await load()).find((r) => r.callback_card_summary)?.total_count || 0);
    const call = await trx('call_log').where({ id: carried.call_log_id }).first();
    const [task] = await trx('ai_follow_up_tasks').insert({ task_type: 'call_back', customer_id: customerId, status: 'pending',
      created_at: new Date(new Date(call.created_at).getTime() + 60000), deadline: new Date(now.getTime() + 86400000) }).returning('id');
    try {
      const after = Number((await load()).find((r) => r.callback_card_summary)?.total_count || 0);
      expect(after).toBe(before - 1);
    } finally {
      await trx('ai_follow_up_tasks').where({ id: task.id }).del();
    }
  });

  test('the digest card count leaves out internal-test customers', async () => {
    const { INTERNAL_TEST_CUSTOMER_IDS } = require('../services/internal-test-customers');
    const load = require('../services/unworked-comms-watcher')._private.loadCallbackCalls;
    const real = await seed();
    const test = await seed();
    await trx('customers').insert({ id: INTERNAL_TEST_CUSTOMER_IDS[0], first_name: 'App', last_name: 'Review', email: 'appreview+fixture@example.invalid', phone: '+15555550199' }).onConflict('id').ignore();
    await trx('call_log').where({ id: test.call_log_id }).update({ customer_id: INTERNAL_TEST_CUSTOMER_IDS[0] });
    const summary = (await load()).find((r) => r.callback_card_summary);
    expect(summary).toBeTruthy();
    const counted = await trx('call_commitments as cc').join('call_log as cl', 'cl.id', 'cc.call_log_id')
      .whereIn('cc.id', [real.id, test.id]).whereNot('cl.customer_id', INTERNAL_TEST_CUSTOMER_IDS[0]).count('cc.id as n').first();
    expect(Number(counted.n)).toBe(1);
    const all = await trx('call_commitments as cc').join('call_log as cl', 'cl.id', 'cc.call_log_id')
      .where({ 'cc.kind': 'callback', 'cc.party': 'waves', 'cc.status': 'open' }).whereRaw('COALESCE(cc.due_at, cc.callback_due_at) <= NOW()')
      .where((b) => b.whereNull('cl.customer_id').orWhereNotIn('cl.customer_id', INTERNAL_TEST_CUSTOMER_IDS)).count('cc.id as n').first();
    expect(Number(summary.total_count)).toBe(Number(all.n));
    expect(Number(summary.total_count)).toBeLessThan(Number((await trx('call_commitments as cc').where({ 'cc.kind': 'callback', 'cc.party': 'waves', 'cc.status': 'open' }).whereRaw('COALESCE(cc.due_at, cc.callback_due_at) <= NOW()').count('cc.id as n').first()).n));
  });

  test.each([0, 5])('unchanged association hints preserve read reminders with %i companion callbacks', async (companions) => {
    const row = await seed({ kind: 'send_appointment_confirmation', due_at: ago, callback_due_at: null });
    for (let i = 0; i < companions; i += 1) await seed();
    await trx('sms_log').insert({ direction: 'outbound', from_phone: '+15555550177', to_phone: '+15555550176',
      message_type: 'confirmation', status: 'sent', created_at: new Date(now.getTime() - 60000) });
    await runSweep();
    const before = await trx('call_commitments').where({ id: row.id }).first();
    expect(before.fulfillment.strength).toBe('association');
    await unread().update({ read_at: now });
    await runSweep();
    await runSweep();
    expect(await unread()).toHaveLength(0);
    expect((await trx('call_commitments').where({ id: row.id }).first()).updated_at).toEqual(before.updated_at);
  });

  test('changed non-callback work does not inherit an old aggregate acknowledgment', async () => {
    const changed = await seed({ kind: 'other', due_at: ago, callback_due_at: null });
    const callbacks = [];
    for (let i = 0; i < 5; i += 1) callbacks.push(await seed());
    await runSweep();
    await unread().update({ read_at: now });
    await trx('call_commitments').where({ id: changed.id }).update({ due_at: new Date(ago.getTime() + 1000), updated_at: now });
    await trx('call_commitments').where({ id: callbacks[0].id }).update({ status: 'fulfilled' });
    await runSweep();
    expect((await unread()).map((row) => row.metadata.commitment_id)).toEqual([changed.id]);
    await runSweep();
    expect((await unread()).map((row) => row.metadata.commitment_id)).toEqual([changed.id]);
  });

  test.each([[1, false], [1, true], [6, false], [6, true]])('an empty gate transition restores %i reminders after rollback (read: %s)', async (count, read) => {
    for (let i = 0; i < count; i += 1) await seed({ callback_due_at: future });
    process.env.GATE_CALLBACK_CARD = 'false';
    await runSweep(); const [first] = await unread();
    if (read) await unread().update({ read_at: now });
    process.env.GATE_CALLBACK_CARD = 'true';
    await runSweep(); expect(await unread()).toHaveLength(0);
    process.env.GATE_CALLBACK_CARD = 'false';
    await runSweep();
    const active = await unread();
    expect(active).toHaveLength(1); expect(active[0].id).toBe(first.id);
    if (count > 5) expect(active[0].metadata.retired).toBe(false);
  });

  test('gate rollback keeps one shared reminder for the same callback', async () => {
    await seed(); await runSweep(); process.env.GATE_CALLBACK_CARD = 'false';
    await runSweep(); expect(await unread()).toHaveLength(1);
  });
});

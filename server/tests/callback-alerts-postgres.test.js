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
  const now = new Date(), ago = new Date(now.getTime() - 3600000), future = new Date(now.getTime() + 3600000);
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
  const runSweep = () => cards.notifyDueCallbacks(trx, { now });
  const bells = () => trx('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' LIKE 'callback-card%'");
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
    expect(active).toHaveLength(1); expect(active[0].id).not.toBe(first.id);
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
    await cards.notifyDueCallbacks(trx, { now: new Date(now.getTime() + 86400000) });
    const active = await unread();
    expect(active).toHaveLength(1); expect(active[0].id).not.toBe(first.id);
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

  test('a failed fulfillment scan preserves the full prior backlog', async () => {
    for (let i = 0; i < 6; i += 1) await seed();
    await runSweep(); const [first] = await unread();
    jest.spyOn(ledger, 'refreshFulfillment').mockResolvedValueOnce({ failed: 1 });
    await seed();
    expect(await runSweep()).toEqual({ alerted: 0 });
    const active = await unread();
    expect(active).toHaveLength(1); expect(active[0]).toEqual(first);
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

  test('the gate disables the sweep without creating or acknowledging reminders', async () => {
    await seed(); await runSweep(); process.env.GATE_CALLBACK_CARD = 'false';
    expect(await runSweep()).toEqual({ alerted: 0 }); expect(await unread()).toHaveLength(1);
  });
});

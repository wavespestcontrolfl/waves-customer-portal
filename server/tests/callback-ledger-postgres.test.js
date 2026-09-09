// Opt-in against the established synthetic QA database; every test rolls back.
const run = process.env.CALLBACK_LEDGER_POSTGRES === '1' ? describe : describe.skip;
// Remote QA round trips can exceed Jest's five-second unit-test default.
jest.setTimeout(30000);
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => null) }));


run('callback ledger on PostgreSQL', () => {
  const { randomUUID } = require('node:crypto');
  const db = require('../models/db');
  let conn, trx, cards, gates, originalGates;
  const phone = '+15555550176';
  const now = new Date();
  const ago = new Date(now.getTime() - 3600000);
  const future = new Date(now.getTime() + 86400000);

  beforeAll(() => {
    if (process.env.WAVES_LOCAL_DEV !== '1' || !/^\/waves_qa_[a-f0-9]+$/.test(new URL(process.env.DATABASE_URL).pathname)) {
      throw new Error('Callback regression tests require the managed synthetic QA database');
    }
    conn = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    gates = require('../config/feature-gates').gates;
    originalGates = { callCommitments: gates.callCommitments, card: process.env.GATE_CALLBACK_CARD };
    gates.callCommitments = true;
    process.env.GATE_CALLBACK_CARD = 'true';
    cards = require('../services/callback-cards');
  });
  beforeEach(async () => {
    trx = await conn.transaction();
    db.mockImplementation((...args) => trx(...args));
    db.raw = trx.raw.bind(trx);
    db.transaction = trx.transaction.bind(trx);
  });
  afterEach(async () => { jest.restoreAllMocks(); await trx.rollback(); });
  afterAll(async () => {
    gates.callCommitments = originalGates.callCommitments;
    if (originalGates.card === undefined) delete process.env.GATE_CALLBACK_CARD;
    else process.env.GATE_CALLBACK_CARD = originalGates.card;
    await conn.destroy();
  });

  async function seed(patch = {}) {
    const callId = randomUUID(), id = randomUUID();
    await trx('call_log').insert({ id: callId, direction: 'inbound', from_phone: phone,
      to_phone: '+15555550100', status: 'completed', created_at: ago, updated_at: ago });
    const [row] = await trx('call_commitments').insert({ id, call_log_id: callId, commitment_key: `fixture:${id}`,
      party: 'waves', kind: 'callback', status: 'open', source: 'human', description: 'Synthetic callback',
      callback_due_at: ago, created_at: ago, updated_at: ago, ...patch }).returning('*');
    return row;
  }
  test('existing, human-created and edited callbacks receive deadlines without the notification worker', async () => {
    const ledger = require('../services/call-commitments');
    const existing = await seed({ callback_due_at: null });
    await ledger.listOpenCommitments(trx);
    expect((await trx('call_commitments').where({ id: existing.id }).first()).callback_due_at).not.toBeNull();
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    const added = await ledger.addHumanCommitment(trx, existing.call_log_id, {
      party: 'waves', kind: 'callback', description: 'Call about the next visit', reviewedBy: staff.id, due_at: future,
    });
    expect(added.callback_due_at).not.toBeNull();
    const edited = await cards.actOnCallback(trx, added.id, { action: 'edit', actorId: staff.id,
      expectedAt: added.updated_at, due_at: null, now });
    expect(edited.due_at).toBeNull();
    expect(edited.effective_due_at).toEqual(edited.callback_due_at);
    expect(edited.callback_due_at).not.toBeNull();
  });

  test('snooze takes shared ownership and rejects a second action on the old version', async () => {
    const row = await seed();
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    expect(staff).toBeTruthy();
    const changed = await cards.actOnCallback(trx, row.id, { action: 'snooze', actorId: staff.id,
      expectedAt: row.updated_at, snooze: 'two_hours', now });
    expect(changed.assigned_to).toBe(staff.id);
    expect(changed.snoozed_until).toEqual(new Date(now.getTime() + 2 * 3600000));
    const ledger = require('../services/call-commitments');
    expect(ledger.selectOverdue([changed], { now })).toEqual([]);
    expect(await ledger.stillOpenIds(trx, [row.id], { now })).toEqual(new Set());
    expect(await ledger.stillOpenIds(trx, [row.id], { now: new Date(now.getTime() + 3 * 3600000) })).toEqual(new Set([row.id]));
    await expect(cards.actOnCallback(trx, row.id, { action: 'fulfill', actorId: staff.id,
      expectedAt: row.updated_at, now })).rejects.toMatchObject({ status: 409 });
    expect((await trx('call_commitments').where({ id: row.id }).first()).status).toBe('open');
  });

  test('acting on one callback preserves a shared reminder for other open promises', async () => {
    const row = await seed(), other = await seed();
    const [bell] = await trx('notifications').insert({ recipient_type: 'admin', category: 'alert', title: 'Fixture backlog',
      metadata: { overdue_commitment_ids: [row.id, other.id] } }).returning('*');
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    const claimed = await cards.actOnCallback(trx, row.id, { action: 'claim', actorId: staff.id, expectedAt: row.updated_at, now });
    expect((await trx('notifications').where({ id: bell.id }).first()).read_at).toBeNull();
    await cards.actOnCallback(trx, row.id, { action: 'fulfill', actorId: staff.id, expectedAt: claimed.updated_at, now });
    expect((await trx('notifications').where({ id: bell.id }).first()).read_at).toBeNull();
  });

  test.each(['confirm', 'edit', 'claim'])('a newer extraction rejects a stale %s action without reviving the callback', async (action) => {
    const row = await seed({ source: 'ai', last_seen_generation: 1 });
    await trx('call_commitments').insert({ call_log_id: row.call_log_id, commitment_key: 'waves:send_report',
      party: 'waves', kind: 'send_report', description: 'Newer extraction', source: 'ai', last_seen_generation: 2 });
    const staff = await trx('technicians').where({ employment_status: 'active' }).first('id');
    expect(staff).toBeTruthy();
    await expect(cards.actOnCallback(trx, row.id, { action, actorId: staff.id, expectedAt: row.updated_at,
      description: 'Edited stale callback' })).rejects.toMatchObject({ status: 409 });
    const unchanged = await trx('call_commitments').where({ id: row.id }).first();
    expect(unchanged.human_state).toBeNull();
    expect(unchanged.updated_at).toEqual(row.updated_at);
  });

  test('the fallback is independent of a stated date and refreshes when extraction changes the source timing', async () => {
    const ledger = require('../services/call-commitments');
    const row = await seed({ source: 'ai', callback_due_at: null, due_at: future, last_seen_generation: 1 });
    await cards.prepareCallbackCards(trx, { callId: row.call_log_id });
    const calendar = await cards.loadCalendar(trx, ago);
    const first = await trx('call_commitments').where({ id: row.id }).first();
    expect(first.callback_due_at).toEqual(cards.staffedDeadline(ago, calendar));
    expect(first.due_at).toEqual(future);
    await trx('call_commitments').where({ id: row.id }).update({ commitment_key: 'waves:callback' });
    await trx('call_log').where({ id: row.call_log_id }).update({ processing_generation: 2, duration_seconds: 7200 });
    await ledger.upsertCommitments(trx, row.call_log_id, [{ party: 'waves', kind: 'callback', description: 'Call back', due_at: null }],
      { generation: 2, procGeneration: 2 });
    const changed = await trx('call_commitments').where({ id: row.id }).first();
    expect(changed.callback_due_at).toBeNull();
    await cards.prepareCallbackCards(trx, { callId: row.call_log_id });
    const source = await trx('call_log').where({ id: row.call_log_id }).first();
    const ended = ledger.callEndedAt(source);
    const currentCalendar = await cards.loadCalendar(trx, ended);
    const current = await trx('call_commitments').where({ id: row.id }).first();
    expect(current.due_at).toBeNull();
    expect(current.callback_due_at).toEqual(cards.staffedDeadline(ended, currentCalendar));
  });

  test.each([[true, true], [false, false]])('re-extraction preserves a fallback when reviewed=%s and cards enabled=%s', async (reviewed, enabled) => {
    const row = await seed({ source: 'ai', human_state: reviewed ? 'confirmed' : null, last_seen_generation: 1 });
    await trx('call_commitments').where({ id: row.id }).update({ commitment_key: 'waves:callback' });
    const gate = process.env.GATE_CALLBACK_CARD;
    process.env.GATE_CALLBACK_CARD = String(enabled);
    try {
      await require('../services/call-commitments').upsertCommitments(trx, row.call_log_id,
        [{ party: 'waves', kind: 'callback', description: 'New extraction', due_at: future }], { generation: 2 });
      expect((await trx('call_commitments').where({ id: row.id }).first()).callback_due_at).toEqual(row.callback_due_at);
    } finally { process.env.GATE_CALLBACK_CARD = gate; }
  });

  test('preparation cannot install a deadline computed before a concurrent row update', async () => {
    const row = await seed({ callback_due_at: null });
    const duringPrepare = (...args) => trx(...args);
    duringPrepare.raw = trx.raw.bind(trx);
    duringPrepare.transaction = async (fn) => {
      await trx('call_commitments').where({ id: row.id }).update({ due_at: future, updated_at: future });
      return trx.transaction(fn);
    };
    await cards.prepareCallbackCards(duringPrepare, { callId: row.call_log_id });
    const current = await trx('call_commitments').where({ id: row.id }).first();
    expect(current.callback_due_at).toBeNull();
    expect(current.due_at).toEqual(future);
    expect(current.updated_at).toEqual(future);
  });

});

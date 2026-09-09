// Opt-in against the established synthetic QA database; every test rolls back.
const run = process.env.CALLBACK_REVIEW_POSTGRES === '1' ? describe : describe.skip;
// Remote QA round trips can exceed Jest's five-second unit-test default.
jest.setTimeout(30000);
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => null) }));
jest.mock('../services/call-bridge', () => ({
  activeBridgeCall: jest.fn(async () => null),
  placeBridgeCall: jest.fn(async () => ({ callSid: 'CA_fixture', callLogId: 'fixture-bridge' })),
}));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => null) }));

run('callback review regressions on PostgreSQL', () => {
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
    originalGates = { callCommitments: gates.callCommitments, twilioVoice: gates.twilioVoice, card: process.env.GATE_CALLBACK_CARD };
    gates.callCommitments = gates.twilioVoice = true;
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
    gates.twilioVoice = originalGates.twilioVoice;
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
  async function bell(row, patch = {}) {
    const [notice] = await trx('notifications').insert({ recipient_type: 'admin', category: 'alert', title: 'Fixture callback',
      metadata: { dedupeKey: `callback-card:${row.id}:${new Date(row.due_at || row.callback_due_at).toISOString()}:fixture`, commitment_id: row.id }, ...patch }).returning('*');
    return notice;
  }

  test('automatic fulfillment retires its individual bell and keeps an open callback bell unread', async () => {
    const done = await seed(), open = await seed();
    const doneBell = await bell(done), openBell = await bell(open);
    await trx('call_log').insert({ direction: 'outbound', from_phone: '+15555550100', to_phone: phone,
      status: 'completed', created_at: now, v2_extraction_status: 'valid', ai_extraction_enriched: { meta: { is_voicemail: false } },
      metadata: { relatedCommitmentId: done.id, customer_leg: { status: 'completed', duration_seconds: 90 } } });
    await cards.notifyDueCallbacks(trx, { now });
    expect((await trx('call_commitments').where({ id: done.id }).first()).status).toBe('fulfilled');
    expect((await trx('notifications').where({ id: doneBell.id }).first()).read_at).not.toBeNull();
    expect((await trx('notifications').where({ id: openBell.id }).first()).read_at).toBeNull();
    // Feed fulfillment can precede a sweep that no longer selects the card.
    await trx('notifications').where({ id: doneBell.id }).update({ read_at: null });
    await cards.notifyDueCallbacks(trx, { now });
    expect((await trx('notifications').where({ id: doneBell.id }).first()).read_at).not.toBeNull();
  });

  test.each(['due_at', 'callback_due_at'])('automatic %s changes retire obsolete bells before and after the new deadline', async (field) => {
    const row = await seed();
    const obsolete = await bell(row);
    await trx('call_commitments').where({ id: row.id }).update({ [field]: future });
    await cards.notifyDueCallbacks(trx, { now });
    expect((await trx('notifications').where({ id: obsolete.id }).first()).read_at).not.toBeNull();

    // Also cover a sweep that first observes the change after it is overdue.
    await trx('notifications').where({ id: obsolete.id }).update({ read_at: null });
    const current = await trx('call_commitments').where({ id: row.id }).first();
    const currentBell = await bell(current);
    await cards.notifyDueCallbacks(trx, { now: new Date(future.getTime() + 3600000) });
    expect((await trx('notifications').where({ id: obsolete.id }).first()).read_at).not.toBeNull();
    expect((await trx('notifications').where({ id: currentBell.id }).first()).read_at).toBeNull();
  });

  test('EOD counts due cards and expired snoozes, excluding future, snoozed and undated work', async () => {
    const { loadCallbackCalls } = require('../services/unworked-comms-watcher')._private;
    const count = async () => (await loadCallbackCalls(now)).find((r) => r.callback_card_summary)?.total_count || 0;
    const baseline = Number(await count());
    await seed();
    await seed({ snoozed_until: ago });
    await seed({ due_at: future });
    await seed({ callback_due_at: future });
    await seed({ snoozed_until: future });
    await seed({ callback_due_at: null });
    expect(Number(await count()) - baseline).toBe(2);
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

  test('the call route rejects a superseded callback even when its row version did not change', async () => {
    const row = await seed({ source: 'ai', last_seen_generation: 1 });
    await trx('call_commitments').insert({ call_log_id: row.call_log_id, commitment_key: 'waves:send_report',
      party: 'waves', kind: 'send_report', description: 'Newer extraction', source: 'ai', last_seen_generation: 2 });
    const router = require('../routes/admin-communications');
    const handler = router.stack.find((r) => r.route?.path === '/call').route.stack.at(-1).handle;
    const bridge = require('../services/call-bridge').placeBridgeCall;
    bridge.mockClear();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler({ body: { to: phone, relatedCommitmentId: row.id, expected_at: row.updated_at.toISOString() },
      technicianId: null, techRole: 'admin' }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(bridge).not.toHaveBeenCalled();
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

  test('an unlinked source can call a phone that now uniquely belongs to a customer', async () => {
    const row = await seed();
    const customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Callback', email: `${customerId}@example.invalid`, phone });
    const router = require('../routes/admin-communications');
    const handler = router.stack.find((r) => r.route?.path === '/call').route.stack.at(-1).handle;
    const bridge = require('../services/call-bridge').placeBridgeCall;
    bridge.mockClear();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await handler({ body: { to: phone, relatedCommitmentId: row.id, expected_at: row.updated_at.toISOString() },
      technicianId: null, techRole: 'admin' }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(bridge).toHaveBeenCalledWith(expect.objectContaining({ customer: null,
      metadata: { relatedCommitmentId: row.id, relatedCallId: row.call_log_id } }));
  });
});

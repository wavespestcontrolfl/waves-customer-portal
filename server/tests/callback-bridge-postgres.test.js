// Opt-in: real two-connection PostgreSQL pool, synthetic rows, mocked transport.
const run = process.env.CALLBACK_BRIDGE_POSTGRES === '1' ? describe : describe.skip;
jest.setTimeout(30000);
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ twilio: { accountSid: `AC${'0'.repeat(32)}`, authToken: 'synthetic-auth' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => null) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(async () => null) }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => null) }));
const mockCreate = jest.fn();
jest.mock('twilio', () => Object.assign(
  jest.fn(() => ({ calls: { create: (...args) => mockCreate(...args) } })), jest.requireActual('twilio'),
));

run('callback bridge on PostgreSQL', () => {
  const { randomUUID, randomBytes, randomInt } = require('node:crypto');
  const db = require('../models/db');
  const numbers = require('../config/twilio-numbers');
  const gates = require('../config/feature-gates').gates;
  const phone = '+15555550176', cell = '+15555550177';
  const from = `+1555555${randomInt(1000, 10000)}`;
  const claimKey = () => `callback-card-bridge:${phone}`;
  const callIds = [], commitmentIds = [];
  let conn, handler, customerId, staffId, originalGates, originalFrom;

  beforeAll(() => {
    if (process.env.WAVES_LOCAL_DEV !== '1' || !/^\/waves_qa_[a-f0-9]+$/.test(new URL(process.env.DATABASE_URL).pathname)) {
      throw new Error('Callback bridge tests require the managed synthetic QA database');
    }
    conn = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    db.mockImplementation((...args) => conn(...args));
    db.raw = conn.raw.bind(conn);
    db.transaction = conn.transaction.bind(conn);
    originalGates = { commitments: gates.callCommitments, card: process.env.GATE_CALLBACK_CARD };
    gates.callCommitments = true;
    process.env.GATE_CALLBACK_CARD = 'true';
    originalFrom = numbers.mainLine.number;
    numbers.mainLine.number = from;
    const router = require('../routes/admin-communications');
    handler = router.stack.find((r) => r.route?.path === '/call').route.stack.at(-1).handle;
  });
  beforeEach(async () => {
    customerId = randomUUID(); staffId = randomUUID();
    await conn('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Callback', email: `${customerId}@example.invalid`, phone });
    await conn('technicians').insert({ id: staffId, name: 'Synthetic Callback Staff', email: `${staffId}@example.invalid`, phone: cell, role: 'technician', employment_status: 'active' });
    mockCreate.mockReset().mockImplementation(async () => {
      // Provider work must be able to borrow this same bounded pool.
      await conn('call_log').whereIn('id', callIds).count('id');
      return { sid: `CA${randomBytes(16).toString('hex')}`, status: 'queued' };
    });
  });
  afterEach(async () => {
    callIds.push(...await conn('call_log').where({ from_phone: from, direction: 'outbound' }).pluck('id'));
    await conn('call_commitments').whereIn('id', commitmentIds).del();
    await conn('call_log').whereIn('id', callIds).del();
    await conn('sms_send_claims').whereIn('claim_key', [claimKey(), 'callback-card-bridge:+15555550178', 'callback-card-bridge:+15555550175', `callback-card-bridge:customer:${customerId}`]).del();
    await conn('customers').where({ id: customerId }).del();
    await conn('technicians').where({ id: staffId }).del();
    callIds.length = commitmentIds.length = 0;
    process.env.GATE_CALLBACK_CARD = 'true';
  });
  afterAll(async () => {
    gates.callCommitments = originalGates.commitments;
    if (originalGates.card === undefined) delete process.env.GATE_CALLBACK_CARD;
    else process.env.GATE_CALLBACK_CARD = originalGates.card;
    numbers.mainLine.number = originalFrom;
    await conn.destroy();
  });

  async function seed({ linked = true, sourcePhone = phone } = {}) {
    const callId = randomUUID(), id = randomUUID(), ago = new Date(Date.now() - 3600000);
    callIds.push(callId); commitmentIds.push(id);
    await conn('call_log').insert({ id: callId, customer_id: linked ? customerId : null, direction: 'inbound',
      from_phone: sourcePhone, to_phone: from, status: 'completed', created_at: ago, updated_at: ago });
    const [row] = await conn('call_commitments').insert({ id, call_log_id: callId, commitment_key: `fixture:${id}`,
      party: 'waves', kind: 'callback', status: 'open', source: 'ai', last_seen_generation: 1,
      description: 'Synthetic callback', callback_due_at: new Date(Date.now() + 3600000), created_at: ago, updated_at: ago }).returning('*');
    return row;
  }
  async function invoke(row, patch = {}, actor = {}) {
    let status = 200, json;
    await handler({ body: { to: phone, customerId, relatedCommitmentId: row.id, expected_at: row.updated_at.toISOString(), ...patch },
      technicianId: staffId, techRole: 'technician', ...actor }, {
      status(value) { status = value; return this; }, json(value) { json = value; return this; },
    }, (err) => { status = err.status || 500; json = { error: err.message }; });
    return { status, json };
  }

  test('two simultaneous attempts place one staff-first bridge with a two-connection pool', async () => {
    const row = await seed();
    const attempts = await Promise.all([invoke(row), invoke(row)]);
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ to: cell, from }));
    const call = await conn('call_log').where({ id: attempts.find((r) => r.status === 200).json.callLogId }).first();
    expect(call.metadata).toMatchObject({ relatedCommitmentId: row.id, relatedCallId: row.call_log_id });
    const current = await conn('call_commitments').where({ id: row.id }).first();
    expect(current.assigned_to).toBe(staffId);
    expect((await invoke(current)).status).toBe(409);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('two promises to one customer at two of their numbers place one bridge at a time', async () => {
    const contact = '+15555550175';
    await conn('customers').where({ id: customerId }).update({ secondary_phone: contact });
    const [first, second] = [await seed(), await seed({ sourcePhone: contact })];
    const attempts = await Promise.all([invoke(first), invoke(second, { to: contact })]);
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('two promises to one customer from different calls place one bridge at a time', async () => {
    const [first, second] = [await seed(), await seed()];
    const attempts = await Promise.all([invoke(first), invoke(second)]);
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('starting the call records the office review, so a later extraction cannot withdraw the callback', async () => {
    const row = await seed();
    expect((await invoke(row)).status).toBe(200);
    const claimed = await conn('call_commitments').where({ id: row.id }).first();
    expect(claimed.human_state).toBe('confirmed');
    expect(claimed.reviewed_by).toBe(staffId);
    const id = randomUUID(); commitmentIds.push(id);
    await conn('call_commitments').insert({ id, call_log_id: row.call_log_id, commitment_key: 'waves:send_report',
      party: 'waves', kind: 'send_report', description: 'Newer extraction', source: 'ai', last_seen_generation: 2 });
    const live = await require('../services/call-commitments').listOpenCommitments(conn, { kind: 'callback', customerId });
    expect(live.map((r) => r.id)).toContain(row.id);
  });

  test('a ringing callback blocks only its own customer, and rings the acting administrator’s cell', async () => {
    const first = await seed();
    const otherCustomer = randomUUID(), otherPhone = '+15555550178';
    await conn('customers').insert({ id: otherCustomer, first_name: 'Other', last_name: 'Callback', email: `${otherCustomer}@example.invalid`, phone: otherPhone });
    try {
      const second = await seed({ sourcePhone: otherPhone });
      await conn('call_log').where({ id: second.call_log_id }).update({ customer_id: otherCustomer });
      expect((await invoke(first)).status).toBe(200);
      expect((await invoke(second, { to: otherPhone, customerId: otherCustomer }, { techRole: 'admin' })).status).toBe(200);
      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(mockCreate.mock.calls.every(([args]) => args.to === cell)).toBe(true);
      expect((await invoke(await conn('call_commitments').where({ id: first.id }).first())).status).toBe(409);
      expect(mockCreate).toHaveBeenCalledTimes(2);
    } finally {
      callIds.push(...await conn('call_log').where({ customer_id: otherCustomer }).pluck('id')); await conn('sms_send_claims').where({ claim_key: `callback-card-bridge:customer:${otherCustomer}` }).del();
      await conn('call_log').whereIn('id', callIds).del();
      await conn('customers').where({ id: otherCustomer }).del();
    }
  });

  test('the existing Call Log callback action takes the same customer interlock as the card', async () => {
    const row = await seed();
    expect((await invoke(row)).status).toBe(200);
    const legacy = await invoke(row, { relatedCommitmentId: undefined, source: 'call-log-callback', relatedCallId: row.call_log_id });
    expect(legacy.status).toBe(409);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const placed = await conn('call_log').where({ from_phone: from, direction: 'outbound' }).first();
    expect(placed.metadata).toMatchObject({ relatedCommitmentId: row.id, callback_policy: 'card' });
  });

  test('an unlinked card bridge and the Call Log action for the same number share one interlock', async () => {
    const row = await seed({ linked: false });
    expect((await invoke(row, { customerId: undefined })).status).toBe(200);
    const legacy = await invoke(row, { relatedCommitmentId: undefined, source: 'call-log-callback', relatedCallId: row.call_log_id });
    expect(legacy.status).toBe(409);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('an unlinked callback persists its canonical dial target so the live-call interlock matches it', async () => {
    const row = await seed({ linked: false });
    const result = await invoke(row, { customerId: undefined, to: '(555) 555-0176' });
    expect(result.status).toBe(200);
    const placed = await conn('call_log').where({ id: result.json.callLogId }).first();
    expect(placed.to_phone).toBe(phone);
    expect(await require('../services/call-bridge').activeBridgeCall({ source: 'admin-callback', customerId: null, toPhone: phone }, conn)).toMatchObject({ id: placed.id });
  });

  test.each(['gate', 'version', 'extraction', 'staff_phone'])('%s refusal cannot contact the provider', async (reason) => {
    const row = await seed();
    if (reason === 'gate') process.env.GATE_CALLBACK_CARD = 'false';
    if (reason === 'version') await conn('call_commitments').where({ id: row.id }).update({ updated_at: new Date() });
    if (reason === 'extraction') {
      const id = randomUUID(); commitmentIds.push(id);
      await conn('call_commitments').insert({ id, call_log_id: row.call_log_id, commitment_key: 'waves:send_report',
        party: 'waves', kind: 'send_report', description: 'Newer extraction', source: 'ai', last_seen_generation: 2 });
    }
    if (reason === 'staff_phone') await conn('technicians').where({ id: staffId }).update({ phone: from });
    expect((await invoke(row)).status).toBe(409);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test.each([false, true])('provider failure retains the claim only when ambiguous=%s', async (ambiguous) => {
    const row = await seed();
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('Synthetic provider failure'), { status: ambiguous ? 503 : 400, code: ambiguous ? 20500 : 21219 }));
    expect((await invoke(row)).status).not.toBe(200);
    expect(await conn('sms_send_claims').where({ claim_key: claimKey() })).toHaveLength(ambiguous ? 1 : 0);
    const call = await conn('call_log').where({ from_phone: from, direction: 'outbound' }).first();
    expect(call.status).toBe(ambiguous ? 'initiated' : 'failed');
  });

  test.each(require('../utils/known-caller-phone').KNOWN_CALLER_PHONE_COLS)('accepts the original caller in the selected customer’s %s field', async (column) => {
    const contact = '+15555550175';
    await conn('customers').where({ id: customerId }).update({ [column]: contact });
    const row = await seed({ sourcePhone: contact });
    expect((await invoke(row, { to: contact })).status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('another known customer phone cannot replace the original caller', async () => {
    const row = await seed();
    await conn('customers').where({ id: customerId }).update({ secondary_phone: '+15555550175' });
    expect((await invoke(row, { to: '+15555550175' })).status).toBe(409);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('a source without a customer keeps that association even if the phone now matches one', async () => {
    const row = await seed({ linked: false });
    const result = await invoke(row, { customerId: undefined });
    expect(result.status).toBe(200);
    expect((await conn('call_log').where({ id: result.json.callLogId }).first()).customer_id).toBeNull();
  });

  test('a completed customer conversation on a card-started call closes the callback through refresh', async () => {
    const row = await seed();
    const started = await invoke(row);
    expect(started.status).toBe(200);
    const legEnded = new Date().toISOString();
    await conn('call_log').where({ id: started.json.callLogId }).update({ status: 'completed', v2_extraction_status: 'valid',
      ai_extraction_enriched: { meta: { is_voicemail: false } },
      metadata: conn.raw('metadata || ?::jsonb', [JSON.stringify({ customer_leg: { status: 'completed', duration_seconds: 90, ended_at: legEnded } })]) });
    expect(await require('../services/call-commitments').refreshFulfillment(conn, row.call_log_id)).toMatchObject({ fulfilled: 1 });
    const kept = await conn('call_commitments').where({ id: row.id }).first();
    expect(kept.status).toBe('fulfilled');
    expect(kept.human_state).toBe('confirmed');
    expect(new Date(kept.fulfilled_at).toISOString()).toBe(legEnded);
  });

  test('a callback placed from the existing call log (source-call link only) closes on its completed customer leg', async () => {
    const row = await seed();
    const legEnded = new Date().toISOString();
    const [outbound] = await conn('call_log').insert({ customer_id: customerId, direction: 'outbound', from_phone: from, to_phone: phone,
      status: 'completed', v2_extraction_status: 'valid', ai_extraction_enriched: { meta: { is_voicemail: false } },
      metadata: { relatedCallId: row.call_log_id, callback_policy: 'card', customer_leg: { status: 'completed', duration_seconds: 90, ended_at: legEnded } } }).returning('id');
    expect(await require('../services/call-commitments').refreshFulfillment(conn, row.call_log_id)).toMatchObject({ fulfilled: 1 });
    const kept = await conn('call_commitments').where({ id: row.id }).first();
    expect(kept.fulfillment).toMatchObject({ record_id: outbound.id, basis: 'callback_customer_conversation' });
    expect(new Date(kept.fulfilled_at).toISOString()).toBe(legEnded);
  });

  test.each(['conversation', 'voicemail', 'short', 'unrelated'])('fulfillment requires the matching customer conversation: %s', async (evidence) => {
    const row = await seed();
    const legEnded = new Date(Date.now() - 600000).toISOString();
    const [outbound] = await conn('call_log').insert({ customer_id: customerId, direction: 'outbound', from_phone: from, to_phone: phone,
      status: 'completed', v2_extraction_status: 'valid', ai_extraction_enriched: { meta: { is_voicemail: evidence === 'voicemail' } },
      metadata: { relatedCommitmentId: evidence === 'unrelated' ? randomUUID() : row.id,
        customer_leg: { status: 'completed', duration_seconds: evidence === 'short' ? 59 : 90, ended_at: legEnded } } }).returning('id');
    const source = await conn('call_log').where({ id: row.call_log_id }).first();
    const proof = await require('../services/call-commitments').resolveFulfillment(conn, row, source);
    if (evidence === 'conversation') {
      expect(proof).toMatchObject({ record_id: outbound.id, basis: 'callback_customer_conversation' });
      // Kept when the customer leg ended, not when the staff leg was dialed.
      expect(new Date(proof.matched_at).toISOString()).toBe(legEnded);
    } else expect(proof).toBeNull();
  });

  test.each(['policy', 'legacy'])('gate rollback: a %s Call Log attempt with an unanswered customer leg is judged by its own contract', async (kind) => {
    const row = await seed();
    await conn('call_log').insert({ customer_id: customerId, direction: 'outbound', from_phone: from, to_phone: phone,
      status: 'completed', duration_seconds: 120, v2_extraction_status: 'valid', ai_extraction_enriched: { meta: { is_voicemail: false } },
      metadata: kind === 'policy'
        ? { relatedCallId: row.call_log_id, callback_policy: 'card', customer_leg: { status: 'no-answer', duration_seconds: 0 } }
        : { relatedCallId: row.call_log_id } });
    process.env.GATE_CALLBACK_CARD = 'false';
    const source = await conn('call_log').where({ id: row.call_log_id }).first();
    const proof = await require('../services/call-commitments').resolveFulfillment(conn, row, source);
    // Under the card policy the unanswered leg is not proof; a pre-policy
    // attempt keeps the legacy connected-call rule it was placed under.
    if (kind === 'policy') expect(proof).toBeNull();
    else expect(proof).toMatchObject({ basis: 'callback_returned_connected_outbound_call' });
  });

  test('gate rollback: a claimed callback still closes on a policy-stamped Call Log attempt through refresh', async () => {
    const row = await seed();
    const staff = await conn('technicians').where({ id: staffId }).first();
    const claimed = await require('../services/callback-cards').actOnCallback(conn, row.id, { action: 'claim', actorId: staff.id, expectedAt: row.updated_at });
    expect(claimed.human_state).toBe('confirmed');
    const legEnded = new Date(Date.now() + 1000).toISOString();
    await conn('call_log').insert({ customer_id: customerId, direction: 'outbound', from_phone: from, to_phone: phone,
      status: 'completed', v2_extraction_status: 'valid', ai_extraction_enriched: { meta: { is_voicemail: false } },
      created_at: new Date(Date.now() + 1000),
      metadata: { relatedCallId: row.call_log_id, callback_policy: 'card', customer_leg: { status: 'completed', duration_seconds: 90, ended_at: legEnded } } });
    process.env.GATE_CALLBACK_CARD = 'false';
    expect(await require('../services/call-commitments').refreshFulfillment(conn, row.call_log_id)).toMatchObject({ fulfilled: 1 });
    expect((await conn('call_commitments').where({ id: row.id }).first()).status).toBe('fulfilled');
  });

  test.each(['conversation', 'unanswered', 'voicemail'])('gate rollback retains customer-leg proof: %s', async (evidence) => {
    const row = await seed();
    const [outbound] = await conn('call_log').insert({ customer_id: customerId, direction: 'outbound', from_phone: from, to_phone: phone,
      status: 'completed', duration_seconds: 120, v2_extraction_status: 'valid',
      ai_extraction_enriched: { meta: { is_voicemail: evidence === 'voicemail' } },
      metadata: { relatedCommitmentId: row.id, customer_leg: {
        status: evidence === 'unanswered' ? 'no-answer' : 'completed', duration_seconds: evidence === 'unanswered' ? 0 : 90,
      } } }).returning('id');
    process.env.GATE_CALLBACK_CARD = 'false';
    const source = await conn('call_log').where({ id: row.call_log_id }).first();
    const proof = await require('../services/call-commitments').resolveFulfillment(conn, row, source);
    if (evidence === 'conversation') expect(proof).toMatchObject({ record_id: outbound.id, basis: 'callback_customer_conversation' });
    else expect(proof).toBeNull();
  });

});

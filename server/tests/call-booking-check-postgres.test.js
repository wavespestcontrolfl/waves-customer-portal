/**
 * Call booking check (owner 2026-11-22, "fix") against live Postgres, through the real reads, the real notification
 * service and the real alert episodes, under the production bell policy (GATE_ADMIN_BELL_POLICY on, so a row lands
 * only because it asks to ring). Proves the SQL side: a plan visit the call agent booked for a call that named a
 * one-time service gets ONE Schedule bell (with the right key, headline, link, subject and done-when) and a repeat
 * run adds nothing; correcting the service closes it; a cancelled visit closes it; a closed bell does not ring
 * again; a bell stays open while the reading cannot be read or the visit waits for a new time; and a voice sandbox
 * call, a follow-up child, a visit a person made, a call with no valid reading, a reading that heard a plan ask, a
 * completed visit, a visit older than 7 days and a visit that agrees with its call all raise nothing.
 *
 * The price problem the same way: a one-time visit with no price, for a call whose reading holds the price staff
 * stated for that service, gets ONE Schedule bell; setting the price closes it and it does not ring again; and once
 * the office corrects a plan visit's service and sets no price, the service bell closes and the price bell rings.
 *
 * The run reads every candidate visit in the database and writes bells for the ones it names. So each test runs
 * in ONE transaction that the reads and the notification writer share, and that rolls back: nothing this suite
 * reads or rings for another suite's rows stays. It refuses any database but a private QA one or CI's.
 */
// Read once, when feature-gates loads; put back after the suite so a later suite in the same worker sees its own env.
const ENV_BEFORE = { GATE_ADMIN_BELL_POLICY: process.env.GATE_ADMIN_BELL_POLICY };
process.env.GATE_ADMIN_BELL_POLICY = 'true';
const { randomUUID } = require('crypto');

// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
// Every module under test reads the pool this suite builds after its database check, never one built from the
// DATABASE_URL text.
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));

afterAll(() => {
  for (const [key, value] of Object.entries(ENV_BEFORE)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

maybeDescribe('call booking check (live Postgres)', () => {
  let db;
  let trx;
  let Check;
  const NOW = new Date('2026-11-21T22:00:00Z'); // 5:00 PM Eastern, Saturday
  const BOOKED_AT = '2026-11-21T21:33:00Z'; // 4:33 PM Eastern
  const tag = randomUUID().slice(0, 8);
  // Two catalog rows of this suite's own, so no seeded catalog name can change the result.
  const oneTime = { id: randomUUID(), name: `Check One-Time Pest ${tag}`, service_key: `check_one_time_${tag}`, billing_type: 'one_time' };
  const plan = { id: randomUUID(), name: `Check Monthly Pest ${tag}`, service_key: `check_monthly_${tag}`, billing_type: 'recurring' };

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    // This worktree's OWN QA database, never another checkout's: the managed runner sets both marks and names
    // the database after the worktree id (scripts/dev/context.js, scripts/qa/server.js). Or CI's database.
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const privateQa = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId) && target.pathname === `/waves_qa_${worktreeId}`;
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error("Use this worktree's private QA database or the isolated CI database");
    // The driver copies every query parameter of a connection string into its settings, so ?host= or ?port=
    // would name another server than the one checked above. A URL with a query is refused, and the pool gets
    // the parts this guard read, never the URL text.
    if (target.search) throw new Error('DATABASE_URL must not carry query parameters');
    db = require('knex')({
      client: 'pg',
      connection: {
        host: target.hostname,
        port: target.port ? Number(target.port) : undefined,
        user: decodeURIComponent(target.username) || undefined,
        password: decodeURIComponent(target.password) || undefined,
        database: target.pathname.slice(1),
      },
      pool: { min: 0, max: 2 },
    });
    Check = require('../services/call-booking-check');
  });
  beforeEach(async () => {
    trx = await db.transaction();
    mockConnection = trx;
    await trx('services').insert([oneTime, plan]);
  });
  afterEach(async () => { await trx.rollback(); });
  afterAll(async () => { if (db) await db.destroy(); });

  const rowsFor = (visitId) => trx('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [`${Check.OWN_PREFIX}service:${visitId}`]);

  // One synthetic caller, the call (its stored reading names `heard`), and the visit booked from it.
  async function booking({ row = plan, heard = oneTime.name, intent = 'active_infestation_treatment', status = 'confirmed', createdAt = BOOKED_AT, callOver = {}, visitOver = {} } = {}) {
    const customerId = randomUUID();
    const callId = randomUUID();
    const visitId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Synthetic', phone: `+1941${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` });
    await trx('call_log').insert({
      id: callId, direction: 'inbound', from_phone: '+19415550101', to_phone: '+19415550000', twilio_call_sid: `CA${randomUUID().replace(/-/g, '')}`,
      status: 'completed', duration_seconds: 240, customer_id: customerId, created_at: createdAt, updated_at: createdAt,
      v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ service_request: { specific_service_name: heard, service_intent: intent } }), ...callOver,
    });
    await trx('scheduled_services').insert({
      id: visitId, customer_id: customerId, scheduled_date: '2026-11-21', service_type: row.name, service_id: row.id, status,
      booking_source: 'phone_call', source_call_log_id: callId, source_action: 'ai_call_pipeline', created_at: createdAt, ...visitOver,
    });
    return { customerId, callId, visitId };
  }

  const run = (now = NOW) => Check.runCallBookingCheck({ now });

  const priceRowsFor = (visitId) => trx('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [`${Check.OWN_PREFIX}price:${visitId}`]);
  // The 2026-11-21 reading: the one-time service, and the one-time price staff stated and the caller accepted
  // ("One-time service is $250, but it varies"), with no strict total.
  const statedTerm = { amount_usd: 250, amount_max_usd: null, unit: 'one_time', accepted: true, stated_by: 'agent' };
  const pricedCall = (request = {}, top = {}) => ({
    ai_extraction_enriched: JSON.stringify({
      service_request: {
        specific_service_name: oneTime.name, service_intent: 'active_infestation_treatment', quoted_price_usd: null, price: statedTerm, prices: [statedTerm], ...request,
      },
      ...top,
    }),
  });

  test('a plan visit for a call that named a one-time service raises one Schedule bell, and a repeat run adds nothing', async () => {
    const b = await booking();
    const first = await run();
    expect(first.raised).toBeGreaterThanOrEqual(1);
    const rows = await rowsFor(b.visitId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.category).toBe('schedule');
    expect(row.title).toBe("Schedule — check the service on Pat Synthetic's visit");
    expect(row.body).toBe(`Booked as ${plan.name}; the call asked for ${oneTime.name}.`);
    expect(row.link).toBe(`/admin/dispatch?tab=schedule&date=2026-11-21&appointment=${b.visitId}`);
    expect(row.read_at).toBeNull();
    expect(row.done_at).toBeNull();
    expect(row.detail).toContain('Nothing was changed and the customer was not contacted.');
    expect(row.metadata).toMatchObject({
      area: 'Schedule', severity: 'needs-you', who: 'person', doneWhen: 'visit_service_one_time', subject: { type: 'visit', id: b.visitId },
      scheduledServiceId: b.visitId, customerId: b.customerId, callLogId: b.callId, problem: 'service',
    });

    const second = await run();
    expect(second.raised).toBe(0);
    expect(await rowsFor(b.visitId)).toHaveLength(1);
  });

  test('correcting the service closes the bell, and it does not ring again when the problem comes back', async () => {
    const b = await booking();
    await run();
    await trx('scheduled_services').where({ id: b.visitId }).update({ service_id: oneTime.id, service_type: oneTime.name });
    const next = await run(new Date('2026-11-21T22:15:00Z'));
    expect(next.closed).toBeGreaterThanOrEqual(1);
    const [row] = await rowsFor(b.visitId);
    expect(row.done_at).not.toBeNull();
    expect(row.resolution).toBe('The visit and the call now agree on the service');
    expect(row.metadata).toMatchObject({ autoCleared: true, autoClearedReason: 'service_agrees' });

    await trx('scheduled_services').where({ id: b.visitId }).update({ service_id: plan.id, service_type: plan.name });
    await run(new Date('2026-11-21T22:30:00Z'));
    expect(await rowsFor(b.visitId)).toHaveLength(1);
  });

  test('a bell stays open while the reading cannot be read and while the visit waits for a new time; a cancelled visit closes it', async () => {
    const b = await booking();
    await run();
    // The call is being processed again: its reading is not valid for now.
    await trx('call_log').where({ id: b.callId }).update({ v2_extraction_status: 'schema_failed' });
    // A reschedule request parks the same visit row until the office books it again.
    await trx('scheduled_services').where({ id: b.visitId }).update({ status: 'rescheduled' });
    await run(new Date('2026-11-21T22:15:00Z'));
    expect((await rowsFor(b.visitId))[0].done_at).toBeNull();

    await trx('scheduled_services').where({ id: b.visitId }).update({ status: 'cancelled' });
    await run(new Date('2026-11-21T22:30:00Z'));
    const [row] = await rowsFor(b.visitId);
    expect(row.done_at).not.toBeNull();
    expect(row.resolution).toBe('The visit is done or cancelled');
  });

  test('a one-time visit with no price, for a call that holds the price staff stated, raises one price bell, and a repeat run adds nothing', async () => {
    const b = await booking({ row: oneTime, callOver: pricedCall() });
    const first = await run();
    expect(first.raised).toBeGreaterThanOrEqual(1);
    const rows = await priceRowsFor(b.visitId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.category).toBe('schedule');
    expect(row.title).toBe("Schedule — set the price on Pat Synthetic's visit");
    expect(row.body).toBe('Staff said $250 on the call, not confirmed as final; the visit has no price.');
    expect(row.link).toBe(`/admin/dispatch?tab=schedule&date=2026-11-21&appointment=${b.visitId}`);
    expect(row.done_at).toBeNull();
    expect(row.detail).toContain('Set the visit\'s price before it is billed. Nothing was changed and the customer was not contacted.');
    expect(row.metadata).toMatchObject({
      area: 'Schedule', severity: 'needs-you', who: 'person', doneWhen: 'visit_priced', subject: { type: 'visit', id: b.visitId },
      scheduledServiceId: b.visitId, customerId: b.customerId, callLogId: b.callId, problem: 'price',
    });
    // The visit is the service the call named: no service bell.
    expect(await rowsFor(b.visitId)).toHaveLength(0);
    // The check changed nothing on the visit.
    expect((await trx('scheduled_services').where({ id: b.visitId }).first()).estimated_price).toBeNull();

    const second = await run();
    expect(second.raised).toBe(0);
    expect(await priceRowsFor(b.visitId)).toHaveLength(1);
  });

  test('setting the price closes the price bell, and it does not ring again when the price is taken off', async () => {
    const b = await booking({ row: oneTime, callOver: pricedCall() });
    await run();
    await trx('scheduled_services').where({ id: b.visitId }).update({ estimated_price: 275 });
    const next = await run(new Date('2026-11-21T22:15:00Z'));
    expect(next.closed).toBeGreaterThanOrEqual(1);
    const [row] = await priceRowsFor(b.visitId);
    expect(row.done_at).not.toBeNull();
    expect(row.resolution).toBe('The visit has a price now');
    expect(row.metadata).toMatchObject({ autoCleared: true, autoClearedReason: 'price_set' });

    await trx('scheduled_services').where({ id: b.visitId }).update({ estimated_price: null });
    await run(new Date('2026-11-21T22:30:00Z'));
    expect(await priceRowsFor(b.visitId)).toHaveLength(1);
  });

  test('a price bell stays open while the reading cannot be read; a visit changed to a plan closes it', async () => {
    const b = await booking({ row: oneTime, callOver: pricedCall() });
    await run();
    await trx('call_log').where({ id: b.callId }).update({ v2_extraction_status: 'schema_failed' });
    await run(new Date('2026-11-21T22:15:00Z'));
    expect((await priceRowsFor(b.visitId))[0].done_at).toBeNull();

    await trx('scheduled_services').where({ id: b.visitId }).update({ service_id: plan.id, service_type: plan.name });
    await run(new Date('2026-11-21T22:30:00Z'));
    const [row] = await priceRowsFor(b.visitId);
    expect(row.done_at).not.toBeNull();
    expect(row.resolution).toBe('The visit is no longer a one-time visit that needs a price');
  });

  test('the office corrects a plan visit\'s service and sets no price: the service bell closes and the price bell rings', async () => {
    const b = await booking({ callOver: pricedCall() });
    await run();
    expect(await rowsFor(b.visitId)).toHaveLength(1);
    expect(await priceRowsFor(b.visitId)).toHaveLength(0);

    await trx('scheduled_services').where({ id: b.visitId }).update({ service_id: oneTime.id, service_type: oneTime.name });
    await run(new Date('2026-11-21T22:15:00Z'));
    expect((await rowsFor(b.visitId))[0].done_at).not.toBeNull();
    const [price] = await priceRowsFor(b.visitId);
    expect(price.done_at).toBeNull();
    expect(price.metadata).toMatchObject({ problem: 'price' });
  });

  test.each([
    ['the visit has a price', { visitOver: { estimated_price: 250 } }, pricedCall()],
    ['the visit is a free callback', { visitOver: { is_callback: true } }, pricedCall()],
    ['the call holds no price', {}, {}],
    ['the call spoke of a second property', {}, pricedCall({}, { property: { additional_properties: [{ city: 'Venice' }] } })],
    ['the call named another service than the visit has', {}, pricedCall({ specific_service_name: 'Another One-Time Service' })],
    ['staff stated a range', {}, pricedCall({ price: { ...statedTerm, amount_max_usd: 300 }, prices: [{ ...statedTerm, amount_max_usd: 300 }] })],
  ])('no price bell when %s', async (_name, shape, callOver) => {
    const b = await booking({ row: oneTime, ...shape, callOver });
    await run();
    expect(await priceRowsFor(b.visitId)).toHaveLength(0);
    expect(await rowsFor(b.visitId)).toHaveLength(0);
  });

  test.each(['ai_call_outbound_review', 'voice_agent'])('a booking that waits for the office (%s) rings the same way', async (sourceAction) => {
    const b = await booking({ status: 'pending', visitOver: { source_action: sourceAction } });
    await run();
    expect(await rowsFor(b.visitId)).toHaveLength(1);
  });

  test.each([
    ['the call was a voice sandbox call', { callOver: { source: 'voice_relay_sandbox' } }],
    ['the call has no valid reading', { callOver: { v2_extraction_status: 'schema_failed' } }],
    ['the reading says the caller asked about a plan', { intent: 'recurring_membership_inquiry' }],
    ['the reading records the caller\'s choice of a plan\'s billing', { callOver: { ai_extraction_enriched: JSON.stringify({ service_request: { specific_service_name: oneTime.name, service_intent: 'active_infestation_treatment', billing_choice: 'per_application' } }) } }],
    ['a person made the visit from the call', { visitOver: { source_action: 'admin' } }],
    ['the visit is the follow-up of a call booking', { visitOver: { source_action: 'ai_call_pipeline_followup' } }],
    ['the visit is already done', { status: 'completed' }],
    ['the visit was booked more than 7 days ago', { createdAt: '2026-11-13T21:00:00Z' }],
    ['the call named the plan the visit has', { heard: plan.name }],
    ['the visit is the one-time service the call named', { row: oneTime }],
  ])('no bell when %s', async (_name, shape) => {
    const b = await booking(shape);
    await run();
    expect(await rowsFor(b.visitId)).toHaveLength(0);
  });
});

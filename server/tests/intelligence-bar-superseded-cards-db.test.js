/** Real isolated Postgres tests: a newer card for the same intent cancels the
 * older card, whatever chat window or platform path it came from, and a Confirm
 * on a superseded card is refused. No model, send or provider is called; every
 * id is synthetic. */
const crypto = require('crypto');
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const databaseUrl = process.env.IB_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
jest.setTimeout(60000);

suite('IB superseded confirmation cards in isolated Postgres', () => {
  let db, Tasks, Pending;
  const actorId = crypto.randomUUID();
  const otherActorId = crypto.randomUUID();
  const customerId = crypto.randomUUID();
  const otherCustomerId = crypto.randomUUID();
  const serviceId = crypto.randomUUID();
  let leadId, otherLeadId; // fresh per test: cards of one intent from earlier tests would count as siblings
  beforeEach(() => { leadId = crypto.randomUUID(); otherLeadId = crypto.randomUUID(); });
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const booking = (extra = {}) => ({ customer_id: customerId, service_type: 'Synthetic Pest Service', scheduled_date: '2030-01-15', time_window: '9:00 AM', price: 149, ...extra });
  const at = offsetMs => new Date(Date.now() + offsetMs);

  // With a task (GATE_IB_PLATFORM on) or without one (off, the default).
  // Each call is a new request; `startedAt` is that request's start time.
  async function propose(toolName, params, { actor = actorId, task, noTask = false, startedAt = new Date() } = {}) {
    if (noTask) return Pending.createPendingAction({ toolName, requestedBy: actor, params, summary: 'Synthetic proposal only', requestStartedAt: startedAt });
    const t = task || (await Tasks.begin({ actorId: actor, sessionId: crypto.randomUUID(), requestKey: crypto.randomUUID(), request: { prompt: 'Synthetic request' }, pageContext: {} })).task;
    return Pending.createPendingAction({
      toolName, requestedBy: actor, taskId: t.id, runnerToken: t.runner_token, stepKey: crypto.randomUUID().slice(0, 32),
      summary: 'Synthetic proposal only', params, requestStartedAt: startedAt,
    });
  }
  const status = id => db('ib_pending_actions').where({ id }).first('status').then(r => r && r.status);
  const claim = row => Pending.claimForConfirm(row.id, row.requested_by, { contractHash: row.contract_hash });
  const bookingLock = (actor = actorId, params = booking()) => Pending.intentLock(actor, 'create_appointment', Pending.intentKey('create_appointment', params));

  beforeAll(async () => {
    const parsed = new URL(databaseUrl);
    const ciDatabase = process.env.CI === 'true' && parsed.hostname === 'localhost' && parsed.pathname === '/waves_test';
    if (!ciDatabase && !/^\/waves_ib_(platform|workflow)_[a-z0-9_]+$/.test(parsed.pathname)) throw new Error('An isolated IB development database is required');
    process.env.DATABASE_URL = databaseUrl;
    db = require('../models/db');
    if (!(await db.schema.hasTable('ib_tasks'))) throw new Error('Apply the task migration to the isolated database first');
    Tasks = require('../services/intelligence-bar/tasks');
    Pending = require('../services/intelligence-bar/pending-actions');
  }, 30000);
  afterAll(async () => {
    if (db) {
      await db('ib_pending_actions').whereIn('requested_by', [actorId, otherActorId]).del();
      await db('ib_tasks').whereIn('actor_id', [actorId, otherActorId]).del();
      await db.destroy();
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  test.each([['with a task (platform on)', false], ['with no task (platform off)', true]])('a revised booking %s cancels the older card; the newer card confirms', async (_label, noTask) => {
    const nine = await propose('create_appointment', booking({ scheduled_date: noTask ? '2030-01-16' : '2030-01-17' }), { noTask, startedAt: at(-2000) });
    const ten = await propose('create_appointment', booking({ scheduled_date: noTask ? '2030-01-16' : '2030-01-17', time_window: '10:00 AM' }), { noTask, startedAt: at(-1000) });
    expect(await status(nine.id)).toBe('cancelled');
    expect(await status(ten.id)).toBe('pending');
    expect(await claim(nine)).toEqual({ error: 'cancelled' });
    expect((await claim(ten)).action.params.time_window).toBe('10:00 AM');
  });

  test('the same intent from another chat window or another path still replaces the older card', async () => {
    const viaTask = await propose('create_appointment', booking({ scheduled_date: '2030-02-01' }), { startedAt: at(-2000) });
    const viaNoTask = await propose('create_appointment', booking({ scheduled_date: '2030-02-01', time_window: '11:00 AM' }), { noTask: true, startedAt: at(-1000) });
    expect(await status(viaTask.id)).toBe('cancelled');
    expect(await status(viaNoTask.id)).toBe('pending');
  });

  test('two accepted names for one catalog service share an intent; two catalog ids do not', async () => {
    const day = '2030-02-02';
    const a = await propose('create_appointment', booking({ scheduled_date: day, service_type: 'Pest Control', _booking_service_id: serviceId }), { noTask: true, startedAt: at(-3000) });
    const b = await propose('create_appointment', booking({ scheduled_date: day, service_type: 'Quarterly Pest Control Service', _booking_service_id: serviceId.toUpperCase(), time_window: '10:00 AM' }), { noTask: true, startedAt: at(-2000) });
    expect(await status(a.id)).toBe('cancelled');
    const c = await propose('create_appointment', booking({ scheduled_date: day, service_type: 'Pest Control', _booking_service_id: crypto.randomUUID() }), { noTask: true, startedAt: at(-1000) });
    expect(await status(b.id)).toBe('pending');
    expect(await status(c.id)).toBe('pending');
  });

  test('a newer address card replaces an older one; a name card on the same lead stays', async () => {
    const change = (from, to) => ({ from, to });
    const addr = (street) => ({ address: change(null, street), city: change(null, 'Sarasota'), zip: change(null, '34201') });
    const older = await propose('update_lead_contact', { lead_id: leadId, address: '21 Palm Ave', city: 'Sarasota', zip: '34201', _approved_changes: addr('21 Palm Ave') }, { noTask: true, startedAt: at(-3000) });
    const name = await propose('update_lead_contact', { lead_id: leadId, last_name: 'Smith', _approved_changes: { last_name: change(null, 'Smith') } }, { noTask: true, startedAt: at(-2000) });
    expect(await status(older.id)).toBe('pending');
    const fix = await propose('update_lead_contact', { lead_id: leadId, address: '12 Palm Ave', city: 'Sarasota', zip: '34201', _approved_changes: addr('12 Palm Ave') }, { noTask: true, startedAt: at(-1000) });
    expect(await status(older.id)).toBe('cancelled');
    expect(await status(name.id)).toBe('pending');
    expect(await status(fix.id)).toBe('pending');
  });

  test('a lead edit is judged by the fields its card really changes, not the raw input', async () => {
    const change = (from, to) => ({ from, to });
    // The first card sends first_name (already Jay) and a new email; only the email is approved.
    const older = await propose('update_lead_contact', { lead_id: leadId, first_name: 'Jay', email: 'new@example.invalid', _approved_changes: { email: change('old@example.invalid', 'new@example.invalid') } }, { noTask: true, startedAt: at(-5000) });
    // A later card that approves a different field only does not replace it.
    const name = await propose('update_lead_contact', { lead_id: leadId, last_name: 'Smith', _approved_changes: { last_name: change(null, 'Smith') } }, { noTask: true, startedAt: at(-4000) });
    expect(await status(older.id)).toBe('pending');
    // A later email-only correction replaces it, although it omits first_name.
    const fix = await propose('update_lead_contact', { lead_id: leadId, email: 'fixed@example.invalid', _approved_changes: { email: change('old@example.invalid', 'fixed@example.invalid') } }, { noTask: true, startedAt: at(-3000) });
    expect(await status(older.id)).toBe('cancelled');
    expect(await claim(older)).toEqual({ error: 'cancelled' });
    expect(await status(name.id)).toBe('pending');
    expect(await status(fix.id)).toBe('pending');
    // The newer card's raw first_name does not count when it approves only the email.
    const jason = await propose('update_lead_contact', { lead_id: leadId, first_name: 'Jason', email: 'x@example.invalid', _approved_changes: { email: change('fixed@example.invalid', 'x@example.invalid') } }, { noTask: true, startedAt: at(-2000) });
    const firstOnly = await propose('update_lead_contact', { lead_id: leadId, first_name: 'Ann', _approved_changes: { first_name: change('Jay', 'Ann') } }, { noTask: true, startedAt: at(-1000) });
    expect(await status(jason.id)).toBe('pending'); // first_name was not in its approved set, so the first_name card covers nothing of it
    expect(await status(firstOnly.id)).toBe('pending');
    expect(await status(fix.id)).toBe('cancelled'); // replaced by the later email card
  });

  test('a lead card that overlaps the newer one on any field is cancelled whole; disjoint fields coexist', async () => {
    const change = (from, to) => ({ from, to });
    // Older compound card: a real first_name change and a WRONG email.
    const older = await propose('update_lead_contact', { lead_id: leadId, first_name: 'Jay', email: 'wrong@example.invalid', _approved_changes: { first_name: change(null, 'Jay'), email: change('old@example.invalid', 'wrong@example.invalid') } }, { noTask: true, startedAt: at(-5000) });
    // Disjoint card (phone only) coexists with it.
    const phone = await propose('update_lead_contact', { lead_id: leadId, phone: '+15550100000', _approved_changes: { phone: change(null, '+15550100000') } }, { noTask: true, startedAt: at(-4000) });
    expect(await status(older.id)).toBe('pending');
    // The email correction overlaps only on email; the older compound card is cancelled whole.
    const fix = await propose('update_lead_contact', { lead_id: leadId, email: 'right@example.invalid', _approved_changes: { email: change('old@example.invalid', 'right@example.invalid') } }, { noTask: true, startedAt: at(-3000) });
    expect(await status(older.id)).toBe('cancelled');
    expect(await claim(older)).toEqual({ error: 'cancelled' });
    expect(await status(phone.id)).toBe('pending');
    const confirmed = await claim(fix);
    expect(confirmed.action.params._approved_changes.email.to).toBe('right@example.invalid');
    // The same overlap rule applies to rows with no approved set (raw fields).
    const rawOlder = await propose('update_lead_contact', { lead_id: otherLeadId, first_name: 'Raw', email: 'wrong@example.invalid' }, { noTask: true, startedAt: at(-2000) });
    await propose('update_lead_contact', { lead_id: otherLeadId, email: 'right@example.invalid' }, { noTask: true, startedAt: at(-1000) });
    expect(await status(rawOlder.id)).toBe('cancelled');
  });

  test('a booking request started long ago and resumed after a newer card was confirmed is stored cancelled', async () => {
    const day = '2030-04-12';
    const minutesAgo = m => new Date(Date.now() - m * 60 * 1000);
    // The newer request started 20 minutes ago; its card was created then and confirmed.
    const newer = await propose('create_appointment', booking({ scheduled_date: day, time_window: '10:00 AM' }), { noTask: true, startedAt: minutesAgo(20) });
    await db('ib_pending_actions').where({ id: newer.id }).update({ created_at: minutesAgo(20) });
    await claim(newer);
    // The interrupted request started 45 minutes ago (long past one card lifetime) and is resumed now.
    const late = await propose('create_appointment', booking({ scheduled_date: day }), { noTask: true, startedAt: minutesAgo(45) });
    expect(late.superseded_by_newer_request).toBe(true);
    expect(await status(late.id)).toBe('cancelled');
    expect(await status(newer.id)).toBe('confirmed');
    // The same holds when the newer card is pending and is the only evidence.
    const day2 = '2030-04-13';
    const pendingNewer = await propose('create_appointment', booking({ scheduled_date: day2, time_window: '10:00 AM' }), { noTask: true, startedAt: minutesAgo(20) });
    await db('ib_pending_actions').where({ id: pendingNewer.id }).update({ created_at: minutesAgo(20) });
    const late2 = await propose('create_appointment', booking({ scheduled_date: day2 }), { noTask: true, startedAt: minutesAgo(45) });
    expect(late2.superseded_by_newer_request).toBe(true);
    expect(await status(pendingNewer.id)).toBe('pending');
  });

  test('an unrelated same-intent card from an older request hours ago does not cancel a fresh request', async () => {
    const day = '2030-04-14';
    const hoursAgo = h => new Date(Date.now() - h * 3600 * 1000);
    const old = await propose('create_appointment', booking({ scheduled_date: day }), { noTask: true, startedAt: hoursAgo(3) });
    await db('ib_pending_actions').where({ id: old.id }).update({ created_at: hoursAgo(3), expires_at: hoursAgo(2.8) });
    const fresh = await propose('create_appointment', booking({ scheduled_date: day, time_window: '10:00 AM' }), { noTask: true, startedAt: new Date() });
    expect(fresh.superseded_by_newer_request).toBeUndefined();
    expect(fresh.earlier_card_confirmed).toBeUndefined();
    expect(await status(fresh.id)).toBe('pending');
    expect(await status(old.id)).toBe('pending'); // left alone: outside the older window, already expired
    // An hours-old CONFIRMED card from an older request does not block a new booking either.
    const day2 = '2030-04-15';
    const done = await propose('create_appointment', booking({ scheduled_date: day2 }), { noTask: true, startedAt: hoursAgo(3) });
    await claim(done);
    await db('ib_pending_actions').where({ id: done.id }).update({ created_at: hoursAgo(3) });
    const again = await propose('create_appointment', booking({ scheduled_date: day2 }), { noTask: true, startedAt: new Date() });
    expect(again.earlier_card_confirmed).toBeUndefined();
    expect(await status(again.id)).toBe('pending');
  });

  test('a lead card with no approved set uses the raw fields; one with an empty set is left alone', async () => {
    const raw = await propose('update_lead_contact', { lead_id: leadId, first_name: 'Raw' }, { noTask: true, startedAt: at(-5000) });
    const empty = await propose('update_lead_contact', { lead_id: leadId, last_name: 'Empty', _approved_changes: {} }, { noTask: true, startedAt: at(-4000) });
    await propose('update_lead_contact', { lead_id: leadId, first_name: 'Newer', last_name: 'Newer', _approved_changes: { first_name: { from: 'Raw', to: 'Newer' }, last_name: { from: null, to: 'Newer' } } }, { noTask: true, startedAt: at(-3000) });
    expect(await status(raw.id)).toBe('cancelled');
    expect(await status(empty.id)).toBe('pending'); // changes nothing, never "replaced"
  });

  test('a lead edit that rewrites the same field cancels the older edit; other fields or leads stay', async () => {
    const jay = await propose('update_lead_contact', { lead_id: leadId, first_name: 'Jay' }, { noTask: true, startedAt: at(-5000) });
    const email = await propose('update_lead_contact', { lead_id: leadId, email: 'synthetic@example.invalid' }, { noTask: true, startedAt: at(-4000) });
    const otherLead = await propose('update_lead_contact', { lead_id: otherLeadId, first_name: 'Zed' }, { noTask: true, startedAt: at(-3000) });
    expect(await status(jay.id)).toBe('pending');
    expect(await status(email.id)).toBe('pending');
    const jason = await propose('update_lead_contact', { lead_id: leadId.toUpperCase(), first_name: 'Jason' }, { noTask: true, startedAt: at(-2000) });
    expect(await status(jay.id)).toBe('cancelled');
    expect(await status(email.id)).toBe('pending');
    expect(await status(otherLead.id)).toBe('pending');
    expect(await status(jason.id)).toBe('pending');
  });

  test('a different customer, service, day, tool, actor or an older-than-TTL card is left alone', async () => {
    const day = '2030-03-01';
    const base = await propose('create_appointment', booking({ scheduled_date: day }), { noTask: true, startedAt: at(-9000) });
    const others = [
      await propose('create_appointment', booking({ scheduled_date: day, customer_id: otherCustomerId }), { noTask: true }),
      await propose('create_appointment', booking({ scheduled_date: day, service_type: 'Synthetic Lawn Service' }), { noTask: true }),
      await propose('create_appointment', booking({ scheduled_date: '2030-03-02' }), { noTask: true }),
      await propose('update_lead_contact', { lead_id: leadId, last_name: 'Synthetic' }, { noTask: true }),
      await propose('create_appointment', booking({ scheduled_date: day, time_window: '1:00 PM' }), { noTask: true, actor: otherActorId }),
    ];
    expect(await status(base.id)).toBe('pending');
    for (const row of others) expect(await status(row.id)).toBe('pending');
    // A tool outside the supersede list never cancels an earlier card for the same customer.
    const sms = { phone: '+15550104321', customer_id: customerId };
    const first = await propose('send_sms', { ...sms, message: 'Synthetic one; never sent' });
    await propose('send_sms', { ...sms, message: 'Synthetic two; never sent' });
    expect(await status(first.id)).toBe('pending');
    // A card from more than one card lifetime ago is not the same proposal.
    const old = await propose('create_appointment', booking({ scheduled_date: '2030-03-03' }), { noTask: true });
    await db('ib_pending_actions').where({ id: old.id }).update({ created_at: new Date(Date.now() - 11 * 60 * 1000) });
    await propose('create_appointment', booking({ scheduled_date: '2030-03-03', time_window: '10:00 AM' }), { noTask: true });
    expect(await status(old.id)).toBe('pending');
  });

  test.each([['with a task', false], ['with no task', true]])('an older request that finishes late %s is stored cancelled and does not cancel the newer card', async (_l, noTask) => {
    const day = noTask ? '2030-04-01' : '2030-04-02';
    const newCard = await propose('create_appointment', booking({ scheduled_date: day, time_window: '10:00 AM' }), { noTask, startedAt: at(-1000) });
    const lateCard = await propose('create_appointment', booking({ scheduled_date: day }), { noTask, startedAt: at(-5000) }); // started earlier, stored later
    expect(lateCard.superseded_by_newer_request).toBe(true);
    expect(await status(lateCard.id)).toBe('cancelled');
    expect(await claim(lateCard)).toEqual({ error: 'cancelled' });
    expect(await status(newCard.id)).toBe('pending');
    expect((await claim(newCard)).action.params.time_window).toBe('10:00 AM');
  });

  test('a resumed older task keeps its original start, so its late card is stored cancelled', async () => {
    const day = '2030-04-05';
    // The older task starts first; a newer request then stores a same-intent card.
    const older = (await Tasks.begin({ actorId, sessionId: crypto.randomUUID(), requestKey: crypto.randomUUID(), request: { prompt: 'Synthetic request' }, pageContext: {} })).task;
    await new Promise(resolve => setTimeout(resolve, 15));
    const newer = await propose('create_appointment', booking({ scheduled_date: day, time_window: '10:00 AM' }), { noTask: true, startedAt: new Date() });
    // Resuming later: the start is the task's created_at (epoch ms), not the resume time.
    const resumedStart = Tasks.requestStartedAt(older);
    expect(resumedStart).toBe(new Date(older.created_at).getTime());
    expect(Tasks.requestStartedAt(undefined)).toBeGreaterThan(resumedStart);
    const late = await propose('create_appointment', booking({ scheduled_date: day }), { task: older, startedAt: new Date(resumedStart) });
    expect(late.superseded_by_newer_request).toBe(true);
    expect(await status(late.id)).toBe('cancelled');
    expect(await status(newer.id)).toBe('pending');
    expect((await claim(newer)).action.params.time_window).toBe('10:00 AM');
    // Contrast: with a fresh start at resume (the old behavior) the stale task would out-rank the newer card.
    const day2 = '2030-04-06';
    const task2 = (await Tasks.begin({ actorId, sessionId: crypto.randomUUID(), requestKey: crypto.randomUUID(), request: { prompt: 'Synthetic request' }, pageContext: {} })).task;
    const newer2 = await propose('create_appointment', booking({ scheduled_date: day2, time_window: '10:00 AM' }), { noTask: true, startedAt: new Date() });
    await propose('create_appointment', booking({ scheduled_date: day2 }), { task: task2, startedAt: new Date(Date.now() + 1000) });
    expect(await status(newer2.id)).toBe('cancelled');
  });

  test('a newer card that was cancelled or has expired still shows the older request is stale', async () => {
    const day = '2030-04-10';
    const cancelled = await propose('create_appointment', booking({ scheduled_date: day, time_window: '10:00 AM' }), { noTask: true, startedAt: at(-1000) });
    expect(await Pending.cancelPendingAction(cancelled.id, actorId)).toEqual({ cancelled: true });
    const late = await propose('create_appointment', booking({ scheduled_date: day }), { noTask: true, startedAt: at(-5000) });
    expect(late.superseded_by_newer_request).toBe(true);
    expect(await status(late.id)).toBe('cancelled');

    const day2 = '2030-04-11';
    const expired = await propose('create_appointment', booking({ scheduled_date: day2, time_window: '10:00 AM' }), { noTask: true, startedAt: at(-1000) });
    await db('ib_pending_actions').where({ id: expired.id }).update({ expires_at: new Date(Date.now() - 1000) });
    const late2 = await propose('create_appointment', booking({ scheduled_date: day2 }), { noTask: true, startedAt: at(-5000) });
    expect(late2.superseded_by_newer_request).toBe(true);
  });

  test('a Confirm is refused when a newer same-intent card exists, even a cancelled or expired one', async () => {
    const day = '2030-04-20';
    const older = await propose('create_appointment', booking({ scheduled_date: day }), { noTask: true, startedAt: at(-5000) });
    // Simulate the race window: the newer card is stored while the older one is still pending.
    const newerRow = async (extra) => db('ib_pending_actions').insert({
      tool_name: 'create_appointment', params: JSON.stringify({ ...booking({ scheduled_date: day, time_window: '10:00 AM' }), _ib_request_started_at: at(-1000).toISOString() }),
      params_hash: 'x'.repeat(64), requested_by: actorId, expires_at: at(600000), ...extra }).returning('id');
    const [{ id }] = await newerRow({ status: 'cancelled' });
    expect(await claim(older)).toEqual({ error: 'cancelled' });
    expect(await status(older.id)).toBe('cancelled');
    await db('ib_pending_actions').where({ id }).del();

    const older2 = await propose('create_appointment', booking({ scheduled_date: '2030-04-21' }), { noTask: true, startedAt: at(-5000) });
    await db('ib_pending_actions').insert({
      tool_name: 'create_appointment', params: JSON.stringify({ ...booking({ scheduled_date: '2030-04-21', time_window: '10:00 AM' }), _ib_request_started_at: at(-1000).toISOString() }),
      params_hash: 'x'.repeat(64), requested_by: actorId, status: 'pending', expires_at: at(-1000) });
    expect(await claim(older2)).toEqual({ error: 'cancelled' });
  });

  test('a replay of an already confirmed card still reports already_used', async () => {
    const card = await propose('create_appointment', booking({ scheduled_date: '2030-05-01' }), { noTask: true });
    expect((await claim(card)).action.id).toBe(card.id);
    expect(await claim(card)).toEqual({ error: 'already_used' });
  });

  test('after a booking card was confirmed, a new card for it is refused; a lead edit stays confirmable', async () => {
    const day = '2030-05-10';
    const first = await propose('create_appointment', booking({ scheduled_date: day }), { noTask: true, startedAt: at(-3000) });
    await claim(first); // no result yet: the booking may be running
    const again = await propose('create_appointment', booking({ scheduled_date: day, time_window: '10:00 AM' }), { noTask: true, startedAt: at(-1000) });
    expect(again.earlier_card_confirmed).toMatch(/already confirmed/);
    expect(await db('ib_pending_actions').where({ id: again.id }).first()).toBeUndefined();
    expect(await status(first.id)).toBe('confirmed');

    // A confirmed card whose run failed does not block the operator from trying again.
    const failed = await propose('create_appointment', booking({ scheduled_date: '2030-05-11' }), { noTask: true, startedAt: at(-3000) });
    await claim(failed);
    await Pending.recordResult(failed.id, { error: 'Synthetic refusal' });
    const retry = await propose('create_appointment', booking({ scheduled_date: '2030-05-11' }), { noTask: true, startedAt: at(-1000) });
    expect(retry.earlier_card_confirmed).toBeUndefined();
    expect(await status(retry.id)).toBe('pending');

    const edit = await propose('update_lead_contact', { lead_id: leadId, first_name: 'Ann' }, { noTask: true, startedAt: at(-3000) });
    await claim(edit);
    await Pending.recordResult(edit.id, { success: true });
    const next = await propose('update_lead_contact', { lead_id: leadId, first_name: 'Anna' }, { noTask: true, startedAt: at(-1000) });
    expect(await status(next.id)).toBe('pending');
    expect(await status(edit.id)).toBe('confirmed');
  });

  // Order 1: the Confirm wins the lock; order 2: the new proposal wins it.
  test('a Confirm and a new proposal racing in either order commit at most one booking', async () => {
    for (let round = 0; round < 10; round++) {
      const day = `2031-01-${String(round + 1).padStart(2, '0')}`;
      const older = await propose('create_appointment', booking({ scheduled_date: day }), { noTask: round % 2 === 0, startedAt: at(-5000) });
      const [confirm, proposal] = await Promise.all([
        claim(older),
        propose('create_appointment', booking({ scheduled_date: day, time_window: '10:00 AM' }), { noTask: round % 2 === 1, startedAt: at(-1000) }),
      ]);
      const oldCommitted = !!confirm.action;
      const newConfirmable = proposal.earlier_card_confirmed === undefined && (await status(proposal.id)) === 'pending';
      expect(oldCommitted && newConfirmable).toBe(false); // never both
      expect(oldCommitted || newConfirmable).toBe(true); // and one of them survives
      if (!oldCommitted) expect(confirm).toEqual({ error: 'cancelled' });
    }
  });

  test('the Confirm and the proposal both wait on the intent lock', async () => {
    const day = '2031-02-01';
    const older = await propose('create_appointment', booking({ scheduled_date: day }), { noTask: true, startedAt: at(-5000) });
    let release; const gate = new Promise(resolve => { release = resolve; });
    let locked; const lockTaken = new Promise(resolve => { locked = resolve; });
    const holder = db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [bookingLock(actorId, booking({ scheduled_date: day }))]);
      locked();
      await gate;
    });
    await lockTaken;
    const states = { claim: false, proposal: false };
    const claimed = claim(older).then(r => { states.claim = true; return r; });
    const proposed = propose('create_appointment', booking({ scheduled_date: day, time_window: '10:00 AM' }), { noTask: true, startedAt: at(-1000) }).then(r => { states.proposal = true; return r; });
    await new Promise(resolve => setTimeout(resolve, 500));
    const blocked = !states.claim && !states.proposal;
    release();
    await holder;
    const [confirm, proposal] = await Promise.all([claimed, proposed]);
    expect(blocked).toBe(true);
    expect(!!confirm.action && (await status(proposal.id)) === 'pending').toBe(false);
  });

  test('overlapping proposals for one intent leave exactly one confirmable card, the one that started last', async () => {
    for (let round = 0; round < 8; round++) {
      const day = `2031-03-${String(round + 1).padStart(2, '0')}`;
      const rows = await Promise.all([0, 1, 2].map(i => propose('create_appointment', booking({ scheduled_date: day, time_window: `${9 + i}:00 AM` }),
        { noTask: round % 2 === 0, startedAt: at(-3000 + i * 1000) })));
      const pending = (await db('ib_pending_actions').whereIn('id', rows.map(r => r.id)).where({ status: 'pending' }).select('id')).map(r => r.id);
      expect(pending).toEqual([rows[2].id]);
    }
  });

  test('one task that holds several cards for different intents keeps all of them confirmable', async () => {
    const { task } = await Tasks.begin({ actorId, sessionId: crypto.randomUUID(), requestKey: crypto.randomUUID(), request: { prompt: 'Synthetic request' }, pageContext: {} });
    const a = await propose('update_lead_contact', { lead_id: leadId, first_name: 'Alpha' }, { task });
    await db('ib_pending_actions').where({ id: a.id }).update({ status: 'confirmed', result: JSON.stringify({ success: true }) });
    const b = await propose('update_lead_contact', { lead_id: otherLeadId, first_name: 'Beta' }, { task });
    expect(await status(a.id)).toBe('confirmed');
    expect(await status(b.id)).toBe('pending');
    expect((await claim(b)).action.params.first_name).toBe('Beta');
  });

  test('a retry of the same step returns the stored card and cancels nothing', async () => {
    const older = await propose('update_lead_contact', { lead_id: otherLeadId, first_name: 'Keep' }, { noTask: true, startedAt: at(-5000) });
    const { task } = await Tasks.begin({ actorId, sessionId: crypto.randomUUID(), requestKey: crypto.randomUUID(), request: { prompt: 'Synthetic request' }, pageContext: {} });
    const stepKey = crypto.randomUUID().slice(0, 32);
    const call = () => Pending.createPendingAction({ toolName: 'update_lead_contact', requestedBy: actorId, taskId: task.id, runnerToken: task.runner_token, stepKey, params: { lead_id: leadId, first_name: 'Retry' }, requestStartedAt: new Date() });
    const one = await call();
    expect((await call()).id).toBe(one.id);
    expect(await status(older.id)).toBe('pending');
  });
});

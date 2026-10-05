/** Real isolated Postgres tests: a newer card for the same intent in the same
 * conversation cancels the older pending card, so the older one can no longer
 * be confirmed. No model, send or provider is called; every id is synthetic. */
const crypto = require('crypto');
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const databaseUrl = process.env.IB_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
jest.setTimeout(30000);

suite('IB superseded confirmation cards in isolated Postgres', () => {
  let db, Tasks, Pending;
  const actorId = crypto.randomUUID();
  const otherActorId = crypto.randomUUID();
  const customerId = crypto.randomUUID();
  const otherCustomerId = crypto.randomUUID();
  const leadId = crypto.randomUUID();
  const otherLeadId = crypto.randomUUID();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const booking = (extra = {}) => ({ customer_id: customerId, service_type: 'Synthetic Pest Service', scheduled_date: '2030-01-15', time_window: '9:00 AM', price: 149, ...extra });

  // Each call is a new request (a new task) in the given conversation.
  async function propose(sessionId, toolName, params, { actor = actorId, task } = {}) {
    const started = task ? { task } : await Tasks.begin({ actorId: actor, sessionId, requestKey: crypto.randomUUID(), request: { prompt: 'Synthetic request' }, pageContext: {} });
    const t = started.task;
    return Pending.createPendingAction({
      toolName, requestedBy: actor, taskId: t.id, runnerToken: t.runner_token, stepKey: crypto.randomUUID().slice(0, 32),
      summary: 'Synthetic proposal only', params,
    });
  }
  const status = id => db('ib_pending_actions').where({ id }).first('status').then(r => r.status);

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

  test('a revised booking in a later request cancels the older card; the newer card confirms', async () => {
    const session = crypto.randomUUID();
    const nine = await propose(session, 'create_appointment', booking());
    const ten = await propose(session, 'create_appointment', booking({ time_window: '10:00 AM' }));
    expect(await status(nine.id)).toBe('cancelled');
    expect(await status(ten.id)).toBe('pending');
    expect(await Pending.claimForConfirm(nine.id, actorId, { contractHash: nine.contract_hash })).toEqual({ error: 'cancelled' });
    const claimed = await Pending.claimForConfirm(ten.id, actorId, { contractHash: ten.contract_hash });
    expect(claimed.action.params.time_window).toBe('10:00 AM');
  });

  test('a lead edit that rewrites the same field cancels the older edit card', async () => {
    const session = crypto.randomUUID();
    const jay = await propose(session, 'update_lead_contact', { lead_id: leadId, first_name: 'Jay' });
    const jason = await propose(session, 'update_lead_contact', { lead_id: leadId.toUpperCase(), first_name: 'Jason' });
    expect(await status(jay.id)).toBe('cancelled');
    expect(await status(jason.id)).toBe('pending');
  });

  test('a different target, service, day, tool, actor or conversation leaves the older card pending', async () => {
    const session = crypto.randomUUID();
    const base = await propose(session, 'create_appointment', booking());
    const others = [
      await propose(session, 'create_appointment', booking({ customer_id: otherCustomerId })),
      await propose(session, 'create_appointment', booking({ service_type: 'Synthetic Lawn Service' })),
      await propose(session, 'create_appointment', booking({ scheduled_date: '2030-02-20' })),
      await propose(session, 'update_lead_contact', { lead_id: leadId, first_name: 'Pat' }),
      await propose(crypto.randomUUID(), 'create_appointment', booking({ time_window: '11:00 AM' })),
      await propose(session, 'create_appointment', booking({ time_window: '1:00 PM' }), { actor: otherActorId }),
    ];
    expect(await status(base.id)).toBe('pending');
    for (const row of others) expect(await status(row.id)).toBe('pending');
    // A tool outside the supersede list never cancels an earlier card for the same customer.
    const first = await propose(session, 'send_sms', { phone: '+15550104321', message: 'Synthetic one; never sent', customer_id: customerId });
    await propose(session, 'send_sms', { phone: '+15550104321', message: 'Synthetic two; never sent', customer_id: customerId });
    expect(await status(first.id)).toBe('pending');
  });

  test('a lead edit of a different field, or another lead, does not cancel the earlier edit', async () => {
    const session = crypto.randomUUID();
    const name = await propose(session, 'update_lead_contact', { lead_id: leadId, first_name: 'Jay' });
    const email = await propose(session, 'update_lead_contact', { lead_id: leadId, email: 'synthetic@example.invalid' });
    const otherLead = await propose(session, 'update_lead_contact', { lead_id: otherLeadId, first_name: 'Zed' });
    expect(await status(name.id)).toBe('pending');
    expect(await status(email.id)).toBe('pending');
    expect(await status(otherLead.id)).toBe('pending');
    // Writing both fields now covers the name edit and the email edit.
    await propose(session, 'update_lead_contact', { lead_id: leadId, first_name: 'Jason', email: 'synthetic2@example.invalid' });
    expect(await status(name.id)).toBe('cancelled');
    expect(await status(email.id)).toBe('cancelled');
    expect(await status(otherLead.id)).toBe('pending');
  });

  test('a card already confirmed is never touched, and a retry of the same step cancels nothing', async () => {
    const session = crypto.randomUUID();
    const first = await propose(session, 'create_appointment', booking());
    await Pending.claimForConfirm(first.id, actorId, { contractHash: first.contract_hash });
    const revised = await propose(session, 'create_appointment', booking({ time_window: '10:00 AM' }));
    expect(await status(first.id)).toBe('confirmed');
    expect(await status(revised.id)).toBe('pending');

    // The same step proposed again inside its own task returns the stored card
    // and does not cancel the earlier request's still-pending card.
    const s2 = crypto.randomUUID();
    const older = await propose(s2, 'create_appointment', booking({ scheduled_date: '2030-03-01' }));
    const { task } = await Tasks.begin({ actorId, sessionId: s2, requestKey: crypto.randomUUID(), request: { prompt: 'Synthetic request' }, pageContext: {} });
    const stepKey = crypto.randomUUID().slice(0, 32);
    const call = () => Pending.createPendingAction({ toolName: 'update_lead_contact', requestedBy: actorId, taskId: task.id, runnerToken: task.runner_token, stepKey, params: { lead_id: leadId, first_name: 'Retry' } });
    const one = await call();
    expect((await call()).id).toBe(one.id);
    expect(await status(older.id)).toBe('pending');
  });

  test('one task that holds several cards for different targets keeps all of them confirmable', async () => {
    const session = crypto.randomUUID();
    const { task } = await Tasks.begin({ actorId, sessionId: session, requestKey: crypto.randomUUID(), request: { prompt: 'Synthetic request' }, pageContext: {} });
    const a = await propose(session, 'update_lead_contact', { lead_id: leadId, first_name: 'Alpha' }, { task });
    await db('ib_pending_actions').where({ id: a.id }).update({ status: 'confirmed', result: JSON.stringify({ success: true }) });
    const b = await propose(session, 'update_lead_contact', { lead_id: otherLeadId, first_name: 'Beta' }, { task });
    expect(await status(a.id)).toBe('confirmed');
    expect(await status(b.id)).toBe('pending');
    const claimed = await Pending.claimForConfirm(b.id, actorId, { contractHash: b.contract_hash });
    expect(claimed.action.params.first_name).toBe('Beta');
  });

  // Requests are ordered by when their task was created, not by who commits first.
  const beginTask = sessionId => Tasks.begin({ actorId, sessionId, requestKey: crypto.randomUUID(), request: { prompt: 'Synthetic request' }, pageContext: {} }).then(r => r.task);
  const confirmable = async (rows) => (await db('ib_pending_actions').whereIn('id', rows.map(r => r.id)).where({ status: 'pending' }).select('id')).map(r => r.id);

  test('overlapping proposals for one intent leave exactly one confirmable card, the newest request', async () => {
    for (let round = 0; round < 8; round++) {
      const session = crypto.randomUUID();
      const tasks = [await beginTask(session), await beginTask(session), await beginTask(session)];
      const rows = await Promise.all(tasks.map((task, i) => propose(session, 'create_appointment', booking({ time_window: `${9 + i}:00 AM` }), { task })));
      expect(await confirmable(rows)).toEqual([rows[2].id]);
    }
  });

  test('a proposal waits for the intent lock, then sees the card the lock holder committed', async () => {
    const session = crypto.randomUUID();
    const older = await beginTask(session), newer = await beginTask(session);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let locked;
    const lockTaken = new Promise(resolve => { locked = resolve; });
    // A second connection holds the intent lock and, while holding it, stores the NEWER request's card.
    const holder = db.transaction(async trx => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`ib-supersede:${actorId}:${session}:create_appointment:${[customerId, 'synthetic pest service', '2030-01-15'].join('|')}`]);
      locked();
      await gate;
      return trx('ib_pending_actions').insert({ tool_name: 'create_appointment', params: JSON.stringify(booking({ time_window: '10:00 AM' })), params_hash: 'x'.repeat(64),
        requested_by: actorId, status: 'pending', expires_at: new Date(Date.now() + 600000), task_id: newer.id, step_key: 'gate-step' }).returning('id');
    });
    await lockTaken;
    let settled = false;
    const late = propose(session, 'create_appointment', booking(), { task: older }).then(row => { settled = true; return row; });
    await new Promise(resolve => setTimeout(resolve, 400));
    const blocked = !settled; // blocked on the advisory lock, not racing past it
    release(); // always release, so a failed run cannot leave the connection held
    expect(blocked).toBe(true);
    const [[held]] = [await holder];
    const lateRow = await late;
    expect(lateRow.superseded_by_newer_request).toBe(true);
    expect(await status(lateRow.id)).toBe('cancelled');
    expect(await status(held.id)).toBe('pending');
  });

  test('an older request that finishes late is stored cancelled and does not cancel the newer card', async () => {
    const session = crypto.randomUUID();
    const older = await beginTask(session), newer = await beginTask(session);
    const newCard = await propose(session, 'create_appointment', booking({ time_window: '10:00 AM' }), { task: newer });
    const lateCard = await propose(session, 'create_appointment', booking(), { task: older });
    expect(lateCard.superseded_by_newer_request).toBe(true);
    expect(await status(lateCard.id)).toBe('cancelled');
    expect(await Pending.claimForConfirm(lateCard.id, actorId, { contractHash: lateCard.contract_hash })).toEqual({ error: 'cancelled' });
    expect(await status(newCard.id)).toBe('pending');
    expect((await Pending.claimForConfirm(newCard.id, actorId, { contractHash: newCard.contract_hash })).action.params.time_window).toBe('10:00 AM');
  });

  test('a late older request is also stale when the newer card was already confirmed, but a different target is not', async () => {
    const session = crypto.randomUUID();
    const older = await beginTask(session), olderToo = await beginTask(session), newer = await beginTask(session);
    const newCard = await propose(session, 'create_appointment', booking({ time_window: '10:00 AM' }), { task: newer });
    await Pending.claimForConfirm(newCard.id, actorId, { contractHash: newCard.contract_hash });
    const lateCard = await propose(session, 'create_appointment', booking(), { task: older });
    expect(await status(lateCard.id)).toBe('cancelled');
    expect(await status(newCard.id)).toBe('confirmed');
    const other = await propose(session, 'create_appointment', booking({ customer_id: otherCustomerId }), { task: olderToo });
    expect(other.superseded_by_newer_request).toBeUndefined();
    expect(await status(other.id)).toBe('pending');
  });
});

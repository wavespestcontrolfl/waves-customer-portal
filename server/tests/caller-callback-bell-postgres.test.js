/**
 * Caller callback late bell (owner 2026-11-04, option A) against live Postgres, through the real reads, the real
 * notification service and the real alert episodes, under the production bell policy (GATE_ADMIN_BELL_POLICY on, so a
 * row lands only because it asks to ring). Proves the SQL side: a new-lead caller's own "I will call back" promise
 * gets ONE Leads bell once it is late (with the right key, headline, link, subject, done-when and Call button) and a
 * repeat run adds nothing; a call from the caller after the call ended closes it ("They called back"); a call or a
 * text from the caller, a booked visit, a lost lead, a call that was not a new lead, a callback not yet due, and one
 * due more than 24 hours ago all raise nothing; the gate off reads nothing. It reads every candidate promise in the
 * database, so it asserts on its own rows only.
 *
 * GATE_CALLER_CALLBACK_PROMISE_CLOSE (promiseCloseEnabled): a caller who called back, texted, or whom a person followed
 * up (a booked visit) gets the PROMISE row closed as kept (status fulfilled, fulfillment closed_by
 * caller_callback_bell naming the inbound call or text), in the close pass (bell raised) and the raise pass (due or
 * not, bell or not); a lost lead writes nothing; a row a person touched or edited between the read and the write is
 * not overwritten; refreshFulfillment on the call leaves it closed; a Waves promise on the same call is untouched;
 * gate off leaves every row open as before. It refuses any database but a private QA one or CI's.
 */
// Read once, when feature-gates loads; put back after the suite so a later suite in the same worker sees its own env.
const ENV_BEFORE = { GATE_ADMIN_BELL_POLICY: process.env.GATE_ADMIN_BELL_POLICY, GATE_CALL_COMMITMENTS: process.env.GATE_CALL_COMMITMENTS };
process.env.GATE_ADMIN_BELL_POLICY = 'true';
process.env.GATE_CALL_COMMITMENTS = 'true';
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

afterAll(async () => {
  for (const [key, value] of Object.entries(ENV_BEFORE)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (!SKIP) await require('../models/db').destroy();
});

maybeDescribe('caller callback late bell (live Postgres)', () => {
  let db;
  let Bell;
  const NOW = new Date('2026-11-04T18:00:00Z'); // 1:00 PM Eastern, Wednesday
  const CALL_AT = '2026-11-04T15:00:00Z'; // 10:00 AM Eastern; with 120 s of talk time it ends 10:02, due 12:02 PM
  const ids = { customers: [], leads: [], calls: [], promises: [], visits: [], texts: [], estimates: [] };
  let seq = 0;

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    Bell = require('../services/caller-callback-bell');
  });

  const bellKeys = () => ids.promises.map((id) => `caller-callback-late:${id}`);
  const rowsFor = (promiseId) => db('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [`caller-callback-late:${promiseId}`]);

  afterAll(async () => {
    if (!db) return;
    await db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ANY(?::text[])", [bellKeys()]).del();
    await db('estimates').whereIn('id', ids.estimates).del();
    await db('sms_log').whereIn('id', ids.texts).del();
    await db('scheduled_services').whereIn('id', ids.visits).del();
    await db('call_commitments').whereIn('id', ids.promises).del();
    await db('call_log').whereIn('id', ids.calls).del();
    await db('leads').whereIn('id', ids.leads).del();
    await db('customers').whereIn('id', ids.customers).del();
  });

  // One synthetic new-lead caller: a lead, the inbound call that made it, and the caller's own call_back promise.
  async function caller({ nature = 'new_lead', leadStatus = 'new', callAt = CALL_AT, withCustomer = false, promiseOver = {} } = {}) {
    seq += 1;
    const phone = `+1941555${String(1000 + seq)}`;
    const leadId = randomUUID();
    const callId = randomUUID();
    const sid = `CA${randomUUID().replace(/-/g, '')}`;
    let customerId = null;
    if (withCustomer) {
      customerId = randomUUID();
      await db('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Synthetic', phone });
      ids.customers.push(customerId);
    }
    await db('leads').insert({
      id: leadId, first_name: 'Pat', last_name: 'Synthetic', phone, status: leadStatus, twilio_call_sid: sid,
      service_interest: 'Quarterly Pest Control Service', customer_id: customerId, created_at: callAt,
    });
    ids.leads.push(leadId);
    await db('call_log').insert({
      id: callId, direction: 'inbound', from_phone: phone, to_phone: '+19415550000', twilio_call_sid: sid, status: 'completed',
      duration_seconds: 120, customer_id: customerId, created_at: callAt, updated_at: callAt,
      ai_extraction_enriched: JSON.stringify({ call_nature: nature, caller: { name_full: 'Pat Synthetic' } }),
    });
    ids.calls.push(callId);
    const [promise] = await db('call_commitments').insert({
      call_log_id: callId, commitment_key: 'customer:call_back', party: 'customer', kind: 'call_back', source: 'ai', status: 'open',
      description: 'The caller said they would call us back after talking with their spouse', created_at: callAt, updated_at: callAt, ...promiseOver,
    }).returning('id');
    ids.promises.push(promise.id);
    return { leadId, callId, customerId, phone, promiseId: promise.id };
  }

  async function inboundCall(from, at) {
    const id = randomUUID();
    await db('call_log').insert({ id, direction: 'inbound', from_phone: from, to_phone: '+19415550000', status: 'no-answer', created_at: at, updated_at: at });
    ids.calls.push(id);
    return id;
  }

  // A quote delivered at `at` (the shared hand-off witness reads deliveryState, never sent_at).
  async function deliveredQuote({ customerId = null, leadId = null }, at) {
    const id = randomUUID();
    const deliveryState = { firstDeliveredAt: at, lastDeliveredAt: at, deliveredAt: [at] };
    await db('estimates').insert({
      id, customer_id: customerId, status: 'sent', customer_name: 'Pat Synthetic',
      estimate_data: JSON.stringify({ ...(leadId ? { lead_id: leadId } : {}), deliveryState }), created_at: at,
    });
    ids.estimates.push(id);
  }

  async function inboundText(from, at) {
    const id = randomUUID();
    await db('sms_log').insert({ id, direction: 'inbound', from_phone: from, to_phone: '+19415550000', message_body: 'Hi, it is Pat', created_at: at, updated_at: at });
    ids.texts.push(id);
    return id;
  }

  const run = (now = NOW) => Bell.runCallerCallbackBell({ now, gateEnabled: true });

  test('a late callback raises one Leads bell with the right fields, and a repeat run adds nothing', async () => {
    const c = await caller();
    const first = await run();
    expect(first.raised).toBeGreaterThanOrEqual(1);
    const rows = await rowsFor(c.promiseId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.category).toBe('lead');
    expect(row.title).toBe('Leads — call Pat Synthetic back');
    expect(row.body).toBe('Said on the Wed, Nov 4, 10:02 AM call they would call back; no call or text since.');
    expect(row.link).toBe(`/admin/leads?lead=${c.leadId}`);
    expect(row.read_at).toBeNull();
    expect(row.done_at).toBeNull();
    expect(row.detail).toContain('Callback was due Wed, Nov 4, 12:02 PM (2 business hours after the call).');
    expect(row.detail).toContain('Interested in: Quarterly Pest Control Service');
    expect(row.metadata).toMatchObject({
      area: 'Leads', severity: 'needs-you', who: 'person', doneWhen: 'lead_contacted', subject: { type: 'lead', id: c.leadId },
      leadId: c.leadId, callLogId: c.callId, commitmentId: c.promiseId, dueAt: '2026-11-04T17:02:00.000Z',
      buttons: { kind: 'call_back', items: [expect.objectContaining({ id: 'call', args: { callLogId: c.callId } })] },
    });

    const second = await run();
    expect(second.raised).toBe(0);
    expect(await rowsFor(c.promiseId)).toHaveLength(1);
  });

  test('a call from the caller after the call ended closes the bell on the next run', async () => {
    const c = await caller();
    await run();
    expect(await rowsFor(c.promiseId)).toHaveLength(1);
    await inboundCall(c.phone, '2026-11-04T17:30:00Z');
    const next = await run(new Date('2026-11-04T18:15:00Z'));
    expect(next.closed).toBeGreaterThanOrEqual(1);
    const [row] = await rowsFor(c.promiseId);
    expect(row.done_at).not.toBeNull();
    expect(row.resolution).toBe('They called back');
    expect(row.metadata).toMatchObject({ autoCleared: true, autoClearedReason: 'caller_called' });
    // A closed bell does not ring again.
    await run(new Date('2026-11-04T18:30:00Z'));
    expect(await rowsFor(c.promiseId)).toHaveLength(1);
  });

  test('a lead closed after the bell rang closes it with "The lead is closed"', async () => {
    const c = await caller();
    await run();
    await db('leads').where({ id: c.leadId }).update({ status: 'lost' });
    await run(new Date('2026-11-04T18:15:00Z'));
    const [row] = await rowsFor(c.promiseId);
    expect(row.resolution).toBe('The lead is closed');
  });

  test.each([
    ['the caller called before the callback was due', async (c) => inboundCall(c.phone, '2026-11-04T16:00:00Z')],
    ['the caller texted', async (c) => inboundText(c.phone, '2026-11-04T16:30:00Z')],
    ['a visit was booked for the caller', async (c) => {
      const id = randomUUID();
      await db('scheduled_services').insert({
        id, customer_id: c.customerId, scheduled_date: '2026-11-10', service_type: 'Quarterly Pest Control Service', status: 'confirmed', created_at: '2026-11-04T16:00:00Z',
      });
      ids.visits.push(id);
    }],
  ])('no bell when %s', async (_name, settle) => {
    const c = await caller({ withCustomer: true });
    await settle(c);
    await run();
    expect(await rowsFor(c.promiseId)).toHaveLength(0);
  });

  test('a quote sent after the call does not stop the bell: the caller may have promised to call back about it', async () => {
    const owned = await caller({ withCustomer: true });
    await deliveredQuote({ customerId: owned.customerId }, '2026-11-04T16:00:00Z');
    const parked = await caller();
    await deliveredQuote({ leadId: parked.leadId }, '2026-11-04T16:00:00Z');
    await run();
    expect(await rowsFor(owned.promiseId)).toHaveLength(1);
    expect(await rowsFor(parked.promiseId)).toHaveLength(1);
  });

  test('evidence from before the call ended does not settle it', async () => {
    const c = await caller();
    await inboundText(c.phone, '2026-11-04T14:00:00Z');
    await run();
    expect(await rowsFor(c.promiseId)).toHaveLength(1);
  });

  test('no bell for a lost lead, a call that was not a new lead, or a promise a person already touched', async () => {
    const lost = await caller({ leadStatus: 'lost' });
    const other = await caller({ nature: 'existing_customer' });
    const touched = await caller({ promiseOver: { human_state: 'confirmed' } });
    await run();
    for (const c of [lost, other, touched]) expect(await rowsFor(c.promiseId)).toHaveLength(0);
  });

  test('no bell before the callback is due, and none when it fell due more than 24 hours ago', async () => {
    const early = await caller();
    await run(new Date('2026-11-04T16:00:00Z')); // 11:00 AM, due 12:02 PM
    expect(await rowsFor(early.promiseId)).toHaveLength(0);

    const old = await caller({ callAt: '2026-11-02T15:00:00Z' }); // due Monday 12:02 PM
    await run();
    expect(await rowsFor(old.promiseId)).toHaveLength(0);
  });

  test('gate off: nothing is read and nothing is written', async () => {
    const c = await caller();
    await expect(Bell.runCallerCallbackBell({ now: NOW, gateEnabled: false })).resolves.toEqual({ skipped: 'disabled' });
    expect(await rowsFor(c.promiseId)).toHaveLength(0);
  });
  describe('promise close (GATE_CALLER_CALLBACK_PROMISE_CLOSE)', () => {
    const commitments = () => require('../services/call-commitments');
    const runClosing = (now = NOW) => Bell.runCallerCallbackBell({ now, gateEnabled: true, promiseCloseEnabled: true });
    const promiseRow = (id) => db('call_commitments').where({ id }).first();
    const EARLY = new Date('2026-11-04T16:30:00Z'); // 11:30 AM Eastern, before the 12:02 PM due time
    const bookedVisit = async (c) => {
      const id = randomUUID();
      await db('scheduled_services').insert({
        id, customer_id: c.customerId, scheduled_date: '2026-11-10', service_type: 'Quarterly Pest Control Service', status: 'confirmed', created_at: '2026-11-04T16:00:00Z',
      });
      ids.visits.push(id);
    };

    test('a caller who called back closes the promise even when it was not yet due and no bell rang', async () => {
      const c = await caller();
      const callId = await inboundCall(c.phone, '2026-11-04T16:00:00Z');
      const result = await runClosing(EARLY);
      expect(result.promisesClosed).toBeGreaterThanOrEqual(1);
      expect(await rowsFor(c.promiseId)).toHaveLength(0);
      const row = await promiseRow(c.promiseId);
      expect(row.status).toBe('fulfilled');
      expect(new Date(row.fulfilled_at).toISOString()).toBe('2026-11-04T16:00:00.000Z');
      expect(row.fulfillment).toEqual({
        kind: 'inbound_call', record_type: 'call_log', record_id: callId, matched_at: '2026-11-04T16:00:00.000Z', strength: 'association',
        basis: 'caller_called', closed_by: 'caller_callback_bell', closed_at: EARLY.toISOString(),
      });
      // Settled and closed: a later run finds no open promise, raises nothing and writes nothing more.
      const again = await runClosing(NOW);
      expect(again.promisesClosed).toBe(0);
      expect(await rowsFor(c.promiseId)).toHaveLength(0);
    });

    test('a caller who texted closes the promise, naming the text', async () => {
      const c = await caller();
      const textId = await inboundText(c.phone, '2026-11-04T16:10:00Z');
      await runClosing(EARLY);
      const row = await promiseRow(c.promiseId);
      expect(row.status).toBe('fulfilled');
      expect(row.fulfillment).toMatchObject({ kind: 'inbound_sms', record_type: 'sms_log', record_id: textId, basis: 'caller_texted', closed_by: 'caller_callback_bell' });
    });

    test('a booked visit closes the promise with basis followed_up and no record, at the run time', async () => {
      const c = await caller({ withCustomer: true });
      await bookedVisit(c);
      await runClosing(EARLY);
      const row = await promiseRow(c.promiseId);
      expect(row.status).toBe('fulfilled');
      expect(row.fulfillment).toEqual({
        kind: 'followed_up', record_type: null, record_id: null, matched_at: EARLY.toISOString(), strength: 'association',
        basis: 'followed_up', closed_by: 'caller_callback_bell', closed_at: EARLY.toISOString(),
      });
    });

    test('a bell already raised closes and its promise closes in the same run', async () => {
      const c = await caller();
      await run();
      expect(await rowsFor(c.promiseId)).toHaveLength(1);
      expect((await promiseRow(c.promiseId)).status).toBe('open');
      const callId = await inboundCall(c.phone, '2026-11-04T17:30:00Z');
      const next = await runClosing(new Date('2026-11-04T18:15:00Z'));
      expect(next.closed).toBeGreaterThanOrEqual(1);
      expect(next.promisesClosed).toBeGreaterThanOrEqual(1);
      const [bell] = await rowsFor(c.promiseId);
      expect(bell.resolution).toBe('They called back');
      const row = await promiseRow(c.promiseId);
      expect(row.status).toBe('fulfilled');
      expect(row.fulfillment).toMatchObject({ record_id: callId, basis: 'caller_called' });
    });

    test('a lost lead with no word from the caller, or evidence from before the call ended, never writes the promise', async () => {
      const lost = await caller({ leadStatus: 'lost' });
      const earlier = await caller();
      await inboundText(earlier.phone, '2026-11-04T14:00:00Z');
      const raised = await caller();
      await run();
      await db('leads').where({ id: raised.leadId }).update({ status: 'lost' });
      await runClosing(new Date('2026-11-04T18:15:00Z'));
      for (const c of [lost, earlier, raised]) expect((await promiseRow(c.promiseId)).status).toBe('open');
      const [bell] = await rowsFor(raised.promiseId);
      expect(bell.resolution).toBe('The lead is closed');
    });

    test('a caller who called back kept the promise even when the lead closed since (booked, or said no on that call)', async () => {
      const won = await caller({ leadStatus: 'won', withCustomer: true });
      const callId = await inboundCall(won.phone, '2026-11-04T16:00:00Z');
      await runClosing(EARLY);
      const row = await promiseRow(won.promiseId);
      expect(row.status).toBe('fulfilled');
      expect(row.fulfillment).toMatchObject({ record_id: callId, basis: 'caller_called' });
      expect(await rowsFor(won.promiseId)).toHaveLength(0);
    });

    test('a call with no linked lead never rings, but a kept promise on it still closes', async () => {
      const kept = await caller();
      const quiet = await caller();
      await db('leads').whereIn('id', [kept.leadId, quiet.leadId]).del();
      const callId = await inboundCall(kept.phone, '2026-11-04T16:00:00Z');
      await runClosing(NOW);
      expect((await promiseRow(kept.promiseId)).fulfillment).toMatchObject({ record_id: callId, basis: 'caller_called' });
      expect((await promiseRow(quiet.promiseId)).status).toBe('open');
      for (const c of [kept, quiet]) expect(await rowsFor(c.promiseId)).toHaveLength(0);
    });

    test('a promise a person touched or edited between the read and the write is not overwritten', async () => {
      const touched = await caller();
      const edited = await caller();
      const callId = await inboundCall(touched.phone, '2026-11-04T16:00:00Z');
      const verdict = { key: 'called', record: { type: 'call_log', id: callId, at: '2026-11-04T16:00:00Z' } };
      const read = async (c) => (await Bell._private.loadPromises(db, { ids: [c.promiseId] }))[0];
      const staleTouched = await read(touched);
      const staleEdited = await read(edited);
      await db('call_commitments').where({ id: touched.promiseId }).update({ human_state: 'dismissed', status: 'dismissed', updated_at: new Date() });
      await db('call_commitments').where({ id: edited.promiseId }).update({ description: 'Edited by staff', updated_at: new Date(Date.now() + 5000) });
      expect(await Bell._private.keepPromise(db, staleTouched, verdict, NOW)).toBe(0);
      expect(await Bell._private.keepPromise(db, staleEdited, verdict, NOW)).toBe(0);
      expect(await promiseRow(touched.promiseId)).toMatchObject({ status: 'dismissed', human_state: 'dismissed', fulfillment: null });
      expect(await promiseRow(edited.promiseId)).toMatchObject({ status: 'open', description: 'Edited by staff', fulfillment: null });
    });

    test('refreshFulfillment on the call leaves the closed promise closed (the promise_evidence marker would reopen it)', async () => {
      const c = await caller();
      await inboundCall(c.phone, '2026-11-04T16:00:00Z');
      await runClosing(EARLY);
      const closed = await promiseRow(c.promiseId);
      expect(closed.status).toBe('fulfilled');
      const refreshed = await commitments().refreshFulfillment(db, c.callId);
      expect(refreshed.reopened || 0).toBe(0);
      const after = await promiseRow(c.promiseId);
      expect(after.status).toBe('fulfilled');
      expect(after.fulfillment).toEqual(closed.fulfillment);
      expect(new Date(after.updated_at).getTime()).toBe(new Date(closed.updated_at).getTime());
    });

    test('a Waves promise on the same call is never touched', async () => {
      const c = await caller();
      const [waves] = await db('call_commitments').insert({
        call_log_id: c.callId, commitment_key: 'waves:callback', party: 'waves', kind: 'callback', source: 'ai', status: 'open',
        description: 'We will call you back tomorrow', created_at: CALL_AT, updated_at: CALL_AT,
      }).returning('*');
      await inboundCall(c.phone, '2026-11-04T16:00:00Z');
      await runClosing(EARLY);
      expect((await promiseRow(c.promiseId)).status).toBe('fulfilled');
      const after = await promiseRow(waves.id);
      expect(after.status).toBe('open');
      expect(after.fulfillment).toBeNull();
      expect(new Date(after.updated_at).getTime()).toBe(new Date(waves.updated_at).getTime());
    });

    test('gate off: the promise stays open exactly as today, bell or no bell', async () => {
      const early = await caller();
      await inboundCall(early.phone, '2026-11-04T16:00:00Z');
      const rung = await caller();
      await run();
      await inboundCall(rung.phone, '2026-11-04T17:30:00Z');
      const off = await Bell.runCallerCallbackBell({ now: new Date('2026-11-04T18:15:00Z'), gateEnabled: true, promiseCloseEnabled: false });
      expect(off.promisesClosed).toBe(0);
      expect((await rowsFor(rung.promiseId))[0].resolution).toBe('They called back');
      for (const c of [early, rung]) expect(await promiseRow(c.promiseId)).toMatchObject({ status: 'open', fulfillment: null, fulfilled_at: null });
    });
  });
});

/**
 * admin-alert-relevance.js against live Postgres, the SQL as the sweep runs
 * it: the re-arm pass (this module's stamp and its window, the put-back fenced
 * on the version read — a millisecond done_at compared exactly), a new
 * lead's booking evidence (after the bell, never a visit that did not run) and
 * the customer-contact classes behind GATE_ALERT_CONTACT_CLOSE (the shared
 * witnesses as SQL: the Messages reader, a person's text and call, a visit, a
 * quote, a person's email reply), and the two rules with their own gates
 * (GATE_VOICEMAIL_VISIT_UNDERWAY: a visit that ran after a voicemail;
 * GATE_LEAD_CONTACTED_CLOSE: the lead_contacted Leads bells). The rules
 * themselves are covered by admin-alert-relevance.test.js.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

const { etDateString } = require('../utils/datetime-et');

const DAY = 24 * 60 * 60 * 1000;

maybeDescribe('alert relevance re-arm (live Postgres)', () => {
  let db;
  let relevance;
  const made = { notifications: [], sms_log: [], call_log: [], emails: [], scheduled_services: [], estimates: [], leads: [], customers: [] };

  beforeAll(() => {
    db = require('../models/db');
    relevance = require('../services/admin-alert-relevance');
  });
  afterEach(() => {
    delete process.env.GATE_ALERT_CONTACT_CLOSE;
    delete process.env.GATE_VOICEMAIL_VISIT_UNDERWAY;
    delete process.env.GATE_LEAD_CONTACTED_CLOSE;
  });
  afterAll(async () => {
    if (made.notifications.length) await db('audit_log').where({ resource_type: 'notification' }).whereIn('resource_id', made.notifications).del();
    for (const table of ['notifications', 'sms_log', 'call_log', 'emails', 'scheduled_services', 'leads', 'estimates', 'customers']) {
      if (made[table].length) await db(table).whereIn('id', made[table]).del();
    }
    await db.destroy();
  }, 120000);

  const insert = async (table, row) => {
    const [r] = await db(table).insert(row).returning('*');
    made[table].push(r.id);
    return r;
  };
  const bell = (row) => insert('notifications', { recipient_type: 'admin', title: 'Fixture alert', ...row, metadata: JSON.stringify(row.metadata) });
  const stamp = (reason, at) => ({ retired: { by: 'alert-relevance', reason, at: at.toISOString() } });
  const get = (id) => db('notifications').where({ id }).first();

  test('takes over a person\'s Done once its subject moved on (no Reopen), fenced on that exact close; one still relevant stays theirs', async () => {
    const now = new Date();
    const customer = await insert('customers', { first_name: 'Takeover', phone: '+15555557009' });
    const pastDay = etDateString(new Date(now.getTime() - 3 * DAY));
    const done = await insert('scheduled_services', { customer_id: customer.id, scheduled_date: pastDay, service_type: 'General Pest Control', status: 'completed' });
    const stuck = await insert('scheduled_services', { customer_id: customer.id, scheduled_date: pastDay, service_type: 'General Pest Control', status: 'on_site' });
    const person = '0b1f6c1e-3c64-4f8e-9d7a-5a2f3e9b1c10';
    const at = new Date(now.getTime() - 60 * 60 * 1000);
    const movedOn = await bell({ category: 'alert', read_at: at, done_at: at, done_by: person, resolution: 'Called the tech',
      metadata: { dedupeKey: `stale-visit:${done.id}:takeover`, scheduled_service_id: done.id } });
    const stillStale = await bell({ category: 'alert', read_at: at, done_at: at, done_by: person, resolution: 'On it',
      metadata: { dedupeKey: `stale-visit:${stuck.id}:takeover`, scheduled_service_id: stuck.id } });

    await relevance.runAdminAlertRelevanceSweep({ now });

    const a = await get(movedOn.id);
    expect(a.done_by).toBe('relevance');
    expect([a.done_at.getTime(), a.resolution, a.read_at.getTime()]).toEqual([at.getTime(), 'Called the tech', at.getTime()]);
    expect(JSON.parse(JSON.stringify(a.metadata)).retired).toBeUndefined();
    const NotificationService = require('../services/notification-service');
    const token = (await db('notifications').where({ id: movedOn.id }).first(db.raw('done_at::text AS t'))).t;
    expect(await NotificationService.reopenAdminDone(movedOn.id, { expectedDoneAt: token })).toBe('not_reopenable');
    expect((await get(stillStale.id)).done_by).toBe(person);
  });

  test('puts back what it retired in the window once the subject is relevant again (keeping a person\'s read); older retirements, and a person\'s own reopen, are final', async () => {
    const now = new Date();
    // As the sweep writes it: millisecond-exact, and the stamp's `at` is that same done_at (and, on an unread row, read_at).
    const recent = new Date(now.getTime() - DAY);
    const old = new Date(now.getTime() - 20 * DAY);
    const customer = await insert('customers', { first_name: 'Rearm', phone: '+15555557001' });
    // Stale again: from before today (ET), back in on_site.
    const pastDay = etDateString(new Date(now.getTime() - 3 * DAY));
    const visit = await insert('scheduled_services', {
      customer_id: customer.id, scheduled_date: pastDay, service_type: 'General Pest Control', status: 'on_site',
    });

    // A stale-visit bell the sweep retired whose visit is stuck in progress again.
    const reopened = await bell({ category: 'alert', read_at: recent,
      done_at: recent, done_by: 'relevance', resolution: 'Visit is no longer in progress',
      metadata: { dedupeKey: `stale-visit:${visit.id}`, scheduled_service_id: visit.id, ...stamp('Visit is no longer in progress', recent) } });
    // The same, retired before the window: final.
    const final = await bell({ category: 'alert', read_at: old, done_at: old, done_by: 'relevance', resolution: 'Visit is no longer in progress',
      metadata: { dedupeKey: `stale-visit:${visit.id}:old`, scheduled_service_id: visit.id, ...stamp('Visit is no longer in progress', old) } });
    // Retired in the window, then READ by a person (a later read_at than the stamp's): read is not done,
    // so the put-back reopens it, and their read stands.
    const personRead = new Date(now.getTime() - 60 * 60 * 1000);
    const readByPerson = await bell({ category: 'alert', read_at: personRead, done_at: recent, done_by: 'relevance', resolution: 'Visit is no longer in progress',
      metadata: { dedupeKey: `stale-visit:${visit.id}:read`, scheduled_service_id: visit.id, ...stamp('Visit is no longer in progress', recent) } });
    // Retired in the window, then REOPENED by a person (done cleared, the stamp survives): theirs, never put back or re-retired.
    const reopenedByPerson = await bell({ category: 'alert', read_at: recent,
      metadata: { dedupeKey: `stale-visit:${visit.id}:reopened`, scheduled_service_id: visit.id, ...stamp('Visit is no longer in progress', recent) } });

    const result = await relevance.runAdminAlertRelevanceSweep({ now });
    expect(result.rearmed).toBeGreaterThanOrEqual(1);
    // Unread again, and the retire pass right after left it: the visit is still stale.
    const back = await get(reopened.id);
    expect(back.read_at).toBeNull();
    // A put-back returns the row to the bell: the done fields clear with the read.
    expect([back.done_at, back.done_by, back.resolution]).toEqual([null, null, null]);
    expect(back.metadata).toEqual({ dedupeKey: `stale-visit:${visit.id}`, scheduled_service_id: visit.id });
    const kept = await get(final.id);
    expect(kept.read_at).toEqual(old);
    expect(kept.done_at).toEqual(old);
    expect(kept.metadata.retired).toMatchObject({ by: 'alert-relevance' });
    const read = await get(readByPerson.id);
    expect(read.read_at).toEqual(personRead);
    expect([read.done_at, read.done_by, read.resolution]).toEqual([null, null, null]);
    expect(read.metadata.retired).toBeUndefined();
    const theirReopen = await get(reopenedByPerson.id);
    expect(theirReopen.done_at).toBeNull();
    expect(theirReopen.read_at).toEqual(recent);
    expect(theirReopen.metadata.retired).toMatchObject({ by: 'alert-relevance' });

    // Moved on again: the next sweep retires the bell once more.
    await db('scheduled_services').where({ id: visit.id }).update({ status: 'completed' });
    await relevance.runAdminAlertRelevanceSweep({ now: new Date() });
    const again = await get(reopened.id);
    expect(again.read_at).toBeInstanceOf(Date);
    expect(again.done_at).toBeInstanceOf(Date);
    expect([again.done_by, again.resolution]).toEqual(['relevance', 'Visit is no longer in progress']);
    expect(again.metadata.retired).toMatchObject({ by: 'alert-relevance', reason: 'Visit is no longer in progress' });
  });

  test('a new-lead bell is judged only by what happened after it: an earlier estimate, a conversion or a booking that never ran does not count, a live booking does', async () => {
    const now = new Date();
    const bellAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const customer = await insert('customers', { first_name: 'Lead', phone: '+15555557002' });
    const estimate = await insert('estimates', { status: 'sent', customer_id: customer.id, sent_at: new Date(bellAt.getTime() - DAY) });
    // Converted by a booking after the bell — that visit was then a no-show (below).
    const lead = await insert('leads', { first_name: 'Lead', phone: '+15555557002', status: 'estimate_sent', customer_id: customer.id, estimate_id: estimate.id,
      converted_at: new Date(bellAt.getTime() + 60 * 60 * 1000) });
    const leadBell = await bell({ category: 'new_lead', link: `/admin/leads?lead=${lead.id}`, created_at: bellAt,
      metadata: { triggerKey: 'new_lead', payload: { leadId: lead.id } } });
    const booked = (status) => insert('scheduled_services', { customer_id: customer.id, scheduled_date: etDateString(new Date(now.getTime() + 7 * DAY)),
      service_type: 'General Pest Control', status, created_at: new Date(bellAt.getTime() + 60 * 60 * 1000) });

    // A status and an estimate from before the bell, a conversion after it, and the visit booked after it a no-show: still relevant.
    await booked('no_show');
    await relevance.runAdminAlertRelevanceSweep({ now });
    const open = await get(leadBell.id);
    expect([open.read_at, open.done_at]).toEqual([null, null]);
    // A live visit booked after the bell: moved on.
    await booked('confirmed');
    await relevance.runAdminAlertRelevanceSweep({ now });
    const retired = await get(leadBell.id);
    expect(retired.read_at).toBeInstanceOf(Date);
    expect(retired.done_at).toBeInstanceOf(Date);
    expect(retired.metadata.retired).toMatchObject({ by: 'alert-relevance', reason: 'A visit was booked' });
  });

  test('an add-a-service portal chat bell closes on a real handoff to its customer after the bell, never on sent_at alone, an earlier delivery or another customer\'s estimate (owner 2026-10-03)', async () => {
    const now = new Date();
    const bellAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const after = new Date(bellAt.getTime() + 60 * 60 * 1000);
    const before = new Date(bellAt.getTime() - DAY);
    const delivered = (at) => JSON.stringify({ deliveryState: { firstDeliveredAt: at.toISOString(), lastDeliveredAt: at.toISOString() } });
    const customer = await insert('customers', { first_name: 'Chat', phone: '+15555557004' });
    const other = await insert('customers', { first_name: 'Other', phone: '+15555557005' });
    const chat = (topic, key) => bell({ category: 'alert', created_at: bellAt,
      metadata: { dedupeKey: `portal-chat-escalation:${key}`, customerId: customer.id, topic } });
    const asked = await chat('add_service', `${customer.id}:a`);
    const cancel = await chat('cancellation', `${customer.id}:b`);
    // A suppressed send (sent_at stamped, nothing delivered), a delivery from
    // before the question, and another customer's delivery: still open.
    await insert('estimates', { status: 'sent', customer_id: customer.id, sent_at: after });
    await insert('estimates', { status: 'sent', customer_id: customer.id, sent_at: before, estimate_data: delivered(before) });
    await insert('estimates', { status: 'sent', customer_id: other.id, sent_at: after, estimate_data: delivered(after) });
    await relevance.runAdminAlertRelevanceSweep({ now });
    expect((await get(asked.id)).done_at).toBeNull();
    // Delivered after the question with sent_at still null (accepted during
    // its first send): the handoff witness, so the bell closes. The
    // cancellation bell for the same customer is never judged.
    await insert('estimates', { status: 'accepted', customer_id: customer.id, estimate_data: delivered(after) });
    await relevance.runAdminAlertRelevanceSweep({ now });
    const closed = await get(asked.id);
    expect([closed.done_by, closed.resolution]).toEqual(['relevance', 'Estimate was sent']);
    expect((await get(cancel.id)).done_at).toBeNull();
  });

  test('a repeat-form alert closes on a real handoff to its customer after its latest form, never on a suppressed send (sent_at alone)', async () => {
    const now = new Date();
    const bellAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const after = new Date(bellAt.getTime() + 60 * 60 * 1000);
    const delivered = (at) => JSON.stringify({ deliveryState: { firstDeliveredAt: at.toISOString(), lastDeliveredAt: at.toISOString() } });
    const customer = await insert('customers', { first_name: 'Repeat', phone: '+15555557006' });
    const lead = await insert('leads', { first_name: 'Repeat', phone: '+15555557006', status: 'new', customer_id: customer.id });
    const alert = await bell({ category: 'lead', link: `/admin/leads?lead=${lead.id}`, created_at: bellAt,
      metadata: { dedupeKey: `lead-repeat-form:${customer.id}`, customerId: customer.id, leadId: lead.id, source: 'lead_repeat_form' } });
    // A suppressed send after the form (sent_at stamped, nothing delivered): still open.
    await insert('estimates', { status: 'sent', customer_id: customer.id, sent_at: after });
    await relevance.runAdminAlertRelevanceSweep({ now });
    expect((await get(alert.id)).done_at).toBeNull();
    // A real delivery after the form closes it.
    await insert('estimates', { status: 'sent', customer_id: customer.id, sent_at: after, estimate_data: delivered(after) });
    await relevance.runAdminAlertRelevanceSweep({ now });
    const closed = await get(alert.id);
    expect([closed.done_by, closed.resolution]).toEqual(['relevance', 'Estimate was sent']);
  });

  test('a quote sent to the lead\'s customer after the bell keeps its bell retired when a newer draft takes over the lead\'s estimate pointer', async () => {
    const now = new Date();
    const bellAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const customer = await insert('customers', { first_name: 'Quoted', phone: '+15555557003' });
    const sent = await insert('estimates', { status: 'sent', customer_id: customer.id, sent_at: new Date(bellAt.getTime() + 60 * 60 * 1000) });
    const lead = await insert('leads', { first_name: 'Quoted', phone: '+15555557003', status: 'new', customer_id: customer.id, estimate_id: sent.id });
    const leadBell = await bell({ category: 'new_lead', link: `/admin/leads?lead=${lead.id}`, created_at: bellAt,
      metadata: { triggerKey: 'new_lead', payload: { leadId: lead.id } } });
    await relevance.runAdminAlertRelevanceSweep({ now });
    const retired = await get(leadBell.id);
    expect(retired.metadata.retired).toMatchObject({ reason: 'Estimate was sent' });
    // A newer draft takes over leads.estimate_id; the next run's re-arm pass keeps the retirement.
    const draft = await insert('estimates', { status: 'draft', customer_id: customer.id });
    await db('leads').where({ id: lead.id }).update({ estimate_id: draft.id });
    await relevance.runAdminAlertRelevanceSweep({ now: new Date() });
    const kept = await get(leadBell.id);
    expect([kept.read_at, kept.done_at]).toEqual([retired.read_at, retired.done_at]);
  });
  // ---- customer-contact classes (GATE_ALERT_CONTACT_CLOSE) -------------------
  describe('customer-contact classes', () => {
    const BIZ = '+15555559000';
    let n = 0;
    const sid = (prefix) => `${prefix}${String(Date.now()).slice(-8)}${String((n += 1)).padStart(6, '0')}`;
    const mins = (base, m) => new Date(base.getTime() + m * 60 * 1000);
    const gate = (mode) => { process.env.GATE_ALERT_CONTACT_CLOSE = mode; };
    const sweep = (now = new Date()) => relevance.runAdminAlertRelevanceSweep({ now });
    const wouldClose = (id) => db('audit_log').where({ action: 'notification.alert_relevance.would_close', resource_type: 'notification', resource_id: id });
    const customerWith = (phone, extra = {}) => insert('customers', { first_name: 'Contact', phone, ...extra });
    // An inbound text and the bell that rang for it (a known sender's shared thread row, or an unknown sender's per-text row).
    const text = async ({ customer = null, phone, at, body = 'Can you come out on Tuesday?', known = true }) => {
      const messageSid = sid('SMI');
      await insert('sms_log', { direction: 'inbound', from_phone: phone, to_phone: BIZ, customer_id: customer?.id || null, message_body: body,
        message_type: 'customer_reply', status: 'received', twilio_sid: messageSid, created_at: at });
      const row = await bell({ category: 'inbound_sms', created_at: mins(at, 1),
        link: known && customer ? `/admin/communications?thread=${customer.id}&message=${messageSid}` : `/admin/communications?message=${messageSid}`,
        metadata: { triggerKey: 'sms_reply', ...(known && customer ? { dedupeKey: `sms-thread:${customer.id}` } : { dedupeKey: `sms-reply:${messageSid}` }),
          payload: { twilioSid: messageSid, threadId: known && customer ? customer.id : null } } });
      return { messageSid, row };
    };
    const staffText = (customer, phone, at, over = {}) => insert('sms_log', { direction: 'outbound', from_phone: BIZ, to_phone: phone, customer_id: customer?.id || null,
      message_body: 'Yes, Tuesday works.', message_type: 'manual', status: 'delivered', twilio_sid: sid('SMO'), metadata: JSON.stringify({ human_authored: true }), created_at: at, ...over });
    const staffCall = (customer, phone, at, over = {}) => insert('call_log', { direction: 'outbound', from_phone: BIZ, to_phone: phone, customer_id: customer?.id || null,
      status: 'completed', source: 'admin-click', duration_seconds: 180, v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: 'false' } }),
      twilio_call_sid: sid('CAO'), created_at: at, ...over });

    test('gate off: a customer-contact bell is not judged at all, however answered it is', async () => {
      const t0 = mins(new Date(), -120);
      const customer = await customerWith('+15555558001');
      const { row } = await text({ customer, phone: customer.phone, at: t0 });
      await staffText(customer, customer.phone, mins(t0, 5));
      const result = await sweep();
      expect(result.byClass.inbound_sms).toBeUndefined();
      expect((await get(row.id)).done_at).toBeNull();
      expect(await wouldClose(row.id)).toHaveLength(0);
    });

    test('shadow: records what would close once per ET day and changes nothing on the bell; true closes it with the reason', async () => {
      const t0 = mins(new Date(), -120);
      const customer = await customerWith('+15555558002');
      const { row } = await text({ customer, phone: customer.phone, at: t0 });
      await staffText(customer, customer.phone, mins(t0, 5));
      const before = await get(row.id);

      gate('shadow');
      const first = await sweep();
      expect(first.wouldClose).toBeGreaterThanOrEqual(1);
      const after = await get(row.id);
      expect([after.read_at, after.done_at, after.done_by, after.resolution]).toEqual([null, null, null, null]);
      expect(after.metadata).toEqual(before.metadata);
      const rows = await wouldClose(row.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({ class: 'inbound_sms', reason: 'Answered by text', etDay: etDateString(new Date()) });
      await sweep();
      expect(await wouldClose(row.id)).toHaveLength(1);

      gate('true');
      await sweep();
      const closed = await get(row.id);
      expect([closed.done_by, closed.resolution]).toEqual(['relevance', 'Answered by text']);
      expect(closed.read_at).toBeInstanceOf(Date);
      expect(closed.metadata.retired).toMatchObject({ by: 'alert-relevance', reason: 'Answered by text' });
    });

    test('a text: answered by a person\'s text, by a person\'s call, or no reply needed (a courtesy text) closes it; an unanswered one, a reply from before the text and an automated text do not', async () => {
      gate('true');
      const t0 = mins(new Date(), -240);
      const answeredBy = await customerWith('+15555558003');
      const calledBy = await customerWith('+15555558004');
      const courtesy = await customerWith('+15555558005');
      const unanswered = await customerWith('+15555558006');
      const earlierReply = await customerWith('+15555558007');
      const automated = await customerWith('+15555558008');
      const a = await text({ customer: answeredBy, phone: answeredBy.phone, at: t0 });
      const b = await text({ customer: calledBy, phone: calledBy.phone, at: t0 });
      // A courtesy text counts as one only after something we sent that asked nothing (the Messages reader's prior-context rule).
      await insert('sms_log', { direction: 'outbound', from_phone: BIZ, to_phone: courtesy.phone, customer_id: courtesy.id, message_body: 'Your visit is complete.',
        message_type: 'service_complete', status: 'delivered', twilio_sid: sid('SMO'), created_at: mins(t0, -60) });
      const c = await text({ customer: courtesy, phone: courtesy.phone, at: t0, body: 'Thank you!' });
      const d = await text({ customer: unanswered, phone: unanswered.phone, at: t0 });
      const e = await text({ customer: earlierReply, phone: earlierReply.phone, at: t0 });
      const f = await text({ customer: automated, phone: automated.phone, at: t0 });
      await staffText(answeredBy, answeredBy.phone, mins(t0, 10));
      await staffCall(calledBy, calledBy.phone, mins(t0, 10));
      await staffText(earlierReply, earlierReply.phone, mins(t0, -30));
      await staffText(automated, automated.phone, mins(t0, 10), { message_type: 'review_request', metadata: JSON.stringify({}) });
      await sweep();
      expect(await get(a.row.id)).toMatchObject({ done_by: 'relevance', resolution: 'Answered by text' });
      expect(await get(b.row.id)).toMatchObject({ done_by: 'relevance', resolution: 'Answered by a call' });
      expect(await get(c.row.id)).toMatchObject({ done_by: 'relevance', resolution: 'Answered, or no reply needed' });
      for (const open of [d, e, f]) expect((await get(open.row.id)).done_at).toBeNull();
    });

    test('a text from an unknown sender is never judged: whatever is sent to that number, its bell stays open and nothing is recorded in shadow', async () => {
      const t0 = mins(new Date(), -240);
      const phone = '+15555558009';
      const unknown = await text({ phone, at: t0, known: false });
      await staffText(null, phone, mins(t0, 10));
      await staffCall(null, phone, mins(t0, 12));
      gate('shadow');
      await sweep();
      expect(await wouldClose(unknown.row.id)).toHaveLength(0);
      gate('true');
      await sweep();
      expect((await get(unknown.row.id)).done_at).toBeNull();
    });

    test('a new text after a close rings the sender\'s thread bell again', async () => {
      gate('true');
      const NotificationService = require('../services/notification-service');
      const t0 = mins(new Date(), -240);
      const customer = await customerWith('+15555558011');
      const first = await text({ customer, phone: customer.phone, at: t0 });
      await staffText(customer, customer.phone, mins(t0, 10));
      await sweep();
      expect((await get(first.row.id)).done_by).toBe('relevance');
      // The emitter's own refresh for the sender's next text (sms-reply-alert-delivery.js ringSmsReplyBell).
      const next = await text({ customer, phone: customer.phone, at: mins(t0, 60), body: 'Also, can you spray the garage?' });
      await db('notifications').where({ id: next.row.id }).del();
      const refreshed = await NotificationService.notifyAdmin('inbound_sms', 'SMS from Contact', 'Also, can you spray the garage?', {
        link: `/admin/communications?thread=${customer.id}&message=${next.messageSid}`,
        metadata: { triggerKey: 'sms_reply', payload: { twilioSid: next.messageSid, threadId: customer.id } },
        dedupeKey: `sms-thread:${customer.id}`, refreshOnDedupe: true, bumpOnRefresh: true,
      });
      expect(refreshed.id).toBe(first.row.id);
      const rung = await get(first.row.id);
      expect([rung.read_at, rung.done_at, rung.done_by, rung.resolution]).toEqual([null, null, null, null]);
      expect(rung.metadata.retired).toBeUndefined();
      // Unanswered: the next sweep leaves it ringing. A staff reply closes it again.
      await sweep();
      expect((await get(first.row.id)).done_at).toBeNull();
      await staffText(customer, customer.phone, mins(t0, 70));
      await sweep();
      expect((await get(first.row.id)).done_by).toBe('relevance');
    });

    test('a voicemail callback request (a missed call is missed-call-bell.js\'s, not the sweep\'s): a person\'s call back, a person-answered call in, a person\'s text, a booked visit or a handed-off quote after the call closes it; earlier contact, an unanswered callback and an automated bell do not', async () => {
      gate('true');
      const t0 = mins(new Date(), -300);
      const callRow = (phone, customer, over = {}) => insert('call_log', { direction: 'inbound', from_phone: phone, to_phone: BIZ, customer_id: customer?.id || null,
        status: 'no-answer', twilio_call_sid: sid('CAI'), created_at: t0, ...over });
      const missed = async (phone, customer, { category = 'voicemail_callback', triggerKey = 'customer_voicemail_callback' } = {}) => {
        const call = await callRow(phone, customer);
        const row = await bell({ category, created_at: mins(t0, 3),
          metadata: { triggerKey, payload: { callLogId: call.id, customerId: customer?.id || null, phone, name: 'Caller' } } });
        return { call, row };
      };
      const cases = {};
      const make = async (key, phone, withCustomer = true, opts) => {
        const customer = withCustomer ? await customerWith(phone) : null;
        cases[key] = { customer, phone, ...(await missed(phone, customer, opts)) };
        return cases[key];
      };
      await make('callBack', '+15555558020');
      await make('inbound', '+15555558021');
      await make('textBack', '+15555558022');
      await make('visit', '+15555558023');
      await make('quote', '+15555558024');
      await make('unknown', '+15555558025', false);
      await make('earlier', '+15555558026');
      await make('voicemail', '+15555558027', true, { category: 'voicemail_callback', triggerKey: 'customer_voicemail_callback' });
      await make('unspoken', '+15555558028');
      await make('automated', '+15555558029');

      await staffCall(cases.callBack.customer, cases.callBack.phone, mins(t0, 20));
      await insert('call_log', { direction: 'inbound', from_phone: cases.inbound.phone, to_phone: BIZ, customer_id: cases.inbound.customer.id, status: 'completed',
        answered_by: 'human', twilio_call_sid: sid('CAI'), created_at: mins(t0, 30), duration_seconds: 90 });
      await staffText(cases.textBack.customer, cases.textBack.phone, mins(t0, 15));
      await insert('scheduled_services', { customer_id: cases.visit.customer.id, scheduled_date: etDateString(new Date(Date.now() + 7 * DAY)),
        service_type: 'General Pest Control', status: 'confirmed', created_at: mins(t0, 40) });
      await insert('estimates', { status: 'sent', customer_id: cases.quote.customer.id, sent_at: mins(t0, 50),
        estimate_data: JSON.stringify({ deliveryState: { firstDeliveredAt: mins(t0, 50).toISOString(), lastDeliveredAt: mins(t0, 50).toISOString() } }) });
      await staffText(null, cases.unknown.phone, mins(t0, 12));
      // A text and a call back from BEFORE the call never answer it.
      await staffText(cases.earlier.customer, cases.earlier.phone, mins(t0, -60));
      await staffCall(cases.earlier.customer, cases.earlier.phone, mins(t0, -60));
      await staffText(cases.voicemail.customer, cases.voicemail.phone, mins(t0, 25));
      // A call back that rang out (no live conversation heard) and a bare dialer row prove no person spoke.
      await staffCall(cases.unspoken.customer, cases.unspoken.phone, mins(t0, 20), { v2_extraction_status: null, ai_extraction_enriched: null });
      await insert('call_log', { direction: 'outbound', from_phone: BIZ, to_phone: cases.unspoken.phone, customer_id: cases.unspoken.customer.id, status: 'completed',
        source: 'collections_voice', twilio_call_sid: sid('CAO'), created_at: mins(t0, 22), duration_seconds: 120, metadata: JSON.stringify({ bridged_at: mins(t0, 22).toISOString() }) });
      // An automated text is not a person's.
      await staffText(cases.automated.customer, cases.automated.phone, mins(t0, 20), { message_type: 'missed_call_followup', metadata: JSON.stringify({}) });
      // The promise chaser shares the category and is not this class's: untouched.
      const chaser = await bell({ category: 'missed_call', created_at: mins(t0, 3), metadata: { triggerKey: 'promise_chaser', dedupeKey: 'promise_chaser:x:y', payload: { phone: cases.callBack.phone } } });

      await sweep();
      const reason = async (key) => { const r = await get(cases[key].row.id); return r.done_at ? [r.done_by, r.resolution] : null; };
      expect(await reason('callBack')).toEqual(['relevance', 'A person called back']);
      expect(await reason('inbound')).toEqual(['relevance', 'A person answered their call']);
      expect(await reason('textBack')).toEqual(['relevance', 'Answered by text']);
      expect(await reason('visit')).toEqual(['relevance', 'A visit was booked']);
      expect(await reason('quote')).toEqual(['relevance', 'Estimate was sent']);
      expect(await reason('unknown')).toEqual(['relevance', 'Answered by text']);
      expect(await reason('voicemail')).toEqual(['relevance', 'Answered by text']);
      for (const open of ['earlier', 'unspoken', 'automated']) expect(await reason(open)).toBeNull();
      expect((await get(chaser.id)).done_at).toBeNull();
    });

    test('a call witness counts by when the call ENDED: a delayed insert of an earlier call, or a post-call row with no end stamp, never closes; a call that began before the event and ended after it does', async () => {
      gate('true');
      const t0 = mins(new Date(), -300);
      const stamp = (extra) => JSON.stringify(extra);
      const missed = async (phone) => {
        const customer = await customerWith(phone);
        const call = await insert('call_log', { direction: 'inbound', from_phone: phone, to_phone: BIZ, customer_id: customer.id, status: 'no-answer', twilio_call_sid: sid('CAI'), created_at: t0 });
        const row = await bell({ category: 'voicemail_callback', created_at: mins(t0, 3),
          metadata: { triggerKey: 'customer_voicemail_callback', payload: { callLogId: call.id, customerId: customer.id, phone, name: 'Caller' } } });
        return { customer, phone, row };
      };
      const noEnd = await missed('+15555558061');
      const endedEarlier = await missed('+15555558062');
      const endedLater = await missed('+15555558063');
      const ringing = await missed('+15555558064');
      const inboundDelayed = await missed('+15555558065');
      // Inserted by the status callback AFTER the call was over (created_at is a post-call time), no end stamp: no trustworthy end.
      await staffCall(noEnd.customer, noEnd.phone, mins(t0, 30), { metadata: stamp({ source: 'status_callback', inserted_on_status: 'completed' }) });
      // The same delayed insert of a call that really ended BEFORE the event.
      await staffCall(endedEarlier.customer, endedEarlier.phone, mins(t0, 30), { metadata: stamp({ source: 'status_callback', ended_at: mins(t0, -10).toISOString() }) });
      // A delayed insert whose own end stamp (Twilio's event time) is after the event: it counts.
      await staffCall(endedLater.customer, endedLater.phone, mins(t0, 30), { metadata: stamp({ source: 'status_callback', ended_at: mins(t0, 12).toISOString() }) });
      // A status-callback row inserted on a non-terminal status was created near the call's start: insert time plus duration.
      await staffCall(ringing.customer, ringing.phone, mins(t0, 20), { metadata: stamp({ source: 'status_callback', inserted_on_status: 'ringing' }) });
      // A recovered row for an inbound call a human answered, no end stamp.
      await insert('call_log', { direction: 'inbound', from_phone: inboundDelayed.phone, to_phone: BIZ, customer_id: inboundDelayed.customer.id, status: 'completed',
        answered_by: 'human', twilio_call_sid: sid('CAI'), created_at: mins(t0, 30), duration_seconds: 60, metadata: stamp({ source: 'twilio_recording_status_recovered' }) });

      // An email received at t0 and a staff call that began 5 minutes before it and ended 10 minutes after.
      const mailer = await customerWith('+15555558066', { email: `overlap-${Date.now()}@example.invalid` });
      const inbound = await insert('emails', { gmail_id: sid('GM'), gmail_thread_id: sid('TH'), from_address: mailer.email, to_address: 'office@waves.example.invalid',
        cc_address: '', bcc_address: '', label_ids: JSON.stringify(['INBOX']), received_at: t0, customer_id: mailer.id });
      const mailRow = await bell({ category: 'inbound_email', created_at: mins(t0, 2), link: `/admin/email?id=${inbound.id}`,
        metadata: { triggerKey: 'customer_email_received', payload: { emailId: inbound.id, customerId: mailer.id } } });
      await staffCall(mailer, mailer.phone, mins(t0, -5), { duration_seconds: 900 });
      // And one that ended just before the email: not after it.
      const before = await customerWith('+15555558067', { email: `before-${Date.now()}@example.invalid` });
      const beforeMail = await insert('emails', { gmail_id: sid('GM'), gmail_thread_id: sid('TH'), from_address: before.email, to_address: 'office@waves.example.invalid',
        cc_address: '', bcc_address: '', label_ids: JSON.stringify(['INBOX']), received_at: t0, customer_id: before.id });
      const beforeRow = await bell({ category: 'inbound_email', created_at: mins(t0, 2), link: `/admin/email?id=${beforeMail.id}`,
        metadata: { triggerKey: 'customer_email_received', payload: { emailId: beforeMail.id, customerId: before.id } } });
      await staffCall(before, before.phone, mins(t0, -30), { duration_seconds: 600 });

      await sweep();
      const state = async (id) => { const r = await get(id); return r.done_at ? [r.done_by, r.resolution] : null; };
      expect(await state(noEnd.row.id)).toBeNull();
      expect(await state(endedEarlier.row.id)).toBeNull();
      expect(await state(inboundDelayed.row.id)).toBeNull();
      expect(await state(endedLater.row.id)).toEqual(['relevance', 'A person called back']);
      expect(await state(ringing.row.id)).toEqual(['relevance', 'A person called back']);
      expect(await state(mailRow.id)).toEqual(['relevance', 'A person called back']);
      expect(await state(beforeRow.id)).toBeNull();
    });

    test('a voicemail bell for a call row inserted after the call was over is anchored on the call\'s real start (callStartedAt); a text before the call still does not count; a missed-call bell is not the sweep\'s', async () => {
      gate('true');
      const t0 = mins(new Date(), -300);
      const delayed = async (phone) => {
        const customer = await customerWith(phone);
        // The status callback inserted this row 10 minutes after the call began; the call lasted 10 minutes.
        const call = await insert('call_log', { direction: 'inbound', from_phone: phone, to_phone: BIZ, customer_id: customer.id, status: 'completed',
          twilio_call_sid: sid('CAI'), created_at: mins(t0, 10), duration_seconds: 600, metadata: JSON.stringify({ source: 'status_callback', inserted_on_status: 'completed' }) });
        const row = await bell({ category: 'voicemail_callback', created_at: mins(t0, 12),
          metadata: { triggerKey: 'customer_voicemail_callback', payload: { callLogId: call.id, customerId: customer.id, phone } } });
        return { customer, phone, row };
      };
      const between = await delayed('+15555558071');
      const early = await delayed('+15555558072');
      await staffText(between.customer, between.phone, mins(t0, 5));
      await staffText(early.customer, early.phone, mins(t0, -3));
      // A missed-call bell with a person's text after it: missed-call-bell.js owns it, the sweep leaves it.
      const missedCustomer = await customerWith('+15555558073');
      const missedBell = await bell({ category: 'missed_call', created_at: mins(t0, 3),
        metadata: { triggerKey: 'customer_missed_call', payload: { customerId: missedCustomer.id, phone: missedCustomer.phone } } });
      await staffText(missedCustomer, missedCustomer.phone, mins(t0, 20));
      await sweep();
      expect(await get(between.row.id)).toMatchObject({ done_by: 'relevance', resolution: 'Answered by text' });
      expect((await get(early.row.id)).done_at).toBeNull();
      expect((await get(missedBell.id)).done_at).toBeNull();
    });

    test('a shared phone never crosses two different customers: a text, call back or reply to B is not contact for A; a witness with no customer id, an unknown subject and the same customer by id still match', async () => {
      gate('true');
      const t0 = mins(new Date(), -300);
      const shared = '+15555558081';
      const a = await customerWith(shared);
      const b = await customerWith(shared);
      const voicemailFor = async (customer, phone, { known = true } = {}) => {
        const call = await insert('call_log', { direction: 'inbound', from_phone: phone, to_phone: BIZ, customer_id: known ? customer.id : null, status: 'no-answer', twilio_call_sid: sid('CAI'), created_at: t0 });
        return bell({ category: 'voicemail_callback', created_at: mins(t0, 3),
          metadata: { triggerKey: 'customer_voicemail_callback', payload: { callLogId: call.id, customerId: known ? customer.id : null, phone } } });
      };
      const textRow = await voicemailFor(a, shared);
      const callRow = await voicemailFor(a, shared);
      const unknownRow = await voicemailFor(a, shared, { known: false });
      // B's text and B's call back do not close A's bells.
      await staffText(b, shared, mins(t0, 10));
      await staffCall(b, shared, mins(t0, 12));
      await sweep();
      expect((await get(textRow.id)).done_at).toBeNull();
      expect((await get(callRow.id)).done_at).toBeNull();
      // An unknown caller (no customer id on the bell) is named by the phone: B's text is the only thing known about the number.
      expect(await get(unknownRow.id)).toMatchObject({ done_by: 'relevance', resolution: 'A person called back' });
      // A text to the number that carries no customer id names the phone; and a text to A by id names A.
      await staffText(null, shared, mins(t0, 20));
      await sweep();
      expect(await get(textRow.id)).toMatchObject({ done_by: 'relevance', resolution: 'Answered by text' });
      expect((await get(callRow.id)).done_by).toBe('relevance');
      const own = await customerWith('+15555558082');
      const ownRow = await voicemailFor(own, own.phone);
      await staffText(own, own.phone, mins(t0, 10));
      await sweep();
      expect(await get(ownRow.id)).toMatchObject({ done_by: 'relevance', resolution: 'Answered by text' });
    });

    test('a text on a SHARED phone is judged only by this customer\'s own evidence: the Messages reader\'s phone-level verdict is not used (a reply to B, even one still "sent", leaves A open; a reply to A, sent or delivered, closes A)', async () => {
      gate('true');
      const t0 = mins(new Date(), -240);
      // Two customers rows on one number.
      const shared = '+15555558083';
      const a = await customerWith(shared);
      const b = await customerWith(shared);
      const crossed = await text({ customer: a, phone: shared, at: t0 });
      await staffText(b, shared, mins(t0, 10), { status: 'sent' });
      await sweep();
      expect((await get(crossed.row.id)).done_at).toBeNull();
      await staffText(b, shared, mins(t0, 11));
      await staffCall(b, shared, mins(t0, 12));
      await sweep();
      expect((await get(crossed.row.id)).done_at).toBeNull();
      // A reply to A that is still "sent" answers A.
      await staffText(a, shared, mins(t0, 20), { status: 'sent' });
      await sweep();
      expect(await get(crossed.row.id)).toMatchObject({ done_by: 'relevance', resolution: 'Answered by text' });

      // A delivered reply, and a person's call with A, also answer A.
      const a2 = await customerWith('+15555558084');
      const b2 = await customerWith('+15555558084');
      const a3 = await customerWith('+15555558085');
      const b3 = await customerWith('+15555558085');
      const delivered = await text({ customer: a2, phone: a2.phone, at: t0 });
      const called = await text({ customer: a3, phone: a3.phone, at: t0 });
      const waiting = await text({ customer: b3, phone: b3.phone, at: t0 });
      await staffText(a2, a2.phone, mins(t0, 10));
      await staffCall(a3, a3.phone, mins(t0, 10));
      await sweep();
      expect(await get(delivered.row.id)).toMatchObject({ done_by: 'relevance', resolution: 'Answered by text' });
      expect(await get(called.row.id)).toMatchObject({ done_by: 'relevance', resolution: 'Answered by a call' });
      // The call was with A: B's thread on the same number is not answered by it.
      expect((await get(waiting.row.id)).done_at).toBeNull();
      expect(b2.id).not.toBe(a2.id);
    });

    test('a phone is shared by what is tied to it, not only by customers rows: a text or call row carrying another customer id ties them; an unshared phone keeps the reader\'s verdict (a courtesy text still closes)', async () => {
      gate('true');
      const t0 = mins(new Date(), -240);
      const a = await customerWith('+15555558086');
      const other = await customerWith('+15555558087');
      // One earlier text on A's number filed under another customer ties the two.
      await staffText(other, a.phone, mins(t0, -600));
      const tiedBell = await text({ customer: a, phone: a.phone, at: t0 });
      // A reply with no customer id on a shared phone is not this customer's own evidence.
      await staffText(null, a.phone, mins(t0, 10));
      await sweep();
      expect((await get(tiedBell.row.id)).done_at).toBeNull();

      // An unshared phone, a courtesy text after a note that asked nothing: as before.
      const alone = await customerWith('+15555558088');
      await insert('sms_log', { direction: 'outbound', from_phone: BIZ, to_phone: alone.phone, customer_id: alone.id, message_body: 'Your visit is complete.',
        message_type: 'service_complete', status: 'delivered', twilio_sid: sid('SMO'), created_at: mins(t0, -60) });
      const courtesy = await text({ customer: alone, phone: alone.phone, at: t0, body: 'Thank you!' });
      await sweep();
      expect(await get(courtesy.row.id)).toMatchObject({ done_by: 'relevance', resolution: 'Answered, or no reply needed' });
    });

    test('an unknown sender on a shared phone is never judged either: no reply, with or without a customer id, closes it', async () => {
      gate('true');
      const t0 = mins(new Date(), -240);
      const phone = '+15555558089';
      const c1 = await customerWith(phone);
      await customerWith(phone);
      const unknown = await text({ phone, at: t0, known: false });
      await staffText(c1, phone, mins(t0, 10));
      await staffText(null, phone, mins(t0, 20), { status: 'sent' });
      await sweep();
      expect((await get(unknown.row.id)).done_at).toBeNull();
    });

    test('an email from a customer: a person\'s reply in its thread closes it; a forward to someone else, a reply on another thread and an earlier reply do not', async () => {
      gate('true');
      const t0 = mins(new Date(), -300);
      const mail = async (key, extra = {}) => {
        const customer = await customerWith(`+1555555803${key}`, { email: `contact${key}-${Date.now()}@example.invalid` });
        const thread = sid('TH');
        const inbound = await insert('emails', { gmail_id: sid('GM'), gmail_thread_id: thread, from_address: customer.email, to_address: 'office@waves.example.invalid',
          cc_address: '', bcc_address: '', label_ids: JSON.stringify(['INBOX']), received_at: t0, customer_id: customer.id, ...extra });
        const row = await bell({ category: 'inbound_email', created_at: mins(t0, 2), link: `/admin/email?id=${inbound.id}`,
          metadata: { triggerKey: 'customer_email_received', payload: { emailId: inbound.id, customerId: customer.id, fromName: 'Contact' } } });
        return { customer, thread, row };
      };
      const sent = (m, at, to = null) => insert('emails', { gmail_id: sid('GM'), gmail_thread_id: m.thread, from_address: 'office@waves.example.invalid',
        to_address: to || m.customer.email, cc_address: '', bcc_address: '', label_ids: JSON.stringify(['SENT']), received_at: at });
      const replied = await mail('1');
      const forwarded = await mail('2');
      const elsewhere = await mail('3');
      const earlier = await mail('4');
      const textOnly = await mail('5');
      await sent(replied, mins(t0, 30));
      await sent(forwarded, mins(t0, 30), 'someone-else@example.invalid');
      await sent({ ...elsewhere, thread: sid('TH') }, mins(t0, 30));
      await sent(earlier, mins(t0, -30));
      await staffText(textOnly.customer, textOnly.customer.phone, mins(t0, 20));
      await sweep();
      expect(await get(replied.row.id)).toMatchObject({ done_by: 'relevance', resolution: 'Answered by email' });
      expect(await get(textOnly.row.id)).toMatchObject({ done_by: 'relevance', resolution: 'Answered by text' });
      for (const open of [forwarded, elsewhere, earlier]) expect((await get(open.row.id)).done_at).toBeNull();
    });

    test('a new lead: a person\'s text or call back after the bell closes it as contacted; contact from before the bell and a ring-out do not; shadow only records', async () => {
      const bellAt = mins(new Date(), -240);
      const lead = async (phone, withCustomer = true) => {
        const customer = withCustomer ? await customerWith(phone) : null;
        const row = await insert('leads', { first_name: 'Lead', phone, status: 'new', customer_id: customer?.id || null });
        const note = await bell({ category: 'new_lead', link: `/admin/leads?lead=${row.id}`, created_at: bellAt,
          metadata: { triggerKey: 'new_lead', payload: { leadId: row.id } } });
        return { customer, phone, note };
      };
      const texted = await lead('+15555558041');
      const called = await lead('+15555558042');
      const phoneOnly = await lead('+15555558043', false);
      const earlier = await lead('+15555558044');
      const ringOut = await lead('+15555558045');
      await staffText(texted.customer, texted.phone, mins(bellAt, 20));
      await staffCall(called.customer, called.phone, mins(bellAt, 20));
      await staffText(null, phoneOnly.phone, mins(bellAt, 20));
      await staffText(earlier.customer, earlier.phone, mins(bellAt, -60));
      await staffCall(ringOut.customer, ringOut.phone, mins(bellAt, 20), { v2_extraction_status: null, ai_extraction_enriched: null });

      gate('shadow');
      await sweep();
      expect((await get(texted.note.id)).done_at).toBeNull();
      expect(await wouldClose(texted.note.id)).toHaveLength(1);
      expect((await wouldClose(texted.note.id))[0].metadata).toMatchObject({ class: 'new_lead', reason: 'Lead was contacted' });

      gate('true');
      await sweep();
      for (const closed of [texted, called, phoneOnly]) {
        expect(await get(closed.note.id)).toMatchObject({ done_by: 'relevance', resolution: 'Lead was contacted' });
      }
      for (const open of [earlier, ringOut]) expect((await get(open.note.id)).done_at).toBeNull();
    });

    test('a voicemail callback request closes once the customer\'s own visit completed after the voicemail on the same ET day (GATE_VOICEMAIL_VISIT_UNDERWAY); the next ET day, before the voicemail, a visit that never ran, another customer\'s (even on the same phone) and an earlier-day voicemail do not', async () => {
      gate('true');
      const WENT_AHEAD = "The customer's visit went ahead after the call";
      // 10:20 AM Eastern (EDT) on 2026-10-26; the call row is the voicemail's start.
      const vmAt = new Date('2026-10-26T14:20:00Z');
      let phoneN = 8101;
      const voicemailFor = async (customer, phone, at = vmAt) => {
        const call = await insert('call_log', { direction: 'inbound', from_phone: phone, to_phone: BIZ, customer_id: customer.id, status: 'no-answer', twilio_call_sid: sid('CAI'), created_at: at });
        return bell({ category: 'voicemail_callback', created_at: mins(at, 1),
          metadata: { triggerKey: 'customer_voicemail_callback', payload: { callLogId: call.id, customerId: customer.id, phone, name: 'Caller' } } });
      };
      const visitFor = (customer, completedAt, status = 'completed') => insert('scheduled_services', { customer_id: customer.id, scheduled_date: '2026-10-26',
        service_type: 'General Pest Control', status, completed_at: completedAt, created_at: mins(vmAt, -60 * 24 * 7) });
      const mk = async (completedAt, { status, at } = {}) => {
        const phone = `+1555555${phoneN += 1}`;
        const customer = await customerWith(phone);
        const row = await voicemailFor(customer, phone, at);
        if (completedAt) await visitFor(customer, completedAt, status);
        return { customer, phone, row };
      };
      const sameDay = await mk(mins(vmAt, 30));
      const nextDay = await mk(new Date('2026-10-27T14:50:00Z'));
      const beforeCall = await mk(mins(vmAt, -10));
      const cancelled = await mk(mins(vmAt, 30), { status: 'cancelled' });
      const noShow = await mk(mins(vmAt, 30), { status: 'no_show' });
      const noVisit = await mk(null);
      // 11:50 PM Eastern, the visit completed at 12:10 AM Eastern the next day: not the same ET day.
      const overMidnight = await mk(new Date('2026-10-27T04:10:00Z'), { at: new Date('2026-10-27T03:50:00Z') });
      // Another customer's completed visit, and one for a different customer on the very same phone: by customer id only.
      const other = await mk(null);
      await visitFor(await customerWith('+15555558190'), mins(vmAt, 30));
      const sharedPhone = await mk(null);
      await visitFor(await customerWith(sharedPhone.phone), mins(vmAt, 30));
      const positives = [sameDay];
      const stays = [nextDay, beforeCall, cancelled, noShow, noVisit, overMidnight, other, sharedPhone];

      // Off: the reason is not offered, nothing is recorded.
      await sweep();
      for (const c of [...positives, ...stays]) expect((await get(c.row.id)).done_at).toBeNull();
      expect(await wouldClose(sameDay.row.id)).toHaveLength(0);
      // Shadow: only what WOULD close is recorded, and no bell changes (the contact gate being true does not matter).
      process.env.GATE_VOICEMAIL_VISIT_UNDERWAY = 'shadow';
      await sweep();
      for (const c of [...positives, ...stays]) expect((await get(c.row.id)).done_at).toBeNull();
      expect((await wouldClose(sameDay.row.id)).map((r) => r.metadata)).toEqual([expect.objectContaining({ class: 'voicemail_callback', reason: WENT_AHEAD })]);
      for (const c of stays) expect(await wouldClose(c.row.id)).toHaveLength(0);
      // True: closes the one, with the wording.
      process.env.GATE_VOICEMAIL_VISIT_UNDERWAY = 'true';
      await sweep();
      expect(await get(sameDay.row.id)).toMatchObject({ done_by: 'relevance', resolution: WENT_AHEAD });
      for (const c of stays) expect((await get(c.row.id)).done_at).toBeNull();
      // Rollback: the gate off puts the bell back, unread.
      delete process.env.GATE_VOICEMAIL_VISIT_UNDERWAY;
      expect((await sweep()).rearmed).toBeGreaterThanOrEqual(1);
      const back = await get(sameDay.row.id);
      expect([back.read_at, back.done_at, back.done_by]).toEqual([null, null, null]);
      expect(back.metadata.retired).toBeUndefined();
    }, 30000);

    test('a voicemail callback request: a person\'s contact outranks the visit wording, and an email bell never closes on the visit', async () => {
      gate('true');
      process.env.GATE_VOICEMAIL_VISIT_UNDERWAY = 'true';
      const vmAt = new Date('2026-10-26T14:20:00Z');
      const customer = await customerWith('+15555558191', { email: `visit-${Date.now()}@example.invalid` });
      const call = await insert('call_log', { direction: 'inbound', from_phone: customer.phone, to_phone: BIZ, customer_id: customer.id, status: 'no-answer', twilio_call_sid: sid('CAI'), created_at: vmAt });
      const row = await bell({ category: 'voicemail_callback', created_at: mins(vmAt, 1),
        metadata: { triggerKey: 'customer_voicemail_callback', payload: { callLogId: call.id, customerId: customer.id, phone: customer.phone } } });
      const inbound = await insert('emails', { gmail_id: sid('GM'), gmail_thread_id: sid('TH'), from_address: customer.email, to_address: 'office@waves.example.invalid',
        cc_address: '', bcc_address: '', label_ids: JSON.stringify(['INBOX']), received_at: vmAt, customer_id: customer.id });
      const mail = await bell({ category: 'inbound_email', created_at: mins(vmAt, 2), link: `/admin/email?id=${inbound.id}`,
        metadata: { triggerKey: 'customer_email_received', payload: { emailId: inbound.id, customerId: customer.id } } });
      await insert('scheduled_services', { customer_id: customer.id, scheduled_date: '2026-10-26', service_type: 'General Pest Control', status: 'completed', completed_at: mins(vmAt, 30),
        created_at: mins(vmAt, -60 * 24 * 7) });
      await sweep();
      expect(await get(row.id)).toMatchObject({ done_by: 'relevance', resolution: "The customer's visit went ahead after the call" });
      expect((await get(mail.id)).done_at).toBeNull();
      // A person's text to them after the call is named first.
      await db('notifications').where({ id: row.id }).update({ done_at: null, done_by: null, resolution: null, read_at: null, metadata: JSON.stringify({ triggerKey: 'customer_voicemail_callback', payload: { callLogId: call.id, customerId: customer.id, phone: customer.phone } }) });
      await staffText(customer, customer.phone, mins(vmAt, 20));
      await sweep();
      expect(await get(row.id)).toMatchObject({ done_by: 'relevance', resolution: 'Answered by text' });
    }, 30000);

    test('lead_contacted Leads bells (GATE_LEAD_CONTACTED_CLOSE, its own gate): a person\'s text or call back, a live visit booked, or an estimate handed off AFTER the bell closes it; earlier facts, sent_at alone, a visit that did not run and a bid-invite Leads bell do not', async () => {
      const bellAt = mins(new Date(), -240);
      const after = mins(bellAt, 60);
      const delivered = (at) => JSON.stringify({ deliveryState: { firstDeliveredAt: at.toISOString(), lastDeliveredAt: at.toISOString() } });
      let phoneN = 8201;
      const leadBell = async ({ doneWhen = 'lead_contacted', dedupeKey } = {}) => {
        const phone = `+1555555${phoneN += 1}`;
        const customer = await customerWith(phone);
        const lead = await insert('leads', { first_name: 'Lead', phone, status: 'new', customer_id: customer.id });
        const row = await bell({ category: 'lead', link: `/admin/leads?lead=${lead.id}`, created_at: bellAt,
          metadata: { dedupeKey: dedupeKey ? dedupeKey(lead) : `sms-lead:${lead.id}`, doneWhen, leadId: lead.id, customerId: customer.id, source: 'sms_lead_extraction' } });
        return { customer, phone, lead, row };
      };
      const visit = (c, status, createdAt) => insert('scheduled_services', { customer_id: c.customer.id, scheduled_date: etDateString(new Date(Date.now() + 7 * DAY)),
        service_type: 'General Pest Control', status, created_at: createdAt });
      const texted = await leadBell();
      const called = await leadBell({ dedupeKey: (l) => `lead-call-text-followup:${l.id}` });
      const booked = await leadBell({ dedupeKey: (l) => `lead-unverified-hold:${l.id}` });
      const quoted = await leadBell({ dedupeKey: (l) => `lead-call-reply-missed:${l.id}` });
      const earlier = await leadBell();
      const suppressed = await leadBell();
      const noShow = await leadBell();
      const bid = await leadBell({ doneWhen: 'bid_decided', dedupeKey: (l) => `bid-invite:${l.id}` });
      await staffText(texted.customer, texted.phone, after);
      await staffCall(called.customer, called.phone, after);
      await visit(booked, 'confirmed', after);
      await insert('estimates', { status: 'accepted', customer_id: quoted.customer.id, estimate_data: delivered(after) });
      // Everything from BEFORE the bell.
      await staffText(earlier.customer, earlier.phone, mins(bellAt, -60));
      await visit(earlier, 'confirmed', mins(bellAt, -60));
      await insert('estimates', { status: 'sent', customer_id: earlier.customer.id, sent_at: mins(bellAt, -60), estimate_data: delivered(mins(bellAt, -60)) });
      // A suppressed send (sent_at stamped, nothing delivered), and a visit booked after the bell that never ran.
      await insert('estimates', { status: 'sent', customer_id: suppressed.customer.id, sent_at: after });
      await visit(noShow, 'no_show', after);
      // A bid-invite Leads bell for a lead a person texted: not this class.
      await staffText(bid.customer, bid.phone, after);
      const closes = [texted, called, booked, quoted];
      const stays = [earlier, suppressed, noShow, bid];

      // Off (the contact gate is off too): nothing judged, nothing recorded.
      await sweep();
      for (const c of [...closes, ...stays]) { expect((await get(c.row.id)).done_at).toBeNull(); expect(await wouldClose(c.row.id)).toHaveLength(0); }
      // Shadow: the would-close rows only, with each reason; no bell changes.
      process.env.GATE_LEAD_CONTACTED_CLOSE = 'shadow';
      await sweep();
      for (const c of [...closes, ...stays]) expect((await get(c.row.id)).done_at).toBeNull();
      const wouldReason = async (c) => (await wouldClose(c.row.id)).map((r) => [r.metadata.class, r.metadata.reason]);
      expect(await wouldReason(texted)).toEqual([['lead_contacted', 'Lead was contacted']]);
      expect(await wouldReason(called)).toEqual([['lead_contacted', 'Lead was contacted']]);
      expect(await wouldReason(booked)).toEqual([['lead_contacted', 'A visit was booked']]);
      expect(await wouldReason(quoted)).toEqual([['lead_contacted', 'Estimate was sent']]);
      for (const c of stays) expect(await wouldClose(c.row.id)).toHaveLength(0);
      // True: closes the four, with their reasons.
      process.env.GATE_LEAD_CONTACTED_CLOSE = 'true';
      await sweep();
      const state = async (c) => { const r = await get(c.row.id); return r.done_at ? [r.done_by, r.resolution] : null; };
      expect(await state(texted)).toEqual(['relevance', 'Lead was contacted']);
      expect(await state(called)).toEqual(['relevance', 'Lead was contacted']);
      expect(await state(booked)).toEqual(['relevance', 'A visit was booked']);
      expect(await state(quoted)).toEqual(['relevance', 'Estimate was sent']);
      for (const c of stays) expect(await state(c)).toBeNull();
      // Rollback: the gate off puts back what it closed.
      delete process.env.GATE_LEAD_CONTACTED_CLOSE;
      expect((await sweep()).rearmed).toBeGreaterThanOrEqual(4);
      for (const c of closes) {
        const back = await get(c.row.id);
        expect([back.done_at, back.done_by]).toEqual([null, null]);
        expect(back.metadata.retired).toBeUndefined();
      }
    }, 30000);

    test('lead_contacted: a bell refreshed with new content (rungAt) is judged from that refresh — a reply, a booking or an estimate handoff between the first ring and the refresh never closes it; the same facts after the refresh do', async () => {
      process.env.GATE_LEAD_CONTACTED_CLOSE = 'true';
      const now = new Date();
      const bellAt = mins(now, -300); // first ring (created_at is kept by a refresh without bumpOnRefresh)
      const early = mins(now, -200); // T1: after the first ring, before the refresh
      const rungAt = mins(now, -120); // T2: the refresh with new content
      const late = mins(now, -60); // after T2
      const delivered = (at) => JSON.stringify({ deliveryState: { firstDeliveredAt: at.toISOString(), lastDeliveredAt: at.toISOString() } });
      let phoneN = 8301;
      const leadBell = async (withRefresh = true) => {
        const phone = `+1555555${phoneN += 1}`;
        const customer = await customerWith(phone);
        const lead = await insert('leads', { first_name: 'Lead', phone, status: 'new', customer_id: customer.id });
        const row = await bell({ category: 'lead', link: `/admin/leads?lead=${lead.id}`, created_at: bellAt,
          metadata: { dedupeKey: `sms-lead:${lead.id}`, doneWhen: 'lead_contacted', leadId: lead.id, customerId: customer.id, ...(withRefresh ? { rungAt: rungAt.toISOString() } : {}) } });
        return { customer, phone, lead, row };
      };
      const visit = (c, createdAt) => insert('scheduled_services', { customer_id: c.customer.id, scheduled_date: etDateString(new Date(Date.now() + 7 * DAY)),
        service_type: 'General Pest Control', status: 'confirmed', created_at: createdAt });
      const estimate = (c, at) => insert('estimates', { status: 'accepted', customer_id: c.customer.id, estimate_data: delivered(at) });
      const facts = { text: (c, at) => staffText(c.customer, c.phone, at), visit, estimate };
      const reasons = { text: 'Lead was contacted', visit: 'A visit was booked', estimate: 'Estimate was sent' };
      const cases = {};
      for (const kind of Object.keys(facts)) {
        cases[kind] = { earlyOnly: await leadBell(), afterRefresh: await leadBell() };
        await facts[kind](cases[kind].earlyOnly, early);
        await facts[kind](cases[kind].afterRefresh, early);
        await facts[kind](cases[kind].afterRefresh, late);
      }
      // Control: the same early reply on a bell that was never refreshed does close it.
      const never = await leadBell(false);
      await staffText(never.customer, never.phone, early);

      await sweep();
      const state = async (c) => { const r = await get(c.row.id); return r.done_at ? [r.done_by, r.resolution] : null; };
      for (const kind of Object.keys(facts)) {
        expect(await state(cases[kind].earlyOnly)).toBeNull();
        expect(await state(cases[kind].afterRefresh)).toEqual(['relevance', reasons[kind]]);
      }
      expect(await state(never)).toEqual(['relevance', 'Lead was contacted']);
    }, 30000);

    test('rollback: gate off puts back, unread, what the contact classes closed in the window', async () => {
      const t0 = mins(new Date(), -120);
      const customer = await customerWith('+15555558051');
      const { row } = await text({ customer, phone: customer.phone, at: t0 });
      await staffText(customer, customer.phone, mins(t0, 5));
      gate('true');
      await sweep();
      expect((await get(row.id)).done_by).toBe('relevance');
      delete process.env.GATE_ALERT_CONTACT_CLOSE;
      const result = await sweep();
      expect(result.rearmed).toBeGreaterThanOrEqual(1);
      const back = await get(row.id);
      expect([back.read_at, back.done_at, back.done_by]).toEqual([null, null, null]);
      expect(back.metadata.retired).toBeUndefined();
    });
  });
});

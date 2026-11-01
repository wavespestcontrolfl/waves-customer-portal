/**
 * Portal items against live Postgres, the SQL as the sweep runs it:
 *   GATE_PORTAL_ITEM_CLOSE: a portal request bell and an add-service request bell close the way chat items do
 *     (a person's contact after the bell; an estimate handed to the customer after the bell), and the request
 *     row behind a closed bell resolves quietly. The shared witnesses decide what counts as contact: an
 *     automated text, a text from before the bell and a text to someone else do not.
 *   GATE_PORTAL_LATE_RERING: an open portal item bell past its one business hour with no contact since is
 *     rung once more on the same row, never twice, never for an old ask, never over a reply.
 * The rules themselves are covered by admin-alert-relevance.test.js and portal-late-rering.test.js.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

const MIN = 60 * 1000;

maybeDescribe('portal item close and late re-ring (live Postgres)', () => {
  let db;
  let relevance;
  let portalInbox;
  const made = { notifications: [], sms_log: [], call_log: [], emails: [], estimates: [], service_requests: [], customers: [] };
  const BIZ = '+15555559100';
  let n = 0;
  let phoneN = 9100;
  const sid = (prefix) => `${prefix}${String(Date.now()).slice(-8)}${String((n += 1)).padStart(6, '0')}`;
  const mins = (base, m) => new Date(base.getTime() + m * MIN);

  beforeAll(() => {
    db = require('../models/db');
    relevance = require('../services/admin-alert-relevance');
    portalInbox = require('../services/portal-inbox');
  });
  afterEach(() => {
    for (const key of ['GATE_ALERT_CONTACT_CLOSE', 'GATE_PORTAL_ITEM_CLOSE', 'GATE_PORTAL_LATE_RERING', 'GATE_PORTAL_CHAT_ANSWERED_CLOSE', 'GATE_PORTAL_INBOX']) delete process.env[key];
  });
  afterAll(async () => {
    for (const table of ['notifications', 'sms_log', 'call_log', 'emails', 'estimates', 'service_requests', 'customers']) {
      if (made[table].length) await db(table).whereIn('id', made[table]).del();
    }
    await db.destroy();
  }, 120000);

  const insert = async (table, row) => {
    const [r] = await db(table).insert(row).returning('*');
    made[table].push(r.id);
    return r;
  };
  const bell = (row) => insert('notifications', { recipient_type: 'admin', title: 'Fixture alert', body: 'Pat asked about adding a service', ...row, metadata: JSON.stringify(row.metadata) });
  const get = (id) => db('notifications').where({ id }).first();
  const getRequest = (id) => db('service_requests').where({ id }).first();
  const sweep = (now = new Date()) => relevance.runAdminAlertRelevanceSweep({ now });
  const customerWith = () => insert('customers', { first_name: 'Portal', phone: `+1555555${phoneN += 1}`, email: `portal${phoneN}-${Date.now()}@example.invalid` });
  const staffText = (customer, at, over = {}) => insert('sms_log', { direction: 'outbound', from_phone: BIZ, to_phone: customer.phone, customer_id: customer.id,
    message_body: 'Yes, we can help with that.', message_type: 'manual', status: 'delivered', twilio_sid: sid('SMO'), metadata: JSON.stringify({ human_authored: true }), created_at: at, ...over });
  // A text the system sent on its own (a reminder): no person wrote it, so it answers nothing.
  const automatedText = (customer, at) => staffText(customer, at, { message_type: 'appointment_reminder', metadata: JSON.stringify({}) });
  const delivered = (at) => JSON.stringify({ deliveryState: { firstDeliveredAt: at.toISOString(), lastDeliveredAt: at.toISOString() } });
  const requestRow = (customer, over = {}) => insert('service_requests', { customer_id: customer.id, category: 'general', subject: 'Fixture request', description: 'Please call', status: 'new', ...over });
  const state = async (b) => { const r = await get(b.id); return r.done_at ? [r.done_by, r.resolution] : null; };

  // The bell POST /api/requests raises.
  const requestBell = (customer, request, at, over = {}) => bell({ category: 'service', link: `/admin/customers?customerId=${customer.id}`, created_at: at,
    metadata: { area: 'Customers', doneWhen: 'request_answered', requestId: request.id, customerId: customer.id, ...over } });
  // The add-service bell (gate on): trigger fields under payload, the request id and customer on top.
  const bundleBell = (customer, request, at, over = {}) => bell({ category: 'estimate', link: `/admin/customers?customerId=${customer.id}`, created_at: at,
    metadata: { triggerKey: 'bundle_quote_requested', priority: 'high', requestId: request.id, customerId: customer.id, payload: { customerId: customer.id, requestId: request.id, bundled: false }, ...over } });
  const chatBell = (customer, at, over = {}) => {
    const id = sid('ESC');
    return bell({ category: 'alert', link: `/admin/customers?customerId=${customer.id}`, created_at: at,
      metadata: { dedupeKey: `portal-chat-escalation:${id}`, doneWhen: 'customer_answered', customerId: customer.id, escalationId: id, conversationId: id, ...over } });
  };

  describe('GATE_PORTAL_ITEM_CLOSE', () => {
    const on = () => { process.env.GATE_ALERT_CONTACT_CLOSE = 'true'; process.env.GATE_PORTAL_ITEM_CLOSE = 'true'; };

    test('a request bell closes on a person\'s text after it and its request resolves quietly; an automated text, a text before the bell, a text to someone else and a cancellation bell do not', async () => {
      const now = new Date();
      const bellAt = mins(now, -300);
      const answered = await customerWith();
      const automated = await customerWith();
      const early = await customerWith();
      const elsewhere = await customerWith();
      const stranger = await customerWith();
      const cases = {};
      for (const [key, customer] of Object.entries({ answered, automated, early, elsewhere })) {
        const request = await requestRow(customer);
        cases[key] = { customer, request, bell: await requestBell(customer, request, bellAt) };
      }
      const cancelRequest = await requestRow(answered, { category: 'cancellation' });
      const cancel = await requestBell(answered, cancelRequest, bellAt, { doneWhen: 'cancellation_reviewed' });
      await staffText(answered, mins(bellAt, 20));
      await automatedText(automated, mins(bellAt, 20));
      await staffText(early, mins(bellAt, -20));
      await staffText(stranger, mins(bellAt, 20)); // a person's text, to someone else

      // Gate off: nothing closes and nothing resolves.
      process.env.GATE_ALERT_CONTACT_CLOSE = 'true';
      await sweep(now);
      for (const c of Object.values(cases)) expect(await state(c.bell)).toBeNull();
      expect((await getRequest(cases.answered.request.id)).status).toBe('new');

      on();
      await sweep(now);
      expect(await state(cases.answered.bell)).toEqual(['relevance', 'Answered by text']);
      const resolved = await getRequest(cases.answered.request.id);
      expect(resolved).toMatchObject({ status: 'resolved', status_version: 1 });
      expect(resolved.resolved_at).toBeInstanceOf(Date);
      expect(resolved.admin_notes).toBe('Answered by text');
      for (const key of ['automated', 'early', 'elsewhere']) {
        expect(await state(cases[key].bell)).toBeNull();
        expect((await getRequest(cases[key].request.id)).status).toBe('new');
      }
      // The cancellation bell for the same, answered customer is never judged.
      expect(await state(cancel)).toBeNull();
      expect((await getRequest(cancelRequest.id)).status).toBe('new');

      // Rollback: the gate off puts the bell back; the request row stays resolved.
      delete process.env.GATE_PORTAL_ITEM_CLOSE;
      await sweep(now);
      expect(await state(cases.answered.bell)).toBeNull();
      expect((await getRequest(cases.answered.request.id)).status).toBe('resolved');
    }, 60000);

    test('a request already resolved by staff keeps its time and notes when its bell closes later', async () => {
      const now = new Date();
      const bellAt = mins(now, -300);
      const customer = await customerWith();
      const resolvedAt = mins(now, -100);
      const request = await requestRow(customer, { status: 'resolved', resolved_at: resolvedAt, admin_notes: 'Handled on the phone' });
      const b = await requestBell(customer, request, bellAt);
      await staffText(customer, mins(bellAt, 20));
      on();
      await sweep(now);
      expect(await state(b)).toEqual(['relevance', 'Answered by text']);
      const row = await getRequest(request.id);
      expect([row.status, row.admin_notes, row.resolved_at.getTime(), row.status_version]).toEqual(['resolved', 'Handled on the phone', resolvedAt.getTime(), 0]);
    }, 30000);

    test('an add-service bell closes when an estimate was handed to its customer after it ("Estimate sent"), never on contact alone, an earlier delivery or another customer\'s estimate; Mark handled closes it once the request id is on top', async () => {
      const now = new Date();
      const bellAt = mins(now, -300);
      const customer = await customerWith();
      const other = await customerWith();
      const request = await requestRow(customer, { category: 'add_service', requested_service: 'mosquito', source: 'portal_home' });
      const asked = await bundleBell(customer, request, bellAt);
      // Raised before the gate: the request id is only under payload, so Mark handled cannot find it.
      const nested = await bell({ category: 'estimate', created_at: bellAt,
        metadata: { triggerKey: 'bundle_quote_requested', payload: { customerId: customer.id, requestId: request.id } } });
      await staffText(customer, mins(bellAt, 10));
      await insert('estimates', { status: 'sent', customer_id: customer.id, sent_at: mins(bellAt, 20) }); // sent_at alone is no handoff
      await insert('estimates', { status: 'sent', customer_id: customer.id, sent_at: mins(bellAt, -60), estimate_data: delivered(mins(bellAt, -60)) });
      await insert('estimates', { status: 'sent', customer_id: other.id, sent_at: mins(bellAt, 20), estimate_data: delivered(mins(bellAt, 20)) });
      on();
      await sweep(now);
      expect(await state(asked)).toBeNull();
      expect(await state(nested)).toBeNull();
      expect((await getRequest(request.id)).status).toBe('new');

      await insert('estimates', { status: 'accepted', customer_id: customer.id, estimate_data: delivered(mins(bellAt, 30)) });
      await sweep(now);
      expect(await state(asked)).toEqual(['relevance', 'Estimate was sent']);
      const row = await getRequest(request.id);
      expect([row.status, row.admin_notes]).toEqual(['resolved', 'Estimate sent']);
      expect(await state(nested)).toBeNull();

      // Mark handled (GATE_PORTAL_INBOX) finds the bell by metadata->>'requestId' once it is on top, and not before.
      process.env.GATE_PORTAL_INBOX = 'true';
      const second = await requestRow(customer, { category: 'add_service', requested_service: 'lawn', source: 'service_report' });
      const fresh = await bundleBell(customer, second, mins(now, -10));
      const stale = await bell({ category: 'estimate', created_at: mins(now, -10),
        metadata: { triggerKey: 'bundle_quote_requested', payload: { customerId: customer.id, requestId: second.id } } });
      await portalInbox.closeRequestAlertsOnResolve({ id: second.id, status: 'resolved' }, true, { technicianId: 'tech-1', role: 'admin' });
      expect((await get(fresh.id)).done_at).toBeInstanceOf(Date);
      expect((await get(stale.id)).done_at).toBeNull();
    }, 60000);

    test('quiet resolve touches only an open request of that customer', async () => {
      const customer = await customerWith();
      const other = await customerWith();
      const open = await requestRow(customer);
      expect(await portalInbox.resolveRequestQuietly(open.id, other.id, 'wrong customer')).toBe(0);
      expect((await getRequest(open.id)).status).toBe('new');
      expect(await portalInbox.resolveRequestQuietly(open.id, customer.id, 'Answered by text')).toBe(1);
      expect(await portalInbox.resolveRequestQuietly(open.id, customer.id, 'again')).toBe(0);
      const row = await getRequest(open.id);
      expect([row.status, row.admin_notes]).toEqual(['resolved', 'Answered by text']);
      const noted = await requestRow(customer, { admin_notes: 'Called twice' });
      await portalInbox.resolveRequestQuietly(noted.id, customer.id, 'A person called back');
      expect((await getRequest(noted.id)).admin_notes).toBe('Called twice\nA person called back');
    });
  });

  describe('GATE_PORTAL_LATE_RERING', () => {
    // A weekday-independent ask at 15:00 UTC yesterday: 10:00 or 11:00 ET, so due one hour later at 16:00 UTC.
    const base = new Date();
    const ASK = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() - 1, 15, 0, 0));
    const BEFORE_DUE = mins(ASK, 50);
    const AFTER_DUE = mins(ASK, 70);
    const lateOn = () => { process.env.GATE_PORTAL_LATE_RERING = 'true'; };

    test('the due time is one business hour on the follow-up clock', () => {
      const { dueAtFor } = require('../services/portal-late-rering');
      expect(dueAtFor(ASK).getTime()).toBe(mins(ASK, 60).getTime());
    });

    test('an open item rings once more after its hour with no contact: same row, unread, on top, "Still waiting", stamped; never before the hour, never twice', async () => {
      const customer = await customerWith();
      const other = await customerWith();
      const chat = await chatBell(customer, ASK, { topic: 'complaint' });
      const asked = await requestBell(other, await requestRow(other), ASK);
      const addRequest = await requestRow(customer, { category: 'add_service', requested_service: 'mosquito', source: 'portal_home' });
      const bundle = await bundleBell(customer, addRequest, ASK);
      await db('notifications').whereIn('id', [chat.id, asked.id, bundle.id]).update({ read_at: mins(ASK, 5) });
      await automatedText(customer, mins(ASK, 10)); // an automated text is no reply

      // Gate off: nothing.
      await sweep(AFTER_DUE);
      for (const b of [chat, asked, bundle]) expect((await get(b.id)).metadata.lateReRungAt).toBeUndefined();

      lateOn();
      // Never before the hour.
      expect((await sweep(BEFORE_DUE)).lateReRung).toBeUndefined();
      for (const b of [chat, asked, bundle]) expect((await get(b.id)).metadata.lateReRungAt).toBeUndefined();

      const result = await sweep(AFTER_DUE);
      expect(result.lateReRung).toBe(3);
      for (const b of [chat, asked, bundle]) {
        const row = await get(b.id);
        expect(row.body.startsWith('Still waiting: no reply after 1 business hour')).toBe(true);
        expect(row.body).toContain('Pat asked about adding a service');
        expect(row.read_at).toBeNull();
        expect(row.done_at).toBeNull();
        expect(row.created_at.getTime()).toBeGreaterThan(AFTER_DUE.getTime());
        expect(row.metadata).toMatchObject({ contact: true, lateReRungAt: AFTER_DUE.toISOString(), rungAt: AFTER_DUE.toISOString() });
        // The bell is the same row: its identity metadata is intact.
        expect(row.metadata.customerId).toBe(b === asked ? other.id : customer.id);
      }

      // Never a second re-ring, even much later and after someone read it.
      const once = await get(chat.id);
      await db('notifications').where({ id: chat.id }).update({ read_at: new Date() });
      expect((await sweep(mins(AFTER_DUE, 120))).lateReRung).toBeUndefined();
      const again = await get(chat.id);
      expect([again.body, again.created_at.getTime(), JSON.stringify(again.metadata)]).toEqual([once.body, once.created_at.getTime(), JSON.stringify(once.metadata)]);
      expect(again.read_at).toBeInstanceOf(Date);
    }, 60000);

    test('a person\'s text or call after the ask stops it (even with every close gate off); a text from before the ask, a done bell, a stamped bell, an old ask and a cancellation bell are not rung', async () => {
      const replied = await customerWith();
      const called = await customerWith();
      const before = await customerWith();
      const closed = await customerWith();
      const stamped = await customerWith();
      const old = await customerWith();
      const estimateSent = await customerWith();
      const cancelled = await customerWith();
      const rows = {};
      for (const [key, customer] of Object.entries({ replied, called, before, closed, stamped, old, estimateSent })) {
        rows[key] = await chatBell(customer, key === 'old' ? mins(AFTER_DUE, -30 * 60) : ASK, key === 'estimateSent' ? { topic: 'add_service' } : {});
      }
      const cancelRequest = await requestRow(cancelled, { category: 'cancellation' });
      rows.cancelled = await requestBell(cancelled, cancelRequest, ASK, { doneWhen: 'cancellation_reviewed' });
      await staffText(replied, mins(ASK, 20));
      await insert('call_log', { direction: 'outbound', from_phone: BIZ, to_phone: called.phone, customer_id: called.id, status: 'completed', source: 'admin-click', duration_seconds: 180,
        v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: 'false' } }), twilio_call_sid: sid('CAO'), created_at: mins(ASK, 20) });
      await staffText(before, mins(ASK, -20));
      await insert('estimates', { status: 'accepted', customer_id: estimateSent.id, estimate_data: delivered(mins(ASK, 30)) });
      await db('notifications').where({ id: rows.closed.id }).update({ done_at: mins(ASK, 30), done_by: '1' });
      await db('notifications').where({ id: rows.stamped.id }).update({ metadata: JSON.stringify({ ...rows.stamped.metadata, lateReRungAt: mins(ASK, 61).toISOString() }) });

      lateOn();
      await sweep(AFTER_DUE);
      for (const key of ['replied', 'called', 'closed', 'old', 'estimateSent', 'cancelled']) expect((await get(rows[key].id)).body).not.toContain('Still waiting');
      expect((await get(rows.before.id)).body).toContain('Still waiting');
      expect((await get(rows.stamped.id)).body).not.toContain('Still waiting');
    }, 60000);

    test('the sweep closes a replied item first, so a bell the close gates closed is never rung "still waiting"', async () => {
      const customer = await customerWith();
      const request = await requestRow(customer);
      const b = await requestBell(customer, request, ASK);
      await staffText(customer, mins(ASK, 20));
      process.env.GATE_ALERT_CONTACT_CLOSE = 'true';
      process.env.GATE_PORTAL_ITEM_CLOSE = 'true';
      lateOn();
      await sweep(AFTER_DUE);
      expect(await state(b)).toEqual(['relevance', 'Answered by text']);
      expect((await get(b.id)).body).not.toContain('Still waiting');
    }, 30000);
  });
});

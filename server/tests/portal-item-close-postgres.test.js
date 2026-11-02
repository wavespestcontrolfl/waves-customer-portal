/**
 * Portal items against live Postgres, the SQL as the sweep runs it:
 *   GATE_PORTAL_ITEM_CLOSE: a portal request bell and an add-service request bell close the way chat items do
 *     (a person's contact after the bell; an estimate handed to the customer after the bell), and the request
 *     row behind a closed bell resolves quietly. The shared witnesses decide what counts as contact: an
 *     automated text, a text from before the bell and a text to someone else do not.
 *   GATE_PORTAL_LATE_RERING: an open portal item bell past its one business hour with no contact since is
 *     rung once more on the same row, never twice, never for an old ask, never over a reply.
 *   GATE_PORTAL_ESTIMATE_RERING: an open add-service request bell 2 business days old with no estimate for its
 *     service is rung once more whatever a person said, never twice, never for an old ask.
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
    for (const key of ['GATE_ALERT_CONTACT_CLOSE', 'GATE_PORTAL_ITEM_CLOSE', 'GATE_PORTAL_LATE_RERING', 'GATE_PORTAL_ESTIMATE_RERING', 'GATE_PORTAL_CHAT_ANSWERED_CLOSE', 'GATE_PORTAL_INBOX']) delete process.env[key];
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
  // A delivered estimate that prices one service (estimate-service-lines reads the estimator's svc* input flags).
  const deliveredFor = (at, flag = 'svcMosquito') => JSON.stringify({ deliveryState: { firstDeliveredAt: at.toISOString(), lastDeliveredAt: at.toISOString() }, inputs: { [flag]: true } });
  // Filed long before any bell in these tests (a request is written first, its bell after), untouched since.
  const FILED = new Date(Date.now() - 3 * 24 * 60 * MIN);
  const requestRow = (customer, over = {}) => insert('service_requests', { customer_id: customer.id, category: 'general', subject: 'Fixture request', description: 'Please call', status: 'new', created_at: FILED, updated_at: FILED, ...over });
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

      await insert('estimates', { status: 'accepted', customer_id: customer.id, estimate_data: deliveredFor(mins(bellAt, 30)) });
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

    test('an add-service request closes only on an estimate that prices its own service, or its own minted estimate; a request that names no service never closes on an estimate', async () => {
      const now = new Date();
      const bellAt = mins(now, -300);
      const mosquito = await customerWith();
      const unnamed = await customerWith();
      const minted = await customerWith();
      const mosquitoRequest = await requestRow(mosquito, { category: 'add_service', requested_service: 'mosquito', source: 'portal_home' });
      const mosquitoBell = await bundleBell(mosquito, mosquitoRequest, bellAt);
      const unnamedRequest = await requestRow(unnamed, { category: 'add_service', requested_service: 'not_stated', source: 'portal_chat' });
      const unnamedBell = await bundleBell(unnamed, unnamedRequest, bellAt);
      // Another service delivered after the ask: no answer to the mosquito ask, and never one to a request naming none.
      await insert('estimates', { status: 'accepted', customer_id: mosquito.id, estimate_data: deliveredFor(mins(bellAt, 20), 'svcPest') });
      for (const flag of ['svcMosquito', 'svcPest', 'svcLawn']) {
        await insert('estimates', { status: 'accepted', customer_id: unnamed.id, estimate_data: deliveredFor(mins(bellAt, 20), flag) });
      }
      // The request's own minted estimate answers it as made, though its lines name no service.
      const mintedEstimate = await insert('estimates', { status: 'accepted', customer_id: minted.id, estimate_data: delivered(mins(bellAt, 20)) });
      const mintedRequest = await requestRow(minted, { category: 'add_service', requested_service: 'lawn_care', source: 'service_report',
        pricing_revision: JSON.stringify({ mintedEstimate: { id: mintedEstimate.id } }) });
      const mintedBell = await bundleBell(minted, mintedRequest, bellAt);
      on();
      await sweep(now);
      expect(await state(mosquitoBell)).toBeNull();
      expect((await getRequest(mosquitoRequest.id)).status).toBe('new');
      expect(await state(unnamedBell)).toBeNull();
      expect((await getRequest(unnamedRequest.id)).status).toBe('new');
      expect(await state(mintedBell)).toEqual(['relevance', 'Estimate was sent']);
      expect((await getRequest(mintedRequest.id)).status).toBe('resolved');

      // The mosquito estimate arrives: now it is answered.
      await insert('estimates', { status: 'accepted', customer_id: mosquito.id, estimate_data: deliveredFor(mins(bellAt, 40)) });
      await sweep(now);
      expect(await state(mosquitoBell)).toEqual(['relevance', 'Estimate was sent']);
      expect((await getRequest(mosquitoRequest.id)).status).toBe('resolved');
      expect(await state(unnamedBell)).toBeNull();
    }, 60000);

    test('quiet resolve touches only an open request of that customer', async () => {
      const customer = await customerWith();
      const other = await customerWith();
      const open = await requestRow(customer);
      expect(await portalInbox.resolveRequestQuietly(open.id, other.id, 'wrong customer', { notAfter: new Date() })).toBe(0);
      expect((await getRequest(open.id)).status).toBe('new');
      expect(await portalInbox.resolveRequestQuietly(open.id, customer.id, 'Answered by text', { notAfter: new Date() })).toBe(1);
      expect(await portalInbox.resolveRequestQuietly(open.id, customer.id, 'again', { notAfter: new Date() })).toBe(0);
      const row = await getRequest(open.id);
      expect([row.status, row.admin_notes]).toEqual(['resolved', 'Answered by text']);
      const noted = await requestRow(customer, { admin_notes: 'Called twice' });
      await portalInbox.resolveRequestQuietly(noted.id, customer.id, 'A person called back', { notAfter: new Date() });
      expect((await getRequest(noted.id)).admin_notes).toBe('Called twice\nA person called back');
    });

    test('quiet resolve leaves a request a person already moved (a newer revision)', async () => {
      const customer = await customerWith();
      for (const status of ['acknowledged', 'scheduled']) {
        const moved = await requestRow(customer, { status });
        expect(await portalInbox.resolveRequestQuietly(moved.id, customer.id, 'Answered by text', { notAfter: new Date() })).toBe(0);
        expect((await getRequest(moved.id)).status).toBe(status);
      }
    });
    test('quiet resolve refuses a request touched after the ask (a refreshed offer is a newer revision), and a call with no boundary writes nothing', async () => {
      const customer = await customerWith();
      const ask = mins(new Date(), -300);
      const untouched = await requestRow(customer, { updated_at: mins(ask, -1) });
      const refreshed = await requestRow(customer, { updated_at: mins(ask, 60) });
      expect(await portalInbox.resolveRequestQuietly(refreshed.id, customer.id, 'Estimate sent', { notAfter: ask })).toBe(0);
      expect(await portalInbox.resolveRequestQuietly(untouched.id, customer.id, 'Estimate sent')).toBe(0);
      expect(await portalInbox.resolveRequestQuietly(untouched.id, customer.id, 'Estimate sent', { notAfter: 'not a date' })).toBe(0);
      expect([(await getRequest(refreshed.id)).status, (await getRequest(untouched.id)).status]).toEqual(['new', 'new']);
      expect(await portalInbox.resolveRequestQuietly(untouched.id, customer.id, 'Estimate sent', { notAfter: ask })).toBe(1);
    });

    test('a request refreshed after the ask: the old bell closes on the estimate delivered before the refresh, the refreshed request stays new; the refresh\'s own bell is judged on its own', async () => {
      const now = new Date();
      const askAt = mins(now, -300);
      const refreshAt = mins(askAt, 120);
      const customer = await customerWith();
      // The shared CTA writer refreshed this same request id (new snapshot, updated_at bumped, status still new).
      const request = await requestRow(customer, { category: 'add_service', requested_service: 'mosquito', source: 'portal_home', updated_at: refreshAt });
      const original = await bundleBell(customer, request, askAt);
      const second = await bundleBell(customer, request, refreshAt);
      await insert('estimates', { status: 'accepted', customer_id: customer.id, estimate_data: deliveredFor(mins(askAt, 30)) });
      on();
      await sweep(now);
      expect(await state(original)).toEqual(['relevance', 'Estimate was sent']);
      // The refresh's bell asked after that estimate: still open.
      expect(await state(second)).toBeNull();
      const row = await getRequest(request.id);
      expect([row.status, row.admin_notes, row.status_version]).toEqual(['new', null, 0]);
    }, 60000);

    test('a bell a person marked Done first: the sweep takes the close over and the request still resolves quietly (once the answer is verified)', async () => {
      const now = new Date();
      const bellAt = mins(now, -300);
      const answered = await customerWith();
      const unanswered = await customerWith();
      const a = { request: await requestRow(answered) };
      const u = { request: await requestRow(unanswered) };
      a.bell = await requestBell(answered, a.request, bellAt);
      u.bell = await requestBell(unanswered, u.request, bellAt);
      for (const c of [a, u]) await db('notifications').where({ id: c.bell.id }).update({ read_at: mins(bellAt, 5), done_at: mins(bellAt, 10), done_by: '1', resolution: 'Handled' });
      await staffText(answered, mins(bellAt, 20));
      on();
      await sweep(now);
      expect((await get(a.bell.id)).done_by).toBe('relevance');
      const row = await getRequest(a.request.id);
      expect([row.status, row.admin_notes]).toEqual(['resolved', 'Answered by text']);
      // Nothing answered it: the person's Done stands and the request stays open.
      expect((await get(u.bell.id)).done_by).toBe('1');
      expect((await getRequest(u.request.id)).status).toBe('new');
    }, 60000);
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
        expect(row.metadata).toMatchObject({ contact: true, lateReRungAt: AFTER_DUE.toISOString(), askedAt: ASK.toISOString() });
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

    test('an estimate for another service does not count as the answer to an add-service request: the late re-ring still rings; one for the asked service stops it', async () => {
      const wrong = await customerWith();
      const right = await customerWith();
      const wrongRequest = await requestRow(wrong, { category: 'add_service', requested_service: 'mosquito', source: 'portal_home' });
      const rightRequest = await requestRow(right, { category: 'add_service', requested_service: 'mosquito', source: 'portal_home' });
      const wrongBell = await bundleBell(wrong, wrongRequest, ASK);
      const rightBell = await bundleBell(right, rightRequest, ASK);
      await insert('estimates', { status: 'accepted', customer_id: wrong.id, estimate_data: deliveredFor(mins(ASK, 30), 'svcPest') });
      await insert('estimates', { status: 'accepted', customer_id: right.id, estimate_data: deliveredFor(mins(ASK, 30)) });
      lateOn();
      await sweep(AFTER_DUE);
      expect((await get(wrongBell.id)).body).toContain('Still waiting');
      expect((await get(rightBell.id)).body).not.toContain('Still waiting');
    }, 60000);

    test('the ask stays the boundary after the re-ring: a reply dated between the ask and the re-ring (it landed while the re-ring was being written) still closes the bell, and the re-ring happens once', async () => {
      const customer = await customerWith();
      const other = await customerWith();
      const request = await requestRow(customer);
      const asked = await requestBell(customer, request, ASK);
      const chat = await chatBell(other, ASK, { topic: 'add_service' });
      const addCustomer = await customerWith();
      const addRequest = await requestRow(addCustomer, { category: 'add_service', requested_service: 'mosquito', source: 'portal_home' });
      const bundle = await bundleBell(addCustomer, addRequest, ASK);
      lateOn();
      expect((await sweep(AFTER_DUE)).lateReRung).toBe(3);
      const bumped = await get(asked.id);
      expect(bumped.created_at.getTime()).toBeGreaterThan(AFTER_DUE.getTime());
      // The replies are dated inside the window the re-ring's own check read as empty.
      await staffText(customer, mins(ASK, 20));
      await staffText(other, mins(ASK, 25));
      await insert('estimates', { status: 'accepted', customer_id: addCustomer.id, estimate_data: deliveredFor(mins(ASK, 30)) });
      process.env.GATE_ALERT_CONTACT_CLOSE = 'true';
      process.env.GATE_PORTAL_ITEM_CLOSE = 'true';
      process.env.GATE_PORTAL_CHAT_ANSWERED_CLOSE = 'true';
      const result = await sweep(mins(AFTER_DUE, 30));
      expect(result.lateReRung).toBeUndefined();
      expect(await state(asked)).toEqual(['relevance', 'Answered by text']);
      expect(await state(chat)).toEqual(['relevance', 'Answered by text']);
      expect(await state(bundle)).toEqual(['relevance', 'Estimate was sent']);
      expect((await getRequest(request.id)).status).toBe('resolved');
      expect((await getRequest(addRequest.id)).status).toBe('resolved');
    }, 60000);

    test('a reply AFTER the ask but before the re-ring does not block closing later; one before the ask never does (chat bell, close gates on, re-ring first)', async () => {
      const customer = await customerWith();
      const early = await customerWith();
      const replied = await chatBell(customer, ASK);
      const before = await chatBell(early, ASK);
      lateOn();
      await sweep(AFTER_DUE);
      await staffText(customer, mins(ASK, 40));
      await staffText(early, mins(ASK, -40));
      process.env.GATE_ALERT_CONTACT_CLOSE = 'true';
      process.env.GATE_PORTAL_CHAT_ANSWERED_CLOSE = 'true';
      await sweep(mins(AFTER_DUE, 30));
      expect(await state(replied)).toEqual(['relevance', 'Answered by text']);
      expect(await state(before)).toBeNull();
    }, 60000);

    test('every overdue bell is considered even when they outnumber a page: pages keyed on created_at and id, and a bell that is not due does not hide the ones after it', async () => {
      const { runPortalLateRering } = require('../services/portal-late-rering');
      const rows = [];
      // Six overdue bells with the SAME created_at (the keyset must tie-break on id) and, among them later,
      // one fresh bell that is not due yet.
      for (let i = 0; i < 6; i += 1) rows.push(await chatBell(await customerWith(), ASK));
      const fresh = await chatBell(await customerWith(), mins(AFTER_DUE, -5));
      lateOn();
      const result = await runPortalLateRering({ now: AFTER_DUE, pageSize: 2 });
      expect(result.rung).toBe(6);
      for (const b of rows) expect((await get(b.id)).metadata.lateReRungAt).toBe(AFTER_DUE.toISOString());
      expect((await get(fresh.id)).metadata.lateReRungAt).toBeUndefined();
      // Run again: nothing is rung twice.
      expect((await runPortalLateRering({ now: mins(AFTER_DUE, 5), pageSize: 2 })).rung).toBe(0);
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

  describe('GATE_PORTAL_ESTIMATE_RERING', () => {
    // An ask at 15:00 UTC three days ago (10:00 or 11:00 ET): due 24 open hours later, 48 to 49 wall-clock
    // hours on (the clocks change on 2026-11-01), so 44 hours is never due and 52 hours always is.
    const base = new Date();
    const ASK = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() - 3, 15, 0, 0));
    const NOT_DUE = mins(ASK, 44 * 60);
    const DUE = mins(ASK, 52 * 60);
    const estimateOn = () => { process.env.GATE_PORTAL_ESTIMATE_RERING = 'true'; };
    // Filed at the ask, not at FILED (now minus 3 days, to the minute): the quiet close resolves a request only when
    // its updated_at is at or before the bell's askedAt, and FILED passes ASK (15:00 UTC) every day after 15:00 UTC.
    const addRequest = (customer, service = 'mosquito') => requestRow(customer, { category: 'add_service', requested_service: service, source: 'portal_home', created_at: ASK, updated_at: ASK });
    const bundleFor = async (customer, at = ASK, service = 'mosquito') => bundleBell(customer, await addRequest(customer, service), at);
    const rungText = 'Estimate still owed: no estimate for this service after 2 business days.';
    // Every test sweeps all open bells in this database: close the fixtures of the last test so none rings in the next.
    afterEach(async () => { await db('notifications').whereIn('id', made.notifications).whereNull('done_at').update({ done_at: new Date(), done_by: 'test' }); });

    test('a request bell 2 business days old with a person\'s text but no estimate rings "Estimate still owed" exactly once: same row, unread, on top, stamped; not before it is due, not with the gate off', async () => {
      const customer = await customerWith();
      const b = await bundleFor(customer);
      await db('notifications').where({ id: b.id }).update({ read_at: mins(ASK, 5) });
      await staffText(customer, mins(ASK, 20)); // "we're working on it": no estimate
      // The same customer's chat add-service bell and a portal request bell are not this class.
      const chat = await chatBell(customer, ASK, { topic: 'add_service' });
      const requested = await requestBell(customer, await requestRow(customer), ASK);

      await sweep(DUE); // gate off
      expect((await get(b.id)).metadata.estimateReRungAt).toBeUndefined();

      estimateOn();
      expect((await sweep(NOT_DUE)).estimateReRung).toBeUndefined();
      expect((await get(b.id)).body).not.toContain(rungText);

      // The close gates are on: a person's text still does not close or silence an add-service request.
      process.env.GATE_ALERT_CONTACT_CLOSE = 'true';
      process.env.GATE_PORTAL_ITEM_CLOSE = 'true';
      const result = await sweep(DUE);
      expect(result.estimateReRung).toBe(1);
      expect(result.lateReRung).toBeUndefined();
      const row = await get(b.id);
      expect(row.body.startsWith(rungText)).toBe(true);
      expect(row.body).toContain('Pat asked about adding a service');
      expect(row.read_at).toBeNull();
      expect(row.done_at).toBeNull();
      expect(row.created_at.getTime()).toBeGreaterThan(DUE.getTime());
      expect(row.metadata).toMatchObject({ contact: true, estimateReRungAt: DUE.toISOString(), askedAt: ASK.toISOString(), requestId: expect.any(String), customerId: customer.id });
      expect(row.metadata.lateReRungAt).toBeUndefined();
      for (const other of [chat, requested]) expect((await get(other.id)).metadata.estimateReRungAt).toBeUndefined();

      // Never a second estimate re-ring.
      const once = await get(b.id);
      await db('notifications').where({ id: b.id }).update({ read_at: new Date() });
      expect((await sweep(mins(DUE, 6 * 60))).estimateReRung).toBeUndefined();
      const again = await get(b.id);
      expect([again.body, again.created_at.getTime(), JSON.stringify(again.metadata)]).toEqual([once.body, once.created_at.getTime(), JSON.stringify(once.metadata)]);
      expect(again.read_at).toBeInstanceOf(Date);
    }, 60000);

    test('a delivered estimate for the asked service stops it; a delivered estimate for ANOTHER service does not; the request\'s own minted estimate stops it', async () => {
      const right = await customerWith();
      const wrong = await customerWith();
      const minted = await customerWith();
      const rightBell = await bundleFor(right);
      const wrongBell = await bundleFor(wrong);
      const mintedRequest = await addRequest(minted, 'mosquito');
      const mintedEstimate = await insert('estimates', { status: 'accepted', customer_id: minted.id, estimate_data: delivered(mins(ASK, 30 * 60)) });
      await db('service_requests').where({ id: mintedRequest.id }).update({ pricing_revision: JSON.stringify({ mintedEstimate: { id: mintedEstimate.id } }) });
      const mintedBell = await bundleBell(minted, mintedRequest, ASK);
      await insert('estimates', { status: 'accepted', customer_id: right.id, estimate_data: deliveredFor(mins(ASK, 30 * 60)) });
      await insert('estimates', { status: 'accepted', customer_id: wrong.id, estimate_data: deliveredFor(mins(ASK, 30 * 60), 'svcPest') });
      estimateOn();
      expect((await sweep(DUE)).estimateReRung).toBe(1);
      expect((await get(wrongBell.id)).body).toContain(rungText);
      expect((await get(rightBell.id)).body).not.toContain(rungText);
      expect((await get(mintedBell.id)).body).not.toContain(rungText);
    }, 60000);

    test('an ask older than 14 days is left alone; one inside the window is rung; a closed bell is left alone', async () => {
      const old = await customerWith();
      const inside = await customerWith();
      const closed = await customerWith();
      const oldBell = await bundleFor(old, mins(DUE, -15 * 24 * 60));
      const insideBell = await bundleFor(inside, mins(DUE, -13 * 24 * 60));
      const closedBell = await bundleFor(closed);
      await db('notifications').where({ id: closedBell.id }).update({ done_at: mins(ASK, 30), done_by: '1' });
      estimateOn();
      expect((await sweep(DUE)).estimateReRung).toBe(1);
      expect((await get(oldBell.id)).body).not.toContain(rungText);
      expect((await get(insideBell.id)).body).toContain(rungText);
      expect((await get(closedBell.id)).body).not.toContain(rungText);
    }, 60000);

    test('a bell the first-reply pass already rang still gets the estimate re-ring once, replacing the "Still waiting" line; the first-reply pass never rings it again', async () => {
      const { runPortalLateRering } = require('../services/portal-late-rering');
      const customer = await customerWith();
      const never = await customerWith();
      const rungBell = await bundleFor(customer);
      const neverFirstRung = await bundleFor(never);
      process.env.GATE_PORTAL_LATE_RERING = 'true';
      expect((await runPortalLateRering({ now: mins(ASK, 70) })).rung).toBe(2);
      // The second bell is put back as one the first-reply pass never rang (a bell the gate was off for).
      await db('notifications').where({ id: neverFirstRung.id }).update({
        metadata: db.raw("metadata - 'lateReRungAt' - 'askedAt'"), body: 'Pat asked about adding a service', created_at: ASK });
      expect((await get(rungBell.id)).body.startsWith('Still waiting:')).toBe(true);

      estimateOn();
      expect((await sweep(DUE)).estimateReRung).toBe(2);
      const row = await get(rungBell.id);
      expect(row.body.startsWith(rungText)).toBe(true);
      expect(row.body).not.toContain('Still waiting');
      expect(row.body).toBe(`${rungText} Pat asked about adding a service`);
      expect(row.metadata).toMatchObject({ lateReRungAt: mins(ASK, 70).toISOString(), estimateReRungAt: DUE.toISOString(), askedAt: ASK.toISOString() });

      // Past both rings: the first-reply pass reads the bumped created_at and the stamped ask, and rings neither row.
      const bumped = await get(neverFirstRung.id);
      expect(bumped.created_at.getTime()).toBeGreaterThan(DUE.getTime());
      for (const at of [DUE, mins(DUE, 60), new Date()]) {
        expect((await runPortalLateRering({ now: at })).rung).toBe(0);
        expect((await sweep(at)).lateReRung).toBeUndefined();
      }
      const final = await get(neverFirstRung.id);
      expect(final.metadata.lateReRungAt).toBeUndefined();
      expect(final.body.startsWith(rungText)).toBe(true);
    }, 60000);

    test('the close rules still read askedAt after the bump: an estimate dated between the ask and the re-ring closes the bell', async () => {
      const customer = await customerWith();
      const request = await addRequest(customer);
      const b = await bundleBell(customer, request, ASK);
      estimateOn();
      expect((await sweep(DUE)).estimateReRung).toBe(1);
      expect((await get(b.id)).created_at.getTime()).toBeGreaterThan(DUE.getTime());
      await insert('estimates', { status: 'accepted', customer_id: customer.id, estimate_data: deliveredFor(mins(ASK, 30 * 60)) });
      process.env.GATE_ALERT_CONTACT_CLOSE = 'true';
      process.env.GATE_PORTAL_ITEM_CLOSE = 'true';
      const result = await sweep(mins(DUE, 30));
      expect(result.estimateReRung).toBeUndefined();
      expect(await state(b)).toEqual(['relevance', 'Estimate was sent']);
      expect((await getRequest(request.id)).status).toBe('resolved');
    }, 60000);

    test('every due bell is considered even when they outnumber a page: pages keyed on created_at and id', async () => {
      const { runPortalEstimateRering } = require('../services/portal-late-rering');
      const rows = [];
      for (let i = 0; i < 5; i += 1) rows.push(await bundleFor(await customerWith()));
      const fresh = await bundleFor(await customerWith(), mins(DUE, -5 * 60));
      estimateOn();
      const result = await runPortalEstimateRering({ now: DUE, pageSize: 2 });
      expect(result.rung).toBe(5);
      for (const b of rows) expect((await get(b.id)).metadata.estimateReRungAt).toBe(DUE.toISOString());
      expect((await get(fresh.id)).metadata.estimateReRungAt).toBeUndefined();
      expect((await runPortalEstimateRering({ now: mins(DUE, 5), pageSize: 2 })).rung).toBe(0);
    }, 60000);
  });
});

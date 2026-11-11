/**
 * GATE_PROMISE_PHONE_MATCH_CLOSE on a live Postgres (CI's DATABASE_URL step): the unknown-sender text bell and the
 * quiet-call filter, as SQL. Owner 2026-11-04: "WHY ARENT THESE UPDATED ... FOR ALL COMUNNICATION LINES".
 *   - an inbound_sms bell from a number with no customer record (sms-reply:<sid>) closes once a person's delivered
 *     reply reached that phone after the sender's LATEST text; an automated reply, a reply from before a later text,
 *     and a number a customer also carries never close it; shadow records and changes nothing; gate off judges nothing;
 *   - an open Waves promise on a vendor_logged, spam_discarded or applicant call is left out of what the pagers list,
 *     and stays in the Owed tab's list.
 * Fixtures fictitious.
 */
process.env.GATE_CALL_COMMITMENTS = 'true';
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
const DAY = 24 * 60 * 60 * 1000;

maybeDescribe('phone-matched alert and promise rules (live Postgres)', () => {
  let db;
  let relevance;
  let cc;
  const made = { notifications: [], sms_log: [], call_log: [], customers: [] };
  const GATES = ['GATE_PROMISE_PHONE_MATCH_CLOSE'];
  const saved = Object.fromEntries(GATES.map((g) => [g, process.env[g]]));
  const BIZ = '+15555559000';
  let seq = 0;
  const sid = (prefix) => `${prefix}${String(Date.now()).slice(-8)}${String((seq += 1)).padStart(6, '0')}`;
  const mins = (base, m) => new Date(base.getTime() + m * 60 * 1000);

  beforeAll(() => {
    db = require('../models/db');
    relevance = require('../services/admin-alert-relevance');
    cc = require('../services/call-commitments');
  });
  afterEach(() => { for (const g of GATES) { if (saved[g] === undefined) delete process.env[g]; else process.env[g] = saved[g]; } });
  afterAll(async () => {
    if (made.notifications.length) await db('audit_log').where({ resource_type: 'notification' }).whereIn('resource_id', made.notifications).del();
    for (const table of ['notifications', 'sms_log', 'call_log', 'customers']) {
      if (made[table].length) await db(table).whereIn('id', made[table]).del(); // call_log cascades the commitments
    }
    await db.destroy();
  }, 120000);

  const insert = async (table, row) => {
    const [r] = await db(table).insert(row).returning('*');
    made[table].push(r.id);
    return r;
  };
  const get = (id) => db('notifications').where({ id }).first();
  const sweep = () => relevance.runAdminAlertRelevanceSweep({ now: new Date() });
  const phoneOf = () => `+1555${String(Date.now()).slice(-4)}${String((seq += 1) % 1000).padStart(3, '0')}`;
  const wouldClose = (id) => db('audit_log').where({ action: 'notification.alert_relevance.would_close', resource_type: 'notification', resource_id: id });

  describe('the unknown-sender text bell', () => {
    // An inbound text from a number with no customer record and the bell that rang for it.
    const unknownText = async (phone, at, body = 'Do you service Parrish?') => {
      const messageSid = sid('SMI');
      await insert('sms_log', { direction: 'inbound', from_phone: phone, to_phone: BIZ, customer_id: null, message_body: body,
        message_type: 'customer_reply', status: 'received', twilio_sid: messageSid, created_at: at });
      const row = await insert('notifications', { recipient_type: 'admin', title: 'Fixture alert', category: 'inbound_sms', created_at: mins(at, 1),
        link: `/admin/communications?message=${messageSid}`,
        metadata: JSON.stringify({ triggerKey: 'sms_reply', dedupeKey: `sms-reply:${messageSid}`, payload: { twilioSid: messageSid, threadId: null } }) });
      return { messageSid, row };
    };
    const personText = (phone, at, over = {}) => insert('sms_log', { direction: 'outbound', from_phone: BIZ, to_phone: phone, customer_id: null,
      message_body: 'Yes, we do.', message_type: 'manual', status: 'delivered', twilio_sid: sid('SMO'), metadata: JSON.stringify({ human_authored: true }), created_at: at, ...over });

    test('gate off: the bell is not judged, however answered; shadow records once and changes nothing; true closes it', async () => {
      const t0 = mins(new Date(), -120);
      const phone = phoneOf();
      const { row } = await unknownText(phone, t0);
      await personText(phone, mins(t0, 5));
      const off = await sweep();
      expect(off.byClass.unknown_sms).toBeUndefined();
      expect((await get(row.id)).done_at).toBeNull();
      expect(await wouldClose(row.id)).toHaveLength(0);

      process.env.GATE_PROMISE_PHONE_MATCH_CLOSE = 'shadow';
      await sweep();
      const shadowed = await get(row.id);
      expect([shadowed.done_at, shadowed.done_by]).toEqual([null, null]);
      const rows = await wouldClose(row.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({ class: 'unknown_sms', reason: 'Answered by text' });

      process.env.GATE_PROMISE_PHONE_MATCH_CLOSE = 'true';
      await sweep();
      const closed = await get(row.id);
      expect([closed.done_by, closed.resolution]).toEqual(['relevance', 'Answered by text']);
      expect(closed.metadata.retired).toMatchObject({ by: 'alert-relevance', reason: 'Answered by text' });
    });

    test('an automated reply, a reply from before the text, a reply before the sender\'s latest text, and a number a customer also carries all leave it open', async () => {
      process.env.GATE_PROMISE_PHONE_MATCH_CLOSE = 'true';
      const t0 = mins(new Date(), -180);

      const automated = phoneOf();
      const a = await unknownText(automated, t0);
      await personText(automated, mins(t0, 5), { message_type: 'confirmation', metadata: null });

      const earlier = phoneOf();
      await personText(earlier, mins(t0, -30));
      const b = await unknownText(earlier, t0);

      // The bell names the first text of a 4-hour window; the sender wrote again after the reply.
      const twice = phoneOf();
      const c = await unknownText(twice, t0);
      await personText(twice, mins(t0, 5));
      await unknownText(twice, mins(t0, 30), 'Hello? Anyone there?');

      const shared = phoneOf();
      await insert('customers', { first_name: 'Shared', phone: shared });
      const d = await unknownText(shared, t0);
      await personText(shared, mins(t0, 5));

      await sweep();
      for (const [label, bell] of [['automated', a], ['earlier', b], ['twice', c], ['shared', d]]) {
        expect([label, (await get(bell.row.id)).done_at]).toEqual([label, null]);
      }
      // Once the person answers the sender's latest text, it closes.
      await personText(twice, mins(t0, 45));
      await sweep();
      expect((await get(c.row.id)).resolution).toBe('Answered by text');
    });

    test('a call a person placed and spoke on to that phone closes it too', async () => {
      process.env.GATE_PROMISE_PHONE_MATCH_CLOSE = 'true';
      const t0 = mins(new Date(), -120);
      const phone = phoneOf();
      const { row } = await unknownText(phone, t0);
      await insert('call_log', { direction: 'outbound', from_phone: BIZ, to_phone: phone, customer_id: null, status: 'completed', source: 'admin-click',
        duration_seconds: 180, v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: 'false' } }),
        twilio_call_sid: sid('CAO'), created_at: mins(t0, 10) });
      await sweep();
      expect((await get(row.id)).resolution).toBe('Answered by a call');
    });
  });

  describe('promises on vendor, spam and applicant calls', () => {
    const promiseOn = async (callExtra) => {
      const phone = phoneOf();
      const call = await insert('call_log', { twilio_call_sid: sid('CAV'), direction: 'inbound', from_phone: phone, to_phone: BIZ, status: 'completed',
        duration_seconds: 55, customer_id: null, created_at: new Date(Date.now() - DAY), ...callExtra });
      const [commitment] = await db('call_commitments').insert({ call_log_id: call.id, commitment_key: 'waves:callback', party: 'waves', kind: 'callback', source: 'ai',
        last_seen_generation: 1, status: 'open', description: `Call back ${call.id}`, evidence: JSON.stringify([{ quote: 'I will call you back', speaker: 'agent' }]) }).returning('id');
      return commitment.id;
    };

    test('the pagers\' list leaves them out under the gate; the Owed tab\'s list keeps every one', async () => {
      const vendor = await promiseOn({ disposition: 'vendor_logged' });
      const spam = await promiseOn({ disposition: 'spam_discarded' });
      const applicant = await promiseOn({ disposition: 'lead_response_flow_triggered', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ call_nature: 'job_applicant' }) });
      const prospect = await promiseOn({ disposition: 'lead_response_flow_triggered', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ call_nature: 'new_lead' }) });
      const mine = new Set([vendor, spam, applicant, prospect]);
      const page = () => cc.listOpenCommitments(db, { party: 'waves', limit: 200 });
      const ids = (rows) => rows.map((r) => r.id).filter((id) => mine.has(id));

      delete process.env.GATE_PROMISE_PHONE_MATCH_CLOSE;
      expect(ids(cc.pagerRows(await page())).length).toBe(4);
      process.env.GATE_PROMISE_PHONE_MATCH_CLOSE = 'shadow';
      expect(ids(cc.pagerRows(await page())).length).toBe(4);
      process.env.GATE_PROMISE_PHONE_MATCH_CLOSE = 'true';
      expect(ids(cc.pagerRows(await page()))).toEqual([prospect]);
      // The Owed tab reads the page itself, and keeps every one.
      expect(ids(await page()).length).toBe(4);
    });
  });
});

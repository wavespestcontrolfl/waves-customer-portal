/**
 * Lead staleness sweep against live Postgres: a lead whose linked customer
 * still has an ask waiting on us is never parked as unresponsive.
 *
 * The real case: a new lead asked for help three times in the customer app
 * (two forms and a chat hand-off) and nobody answered; 21 days later the
 * sweep wrote "Auto-marked unresponsive after 21 days with no contact". The
 * sweep read lead_activities only, so app asks and texts were invisible.
 *
 * Runs the production builders (buildStaleLeadUpdate / the expired-estimate
 * flip) against rows scoped to this run's own leads. Every row is synthetic
 * and tagged by this run; cleanup removes only those rows. The compiled-SQL
 * pins live in lead-staleness.test.js. It refuses any database but a private
 * QA one or CI's.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'lead-staleness-owed-reply-postgres-only';

const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('lead staleness: the customer\'s own unanswered ask (live Postgres)', () => {
  const RUN = randomUUID().slice(0, 8);
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = new Date();
  const ago = (days) => new Date(NOW.getTime() - days * DAY);
  const mins = (base, m) => new Date(base.getTime() + m * 60 * 1000);
  const BIZ = '+15555559000';
  const made = {
    leads: [], customers: [], sms_log: [], call_log: [], emails: [], estimates: [],
    agent_sessions: [], ai_escalations: [], service_requests: [], notifications: [], inbound_sms_optout_receipts: [],
  };
  let db;
  let staleness;
  let seq = 0;
  const sid = (prefix) => `${prefix}${RUN}${String((seq += 1)).padStart(6, '0')}`;

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    staleness = require('../services/lead-staleness');
  });

  afterAll(async () => {
    if (!db) return;
    await db('inbound_sms_optout_receipts').whereIn('message_sid', made.inbound_sms_optout_receipts).del();
    for (const table of ['notifications', 'ai_escalations', 'agent_sessions', 'service_requests', 'sms_log', 'call_log', 'emails', 'leads', 'estimates', 'customers']) {
      if (made[table].length) await db(table).whereIn('id', made[table]).del();
    }
  }, 120000);

  const insert = async (table, row) => {
    const [r] = await db(table).insert(row).returning('*');
    made[table].push(r.id);
    return r;
  };

  let phoneSeq = 0;
  const newPhone = () => `+1941555${String(1000 + (phoneSeq += 1) + Math.floor(Math.random() * 7000)).slice(-4)}`;

  // A lead 30 days old on its own customer, plus the helpers that give that
  // customer an ask or a reply.
  async function scene({ linked = true } = {}) {
    const phone = newPhone();
    const customer = await insert('customers', { first_name: 'Pat', last_name: `Synthetic${RUN}`, phone, email: `pat-${RUN}-${seq += 1}@example.invalid` });
    const lead = await insert('leads', { first_name: 'Pat', phone, status: 'new', customer_id: linked ? customer.id : null, created_at: ago(30) });
    return { customer, lead, phone };
  }

  async function chat(customer, { done = null } = {}) {
    const session = await insert('agent_sessions', { customer_id: customer.id, channel: 'portal_chat', channel_identifier: `t-${RUN}-${randomUUID()}`, status: 'escalated' });
    const esc = await insert('ai_escalations', {
      conversation_id: session.id, customer_id: customer.id, reason: 'complex_question', summary: 'needs a person',
      customer_message: 'Can someone help me?', status: 'pending', priority: 'normal', created_at: ago(25),
    });
    if (done !== null) {
      await insert('notifications', {
        recipient_type: 'admin', category: 'alert', title: `Comms - ${RUN}`, body: 'x',
        metadata: JSON.stringify({ escalationId: esc.id }), done_at: done ? new Date() : null,
      });
    }
    return esc;
  }

  const request = (customer, over = {}) => insert('service_requests', {
    customer_id: customer.id, category: 'general', subject: `${RUN} request`, description: 'Please call me',
    status: 'new', source: null, created_at: ago(25), ...over,
  });

  const inboundText = (customer, phone, at, over = {}) => {
    const messageSid = sid('SMI');
    return insert('sms_log', {
      direction: 'inbound', from_phone: phone, to_phone: BIZ, customer_id: customer.id, message_body: 'Can you come out on Tuesday?',
      message_type: 'customer_reply', status: 'received', twilio_sid: messageSid, created_at: at, ...over,
    });
  };
  const staffText = (customer, phone, at, over = {}) => insert('sms_log', {
    direction: 'outbound', from_phone: BIZ, to_phone: phone, customer_id: customer.id, message_body: 'Yes, Tuesday works.',
    message_type: 'manual', status: 'delivered', twilio_sid: sid('SMO'), metadata: JSON.stringify({ human_authored: true }), created_at: at, ...over,
  });
  const staffCall = (customer, phone, at, over = {}) => insert('call_log', {
    direction: 'outbound', from_phone: BIZ, to_phone: phone, customer_id: customer.id, status: 'completed', source: 'admin-click',
    duration_seconds: 180, v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: 'false' } }),
    twilio_call_sid: sid('CAO'), created_at: at, ...over,
  });

  // The production builders, narrowed to this run's leads. Resolves to the ids
  // the flip parked.
  async function sweepNew(leads) {
    const cutoff = new Date(NOW.getTime() - 21 * DAY);
    const rows = await staleness.buildStaleLeadUpdate(db, { now: NOW, cutoff, excludeSoftDeleted: true }).whereIn('leads.id', leads.map((l) => l.id));
    return rows.map((r) => r.id);
  }
  async function sweepEstimate(leads) {
    const cutoff = new Date(NOW.getTime() - 21 * DAY);
    const rows = await staleness.buildExpiredEstimateLeadUpdate(db, { now: NOW, cutoff, excludeSoftDeleted: true }).whereIn('leads.id', leads.map((l) => l.id));
    return rows.map((r) => r.id);
  }
  // A lead is parked when the flip returns its id. Run the flip once per case
  // and read the row back so the assertion also sees the stored status.
  async function parked(lead) {
    const ids = await sweepNew([lead]);
    const row = await db('leads').where({ id: lead.id }).first('status');
    expect(ids.includes(lead.id)).toBe(row.status === 'unresponsive');
    return ids.includes(lead.id);
  }

  test('control: a quiet lead with no ask is parked', async () => {
    const { lead } = await scene();
    expect(await parked(lead)).toBe(true);
  });

  test('an open Portal chat hand-off keeps the lead; a chat whose bell is Done does not', async () => {
    const open = await scene();
    await chat(open.customer);
    expect(await parked(open.lead)).toBe(false);

    const noBell = await scene();
    await chat(noBell.customer, { done: false });
    expect(await parked(noBell.lead)).toBe(false);

    const handled = await scene();
    await chat(handled.customer, { done: true });
    expect(await parked(handled.lead)).toBe(true);
  });

  test('an open customer service request keeps the lead; resolved, closed, cancelled and staff-made ones do not', async () => {
    const open = await scene();
    await request(open.customer);
    expect(await parked(open.lead)).toBe(false);

    for (const status of ['resolved', 'closed', 'cancelled']) {
      const s = await scene();
      await request(s.customer, { status });
      expect(await parked(s.lead)).toBe(true);
    }

    const staffMade = await scene();
    await request(staffMade.customer, { source: 'admin' });
    expect(await parked(staffMade.lead)).toBe(true);
  });

  // The bell portal-unfinished-bookings.js raises when they leave the card step of our estimate.
  const bookingBell = (customer, { done = false, key = `portal-unfinished-checkout:${randomUUID()}` } = {}) => insert('notifications', {
    recipient_type: 'admin', category: 'alert', title: `Booking - ${RUN}`, body: 'x',
    metadata: JSON.stringify({ dedupeKey: key, customerId: customer.id, doneWhen: 'customer_answered' }), done_at: done ? new Date() : null,
  });

  test('an open "Booking not finished" bell keeps the lead; a Done one, another customer\'s or another kind of bell does not', async () => {
    const open = await scene();
    await bookingBell(open.customer);
    expect(await parked(open.lead)).toBe(false);

    const handled = await scene();
    await bookingBell(handled.customer, { done: true });
    expect(await parked(handled.lead)).toBe(true);

    // The open bell above is on another customer.
    const other = await scene();
    expect(await parked(other.lead)).toBe(true);

    const otherKind = await scene();
    await bookingBell(otherKind.customer, { key: `portal-ask:${randomUUID()}` });
    expect(await parked(otherKind.lead)).toBe(true);
  });

  test('an inbound text nobody answered keeps the lead', async () => {
    const { customer, lead, phone } = await scene();
    await inboundText(customer, phone, ago(20));
    expect(await parked(lead)).toBe(false);
  });

  test('a person\'s text, a call a person placed, or a call a human answered after the text releases the lead', async () => {
    const t0 = ago(20);

    const texted = await scene();
    await inboundText(texted.customer, texted.phone, t0);
    await staffText(texted.customer, texted.phone, mins(t0, 5));
    expect(await parked(texted.lead)).toBe(true);

    const called = await scene();
    await inboundText(called.customer, called.phone, t0);
    await staffCall(called.customer, called.phone, mins(t0, 10));
    expect(await parked(called.lead)).toBe(true);

    const answered = await scene();
    await inboundText(answered.customer, answered.phone, t0);
    await insert('call_log', {
      direction: 'inbound', from_phone: answered.phone, to_phone: BIZ, customer_id: answered.customer.id, status: 'completed',
      answered_by: 'human', duration_seconds: 120, twilio_call_sid: sid('CAI'), created_at: mins(t0, 15),
    });
    expect(await parked(answered.lead)).toBe(true);
  });

  test('a person\'s Gmail send to the customer after the text releases the lead', async () => {
    const t0 = ago(20);
    const { customer, lead, phone } = await scene();
    await inboundText(customer, phone, t0);
    await insert('emails', {
      gmail_id: sid('GM'), gmail_thread_id: sid('TH'), from_address: 'office@waves.example.invalid', to_address: customer.email,
      cc_address: '', bcc_address: '', label_ids: JSON.stringify(['SENT']), received_at: mins(t0, 20),
    });
    expect(await parked(lead)).toBe(true);
  });

  test('a Gmail send counts only when the customer\'s address is one of its mailboxes', async () => {
    const t0 = ago(20);
    const sent = (customer, headers) => insert('emails', {
      gmail_id: sid('GM'), gmail_thread_id: sid('TH'), from_address: 'office@waves.example.invalid',
      to_address: '', cc_address: '', bcc_address: '', ...headers,
      label_ids: JSON.stringify(['SENT']), received_at: mins(t0, 20),
    });
    // A longer address that ends with the customer's (joann@ for ann@) is someone else.
    const a = await scene();
    await inboundText(a.customer, a.phone, t0);
    await sent(a.customer, { to_address: `jo${a.customer.email}` });
    expect(await parked(a.lead)).toBe(false);
    // An email-shaped display name is not a recipient: this went to the office.
    const b = await scene();
    await inboundText(b.customer, b.phone, t0);
    await sent(b.customer, { to_address: `"${b.customer.email}" <office@waves.example.invalid>` });
    expect(await parked(b.lead)).toBe(false);
    // The real mailbox in angle brackets, mixed case, in Cc beside another recipient, does count.
    const c = await scene();
    await inboundText(c.customer, c.phone, t0);
    await sent(c.customer, { to_address: 'other@example.invalid', cc_address: `"Synthetic, Pat" <${c.customer.email.toUpperCase()}>` });
    expect(await parked(c.lead)).toBe(true);
  });

  test('a reply that came BEFORE the text, an automated text, or a call that rang out does not release the lead', async () => {
    const t0 = ago(20);

    const earlier = await scene();
    await staffText(earlier.customer, earlier.phone, mins(t0, -30));
    await inboundText(earlier.customer, earlier.phone, t0);
    expect(await parked(earlier.lead)).toBe(false);

    const automated = await scene();
    await inboundText(automated.customer, automated.phone, t0);
    // An automated reminder is no person: no human_authored stamp, no admin sender.
    await staffText(automated.customer, automated.phone, mins(t0, 5), { message_type: 'appointment_reminder', metadata: JSON.stringify({}) });
    expect(await parked(automated.lead)).toBe(false);

    const rangOut = await scene();
    await inboundText(rangOut.customer, rangOut.phone, t0);
    await staffCall(rangOut.customer, rangOut.phone, mins(t0, 10), { v2_extraction_status: 'failed', ai_extraction_enriched: null });
    expect(await parked(rangOut.lead)).toBe(false);
  });

  test('a STOP text is not an ask (message type or opt-out receipt)', async () => {
    const byType = await scene();
    await inboundText(byType.customer, byType.phone, ago(20), { message_type: 'opt_out', message_body: 'STOP' });
    expect(await parked(byType.lead)).toBe(true);

    const byReceipt = await scene();
    const stop = await inboundText(byReceipt.customer, byReceipt.phone, ago(20), { message_body: 'stop' });
    await db('inbound_sms_optout_receipts').insert({ message_sid: stop.twilio_sid, phone: byReceipt.phone });
    made.inbound_sms_optout_receipts.push(stop.twilio_sid);
    expect(await parked(byReceipt.lead)).toBe(true);
  });

  test('a text older than 90 days is not an ask; one at 80 days is', async () => {
    const old = await scene();
    await inboundText(old.customer, old.phone, ago(100));
    expect(await parked(old.lead)).toBe(true);

    const recent = await scene();
    await inboundText(recent.customer, recent.phone, ago(80));
    expect(await parked(recent.lead)).toBe(false);
  });

  test('a lead with no customer is judged as before, whatever the phone has texted', async () => {
    const { customer, lead, phone } = await scene({ linked: false });
    await inboundText(customer, phone, ago(20));
    await request(customer);
    await chat(customer);
    expect(await parked(lead)).toBe(true);
  });

  test('another customer\'s ask does not keep this lead', async () => {
    const mine = await scene();
    const other = await scene();
    await chat(other.customer);
    await request(other.customer);
    await inboundText(other.customer, other.phone, ago(20));
    expect(await parked(mine.lead)).toBe(true);
  });

  test('the expired-estimate flip honours the same exemption', async () => {
    const make = async () => {
      const s = await scene();
      const estimate = await insert('estimates', {
        status: 'expired', disposition: 'expired_unviewed', customer_id: s.customer.id, created_at: ago(40), sent_at: ago(35),
      });
      await db('leads').where({ id: s.lead.id }).update({ status: 'estimate_sent', estimate_id: estimate.id });
      return s;
    };
    const quiet = await make();
    const asked = await make();
    await chat(asked.customer);
    const parkedIds = await sweepEstimate([quiet.lead, asked.lead]);
    expect(parkedIds).toContain(quiet.lead.id);
    expect(parkedIds).not.toContain(asked.lead.id);
  });
});

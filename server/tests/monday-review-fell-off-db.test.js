/**
 * Monday review bell, list 1 as "customer alerts that fell off with no reply" (GATE_MONDAY_FELL_OFF_LINE; owner
 * 2026-11-05, decision D3) against live Postgres: the loader's SQL, the customer-contact test, the name read and the
 * shared reply witnesses (admin-alert-contact-witnesses.js) on real rows. Every fixture carries this run's marker,
 * so counts never depend on rows other suites left behind and cleanup touches only what this suite wrote. It
 * refuses any database but a private QA one or CI's.
 */
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('monday review fell-off list (live Postgres)', () => {
  let db;
  let fellOff;
  const RUN = randomUUID().slice(0, 8);
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  const NOW = new Date();
  const ago = (days) => new Date(NOW.getTime() - days * DAY);
  const created = { notifications: [], customers: [], sms: [], calls: [], visits: [] };
  let testCustomerId = null;

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    fellOff = require('../services/monday-review-fell-off');
    // One fixture customer stands in for an internal test customer.
    jest.spyOn(require('../services/internal-test-customers'), 'isInternalTestCustomerId')
      .mockImplementation((id) => !!id && !!testCustomerId && String(id) === String(testCustomerId));
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (!db) return;
    if (created.notifications.length) await db('notifications').whereIn('id', created.notifications).del();
    if (created.sms.length) await db('sms_log').whereIn('id', created.sms).del();
    if (created.calls.length) await db('call_log').whereIn('id', created.calls).del();
    if (created.visits.length) await db('scheduled_services').whereIn('id', created.visits).del();
    if (created.customers.length) await db('customers').whereIn('id', created.customers).del();
  }, 60000);

  const phone = () => `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

  const addCustomer = async (first) => {
    const [row] = await db('customers').insert({ first_name: first, last_name: `Fell${RUN}`, phone: phone() }).returning(['id', 'phone']);
    created.customers.push(row.id);
    return row;
  };

  const addSms = async (over) => {
    const [row] = await db('sms_log').insert({ from_phone: '+15550000001', to_phone: '+15550000002', status: 'delivered', ...over }).returning('id');
    created.sms.push(row.id);
    return row.id;
  };

  // The customer's text and the thread bell it rang, quiet-closed `closedDaysAgo` days ago.
  async function textAlert(customer, { name, sentDaysAgo = 5, closedDaysAgo = 2, category = 'inbound_sms', closedBy = 'quiet-72h', closed = true, metadata = {} } = {}) {
    const sid = `SM${RUN}${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const sentAt = ago(sentDaysAgo);
    await addSms({
      direction: 'inbound', from_phone: customer.phone, to_phone: '+15550000002', twilio_sid: sid, customer_id: customer.id,
      status: 'received', created_at: sentAt,
    });
    const [row] = await db('notifications').insert({
      recipient_type: 'admin', category, title: `SMS from ${name} Fell${RUN}`, body: 'fixture', link: `/admin/communications?message=${sid}`,
      created_at: sentAt,
      done_at: closed ? ago(closedDaysAgo) : null, done_by: closed ? closedBy : null, resolution: closed ? 'No new activity for 3 days' : null,
      metadata: JSON.stringify({
        severity: 'needs-you', who: 'person', triggerKey: 'sms_reply', dedupeKey: `sms-thread:${customer.id}`, threadId: customer.id,
        payload: { twilioSid: sid, threadId: customer.id }, ...metadata,
      }),
    }).returning('id');
    created.notifications.push(row.id);
    return { id: row.id, sid, sentAt };
  }

  const staffText = (customer, at, over = {}) => addSms({
    direction: 'outbound', to_phone: customer.phone, customer_id: customer.id, twilio_sid: `SM${RUN}${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    status: 'delivered', message_type: 'manual', metadata: JSON.stringify({ human_authored: 'true' }), created_at: at, ...over,
  });

  // The list, reduced to this run's fixtures: the names that were listed.
  const listed = async () => {
    const out = await fellOff.loadFellOffAlerts({ now: NOW });
    return { out, names: out.entries.filter((e) => e.title.includes(`Fell${RUN}`)).map((e) => e.title.replace(` Fell${RUN}`, '').replace('SMS from ', '')).sort() };
  };

  test('lists the quiet-closed customer text nobody answered, by name, and only that one among the cases that follow', async () => {
    const unanswered = await addCustomer('Alpha');
    await textAlert(unanswered, { name: 'Alpha' });

    const answered = await addCustomer('Bravo');
    const bravo = await textAlert(answered, { name: 'Bravo' });
    await staffText(answered, new Date(bravo.sentAt.getTime() + 3 * HOUR)); // a person's delivered text after the alert

    const replyBefore = await addCustomer('Charlie');
    const charlie = await textAlert(replyBefore, { name: 'Charlie' });
    await staffText(replyBefore, new Date(charlie.sentAt.getTime() - 3 * HOUR)); // a reply that came BEFORE the text

    const notContact = await addCustomer('Delta');
    await textAlert(notContact, { name: 'Delta', category: 'system', metadata: { triggerKey: 'ops_check', dedupeKey: `ops:${RUN}` } }); // not customer contact

    const reopened = await addCustomer('Echo');
    await textAlert(reopened, { name: 'Echo', closed: false }); // reopened: open again

    const internal = await addCustomer('Foxtrot');
    testCustomerId = internal.id;
    await textAlert(internal, { name: 'Foxtrot' }); // an internal test customer

    const stale = await addCustomer('Golf');
    await textAlert(stale, { name: 'Golf', sentDaysAgo: 12, closedDaysAgo: 8 }); // closed more than 7 days ago

    const taken = await addCustomer('Hotel');
    await textAlert(taken, { name: 'Hotel', closedBy: 'relevance' }); // another closer took it over

    const { out, names } = await listed();
    expect(names).toEqual(['Alpha', 'Charlie']);
    expect(out).toMatchObject({ kind: 'fell-off', capped: false, unchecked: false });
    const alpha = out.entries.find((e) => e.title.includes('Alpha'));
    expect(alpha.name).toBe(`Alpha Fell${RUN}`);
    expect(alpha.at.getTime()).toBeGreaterThan(ago(5.1).getTime());
    expect(out.count).toBe(out.entries.length);
  });

  test('a text that was not delivered, an automated text and a bare call row answer nothing', async () => {
    const customer = await addCustomer('India');
    const alert = await textAlert(customer, { name: 'India' });
    const after = new Date(alert.sentAt.getTime() + 2 * HOUR);
    await staffText(customer, after, { status: 'failed' }); // never delivered
    await staffText(customer, after, { message_type: 'auto_reply', metadata: JSON.stringify({}) }); // not a person's text
    // A bridge row: written before Twilio dials, no reviewed extraction, so no proof a person spoke with the customer.
    const [call] = await db('call_log').insert({
      direction: 'outbound', status: 'completed', source: 'admin-click', customer_id: customer.id, from_phone: '+15550000002', to_phone: customer.phone,
      duration_seconds: 120, created_at: after,
    }).returning('id');
    created.calls.push(call.id);
    expect((await listed()).names).toContain('India');
  });

  test('a call a person placed and spoke on answers it', async () => {
    const customer = await addCustomer('Juliet');
    const alert = await textAlert(customer, { name: 'Juliet' });
    const [call] = await db('call_log').insert({
      direction: 'outbound', status: 'completed', source: 'admin-click', customer_id: customer.id, from_phone: '+15550000002', to_phone: customer.phone,
      duration_seconds: 240, created_at: new Date(alert.sentAt.getTime() + 2 * HOUR), v2_extraction_status: 'valid',
      ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: 'false' } }),
    }).returning('id');
    created.calls.push(call.id);
    expect((await listed()).names).not.toContain('Juliet');
  });

  test('a ringing refresh moves the boundary: a reply before the latest ring does not answer the alert', async () => {
    const customer = await addCustomer('Kilo');
    const alert = await textAlert(customer, { name: 'Kilo', metadata: { rungAt: ago(3).toISOString() } });
    await staffText(customer, new Date(alert.sentAt.getTime() + 2 * HOUR)); // after the first text, before the refresh
    expect((await listed()).names).toContain('Kilo');
  });

  test('a text from a number with no customer on file is listed until a person replies to that number', async () => {
    const stranger = phone();
    const sid = `SM${RUN}${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const sentAt = ago(5);
    await addSms({ direction: 'inbound', from_phone: stranger, to_phone: '+15550000002', twilio_sid: sid, status: 'received', created_at: sentAt });
    const [row] = await db('notifications').insert({
      recipient_type: 'admin', category: 'inbound_sms', title: `SMS from Lima Fell${RUN}`, body: 'fixture', link: `/admin/communications?message=${sid}`,
      created_at: sentAt, done_at: ago(2), done_by: 'quiet-72h', resolution: 'No new activity for 3 days',
      metadata: JSON.stringify({ severity: 'needs-you', who: 'person', triggerKey: 'sms_reply', dedupeKey: `sms-reply:${sid}`, payload: { twilioSid: sid } }),
    }).returning('id');
    created.notifications.push(row.id);
    const first = await listed();
    expect(first.names).toContain('Lima');
    expect(first.out.entries.find((e) => e.title.includes('Lima')).name).toBe('');
    await addSms({
      direction: 'outbound', to_phone: stranger, twilio_sid: `SM${RUN}${randomUUID().replace(/-/g, '').slice(0, 20)}`, status: 'delivered',
      message_type: 'manual', metadata: JSON.stringify({ human_authored: 'true' }), created_at: new Date(sentAt.getTime() + 3 * HOUR),
    });
    expect((await listed()).names).not.toContain('Lima');
  });

  test('a declared customer contact outside the contact categories is judged by the customer, and a booked visit answers it', async () => {
    const customer = await addCustomer('Mike');
    const [row] = await db('notifications').insert({
      recipient_type: 'admin', category: 'schedule', title: `Reschedule note from Mike Fell${RUN}`, body: 'fixture', link: `/admin/customers/${customer.id}`,
      created_at: ago(5), done_at: ago(2), done_by: 'quiet-72h', resolution: 'No new activity for 3 days',
      metadata: JSON.stringify({ severity: 'needs-you', who: 'person', contact: true, customerId: customer.id }),
    }).returning('id');
    created.notifications.push(row.id);
    expect((await listed()).names).toContain('Reschedule note from Mike');
    // A visit booked for that customer after the alert answers it (the new-lead rule's live top-level booking).
    const [visit] = await db('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: '2026-11-10', service_type: `Fixture ${RUN}`, status: 'confirmed', created_at: ago(1),
    }).returning('id');
    created.visits.push(visit.id);
    expect((await listed()).names).not.toContain('Reschedule note from Mike');
  });

  test('a quote lookup that fails lists that alert, marks the week unchecked and leaves the other entries alone', async () => {
    const relevance = require('../services/admin-alert-relevance');
    const flaky = await addCustomer('Oscar');
    const [row] = await db('notifications').insert({
      recipient_type: 'admin', category: 'schedule', title: `Reschedule note from Oscar Fell${RUN}`, body: 'fixture', link: `/admin/customers/${flaky.id}`,
      created_at: ago(5), done_at: ago(2), done_by: 'quiet-72h', resolution: 'No new activity for 3 days',
      metadata: JSON.stringify({ severity: 'needs-you', who: 'person', contact: true, customerId: flaky.id }),
    }).returning('id');
    created.notifications.push(row.id);
    const plain = await addCustomer('Papa');
    await textAlert(plain, { name: 'Papa' });
    const answeredCustomer = await addCustomer('Quebec');
    const quebec = await textAlert(answeredCustomer, { name: 'Quebec' });
    await staffText(answeredCustomer, new Date(quebec.sentAt.getTime() + 3 * HOUR));
    const spy = jest.spyOn(relevance, 'quoteAnswered').mockRejectedValue(new Error('canceling statement due to statement timeout'));
    try {
      const { out, names } = await listed();
      expect(spy).toHaveBeenCalled();
      expect(out.unchecked).toBe(true);
      expect(names).toContain('Reschedule note from Oscar'); // listed, unchecked
      expect(names).toContain('Papa'); // a text alert never reads the quote witness
      expect(names).not.toContain('Quebec'); // still judged answered by its text
    } finally {
      spy.mockRestore();
    }
    expect((await listed()).out.unchecked).toBe(false);
  });

  test('the Monday text names the listed alerts and nothing else changes', async () => {
    const review = require('../services/monday-review-bell');
    const customer = await addCustomer('November');
    await textAlert(customer, { name: 'November' });
    const out = await fellOff.loadFellOffAlerts({ now: NOW });
    const [list] = review._private.buildLists({ alerts: out });
    expect(list.key).toBe('fellOff');
    expect(list.count).toBe(out.count);
    expect(list.detail).toContain(`SMS from November Fell${RUN} (`);
  });
});

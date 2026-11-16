/**
 * Monday review bell, list 1 as "customer alerts that fell off with no reply" (GATE_MONDAY_FELL_OFF_LINE; owner
 * 2026-11-05, decision D3) against live Postgres: the loader's SQL, the customer-contact test, the name read and the
 * relevance sweep's own verdicts (admin-alert-relevance.js classify / loadSubjects / subjectFor / judge) on real rows. Every fixture carries this run's marker,
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
  const created = { notifications: [], customers: [], sms: [], calls: [], visits: [], estimates: [] };
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
    restoreEnv();
    if (!db) return;
    if (created.notifications.length) await db('notifications').whereIn('id', created.notifications).del();
    if (created.sms.length) await db('sms_log').whereIn('id', created.sms).del();
    if (created.calls.length) await db('call_log').whereIn('id', created.calls).del();
    if (created.estimates.length) await db('estimates').whereIn('id', created.estimates).del();
    if (created.visits.length) await db('scheduled_services').whereIn('id', created.visits).del();
    if (created.customers.length) await db('customers').whereIn('id', created.customers).del();
  }, 60000);

  // Gates the sweep honors, set for one test and put back.
  const savedEnv = {};
  const setEnv = (name, value) => { if (!(name in savedEnv)) savedEnv[name] = process.env[name]; process.env[name] = value; };
  const restoreEnv = () => {
    for (const [name, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    for (const name of Object.keys(savedEnv)) delete savedEnv[name];
  };
  afterEach(restoreEnv);

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
      status: 'received', created_at: sentAt, message_body: 'Can someone call me back about my service please',
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
    direction: 'outbound', from_phone: '+15550000002', to_phone: customer.phone, customer_id: customer.id, twilio_sid: `SM${RUN}${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    status: 'delivered', message_type: 'manual', metadata: JSON.stringify({ human_authored: 'true' }), created_at: at, ...over,
  });

  // The list, reduced to this run's fixtures: the names that were listed.
  const listed = async () => {
    const out = await fellOff.loadFellOffAlerts({ now: NOW });
    return { out, names: out.entries.filter((e) => e.title.includes(`Fell${RUN}`)).map((e) => e.title.replace(` Fell${RUN}`, '').replace('SMS from ', '')).sort() };
  };

  const mine = (out) => out.entries.filter((e) => e.title.includes(`Fell${RUN}`));
  const insertAlert = async (over) => {
    const { metadata, ...rest } = over;
    const [row] = await db('notifications').insert({
      recipient_type: 'admin', body: 'fixture', created_at: ago(5), done_at: ago(2), done_by: 'quiet-72h', resolution: 'No new activity for 3 days',
      metadata: JSON.stringify({ severity: 'needs-you', who: 'person', ...metadata }), ...rest,
    }).returning('id');
    created.notifications.push(row.id);
    return row.id;
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
    expect(out).toMatchObject({ kind: 'fell-off', capped: false });
    // The sweep judged these by their witnesses, so none carries the unchecked mark.
    expect(mine(out).every((e) => e.unchecked === false)).toBe(true);
    const alpha = out.entries.find((e) => e.title.includes('Alpha'));
    expect(alpha.name).toBe(`Alpha Fell${RUN}`);
    expect(alpha.at.getTime()).toBeGreaterThan(ago(5.1).getTime());
    expect(out.count).toBe(out.entries.length);
  });

  test('a text a person answered is left out; an unanswered one is listed', async () => {
    const answered = await addCustomer('Uniform');
    const uniform = await textAlert(answered, { name: 'Uniform' });
    await staffText(answered, new Date(uniform.sentAt.getTime() + 3 * HOUR));
    await textAlert(await addCustomer('Victor'), { name: 'Victor' });
    const { names } = await listed();
    expect(names).toContain('Victor');
    expect(names).not.toContain('Uniform');
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

  describe('a portal chat hand-off that a reminder re-rang (GATE_PORTAL_CHAT_ANSWERED_CLOSE)', () => {
    // portal-late-rering.js bumps created_at for the reminder and keeps the original ask in metadata.askedAt, so a reply
    // between the two still counts. The sweep's boundary rule, not a second one here, decides.
    const chatAlert = (customer, name) => insertAlert({
      category: 'alert', title: `Portal chat from ${name} Fell${RUN}`, link: `/admin/customers/${customer.id}`, created_at: ago(3),
      metadata: {
        dedupeKey: `portal-chat-escalation:${RUN}-${name}`, doneWhen: 'customer_answered', topic: 'billing', contact: true,
        customerId: customer.id, askedAt: ago(5).toISOString(), lateReRungAt: ago(3).toISOString(),
      },
    });

    test('a reply between the original ask and the reminder answers it; one from before the ask does not', async () => {
      setEnv('GATE_PORTAL_CHAT_ANSWERED_CLOSE', 'true');
      const between = await addCustomer('Whiskey');
      await chatAlert(between, 'Whiskey');
      await staffText(between, ago(4)); // after askedAt (5 days ago), before the re-rung created_at (3 days ago)
      const before = await addCustomer('Xray');
      await chatAlert(before, 'Xray');
      await staffText(before, ago(6)); // before the ask
      const unanswered = await addCustomer('Yankee');
      await chatAlert(unanswered, 'Yankee');
      const { out } = await listed();
      const titles = mine(out).map((e) => e.title);
      expect(titles.some((t) => t.includes('Whiskey'))).toBe(false);
      expect(titles.some((t) => t.includes('Xray'))).toBe(true);
      expect(titles.some((t) => t.includes('Yankee'))).toBe(true);
      expect(mine(out).filter((e) => /Xray|Yankee/.test(e.title)).every((e) => e.unchecked === false)).toBe(true);
      // The date shown is the day the customer asked, not the reminder's.
      expect(out.entries.find((e) => e.title.includes('Yankee')).at.getTime()).toBe(ago(5).getTime());
    });

    test('with the class\'s own gate off the sweep does not judge it: listed, unchecked', async () => {
      setEnv('GATE_PORTAL_CHAT_ANSWERED_CLOSE', '');
      const customer = await addCustomer('Zulu');
      await chatAlert(customer, 'Zulu');
      await staffText(customer, ago(4));
      const entry = mine((await listed()).out).find((e) => e.title.includes('Zulu'));
      expect(entry).toMatchObject({ unchecked: true });
    });
  });

  test('a text from a number with no customer on file: judged only while its own gate is on, answered by a reply to that number', async () => {
    const stranger = phone();
    const sid = `SM${RUN}${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const sentAt = ago(5);
    await addSms({ direction: 'inbound', from_phone: stranger, to_phone: '+15550000002', twilio_sid: sid, status: 'received', created_at: sentAt, message_body: 'Please call me' });
    await insertAlert({
      category: 'inbound_sms', title: `SMS from Lima Fell${RUN}`, link: `/admin/communications?message=${sid}`, created_at: sentAt,
      metadata: { triggerKey: 'sms_reply', dedupeKey: `sms-reply:${sid}`, payload: { twilioSid: sid } },
    });
    // Its class is off: not judged, so it is listed and says so.
    const off = await listed();
    expect(off.names).toContain('Lima');
    expect(off.out.entries.find((e) => e.title.includes('Lima'))).toMatchObject({ name: '', unchecked: true });
    // Class on, nobody replied: listed, and checked.
    setEnv('GATE_PROMISE_PHONE_MATCH_CLOSE', 'true');
    const on = await listed();
    expect(on.out.entries.find((e) => e.title.includes('Lima'))).toMatchObject({ unchecked: false });
    await addSms({
      direction: 'outbound', from_phone: '+15550000002', to_phone: stranger, twilio_sid: `SM${RUN}${randomUUID().replace(/-/g, '').slice(0, 20)}`, status: 'delivered',
      message_type: 'manual', metadata: JSON.stringify({ human_authored: 'true' }), created_at: new Date(sentAt.getTime() + 3 * HOUR),
    });
    expect((await listed()).names).not.toContain('Lima');
  });

  test('a repeat-form alert is answered by an estimate handed over after the form, never by one handed over before', async () => {
    const quoted = await addCustomer('Mike');
    const earlier = await addCustomer('November');
    const bell = (customer, name) => insertAlert({
      category: 'lead', title: `Repeat form from ${name} Fell${RUN}`, created_at: ago(5),
      metadata: { dedupeKey: `lead-repeat-form:${customer.id}`, contact: true, customerId: customer.id, leadId: null },
    });
    await bell(quoted, 'Mike');
    await bell(earlier, 'November');
    const delivered = (at) => JSON.stringify({ deliveryState: { firstDeliveredAt: at.toISOString(), lastDeliveredAt: at.toISOString() } });
    for (const [customer, at] of [[quoted, ago(3)], [earlier, ago(6)]]) {
      const [estimate] = await db('estimates').insert({ status: 'sent', customer_id: customer.id, sent_at: at, estimate_data: delivered(at), created_at: ago(7) }).returning('id');
      created.estimates.push(estimate.id);
    }
    const titles = mine((await listed()).out).map((e) => e.title);
    expect(titles.some((t) => t.includes('Mike'))).toBe(false);
    expect(titles.some((t) => t.includes('November'))).toBe(true);
  });

  test('a customer contact no class judges (a missed call; a declared contact with no class) is listed with the unchecked mark', async () => {
    const customer = await addCustomer('Romeo');
    await insertAlert({
      category: 'missed_call', title: `Missed call from Romeo Fell${RUN}`, link: '/admin/communications',
      metadata: { triggerKey: 'customer_missed_call', customerId: customer.id },
    });
    await insertAlert({
      category: 'schedule', title: `Reschedule note from Sierra Fell${RUN}`, link: `/admin/customers/${customer.id}`,
      metadata: { contact: true, customerId: customer.id },
    });
    const { out } = await listed();
    const entries = mine(out).filter((e) => /Romeo|Sierra/.test(e.title));
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.unchecked === true)).toBe(true);
    expect(out.unchecked).toBe(true);
    expect(out.uncheckedCount).toBeGreaterThanOrEqual(2);
  });

  test('a subject load that fails lists every alert, unchecked, and the review still has its list', async () => {
    const customer = await addCustomer('Papa');
    await textAlert(customer, { name: 'Papa' });
    const answeredCustomer = await addCustomer('Quebec');
    const quebec = await textAlert(answeredCustomer, { name: 'Quebec' });
    await staffText(answeredCustomer, new Date(quebec.sentAt.getTime() + 3 * HOUR));
    const spy = jest.spyOn(require('../services/admin-alert-relevance'), 'loadSubjects').mockRejectedValue(new Error('canceling statement due to statement timeout'));
    try {
      const { out, names } = await listed();
      expect(spy).toHaveBeenCalled();
      expect(names).toEqual(expect.arrayContaining(['Papa', 'Quebec'])); // nothing could be checked, so nothing is hidden
      expect(mine(out).every((e) => e.unchecked === true)).toBe(true);
      expect(out.unchecked).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect((await listed()).names).not.toContain('Quebec');
  });

  test('the Monday text names the listed alerts and nothing else changes', async () => {
    const review = require('../services/monday-review-bell');
    const customer = await addCustomer('Oscar');
    await textAlert(customer, { name: 'Oscar' });
    const out = await fellOff.loadFellOffAlerts({ now: NOW });
    const [list] = review._private.buildLists({ alerts: out });
    expect(list.key).toBe('fellOff');
    expect(list.count).toBe(out.count);
    expect(list.detail).toContain(`SMS from Oscar Fell${RUN} (`);
  });
});

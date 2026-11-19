jest.mock('../models/db', () => jest.fn());

const { loadLeadReachStats, judgeReach, reachCohort, NOT_JUDGED } = require('../services/lead-reach-stats');

const T0 = new Date('2026-11-10T15:00:00Z').getTime();
const at = (minutes) => T0 + minutes * 60000;

function lead(id, extra = {}) {
  return {
    id, status: 'new', first_contact_at: new Date(T0).toISOString(),
    phone: `+1941555${String(id).padStart(4, '0')}`, email: null, twilio_call_sid: null, ...extra,
  };
}
const phoneKey = (l) => `phone:${l.phone.replace('+1', '')}`;
const none = { texts: [], calls: [], emails: [], estimates: [] };

describe('reachCohort', () => {
  test('drops spam, duplicate, disqualified, cancelled, handled and leads with no first-contact time', () => {
    const rows = ['new', 'contacted', 'won', 'lost', 'spam', 'duplicate', 'disqualified', 'cancelled', 'handled']
      .map((status, i) => lead(i + 1, { status }));
    rows.push(lead(99, { first_contact_at: null }));
    expect(reachCohort(rows).map((l) => l.status)).toEqual(['new', 'contacted', 'won', 'lost']);
  });
});

describe('judgeReach', () => {
  test('earliest person contact after first contact, in minutes; null when nobody reached the lead', () => {
    const a = lead(1);
    const b = lead(2);
    const c = lead(3);
    const result = judgeReach([a, b, c], {
      ...none,
      texts: [{ key: phoneKey(a), at: at(40) }, { key: phoneKey(a), at: at(7) }],
      calls: [{ key: phoneKey(b), sid: 'CA-other', at: at(3) }],
    });
    expect(result.get('1')).toBe(7);
    expect(result.get('2')).toBe(3);
    expect(result.get('3')).toBeNull();
  });

  test('a contact from before first contact does not count, except the call that created the lead', () => {
    const a = lead(1, { twilio_call_sid: 'CA-origin' });
    const b = lead(2, { twilio_call_sid: 'CA-origin-2' });
    const result = judgeReach([a, b], {
      ...none,
      texts: [{ key: phoneKey(b), at: at(-60) }],
      // A person answered the call that made lead 1: reached at once (0 minutes).
      calls: [{ key: phoneKey(a), sid: 'CA-origin', at: at(-2) }, { key: phoneKey(b), sid: 'CA-old', at: at(-30) }],
    });
    expect(result.get('1')).toBe(0);
    expect(result.get('2')).toBeNull();
  });

  test('an email to the lead address and a sent estimate count; an estimate on another lead does not', () => {
    const a = lead(1, { email: 'Pat.Fixture@Example.invalid' });
    const b = lead(2);
    const c = lead(3);
    const result = judgeReach([a, b, c], {
      ...none,
      emails: [{ key: 'email:pat.fixture@example.invalid', at: at(25) }],
      estimates: [{ leadId: '2', at: at(12) }, { leadId: '99', at: at(1) }],
    });
    expect(result.get('1')).toBe(25);
    expect(result.get('2')).toBe(12);
    expect(result.get('3')).toBeNull();
  });

  // Finding 2: a contact on a phone or email several leads share, or on another customer's contact
  // row, is not proof that THIS lead was reached.
  test('a shared phone or email does not credit any of the leads that share it', () => {
    const a = lead(1, { phone: '+19415550100', email: 'shared.fixture@example.invalid' });
    const b = lead(2, { phone: '+19415550100' });
    const c = lead(3, { email: 'shared.fixture@example.invalid' });
    const d = lead(4);
    const owners = new Map([
      ['phone:9415550100', new Set(['1', '2'])],
      ['email:shared.fixture@example.invalid', new Set(['1', '3'])],
    ]);
    const result = judgeReach([a, b, c, d], {
      ...none,
      owners,
      texts: [{ key: 'phone:9415550100', scope: 'phone', customerId: null, at: at(5) }, { key: phoneKey(d), scope: 'phone', customerId: null, at: at(6) }],
      emails: [{ key: 'email:shared.fixture@example.invalid', scope: 'email', customerId: null, at: at(8) }],
    });
    expect(result.get('1')).toBeNull();
    expect(result.get('2')).toBeNull();
    expect(result.get('3')).toBeNull();
    expect(result.get('4')).toBe(6); // an identity only this lead holds still counts
  });

  test('a contact row that belongs to a different customer does not count', () => {
    const a = lead(1, { customer_id: 'cust-a' });
    const b = lead(2, { customer_id: 'cust-b', phone: '+19415550102' });
    const c = lead(3, { customer_id: null, phone: '+19415550103' });
    const result = judgeReach([a, b, c], {
      ...none,
      texts: [
        { key: phoneKey(a), scope: 'phone', customerId: 'cust-other', at: at(4) },
        { key: phoneKey(b), scope: 'phone', customerId: 'cust-b', at: at(9) },
        { key: phoneKey(c), scope: 'phone', customerId: null, at: at(11) },
      ],
    });
    expect(result.get('1')).toBeNull();
    expect(result.get('2')).toBe(9);
    expect(result.get('3')).toBe(11);
  });

  // Finding 3: the originating call is found by its sid, not by the lead's current phone.
  test('an answered originating call counts when the lead gave a different callback number', () => {
    const a = lead(1, { twilio_call_sid: 'CA-origin', phone: '+19415550111' });
    const b = lead(2, { twilio_call_sid: 'CA-origin-b', phone: '+19415550112' });
    const result = judgeReach([a, b], {
      ...none,
      calls: [
        // The caller rang from another line; a person answered, 1 minute before first contact was stamped.
        { key: 'phone:9415550999', scope: 'phone', customerId: null, sid: 'CA-origin', at: at(-1) },
        // A call with another sid on an unrelated line is nobody's evidence.
        { key: 'phone:9415550998', scope: 'phone', customerId: null, sid: 'CA-stranger', at: at(2) },
      ],
    });
    expect(result.get('1')).toBe(0);
    expect(result.get('2')).toBeNull();
  });

  // Round 2, finding 1: a call the processor settled onto one lead is that lead's, whatever sid or phone says.
  test('a call settled onto another lead does not credit the lead that kept its sid; the assigned lead is credited', () => {
    const oldLead = lead(1, { twilio_call_sid: 'CA-moved' });
    const newLead = lead(2, { phone: '+19415550222' });
    const result = judgeReach([oldLead, newLead], {
      ...none,
      calls: [
        // Same call row: the old lead keeps the sid and the phone; the stamp points at lead 2, on a third number.
        { key: phoneKey(oldLead), scope: 'phone', customerId: null, sid: 'CA-moved', stampedTo: '2', at: at(-1) },
        { key: 'phone:9415550777', scope: 'phone', customerId: null, sid: 'CA-moved', stampedTo: '2', at: at(6) },
        // A call with no settled stamp still counts by phone.
        { key: phoneKey(oldLead), scope: 'phone', customerId: null, sid: 'CA-later', stampedTo: null, at: at(50) },
      ],
    });
    expect(result.get('1')).toBe(50);
    expect(result.get('2')).toBe(6);
  });

  // Round 2, finding 4: no record names who made each delivery.
  test('an automated estimate delivered again is not judged unless something else reached the lead in time', () => {
    const a = lead(1);
    const b = lead(2);
    const c = lead(3);
    const d = lead(4);
    const result = judgeReach([a, b, c, d], {
      ...none,
      texts: [{ key: phoneKey(c), scope: 'phone', customerId: null, at: at(5) }, { key: phoneKey(d), scope: 'phone', customerId: null, at: at(40) }],
      estimates: [
        { leadId: '1', at: at(2), automated: true, deliveries: 2, autoDeliveries: 1 }, // automated, then sent again by someone unknown
        { leadId: '2', at: at(2), automated: true, deliveries: 1, autoDeliveries: 1 }, // automated only: no person reached the lead
        { leadId: '3', at: at(2), automated: true, deliveries: 2, autoDeliveries: 1 }, // a person's text inside 15 minutes settles it
        { leadId: '4', at: at(2), automated: true, deliveries: 3, autoDeliveries: 1 }, // a later text does not
      ],
    });
    expect(result.get('1')).toBe(NOT_JUDGED);
    expect(result.get('2')).toBeNull();
    expect(result.get('3')).toBe(5);
    expect(result.get('4')).toBe(NOT_JUDGED);
  });

  // Round 3, finding 1: the moving job's overnight email and its recorded morning text are both known automation.
  test('only deliveries beyond the ones the automation records prove leave a lead not judged', () => {
    const a = lead(1);
    const b = lead(2);
    const result = judgeReach([a, b], {
      ...none,
      estimates: [
        { leadId: '1', at: at(2), automated: true, deliveries: 2, autoDeliveries: 2 }, // email + recorded morning text
        { leadId: '2', at: at(2), automated: true, deliveries: 3, autoDeliveries: 2 }, // one more nobody accounts for
      ],
    });
    expect(result.get('1')).toBeNull();
    expect(result.get('2')).toBe(NOT_JUDGED);
  });

  // Round 3, finding 2: a staff-bridge call row starts when the employee is rung, not when the customer answers.
  test('an outbound call is reached when the customer leg connected; with none, a call across the 15-minute edge is not judged', () => {
    const a = lead(1);
    const b = lead(2);
    const c = lead(3);
    const d = lead(4);
    const call = (l, fields) => ({ key: phoneKey(l), scope: 'phone', customerId: null, sid: null, stampedTo: null, spanEnd: null, ...fields });
    const result = judgeReach([a, b, c, d], {
      ...none,
      calls: [
        call(a, { at: at(16), spanEnd: null }), // started at 14, the customer leg connected at 16: later, not within
        call(b, { at: at(14), spanEnd: at(22) }), // no customer leg; started inside, ended outside: unknown
        call(c, { at: at(3), spanEnd: at(9) }), // started and ended inside: reached
        call(d, { at: at(20), spanEnd: at(30) }), // started after the window: later
      ],
    });
    expect(result.get('1')).toBe(16);
    expect(result.get('2')).toBe(NOT_JUDGED);
    expect(result.get('3')).toBe(9); // reached by the call's end at the latest
    expect(result.get('4')).toBe(30); // started after the window: later whatever the answer time
  });

  // Round 3, finding 3: one call, one owner: settled stamp, then the originating sid, then the phone.
  test('an originating call credits the lead that owns its sid, not an older lead on the caller phone', () => {
    const older = lead(1, { phone: '+19415550500', first_contact_at: new Date(at(-600)).toISOString() });
    const caller = lead(2, { phone: '+19415550501', twilio_call_sid: 'CA-origin-2' });
    const result = judgeReach([older, caller], {
      ...none,
      calls: [{ key: phoneKey(older), scope: 'phone', customerId: null, sid: 'CA-origin-2', stampedTo: null, at: at(-1) }],
    });
    expect(result.get('2')).toBe(0);
    expect(result.get('1')).toBeNull();
    // A settled stamp outranks the sid: the call goes to lead 1 alone.
    const stamped = judgeReach([older, caller], {
      ...none,
      calls: [{ key: phoneKey(older), scope: 'phone', customerId: null, sid: 'CA-origin-2', stampedTo: '1', at: at(4) }],
    });
    expect(stamped.get('1')).toBe(604);
    expect(stamped.get('2')).toBeNull();
  });

  // Round 4, finding 1: the sid's owner is read from all leads, so the answer does not move with the date range.
  test('a call whose sid belongs to a lead outside the cohort credits no cohort lead by phone', () => {
    const older = lead(1, { phone: '+19415550500' });
    const calls = [{ key: phoneKey(older), scope: 'phone', customerId: null, sid: 'CA-outside', stampedTo: null, at: at(5) }];
    const outside = new Map([['CA-outside', 'lead-outside-range']]);
    expect(judgeReach([older], { ...none, calls }, outside).get('1')).toBeNull();
    // With no known owner the phone still counts.
    expect(judgeReach([older], { ...none, calls }, new Map()).get('1')).toBe(5);
  });

  // Round 4, finding 2: an inbound call counts from when the staff phone accepted it.
  test('an inbound call that starts inside the window but is accepted after it is later; unknown answer time across the edge is not judged', () => {
    const a = lead(1);
    const b = lead(2);
    const c = lead(3);
    const call = (l, fields) => ({ key: phoneKey(l), scope: 'phone', customerId: null, sid: null, stampedTo: null, spanEnd: null, ...fields });
    const result = judgeReach([a, b, c], {
      ...none,
      calls: [
        call(a, { at: at(16) }), // callTiming already moved this call's time to forward_acceptance.accepted_at (minute 16)
        call(b, { at: at(14), spanEnd: at(30) }), // no acceptance stamp: answered somewhere in 14..30
        call(c, { at: at(20), spanEnd: at(40) }), // starts after the window: later whatever the answer time
      ],
    });
    expect(result.get('1')).toBe(16);
    expect(result.get('2')).toBe(NOT_JUDGED);
    expect(result.get('3')).toBe(40);
  });

  // Round 4, finding 3: uncertainty only matters when it could change the bucket.
  test('a resend after a proven late contact leaves the lead judged; one that could be inside the window does not', () => {
    const a = lead(1);
    const b = lead(2);
    const c = lead(3);
    const resend = (leadId, resendAt) => ({ leadId, at: at(30), automated: true, deliveries: 3, autoDeliveries: 1, resendAt });
    const result = judgeReach([a, b, c], {
      ...none,
      texts: [20, 20, 20].map((m, i) => ({ key: phoneKey([a, b, c][i]), scope: 'phone', customerId: null, at: at(m) })),
      estimates: [resend('1', at(60 * 24)), resend('2', at(10)), { ...resend('3', at(10)), autoDeliveries: 3 }],
    });
    expect(result.get('1')).toBe(20); // staff text at 20, every possible resend is later: later
    expect(result.get('2')).toBe(NOT_JUDGED); // a resend at minute 10 could have been the person's
    expect(result.get('3')).toBe(20); // all three deliveries are proven automated
  });
});

// A chainable stand-in for knex: every builder method returns the builder, awaiting it
// yields the rows registered for the table, and each table's chain is counted.
// A table's value may be a list of row lists: the first query on the table reads the first list, the
// second reads the next (`leads` is read twice: the linked estimates, then the identity owners).
function fakeConn(rowsByTable) {
  const calls = [];
  const queues = {};
  const conn = (table) => {
    const name = String(table).split(' ')[0];
    calls.push(name);
    const scripted = rowsByTable[name];
    const rows = Array.isArray(scripted?.queue) ? (scripted.queue[(queues[name] = (queues[name] ?? -1) + 1)] || []) : (scripted || []);
    const builder = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'then') return (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
        if (prop === 'whereRaw') return (sql) => { (conn.raws[name] = conn.raws[name] || []).push(String(sql)); return builder; };
        return () => builder;
      },
    });
    return builder;
  };
  conn.raw = (sql) => sql;
  conn.calls = calls;
  conn.raws = {};
  return conn;
}

describe('loadLeadReachStats', () => {
  test('counts reached within 15 minutes, reached later and never reached with one query per witness kind', async () => {
    const leads = [lead(1), lead(2), lead(3), lead(6), lead(4, { status: 'spam' }), lead(5, { status: 'disqualified' })];
    const conn = fakeConn({
      sms_log: [{ peer: leads[0].phone.replace('+1', ''), at: new Date(at(6)) }],
      call_log: [{ peer: leads[1].phone.replace('+1', ''), sid: 'CA-x', at: new Date(at(90)) }],
      emails: [],
      // The estimates read: a linked estimate's first real delivery.
      estimates: [{ id: 'e1', linked_lead_id: leads[2].id, at: new Date(at(4)).toISOString(), automated: false, deliveries: 1 }],
      // The identity read: other open leads sharing identity.
      leads: [],
    });
    const stats = await loadLeadReachStats(leads, { conn });
    expect(stats).toEqual({ cohort: 4, reachedWithin: 2, reachedLater: 1, neverReached: 1, notJudged: 0, withinMinutes: 15 });
    // Batched: one query per kind for the whole cohort (the leads have no email, so none for email). The two leads
    // reads are the identity owners and the leads that originated the calls' sids (from all leads, not the cohort).
    expect(conn.calls.sort()).toEqual(['call_log', 'estimates', 'leads', 'leads', 'sms_log']);
  });

  // Finding 1: the estimate witness is the first REAL delivery. A suppressed send, a website
  // self-service publication and the lead's 'estimate_sent' activity row (written even when every
  // channel was suppressed) all leave deliveryState.firstDeliveredAt empty or are not read at all.
  test('estimate evidence is the first real delivery by a person, not an activity row or sent_at', async () => {
    const conn = fakeConn({});
    await loadLeadReachStats([lead(1)], { conn });
    expect(conn.calls).not.toContain('lead_activities');
    const sql = conn.raws.estimates.join(' | ');
    expect(sql).toContain("deliveryState,firstDeliveredAt}' IS NOT NULL");
    expect(sql).not.toContain('sent_at');
  });

  test('a phone another open lead holds does not credit the cohort lead', async () => {
    const mine = lead(1);
    const conn = fakeConn({
      sms_log: [{ peer: mine.phone.replace('+1', ''), customer_id: null, at: new Date(at(3)) }],
      // The identity read finds a second open lead on the same phone.
      leads: [{ id: 'other-open', customer_id: null, email: null, peer: mine.phone.replace('+1', '') }],
    });
    const stats = await loadLeadReachStats([mine], { conn });
    expect(stats).toMatchObject({ cohort: 1, reachedWithin: 0, reachedLater: 0, neverReached: 1 });
  });

  // Round 2, finding 2: office mail leaves emails.customer_id empty, so the owner is read from the
  // thread and the recipients, for the whole batch.
  test('an outbound email in another customer\'s thread does not credit a lead with the same address', async () => {
    const addr = 'pat.fixture@example.invalid';
    const mine = lead(1, { email: addr, phone: '+19415550301', customer_id: 'cust-b' });
    const sent = { id: 'm1', gmail_thread_id: 't1', to_address: addr, cc_address: '', bcc_address: '', customer_id: null, at: new Date(at(5)) };
    const run = (threadCustomer, customers = []) => loadLeadReachStats([mine], {
      conn: fakeConn({
        emails: { queue: [[sent], [{ id: 'in1', gmail_thread_id: 't1', customer_id: threadCustomer }]] },
        customers,
      }),
    });
    expect(await run('cust-a')).toMatchObject({ reachedWithin: 0, neverReached: 1 });
    expect(await run('cust-b')).toMatchObject({ reachedWithin: 1, neverReached: 0 });
    // The thread says one customer and the recipient address another: ambiguous, never a guess.
    expect(await run('cust-b', [{ id: 'cust-c', address: addr }])).toMatchObject({ reachedWithin: 0, neverReached: 1 });
  });

  // Round 2, finding 3: the public-quote mirror carries the lead id only in estimate_data.lead_id.
  test('an estimate named by estimate_data.lead_id counts under the ownership checks', async () => {
    const named = lead(1, { phone: '+19415550401', email: 'pat.fixture@example.invalid' });
    const linkedElsewhere = lead(2, { phone: '+19415550402', estimate_id: 'e-other' });
    const wrongContact = lead(3, { phone: '+19415550403' });
    const delivered = new Date(at(3)).toISOString();
    const row = (leadId, extra = {}) => ({
      id: `e-${leadId}`, customer_id: null, customer_phone: '(941) 555-0401', customer_email: null,
      linked_lead_id: null, data_lead_id: String(leadId), at: delivered, automated: false, deliveries: 1, ...extra,
    });
    const conn = fakeConn({
      estimates: [
        row(1),
        row(2, { customer_phone: '(941) 555-0402' }), // named lead already belongs to another estimate
        row(3), // the estimate's contact is not this lead's
      ],
    });
    const stats = await loadLeadReachStats([named, linkedElsewhere, wrongContact], { conn });
    expect(stats).toMatchObject({ cohort: 3, reachedWithin: 1, neverReached: 2 });
  });

  test('a lead whose only estimate was automated and then sent again is left out of every count', async () => {
    const conn = fakeConn({
      estimates: [{ id: 'e1', linked_lead_id: 1, at: new Date(at(2)).toISOString(), automated: true, auto_deliveries: 1, deliveries: 2 }],
    });
    const stats = await loadLeadReachStats([lead(1), lead(2)], { conn });
    expect(stats).toEqual({ cohort: 1, reachedWithin: 0, reachedLater: 0, neverReached: 1, notJudged: 1, withinMinutes: 15 });
  });

  test('a moving estimate emailed and then texted by the app is counted as never reached, not left out', async () => {
    const conn = fakeConn({
      estimates: [{ id: 'e1', linked_lead_id: 1, at: new Date(at(2)).toISOString(), automated: true, auto_deliveries: 2, deliveries: 2 }],
    });
    const stats = await loadLeadReachStats([lead(1)], { conn });
    expect(stats).toMatchObject({ cohort: 1, neverReached: 1, notJudged: 0 });
  });

  // Round 3, finding 4: the stamped-call lookup does not depend on which other leads are in the window.
  test('an email-only lead is reached by a later call the processor settled onto it', async () => {
    const mine = lead(7, { phone: null, email: 'pat.fixture@example.invalid' });
    const conn = fakeConn({
      call_log: [{ peer: '9415550999', sid: 'CA-later', at: new Date(at(5)), direction: 'inbound', stamp_lead_id: '7', settled: true, customer_id: null }],
    });
    const stats = await loadLeadReachStats([mine], { conn });
    expect(conn.calls).toContain('call_log');
    expect(stats).toMatchObject({ cohort: 1, reachedWithin: 1, neverReached: 0 });
  });

  // Round 3, finding 5: the SEO outreach job sends from the same Gmail account and stores each pitch's thread.
  test('the sent-email read leaves out the SEO outreach job\'s Gmail threads', async () => {
    const conn = fakeConn({});
    await loadLeadReachStats([lead(1, { email: 'pat.fixture@example.invalid' })], { conn });
    const sql = conn.raws.emails.join(' | ');
    expect(sql).toContain('seo_link_prospects');
    expect(sql).toContain('outreach_thread_ref IN (er.gmail_thread_id, er.gmail_id)');
  });

  test('a call whose sid another lead originated, read from all leads, credits no one by phone', async () => {
    const older = lead(1);
    const conn = fakeConn({
      call_log: [{ peer: older.phone.replace('+1', ''), sid: 'CA-theirs', at: new Date(at(5)), direction: 'inbound', settled: true }],
      // 1st read: shared identity; 2nd read: the sid's owner, a lead outside the cohort.
      leads: { queue: [[], [{ id: 'outside', twilio_call_sid: 'CA-theirs' }]] },
    });
    expect(await loadLeadReachStats([older], { conn })).toMatchObject({ reachedWithin: 0, neverReached: 1 });
  });

  test('an inbound call is timed from the staff acceptance; with none and an answer window across the edge it is left out', async () => {
    const accepted = new Date(at(16)).toISOString();
    const run = (row) => loadLeadReachStats([lead(1)], { conn: fakeConn({ call_log: [{ peer: lead(1).phone.replace('+1', ''), direction: 'inbound', at: new Date(at(14)), ...row }] }) });
    expect(await run({ ended_at: new Date(at(30)), accepted: 'true', accepted_at: accepted })).toMatchObject({ reachedLater: 1, notJudged: 0 });
    expect(await run({ ended_at: new Date(at(30)) })).toMatchObject({ cohort: 0, notJudged: 1 });
    expect(await run({ ended_at: new Date(at(20)) })).toMatchObject({ reachedWithin: 0, notJudged: 1 });
    expect(await run({ ended_at: new Date(at(14.5)) })).toMatchObject({ reachedWithin: 1 });
  });

  // Round 4, finding 4: resolveEmailCustomerLink's own guard, shared.
  test('a sent email whose Cc/Bcc were never captured is no evidence', async () => {
    const addr = 'pat.fixture@example.invalid';
    const mine = lead(1, { email: addr, phone: '+19415550301' });
    const sent = (extra) => ({ id: 'm1', gmail_thread_id: 't1', to_address: addr, cc_address: '', bcc_address: '', customer_id: null, at: new Date(at(5)), ...extra });
    const run = (row) => loadLeadReachStats([mine], { conn: fakeConn({ emails: { queue: [[row], []] } }) });
    expect(await run(sent())).toMatchObject({ reachedWithin: 1 });
    expect(await run(sent({ cc_address: null }))).toMatchObject({ reachedWithin: 0, neverReached: 1 });
    expect(await run(sent({ bcc_address: null }))).toMatchObject({ reachedWithin: 0, neverReached: 1 });
  });

  test('an empty cohort runs no query', async () => {
    const conn = fakeConn({});
    const stats = await loadLeadReachStats([lead(1, { status: 'spam' })], { conn });
    expect(stats.cohort).toBe(0);
    expect(conn.calls).toEqual([]);
  });
});

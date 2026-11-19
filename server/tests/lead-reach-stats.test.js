jest.mock('../models/db', () => jest.fn());

const { loadLeadReachStats, judgeReach, reachCohort } = require('../services/lead-reach-stats');

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
      // 1st read: the linked estimates' first real delivery; 2nd read: other open leads sharing identity.
      leads: { queue: [[{ lead_id: leads[2].id, at: new Date(at(4)).toISOString() }], []] },
    });
    const stats = await loadLeadReachStats(leads, { conn });
    expect(stats).toEqual({ cohort: 4, reachedWithin: 2, reachedLater: 1, neverReached: 1, withinMinutes: 15 });
    // Batched: one query per kind for the whole cohort (the leads have no email, so none for email).
    expect(conn.calls.sort()).toEqual(['call_log', 'leads', 'leads', 'sms_log']);
  });

  // Finding 1: the estimate witness is the first REAL delivery. A suppressed send, a website
  // self-service publication and the lead's 'estimate_sent' activity row (written even when every
  // channel was suppressed) all leave deliveryState.firstDeliveredAt empty or are not read at all.
  test('estimate evidence is the first real delivery by a person, not an activity row or sent_at', async () => {
    const conn = fakeConn({ leads: { queue: [[], []] } });
    await loadLeadReachStats([lead(1)], { conn });
    expect(conn.calls).not.toContain('lead_activities');
    const sql = conn.raws.leads.join(' | ');
    expect(sql).toContain("deliveryState,firstDeliveredAt}' IS NOT NULL");
    expect(sql).toContain("'automation'->'autoSend'->>'result'");
    expect(sql).toContain("'automation'->'moveAutoSend'->>'result'");
    expect(sql).not.toContain('sent_at');
  });

  test('a phone another open lead holds does not credit the cohort lead', async () => {
    const mine = lead(1);
    const conn = fakeConn({
      sms_log: [{ peer: mine.phone.replace('+1', ''), customer_id: null, at: new Date(at(3)) }],
      // The identity read finds a second open lead on the same phone.
      leads: { queue: [[], [{ id: 'other-open', customer_id: null, email: null, peer: mine.phone.replace('+1', '') }]] },
    });
    const stats = await loadLeadReachStats([mine], { conn });
    expect(stats).toMatchObject({ cohort: 1, reachedWithin: 0, reachedLater: 0, neverReached: 1 });
  });

  test('an empty cohort runs no query', async () => {
    const conn = fakeConn({});
    const stats = await loadLeadReachStats([lead(1, { status: 'spam' })], { conn });
    expect(stats.cohort).toBe(0);
    expect(conn.calls).toEqual([]);
  });
});

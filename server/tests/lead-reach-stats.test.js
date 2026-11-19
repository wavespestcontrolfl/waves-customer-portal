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
});

// A chainable stand-in for knex: every builder method returns the builder, awaiting it
// yields the rows registered for the table, and each table's chain is counted.
function fakeConn(rowsByTable) {
  const calls = [];
  const conn = (table) => {
    const name = String(table).split(' ')[0];
    calls.push(name);
    const builder = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'then') return (resolve, reject) => Promise.resolve(rowsByTable[name] || []).then(resolve, reject);
        return () => builder;
      },
    });
    return builder;
  };
  conn.raw = (sql) => sql;
  conn.calls = calls;
  return conn;
}

describe('loadLeadReachStats', () => {
  test('counts reached within 15 minutes, reached later and never reached with one query per witness kind', async () => {
    const leads = [lead(1), lead(2), lead(3), lead(6), lead(4, { status: 'spam' }), lead(5, { status: 'disqualified' })];
    const conn = fakeConn({
      sms_log: [{ peer: leads[0].phone.replace('+1', ''), at: new Date(at(6)) }],
      call_log: [{ peer: leads[1].phone.replace('+1', ''), sid: 'CA-x', at: new Date(at(90)) }],
      emails: [],
      lead_activities: [],
      leads: [{ lead_id: leads[2].id, at: new Date(at(4)) }], // the linked estimate's send time
    });
    const stats = await loadLeadReachStats(leads, { conn });
    expect(stats).toEqual({ cohort: 4, reachedWithin: 2, reachedLater: 1, neverReached: 1, withinMinutes: 15 });
    // Batched: one query per kind for the whole cohort (the leads have no email, so none for email).
    expect(conn.calls.sort()).toEqual(['call_log', 'lead_activities', 'leads', 'sms_log']);
  });

  test('an empty cohort runs no query', async () => {
    const conn = fakeConn({});
    const stats = await loadLeadReachStats([lead(1, { status: 'spam' })], { conn });
    expect(stats.cohort).toBe(0);
    expect(conn.calls).toEqual([]);
  });
});

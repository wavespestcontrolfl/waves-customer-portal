/**
 * services/review-link-candidates.js — the one reader behind the Reviews match queue and the
 * read-only audit. Pins the customer filter (a subset binds every id in every query, including the
 * follow-up log subquery; an empty subset reads nothing; no subset reads everyone) and that rows
 * group by customer id as text, so a uuid object and its string meet. All names are synthetic.
 */
const { loadEvidenceRows, buildCandidates } = require('../services/review-link-candidates');

function fakeConn() {
  const calls = [];
  return {
    calls,
    raw: async (sql, bindings = []) => { calls.push({ sql, bindings }); return { rows: [] }; },
  };
}

describe('loadEvidenceRows', () => {
  test('a customer subset binds its ids in every query, the follow-up log subquery included', async () => {
    const conn = fakeConn();
    await loadEvidenceRows(conn, { customerIds: ['c1', 'c2'] });
    expect(conn.calls).toHaveLength(5);
    for (const { sql, bindings } of conn.calls) {
      const lists = sql.match(/IN \(\?, \?\)/g) || [];
      expect(lists.length).toBeGreaterThan(0);
      // The customers query binds the sandbox call source first (its first-call subquery).
      const sandbox = sql.includes('FROM call_log') ? ['voice_relay_sandbox'] : [];
      expect(bindings).toEqual([...sandbox, ...lists.flatMap(() => ['c1', 'c2'])]);
    }
    const asks = conn.calls.find(({ sql }) => sql.includes('FROM review_requests rr'));
    expect(asks.sql).toMatch(/messaging_audit_log[\s\S]*customer_id IN \(\?, \?\)[\s\S]*GROUP BY/);
  });

  test('every customer when no subset is given; nothing when the subset is empty', async () => {
    const all = fakeConn();
    await loadEvidenceRows(all);
    expect(all.calls.every(({ sql }) => !/ IN \(\?/.test(sql))).toBe(true);
    expect(all.calls.map(({ bindings }) => bindings)).toEqual([['voice_relay_sandbox'], [], [], [], []]);
    const none = fakeConn();
    await loadEvidenceRows(none, { customerIds: [] });
    expect(none.calls.every(({ sql }) => sql.includes(' AND false'))).toBe(true);
  });
});

describe('buildCandidates', () => {
  test('groups activity by customer id as text', () => {
    const id = { toString: () => 'c1' };
    const [candidate] = buildCandidates({
      customers: [{ id: 'c1', first_name: 'Marlow', last_name: 'Pemberton', service_contact_name: 'Gwen', active: false }],
      visits: [{ customer_id: id, on_day: '2026-10-10' }],
      asks: [{ customer_id: 'c1', sms_sent_at: '2026-10-11T15:00:00Z' }],
      taps: [],
      texts: [{ customer_id: 'c1', at: '2026-10-12T15:00:00Z', body: 'Just left you a review!' }, { customer_id: 'c1', at: '2026-10-12T16:00:00Z', body: 'Is the review link broken?' }],
    });
    expect(candidate).toMatchObject({
      customerId: 'c1',
      active: false,
      contacts: ['Gwen'],
      activity: { visitsOn: ['2026-10-10'], asksAt: ['2026-10-11T15:00:00Z'], inboundTexts: [{ body: 'Just left you a review!' }] },
    });
    expect(candidate.activity.inboundTexts).toHaveLength(1);
  });
});

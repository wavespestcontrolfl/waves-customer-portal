/**
 * "Why we win and lose" weekly bell (owner ruling 2026-11-25). Synthetic leads only: no real
 * names or quotes. Proves the Eastern week window, the counts and plain-English labels, the
 * composed alert under the real composer rules, no-leads / dedupe / fail-open behavior, and that
 * every code the nightly filler writes has a plain label.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(), _private: {}, safeErrorSummary: jest.fn(() => 'err') }));
jest.mock('../services/admin-alert-episodes', () => ({ openAdminAlertKeys: jest.fn(), closeAdminAlertKeys: jest.fn() }));
jest.mock('../services/call-commitments', () => ({ listOpenCommitments: jest.fn() }));

const { notifyAdmin } = require('../services/notification-service');
const episodes = require('../services/admin-alert-episodes');
const { listOpenCommitments } = require('../services/call-commitments');
const logger = require('../services/logger');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const { SWITCH_REASONS, NOT_BOOKED_REASONS } = require('../services/lead-why-fill');
const weekly = require('../services/lead-why-weekly');

const {
  reportWeek, topCounts, summarizeWeek, composeWeekly, loadOwedLeads, owedLine, SWITCH_LABELS, NOT_BOOKED_LABELS, REPLACED,
} = weekly._private;

// Monday 2026-11-23, 8:15 AM EST. The week reported is Mon Nov 16 to Sun Nov 22.
const MONDAY = new Date('2026-11-23T13:15:00Z');
const lead = (id, o = {}) => ({
  id, status: 'contacted', created_at: '2026-11-18T15:00:00Z', switch_reason: null, previous_company: null, not_booked_reason: null, ...o,
});
const WEEK = [
  lead('L1', { status: 'won', switch_reason: 'price_creep', previous_company: 'Orkin' }),
  lead('L2', { status: 'won', switch_reason: 'price_creep', previous_company: 'Orkin' }),
  lead('L3', { status: 'lost', switch_reason: 'no_show', previous_company: 'Terminix', not_booked_reason: 'price' }),
  lead('L4', { status: 'unresponsive', not_booked_reason: 'no_response' }),
  lead('L5', { status: 'contacted', not_booked_reason: 'timing', switch_reason: 'moved' }),
  lead('L6', { status: 'new' }),
];

beforeEach(() => {
  jest.clearAllMocks();
  notifyAdmin.mockResolvedValue({ id: 'n1' });
  episodes.openAdminAlertKeys.mockResolvedValue([]);
  episodes.closeAdminAlertKeys.mockResolvedValue(1);
});

describe('reportWeek (Eastern, Monday to Sunday)', () => {
  test('a Monday morning reports the week that just ended', () => {
    const w = reportWeek(MONDAY);
    expect(w.start).toBe('2026-11-16');
    expect(w.sunday).toBe('2026-11-22');
    expect(w.from.toISOString()).toBe('2026-11-16T05:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-11-23T05:00:00.000Z');
  });
  test('the week crosses the November clock change correctly', () => {
    // Monday Nov 2, 2026 8:15 AM EST; the clocks went back Nov 1, so the week began in EDT.
    const w = reportWeek(new Date('2026-11-02T13:15:00Z'));
    expect(w.start).toBe('2026-10-26');
    expect(w.from.toISOString()).toBe('2026-10-26T04:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });
});

describe('counts', () => {
  test('topCounts: most common first, ties by name, blanks skipped, top 3', () => {
    const rows = ['b', 'a', 'b', ' ', null, 'c', 'a', 'd'].map((v) => ({ f: v }));
    expect(topCounts(rows, 'f')).toEqual([{ value: 'a', count: 2 }, { value: 'b', count: 2 }, { value: 'c', count: 1 }]);
  });
  test('summarizeWeek: wins, not booked (lost / unresponsive only), the rest; loss reasons from the same leads', () => {
    const s = summarizeWeek(WEEK, []);
    // L5 is open with a stale reason: neither not booked nor counted as a loss reason.
    expect(s).toMatchObject({ total: 6, won: 2, notBooked: 2, other: 2, switchKnown: 4, rivalsKnown: 3, notBookedKnown: 2 });
    expect(s.switchReasons[0]).toEqual({ value: 'price_creep', count: 2 });
    expect(s.rivals[0]).toEqual({ value: 'Orkin', count: 2 });
  });
  test('a won lead with a stale not-booked reason is still a win, never both', () => {
    const s = summarizeWeek([lead('W', { status: 'won', not_booked_reason: 'price' })], []);
    expect(s).toMatchObject({ won: 1, notBooked: 0, notBookedKnown: 0, notBookedReasons: [] });
  });
  test('a lost lead that converted is not counted as not booked', () => {
    const s = summarizeWeek([lead('C', { status: 'lost', converted_at: '2026-11-19T15:00:00Z', not_booked_reason: 'price' })], []);
    expect(s).toMatchObject({ notBooked: 0, notBookedKnown: 0 });
  });
});

describe('the card', () => {
  const week = reportWeek(MONDAY);
  const { spec, detail } = composeWeekly(week, summarizeWeek(WEEK, [{ id: 'L3', created_at: '2026-11-18T15:00:00Z' }]));

  test('passes the real composer rules and stays within the headline and why limits', () => {
    const alert = composeAdminAlert(spec);
    expect(alert.headline).toBe('Leads — read why we win and lose, week of Nov 16');
    expect(alert.headline.length).toBeLessThanOrEqual(60);
    expect(alert.why).toBe('6 new leads, 2 won, 2 not booked; top switch reason: price kept going up; 1 promised follow-up still owed.');
    expect(alert.metadata).toMatchObject({ area: 'Leads', severity: 'needs-you', who: 'person', doneWhen: 'reviewed' });
  });

  test('the detail uses plain words, counts, coverage and the owed list; no codes', () => {
    expect(detail).toContain('Leads: 6. Won: 2. Not booked: 2. Still open or closed another way: 2.');
    expect(detail).toContain('Why they left their last company (4 of 6 leads): price kept going up 2, moved house 1, old company missed visits 1.');
    expect(detail).toContain('Companies they are leaving (3 of 6 leads): Orkin 2, Terminix 1.');
    expect(detail).toContain('Why they did not book (2 of 2 leads): never answered us 1, price too high 1.');
    expect(detail).toContain('still owed: 1 lead - L3 (Nov 18).');
    expect(detail).not.toMatch(/price_creep|no_response|pests_came_back/);
  });

  test('empty lists say so; an unreadable promise read leaves its line out', () => {
    const empty = composeWeekly(week, summarizeWeek([lead('A', { status: 'won' })], null)).detail;
    expect(empty).toContain('Why they left their last company: nothing recorded yet (0 of 1 leads).');
    expect(empty).not.toContain('promised and still owed');
    expect(owedLine([])).toBe('Quote or callback promised and still owed: none.');
  });

  test('a long owed list is capped and says how many more', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ id: `L${i}`, created_at: '2026-11-18T15:00:00Z' }));
    expect(owedLine(many)).toMatch(/13 leads - .*L9 \(Nov 18\), and 3 more\.$/);
  });

  test('every code the nightly filler writes has a plain label', () => {
    expect(Object.keys(SWITCH_LABELS).sort()).toEqual([...SWITCH_REASONS].sort());
    expect(Object.keys(NOT_BOOKED_LABELS).sort()).toEqual([...NOT_BOOKED_REASONS].sort());
  });
});

describe('loadOwedLeads: the Owed queue read, per lead', () => {
  test('counts a lead only with an overdue, non-quiet promise; won leads are read too', async () => {
    listOpenCommitments.mockImplementation(async (_c, { leadId }) => ({
      L1: [{ overdue: true, quiet_call: false }],
      L3: [{ overdue: true, quiet_call: false }],
      L4: [{ overdue: false, quiet_call: false }],
      L5: [{ overdue: true, quiet_call: true }],
      L6: [],
    })[leadId] || []);
    const owed = await loadOwedLeads({}, WEEK);
    expect(owed.map((l) => l.id)).toEqual(['L1', 'L3']);
    expect(listOpenCommitments).toHaveBeenCalledWith({}, expect.objectContaining({ party: 'waves', kinds: ['send_estimate', 'callback'] }));
  });
  test('a full page of quiet promises does not hide an owed one on the next page', async () => {
    const quiet = Array.from({ length: 20 }, () => ({ overdue: true, quiet_call: true }));
    listOpenCommitments.mockImplementation(async (_c, { offset }) => (offset === 0 ? quiet : [{ overdue: true, quiet_call: false }]));
    const owed = await loadOwedLeads({}, [lead('Q')]);
    expect(owed.map((l) => l.id)).toEqual(['Q']);
    expect(listOpenCommitments).toHaveBeenCalledWith({}, expect.objectContaining({ offset: 20 }));
  });
  test('fails open: a broken read gives null and a warning', async () => {
    listOpenCommitments.mockRejectedValue(new Error('boom'));
    expect(await loadOwedLeads({}, WEEK)).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});

// A chainable knex stand-in that resolves to the next page at each .select().
function connWith(rows, pages = [rows]) {
  const q = {};
  for (const m of ['whereNull', 'where', 'whereNotIn', 'whereRaw', 'orderBy', 'limit']) q[m] = jest.fn(() => q);
  q.modify = jest.fn((fn) => { fn(q); return q; });
  let i = 0;
  q.select = jest.fn(async () => pages[i++] || []);
  const conn = jest.fn(() => q);
  conn.raw = jest.fn((sql) => sql);
  conn.q = q;
  return conn;
}

describe('runLeadWhyWeekly', () => {
  const owed = async () => [];

  test('a week with no leads raises nothing', async () => {
    const out = await weekly.runLeadWhyWeekly({ now: MONDAY, conn: connWith([]), loadOwed: owed });
    expect(out).toEqual({ leads: 0, outcome: 'no_leads' });
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('raises one bell-ringing row keyed on the week, with the detail, and closes older rows', async () => {
    episodes.openAdminAlertKeys.mockResolvedValue(['lead-why-weekly:2026-11-09', 'lead-why-weekly:2026-11-16']);
    const conn = connWith(WEEK);
    const out = await weekly.runLeadWhyWeekly({ now: MONDAY, conn, loadOwed: owed });
    expect(out).toEqual({ leads: 6, outcome: 'raised' });
    expect(conn.q.where).toHaveBeenCalledWith('leads.created_at', '>=', expect.any(Date));
    // scopeToProspects: the non-engaged statuses plus the won-repeat checks.
    expect(conn.q.whereNotIn).toHaveBeenCalledWith('leads.status', expect.arrayContaining(['duplicate', 'spam']));
    expect(conn.q.whereRaw).toHaveBeenCalled();
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = notifyAdmin.mock.calls[0];
    expect(category).toBe('system');
    expect(title).toBe('Leads — read why we win and lose, week of Nov 16');
    expect(body.length).toBeLessThanOrEqual(110);
    expect(opts).toMatchObject({ dedupeKey: 'lead-why-weekly:2026-11-16', bell: true, link: '/admin/leads' });
    expect(opts).not.toHaveProperty('dedupeOpenOnly');
    expect(opts.detail).toContain('Leads: 6.');
    expect(JSON.stringify(opts)).not.toMatch(/customer_id|first_name|last_name/);
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(conn, ['lead-why-weekly:2026-11-09'], 'replaced', expect.objectContaining({ resolution: REPLACED }));
  });

  test('a rerun that dedupes writes nothing new but still closes older weeks, never a newer one', async () => {
    notifyAdmin.mockResolvedValue({ id: 'n1', deduped: true });
    episodes.openAdminAlertKeys.mockResolvedValue(['lead-why-weekly:2026-11-09', 'lead-why-weekly:2026-11-16', 'lead-why-weekly:2026-11-23']);
    const conn = connWith(WEEK);
    const out = await weekly.runLeadWhyWeekly({ now: MONDAY, conn, loadOwed: owed });
    expect(out.outcome).toBe('unchanged');
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(conn, ['lead-why-weekly:2026-11-09'], 'replaced', expect.anything());
  });

  test('a week bigger than one page is counted in full', async () => {
    const big = Array.from({ length: 500 }, (_, i) => lead(`B${i}`));
    const out = await weekly.runLeadWhyWeekly({ now: MONDAY, conn: connWith(null, [big, [lead('LAST', { status: 'won' })]]), loadOwed: owed });
    expect(out.leads).toBe(501);
  });

  test('a failed promise read still sends the card, without that line', async () => {
    await weekly.runLeadWhyWeekly({ now: MONDAY, conn: connWith(WEEK), loadOwed: async () => null });
    expect(notifyAdmin.mock.calls[0][3].detail).not.toContain('promised and still owed');
  });
});

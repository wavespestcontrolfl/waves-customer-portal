/**
 * Stale-rule check (server/services/stale-rule-check.js): hold bells that keep being handled by hand flag a rule that may be out
 * of date. Pure grouping and the weekly run against a fake loader; the bell write is the composer plus a mocked
 * NotificationService.notifyAdmin, so the dedupe key and the copy rules are what is under test.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => {
  const real = jest.requireActual('../services/notification-service');
  return Object.assign(Object.create(real), { notifyAdmin: jest.fn(), _private: real._private });
});

const NotificationService = require('../services/notification-service');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const check = require('../services/stale-rule-check');

const { normalizeTitle, isHoldBell, flagGroups, isoWeekKey, composeRuleCheck, loadBells } = check._private;

const HOLD = 'Completed first visit needs manual billing — setup fee was never invoiced';
const PERSON = '11111111-2222-4333-8444-555555555555';
let n = 0;
const bell = (over = {}) => {
  n += 1;
  return {
    id: `row-${n}`, category: 'billing', title: HOLD, body: 'Bill it by hand.', dedupe_key: `k${n}`,
    created_at: new Date(Date.UTC(2026, 10, 1 + (n % 20), 15)), done_at: new Date(Date.UTC(2026, 10, 2 + (n % 20), 15)), done_by: PERSON, ...over,
  };
};
const many = (count, over) => Array.from({ length: count }, () => bell(over));

describe('normalizeTitle', () => {
  test('digits, money, names and text after a colon do not split a group', () => {
    expect(normalizeTitle('Billing — charge 5 invoices of $1,254.00')).toBe('billing — charge # invoices of #');
    expect(normalizeTitle('Billing — book Diane Dizon\'s wasp removal')).toBe('billing — book * wasp removal');
    expect(normalizeTitle('Comms — held SMS from Jane: she said call')).toBe('comms — held sms from *');
    expect(normalizeTitle(HOLD)).toBe(HOLD.toLowerCase());
  });
});

describe('isHoldBell', () => {
  test.each([
    ['needs manual quote', 'Estimates — Quote needs manual pricing', ''],
    ['by hand', 'Billing — send it', 'Please do this by hand.'],
    ['held', 'Schedule — visit held for a person', ''],
    ['needs review', 'Leads — lead needs review', ''],
    ['could not … so', 'Billing — could not match the payer so nothing was sent', ''],
  ])('matches %s', (_n, title, body) => {
    expect(isHoldBell({ category: 'billing', title, body })).toBe(true);
  });

  test('does not match an ordinary bell', () => {
    expect(isHoldBell({ category: 'inbound_sms', title: 'Comms — call Mona back', body: 'Promised on a call.' })).toBe(false);
  });

  test.each([
    ['a digest', { category: 'ops_digest', title: HOLD }],
    ['a system row', { category: 'system', title: HOLD }],
    ['a payment failure', { category: 'billing', title: 'Billing — payment failed, held for review' }],
    ['a reminder job failure', { category: 'alert', title: 'Reminder job failed so it was skipped' }],
    ['the nightly auto-dispatch summary', { category: 'appointment', title: 'Auto-dispatch: 0 moves, 1 held', body: 'No move was worth making last night. Nothing needs you.' }],
    ['its own bell', { category: 'alert', title: HOLD, dedupe_key: 'rule-check:2026-W48' }],
  ])('excludes %s', (_n, row) => {
    expect(isHoldBell(row)).toBe(false);
  });
});

describe('flagGroups', () => {
  test('flags a group of 3+ handled by a person, across customers', () => {
    const groups = flagGroups([...many(5), ...many(2, { title: 'Billing — a different held thing' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 5, handled: 5, title: HOLD });
    expect(groups[0].firstAt.getTime()).toBeLessThanOrEqual(groups[0].lastAt.getTime());
  });

  test('two bells are under the threshold', () => {
    expect(flagGroups(many(2))).toEqual([]);
  });

  test('generic fall-off closers, open rows and a NULL closer are not handled', () => {
    const fallOff = check.NON_RESOLUTION_CLOSERS.map((done_by) => bell({ done_by }));
    expect(fallOff).toHaveLength(6);
    expect(flagGroups(fallOff)).toEqual([]);
    expect(flagGroups(many(4, { done_by: 'quiet-72h' }))).toEqual([]);
    expect(flagGroups(many(4, { done_by: null }))).toEqual([]);
    expect(flagGroups(many(4, { done_at: null, done_by: null }))).toEqual([]);
    expect(flagGroups(many(3, { done_at: null, done_by: PERSON }))).toEqual([]);
  });

  test('a subject closer such as setup-fee-alert counts as handled (the first-visit billing bell)', () => {
    const groups = flagGroups(many(5, { done_by: 'setup-fee-alert' }));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 5, handled: 5, title: HOLD });
  });

  test('half is the line: 2 of 4 flags, 1 of 3 does not', () => {
    expect(flagGroups([...many(2), ...many(2, { done_by: 'quiet-72h' })])).toHaveLength(1);
    expect(flagGroups([bell(), ...many(2, { done_by: 'episodes' })])).toEqual([]);
  });

  test('a person id, a legacy numeric id and claude count as handled', () => {
    expect(flagGroups([bell({ done_by: '12' }), bell({ done_by: 'claude' }), bell()])).toHaveLength(1);
  });

  test('excluded bells never form a group', () => {
    expect(flagGroups(many(6, { category: 'ops_digest' }))).toEqual([]);
    expect(flagGroups(many(6, { category: 'system' }))).toEqual([]);
  });
});

describe('isoWeekKey', () => {
  test('uses the Eastern date and ISO week numbering', () => {
    expect(isoWeekKey(new Date('2026-11-24T15:00:00Z'))).toBe('2026-W48');
    expect(isoWeekKey(new Date('2027-01-01T15:00:00Z'))).toBe('2026-W53');
    expect(isoWeekKey(new Date('2026-11-23T03:00:00Z'))).toBe('2026-W47');
  });
});

describe('composeRuleCheck', () => {
  test('passes the notification rules and carries the plain lines', () => {
    const groups = flagGroups(many(5));
    const { spec, detail } = composeRuleCheck(groups);
    expect(() => composeAdminAlert(spec)).not.toThrow();
    expect(detail).toContain(`"${HOLD}": 5 bells, 5 handled, first `);
    expect(detail).toContain("Check this rule against the owner's later rulings.");
  });
});

describe('runStaleRuleCheck', () => {
  beforeEach(() => {
    NotificationService.notifyAdmin.mockReset();
    NotificationService.notifyAdmin.mockResolvedValue({ id: 'new' });
  });
  const run = (rows, now = new Date('2026-11-24T14:40:00Z')) => check.runStaleRuleCheck({ now, loadRows: async () => rows });

  test('no bell when nothing is flagged', async () => {
    await expect(run([...many(2), ...many(4, { done_by: 'episodes' })])).resolves.toEqual({ flagged: 0, outcome: 'clean' });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('one bell per ISO week with the week key, ringing, with the group detail', async () => {
    await expect(run(many(5))).resolves.toEqual({ flagged: 1, outcome: 'raised' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('system');
    expect(title).toBe('System — check the rule behind 1 held action');
    expect(why).toBe('5 held actions were done by hand in 60 days; the rule may be out of date.');
    expect(opts).toMatchObject({ bell: true, dedupeKey: 'rule-check:2026-W48', metadata: { week: '2026-W48', severity: 'needs-you' } });
    expect(opts.detail).toContain('1. "Completed first visit');
  });

  test('a rerun the same week sends the same key, so the notification service dedupes it', async () => {
    NotificationService.notifyAdmin.mockResolvedValue({ id: 'old', deduped: true });
    await run(many(5), new Date('2026-11-24T14:40:00Z'));
    await expect(run(many(5), new Date('2026-11-26T14:40:00Z'))).resolves.toEqual({ flagged: 1, outcome: 'unchanged' });
    const keys = NotificationService.notifyAdmin.mock.calls.map((c) => c[3].dedupeKey);
    expect(new Set(keys).size).toBe(1);
    await run(many(5), new Date('2026-12-01T14:40:00Z'));
    expect(NotificationService.notifyAdmin.mock.calls[2][3].dedupeKey).toBe('rule-check:2026-W49');
  });

  test('a bell that was not written throws so job_health shows it', async () => {
    NotificationService.notifyAdmin.mockResolvedValue(null);
    await expect(run(many(5))).rejects.toThrow('not written');
  });
});

describe('loadBells', () => {
  test('reads admin bells of the last 60 days, never writes', async () => {
    const calls = [];
    const q = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? (res) => res([]) : (...args) => { calls.push([prop, args]); return q; }) });
    const database = Object.assign(() => q, { raw: (s) => s });
    await loadBells({ now: new Date('2026-11-24T14:40:00Z'), database });
    const names = calls.map(([p]) => p);
    expect(names).toEqual(expect.arrayContaining(['where', 'whereNotIn', 'select']));
    expect(names).not.toEqual(expect.arrayContaining(['update', 'insert', 'del', 'forUpdate']));
    const since = calls.find(([p, a]) => p === 'where' && a[0] === 'created_at')[1][2];
    expect(new Date('2026-11-24T14:40:00Z').getTime() - since.getTime()).toBe(60 * 24 * 60 * 60 * 1000);
  });
});

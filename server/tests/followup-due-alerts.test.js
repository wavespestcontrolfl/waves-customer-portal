/**
 * Follow-up due alerts (owner 2026-11-02, B1): the due-date rule, each branch of "covered", the split between a
 * card's own alert and the catch-up list, raise-once, the catch-up ring rule, closing, and the gate. The reads
 * run through a table-keyed fake database; the SQL itself runs against Postgres in followup-due-alerts-postgres.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/admin-alert-episodes', () => ({
  openAdminAlertKeys: jest.fn(async () => []),
  closeAdminAlertKeys: jest.fn(),
  raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'n1', deduped: false })),
}));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn(async () => ({ id: 'n1', deduped: false })),
}));

const episodes = require('../services/admin-alert-episodes');
const { raiseAdminAlert, composeAdminAlert } = require('../services/admin-alert-compose');
const logger = require('../services/logger');
const FollowupDue = require('../services/followup-due-alerts');

const { runFollowupDueAlerts } = FollowupDue;
const {
  dueDay, coverageOf, classify, actionFor, whyFor, ownSpec, composeCatchUp, ringOnNewCard, shortName, addDays,
} = FollowupDue._private;

// 8:20 AM Eastern on Monday 2026-11-02 (Eastern time is UTC-5 after the clock change).
const NOW = new Date('2026-11-02T13:20:00Z');
const TODAY = '2026-11-02';

let seq = 0;
function card(over = {}) {
  seq += 1;
  const id = over.id || `card-${seq}`;
  return {
    id, job_id: `job-${id}`, customer_id: `cust-${id}`, first_name: 'Pat', last_name: 'Synthetic',
    active: true, pipeline_stage: 'active_customer', deleted_at: null, resolved_at: null,
    created_at: '2026-10-20T15:00:00Z', card_day: '2026-10-20',
    payload: { serviceType: 'Quarterly Pest Control Service', suggestedFollowupDate: '2026-11-02' },
    ...over,
  };
}
const dueOn = (day, over = {}) => card({ payload: { serviceType: 'Quarterly Pest Control Service', suggestedFollowupDate: day }, ...over });
const visitFor = (c, over = {}) => ({
  id: `visit-${c.id}`, customer_id: c.customer_id, followup_source_service_id: null, created_at: '2026-10-01T00:00:00Z', day: '2026-10-01', ...over,
});

// A fake database keyed on the table each read starts from.
function fakeDb({ cards = [], visits = [], raised = [] } = {}) {
  const calls = [];
  const database = jest.fn((table) => {
    calls.push(table);
    const notifications = raised.map((r) => (typeof r === 'string'
      ? { dedupe_key: r, auto_cleared: null, done_by: null }
      : { dedupe_key: r.key, auto_cleared: r.autoCleared ? 'true' : null, done_by: r.doneBy || null }));
    const rows = { 'dispatch_alerts as a': cards, 'scheduled_services as v': visits, notifications }[table];
    const chain = new Proxy({}, {
      get: (_t, prop) => (prop === 'then' ? (resolve) => resolve(rows) : () => chain),
    });
    return chain;
  });
  database.raw = jest.fn((sql) => sql);
  database.calls = calls;
  return database;
}

const run = (state, opts = {}) => runFollowupDueAlerts({ now: NOW, gateEnabled: true, database: fakeDb(state), ...opts });
// Own alerts and the catch-up alert both go through the episodes helper; split its calls by dedupe key.
const ownCalls = () => episodes.raiseAdminAlertWithReopen.mock.calls.filter((c) => String(c[3]?.dedupeKey).startsWith('followup-due:'));
const catchUpCalls = () => episodes.raiseAdminAlertWithReopen.mock.calls.filter((c) => c[3]?.dedupeKey === 'followup-due-older');

beforeEach(() => {
  jest.clearAllMocks();
  episodes.openAdminAlertKeys.mockResolvedValue([]);
  // Each key closes one row; the catch-up row is not standing unless a test says so.
  episodes.closeAdminAlertKeys.mockImplementation(async (_conn, keys) => (keys[0] === 'followup-due-older' ? 0 : keys.length));
  episodes.raiseAdminAlertWithReopen.mockResolvedValue({ id: 'n1', deduped: false });
  raiseAdminAlert.mockResolvedValue({ id: 'n1', deduped: false });
});

describe('due date', () => {
  test('uses suggestedFollowupDate, then suggestedDate, when each is a real calendar day', () => {
    expect(dueDay(card({ payload: { suggestedFollowupDate: '2026-11-05', suggestedDate: '2026-11-09' } }))).toBe('2026-11-05');
    expect(dueDay(card({ payload: { suggestedDate: '2026-11-09' } }))).toBe('2026-11-09');
    expect(dueDay(card({ payload: { suggestedFollowupDate: '2026-11-05', suggestedDate: 'x' } }))).toBe('2026-11-05');
  });

  test('a missing or invalid date falls back to the card\'s Eastern created day plus 14 days', () => {
    for (const payload of [{}, { suggestedFollowupDate: 'soon' }, { suggestedFollowupDate: '2026-02-31' }, { suggestedFollowupDate: '2026-11-05T00:00:00Z' }]) {
      expect(dueDay(card({ payload, card_day: '2026-10-20' }))).toBe('2026-11-03');
    }
    // 02:00Z on Nov 1 is still Oct 31 in Eastern time: the day comes from the Eastern calendar, not UTC.
    expect(dueDay(card({ payload: {}, card_day: undefined, created_at: '2026-11-01T02:00:00Z' }))).toBe('2026-11-14');
    expect(addDays('2026-12-25', 14)).toBe('2027-01-08');
  });

  test('a string payload is read as JSON', () => {
    expect(dueDay(card({ payload: JSON.stringify({ suggestedFollowupDate: '2026-11-06' }) }))).toBe('2026-11-06');
  });
});

describe('covered cards', () => {
  const c = dueOn('2026-10-30', { created_at: '2026-10-20T15:00:00Z', card_day: '2026-10-20' });

  test('an uncovered card has no cover', () => {
    expect(coverageOf(c, [])).toBeNull();
    // An old visit, a visit of another customer, and the source visit itself do not cover it.
    expect(coverageOf(c, [
      visitFor(c, { created_at: '2026-10-01T00:00:00Z', day: '2026-10-05' }),
      { ...visitFor(c, { id: 'other', created_at: '2026-10-25T00:00:00Z', day: '2026-10-25' }), customer_id: 'someone-else' },
      visitFor(c, { id: c.job_id, created_at: '2026-10-25T00:00:00Z', day: '2026-10-25' }),
    ])).toBeNull();
  });

  test('a resolved card, an inactive customer and an internal test customer are covered', () => {
    expect(coverageOf({ ...c, resolved_at: '2026-10-28T00:00:00Z' }, [])).toBe('resolved');
    expect(coverageOf({ ...c, active: false }, [])).toBe('inactive');
    expect(coverageOf({ ...c, pipeline_stage: 'churned' }, [])).toBe('inactive');
    expect(coverageOf({ ...c, deleted_at: '2026-10-28T00:00:00Z' }, [])).toBe('inactive');
    expect(coverageOf({ ...c, customer_id: null }, [])).toBe('inactive');
    expect(coverageOf({ ...c, first_name: 'Adam', last_name: 'Martinez' }, [])).toBe('internal');
    expect(coverageOf({ ...c, customer_id: '3274944a-f509-413c-9dee-a8b0cdb16493' }, [])).toBe('internal');
  });

  test('a visit created after the card covers it, whatever its date', () => {
    expect(coverageOf(c, [visitFor(c, { created_at: '2026-10-21T00:00:00Z', day: '2027-03-01' })])).toBe('booked');
    expect(coverageOf(c, [visitFor(c, { created_at: '2026-10-21T00:00:00Z', day: null })])).toBe('booked');
  });

  test('a visit dated after the card day and up to due + 7 days covers it, even if created earlier', () => {
    const early = { created_at: '2026-10-01T00:00:00Z' };
    expect(coverageOf(c, [visitFor(c, { ...early, day: '2026-10-21' })])).toBe('booked');
    expect(coverageOf(c, [visitFor(c, { ...early, day: '2026-11-06' })])).toBe('booked');
    // The card day itself, and a day past due + 7, are outside the window.
    expect(coverageOf(c, [visitFor(c, { ...early, day: '2026-10-20' })])).toBeNull();
    expect(coverageOf(c, [visitFor(c, { ...early, day: '2026-11-07' })])).toBeNull();
  });

  test('a visit booked from the card\'s visit covers it, even for another customer id', () => {
    const child = { id: 'child', customer_id: 'moved', followup_source_service_id: c.job_id, created_at: '2026-10-01T00:00:00Z', day: null };
    expect(coverageOf(c, [child])).toBe('booked');
  });
});

describe('fresh versus catch-up', () => {
  test('due today or within the last 3 days is fresh; older is catch-up; future is neither', () => {
    const today = dueOn('2026-11-02');
    const threeAgo = dueOn('2026-10-30');
    const fourAgo = dueOn('2026-10-29');
    const future = dueOn('2026-11-03');
    const ancient = dueOn('2026-08-15');
    const booked = dueOn('2026-10-01', { resolved_at: '2026-10-05T00:00:00Z' });
    const out = classify([future, fourAgo, today, ancient, threeAgo, booked], [], TODAY);
    expect(out.fresh.map((i) => i.card.id)).toEqual([threeAgo.id, today.id]);
    expect(out.older.map((i) => i.card.id)).toEqual([ancient.id, fourAgo.id]);
    expect(out.covered.get(booked.id)).toBe('resolved');
    expect(out.covered.size).toBe(1);
  });

  test('a covered card is in neither list', () => {
    const c = dueOn('2026-10-31');
    const out = classify([c], [visitFor(c, { created_at: '2026-10-25T00:00:00Z' })], TODAY);
    expect([out.fresh, out.older]).toEqual([[], []]);
    expect(out.covered.get(c.id)).toBe('booked');
  });
});

describe('alert copy', () => {
  test('an own alert follows the notification rule and links to the customer page', () => {
    const c = dueOn('2026-11-05', { created_at: '2026-11-01T01:00:00Z', card_day: '2026-10-31' });
    const spec = ownSpec({ card: c, due: '2026-11-05' });
    expect(spec).toMatchObject({
      area: 'Schedule', action: "book Pat S.'s follow-up (due Nov 5)", severity: 'needs-you', who: 'person',
      subject: { type: 'visit', id: c.job_id }, doneWhen: 'followup_booked', link: `/admin/customers?customerId=${c.customer_id}`, promise: true,
    });
    expect(spec.why).toBe('Quarterly Pest Control Service follow-up you flagged on Oct 31; no visit is booked.');
    const composed = composeAdminAlert(spec);
    expect(composed.headline).toBe("Schedule — book Pat S.'s follow-up (due Nov 5)");
    expect(composed.metadata).toMatchObject({ promise: true, doneWhen: 'followup_booked' });
  });

  test('a long name or odd service text falls back until the headline and why fit the rule', () => {
    const longName = dueOn('2026-11-05', { first_name: 'Maximilian-Alexander', last_name: 'Featherstonehaugh' });
    expect(actionFor(longName, '2026-11-05')).toBe("book Maximilian-Alexander F.'s follow-up");
    const huge = { ...longName, first_name: 'Maximilian-Alexander-Bartholomew' };
    expect(actionFor(huge, '2026-11-05')).toBe('book a follow-up (due Nov 5)');
    expect(composeAdminAlert(ownSpec({ card: huge, due: '2026-11-05' })).headline.length).toBeLessThanOrEqual(60);
    expect(actionFor(dueOn('2026-11-05', { first_name: '' }), '2026-11-05')).toBe('book a follow-up (due Nov 5)');
    expect(shortName(dueOn('2026-11-05', { last_name: '' }))).toBe('Pat');

    const slug = dueOn('2026-11-05', { payload: { serviceType: 'rodent_trapping' } });
    expect(whyFor(slug)).toBe('rodent trapping follow-up you flagged on Oct 20; no visit is booked.');
    const wordy = dueOn('2026-11-05', { payload: { serviceType: `${'Very long service name '.repeat(6)}` } });
    expect(whyFor(wordy)).toBe('Follow-up you flagged on Oct 20; no visit is booked.');
    expect(whyFor(dueOn('2026-11-05', { payload: {} }))).toBe('Follow-up you flagged on Oct 20; no visit is booked.');
  });

  test('the catch-up alert counts the cards, names the oldest due day and lists each one', () => {
    const old = { card: dueOn('2026-08-20', { first_name: 'Sam', last_name: 'Example', payload: { serviceType: 'rodent_trapping', suggestedFollowupDate: '2026-08-20' } }), due: '2026-08-20' };
    const recent = { card: dueOn('2026-10-25'), due: '2026-10-25' };
    const composed = composeCatchUp([old, recent], TODAY);
    expect(composed.spec).toMatchObject({ action: 'book 2 older follow-ups', link: '/admin/dispatch', subject: { type: 'check', id: 'followup-due-older' }, doneWhen: 'count_zero' });
    expect(composed.spec.why).toBe('2 follow-ups you flagged have no visit booked; the oldest was due Aug 20.');
    expect(composeAdminAlert(composed.spec).headline).toBe('Schedule — book 2 older follow-ups');
    expect(composed.detail).toContain('Sam E. · rodent trapping · due Aug 20 (74 days ago)');
    expect(composed.detail).toContain('Pat S. · Quarterly Pest Control Service · due Oct 25 (8 days ago)');
    expect(composed.itemKeys).toEqual([old.card.id, recent.card.id].sort());
    // A single card links to its customer; a long list stops at 25 lines.
    expect(composeCatchUp([old], TODAY).spec.link).toBe(`/admin/customers?customerId=${old.card.customer_id}`);
    const many = Array.from({ length: 30 }, () => ({ card: dueOn('2026-09-01'), due: '2026-09-01' }));
    const big = composeCatchUp(many, TODAY);
    expect(big.detail).toContain('…and 5 more.');
    expect(composeAdminAlert(big.spec).headline).toBe('Schedule — book 30 older follow-ups');
  });

  test('the catch-up refresh rings only when a card joins the list', () => {
    const ring = ringOnNewCard(['a', 'b', 'c']);
    expect(ring(null, { itemKeys: ['a', 'b', 'c'] })).toBe(false);
    expect(ring(null, { itemKeys: ['a', 'b', 'c', 'd'] })).toBe(false);
    expect(ring(null, { itemKeys: ['a', 'b'] })).toBe(true);
    expect(ring(null, {})).toBe(true);
    expect(ring(null, null)).toBe(true);
  });
});

describe('runFollowupDueAlerts', () => {
  test('gate off: nothing is read and nothing is written', async () => {
    const database = fakeDb({ cards: [dueOn('2026-11-02')] });
    await expect(runFollowupDueAlerts({ now: NOW, gateEnabled: false, database })).resolves.toEqual({ skipped: 'disabled' });
    expect(database).not.toHaveBeenCalled();
    expect(episodes.openAdminAlertKeys).not.toHaveBeenCalled();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('ALERT_EPISODES off: the job stands down before any read', async () => {
    process.env.ALERT_EPISODES = 'off';
    try {
      const database = fakeDb({ cards: [dueOn('2026-11-02')] });
      await expect(runFollowupDueAlerts({ now: NOW, gateEnabled: true, database })).resolves.toEqual({ skipped: 'episodes_off' });
      expect(database).not.toHaveBeenCalled();
      expect(episodes.openAdminAlertKeys).not.toHaveBeenCalled();
      expect(raiseAdminAlert).not.toHaveBeenCalled();
      expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    } finally {
      delete process.env.ALERT_EPISODES;
    }
  });

  test('gate unset in the environment is off', async () => {
    delete process.env.GATE_FOLLOWUP_DUE_ALERT;
    const database = fakeDb({ cards: [dueOn('2026-11-02')] });
    await expect(runFollowupDueAlerts({ now: NOW, database })).resolves.toEqual({ skipped: 'disabled' });
    expect(database).not.toHaveBeenCalled();
  });

  test('a card due today raises its own alert, once, with the ring flag and the customer link', async () => {
    const c = dueOn('2026-11-02');
    await expect(run({ cards: [c] })).resolves.toMatchObject({ raised: 1, closed: 0, listed: 0, outcome: 'clear' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(ownCalls()).toHaveLength(1);
    const [category, headline, why, opts] = ownCalls()[0];
    expect(category).toBe('schedule');
    expect(headline).toBe("Schedule — book Pat S.'s follow-up (due Nov 2)");
    expect(why).toBe('Quarterly Pest Control Service follow-up you flagged on Oct 20; no visit is booked.');
    expect(opts).toMatchObject({ dedupeKey: `followup-due:${c.id}`, bell: true, link: `/admin/customers?customerId=${c.customer_id}` });
    expect(opts.metadata).toMatchObject({ dispatchAlertId: c.id, customerId: c.customer_id, dueDate: '2026-11-02', promise: true });
    expect(opts.dedupeOpenOnly).toBeUndefined();
  });

  test('a repeat run does not count a deduped alert as raised', async () => {
    episodes.raiseAdminAlertWithReopen.mockResolvedValue({ id: 'n1', deduped: true, rang: false });
    await expect(run({ cards: [dueOn('2026-11-01')] })).resolves.toMatchObject({ raised: 0 });
    expect(ownCalls()).toHaveLength(1);
  });

  test('a fresh card whose alert auto-closed rings again through the reopen helper', async () => {
    const c = dueOn('2026-11-01');
    episodes.raiseAdminAlertWithReopen.mockResolvedValue({ id: 'n1', deduped: true, refreshed: true, rang: true });
    await expect(run({ cards: [c], raised: [{ key: `followup-due:${c.id}`, autoCleared: true }] })).resolves.toMatchObject({ raised: 1 });
    expect(ownCalls()).toHaveLength(1);
  });

  test('a card due in the future raises nothing', async () => {
    await expect(run({ cards: [dueOn('2026-11-03'), dueOn('2026-12-01')] })).resolves.toMatchObject({ raised: 0, listed: 0 });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  });

  test('a booked or inactive card raises nothing', async () => {
    const booked = dueOn('2026-11-01');
    const gone = dueOn('2026-11-01', { active: false });
    await run({ cards: [booked, gone], visits: [visitFor(booked, { created_at: '2026-10-25T00:00:00Z' })] });
    expect(ownCalls()).toHaveLength(0);
  });

  test('cards past the 3-day window go on one catch-up alert; each has no alert of its own', async () => {
    const a = dueOn('2026-08-20');
    const b = dueOn('2026-10-10');
    const fresh = dueOn('2026-11-01');
    await expect(run({ cards: [b, fresh, a] })).resolves.toMatchObject({ raised: 1, listed: 2, outcome: 'raised' });
    expect(ownCalls()).toHaveLength(1);
    expect(ownCalls()[0][3].dedupeKey).toBe(`followup-due:${fresh.id}`);
    expect(catchUpCalls()).toHaveLength(1);
    const [category, headline, why, opts] = catchUpCalls()[0];
    expect(category).toBe('schedule');
    expect(headline).toBe('Schedule — book 2 older follow-ups');
    expect(why).toContain('the oldest was due Aug 20');
    expect(opts).toMatchObject({ dedupeKey: 'followup-due-older', bell: true, refreshOnDedupe: true, bumpOnRefresh: true, link: '/admin/dispatch' });
    expect(opts.metadata).toMatchObject({ itemKeys: [a.id, b.id].sort(), count: 2, promise: true });
    expect(opts.detail.split('\n')[1]).toMatch(/^Pat S\. · Quarterly Pest Control Service · due Aug 20/);
    expect(opts.ringOnRefresh(null, { itemKeys: [a.id, b.id] })).toBe(false);
    expect(opts.ringOnRefresh(null, { itemKeys: [a.id] })).toBe(true);
  });

  test('an older card that already has an alert of its own stays off the catch-up list', async () => {
    const mine = dueOn('2026-10-20');
    const other = dueOn('2026-10-10');
    await expect(run({ cards: [mine, other], raised: [`followup-due:${mine.id}`] })).resolves.toMatchObject({ listed: 1 });
    expect(ownCalls()).toHaveLength(0);
    const opts = catchUpCalls()[0][3];
    expect(opts.metadata.itemKeys).toEqual([other.id]);
  });

  test('an older card whose own alert auto-closed and is uncovered again rings its own alert, off the catch-up list', async () => {
    const back = dueOn('2026-10-20');
    const other = dueOn('2026-10-10');
    episodes.raiseAdminAlertWithReopen.mockImplementation(async (_c, _h, _w, opts) => (opts.dedupeKey === 'followup-due-older'
      ? { id: 'n2', deduped: false } : { id: 'n1', deduped: true, refreshed: true, rang: true }));
    await expect(run({ cards: [back, other], raised: [{ key: `followup-due:${back.id}`, autoCleared: true }] }))
      .resolves.toMatchObject({ raised: 1, listed: 1 });
    expect(ownCalls().map((c) => c[3].dedupeKey)).toEqual([`followup-due:${back.id}`]);
    expect(catchUpCalls()[0][3].metadata.itemKeys).toEqual([other.id]);
  });

  test('an older card whose own alert the retention sweep expired goes back on the catch-up list', async () => {
    const expired = dueOn('2026-09-20');
    await expect(run({ cards: [expired], raised: [{ key: `followup-due:${expired.id}`, doneBy: 'retention' }] }))
      .resolves.toMatchObject({ listed: 1 });
    expect(ownCalls()).toHaveLength(0);
    expect(catchUpCalls()[0][3].metadata.itemKeys).toEqual([expired.id]);
  });

  test('an older card a person marked done stays off both alerts', async () => {
    const done = dueOn('2026-10-01');
    await expect(run({ cards: [done], raised: [{ key: `followup-due:${done.id}`, doneBy: 'tech-1' }] }))
      .resolves.toMatchObject({ raised: 0, listed: 0 });
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  });

  test('catch-up outcomes: refreshed quietly, rung again, unchanged, suppressed', async () => {
    const cards = [dueOn('2026-10-10')];
    const cases = [
      [{ deduped: true, refreshed: true, rung: false }, 'refreshed'],
      [{ deduped: true, refreshed: true, rung: true }, 'raised'],
      [{ deduped: true }, 'unchanged'],
      [{ suppressed: true }, 'suppressed'],
    ];
    for (const [reply, outcome] of cases) {
      episodes.raiseAdminAlertWithReopen.mockResolvedValueOnce(reply);
      await expect(run({ cards })).resolves.toMatchObject({ listed: 1, outcome });
    }
  });

  test('an empty catch-up list closes the row (done by the job) and a clear list closes nothing new', async () => {
    episodes.closeAdminAlertKeys.mockResolvedValueOnce(1);
    await expect(run({ cards: [] })).resolves.toMatchObject({ listed: 0, outcome: 'closed' });
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(expect.anything(), ['followup-due-older'], 'count_zero', { resolution: 'Every older follow-up is booked or closed' });
    episodes.closeAdminAlertKeys.mockResolvedValueOnce(0);
    await expect(run({ cards: [] })).resolves.toMatchObject({ outcome: 'clear' });
  });

  test('a run closes the open own alerts whose card is booked, resolved, inactive or gone, and keeps the rest', async () => {
    const booked = dueOn('2026-10-31');
    const resolved = dueOn('2026-10-31', { resolved_at: '2026-11-01T00:00:00Z' });
    const inactive = dueOn('2026-10-31', { active: false });
    const standing = dueOn('2026-10-31');
    episodes.openAdminAlertKeys.mockResolvedValue([booked, resolved, inactive, standing, { id: 'deleted-card' }].map((x) => `followup-due:${x.id}`));
    const cards = [booked, resolved, inactive, standing];
    const visits = [visitFor(booked, { created_at: '2026-10-30T00:00:00Z' })];
    const result = await run({ cards, visits, raised: [`followup-due:${standing.id}`] });
    expect(episodes.openAdminAlertKeys).toHaveBeenCalledWith(expect.anything(), 'followup-due:');
    const closes = Object.fromEntries(episodes.closeAdminAlertKeys.mock.calls
      .filter(([, keys]) => keys[0] !== 'followup-due-older')
      .map(([, keys, reason, opts]) => [opts.resolution, { keys, reason }]));
    expect(closes).toEqual({
      'Follow-up booked': { keys: [`followup-due:${booked.id}`], reason: 'followup_booked' },
      'Card resolved': { keys: [`followup-due:${resolved.id}`, 'followup-due:deleted-card'], reason: 'card_resolved' },
      'Customer inactive': { keys: [`followup-due:${inactive.id}`], reason: 'customer_inactive' },
    });
    expect(result.closed).toBe(4);
    // The standing card is still uncovered and due 2 days ago: its alert is deduped, not closed.
    expect(ownCalls()).toHaveLength(1);
    expect(ownCalls()[0][3].dedupeKey).toBe(`followup-due:${standing.id}`);
  });

  test('one failed own alert does not stop the others, and the run reports the failure', async () => {
    episodes.raiseAdminAlertWithReopen.mockRejectedValueOnce(new Error('db down')).mockResolvedValue({ id: 'n2', deduped: false });
    await expect(run({ cards: [dueOn('2026-11-01'), dueOn('2026-11-02')] })).rejects.toThrow('1 follow-up due alert failed to write');
    expect(ownCalls()).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith('[followup-due-alerts] own alert failed: db down');
  });

  test('a read failure throws before anything is written or closed', async () => {
    const database = fakeDb({ cards: [dueOn('2026-11-02')] });
    database.mockImplementationOnce(() => { throw new Error('connection reset'); });
    episodes.openAdminAlertKeys.mockResolvedValue(['followup-due:gone']);
    await expect(runFollowupDueAlerts({ now: NOW, gateEnabled: true, database })).rejects.toThrow('connection reset');
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  });
});

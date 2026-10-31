// ops/agents/second-tech-handover.js — the pure planner. READ-ONLY build 6 of the
// second-tech plan: it must name what a later --execute would move, and nothing else.
// Synthetic ids only. 2099-07-06 is a Monday.
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const script = path.join(__dirname, '..', '..', 'ops', 'agents', 'second-tech-handover.js');
const {
  buildPlan, parseArgs, defaultStart, isOpenVisit, isGroupedVisit, seriesTechnicianId, isBaitSeries, isTermiteBaitAddon,
} = require(script);

const OWNER = '00000000-0000-4000-8000-000000000001';
const HIRE = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const TODAY = '2099-06-30';
const START = '2099-07-06';
const MON = '2099-07-06';
const TUE = '2099-07-07';
const WED = '2099-07-08';
const THU = '2099-07-09';
const FRI = '2099-07-10';
const SAT = '2099-07-11';
// After the 13-week weekend-customer window (--start 2099-07-06: dates before 2099-10-05 are inside it).
const MON_LATE = '2099-10-12';
const FRI_LATE = '2099-10-09';

let seq = 0;
const id = (p) => `${p}-${++seq}`;
const parent = (o = {}) => ({
  id: id('S'), customer_id: id('C'), line: 'general', service_key_snapshot: null, service_type: 'Quarterly Pest Control',
  technician_id: OWNER, recurring_technician_id: null, recurring_technician_override: false, recurring_ongoing: true, ...o,
});
const visit = (series, date, o = {}) => ({
  id: id('V'), series_id: series.id, scheduled_date: date, status: 'confirmed', track_state: null,
  technician_id: OWNER, visit_id: null, group_status: null, ...o,
});
// The reader decides activity in SQL (whereVisitRowLive). Fixtures mark a series live
// when it has a visit that is not finished, on or after TODAY; pass liveSeriesIds to override.
const fixtureLive = (visits) => [...new Set(visits
  .filter((v) => !['completed', 'cancelled', 'skipped', 'no_show'].includes(v.status) && String(v.scheduled_date) >= TODAY)
  .map((v) => v.series_id))];
const plan = (parents, visits, o = {}) => buildPlan({
  from: OWNER, to: null, start: START, today: TODAY, parents, visits, liveSeriesIds: fixtureLive(visits), ...o,
});

describe('second-tech-handover planner', () => {
  test('a series whose template changes but has no visit to move now is still listed (template-only)', () => {
    const lateFridayOnly = parent();
    const noChildren = parent();
    const moving = parent();
    const p = plan([lateFridayOnly, noChildren, moving], [visit(lateFridayOnly, FRI_LATE), visit(moving, MON)]);
    expect(p.series.retemplate).toBe(3);
    expect(new Set(p.ids.retemplate)).toEqual(new Set([lateFridayOnly.id, noChildren.id, moving.id]));
    expect(p.ids.series).toEqual([moving.id]);
  });

  test('a pest series on the owner moves its Mon-Thu visits; a Friday after the 13 weeks stays (stays_off_day)', () => {
    const s = parent();
    const vs = [MON, TUE, WED, THU, FRI_LATE].map((d) => visit(s, d));
    const p = plan([s], vs);
    expect(p.would_change).toMatchObject({ series: 1, visits: 4, by_line: { general: { series: 1, visits: 4 } } });
    expect(p.would_change.by_weekday).toEqual({ Mon: 1, Tue: 1, Wed: 1, Thu: 1 });
    expect(p.stays_off_day).toEqual({ visits: 1, by_weekday: { Fri: 1 } });
    expect(p.ids.visits).toEqual(vs.slice(0, 4).map((v) => v.id));
    expect(p.ids.series).toEqual([s.id]);
    expect(p.notices_to_suppress).toBe(4);
    expect(p.target).toBe('not set');
    expect(p.target_work_days_source).toBe('assumed_mon_thu');
    expect(p.series.retemplate).toBe(1);
  });

  test('rodent and mosquito move too; lawn and termite series are skipped as other_line', () => {
    const rodent = parent({ line: 'rodent' });
    const mosq = parent({ line: 'mosquito' });
    const lawn = parent({ line: 'lawn' });
    const termite = parent({ line: 'termite' });
    const p = plan([rodent, mosq, lawn, termite], [rodent, mosq, lawn, termite].map((s) => visit(s, MON)));
    expect(p.would_change.by_line).toEqual({ rodent: { series: 1, visits: 1 }, mosquito: { series: 1, visits: 1 } });
    expect(p.skipped.other_line).toEqual({ series: 2, visits: 2 });
  });

  test('--lines narrows what moves', () => {
    const pest = parent();
    const rodent = parent({ line: 'rodent' });
    const p = plan([pest, rodent], [visit(pest, MON), visit(rodent, MON)], { lines: ['rodent'] });
    expect(p.would_change.by_line).toEqual({ rodent: { series: 1, visits: 1 } });
    expect(p.skipped.other_line.series).toBe(1);
  });

  test('a customer with an active termite-bait series keeps every series; a plain termite series does not make a bait customer', () => {
    const baitCustomer = 'C-bait';
    const bait = parent({ customer_id: baitCustomer, line: 'termite', service_key_snapshot: 'termite_active_bait_quarterly', service_type: 'Quarterly Termite Active Bait Station Service' });
    const pest = parent({ customer_id: baitCustomer });
    const monitoring = parent({ customer_id: 'C-mon', line: 'termite', service_type: 'Termite Monitoring' });
    const pest2 = parent({ customer_id: 'C-mon' });
    const wdo = parent({ customer_id: 'C-wdo', line: 'termite', service_type: 'WDO Inspection' });
    const pest3 = parent({ customer_id: 'C-wdo' });
    const p = plan([bait, pest, monitoring, pest2, wdo, pest3], [bait, pest, monitoring, pest2, wdo, pest3].map((s) => visit(s, MON)));
    expect(p.skipped.termite_bait_customer).toEqual({ series: 2, visits: 2, customers: 2 });
    expect(p.ids.series).toEqual([pest3.id]);
    expect(isBaitSeries(wdo)).toBe(false);
  });

  test('termite bait sold as an add-on marks its customer; a rodent bait or termite bond add-on does not', () => {
    expect(isTermiteBaitAddon({ service_key_snapshot: 'termite_bait', service_name: 'Termite Bait Station Service' })).toBe(true);
    expect(isTermiteBaitAddon({ service_key_snapshot: null, service_name: 'Termite Bait Station Service' })).toBe(true);
    expect(isTermiteBaitAddon({ catalog_key: 'termite_monitoring', service_name: 'Station check' })).toBe(true);
    expect(isTermiteBaitAddon({ service_key_snapshot: 'rodent_bait_quarterly', service_name: 'Quarterly Rodent Bait Station Service' })).toBe(false);
    expect(isTermiteBaitAddon({ service_key_snapshot: 'termite_bond_1yr', service_name: 'Termite Bond Service (1-Year Term)' })).toBe(false);
    const pest = parent({ customer_id: 'C-addon' });
    const pest2 = parent({ customer_id: 'C-addon' });
    const other = parent({ customer_id: 'C-plain' });
    const p = plan([pest, pest2, other], [visit(pest, MON), visit(pest2, TUE), visit(other, WED)], { baitAddonSeriesIds: [pest.id] });
    expect(p.skipped.termite_bait_customer).toEqual({ series: 2, visits: 2, customers: 1 });
    expect(p.ids.series).toEqual([other.id]);
  });

  test('the combined pest + termite bait plan (catalog pest_control) is a bait plan', () => {
    const combined = parent({ customer_id: 'C-combo', line: 'general', catalog_key: 'pest_termite_bait_quarterly' });
    expect(isBaitSeries(combined)).toBe(true);
    const p = plan([combined], [visit(combined, MON)]);
    expect(p.skipped.termite_bait_customer).toEqual({ series: 1, visits: 1, customers: 1 });
  });

  test('a bait plan linked only by its catalog key (no key snapshot, no "bait" in the label) still marks its customer', () => {
    const annual = parent({ customer_id: 'C-annual', line: 'termite', catalog_key: 'termite_active_annual', service_key_snapshot: null, service_type: 'Termite Active Annual' });
    const pest = parent({ customer_id: 'C-annual' });
    expect(isBaitSeries(annual)).toBe(true);
    expect(isBaitSeries({ ...annual, catalog_key: null })).toBe(false);
    const p = plan([annual, pest], [annual, pest].map((s) => visit(s, MON)));
    expect(p.skipped.termite_bait_customer).toEqual({ series: 1, visits: 1, customers: 1 });
    expect(p.would_change.visits).toBe(0);
  });

  test('a bait series that is no longer active does not protect its customer', () => {
    const bait = parent({ customer_id: 'C-old', line: 'termite', service_type: 'Termite Bait Station', recurring_ongoing: false });
    const done = visit(bait, '2099-05-01', { status: 'completed' });
    const pest = parent({ customer_id: 'C-old' });
    const p = plan([bait, pest], [done, visit(pest, MON)]);
    expect(p.skipped.termite_bait_customer).toBeUndefined();
    expect(p.would_change.visits).toBe(1);
  });

  test('a visit still in an old visit group is skipped as grouped; a dissolved group is not', () => {
    const s = parent();
    const grouped = visit(s, MON, { visit_id: 'G-1', group_status: 'open' });
    const dissolved = visit(s, TUE, { visit_id: 'G-2', group_status: 'dissolved' });
    const p = plan([s], [grouped, dissolved]);
    expect(p.skipped.grouped).toEqual({ series: 1, visits: 1 });
    expect(p.ids.visits).toEqual([dissolved.id]);
    expect(isGroupedVisit({ visit_id: 'G-3', group_status: null })).toBe(true);
  });

  test('completed, cancelled, skipped, no_show, in-progress and tracker-live visits are never moved', () => {
    const s = parent();
    const statuses = ['completed', 'cancelled', 'skipped', 'no_show', 'en_route', 'on_site'];
    const vs = statuses.map((st) => visit(s, WED, { status: st }));
    vs.push(visit(s, WED, { status: 'confirmed', track_state: 'on_property' }));
    vs.push(visit(s, WED, { status: 'pending', track_state: 'cancelled' }));
    const p = plan([s], vs);
    expect(p.would_change.visits).toBe(0);
    expect(p.skipped.not_open.visits).toBe(8);
    for (const st of ['pending', 'confirmed', 'rescheduled']) expect(isOpenVisit({ status: st })).toBe(true);
  });

  test('a visit before the start day is ignored (before_start)', () => {
    const s = parent();
    const p = plan([s], [visit(s, '2099-07-03'), visit(s, MON)]);
    expect(p.skipped.before_start).toEqual({ series: 1, visits: 1 });
    expect(p.would_change.visits).toBe(1);
  });

  test('only visits held by --from move: unassigned stays unassigned, another technician keeps theirs', () => {
    const s = parent();
    const p = plan([s], [visit(s, MON, { technician_id: null }), visit(s, TUE, { technician_id: OTHER }), visit(s, WED)]);
    expect(p.skipped.unassigned_left.visits).toBe(1);
    expect(p.skipped.other_technician.visits).toBe(1);
    expect(p.would_change.visits).toBe(1);
  });

  test('series technician follows the template rules: override wins, then the template, then the parent', () => {
    expect(seriesTechnicianId({ recurring_technician_override: true, recurring_technician_id: null, technician_id: OWNER })).toBeNull();
    expect(seriesTechnicianId({ recurring_technician_override: false, recurring_technician_id: OTHER, technician_id: OWNER })).toBe(OTHER);
    expect(seriesTechnicianId({ recurring_technician_id: null, technician_id: OWNER })).toBe(OWNER);
    const onOther = parent({ recurring_technician_id: OTHER });
    const p = plan([onOther], [visit(onOther, MON)]);
    expect(p.series.on_from).toBe(0);
    expect(p.would_change.visits).toBe(0);
  });

  test('a non-ongoing bait series kept live only by an in-progress visit still protects its customer', () => {
    const bait = parent({ customer_id: 'C-live', line: 'termite', service_type: 'Termite Bait Station', recurring_ongoing: false });
    const pest = parent({ customer_id: 'C-live' });
    // Its last visit is in progress (dated yesterday): not movable, but the series is live.
    const inProgress = visit(bait, '2099-06-29', { status: 'en_route' });
    const p = plan([bait, pest], [inProgress, visit(pest, MON)], { liveSeriesIds: [bait.id, pest.id] });
    expect(p.skipped.termite_bait_customer).toEqual({ series: 1, visits: 1, customers: 1 });
    expect(p.would_change.visits).toBe(0);
  });

  test('a cancelled first visit (the parent row) does not end the series: live children still move', () => {
    const s = parent({ status: 'cancelled' });
    const kids = [visit(s, MON), visit(s, TUE)];
    const p = plan([s], kids);
    expect(p.series.active).toBe(1);
    expect(p.would_change.visits).toBe(2);
    // Ongoing alone does not keep a cancelled parent's series active: it needs a live row.
    expect(plan([s], [], { liveSeriesIds: [] }).series.active).toBe(0);
  });

  test('lapsed series (not ongoing, nothing open ahead) is not active', () => {
    const s = parent({ recurring_ongoing: false });
    const p = plan([s], [visit(s, '2099-05-01', { status: 'completed' })]);
    expect(p.series.active).toBe(0);
  });

  test('--to with explicit work_days changes the off days', () => {
    const s = parent();
    const vs = [MON_LATE, TUE, WED, THU, FRI].map((d) => visit(s, d));
    const p = plan([s], vs, { to: { id: HIRE, work_days: [2, 3, 4, 5] } });
    expect(p.target).toBe(HIRE);
    expect(p.target_work_days_source).toBe('technician_row');
    expect(p.would_change.by_weekday).toEqual({ Tue: 1, Wed: 1, Thu: 1, Fri: 1 });
    expect(p.stays_off_day).toEqual({ visits: 1, by_weekday: { Mon: 1 } });
    const every = plan([s], vs, { to: { id: HIRE, work_days: null } });
    expect(every.would_change.visits).toBe(5);
    expect(every.stays_off_day.visits).toBe(0);
  });

  test('question 1 = C: a customer with a weekend visit in the 13 weeks keeps the owner, whole', () => {
    const customerId = 'C-weekend';
    const general = parent({ customer_id: customerId });
    const mosquito = parent({ customer_id: customerId, line: 'mosquito' });
    const weekday = parent();
    const p = plan([general, mosquito, weekday], [visit(general, MON), visit(general, SAT), visit(mosquito, TUE), visit(weekday, WED)]);
    // Both series of the weekend customer stay: no template change and no visit moves, the weekday ones included.
    expect(p.skipped.off_day_customer).toEqual({ series: 2, visits: 3, customers: 1 });
    expect(p.ids.retemplate).toEqual([weekday.id]);
    expect(p.would_change.visits).toBe(1);
    expect(p.stays_off_day.visits).toBe(0);
    expect(p.off_day_policy).toBe('weekend_customer_stays_whole');
    expect(p.off_day_customer_until).toBe('2099-10-05');
  });

  test('the 13 weeks end before day 91: a weekend visit on day 90 keeps the customer, one after the window does not', () => {
    const inside = parent();
    const after = parent();
    // 2099-10-04 is a Sunday inside the window; 2099-10-10 a Saturday after it.
    const p = plan([inside, after], [visit(inside, MON), visit(inside, '2099-10-04'), visit(after, MON), visit(after, '2099-10-10')]);
    expect(p.skipped.off_day_customer).toEqual({ series: 1, visits: 2, customers: 1 });
    expect(p.ids.retemplate).toEqual([after.id]);
    expect(p.stays_off_day).toEqual({ visits: 1, by_weekday: { Sat: 1 } });
  });

  test('only a visit the run would move makes a weekend customer: done, someone else\'s, before --start, grouped or lawn do not', () => {
    const s = parent();
    const lawn = parent({ customer_id: s.customer_id, line: 'lawn' });
    const vs = [
      visit(s, MON),
      visit(s, SAT, { status: 'completed' }),
      visit(s, '2099-07-12', { technician_id: OTHER }),
      visit(s, '2099-07-05'), // a Sunday before --start
      visit(s, SAT, { visit_id: 'G-1', group_status: 'open' }),
      visit(lawn, SAT),
    ];
    const p = plan([s, lawn], vs);
    expect(p.skipped.off_day_customer).toBeUndefined();
    expect(p.ids.retemplate).toEqual([s.id]);
    expect(p.ids.visits).toEqual([vs[0].id]);
  });

  test('a series with no line is reported, not moved', () => {
    const s = parent({ line: null });
    const p = plan([s], [visit(s, MON)]);
    expect(p.skipped.no_line).toEqual({ series: 1, visits: 1 });
    expect(p.would_change.visits).toBe(0);
  });

  test('the plan carries no customer data: ids and counts only', () => {
    const s = parent({ customer_id: 'CUSTOMER-SECRET-ID' });
    s.customer_name = 'Jane Q Synthetic';
    s.email = 'synthetic@example.invalid';
    const p = plan([s], [visit(s, MON)]);
    const text = JSON.stringify(p);
    expect(text).not.toMatch(/Jane|Synthetic|example\.invalid|CUSTOMER-SECRET/);
  });
});

describe('second-tech-handover arguments and source', () => {
  test('defaultStart is the next Monday after today, ET', () => {
    expect(defaultStart(new Date('2099-07-01T16:00:00Z'))).toBe('2099-07-06'); // Wednesday
    expect(defaultStart(new Date('2099-07-06T16:00:00Z'))).toBe('2099-07-13'); // Monday -> the following Monday
    expect(defaultStart(new Date('2099-07-05T16:00:00Z'))).toBe('2099-07-06'); // Sunday
  });

  test('parseArgs reads the flags and keeps the defaults', () => {
    const a = parseArgs(['--from', OWNER, `--to=${HIRE}`, '--start', START, '--lines', 'rodent,general', '--list', '--json']);
    expect(a).toMatchObject({ from: OWNER, to: HIRE, start: START, lines: ['rodent', 'general'], list: true, json: true });
    expect(parseArgs(['--from', OWNER]).lines).toEqual(['general', 'rodent', 'mosquito']);
  });

  test('the planner file has no write path: --execute hands off to the execute file', () => {
    const src = fs.readFileSync(script, 'utf8');
    // crypto's hash .update() is not a database write.
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n').replace(/createHash\('sha256'\)\.update\(/g, 'createHash(');
    expect(src.split('\n')[1]).toMatch(/^\/\/ MUTATES \(dry-run default/);
    expect(code).not.toMatch(/\.(insert|update|del|delete|truncate|upsert)\s*\(/);
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE)\b/i);
    expect(code).toMatch(/SET TRANSACTION READ ONLY/);
    expect(code).toMatch(/require\('\.\/second-tech-handover-execute'\)\.main\(args\)/);
  });
});

describe('second-tech-handover PLAN ID', () => {
  const HIRE_ROW = { id: HIRE, work_days: [1, 2, 3, 4] };
  const build = (parents, visits, o = {}) => plan(parents, visits, { to: HIRE_ROW, ...o });
  const fixture = () => {
    const s = parent();
    return { s, vs: [MON, TUE, WED, THU, FRI_LATE].map((d) => visit(s, d)) };
  };

  test('the same plan gives the same 64-character id, whatever order the rows arrive in', () => {
    const { s, vs } = fixture();
    const a = build([s], vs);
    const b = build([s], [...vs].reverse());
    expect(a.planId).toMatch(/^[0-9a-f]{64}$/);
    expect(b.planId).toBe(a.planId);
    expect(a.ids.moves).toHaveLength(4);
  });

  test('the id changes when a visit, its date, the target, the start or the lines change', () => {
    const { s, vs } = fixture();
    const base = build([s], vs).planId;
    // one fewer visit to move (it was completed)
    expect(build([s], vs.map((v, i) => (i === 0 ? { ...v, status: 'completed' } : v))).planId).not.toBe(base);
    // a visit's date moved (still a target work day)
    expect(build([s], vs.map((v, i) => (i === 0 ? { ...v, scheduled_date: '2099-07-13' } : v))).planId).not.toBe(base);
    // a different hire
    expect(build([s], vs, { to: { id: OTHER, work_days: [1, 2, 3, 4] } }).planId).not.toBe(base);
    // the hire's day off changes which visits move
    expect(build([s], vs, { to: { id: HIRE, work_days: [1, 2, 3, 4, 5] } }).planId).not.toBe(base);
    // a later start
    expect(build([s], vs, { start: TUE }).planId).not.toBe(base);
    // a narrower line set
    expect(build([s], vs, { lines: ['rodent'] }).planId).not.toBe(base);
  });

  test('a series that only changes template (no visit to move) is part of the id', () => {
    const { s, vs } = fixture();
    const extra = parent();
    expect(build([s, extra], vs).planId).not.toBe(build([s], vs).planId);
  });

  test('the id is in the dry-run text and in --json, and the list shows every change as ids only', () => {
    const { printPlan } = require(script);
    const { s, vs } = fixture();
    const p = build([s], vs);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printPlan(p, { list: false });
      expect(log.mock.calls[0][0]).toContain(`PLAN ID: ${p.planId}`);
    } finally {
      log.mockRestore();
    }
    expect(JSON.parse(JSON.stringify(p)).planId).toBe(p.planId);
  });
});

describe('second-tech-handover execute flags and refusals', () => {
  const PLAN = 'a'.repeat(64);
  const exit = () => jest.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${code}`); });
  const quiet = () => jest.spyOn(console, 'error').mockImplementation(() => {});

  test('parseArgs reads --execute, --plan, --rollback and --out-dir', () => {
    expect(parseArgs(['--from', OWNER, '--to', HIRE, '--execute', '--plan', PLAN, '--out-dir', '/tmp/x'])).toMatchObject({
      execute: true, plan: PLAN, outDir: '/tmp/x', rollback: null,
    });
    expect(parseArgs(['--rollback', '/tmp/f.json'])).toMatchObject({ rollback: '/tmp/f.json', execute: false, from: null });
    expect(parseArgs(['--from', OWNER]).execute).toBe(false);
  });

  test('--execute without --to, without --plan, or with a bad plan id exits 2 before any connection', () => {
    const ex = exit(); const err = quiet();
    try {
      expect(() => parseArgs(['--from', OWNER, '--execute', '--plan', PLAN])).toThrow('exit 2');
      expect(() => parseArgs(['--from', OWNER, '--to', HIRE, '--execute'])).toThrow('exit 2');
      expect(() => parseArgs(['--from', OWNER, '--to', HIRE, '--execute', '--plan', 'abc'])).toThrow('exit 2');
      expect(() => parseArgs(['--from', OWNER, '--to', HIRE, '--plan', PLAN])).toThrow('exit 2');
      expect(() => parseArgs(['--from', OWNER, '--to', OWNER, '--execute', '--plan', PLAN])).toThrow('exit 2');
      expect(() => parseArgs(['--rollback', '/tmp/f.json', '--execute', '--plan', PLAN])).toThrow('exit 2');
    } finally {
      ex.mockRestore(); err.mockRestore();
    }
  });

  const { executeHandover, rollbackHandover, restartWindowReason, checkTarget, summaryCard, Refusal } = require('../../ops/agents/second-tech-handover-execute.js');
  const base = { from: OWNER, to: HIRE, start: START, planId: PLAN, now: new Date('2099-07-01T16:00:00Z') };

  test('executeHandover refuses with no connection used: no --to, same technician, no plan id', async () => {
    await expect(executeHandover(null, { ...base, to: null })).rejects.toMatchObject({ code: 'NO_TARGET' });
    await expect(executeHandover(null, { ...base, to: OWNER })).rejects.toMatchObject({ code: 'SAME_TECHNICIAN' });
    await expect(executeHandover(null, { ...base, planId: null })).rejects.toMatchObject({ code: 'NO_PLAN_ID' });
    await expect(executeHandover(null, { ...base, planId: 'abc' })).rejects.toBeInstanceOf(Refusal);
  });

  test('the target must be assignable and have an explicit work-days list', () => {
    const ok = { id: HIRE, employment_status: 'active', field_dispatchable: true, work_days: [1, 2, 3, 4] };
    expect(() => checkTarget(ok)).not.toThrow();
    expect(() => checkTarget(null)).toThrow(/no technician row/);
    expect(() => checkTarget({ ...ok, employment_status: 'prospective' })).toThrow(/not assignable/);
    expect(() => checkTarget({ ...ok, field_dispatchable: false })).toThrow(/not assignable/);
    for (const work_days of [null, [], '{}', [0, 1, 2, 3, 4, 5, 6]]) {
      expect(() => checkTarget({ ...ok, work_days })).toThrow(/no work days set/);
    }
    expect(() => checkTarget({ ...ok, work_days: '{1,2,3,4}' })).not.toThrow();
  });

  test('restart windows: 03:50-04:20 ET daily and 06:40-07:02 ET Mondays', () => {
    // 2099-07-06 is a Monday; EDT = UTC-4.
    const et = (day, hhmm) => new Date(`${day}T${hhmm}:00-04:00`);
    expect(restartWindowReason(et('2099-07-07', '03:49'))).toBeNull();
    expect(restartWindowReason(et('2099-07-07', '03:50'))).toMatch(/04:10 auto-dispatch/);
    expect(restartWindowReason(et('2099-07-07', '04:10'))).toMatch(/04:10 auto-dispatch/);
    expect(restartWindowReason(et('2099-07-07', '04:20'))).toMatch(/04:10 auto-dispatch/);
    expect(restartWindowReason(et('2099-07-07', '04:21'))).toBeNull();
    expect(restartWindowReason(et('2099-07-07', '06:50'))).toBeNull(); // Tuesday
    expect(restartWindowReason(et('2099-07-06', '06:39'))).toBeNull();
    expect(restartWindowReason(et('2099-07-06', '06:40'))).toMatch(/Monday/);
    expect(restartWindowReason(et('2099-07-06', '07:02'))).toMatch(/Monday/);
    expect(restartWindowReason(et('2099-07-06', '07:03'))).toBeNull();
  });

  test('both writers refuse inside a restart window before touching the database', async () => {
    const inWindow = new Date('2099-07-07T04:10:00-04:00');
    await expect(executeHandover(null, { ...base, now: inWindow })).rejects.toMatchObject({ code: 'RESTART_WINDOW' });
    const file = path.join(require('os').tmpdir(), `handover-unit-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({ version: 1, run_id: '00000000-0000-4000-8000-0000000000aa', plan_id: PLAN, from: OWNER, to: HIRE, series: [], visits: [] }));
    try {
      await expect(rollbackHandover(null, { file, now: inWindow })).rejects.toMatchObject({ code: 'RESTART_WINDOW' });
      await expect(rollbackHandover(null, { file: `${file}.missing` })).rejects.toMatchObject({ code: 'BAD_ROLLBACK_FILE' });
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('the summary card carries counts only', () => {
    expect(summaryCard({ visits: 12, customers: 9, series: 7 })).toEqual({
      type: 'series_handover',
      message: 'You now have 12 visits across 9 customers. They are on your schedule.',
      payload: { headline: 'Visits moved to your schedule', visits: 12, customers: 9, series: 7 },
    });
    expect(summaryCard({ visits: 1, customers: 1, series: 1 }).message).toBe('You now have 1 visit across 1 customer. They are on your schedule.');
  });

  test('the execute file reaches no sender: no per-visit notice, push, text, email or board broadcast', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'ops', 'agents', 'second-tech-handover-execute.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    expect(src.split('\n')[0]).toBe('// MUTATES');
    for (const banned of [
      'tech-visit-notifications', 'dispatch-assignment', 'push-notifications', 'twilio', 'sendgrid', 'sms', 'notification-service',
      'admin-alert', 'visit-groups', 'appointment-reminders', 'rebooker', 'sockets', 'notifyAssignmentChange',
    ]) expect(code.toLowerCase()).not.toContain(banned.toLowerCase());
    // The one message is the hire's card, through the tech feed's own writer.
    expect(code.match(/sendTechNotification\(/g)).toHaveLength(1);
  });

  test('the series-maintenance fence uses the same key as admin-schedule acquireRecurringSeriesMaintenanceLock', () => {
    const { SERIES_MAINTENANCE_LOCK } = require('../../ops/agents/second-tech-handover-execute.js');
    const schedule = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const start = schedule.indexOf('async function acquireRecurringSeriesMaintenanceLock(');
    expect(start).toBeGreaterThan(-1);
    const body = schedule.slice(start, schedule.indexOf('\n}\n', start));
    // Same two-key advisory lock, same first key: a drift here would let a nightly top-up slip past the run.
    expect(body).toContain('pg_advisory_xact_lock(hashtext(?), hashtext(?::text))');
    expect(body).toContain(`'${SERIES_MAINTENANCE_LOCK}'`);
    const execSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'ops', 'agents', 'second-tech-handover-execute.js'), 'utf8');
    expect(execSrc).toContain("trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', [SERIES_MAINTENANCE_LOCK, id])");
  });
});

describe('tlsFor (connection TLS)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { tlsFor } = require('../../ops/agents/second-tech-handover.js');
  const REMOTE = 'postgresql://user:secret@example.proxy.rlwy.net:12345/railway';

  test('a local database needs no TLS', () => {
    expect(tlsFor('postgresql://waves@localhost:5439/waves_test', null)).toBe(false);
    expect(tlsFor('postgres://u:p@127.0.0.1:5432/db', null)).toBe(false);
  });

  test('the public proxy without a pinned root is refused, even when the password says "localhost"', () => {
    expect(() => tlsFor(REMOTE, null)).toThrow(/PG_CA_FILE/);
    expect(() => tlsFor('postgresql://u:localhost@example.proxy.rlwy.net:1/db', null)).toThrow(/PG_CA_FILE/);
  });

  test('TLS options in the URL are refused, and the URL never reaches pg (fields only)', () => {
    const { connectionFields, readOnlyConn } = require('../../ops/agents/second-tech-handover.js');
    for (const q of ['sslmode=disable', 'sslmode=no-verify', 'ssl=false', 'sslrootcert=/tmp/x']) {
      expect(() => connectionFields(`${REMOTE}?${q}`)).toThrow(/refusing TLS options/);
    }
    expect(connectionFields('postgresql://u%40x:p%2Fq@example.proxy.rlwy.net:6543/rail%20way?application_name=plan')).toEqual({
      host: 'example.proxy.rlwy.net', port: 6543, user: 'u@x', password: 'p/q', database: 'rail way',
    });
    const file = path.join(os.tmpdir(), `pinned-root-b-${process.pid}.pem`);
    fs.writeFileSync(file, '-----BEGIN CERTIFICATE-----\nMIIBsynthetic\n-----END CERTIFICATE-----\n');
    const prior = process.env.PG_CA_FILE;
    process.env.PG_CA_FILE = file;
    const conn = readOnlyConn(REMOTE);
    try {
      const cfg = conn.client.config.connection;
      expect(cfg.connectionString).toBeUndefined();
      expect(cfg.ssl.rejectUnauthorized).toBe(true);
      expect(cfg.enableChannelBinding).toBe(true);
      expect(cfg.host).toBe('example.proxy.rlwy.net');
    } finally {
      if (prior === undefined) delete process.env.PG_CA_FILE; else process.env.PG_CA_FILE = prior;
      fs.unlinkSync(file);
      conn.destroy();
    }
  });

  test('a remote login is SCRAM-SHA-256-PLUS only: cleartext, MD5 and unbound SCRAM requests are refused', () => {
    const { EventEmitter } = require('events');
    const { scramPlusOnly } = require('../../ops/agents/second-tech-handover.js');
    const pg = { Client: class { _handleAuthSASL() { this.saslStarted = true; } } };
    scramPlusOnly(pg);
    const fake = () => { const c = new pg.Client(); c.connection = new EventEmitter(); c.errors = []; c.connection.on('error', (e) => c.errors.push(e.message)); return c; };
    const a = fake(); a._handleAuthCleartextPassword({});
    const b = fake(); b._handleAuthMD5Password({ salt: Buffer.alloc(4) });
    const c = fake(); c._handleAuthSASL({ mechanisms: ['SCRAM-SHA-256'] });
    const d = fake(); d._handleAuthSASL({ mechanisms: ['SCRAM-SHA-256-PLUS', 'SCRAM-SHA-256'] });
    expect(a.errors).toEqual([expect.stringMatching(/cleartext.*SCRAM-SHA-256-PLUS only/)]);
    expect(b.errors).toEqual([expect.stringMatching(/MD5.*SCRAM-SHA-256-PLUS only/)]);
    expect(c.errors).toEqual([expect.stringMatching(/without channel binding/)]);
    expect(c.saslStarted).toBeUndefined();
    expect(d.errors).toEqual([]);
    expect(d.saslStarted).toBe(true);
  });

  test('with a pinned root the chain is verified (rejectUnauthorized on); only the name check is skipped', () => {
    const file = path.join(os.tmpdir(), `pinned-root-${process.pid}.pem`);
    fs.writeFileSync(file, '-----BEGIN CERTIFICATE-----\nMIIBsynthetic\n-----END CERTIFICATE-----\n');
    try {
      const tls = tlsFor(REMOTE, file);
      expect(tls.rejectUnauthorized).toBe(true);
      expect(tls.ca).toContain('BEGIN CERTIFICATE');
      expect(tls.checkServerIdentity('example.proxy.rlwy.net', {})).toBeUndefined();
    } finally {
      fs.unlinkSync(file);
    }
  });
});

// Territories by ZIP, build 6 (owner 2026-10-30): --zips moves only the listed ZIPs' series, and
// the plan carries each listed ZIP's territory technician so --execute can hand the ZIP over too.
describe('second-tech-handover planner — --zips (territory handover)', () => {
  const crypto = require('crypto');
  const { planIdOf } = require(script);
  const territory = [{ zip: '34293', area: 'venice', technician_id: null }, { zip: '34285', area: 'venice', technician_id: null }];

  test('parseArgs takes a sorted, de-duplicated ZIP list and refuses anything else', () => {
    expect(parseArgs(['--from', OWNER, '--zips', '34293, 34285,34293']).zips).toEqual(['34285', '34293']);
    expect(parseArgs(['--from', OWNER]).zips).toBeNull();
    const exit = jest.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${code}`); });
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseArgs(['--from', OWNER, '--zips', '3429'])).toThrow('exit 2');
    expect(() => parseArgs(['--from', OWNER, '--zips', 'FL 34293'])).toThrow('exit 2');
    exit.mockRestore(); err.mockRestore();
  });

  test('a series outside the listed ZIPs stays whole (outside_zips); a listed one moves', () => {
    const south = parent({ zip: '34293' });
    const north = parent({ zip: '34219' });
    const noZip = parent({ zip: null });
    const p = plan([south, north, noZip], [visit(south, MON), visit(north, TUE), visit(noZip, WED)], { zips: ['34285', '34293'], territory });
    expect(p.ids.series).toEqual([south.id]);
    expect(p.skipped.outside_zips).toMatchObject({ series: 2, visits: 2 });
    // The line count still counts every series of these lines.
    expect(p.series.in_lines).toBe(3);
    expect(p.zips).toEqual(['34285', '34293']);
    expect(p.territory).toEqual(territory);
  });

  test('without --zips the PLAN ID is exactly the pre-territory id', () => {
    const args = { from: OWNER, to: HIRE, start: START, lines: ['general'], retemplate: ['S-a'], moves: [{ series_id: 'S-a', visit_id: 'V-a', date: MON }] };
    const rows = [JSON.stringify(['S-a', '', '', OWNER]), JSON.stringify(['S-a', 'V-a', MON, OWNER])].sort();
    const legacy = crypto.createHash('sha256')
      .update(JSON.stringify({ v: 1, from: OWNER, to: HIRE, start: START, lines: ['general'], rows })).digest('hex');
    expect(planIdOf(args)).toBe(legacy);
  });

  test('the ZIP list and each ZIP\'s current territory technician are part of the PLAN ID', () => {
    const args = { from: OWNER, to: HIRE, start: START, lines: ['general'], retemplate: [], moves: [] };
    const withZips = planIdOf({ ...args, zips: ['34293'], territory: [{ zip: '34293', technician_id: null }] });
    expect(withZips).not.toBe(planIdOf(args));
    expect(planIdOf({ ...args, zips: ['34293'], territory: [{ zip: '34293', technician_id: OTHER }] })).not.toBe(withZips);
    expect(planIdOf({ ...args, zips: ['34285'], territory: [{ zip: '34285', technician_id: null }] })).not.toBe(withZips);
  });
});

// ops/agents/second-tech-handover.js — the pure planner. READ-ONLY build 6 of the
// second-tech plan: it must name what a later --execute would move, and nothing else.
// Synthetic ids only. 2099-07-06 is a Monday.
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const script = path.join(__dirname, '..', '..', 'ops', 'agents', 'second-tech-handover.js');
const {
  buildPlan, parseArgs, defaultStart, isOpenVisit, isGroupedVisit, seriesTechnicianId, isBaitSeries, isTermiteBaitAddon,
  printPlan, planHandover, PlanError, offCapabilityLines, MOVABLE_LINES, TERRITORY_MOVABLE_LINES,
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

// Owner 2026-10-30 (corrected the same day): "termite and WDO follow the territory". A --zips run also hands over termite
// and WDO series; a run without --zips is what it was. Termite BAIT customers stay with the owner in every run.
describe('second-tech-handover — termite / WDO by territory', () => {
  const territory = [{ zip: '34293', area: 'venice', technician_id: null }];
  const south = (o = {}) => parent({ zip: '34293', ...o });
  const termitePlan = (parents, visits, o = {}) => plan(parents, visits, { zips: ['34293'], territory, lines: TERRITORY_MOVABLE_LINES, ...o });

  test('the territory lines are the four lines services/territory.js names; lawn is in neither list', () => {
    const { TERRITORY_LINES } = require('../services/territory');
    expect(new Set(TERRITORY_MOVABLE_LINES)).toEqual(new Set(TERRITORY_LINES));
    expect(TERRITORY_MOVABLE_LINES).toEqual([...MOVABLE_LINES, 'termite']);
    expect(MOVABLE_LINES).not.toContain('termite');
    expect(TERRITORY_MOVABLE_LINES).not.toContain('lawn');
  });

  test('a termite series moves in a --zips run: its template and its Mon-Thu visits', () => {
    const termite = south({ line: 'termite', service_type: 'Termite Spot Treatment Service' });
    const wdo = south({ line: 'termite', service_type: 'WDO Inspection' });
    const p = termitePlan([termite, wdo], [visit(termite, TUE), visit(wdo, WED)]);
    expect(p.series.retemplate).toBe(2);
    expect(p.would_change.by_line).toEqual({ termite: { series: 2, visits: 2 } });
    expect(p.retemplate_by_line).toEqual({ termite: 2 });
    expect(p.skipped.other_line).toBeUndefined();
  });

  test('without termite in the lines (a run without --zips) the same series stays as other_line', () => {
    const termite = parent({ line: 'termite', service_type: 'Termite Spot Treatment Service' });
    const p = plan([termite], [visit(termite, TUE)]);
    expect(p.series.retemplate).toBe(0);
    expect(p.skipped.other_line).toEqual({ series: 1, visits: 1 });
  });

  test('a termite series outside the listed ZIPs stays (the south goes to the hire, the north stays)', () => {
    const north = parent({ zip: '34219', line: 'termite' });
    const p = termitePlan([north], [visit(north, TUE)]);
    expect(p.skipped.outside_zips).toMatchObject({ series: 1, visits: 1 });
    expect(p.series.retemplate).toBe(0);
  });

  test('termite bait customers still stay whole in a territory run, and the dry run prints their count', () => {
    const bait = south({ customer_id: 'C-bait2', line: 'termite', service_key_snapshot: 'termite_active_bait_quarterly', service_type: 'Quarterly Termite Active Bait Station Service' });
    const baitPest = south({ customer_id: 'C-bait2' });
    const plain = south({ line: 'termite', service_type: 'Termite Spot Treatment Service' });
    const p = termitePlan([bait, baitPest, plain], [bait, baitPest, plain].map((s) => visit(s, MON)));
    expect(p.skipped.termite_bait_customer).toEqual({ series: 2, visits: 2, customers: 1 });
    expect(p.ids.series).toEqual([plain.id]);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    printPlan({ ...p, planId: 'x' }, { list: false });
    const text = log.mock.calls.map((c) => c[0]).join('\n');
    log.mockRestore();
    expect(text).toMatch(/Termite bait customers kept with the owner in every run \(owner has not ruled on bait\): 1 customers, 2 series, 2 visits/);
  });

  test('lawn never moves, even in a territory run', () => {
    const lawn = south({ line: 'lawn', service_type: 'Lawn Care Program' });
    const p = termitePlan([lawn], [visit(lawn, MON)]);
    expect(p.skipped.other_line).toEqual({ series: 1, visits: 1 });
    expect(p.series.retemplate).toBe(0);
  });

  test('parseArgs: --zips alone defaults to the four lines; --lines narrows it; termite without --zips exits 2', () => {
    expect(parseArgs(['--from', OWNER]).lines).toEqual(MOVABLE_LINES);
    expect(parseArgs(['--from', OWNER, '--zips', '34293']).lines).toEqual(['general', 'rodent', 'mosquito', 'termite']);
    expect(parseArgs(['--from', OWNER, '--zips', '34293', '--lines', 'general']).lines).toEqual(['general']);
    expect(parseArgs(['--from', OWNER, '--zips', '34293', '--lines', 'termite']).lines).toEqual(['termite']);
    const exit = jest.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${code}`); });
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseArgs(['--from', OWNER, '--lines', 'termite'])).toThrow('exit 2');
    expect(err.mock.calls.map((c) => c[0]).join(' ')).toMatch(/termite needs --zips/);
    expect(() => parseArgs(['--from', OWNER, '--lines', 'general,termite'])).toThrow('exit 2');
    expect(() => parseArgs(['--from', OWNER, '--lines', 'lawn'])).toThrow('exit 2');
    exit.mockRestore(); err.mockRestore();
  });

  test('planHandover refuses termite without --zips before it reads anything', async () => {
    await expect(planHandover(null, { from: OWNER, start: START, today: TODAY, lines: ['termite'] })).rejects.toMatchObject({ code: 'LINES_NEED_ZIPS' });
    await expect(planHandover(null, { from: OWNER, start: START, today: TODAY, lines: ['termite'] })).rejects.toBeInstanceOf(PlanError);
  });

  test('a WDO inspection reads termite: by name, and by the catalog categories wdo and termite', async () => {
    const { serviceLineFor } = require('../services/scheduling/line-technician');
    for (const name of ['WDO Inspection', 'WDO / Wood Destroying Organism Inspection', 'Wood-Destroying Organism Inspection', 'Termite Spot Treatment']) {
      expect(await serviceLineFor(null, { serviceType: name })).toEqual({ line: 'termite', lineFrom: 'name' });
    }
    // The catalog row wins over a name that would read general.
    const catalog = (category) => () => ({ where: () => ({ first: async () => ({ category }) }) });
    for (const category of ['wdo', 'termite']) {
      expect(await serviceLineFor(catalog(category), { serviceId: 'svc-1', serviceType: 'Home Inspection' })).toEqual({ line: 'termite', lineFrom: 'catalog' });
    }
  });

  test('offCapabilityLines: only an Off row (active false) counts; unset, qualified and review_required are allowed', async () => {
    const rows = [
      { service_category: 'termite', capability_level: 'review_required', active: false },
      { service_category: 'general', capability_level: 'qualified', active: true },
      { service_category: 'rodent', capability_level: 'review_required', active: true },
    ];
    const db = () => ({ where: () => ({ whereIn: () => ({ select: async () => rows }) }) });
    expect(await offCapabilityLines(db, HIRE, ['general', 'rodent', 'mosquito', 'termite'])).toEqual(['termite']);
    expect(await offCapabilityLines(db, null, ['termite'])).toEqual([]);
    expect(await offCapabilityLines(db, HIRE, [])).toEqual([]);
  });
});

// The day-60 second run (--weekend-move, owner 2026-10-28 question 1 = C): weekend customers move to the hire, each live
// visit on a day off to the nearest hire work day within ±5 days, the series re-anchored so top-up keeps the new weekday.
describe('second-tech-handover — --weekend-move date logic', () => {
  const weekend = require('../../ops/agents/second-tech-handover-weekend.js');
  const seeder = require('../services/recurring-appointment-seeder');
  const { measureRecurringSeries } = require('../services/recurring-schedule-audit');
  const { daysBetween } = require('../services/auto-dispatch/route-tiers');
  const hop = (date, pattern, n, opts) => seeder._internals.nextRecurringDate(date, pattern, n, opts);
  const ord = (date) => seeder._internals.recurrenceOrdinalOptions(date, {});
  const MON_THU = [1, 2, 3, 4];

  // A series of `count` visits from `first`, spaced as top-up spaces them (its own ordinal weekday), held by OWNER.
  let n = 0;
  const series = (first, { pattern = 'quarterly', count = 3, customer = `C-w${++n}`, window = ['09:00:00', '10:00:00'], parentExtra = {}, visitExtra = {} } = {}) => {
    // The parent's own date sits on the series' weekday, as for a series top-up grew from its first visit.
    const parentRow = { id: `P-w${n}`, customer_id: customer, service_type: 'Quarterly Pest Control', recurring_pattern: pattern, recurring_nth: null, recurring_weekday: null, recurring_interval_days: null, scheduled_date: first, ...parentExtra };
    const opts = { ...ord(first), intervalDays: parentExtra.recurring_interval_days };
    const visits = Array.from({ length: count }, (_, i) => ({
      id: `V-w${n}-${i}`, series_id: parentRow.id, recurring_parent_id: parentRow.id, is_recurring: true, scheduled_date: i === 0 ? first : hop(first, pattern, i, opts),
      status: 'confirmed', technician_id: OWNER, window_start: window[0], window_end: window[1], ...visitExtra,
    }));
    const live = visits;
    return { customer_id: customer, series: [{ parent: parentRow, live, chain: live, rows: live, needsDates: true }] };
  };
  const facts = (over = {}) => ({
    blackout: null, absentDates: new Set(), prefs: new Map(), neighbors: new Map(), stayStill: new Map(), noWeekends: new Map(), anchors: new Map(), bases: new Map(), ...over,
  });
  const clearFacts = (candidates, over = {}) => {
    const f = facts(over);
    for (const c of candidates) {
      f.prefs.set(c.customer_id, { preferred_day_indexes: [], blackout: null });
      for (const s of c.series) for (const v of s.live) { f.neighbors.set(v.id, { prev: null, next: null }); f.stayStill.set(v.id, null); f.anchors.set(v.id, v.scheduled_date); }
    }
    return f;
  };
  const run = (candidates, o = {}) => weekend.resolveWeekendMoves({
    candidates, from: OWNER, workDays: MON_THU, start: o.start || START, today: TODAY, facts: o.facts || clearFacts(candidates), free: o.free || (async () => true), seed: o.seed, own: o.own,
  });
  const dow = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();

  test('candidate days: --to work days within ±5 days, nearest first, a tie takes the earlier date, none before --start', () => {
    expect(weekend.candidateDates(SAT, MON_THU, TODAY, START)).toEqual(['2099-07-09', '2099-07-13', '2099-07-08', '2099-07-14', '2099-07-07', '2099-07-15', '2099-07-06', '2099-07-16']);
    // Nothing inside the 73 h freeze margin (today + 4 days), here with the earliest --start the run allows.
    expect(weekend.candidateDates('2099-07-02', MON_THU, '2099-06-30', '2099-07-04')).toEqual(['2099-07-06', '2099-07-07']);
    // Nothing before --start, the first solo day: with a Friday --start the Saturday keeps only the next week's days.
    expect(weekend.candidateDates(SAT, MON_THU, TODAY, FRI)).toEqual(['2099-07-13', '2099-07-14', '2099-07-15', '2099-07-16']);
  });

  test('a new date is never before --start: with a Friday --start the Saturday visit takes the Monday after, not the Thursday before', async () => {
    const late = series(SAT, { count: 1 });
    expect((await run([late], { start: FRI })).newDates.get(late.series[0].live[0].id)).toBe('2099-07-13');
    // The control: with a Monday --start the same Saturday takes the Thursday before it.
    const control = series(SAT, { count: 1 });
    expect((await run([control])).newDates.get(control.series[0].live[0].id)).toBe('2099-07-09');
  });

  test('Sat -> Thu (-2), Sun -> Mon (+1), Fri -> Thu (-1): the first visit and every later one, re-anchored on the new weekday', async () => {
    for (const [first, expected, label] of [[SAT, '2099-07-09', 'Sat -> Thu'], ['2099-07-12', '2099-07-13', 'Sun -> Mon'], [FRI, '2099-07-09', 'Fri -> Thu']]) {
      // Three quarterly visits; the Friday series has two (a third would sit 6 days from its Thursday projection, so the Wednesday wins).
      const c = series(first, { count: first === FRI ? 2 : 3 });
      const { kept, newDates, anchors } = await run([c]);
      expect(kept.size).toBe(0);
      expect(newDates.get(c.series[0].live[0].id)).toBe(expected);
      expect(weekend.changeLabel(first, expected)).toBe(label);
      const toDay = dow(expected);
      for (const v of c.series[0].live) {
        const d = newDates.get(v.id);
        expect(dow(d)).toBe(toDay);
        expect(Math.abs(daysBetween(v.scheduled_date, d))).toBeLessThanOrEqual(5);
      }
      expect(anchors).toEqual([expect.objectContaining({ weekday: toDay, old_nth: null, old_weekday: null })]);
    }
  });

  test('the next top-up child lands on the new weekday, and the recurring audit reads the moved visits as on cadence', async () => {
    const c = series(SAT);
    const { newDates, anchors } = await run([c]);
    const [a] = anchors;
    const moved = c.series[0].live.map((v) => ({ ...v, scheduled_date: newDates.get(v.id) }));
    const parentAfter = { ...c.series[0].parent, recurring_nth: a.nth, recurring_weekday: a.weekday };
    // Top-up hops from the latest live visit with the parent's stamped nth / weekday (admin-schedule seriesRecurrenceOptions).
    const latest = moved[moved.length - 1].scheduled_date;
    const topUp = hop(latest, 'quarterly', 1, seeder._internals.recurrenceOrdinalOptions('2099-04-04', { nth: parentAfter.recurring_nth, weekday: parentAfter.recurring_weekday }));
    expect(dow(topUp)).toBe(dow(newDates.get(c.series[0].live[0].id)));
    // The control: without the stamp the same hop returns to the parent's Saturday (the reason for the re-anchor).
    expect(dow(hop(latest, 'quarterly', 1, seeder._internals.recurrenceOrdinalOptions('2099-04-04', {})))).toBe(6);
    // The audit measures every interval against the stamped template: no drift.
    const template = { ...parentAfter, id: 'P', scheduled_date: '2099-04-04', is_recurring: true, status: 'completed', recurring_ongoing: true };
    const rows = [template, ...moved.map((v) => ({ ...v, date_exception: false }))];
    const measured = measureRecurringSeries(template, rows, { todayET: TODAY });
    expect(measured.intervals.map((i) => i.driftDays)).toEqual([0, 0, 0]);
  });

  test('a day-gap series (every 6 weeks, custom) keeps the new weekday with no anchor write', async () => {
    for (const [pattern, extra] of [['every_6_weeks', {}], ['custom', { recurring_interval_days: 21 }]]) {
      const c = series(SAT, { pattern, parentExtra: extra });
      const { newDates, anchors } = await run([c]);
      const days = c.series[0].live.map((v) => newDates.get(v.id));
      expect(anchors).toEqual([]);
      expect(days.map(dow)).toEqual([4, 4, 4]);
      // Top-up adds the fixed gap to the latest visit: the new weekday carries on.
      expect(dow(hop(days[2], pattern, 1, { intervalDays: extra.recurring_interval_days }))).toBe(4);
    }
  });

  test('a day gap that is not whole weeks keeps the customer whole: top-up would walk the series back onto a day off (cadence_drift)', async () => {
    // A custom 9-day series, Thu 07-09 and Sat 07-18. A Tue 07-07 / Thu 07-16 re-date would fit both visits,
    // but top-up hops 9 days from the latest visit: its next child for the hire is Sat 07-25.
    expect(dow(hop('2099-07-16', 'custom', 1, { intervalDays: 9 }))).toBe(6);
    const parentRow = { id: 'P-stay', customer_id: 'C-stay', service_type: 'Pest', recurring_pattern: 'custom', recurring_nth: null, recurring_weekday: null, recurring_interval_days: 9 };
    const live = ['2099-07-09', '2099-07-18'].map((d, i) => ({
      id: `V-stay-${i}`, series_id: 'P-stay', recurring_parent_id: 'P-stay', is_recurring: true, scheduled_date: d, status: 'confirmed',
      technician_id: OWNER, window_start: '09:00:00', window_end: '10:00:00',
    }));
    const c = { customer_id: 'C-stay', series: [{ parent: parentRow, live, chain: live, rows: live, needsDates: true }] };
    const out = await run([c]);
    expect(out.kept.get('C-stay')).toBe('cadence_drift');
    expect(out.newDates.size).toBe(0);
    // Daily and a custom 30 days drift the same way (a custom 21 days is whole weeks: the day-gap test above moves it).
    for (const [pattern, days] of [['daily', null], ['custom', 30]]) {
      const d = series(SAT, { pattern, count: 1, parentExtra: { recurring_interval_days: days } });
      expect((await run([d])).kept.get(d.customer_id)).toBe('cadence_drift');
    }
    // A drifting series with no visit to re-date keeps its customer too: it moves to --to with the rest.
    const two = series(SAT, { count: 1 });
    const thu = { id: 'V-drift-0', series_id: 'P-drift', recurring_parent_id: 'P-drift', is_recurring: true, scheduled_date: '2099-07-09', status: 'confirmed', technician_id: OWNER, window_start: '13:00:00', window_end: '14:00:00' };
    two.series.push({ parent: { ...parentRow, id: 'P-drift', customer_id: two.customer_id }, live: [thu], chain: [thu], rows: [thu], needsDates: false });
    const both = await run([two]);
    expect(both.kept.get(two.customer_id)).toBe('cadence_drift');
    expect(both.newDates.size).toBe(0);
  });

  test('a cancelled or skipped middle occurrence does not shift the later dates (seasonal Feb-Oct and monthly walks count the real cadence steps)', async () => {
    for (const [pattern, first, steps] of [['seasonal_feb_oct', '2099-07-11', 2], ['monthly', '2099-07-11', 2], ['quarterly', '2099-07-11', 2]]) {
      const parentRow = { id: `P-gap-${pattern}`, customer_id: `C-gap-${pattern}`, service_type: 'Mosquito', recurring_pattern: pattern, recurring_nth: null, recurring_weekday: null, recurring_interval_days: null };
      const opts = ord(first);
      // The occurrence one step after `first` was cancelled: the survivors sit `steps` cadence steps apart.
      const live = [first, hop(first, pattern, steps, opts)].map((d, i) => ({
        id: `V-gap-${pattern}-${i}`, series_id: parentRow.id, recurring_parent_id: parentRow.id, is_recurring: true, scheduled_date: d, status: 'confirmed',
        technician_id: OWNER, window_start: '09:00:00', window_end: '10:00:00',
      }));
      const c = { customer_id: parentRow.customer_id, series: [{ parent: parentRow, live, chain: live, rows: live, needsDates: true }] };
      const out = await run([c]);
      expect(out.kept.size).toBe(0);
      expect(live.map((v) => dow(out.newDates.get(v.id)))).toEqual([4, 4]);
      for (const v of live) expect(Math.abs(daysBetween(v.scheduled_date, out.newDates.get(v.id)))).toBeLessThanOrEqual(5);
    }
  });

  test('month boundary: a 1st Saturday moved two days earlier lands in the previous month, projects wrong, so the next day is tried', async () => {
    let first = null;
    for (let m = 1; m <= 12 && !first; m += 1) {
      const d = `2099-${String(m).padStart(2, '0')}-01`;
      if (dow(d) === 6) first = d;
    }
    const c = series(first);
    const { kept, newDates, anchors } = await run([c]);
    expect(kept.size).toBe(0);
    const firstNew = newDates.get(c.series[0].live[0].id);
    // Not the Thursday before (the 5th / last Thursday of the previous month): the Monday after, in the same month.
    expect(firstNew).toBe(`${first.slice(0, 8)}03`);
    expect(anchors[0]).toMatchObject({ nth: 1, weekday: 1 });
    for (const v of c.series[0].live) expect(Math.abs(daysBetween(v.scheduled_date, newDates.get(v.id)))).toBeLessThanOrEqual(5);
  });

  test('a visit never reaches or crosses its adjacent occurrence (the flex-tier neighbor bound)', async () => {
    const c = series(SAT, { count: 1 });
    const f = clearFacts([c]);
    f.neighbors.set(c.series[0].live[0].id, { prev: '2099-07-09', next: null });
    expect((await run([c], { facts: f })).newDates.get(c.series[0].live[0].id)).toBe('2099-07-13');
    f.neighbors.set(c.series[0].live[0].id, null);
    expect((await run([c], { facts: f })).kept.get(c.customer_id)).toBe('neighbor');
  });

  test("the flex tier's cumulative allowance: a visit auto-dispatch already moved can only go ±5 days of its durable original date; an unknown anchor fails closed", async () => {
    const c = series(SAT, { count: 1 });
    const id = c.series[0].live[0].id;
    const f = clearFacts([c]);
    // Originally Friday 07-03: Thursday 07-09 is 6 days from it, so the Wednesday 07-08 (5 days) is the nearest legal day.
    f.anchors.set(id, '2099-07-03');
    expect((await run([c], { facts: f })).newDates.get(id)).toBe('2099-07-08');
    f.anchors.set(id, null);
    expect((await run([c], { facts: f })).kept.get(c.customer_id)).toBe('anchor_unknown');
    f.anchors.set(id, '2099-06-20');
    expect((await run([c], { facts: f })).kept.get(c.customer_id)).toBe('anchor_budget');
  });

  test('blackout, absence and the freeze margin push a date to the next candidate; every candidate gone keeps the customer whole', async () => {
    const c = series(SAT, { count: 1 });
    const layers = { dates: new Set(['2099-07-09']), weeklyDaysOff: new Set(), closedHolidays: new Set() };
    expect((await run([c], { facts: clearFacts([c], { blackout: layers }) })).newDates.get(c.series[0].live[0].id)).toBe('2099-07-13');
    const absent = new Set(['2099-07-09', '2099-07-13']);
    expect((await run([c], { facts: clearFacts([c], { absentDates: absent }) })).newDates.get(c.series[0].live[0].id)).toBe('2099-07-08');
    const all = new Set(weekend.candidateDates(SAT, MON_THU, TODAY, START));
    expect((await run([c], { facts: clearFacts([c], { absentDates: all }) })).kept.get(c.customer_id)).toBe('absence');
    expect((await run([series('2099-07-02', { count: 1 })], {})).newDates.size).toBe(1); // 07-06 is 6 days out: fine
    const tooSoon = series('2099-07-04', { count: 1 }); // Sat; Mon 07-06 is the only legal day and 07-02 is under the margin
    expect([...(await run([tooSoon])).newDates.values()]).toEqual(['2099-07-06']);
  });

  test("a customer whose portal preference names a day off or a blocked date stays whole", async () => {
    const pref = series(SAT);
    const f = clearFacts([pref]);
    f.prefs.set(pref.customer_id, { preferred_day_indexes: [6], blackout: null });
    expect((await run([pref], { facts: f })).kept.get(pref.customer_id)).toBe('preferred_day');
    const away = series(SAT);
    const g = clearFacts([away]);
    g.prefs.set(away.customer_id, { preferred_day_indexes: [], blackout: { start: '2099-07-01', end: '2099-07-10' } });
    // Thu 07-09 is blocked, Mon 07-13 is not: the next candidate carries the move.
    expect((await run([away], { facts: g })).newDates.get(away.series[0].live[0].id)).toBe('2099-07-13');
    g.prefs.set(away.customer_id, { preferred_day_indexes: [], blackout: { start: '2099-07-01', end: '2099-07-31' } });
    expect((await run([away], { facts: g })).kept.get(away.customer_id)).toBe('customer_blackout');
  });

  test('a visit the app keeps still keeps the customer whole: confirmed, reminder sent, person-placed, grouped, exception, hand-off, other technician, first visit', async () => {
    for (const reason of ['held', 'reminder_sent', 'person_placed', 'grouped', 'date_exception', 'dispatch_handoff', 'not_open']) {
      const c = series(SAT, { count: 1 });
      const f = clearFacts([c]);
      f.stayStill.set(c.series[0].live[0].id, reason);
      expect((await run([c], { facts: f })).kept.get(c.customer_id)).toBe(reason);
    }
    const other = series(SAT, { count: 1, visitExtra: { technician_id: OTHER } });
    expect((await run([other])).kept.get(other.customer_id)).toBe('other_technician');
    const first = series(SAT, { count: 1 });
    first.series[0].live[0].recurring_parent_id = null;
    expect((await run([first])).kept.get(first.customer_id)).toBe('first_visit');
    // A confirmed visit already on a work day still moves its technician only: nothing to decide here.
    const workday = series(MON, { count: 1 });
    workday.series[0].needsDates = false;
    const f = clearFacts([workday]);
    f.stayStill.set(workday.series[0].live[0].id, 'held');
    const out = await run([workday], { facts: f });
    expect(out.kept.size).toBe(0);
    expect(out.newDates.size).toBe(0);
  });

  test('--to busy at the window keeps the customer whole when no candidate is free; two customers onto one hour do not share it', async () => {
    const busy = series(SAT, { count: 1 });
    expect((await run([busy], { free: async () => false })).kept.get(busy.customer_id)).toBe('busy');
    const a = series(SAT, { count: 1 });
    const b = series(SAT, { count: 1 });
    const out = await run([a, b]);
    const first = out.newDates.get(a.series[0].live[0].id);
    const second = out.newDates.get(b.series[0].live[0].id);
    expect(first).toBe('2099-07-09');
    expect(second).not.toBe(first); // the second customer takes the next free day, never the same hour
    // When every candidate day already holds the hour, the customer stays whole.
    const seed = new Map(weekend.candidateDates(SAT, MON_THU, TODAY, START).map((d) => [d, [{ s: 540, e: 600 }]]));
    expect((await run([series(SAT, { count: 1 })], { seed })).kept.size).toBe(1);
    // A technician-only move of the same run holds its hour too.
    const half = new Map([['2099-07-09', [{ s: 570, e: 630 }]]]);
    expect((await run([series(SAT, { count: 1 })], { seed: half })).newDates.values().next().value).toBe('2099-07-13');
  });

  test('a customer is kept WHOLE when one of its series cannot move; the hours its other series took are given back', async () => {
    const ok = series(SAT, { count: 1 });
    const bad = series(SAT, { count: 1 });
    const customer = ok.customer_id;
    bad.customer_id = customer;
    bad.series[0].parent.customer_id = customer;
    const next = series(SAT, { count: 1 });
    const f = clearFacts([ok, bad, next]);
    f.stayStill.set(bad.series[0].live[0].id, 'held');
    const joined = { customer_id: customer, series: [...ok.series, ...bad.series] };
    f.prefs.set(customer, { preferred_day_indexes: [], blackout: null });
    const out = await run([joined, next], { facts: f });
    expect(out.kept.get(customer)).toBe('held');
    expect(out.newDates.has(ok.series[0].live[0].id)).toBe(false);
    // The Thursday the first series briefly took is free again for the next customer.
    expect(out.newDates.get(next.series[0].live[0].id)).toBe('2099-07-09');
  });

  test('a weekend customer that stays whole gives back its weekday hours; the customers decided before it are decided again', async () => {
    // B's own Thursday 9-10 visit holds the hour on the hire while B may move. B stays whole: its Saturday is customer-placed.
    const a = series(SAT, { count: 1 });
    const b = series(SAT, { count: 1 });
    const own = () => new Map([['V-b-thu', { customer_id: b.customer_id, date: '2099-07-09', s: 540, e: 600 }]]);
    const placed = (candidates) => { const f = clearFacts(candidates); f.stayStill.set(b.series[0].live[0].id, 'person_placed'); return f; };
    for (const order of [[a, b], [b, a]]) {
      const out = await run(order, { own: own(), facts: placed(order) });
      expect(out.kept.get(b.customer_id)).toBe('person_placed');
      expect(out.newDates.get(a.series[0].live[0].id)).toBe('2099-07-09'); // the hour B gave back, in either order
    }
    // The control: while B moves, its Thursday hour stays reserved and A takes the Monday.
    const moving = await run([a, b], { own: own() });
    expect(moving.kept.size).toBe(0);
    expect(moving.newDates.get(a.series[0].live[0].id)).toBe('2099-07-13');
  });

  test('a weekday visit that gets a new date gives back its old hour, and the customers decided before it are decided again', async () => {
    // C: a custom 21-day series, Mon 07-13 (a weekday visit the run hands over, 9-10) and Sat 08-01. The hire is busy on
    // 08-03, so the series cannot stay on Mon 07-13 (its next visit would land on 08-03): it moves to Tue 07-14 / Tue 08-04.
    const parentC = { id: 'P-c21', customer_id: 'C-c21', service_type: 'Pest', recurring_pattern: 'custom', recurring_nth: null, recurring_weekday: null, recurring_interval_days: 21 };
    const liveC = ['2099-07-13', '2099-08-01'].map((d, i) => ({
      id: `V-c21-${i}`, series_id: 'P-c21', recurring_parent_id: 'P-c21', is_recurring: true, scheduled_date: d, status: 'confirmed',
      technician_id: OWNER, window_start: '09:00:00', window_end: '10:00:00',
    }));
    const c = { customer_id: 'C-c21', series: [{ parent: parentC, live: liveC, chain: liveC, rows: liveC, needsDates: true }] };
    const d = series('2099-07-12', { count: 1 }); // D's Sunday visit: Mon 07-13 is its nearest day
    const own = new Map([['V-c21-0', { customer_id: 'C-c21', date: '2099-07-13', s: 540, e: 600 }]]);
    const out = await run([d, c], { own, free: async (v, date) => date !== '2099-08-03' });
    expect(out.kept.size).toBe(0);
    expect(out.newDates.get(d.series[0].live[0].id)).toBe('2099-07-13'); // the hour C's Monday visit gave back
    expect(out.newDates.get('V-c21-0')).toBe('2099-07-14');
    expect(out.newDates.get('V-c21-1')).toBe('2099-08-04');
  });

  test('a customer decided again hands over a weekday visit only when no new date took its hour: never two visits on one hour', async () => {
    // Q's own Thursday and R's own Monday (9-10) hold their hours; the hire is free only on those two days. R stays whole.
    const p = series(SAT, { count: 1 });
    const q = series(SAT, { count: 1 });
    const r = series(SAT, { count: 1 });
    const own = new Map([
      ['V-q-thu', { customer_id: q.customer_id, date: '2099-07-09', s: 540, e: 600 }],
      ['V-r-mon', { customer_id: r.customer_id, date: '2099-07-13', s: 540, e: 600 }],
    ]);
    const f = clearFacts([p, q, r]);
    f.stayStill.set(r.series[0].live[0].id, 'person_placed');
    const out = await run([p, q, r], { own, facts: f, free: async (v, date) => ['2099-07-09', '2099-07-13'].includes(date) });
    // Q and R both stay whole in the first pass, so their hours are given back; P then takes Thursday 9-10, and Q's
    // Thursday 9-10 visit cannot go to the hire on top of it.
    expect(out.newDates.get(p.series[0].live[0].id)).toBe('2099-07-09');
    expect(out.kept.get(q.customer_id)).toBe('busy');
    expect(out.kept.get(r.customer_id)).toBe('person_placed');
    expect(out.newDates.size).toBe(1);
  });

  test('each series a weekend customer hands over must keep growing on a --to work day: a Saturday parent anchor keeps the customer whole (top_up_day_off)', async () => {
    // W: a Saturday quarterly series to re-date, and a monthly series whose only live visit already sits on Thursday 07-16
    // while its parent still walks a Saturday (a one-off move): top-up would grow the hire's next monthly visit on a Saturday.
    const withMonthly = (anchor, extra = {}) => {
      const w = series(SAT, { count: 1 });
      const sid = `P-m-${w.customer_id}`;
      const thu = { id: `V-m-${w.customer_id}`, series_id: sid, recurring_parent_id: sid, is_recurring: true, scheduled_date: '2099-07-16', status: 'confirmed', technician_id: OWNER, window_start: '13:00:00', window_end: '14:00:00' };
      const monthly = { id: sid, customer_id: w.customer_id, service_type: 'Mosquito', recurring_pattern: 'monthly', recurring_interval_days: null, ...anchor, ...extra };
      w.series.push({ parent: monthly, live: [thu], chain: [thu], rows: [thu], needsDates: false });
      return w;
    };
    const SAT_2ND = { recurring_nth: 2, recurring_weekday: 6, scheduled_date: '2099-04-09' }; // a stored 2nd Saturday (the Thursday date does not count)
    for (const anchor of [SAT_2ND, { recurring_nth: null, recurring_weekday: null, scheduled_date: '2099-04-11' }]) { // no stored weekday: the parent's own Saturday
      const w = withMonthly(anchor);
      const out = await run([w]);
      expect(out.kept.get(w.customer_id)).toBe('top_up_day_off');
      expect(out.newDates.size).toBe(0);
    }
    // The control: a parent that walks Thursdays moves with its customer, and the Saturday visit takes Thursday 07-09.
    const control = withMonthly({ recurring_nth: 3, recurring_weekday: 4, scheduled_date: '2099-04-16' });
    const moved = await run([control]);
    expect(moved.kept.size).toBe(0);
    expect(moved.newDates.get(control.series[0].live[0].id)).toBe('2099-07-09');
    // Top-up's weekend shift counts: a series that skips weekends grows a Saturday on the Monday after (a work day), or on the
    // Friday before when it shifts back (a day off). The customer's no-weekend preference shifts like the parent's flag.
    expect((await run([withMonthly(SAT_2ND, { skip_weekends: true })])).kept.size).toBe(0);
    const back = withMonthly(SAT_2ND, { skip_weekends: true, weekend_shift: 'back' });
    expect((await run([back])).kept.get(back.customer_id)).toBe('top_up_day_off');
    const pref = withMonthly(SAT_2ND);
    const f = clearFacts([pref]);
    f.noWeekends.set(pref.customer_id, true);
    expect((await run([pref], { facts: f })).kept.size).toBe(0);
  });

  test('a day gap grows from its latest live row\'s cadence slot: an exception\'s or a hand-off\'s Saturday slot, or a past Saturday base, keeps the customer whole', async () => {
    // W: a Saturday quarterly series to re-date, and a weekly series with no visit on a day off.
    const withWeekly = (rows, base) => {
      const w = series(SAT, { count: 1 });
      const sid = `P-k-${w.customer_id}`;
      const weekly = { id: sid, customer_id: w.customer_id, service_type: 'Pest', recurring_pattern: 'weekly', recurring_nth: null, recurring_weekday: null, recurring_interval_days: null, scheduled_date: '2099-04-09' };
      const live = rows.map((r, i) => ({ id: `${sid}-${i}`, series_id: sid, recurring_parent_id: sid, is_recurring: true, status: 'confirmed', technician_id: OWNER, window_start: '13:00:00', window_end: '14:00:00', ...r }));
      w.series.push({ parent: weekly, live, chain: live, rows: live, needsDates: false });
      const f = clearFacts([w]);
      if (base) f.bases.set(sid, base);
      return { w, f };
    };
    const decide = async ({ w, f }) => (await run([w], { facts: f })).kept.get(w.customer_id);
    // The latest row is a one-off move from Saturday 07-18 to Thursday 07-16: top-up hops a week from its Saturday slot.
    expect(await decide(withWeekly([{ scheduled_date: '2099-07-09' }, { scheduled_date: '2099-07-16', date_exception: true, date_exception_cadence_date: '2099-07-18' }]))).toBe('top_up_day_off');
    // A hand-off placed on Thursday 07-16 whose due date is Saturday 07-18: the due date is its slot.
    expect(await decide(withWeekly([{ scheduled_date: '2099-07-09' }, { scheduled_date: '2099-07-16', recurring_dispatch_due_date: '2099-07-18' }]))).toBe('top_up_day_off');
    // No live row ahead: top-up grows from the base row the database holds, here a past Saturday.
    expect(await decide(withWeekly([], { id: 'B-past', scheduled_date: '2099-06-27' }))).toBe('top_up_day_off');
    // The controls: the same rows on Thursday slots, a past Thursday base, and a series with no live row at all (no growth).
    expect(await decide(withWeekly([{ scheduled_date: '2099-07-09' }, { scheduled_date: '2099-07-16' }]))).toBeUndefined();
    expect(await decide(withWeekly([{ scheduled_date: '2099-07-09' }, { scheduled_date: '2099-07-16', recurring_dispatch_due_date: '2099-07-16' }]))).toBeUndefined();
    expect(await decide(withWeekly([], { id: 'B-past', scheduled_date: '2099-06-25' }))).toBeUndefined();
    expect(await decide(withWeekly([]))).toBeUndefined();
  });

  test('the run\'s own new dates count in the next top-up base: a Thursday hand-off due on Saturday moves the series to Monday, its due date cleared', async () => {
    // A weekly series: Saturday 07-11 and a hand-off placed on Thursday 07-16 whose due date is Saturday 07-18. Thursday 07-09
    // would leave that due date as top-up's base; Monday 07-13 re-dates the hand-off too, and a re-date clears a timed
    // row's due date (recurringDispatchDuePatch, as the writer does), so top-up grows Mondays.
    const handoff = series(SAT, { pattern: 'weekly', count: 2 });
    Object.assign(handoff.series[0].live[1], { scheduled_date: '2099-07-16', recurring_dispatch_due_date: '2099-07-18', window_start: '13:00:00', window_end: '14:00:00' });
    const out = await run([handoff]);
    expect(out.kept.size).toBe(0);
    expect(handoff.series[0].live.map((v) => out.newDates.get(v.id))).toEqual(['2099-07-13', '2099-07-20']);
    // The control: the same Thursday visit with no due date keeps its date, and the Saturday takes Thursday 07-09.
    const plain = series(SAT, { pattern: 'weekly', count: 2 });
    Object.assign(plain.series[0].live[1], { scheduled_date: '2099-07-16', window_start: '13:00:00', window_end: '14:00:00' });
    const control = await run([plain]);
    expect(plain.series[0].live.map((v) => control.newDates.get(v.id))).toEqual(['2099-07-09', undefined]);
  });

  test('loadTopUpBases reads top-up\'s base row with admin-schedule latestLiveSeriesVisit\'s filter and order', () => {
    const schedule = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const helper = schedule.slice(schedule.indexOf('function latestLiveSeriesVisit('), schedule.indexOf('async function loadActiveSeriesDates('));
    const mine = fs.readFileSync(path.join(__dirname, '..', '..', 'ops', 'agents', 'second-tech-handover-weekend.js'), 'utf8');
    const reader = mine.slice(mine.indexOf('async function loadTopUpBases('), mine.indexOf('async function loadBlackout('));
    expect(helper.length).toBeGreaterThan(0);
    expect(reader.length).toBeGreaterThan(0);
    for (const part of [".where('is_recurring', true)", ".whereNotIn('status', ['cancelled', 'rescheduled'])",
      "COALESCE(date_exception_cadence_date, recurring_dispatch_due_date, scheduled_date)'), 'desc')"]) {
      expect(helper).toContain(part);
      expect(reader).toContain(part);
    }
  });

  test('isMonthBased matches rebooker.isMonthBasedRecurrence for every pattern the scheduler places', () => {
    jest.isolateModules(() => {
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
      const { isMonthBasedRecurrence } = require('../services/rebooker');
      for (const p of ['monthly', 'bimonthly', 'quarterly', 'triannual', 'semiannual', 'biannual', 'annual', 'yearly', 'monthly_nth_weekday', 'seasonal_feb_oct',
        'weekly', 'biweekly', 'every_6_weeks', 'custom', 'daily', 'lawn_rounds_9', null]) {
        expect(weekend.isMonthBased(p)).toBe(isMonthBasedRecurrence(p));
      }
    });
  });

  test('--weekend-move arguments: needs --to; START_TOO_SOON under 4 days; the plan id covers new dates and anchors', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${code}`); });
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseArgs(['--from', OWNER, '--to', HIRE, '--weekend-move']).weekendMove).toBe(true);
    expect(parseArgs(['--from', OWNER, '--to', HIRE]).weekendMove).toBe(false);
    expect(() => parseArgs(['--from', OWNER, '--weekend-move'])).toThrow('exit 2');
    exit.mockRestore(); err.mockRestore();
    const { assertRunFlags, planIdOf } = require(script);
    expect(() => assertRunFlags({ lines: ['general'], zips: null, weekendMove: true, start: '2099-07-03', today: '2099-06-30' })).toThrow(expect.objectContaining({ code: 'START_TOO_SOON' }));
    expect(() => assertRunFlags({ lines: ['general'], zips: null, weekendMove: true, start: '2099-07-04', today: '2099-06-30' })).not.toThrow();
    expect(() => assertRunFlags({ lines: ['general'], zips: null, weekendMove: false, start: '2099-07-01', today: '2099-06-30' })).not.toThrow();
    const base = { from: OWNER, to: HIRE, start: START, lines: ['general'], retemplate: ['S-a'], weekendMove: true };
    const move = { series_id: 'S-a', visit_id: 'V-a', date: SAT, to_date: '2099-07-09' };
    const id = planIdOf({ ...base, moves: [move] });
    expect(planIdOf({ ...base, moves: [{ ...move, to_date: '2099-07-13' }] })).not.toBe(id);
    expect(planIdOf({ ...base, moves: [{ ...move, to_date: null }] })).not.toBe(id);
    const anchor = { series_id: 'S-a', nth: 2, weekday: 4, old_nth: null, old_weekday: null };
    expect(planIdOf({ ...base, moves: [move], anchors: [anchor] })).not.toBe(id);
    expect(planIdOf({ ...base, moves: [move], anchors: [{ ...anchor, weekday: 1 }] })).not.toBe(planIdOf({ ...base, moves: [move], anchors: [anchor] }));
    // Without the flag the id is exactly what it was.
    expect(planIdOf({ ...base, weekendMove: false, moves: [{ series_id: 'S-a', visit_id: 'V-a', date: SAT }] }))
      .toBe(planIdOf({ from: OWNER, to: HIRE, start: START, lines: ['general'], retemplate: ['S-a'], moves: [{ series_id: 'S-a', visit_id: 'V-a', date: SAT }] }));
  });

  test('buildPlan in --weekend-move mode plans weekend customers (no off_day_customer skip) and lists the day changes by weekday', () => {
    const wk = parent({ customer_id: 'C-wk' });
    const sat = visit(wk, SAT, { is_recurring: true });
    const mon = visit(wk, MON, { is_recurring: true });
    const draft = plan([wk], [sat, mon], { weekendMove: true });
    expect(draft.skipped.off_day_customer).toBeUndefined();
    expect(draft.weekend_candidates).toEqual([{ customer_id: 'C-wk', series_ids: [wk.id] }]);
    expect(draft.ids.moves.find((m) => m.visit_id === sat.id)).toMatchObject({ date: SAT, to_date: null });
    expect(draft.ids.moves.find((m) => m.visit_id === mon.id).to_date).toBeUndefined();
    const kept = plan([wk], [sat, mon], { weekendMove: true, weekend: { kept: new Map([['C-wk', 'busy']]), newDates: new Map(), anchors: [] } });
    expect(kept.series.retemplate).toBe(0);
    expect(kept.skipped.weekend_kept_busy).toEqual({ series: 1, visits: 2, customers: 1 });
    expect(kept.ids.kept).toEqual([{ customer_id: 'C-wk', reason: 'busy' }]);
    const moved = plan([wk], [sat, mon], { weekendMove: true, weekend: { kept: new Map(), newDates: new Map([[sat.id, '2099-07-09']]), anchors: [{ series_id: wk.id, nth: 2, weekday: 4, old_nth: null, old_weekday: null }] } });
    expect(moved.date_changes).toEqual({ visits: 1, customers: 1, by_change: { 'Sat -> Thu': 1 } });
    expect(moved.ids.moves.find((m) => m.visit_id === sat.id)).toMatchObject({ to_date: '2099-07-09' });
    expect(moved.would_change.visits).toBe(2);
    expect(moved.ids.anchors).toHaveLength(1);
    expect(moved.planId).not.toBe(draft.planId);
    // Not in this mode, the owner's first-run rule is unchanged.
    expect(plan([wk], [sat, mon]).skipped.off_day_customer).toMatchObject({ series: 1, customers: 1 });
  });
});

// ops/agents/second-tech-handover.js — the pure planner. READ-ONLY build 6 of the
// second-tech plan: it must name what a later --execute would move, and nothing else.
// Synthetic ids only. 2099-07-06 is a Monday.
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const script = path.join(__dirname, '..', '..', 'ops', 'agents', 'second-tech-handover.js');
const {
  buildPlan, parseArgs, defaultStart, isOpenVisit, isGroupedVisit, seriesTechnicianId, isBaitSeries,
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
    const fridayOnly = parent();
    const noChildren = parent();
    const moving = parent();
    const p = plan([fridayOnly, noChildren, moving], [visit(fridayOnly, FRI), visit(moving, MON)]);
    expect(p.series.retemplate).toBe(3);
    expect(new Set(p.ids.retemplate)).toEqual(new Set([fridayOnly.id, noChildren.id, moving.id]));
    expect(p.ids.series).toEqual([moving.id]);
  });

  test('a pest series on the owner moves its Mon-Thu visits; the Friday visit stays (stays_off_day)', () => {
    const s = parent();
    const vs = [MON, TUE, WED, THU, FRI].map((d) => visit(s, d));
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

  test('lapsed series (not ongoing, nothing open ahead) is not active', () => {
    const s = parent({ recurring_ongoing: false });
    const p = plan([s], [visit(s, '2099-05-01', { status: 'completed' })]);
    expect(p.series.active).toBe(0);
  });

  test('--to with explicit work_days changes the off days', () => {
    const s = parent();
    const vs = [MON, TUE, WED, THU, FRI].map((d) => visit(s, d));
    const p = plan([s], vs, { to: { id: HIRE, work_days: [2, 3, 4, 5] } });
    expect(p.target).toBe(HIRE);
    expect(p.target_work_days_source).toBe('technician_row');
    expect(p.would_change.by_weekday).toEqual({ Tue: 1, Wed: 1, Thu: 1, Fri: 1 });
    expect(p.stays_off_day).toEqual({ visits: 1, by_weekday: { Mon: 1 } });
    const every = plan([s], vs, { to: { id: HIRE, work_days: null } });
    expect(every.would_change.visits).toBe(5);
    expect(every.stays_off_day.visits).toBe(0);
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

  test('the file has no write path', () => {
    const src = fs.readFileSync(script, 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    expect(src.split('\n')[1]).toBe('// READ-ONLY');
    expect(code).not.toMatch(/\.(insert|update|del|delete|truncate|upsert)\s*\(/);
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE)\b/i);
    expect(code).toMatch(/SET TRANSACTION READ ONLY/);
    expect(code).not.toMatch(/--execute/);
  });
});

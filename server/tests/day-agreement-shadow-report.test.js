/**
 * Day-only agreement shadow report (scripts/day-agreement-shadow-report.js):
 * the pure scoring half. Does the outcome of a would_book / would_move match
 * what staff did later, and does the printed report stay free of customer
 * detail. The read-only database half is covered by the Postgres test.
 */
const report = require('../../scripts/day-agreement-shadow-report');

const AGREED = new Date('2040-03-12T15:00:00Z');
const after = new Date('2040-03-12T18:00:00Z');
const before = new Date('2040-03-01T12:00:00Z');
const decision = (over = {}) => ({
  id: '3f2a9c10-aaaa-bbbb-cccc-000000000001', source_kind: 'call', customer_id: 'cust-1', agreed_at: AGREED,
  verdict: 'would_book', skip_reason: null, target_date: '2040-03-14', from_visit_id: null, from_day: null,
  chosen_window_start: '09:00', judged: { act: true }, ...over,
});
const visit = (over = {}) => ({
  id: 'v-1', customer_id: 'cust-1', status: 'confirmed', d: '2040-03-14', window_start: '09:00:00', created_at: after, updated_at: after, ...over,
});

describe('classifyOutcome', () => {
  test('staff booked the agreed day after the agreement; same_hour when the hour is the one the picker chose', () => {
    expect(report.classifyOutcome(decision(), [visit()])).toEqual({ outcome: 'staff_acted_on_day', sameHour: true });
    expect(report.classifyOutcome(decision(), [visit({ window_start: '13:00' })])).toEqual({ outcome: 'staff_acted_on_day', sameHour: false });
  });

  test('a visit that was already there before the agreement and never touched is not staff acting', () => {
    expect(report.classifyOutcome(decision(), [visit({ created_at: before, updated_at: before })]).outcome).toBe('nothing');
  });

  test('a visit moved onto the agreed day after the agreement counts as staff acting', () => {
    expect(report.classifyOutcome(decision({ verdict: 'would_move', from_visit_id: 'v-1' }), [visit({ created_at: before })]).outcome).toBe('staff_acted_on_day');
  });

  test('a visit only UPDATED after the agreement (completed as planned) is not a staff booking (pre-push audit)', () => {
    expect(report.classifyOutcome(decision(), [visit({ created_at: before, status: 'completed' })]).outcome).toBe('nothing');
  });

  test('a series top-up or a visit created after the 14-day window is not this agreement\'s outcome (pre-push audit)', () => {
    expect(report.classifyOutcome(decision(), [visit({ recurring_parent_id: 'series-1' })]).outcome).toBe('nothing');
    const late = new Date(new Date(decision().agreed_at).getTime() + 30 * 24 * 3600 * 1000).toISOString();
    expect(report.classifyOutcome(decision(), [visit({ d: '2040-05-01', created_at: late })]).outcome).toBe('nothing');
  });

  test('one agreement judged again from a later thread snapshot counts once', () => {
    const d1 = decision({ id: 'a1', verdict: 'would_book', customer_id: 'c-1' });
    const d2 = decision({ id: 'a2', verdict: 'would_book', customer_id: 'c-1' });
    const r = report.summarize([d1, d2], () => []);
    expect(r.wouldTotal).toBe(1);
    expect(r.duplicates).toBe(1);
  });

  test('staff booked a different day: a new visit on another day, or the moved visit now sits elsewhere', () => {
    expect(report.classifyOutcome(decision(), [visit({ d: '2040-03-15' })]).outcome).toBe('staff_other_day');
    const move = decision({ verdict: 'would_move', from_visit_id: 'v-1', from_day: '2040-03-16' });
    expect(report.classifyOutcome(move, [visit({ d: '2040-03-18', created_at: before })]).outcome).toBe('staff_other_day');
    expect(report.classifyOutcome(move, [visit({ d: '2040-03-16', created_at: before, updated_at: before })]).outcome).toBe('nothing');
  });

  test('a cancelled visit never counts, and no visits at all is nothing', () => {
    expect(report.classifyOutcome(decision(), [visit({ status: 'cancelled' })]).outcome).toBe('nothing');
    expect(report.classifyOutcome(decision(), []).outcome).toBe('nothing');
  });
});

describe('summarize and format', () => {
  const rows = [
    decision(),
    decision({ id: '3f2a9c10-0000-0000-0000-000000000002', verdict: 'would_move', source_kind: 'sms', chosen_window_start: '14:00', customer_id: 'cust-5' }),
    decision({ id: '3f2a9c10-0000-0000-0000-000000000003', verdict: 'skip', skip_reason: 'no_slot' }),
    decision({ id: '3f2a9c10-0000-0000-0000-000000000004', verdict: 'skip', skip_reason: 'low_confidence', customer_id: 'cust-2' }),
    decision({ id: '3f2a9c10-0000-0000-0000-000000000005', verdict: 'skip', skip_reason: 'staff_already_acted', customer_id: 'cust-3' }),
    decision({ id: '3f2a9c10-0000-0000-0000-000000000006', verdict: 'skip', skip_reason: 'model_no_act', judged: { act: false }, customer_id: 'cust-4' }),
  ];
  const visitsOf = (d) => ({
    'cust-1': [visit()],
    'cust-2': [visit({ customer_id: 'cust-2' })],
    'cust-3': [visit({ customer_id: 'cust-3' })],
    'cust-4': [visit({ customer_id: 'cust-4' })],
  }[d.customer_id] || []);
  const out = report.summarize(rows, visitsOf);

  test('counts verdicts and skip reasons', () => {
    expect(out.total).toBe(6);
    expect(out.byVerdict).toEqual({ would_book: 1, would_move: 1, skip: 4 });
    expect(out.skipReasons).toEqual({ no_slot: 1, low_confidence: 1, staff_already_acted: 1, model_no_act: 1 });
  });

  test('scores only would_* rows, and counts how often the chosen hour matched staff', () => {
    expect(out.wouldTotal).toBe(2);
    expect(out.wouldOutcomes).toEqual({ staff_acted_on_day: 1, nothing: 1 });
    expect(out.sameHour).toBe(1);
  });

  test('a skip where the model said act and staff booked that day anyway is a missed opportunity; staff_already_acted and act:false are not', () => {
    // cust-1's no_slot skip (the model said act) and cust-2's low_confidence skip both match a real staff visit.
    expect(out.missedOpportunities).toEqual({ no_slot: 1, low_confidence: 1 });
  });

  test('the printed report has id8 rows and no customer detail', () => {
    const text = report.format(out, { from: '2040-03-12', to: '2040-03-19' });
    expect(text).toContain('decisions: 6');
    expect(text).toContain('3f2a9c10 call would_book 2040-03-14 09:00 staff_acted_on_day same_hour');
    expect(text).toContain('3f2a9c10 sms would_move 2040-03-14 14:00 nothing');
    expect(text).not.toMatch(/cust-|3f2a9c10-aaaa|@|\+1\d{10}/);
  });
});

describe('a re-judged agreement counts once', () => {
  const act = (id, over = {}) => decision({
    id, verdict: 'skip', skip_reason: 'no_slot', judged: { act: true, kind: 'new_visit' }, customer_id: 'cust-1', target_date: '2040-03-14', ...over,
  });
  const visitsOf = () => [visit()];

  test('action-shaped skips with the same customer, day and kind are one skip and one missed opportunity', () => {
    const out = report.summarize([act('a'), act('b', { skip_reason: 'low_confidence' }), act('c')], visitsOf);
    expect(out.byVerdict).toEqual({ skip: 1 });
    expect(out.skipReasons).toEqual({ no_slot: 1 });
    expect(out.missedOpportunities).toEqual({ no_slot: 1 });
    expect(out.duplicates).toBe(2);
  });

  test('a different day, kind or customer is a different agreement; a skip the model did not call act is never merged', () => {
    const out = report.summarize([
      act('a'), act('b', { target_date: '2040-03-15' }), act('c', { judged: { act: true, kind: 'move' } }), act('d', { customer_id: 'cust-2' }),
      act('e', { judged: { act: false } }), act('f', { judged: { act: false } }),
    ], visitsOf);
    expect(out.byVerdict).toEqual({ skip: 6 });
    expect(out.duplicates).toBeUndefined();
  });
});

describe('parseArgs', () => {
  test('needs an ET date range, from not after to', () => {
    expect(report.parseArgs(['--from', '2040-03-12', '--to', '2040-03-19'])).toEqual({ from: '2040-03-12', to: '2040-03-19' });
    expect(() => report.parseArgs([])).toThrow(/usage/);
    expect(() => report.parseArgs(['--from', '2040-03-20', '--to', '2040-03-19'])).toThrow(/after/);
    expect(() => report.parseArgs(['--from', 'x', '--to', 'y'])).toThrow(/usage/);
    expect(() => report.parseArgs(['--all'])).toThrow(/unknown argument/);
  });
});

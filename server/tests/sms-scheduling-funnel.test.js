/**
 * SMS scheduling funnel summary: counts only, computed from rows.
 */
jest.mock('../models/db', () => jest.fn());

const { summarizeFunnel, weekOf, isSchedulingText } = require('../services/sms-scheduling-funnel');

const at = (iso) => new Date(iso);
const A = 'cust-a';
const B = 'cust-b';
const C = 'cust-c';

test('weeks start on Monday, Eastern', () => {
  expect(weekOf(at('2026-09-30T15:00:00Z'))).toBe('2026-09-28'); // Wednesday
  expect(weekOf(at('2026-09-28T03:00:00Z'))).toBe('2026-09-21'); // still Sunday night in Florida
  expect(weekOf(at('2026-09-28T12:00:00Z'))).toBe('2026-09-28'); // Monday
});

test('only scheduling texts are counted, and each is tied to what followed it', () => {
  expect(isSchedulingText('Can we reschedule my appointment to Friday?')).toBe(true);
  expect(isSchedulingText('Thanks so much!')).toBe(false);

  const summary = summarizeFunnel({
    now: at('2026-10-10T00:00:00Z'),
    inbound: [
      { customer_id: A, body: 'Can we reschedule my appointment to Friday?', created_at: at('2026-09-29T14:00:00Z') },
      { customer_id: B, body: 'I need to reschedule my visit please', created_at: at('2026-09-30T14:00:00Z') },
      { customer_id: C, body: 'Can you reschedule me for next week?', created_at: at('2026-09-30T16:00:00Z') },
      { customer_id: A, body: 'Thanks so much!', created_at: at('2026-09-29T18:00:00Z') },
    ],
    // A's visit moved 3 hours later; B's moved 3 days later (outside 48h).
    moves: [{ customer_id: A, created_at: at('2026-09-29T17:00:00Z') }, { customer_id: B, created_at: at('2026-10-03T14:00:00Z') }],
    cancels: [{ customer_id: C, transitioned_at: at('2026-09-30T17:00:00Z') }],
    bookings: [],
  });

  expect(summary.inbound_total).toBe(4);
  expect(summary.scheduling_flagged).toBe(3);
  expect(summary.per_week).toEqual({ '2026-09-28': 3 });
  expect(summary.followed_within_48h).toEqual({ any: 2, moves: 1, cancels_or_skips: 1, new_bookings: 0 });
  expect(summary).not.toHaveProperty('person_replied');
  expect(summary.offers).toBeNull();
});

test('offers are counted by kind and state, and an unresolved slot is called out', () => {
  const now = at('2026-10-02T12:00:00Z');
  const slot = { date: '2026-10-06', start: '10:00', end: '12:00' };
  const summary = summarizeFunnel({
    now,
    // Follow-ups read three days later: every offer's 48h window has closed.
    observedAt: at('2026-10-05T00:00:00Z'),
    moves: [{ customer_id: A, created_at: at('2026-10-01T15:00:00Z') }],
    offers: [
      { customer_id: A, kind: 'move_visit', status: 'open', sent_at: at('2026-10-01T14:00:00Z'), expires_at: at('2026-10-03T14:00:00Z'), slots: [slot] },
      { customer_id: B, kind: 'move_visit', status: 'open', sent_at: at('2026-09-29T14:00:00Z'), expires_at: at('2026-10-01T14:00:00Z'), slots: JSON.stringify([slot]) },
      { customer_id: C, kind: 'book_new', status: 'superseded', sent_at: at('2026-10-01T10:00:00Z'), expires_at: at('2026-10-03T10:00:00Z'), slots: [{ date: null, start: null, end: null }] },
    ],
  });
  expect(summary.offers).toEqual({
    sent: 3, by_kind: { move_visit: 2, book_new: 1 }, open: 1, expired: 1, superseded: 1, other: 0,
    with_unresolved_slot: 1, matured: 3, followed_by_change_48h: 1,
  });
});

test('an empty window reports zeros, not errors', () => {
  expect(summarizeFunnel({})).toMatchObject({ inbound_total: 0, scheduling_flagged: 0, offers: null });
});

describe('report boundaries', () => {
  const { parseReportInstant } = require('../services/sms-scheduling-funnel');
  test('a bare date is Eastern midnight, in daylight and standard time', () => {
    expect(parseReportInstant('2026-10-01').toISOString()).toBe('2026-10-01T04:00:00.000Z');
    expect(parseReportInstant('2026-12-01').toISOString()).toBe('2026-12-01T05:00:00.000Z');
  });
  test('Nd counts back from now; absent uses the fallback; nonsense throws', () => {
    const now = new Date('2026-10-02T12:00:00Z');
    expect(parseReportInstant('7d', null, now).toISOString()).toBe('2026-09-25T12:00:00.000Z');
    expect(parseReportInstant(undefined, now)).toBe(now);
    expect(() => parseReportInstant('soon')).toThrow(/cannot read the date/);
  });
});

test('a tapback quoting our appointment text is not a scheduling request', () => {
  expect(isSchedulingText('Liked \u201cYour appointment is tomorrow between 10 AM and 12 PM. Reply to reschedule.\u201d')).toBe(false);
  expect(isSchedulingText('Can we reschedule my appointment to Friday?')).toBe(true);
});

test('a supersede after the report end does not rewrite the past report', () => {
  const offer = (closedAt) => ({ customer_id: A, kind: 'move_visit', status: 'superseded', sent_at: '2026-09-29T14:00:00Z', expires_at: '2026-10-01T14:00:00Z', closed_at: closedAt, slots: [] });
  const asOf = (closedAt, now) => summarizeFunnel({ offers: [offer(closedAt)], now: at(now) }).offers;
  expect(asOf('2026-09-30T10:00:00Z', '2026-09-30T12:00:00Z')).toMatchObject({ superseded: 1, open: 0 });
  expect(asOf('2026-10-05T10:00:00Z', '2026-09-30T12:00:00Z')).toMatchObject({ superseded: 0, open: 1 });
  expect(asOf('2026-10-05T10:00:00Z', '2026-10-02T12:00:00Z')).toMatchObject({ superseded: 0, expired: 1 });
});

test('a text whose 48h window has not closed is left out of the change rate', () => {
  const summary = summarizeFunnel({
    now: at('2026-10-02T12:00:00Z'),
    inbound: [
      { customer_id: A, body: 'Can we reschedule my appointment to Friday?', created_at: at('2026-09-29T14:00:00Z') },
      { customer_id: B, body: 'I need to reschedule my visit please', created_at: at('2026-10-02T09:00:00Z') },
    ],
    moves: [{ customer_id: A, created_at: at('2026-09-29T17:00:00Z') }],
  });
  expect(summary).toMatchObject({ scheduling_flagged: 2, scheduling_matured: 1 });
  expect(summary.followed_within_48h.any).toBe(1);
});

test('an impossible bare date is refused, not rolled over', () => {
  const { parseReportInstant } = require('../services/sms-scheduling-funnel');
  expect(() => parseReportInstant('2026-02-30')).toThrow(/cannot read the date/);
  expect(parseReportInstant('2026-02-28').toISOString()).toBe('2026-02-28T05:00:00.000Z');
});

test('report dates print as the Eastern day, also after 8 PM Eastern', () => {
  const { formatReportDate } = require('../services/sms-scheduling-funnel');
  expect(formatReportDate(new Date('2026-10-02T01:30:00Z'))).toBe('2026-10-01');
});

test('a would-move is scored only after its 48h, and only against a logged move into that time inside it', () => {
  const { summarizeDecisions } = require('../services/sms-scheduling-funnel');
  const would = (id) => JSON.stringify({ kind: 'move_visit', scheduled_service_id: id, date: '2026-10-06', start: '10:00', arrival_end: '12:00' });
  const decided = '2026-10-01T15:00:00Z';
  const decisions = [
    { action: 'accept_slot', outcome: 'would_move', refusals: '[]', would_have: would('v1'), created_at: decided },
    { action: 'accept_slot', outcome: 'would_move', refusals: '[]', would_have: would('v2'), created_at: decided },
    { action: 'accept_slot', outcome: 'would_move', refusals: '[]', would_have: would('v3'), created_at: decided },
    { action: 'accept_slot', outcome: 'would_move', refusals: '[]', would_have: would('v4'), created_at: '2026-10-04T15:00:00Z' },
    { action: 'accept_slot', outcome: 'staff', refusals: '["quote_not_in_text"]', would_have: null, created_at: decided },
    { action: 'decline', outcome: 'no_action', refusals: [], would_have: null, created_at: decided },
  ];
  const moves = new Map([
    ['v1', [{ created_at: '2026-10-01T18:00:00Z', new_date: '2026-10-06', new_window: '10:00-11:00' }]],
    // moved, but to another time
    ['v2', [{ created_at: '2026-10-01T18:00:00Z', new_date: '2026-10-07', new_window: '10:00-11:00' }]],
    // moved there, but days later: outside the window
    ['v3', [{ created_at: '2026-10-05T18:00:00Z', new_date: '2026-10-06', new_window: '10:00-11:00' }]],
  ]);
  const out = summarizeDecisions(decisions, moves, new Date('2026-10-05T00:00:00Z'));
  expect(out).toEqual({
    total: 6,
    by_outcome: { would_move: 4, staff: 1, no_action: 1 },
    by_action: { accept_slot: 5, decline: 1 },
    refusals: { quote_not_in_text: 1 },
    // v4 was decided 9h before the report end: not scored yet
    would_move_matured: 3,
    would_move_matched: 1,
    would_move_unmatched: 2,
  });
});

test('recall counts real accepts (offers whose visit then moved into an offered time) and how many got that would-move', () => {
  const { summarizeRecall } = require('../services/sms-scheduling-funnel');
  const slots = [{ date: '2026-10-06', start: '10:00' }, { date: '2026-10-07', start: '14:00' }];
  const offer = (id, visit) => ({ id, kind: 'move_visit', scheduled_service_id: visit, sent_at: '2026-10-01T13:00:00Z', slots });
  const offers = [offer('o1', 'v1'), offer('o2', 'v2'), offer('o3', 'v3'), { ...offer('o4', 'v4'), kind: 'book_new' }];
  const moves = new Map([
    ['v1', [{ created_at: '2026-10-01T20:00:00Z', new_date: '2026-10-07', new_window: '14:00-15:30' }]],
    ['v2', [{ created_at: '2026-10-01T20:00:00Z', new_date: '2026-10-06', new_window: '10:00-11:00' }]],
    // moved, but not into an offered time: not a real accept of this offer
    ['v3', [{ created_at: '2026-10-01T20:00:00Z', new_date: '2026-10-09', new_window: '10:00-11:00' }]],
  ]);
  const would = (date, start) => JSON.stringify({ kind: 'move_visit', date, start });
  const decisions = [
    { sms_offer_id: 'o1', outcome: 'would_move', would_have: would('2026-10-07', '14:00') },
    // o2's real accept went to staff: missed
    { sms_offer_id: 'o2', outcome: 'staff', would_have: would('2026-10-06', '10:00') },
  ];
  expect(summarizeRecall(offers, decisions, moves, new Date('2026-10-05T00:00:00Z'))).toEqual({ real_accepts: 2, caught: 1 });
});

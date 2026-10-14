// Backfill of payload.date / previous_date on open schedule-change cards
// written before the ISO days existed (Codex #5786 P2): the year is the one
// nearest the card's creation.
const { _test: { dayFrom } } = require('../models/migrations/20261003150000_tech_notifications_schedule_change_days_backfill');

describe('dayFrom', () => {
  test.each([
    ['Thu Dec 10, 2–3 PM', '2026-10-03T07:00:00Z', '2026-12-10'],
    ['Mon Oct 5', '2026-10-03T07:00:00Z', '2026-10-05'],
    // Created in late December about an early-January visit: next year.
    ['Tue Jan 5, 9–10 AM', '2026-12-28T15:00:00Z', '2027-01-05'],
    // A move OFF yesterday, written today: same year.
    ['Fri Oct 2, 9–10 AM', '2026-10-03T07:00:00Z', '2026-10-02'],
  ])('%s (created %s) → %s', (text, createdAt, expected) => {
    expect(dayFrom(text, createdAt)).toBe(expected);
  });

  test.each([
    [null], [''], ['Today'], ['Thu Foo 10'], ['Thu Feb 30, 9 AM'],
  ])('unreadable %p → null (left to the visit-day fallback)', (text) => {
    expect(dayFrom(text, '2026-10-03T07:00:00Z')).toBeNull();
  });
});

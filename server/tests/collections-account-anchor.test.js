/**
 * account-anchor — ONE dunning clock per customer, anchored to the
 * OLDEST-due open invoice (owner ruling 2026-08-28).
 */
const { anchorInvoiceOf, orderByDue, accountDaysOverdue, daysOverdueOn, dunningTierForOverdue, registerForTier, dueValueOf } = require('../services/collections/account-anchor');

const NOW = new Date('2026-08-28T15:00:00Z'); // 11:00 ET Fri Aug 28

test('anchor = oldest due_date (ties broken by created_at); created_at is the fallback due', () => {
  const a = { id: 'a', due_date: '2026-08-24', created_at: '2026-08-10T00:00:00Z' };
  const b = { id: 'b', due_date: '2026-07-29', created_at: '2026-07-15T00:00:00Z' };
  const c = { id: 'c', due_date: null, created_at: '2026-07-20T00:00:00Z' };
  expect(anchorInvoiceOf([a, b, c]).id).toBe('c'); // created_at 07-20 < due 07-29
  expect(anchorInvoiceOf([a, b]).id).toBe('b');
  expect(anchorInvoiceOf([])).toBeNull();
  expect(dueValueOf(c)).toBe('2026-07-20T00:00:00Z');
});

test('equal due dates tie-break on created_at as INSTANTS (Postgres returns Date objects)', () => {
  // String(Date) is not chronological ("Wed Jul 01" > "Fri Jul 10"); compare epochs.
  const first = { id: 'first', due_date: '2026-07-29', created_at: new Date('2026-07-01T12:00:00Z') };
  const later = { id: 'later', due_date: '2026-07-29', created_at: new Date('2026-07-10T12:00:00Z') };
  expect(anchorInvoiceOf([later, first]).id).toBe('first');
  expect(anchorInvoiceOf([first, later]).id).toBe('first');
  const missing = { id: 'missing', due_date: '2026-07-29', created_at: null };
  expect(anchorInvoiceOf([missing, later]).id).toBe('later'); // unparseable sorts last
  // orderByDue is the same comparator end-to-end and never mutates its input.
  const noDue = { id: 'nodue', due_date: null, created_at: null };
  const input = [noDue, later, missing, first];
  expect(orderByDue(input).map((i) => i.id)).toEqual(['first', 'later', 'missing', 'nodue']);
  expect(input.map((i) => i.id)).toEqual(['nodue', 'later', 'missing', 'first']);
});

test('account age = the anchor\'s age; a 4-day invoice does not soften a 30-day one', () => {
  const old = { id: 'o', due_date: '2026-07-29' };
  const young = { id: 'y', due_date: '2026-08-24' };
  expect(daysOverdueOn(NOW, old.due_date)).toBe(30);
  expect(daysOverdueOn(NOW, young.due_date)).toBe(4);
  expect(accountDaysOverdue(NOW, [young, old])).toBe(30);
  expect(accountDaysOverdue(NOW, [])).toBe(0);
});

test('tiers and registers: 14 friendly · 30 firm · 60+ final', () => {
  expect(dunningTierForOverdue(13)).toBe(7);
  expect(dunningTierForOverdue(14)).toBe(14);
  expect(dunningTierForOverdue(29)).toBe(14);
  expect(dunningTierForOverdue(30)).toBe(30);
  expect(dunningTierForOverdue(60)).toBe(60);
  expect(dunningTierForOverdue(95)).toBe(90);
  expect(registerForTier(14)).toBe('friendly');
  expect(registerForTier(30)).toBe('firm');
  expect(registerForTier(60)).toBe('final');
  expect(registerForTier(90)).toBe('final');
});

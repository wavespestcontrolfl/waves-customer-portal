const { previsitBalanceReminderEligible, duesObligation, friendlyVisitDate, DUES_GRACE_DAYS } = require('../services/previsit-balance-reminder');

// Customer copy must never show an ISO string or a GMT timestamp (Codex r9).
describe('friendlyVisitDate', () => {
  test('formats a YYYY-MM-DD string as a friendly date', () => {
    expect(friendlyVisitDate('2026-07-28')).toBe('July 28, 2026');
  });

  test('formats a JS Date (pg DATE at UTC midnight) on the correct calendar day', () => {
    expect(friendlyVisitDate(new Date('2026-07-28T00:00:00Z'))).toBe('July 28, 2026');
  });

  test('passes unparseable values through untouched', () => {
    expect(friendlyVisitDate('soon')).toBe('soon');
    expect(friendlyVisitDate(null)).toBe('');
  });
});

// The owner rule this encodes: the reminder is tied to the upcoming visit's
// lane, not just the customer. Recurring debt + one-time visit = silence.
describe('previsitBalanceReminderEligible', () => {
  const base = {
    isRecurringVisit: true,
    payerBilled: false,
    alreadySent: false,
    laneMode: 'monthly_membership',
    duesCollected: false,
    todayEt: '2026-07-04',
    graceDateEt: '2026-07-04',
    overdueRecurringDue: 0,
  };

  test('member with late dues before a recurring visit → send', () => {
    expect(previsitBalanceReminderEligible(base)).toMatchObject({ send: true, duesLate: true });
  });

  test('a ONE-TIME visit never sends, even with recurring debt on the account (owner rule)', () => {
    expect(previsitBalanceReminderEligible({ ...base, isRecurringVisit: false }))
      .toEqual({ send: false, reason: 'one_time_visit' });
    expect(previsitBalanceReminderEligible({ ...base, isRecurringVisit: false, overdueRecurringDue: 96.6 }))
      .toEqual({ send: false, reason: 'one_time_visit' });
  });

  test('dues not late until the ET grace date arrives', () => {
    expect(previsitBalanceReminderEligible({ ...base, todayEt: '2026-07-03' }).send).toBe(false);
    expect(previsitBalanceReminderEligible({ ...base, todayEt: '2026-07-04' }).send).toBe(true);
    expect(previsitBalanceReminderEligible({ ...base, todayEt: '2026-07-05' }).send).toBe(true);
  });

  test('collected dues + no overdue recurring invoices → silence', () => {
    expect(previsitBalanceReminderEligible({ ...base, duesCollected: true }))
      .toEqual({ send: false, reason: 'no_recurring_late_balance' });
  });

  test('overdue RECURRING invoice debt sends for any recurring visit lane', () => {
    expect(previsitBalanceReminderEligible({
      ...base, laneMode: 'per_visit', duesCollected: null, overdueRecurringDue: 96.6,
    })).toMatchObject({ send: true, overdueDue: 96.6 });
  });

  test('payer-billed visits and already-reminded visits stay silent', () => {
    expect(previsitBalanceReminderEligible({ ...base, payerBilled: true }))
      .toEqual({ send: false, reason: 'payer_billed' });
    expect(previsitBalanceReminderEligible({ ...base, alreadySent: true }))
      .toEqual({ send: false, reason: 'already_sent' });
  });

  test('non-member lanes never count dues (only overdue recurring invoices)', () => {
    expect(previsitBalanceReminderEligible({
      ...base, laneMode: 'per_visit', duesCollected: false, overdueRecurringDue: 0,
    }).send).toBe(false);
  });
});

// Real DATE math for the dues obligation — month rollovers included (Codex r2).
describe('duesObligation', () => {
  test('mid-month: due on the billing day, grace DUES_GRACE_DAYS later, same month', () => {
    expect(duesObligation('2026-07-10', 1)).toEqual({
      dueDateEt: '2026-07-01', graceDateEt: '2026-07-04', monthKey: '2026-07',
    });
  });

  test('before the billing day, the obligation is LAST month (its dues, its grace)', () => {
    expect(duesObligation('2026-07-10', 15)).toEqual({
      dueDateEt: '2026-06-15', graceDateEt: '2026-06-18', monthKey: '2026-06',
    });
  });

  test('month-end billing day: grace rolls into the next month and February clamps (Codex r2)', () => {
    // Feb 2026 has 28 days; billing day 30 clamps to Feb 28. On Mar 2 the
    // obligation is still February, grace Mar 3 — not yet late; Mar 3 is.
    expect(duesObligation('2026-03-02', 30)).toEqual({
      dueDateEt: '2026-02-28', graceDateEt: '2026-03-03', monthKey: '2026-02',
    });
  });

  test('January rolls back across the year boundary', () => {
    expect(duesObligation('2026-01-05', 15)).toEqual({
      dueDateEt: '2025-12-15', graceDateEt: '2025-12-18', monthKey: '2025-12',
    });
  });

  test('NULL billing day defaults to the 1st', () => {
    expect(duesObligation('2026-07-10', null).dueDateEt).toBe('2026-07-01');
    expect(DUES_GRACE_DAYS).toBeGreaterThan(0);
  });
});

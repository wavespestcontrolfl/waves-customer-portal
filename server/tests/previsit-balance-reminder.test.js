const { previsitBalanceReminderEligible, DUES_GRACE_DAYS } = require('../services/previsit-balance-reminder');

// The owner rule this encodes: the reminder is tied to the upcoming visit's
// lane, not just the customer. Recurring debt + one-time visit = silence.
describe('previsitBalanceReminderEligible', () => {
  const base = {
    isRecurringVisit: true,
    payerBilled: false,
    alreadySent: false,
    laneMode: 'monthly_membership',
    duesCollected: false,
    todayEtDay: 1 + DUES_GRACE_DAYS,
    billingDay: 1,
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

  test('dues not late until the billing day + grace has passed', () => {
    expect(previsitBalanceReminderEligible({ ...base, todayEtDay: 1 }).send).toBe(false);
    expect(previsitBalanceReminderEligible({ ...base, todayEtDay: DUES_GRACE_DAYS }).send).toBe(false);
    expect(previsitBalanceReminderEligible({ ...base, todayEtDay: 1 + DUES_GRACE_DAYS }).send).toBe(true);
    expect(previsitBalanceReminderEligible({ ...base, billingDay: 15, todayEtDay: 16 }).send).toBe(false);
    expect(previsitBalanceReminderEligible({ ...base, billingDay: 15, todayEtDay: 15 + DUES_GRACE_DAYS }).send).toBe(true);
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

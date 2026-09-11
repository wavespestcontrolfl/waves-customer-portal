const {
  stackDiscounts,
  stackVisitDiscounts,
  stackGroupConflict,
  assertStackGroups,
} = require('../services/discount-stack');

const SILVER = { id: 'silver', name: 'WaveGuard Silver', discountType: 'percentage', amount: 10, stack_group: 'tier', is_stackable: false };
const GOLD = { id: 'gold', name: 'WaveGuard Gold', discountType: 'percentage', amount: 15, stack_group: 'tier', is_stackable: false };
const MILITARY = { id: 'military', name: 'Military Discount', discountType: 'percentage', amount: 5, is_stackable: true };
const REFERRAL = { id: 'referral', name: 'Referral Credit', discountType: 'fixed_amount', amount: 25, is_stackable: true };

describe('stackDiscounts (one base, many discounts)', () => {
  test('percentages compound in sequence — 10% then 5% is the lesser $16.10, not an additive $16.65', () => {
    const result = stackDiscounts(111, [SILVER, MILITARY]);
    expect(result.items.map((i) => i.dollars)).toEqual([11.1, 5]);
    expect(result.totalDollars).toBe(16.1);
    expect(result.net).toBe(94.9);
  });

  test('order of two percentages does not change the total', () => {
    expect(stackDiscounts(111, [MILITARY, SILVER]).net).toBe(94.9);
  });

  test('dollar credits come off first, then percentages compound on the remainder', () => {
    // $111 − $25 = $86, then 10% of $86 = $8.60 → $77.40 (not $74.90).
    const result = stackDiscounts(111, [SILVER, REFERRAL]);
    expect(result.items.map((i) => i.dollars)).toEqual([8.6, 25]);
    expect(result.net).toBe(77.4);
  });

  test('never takes the base below zero and reports clamped dollars', () => {
    const result = stackDiscounts(20, [REFERRAL, { discountType: 'fixed_amount', amount: 10 }]);
    expect(result.items.map((i) => i.dollars)).toEqual([20, 0]);
    expect(result.net).toBe(0);
  });

  test('honors a percentage cap and a free service takes the remainder', () => {
    const capped = stackDiscounts(200, [{ discountType: 'percentage', amount: 50, maxDiscountDollars: 30 }]);
    expect(capped.items[0].dollars).toBe(30);
    const free = stackDiscounts(200, [REFERRAL, { discountType: 'free_service', amount: 0 }]);
    expect(free.items.map((i) => i.dollars)).toEqual([25, 175]);
    expect(free.net).toBe(0);
  });
});

describe('stackVisitDiscounts (line slot + appointment slot)', () => {
  test("Silver on the pest line and Military on the visit, scoped to that line — the membership line is untouched", () => {
    const result = stackVisitDiscounts({
      lines: [
        { gross: 111, lineDiscount: SILVER, eligible: true },
        { gross: 60, lineDiscount: null, eligible: false },
      ],
      appointmentDiscount: MILITARY,
    });
    expect(result.lines[0]).toEqual({ lineDiscountDollars: 11.1, net: 99.9 });
    expect(result.lines[1]).toEqual({ lineDiscountDollars: 0, net: 60 });
    expect(result.subtotal).toBe(159.9);
    expect(result.appointmentDiscountDollars).toBe(5);
    expect(result.total).toBe(154.9);
  });

  test('a fixed appointment credit lands before a line percentage', () => {
    const result = stackVisitDiscounts({
      lines: [{ gross: 111, lineDiscount: SILVER, eligible: true }],
      appointmentDiscount: REFERRAL,
    });
    expect(result.appointmentDiscountDollars).toBe(25);
    expect(result.lines[0].lineDiscountDollars).toBe(8.6);
    expect(result.total).toBe(77.4);
  });

  test('a fixed appointment credit is spread pro rata over the eligible lines', () => {
    const result = stackVisitDiscounts({
      lines: [
        { gross: 100, lineDiscount: SILVER, eligible: true },
        { gross: 50, lineDiscount: SILVER, eligible: true },
        { gross: 40, lineDiscount: null, eligible: false },
      ],
      appointmentDiscount: { discountType: 'fixed_amount', amount: 30 },
    });
    // $30 over $150: $20 off the first line, $10 off the second.
    expect(result.lines.map((l) => l.lineDiscountDollars)).toEqual([8, 4, 0]);
    expect(result.appointmentDiscountDollars).toBe(30);
    expect(result.total).toBe(148);
  });

  test('without a fixed appointment credit the math is the legacy line-then-appointment order', () => {
    const result = stackVisitDiscounts({
      lines: [{ gross: 111, lineDiscount: SILVER, eligible: true }],
      appointmentDiscount: { discountType: 'percentage', amount: 5, maxDiscountDollars: 3 },
    });
    expect(result.lines[0].net).toBe(99.9);
    expect(result.appointmentDiscountDollars).toBe(3);
    expect(result.total).toBe(96.9);
  });

  test('no appointment discount and no line discounts is a plain sum', () => {
    const result = stackVisitDiscounts({ lines: [{ gross: 10 }, { gross: 5.5 }], appointmentDiscount: null });
    expect(result.subtotal).toBe(15.5);
    expect(result.appointmentDiscountDollars).toBe(0);
    expect(result.total).toBe(15.5);
  });
});

describe('stack groups', () => {
  test('two WaveGuard tiers on one document are refused', () => {
    expect(stackGroupConflict([SILVER, GOLD])).toEqual({ group: 'tier', names: ['WaveGuard Silver', 'WaveGuard Gold'] });
    expect(() => assertStackGroups([SILVER, MILITARY, GOLD])).toThrow(/Only one WaveGuard tier discount can apply: WaveGuard Silver and WaveGuard Gold/);
  });

  test('a tier plus stackable discounts is fine, and the same tier may sit on two different lines', () => {
    expect(stackGroupConflict([SILVER, MILITARY, REFERRAL])).toBeNull();
    expect(stackGroupConflict([
      { ...SILVER, scope: 'primary' },
      { ...SILVER, scope: 'addon:0' },
    ])).toBeNull();
    expect(() => assertStackGroups([SILVER, null, undefined])).not.toThrow();
  });

  test('the same tier twice on ONE lane, or on a line and the document-wide slot, is refused', () => {
    // Two rows with no lane at all are the same lane.
    expect(stackGroupConflict([SILVER, SILVER])?.group).toBe('tier');
    expect(stackGroupConflict([
      { ...SILVER, scope: 'primary' },
      { ...SILVER, scope: 'primary' },
    ])?.group).toBe('tier');
    // A line slot plus the appointment slot would compound on that line.
    expect(stackGroupConflict([
      { ...SILVER, scope: 'primary' },
      { ...SILVER, spansAll: true },
    ])?.group).toBe('tier');
    expect(stackGroupConflict([
      { ...SILVER, spansAll: true },
      { ...SILVER, scope: 'addon:0' },
    ])?.group).toBe('tier');
  });

  test('the error carries a 400 status', () => {
    try {
      assertStackGroups([SILVER, GOLD]);
    } catch (err) {
      expect(err.status).toBe(400);
    }
  });
});

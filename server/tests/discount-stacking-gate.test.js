/**
 * GATE_DISCOUNT_STACKING dark (the default): off unless the env var is the
 * exact string 'true'.
 *
 * This file is a trimmed carry from claude/multiple-discounts-service-q0idfk
 * (Codex #4405 slice 1 — server engine + gate/API contract). The source
 * version also asserted the visit path (buildAppointmentPricing /
 * calculateVisitFinancialsForAddons from server/routes/admin-schedule.js)
 * and the invoice path (InvoiceService._internals.stackLineItemDiscounts)
 * stay byte-identical while the gate is dark. Those assertions depend on
 * schedule/invoice changes that are NOT part of this slice — admin-schedule.js
 * has no discountServiceKeyFilter refusal yet and invoice.js has no
 * stackLineItemDiscounts export yet — so they were dropped here rather than
 * carried failing; they belong in the admin-schedule.js and invoice.js
 * slices, which can re-add this coverage once those callers exist. The pure
 * engine's own compound:false / legacy-order behavior is already exercised
 * by discount-stack.test.js and discount-stack-r3-fixes.test.js, so nothing
 * about server/services/discount-stack.js itself goes untested by this trim.
 */
delete process.env.GATE_DISCOUNT_STACKING;

const { isEnabled } = require('../config/feature-gates');

describe('the gate itself', () => {
  test('ships dark — only the exact string "true" turns it on', () => {
    expect(isEnabled('discountStacking')).toBe(false);
  });
});

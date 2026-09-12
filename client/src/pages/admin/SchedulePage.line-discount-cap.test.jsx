// @vitest-environment jsdom
// Codex #4405 P1: a seeded line-discount stamp (the primary line's
// server-stamped type/amount, or an add-on's auto-seeded stamp) carries no
// cap — scheduled_services has no line_discount_max_dollars column — so the
// preview must pull the cap from the live catalog row, but ONLY when that
// row still confirms the stamp's type/amount (mirrors reconstructStoredLineSlot
// on the server). Otherwise a stored 50%-capped-at-$20 discount on a $100
// line previews as $50 off while the server saves $20.
import { describe, expect, it } from "vitest";
import { verifiedLineDiscountCap } from "./SchedulePage";
import { stackVisitDiscounts } from "../../lib/discountStack";

describe("verifiedLineDiscountCap", () => {
  const stamp = { id: "d1", name: "Fall Promo", discount_type: "percentage", amount: 50 };

  it("null stamp passes through", () => {
    expect(verifiedLineDiscountCap(null, { discount_type: "percentage", amount: 50, max_discount_dollars: 20 })).toBeNull();
  });

  it("no catalog row (not loaded yet, or deleted): stamp is returned unchanged (uncapped) — no regression, not a new failure", () => {
    expect(verifiedLineDiscountCap(stamp, null)).toEqual(stamp);
  });

  it("catalog type no longer matches the stamp (edited-since preset): stamp is returned unchanged, cap withheld", () => {
    const catalogRow = { discount_type: "fixed_amount", amount: 50, max_discount_dollars: 20 };
    expect(verifiedLineDiscountCap(stamp, catalogRow)).toEqual(stamp);
  });

  it("catalog amount drifted from the stamp (edited-since preset): stamp is returned unchanged, cap withheld", () => {
    const catalogRow = { discount_type: "percentage", amount: 25, max_discount_dollars: 20 };
    expect(verifiedLineDiscountCap(stamp, catalogRow)).toEqual(stamp);
  });

  it("catalog confirms type+amount: the verified cap is merged in", () => {
    const catalogRow = { discount_type: "percentage", amount: 50, max_discount_dollars: 20 };
    expect(verifiedLineDiscountCap(stamp, catalogRow)).toEqual({ ...stamp, max_discount_dollars: 20 });
  });

  it("a variable/custom catalog preset confirms on type alone — its own amount is a 0/placeholder, not the operator-entered stamp amount", () => {
    const variableStamp = { id: "d2", name: "Custom %", discount_type: "variable_percentage", amount: 15 };
    const catalogRow = { discount_type: "variable_percentage", amount: 0, max_discount_dollars: 30 };
    expect(verifiedLineDiscountCap(variableStamp, catalogRow)).toEqual({ ...variableStamp, max_discount_dollars: 30 });
  });
});

describe("preview divergence this fix closes (stackVisitDiscounts)", () => {
  // The exact scenario in the finding: a stored 50%-capped-at-$20 discount
  // on a $100 line previews as $50 off (uncapped) instead of the $20 the
  // server saves, once stacking resolves the seeded stamp's type/amount.
  it("FAILS without the cap: an uncapped seeded stamp compounds to $50, not the $20 cap", () => {
    const uncappedStamp = { id: "d1", discount_type: "percentage", amount: 50 }; // no max_discount_dollars
    const result = stackVisitDiscounts({
      lines: [{ gross: 100, lineDiscount: uncappedStamp, eligible: true }],
      appointmentDiscount: null,
      compound: true,
    });
    expect(result.lines[0].lineDiscountDollars).toBe(50);
  });

  it("with the verified cap merged in, the preview matches the server's $20 cap", () => {
    const stamp = { id: "d1", discount_type: "percentage", amount: 50 };
    const catalogRow = { discount_type: "percentage", amount: 50, max_discount_dollars: 20 };
    const capped = verifiedLineDiscountCap(stamp, catalogRow);
    const result = stackVisitDiscounts({
      lines: [{ gross: 100, lineDiscount: capped, eligible: true }],
      appointmentDiscount: null,
      compound: true,
    });
    expect(result.lines[0].lineDiscountDollars).toBe(20);
  });
});

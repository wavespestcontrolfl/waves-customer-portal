import { describe, expect, it } from "vitest";
import { humanizeQuoteReason, quoteRequiredReasonText } from "./quoteDisplay";

describe("area add-on custom-quote reasons read in plain words", () => {
  it("the yearly limit and the unreadable history have their own copy, with no dates", () => {
    expect(humanizeQuoteReason("area_addon_yearly_limit_reached")).toBe("This treatment was applied at your property too recently to repeat — Waves will confirm what can be scheduled and the price before it’s finalized.");
    expect(humanizeQuoteReason("area_addon_history_unavailable")).toBe("Waves could not check this property’s treatment history — Waves will confirm this treatment and its price before it’s finalized.");
    expect(quoteRequiredReasonText({ customQuoteReason: "area_addon_yearly_limit_reached" })).toMatch(/too recently to repeat/);
  });

  it("an unknown token is still humanized, and plain text passes through", () => {
    expect(humanizeQuoteReason("some_new_reason")).toBe("Some new reason");
    expect(humanizeQuoteReason("Already plain.")).toBe("Already plain.");
  });
});

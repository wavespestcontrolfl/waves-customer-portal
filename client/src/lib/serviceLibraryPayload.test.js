import { describe, expect, it } from "vitest";
import { buildMobileServicePayload } from "./serviceLibraryPayload";

describe("buildMobileServicePayload", () => {
  it("preserves a variable service baseline during quick edit", () => {
    const payload = buildMobileServicePayload({
      service: { base_price: "89.00" },
      isNew: false,
      name: "Lawn Care",
      duration: "45",
      pricingType: "variable",
      basePrice: "89.00",
      isActive: true,
    });

    expect(payload.base_price).toBe("89.00");
  });

  it("uses the edited amount for fixed-price services", () => {
    const payload = buildMobileServicePayload({
      service: { base_price: "89.00" },
      isNew: false,
      name: "Inspection",
      duration: "60",
      pricingType: "fixed",
      basePrice: "125.50",
      isActive: true,
    });

    expect(payload.base_price).toBe(125.5);
  });
});

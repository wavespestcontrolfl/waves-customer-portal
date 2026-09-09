import { describe, expect, it } from "vitest";
import { buildMobileServicePayload, omitUnchangedDurationFields } from "./serviceLibraryPayload";

describe("buildMobileServicePayload", () => {
  it("omits echoed policy durations while retaining an intentional change", () => {
    const service = { min_duration_minutes: 30, default_duration_minutes: 30, max_duration_minutes: 40 };
    expect(omitUnchangedDurationFields({ ...service, name: "Renamed" }, service)).toEqual({ name: "Renamed" });
    expect(omitUnchangedDurationFields({ ...service, default_duration_minutes: "40" }, service))
      .toEqual({ default_duration_minutes: "40" });
    expect(buildMobileServicePayload({ service, duration: "30", name: "Renamed", isNew: false }))
      .not.toHaveProperty("default_duration_minutes");
  });

  it("compares durations to the opened form while preserving the current price baseline", () => {
    const payload = buildMobileServicePayload({
      service: { default_duration_minutes: 60, base_price: "99.00" },
      originalService: { default_duration_minutes: 30, base_price: "89.00" },
      duration: "30", name: "Renamed", pricingType: "variable", isNew: false,
    });
    expect(payload).not.toHaveProperty("default_duration_minutes");
    expect(payload.base_price).toBe("99.00");
    expect(buildMobileServicePayload({ duration: "30", isNew: true }).default_duration_minutes).toBe(30);
  });

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

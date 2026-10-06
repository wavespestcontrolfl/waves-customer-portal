import { describe, expect, it } from "vitest";

import {
  mergePostPaymentService,
  shouldOpenPestFastComplete,
  shouldReopenCompletionAfterPayment,
} from "./dispatchCompletionRouting";

describe("post-payment completion routing", () => {
  it.each(["completed", "cancelled", "no_show", "skipped"])(
    "does not reopen completion for a %s visit",
    (status) => {
      expect(shouldReopenCompletionAfterPayment({ status })).toBe(false);
    },
  );

  it.each(["pending", "confirmed", "rescheduled", "en_route", "on_site"])(
    "reopens completion for an active %s visit",
    (status) => {
      expect(shouldReopenCompletionAfterPayment({ status })).toBe(true);
    },
  );

  it("keeps fresh terminal status while carrying paid invoice state", () => {
    expect(
      mergePostPaymentService(
        { id: "svc-1", status: "completed", checkoutInvoiceStatus: "draft" },
        { id: "svc-1", status: "confirmed", checkoutInvoiceStatus: "paid" },
      ),
    ).toMatchObject({ status: "completed", checkoutInvoiceStatus: "paid" });
  });
});

describe("shouldOpenPestFastComplete (owner 2026-10-05)", () => {
  const pest = (overrides = {}) => ({
    id: "svc-1",
    status: "on_site",
    propertyId: null,
    fastCompleteReportEnabled: true,
    completionProfile: { category: "pest_control", serviceKey: "pest_control_quarterly", findingsType: null },
    ...overrides,
  });

  it("opens for a regular pest visit and a pest re-service while the report gate is on", () => {
    expect(shouldOpenPestFastComplete(pest())).toBe(true);
    expect(shouldOpenPestFastComplete(pest({ completionProfile: { category: "pest_control", serviceKey: "pest_re_service", findingsType: null } }))).toBe(true);
  });

  it("stays off with the gate off, for other service lines, and for closed visits", () => {
    expect(shouldOpenPestFastComplete(pest({ fastCompleteReportEnabled: false }))).toBe(false);
    expect(shouldOpenPestFastComplete(pest({ fastCompleteReportEnabled: undefined }))).toBe(false);
    expect(shouldOpenPestFastComplete(pest({ completionProfile: { category: "lawn_care", findingsType: null } }))).toBe(false);
    for (const status of ["completed", "cancelled", "skipped", "no_show"]) {
      expect(shouldOpenPestFastComplete(pest({ status }))).toBe(false);
    }
  });

  it("stays off for typed and combined profiles, outline traces and a failed project lookup", () => {
    expect(shouldOpenPestFastComplete(pest({ completionProfile: { category: "pest_control", findingsType: "cockroach" } }))).toBe(false);
    expect(shouldOpenPestFastComplete(pest({ completionProfile: { category: "pest_control", findingsType: null, companions: [{ type: "rodent_bait" }] } }))).toBe(false);
    expect(shouldOpenPestFastComplete(pest({ traceVariant: "outline" }))).toBe(false);
    expect(shouldOpenPestFastComplete(pest({ linkedProjectLookupFailed: true }))).toBe(false);
  });

  it("keeps the full form for a row with no premise key and for a visit returning from payment", () => {
    const { propertyId: _omit, ...weekRow } = pest();
    expect(shouldOpenPestFastComplete(weekRow)).toBe(false);
    expect(shouldOpenPestFastComplete(pest({ completionInvoiceAlreadySent: true }))).toBe(false);
    expect(shouldOpenPestFastComplete(pest({ checkoutInvoiceId: "inv-fixture" }))).toBe(false);
    expect(shouldOpenPestFastComplete(pest({ checkoutInvoiceToken: "tok-fixture" }))).toBe(false);
  });
});

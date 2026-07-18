import { describe, expect, it } from "vitest";

import {
  mergePostPaymentService,
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

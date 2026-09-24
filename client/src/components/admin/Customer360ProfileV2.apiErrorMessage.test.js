import { describe, expect, it } from "vitest";
import { apiErrorMessage } from "./Customer360ProfileV2";

// Codex review round 1 on PR #4684: the Edit/Delete catch sites in
// CustomerProfileEditor read e.body?.message (adminFetch's parsed clone of
// a structured refusal), never e.message — adminFetch derives err.message
// from body.error/body.reason/body.message/body.code IN THAT ORDER, so a
// 409 like { error: 'customer_still_billing_or_scheduled', message: 'This
// customer still has a scheduled visit...' } left err.message as the
// opaque error CODE. apiErrorMessage is the one place both catch sites now
// call, so this fix can't regress independently on either.
describe("apiErrorMessage (Codex round 1, PR #4684)", () => {
  it("prefers the structured refusal's body.message over the opaque err.message code", () => {
    const err = new Error("customer_still_billing_or_scheduled");
    err.body = { error: "customer_still_billing_or_scheduled", message: "This customer still has a scheduled visit on 2026-10-14. Use \"Cancel plan…\" to wind down billing and visits together, then mark Churned." };
    expect(apiErrorMessage(err, "Save failed")).toBe(
      "This customer still has a scheduled visit on 2026-10-14. Use \"Cancel plan…\" to wind down billing and visits together, then mark Churned.",
    );
  });

  it("falls back to err.message when the body has no message field", () => {
    const err = new Error("HTTP 500");
    err.body = { error: "internal_error" };
    expect(apiErrorMessage(err, "Save failed")).toBe("HTTP 500");
  });

  it("falls back to err.message when the body failed to parse (no err.body at all)", () => {
    const err = new Error("Failed to fetch");
    expect(apiErrorMessage(err, "Save failed")).toBe("Failed to fetch");
  });

  it("falls back to the caller-supplied default when there is no error message anywhere", () => {
    const err = {};
    expect(apiErrorMessage(err, "Save failed")).toBe("Save failed");
    expect(apiErrorMessage(null, "Delete failed")).toBe("Delete failed");
  });
});

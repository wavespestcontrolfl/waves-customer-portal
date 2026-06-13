import { describe, expect, it } from "vitest";

import { shouldResetCompletionIdempotencyKey } from "./SchedulePage.jsx";

describe("completion idempotency retry keys", () => {
  it("resets the key for ordinary client errors", () => {
    expect(shouldResetCompletionIdempotencyKey({ status: 400 })).toBe(true);
    expect(shouldResetCompletionIdempotencyKey({ status: 422 })).toBe(true);
  });

  it("preserves the key for billing-required conflicts", () => {
    expect(
      shouldResetCompletionIdempotencyKey({
        status: 409,
        code: "completion_billing_required",
      }),
    ).toBe(false);
  });

  it("resets the key when a stale lawn assessment conflict needs a refreshed retry", () => {
    expect(
      shouldResetCompletionIdempotencyKey({
        status: 409,
        code: "lawn_assessment_stale",
      }),
    ).toBe(true);
  });

  it("does not reset for server errors", () => {
    expect(shouldResetCompletionIdempotencyKey({ status: 500 })).toBe(false);
  });
});

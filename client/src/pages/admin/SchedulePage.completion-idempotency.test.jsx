import { describe, expect, it } from "vitest";

import {
  completionPreferencesNeedDraft,
  normalizeCompletionDetourPhotos,
  shouldResetCompletionIdempotencyKey,
} from "./SchedulePage.jsx";

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

describe("completion detour draft state", () => {
  it("treats outbound-message and pest-rating changes as draft content", () => {
    expect(completionPreferencesNeedDraft()).toBe(false);
    expect(completionPreferencesNeedDraft({ sendSms: false })).toBe(true);
    expect(completionPreferencesNeedDraft({ includePayLink: false })).toBe(true);
    expect(completionPreferencesNeedDraft({ requestReview: false })).toBe(true);
    expect(completionPreferencesNeedDraft({ clientPestRating: 0 })).toBe(true);
  });

  it("keeps prepared photos available for the in-memory billing detour", () => {
    const photos = [{ name: "after.jpg", data: "data:image/jpeg;base64,abc" }];
    expect(normalizeCompletionDetourPhotos(photos)).toBe(photos);
    expect(normalizeCompletionDetourPhotos(null)).toEqual([]);
  });
});

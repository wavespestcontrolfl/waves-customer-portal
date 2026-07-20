import { describe, expect, it } from "vitest";

import {
  completionPreferencesNeedDraft,
  completionTimeOnSiteBody,
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

describe("backfill timeOnSite submission (Codex P1, PR #2897)", () => {
  // The running `elapsed` derives from the visit's ORIGINAL check-in — for a
  // stale on_site row that's days/weeks — and the server treats any submitted
  // timeOnSite as explicit operator input (persisted duration + job-costing
  // labor). Under a backdated closeout only a TYPED positive number travels.
  it("backfill checked + empty input → no timeOnSite key at all", () => {
    expect(
      completionTimeOnSiteBody({ backfill: true, typedMinutes: "", elapsed: "412:07:33" }),
    ).toEqual({});
  });

  it("backfill checked + typed 45 → exactly 45, never the auto elapsed", () => {
    expect(
      completionTimeOnSiteBody({ backfill: true, typedMinutes: "45", elapsed: "412:07:33" }),
    ).toEqual({ timeOnSite: 45 });
  });

  it("backfill checked + junk/zero/negative input → no key (server records unknown)", () => {
    for (const junk of ["abc", "0", "-5", null, undefined]) {
      expect(
        completionTimeOnSiteBody({ backfill: true, typedMinutes: junk, elapsed: "412:07:33" }),
      ).toEqual({});
    }
  });

  it("unchecked → today's behavior exactly: the auto elapsed submits", () => {
    expect(
      completionTimeOnSiteBody({ backfill: false, typedMinutes: "45", elapsed: "0:07:21" }),
    ).toEqual({ timeOnSite: "0:07:21" });
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

import { describe, expect, it } from "vitest";

import {
  completionPreferencesNeedDraft,
  completionReviewSuppressionReason,
  completionTimeOnSiteBody,
  completionWillReview,
  restoredBackfillChoices,
  shouldResetCompletionIdempotencyKey,
} from "./SchedulePage.jsx";

describe("completion idempotency retry keys", () => {
  it("resets the key for ordinary client errors", () => {
    expect(shouldResetCompletionIdempotencyKey({ status: 400 })).toBe(true);
    expect(shouldResetCompletionIdempotencyKey({ status: 422 })).toBe(true);
  });

  it("preserves the key for ordinary conflicts", () => {
    expect(
      shouldResetCompletionIdempotencyKey({
        status: 409,
        code: "completion_side_effects_running",
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

describe("live admin time-on-site override (forgotten-closeout fix)", () => {
  // On a live completion the wire contract is TYPE-based: a NUMBER is
  // admin-typed minutes overriding the running timer; a string stays the
  // auto-elapsed. The backfill branch keeps its own input and semantics.
  it("typed minutes on a live completion submit as a NUMBER, not the elapsed", () => {
    expect(
      completionTimeOnSiteBody({ backfill: false, elapsed: "2:19:05", adjustedMinutes: "45" }),
    ).toEqual({ timeOnSite: 45 });
    expect(
      completionTimeOnSiteBody({ backfill: false, elapsed: "2:19:05", adjustedMinutes: " 45 " }),
    ).toEqual({ timeOnSite: 45 });
  });

  it("blank falls back to the timer — today's behavior exactly", () => {
    for (const blank of ["", "   ", null, undefined]) {
      expect(
        completionTimeOnSiteBody({ backfill: false, elapsed: "2:19:05", adjustedMinutes: blank }),
      ).toEqual({ timeOnSite: "2:19:05" });
    }
  });

  it("out-of-range/junk falls back to the timer (handleSubmit alerts first; this is the stale-draft belt-and-suspenders)", () => {
    for (const bad of ["0", "-5", "721", "abc"]) {
      expect(
        completionTimeOnSiteBody({ backfill: false, elapsed: "2:19:05", adjustedMinutes: bad }),
      ).toEqual({ timeOnSite: "2:19:05" });
    }
  });

  it("the backfill branch ignores adjustedMinutes entirely — its own input owns that mode", () => {
    expect(
      completionTimeOnSiteBody({
        backfill: true,
        typedMinutes: "30",
        elapsed: "412:07:33",
        adjustedMinutes: "45",
      }),
    ).toEqual({ timeOnSite: 30 });
    expect(
      completionTimeOnSiteBody({
        backfill: true,
        typedMinutes: "",
        elapsed: "412:07:33",
        adjustedMinutes: "45",
      }),
    ).toEqual({});
  });

  it("typed override minutes are draft content; whitespace is not", () => {
    expect(completionPreferencesNeedDraft({ adjustedTimeOnSite: "45" })).toBe(true);
    expect(completionPreferencesNeedDraft({ adjustedTimeOnSite: "  " })).toBe(false);
    expect(completionPreferencesNeedDraft({ adjustedTimeOnSite: "" })).toBe(false);
  });
});

describe("completion draft state", () => {
  it("treats outbound-message and pest-rating changes as draft content", () => {
    expect(completionPreferencesNeedDraft()).toBe(false);
    expect(completionPreferencesNeedDraft({ sendSms: false })).toBe(true);
    expect(completionPreferencesNeedDraft({ includePayLink: false })).toBe(true);
    expect(completionPreferencesNeedDraft({ requestReview: false })).toBe(true);
    expect(completionPreferencesNeedDraft({ clientPestRating: 0 })).toBe(true);
  });
});

describe("backfill choices survive the completion draft (Codex P2, PR #2897 fix round 6)", () => {
  // Losing a checked backdate box across a reload turns the SAME submit into
  // a LOUD completion (sends + collection rails). The default is dynamic —
  // CHECKED at ≥7 days stale, unchecked at 1–6 — so it is drift from the
  // panel default, in either direction, that makes the choice draft content.
  it("checkbox drift from the panel default is draft content — both directions", () => {
    expect(
      completionPreferencesNeedDraft({ backfillCloseout: true, backfillCloseoutDefault: false }),
    ).toBe(true);
    expect(
      completionPreferencesNeedDraft({ backfillCloseout: false, backfillCloseoutDefault: true }),
    ).toBe(true);
    expect(
      completionPreferencesNeedDraft({ backfillCloseout: false, backfillCloseoutDefault: false }),
    ).toBe(false);
    expect(
      completionPreferencesNeedDraft({ backfillCloseout: true, backfillCloseoutDefault: true }),
    ).toBe(false);
  });

  it("typed minutes are draft content; whitespace is not", () => {
    expect(completionPreferencesNeedDraft({ backfillTimeOnSite: "45" })).toBe(true);
    expect(completionPreferencesNeedDraft({ backfillTimeOnSite: "  " })).toBe(false);
    expect(completionPreferencesNeedDraft({ backfillTimeOnSite: "" })).toBe(false);
  });

  it("restore round-trips the saved choices — the quiet choice never degrades to LOUD", () => {
    expect(
      restoredBackfillChoices(
        { backfillCloseout: true, backfillTimeOnSite: "45", adjustedTimeOnSite: "50" },
        false,
      ),
    ).toEqual({ backfillCloseout: true, backfillTimeOnSite: "45", adjustedTimeOnSite: "50" });
    // The ≥7-day inverse: an explicit LOUD choice survives a CHECKED default.
    expect(
      restoredBackfillChoices({ backfillCloseout: false, backfillTimeOnSite: "" }, true),
    ).toEqual({ backfillCloseout: false, backfillTimeOnSite: "", adjustedTimeOnSite: "" });
  });

  it("a legacy draft without the fields restores the panel default, not false", () => {
    expect(restoredBackfillChoices({}, true)).toEqual({
      backfillCloseout: true,
      backfillTimeOnSite: "",
      adjustedTimeOnSite: "",
    });
    expect(restoredBackfillChoices({}, false)).toEqual({
      backfillCloseout: false,
      backfillTimeOnSite: "",
      adjustedTimeOnSite: "",
    });
    // Junk shapes fall back the same way instead of leaking through.
    expect(
      restoredBackfillChoices(
        { backfillCloseout: "true", backfillTimeOnSite: 45, adjustedTimeOnSite: 50 },
        false,
      ),
    ).toEqual({ backfillCloseout: false, backfillTimeOnSite: "", adjustedTimeOnSite: "" });
  });
});

describe("review state under a backdated quiet closeout (Codex P2, PR #2897 fix round 6)", () => {
  it("backfill suppresses the review ask — willReview false, so no review-time validation can block the submit", () => {
    const reason = completionReviewSuppressionReason({ backfillQuietCloseout: true });
    expect(reason).toBe("backfill");
    expect(
      completionWillReview({ requestReview: true, reviewSuppressionReason: reason }),
    ).toBe(false);
    // Recap-only mode suppresses the same way (its requestReview posts
    // !reviewSuppressionReason, so the body carries false too).
    expect(
      completionWillReview({ oneTimeRecapOnly: true, reviewSuppressionReason: reason }),
    ).toBe(false);
  });

  it("without backfill the existing suppression chain is unchanged", () => {
    expect(completionReviewSuppressionReason({})).toBe(null);
    expect(completionReviewSuppressionReason({ isIncompleteVisit: true })).toBe("incomplete");
    expect(
      completionReviewSuppressionReason({ visitOutcome: "customer_declined" }),
    ).toBe("customer_declined");
    expect(
      completionReviewSuppressionReason({ visitOutcome: "customer_concern" }),
    ).toBe("customer_concern");
    expect(
      completionReviewSuppressionReason({ customerConcernInteraction: true }),
    ).toBe("customer_concern");
    // Coverage fix (2026-07-30): an invoiced completion is no longer a
    // client-side suppression — the server owns the invoice rule (unpaid
    // blocks at completion, the paid-invoice webhook queues the ask).
    expect(completionReviewSuppressionReason({ willInvoice: true })).toBe(null);
    expect(completionWillReview({ requestReview: true })).toBe(true);
    expect(completionWillReview({ requestReview: false })).toBe(false);
    expect(completionWillReview({ requestReview: true, willInvoice: true })).toBe(true);
    expect(completionWillReview({ oneTimeRecapOnly: true, requestReview: false })).toBe(true);
  });

  it("incomplete still outranks backfill for the reason string", () => {
    expect(
      completionReviewSuppressionReason({ isIncompleteVisit: true, backfillQuietCloseout: true }),
    ).toBe("incomplete");
  });
});

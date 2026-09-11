// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  buildPhotoRecoveryOutcome,
  buildPhotoRetryFormBody,
  completionAutoCloseDelay,
} from "./SchedulePage";

const photo = (n, extra = {}) => ({ data: `data:image/jpeg;base64,${"QUJD".repeat(n)}`, name: `p${n}.jpg`, ...extra });

describe("buildPhotoRecoveryOutcome", () => {
  const base = { serviceId: "svc-1", servicePhotos: [photo(1), photo(2)], lastSubmitBody: null, prior: null };

  it("owes nothing when every photo attached and no reconciliation is owed", () => {
    const result = { completionPhotoUpload: { failed: 0 } };
    expect(buildPhotoRecoveryOutcome({ ...base, completion: result, result })).toEqual({ photosOwed: false, draft: null });
    expect(buildPhotoRecoveryOutcome({ ...base, completion: {}, result: {} })).toEqual({ photosOwed: false, draft: null });
  });

  it("re-queues the committed body's photos when uploads failed", () => {
    const result = { completionPhotoUpload: { failed: 1 } };
    const lastSubmitBody = { completionPhotos: [photo(9)] };
    const { photosOwed, draft } = buildPhotoRecoveryOutcome({ ...base, completion: result, result, lastSubmitBody });
    expect(photosOwed).toBe(true);
    expect(draft).toMatchObject({ serviceId: "svc-1", servicePhotos: [photo(9)], generationPhotoCount: 1, reconcileOwed: false, pendingPhotoCompletion: result });
    expect(draft.draftId).toMatch(/[0-9a-f-]{36}/);
  });

  it("owes only the reconciliation, with no photos, when the server parked the summary", () => {
    const result = { completionPhotoUpload: { failed: 0, reconcileOwed: true } };
    const { draft } = buildPhotoRecoveryOutcome({ ...base, completion: result, result });
    expect(draft).toMatchObject({ servicePhotos: [], generationPhotoCount: 0, reconcileOwed: true });
  });

  it("a failed upload wins over a reconcile flag: photos are re-queued, not skipped", () => {
    const result = { completionPhotoUpload: { failed: 2, reconcileOwed: true } };
    const { draft } = buildPhotoRecoveryOutcome({ ...base, completion: result, result });
    expect(draft).toMatchObject({ servicePhotos: base.servicePhotos, reconcileOwed: false });
  });

  it("keeps the autosaved draftId only for the identical photo set", () => {
    const result = { completionPhotoUpload: { failed: 1 } };
    const prior = { draftId: "draft-same", serviceId: "svc-1", servicePhotos: base.servicePhotos };
    expect(buildPhotoRecoveryOutcome({ ...base, completion: result, result, prior }).draft.draftId).toBe("draft-same");
    const otherVisit = { ...prior, serviceId: "svc-2" };
    expect(buildPhotoRecoveryOutcome({ ...base, completion: result, result, prior: otherVisit }).draft.draftId).not.toBe("draft-same");
    const fewer = { completionPhotos: [photo(1)] };
    expect(buildPhotoRecoveryOutcome({ ...base, completion: result, result, prior, lastSubmitBody: fewer }).draft.draftId).not.toBe("draft-same");
  });
});

describe("completionAutoCloseDelay", () => {
  it("auto-closes quickly by default and later when the SMS needs a glance", () => {
    expect(completionAutoCloseDelay({}, false, false)).toBe(1200);
    expect(completionAutoCloseDelay({ completionSmsStatus: "blocked" }, false, false)).toBe(3200);
    expect(completionAutoCloseDelay({ completionSmsStatus: "failed" }, false, false)).toBe(3200);
    expect(completionAutoCloseDelay({ completionSmsStatus: "sent" }, false, false)).toBe(1200);
  });

  it("holds the overlay open for a required follow-up, a pending recap, advisories, or owed photos", () => {
    expect(completionAutoCloseDelay({ followupSuggestion: { required: true } }, false, false)).toBeNull();
    expect(completionAutoCloseDelay({ followupSuggestion: { required: false } }, false, false)).toBe(1200);
    expect(completionAutoCloseDelay({}, false, true)).toBeNull();
    expect(completionAutoCloseDelay({ completionAdvisories: ["Low product"] }, false, false)).toBeNull();
    expect(completionAutoCloseDelay({ completionAdvisories: [] }, false, false)).toBe(1200);
    expect(completionAutoCloseDelay({}, true, false)).toBeNull();
  });
});

describe("buildPhotoRetryFormBody", () => {
  it("derives the attachment fields from the panel-shaped photo", () => {
    const form = buildPhotoRetryFormBody(photo(1, { caption: "Front door", captionSource: "ai", photoType: "before", sortOrder: 4 }), 0);
    expect(form.get("photo")).toBeInstanceOf(Blob);
    expect(form.get("photo").type).toBe("image/jpeg");
    expect(form.get("photoType")).toBe("before");
    expect(form.get("sortOrder")).toBe("4");
    expect(form.get("caption")).toBe("Front door");
    expect(JSON.parse(form.get("aiTags"))).toEqual({ captionSource: "ai" });
  });

  it("falls back to the index, the after type, and no caption or tags", () => {
    const form = buildPhotoRetryFormBody({ data: "data:image/png;base64,QUJD" }, 3);
    expect(form.get("photo").type).toBe("image/png");
    expect(form.get("photoType")).toBe("after");
    expect(form.get("sortOrder")).toBe("3");
    expect(form.get("caption")).toBeNull();
    expect(form.get("aiTags")).toBeNull();
  });
});

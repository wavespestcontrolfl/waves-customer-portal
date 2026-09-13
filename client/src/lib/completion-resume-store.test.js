// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import {
  deleteCompletionResumeBody,
  PRUNE_GRACE_MS,
  getCompletionResumeBody,
  pruneCompletionResumeBodies,
  putCompletionResumeBody,
  putCompletionDraft,
  getCompletionDraft,
  deleteCompletionDraft,
  pruneCompletionDrafts,
  DRAFT_RETENTION_MS,
  deleteVisitCompletionDraft,
  getVisitCompletionDraft,
  putVisitCompletionDraft,
} from "./completion-resume-store";
import {
  clearCompletionResumeOwed,
  completionResumeOwed,
  persistCompletionResumeOwed,
  restoreCompletionResumeBody,
} from "../pages/admin/SchedulePage.jsx";

// A committed completion body the way handleSubmit builds it: the original
// idempotency key, station capturedAt stamps, and base64 photos — the parts
// a rebuilt body cannot reproduce and the server's resume hash binds.
const photo = (n) => ({
  data: `data:image/jpeg;base64,${"A".repeat(2000)}${n}`,
  name: `service-photo-${n}.jpg`,
  photoType: "after",
  sortOrder: n,
  capturedAt: "2026-09-03T02:00:00.000Z",
});
const committedBody = () => ({
  idempotencyKey: "complete_svc-1_7c1c0f7e",
  notes: "Treated exterior perimeter.",
  stationReferences: [{ id: "st-1", capturedAt: "2026-09-03T02:00:01.000Z" }],
  completionPhotos: [photo(1), photo(2)],
});

beforeEach(() => {
  // Fresh database AND fresh marker per test.
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

describe("completion resume store (IndexedDB)", () => {
  it("keeps prepared visit forms outside the store an older completion panel prunes", async () => {
    const draft = { visitId: 'visit-1', key: 'visit-key', forms: { 'svc-1': { body: committedBody() } } };
    const past = Date.now() - PRUNE_GRACE_MS * 10;
    await putVisitCompletionDraft('visit-1', draft, 'tech-a', past);
    // This unmarked row models where the first closeout UI stored visit
    // drafts. The current pruner deliberately has the same key-agnostic
    // behavior as an already-open previous-version CompletionPanel tab.
    await putCompletionResumeBody('visit:legacy-location', draft, past);
    expect(await pruneCompletionResumeBodies(() => false)).toBe(1);
    expect(await getCompletionResumeBody('visit:legacy-location')).toBeNull();
    expect(await getVisitCompletionDraft('visit-1', 'tech-a')).toEqual(draft);
    expect(await getVisitCompletionDraft('visit-1', 'tech-b')).toBeNull();
    await deleteVisitCompletionDraft('visit-1', 'tech-a');
    expect(await getVisitCompletionDraft('visit-1', 'tech-a')).toBeNull();
  });

  it("orders draft writes and deletion while leaving a committed retry body intact", async () => {
    await putCompletionResumeBody('svc-1', committedBody());
    const first = putCompletionDraft('svc-1', { servicePhotos: [photo(1)] });
    const second = putCompletionDraft('svc-1', { servicePhotos: [photo(2)] });
    expect(await getCompletionDraft('svc-1')).toEqual({ servicePhotos: [photo(2)] });
    const removed = deleteCompletionDraft('svc-1');
    await Promise.all([first, second, removed]);
    expect(await getCompletionDraft('svc-1')).toBeNull();
    expect(await getCompletionResumeBody('svc-1')).toEqual(committedBody());
  });

  it("never prunes an unsubmitted photo draft as an unmarked retry body", async () => {
    await putCompletionDraft('svc-1', { servicePhotos: [photo(1)] });
    expect(await pruneCompletionResumeBodies(() => false, Date.now() + PRUNE_GRACE_MS + 1)).toBe(0);
    expect(await getCompletionDraft('svc-1')).toEqual({ servicePhotos: [photo(1)] });
  });
  it("keeps each admin's draft for the same visit apart and never hands one to another scope", async () => {
    await putCompletionDraft('svc-1', { servicePhotos: [photo(1)], notes: 'tech A' }, 'tech-a');
    expect(await getCompletionDraft('svc-1', 'tech-b')).toBeNull();
    expect(await getCompletionDraft('svc-1')).toBeNull();
    await putCompletionDraft('svc-1', { servicePhotos: [photo(2)], notes: 'tech B' }, 'tech-b');
    expect(await getCompletionDraft('svc-1', 'tech-a')).toMatchObject({ notes: 'tech A' });
    expect(await deleteCompletionDraft('svc-1', 'tech-b')).toBe(true);
    expect(await getCompletionDraft('svc-1', 'tech-b')).toBeNull();
    expect(await getCompletionDraft('svc-1', 'tech-a')).toMatchObject({ notes: 'tech A' });
  });

  it("prunes drafts past the retention window across scopes, reports them, and keeps live ones", async () => {
    const stale = Date.now() - DRAFT_RETENTION_MS - 1000;
    await putCompletionDraft('svc-old', { servicePhotos: [photo(1)] }, 'tech-a', stale);
    await putCompletionDraft('svc-old', { servicePhotos: [photo(2)] }, 'tech-b', stale);
    await putCompletionDraft('svc-live', { servicePhotos: [photo(3)] }, 'tech-a');
    const pruned = await pruneCompletionDrafts();
    expect(pruned.sort((a, b) => a.scope.localeCompare(b.scope))).toEqual([
      { serviceId: 'svc-old', scope: 'tech-a' }, { serviceId: 'svc-old', scope: 'tech-b' },
    ]);
    expect(await getCompletionDraft('svc-old', 'tech-a')).toBeNull();
    expect(await getCompletionDraft('svc-live', 'tech-a')).toEqual({ servicePhotos: [photo(3)] });
    expect(await pruneCompletionDrafts()).toEqual([]);
  });

  it("prune re-reads a draft behind its in-flight refresh instead of deleting the refreshed row", async () => {
    await putCompletionDraft('svc-1', { servicePhotos: [photo(1)] }, 'tech-a', Date.now() - DRAFT_RETENTION_MS - 1000);
    const refresh = putCompletionDraft('svc-1', { servicePhotos: [photo(1)], notes: 'reopened' }, 'tech-a');
    const pruned = pruneCompletionDrafts();
    await refresh;
    expect(await pruned).toEqual([]);
    expect(await getCompletionDraft('svc-1', 'tech-a')).toMatchObject({ notes: 'reopened' });
  });

  it("round-trips a photo-bearing body byte-for-byte", async () => {
    const body = committedBody();
    expect(await putCompletionResumeBody("svc-1", body)).toBe(true);
    const restored = await getCompletionResumeBody("svc-1");
    expect(restored).toEqual(body);
    expect(restored.completionPhotos[1].data).toBe(body.completionPhotos[1].data);
  });

  it("is keyed per service and deletes only its own row", async () => {
    await putCompletionResumeBody("svc-1", committedBody());
    await putCompletionResumeBody("svc-2", { ...committedBody(), idempotencyKey: "complete_svc-2_x" });
    expect(await deleteCompletionResumeBody("svc-1")).toBe(true);
    expect(await getCompletionResumeBody("svc-1")).toBeNull();
    expect((await getCompletionResumeBody("svc-2")).idempotencyKey).toBe("complete_svc-2_x");
  });

  it("resolves null / false instead of throwing when IndexedDB is unavailable", async () => {
    globalThis.indexedDB = undefined;
    expect(await putCompletionResumeBody("svc-1", committedBody())).toBe(false);
    expect(await getCompletionResumeBody("svc-1")).toBeNull();
    expect(await deleteCompletionResumeBody("svc-1")).toBe(false);
  });

  it("rejects nothing-bodies without touching storage", async () => {
    expect(await putCompletionResumeBody("svc-1", null)).toBe(false);
    expect(await putCompletionResumeBody("", committedBody())).toBe(false);
    expect(await getCompletionResumeBody("svc-1")).toBeNull();
  });
});

describe("persistCompletionResumeOwed / restore / clear (marker + body)", () => {
  // clear's body delete is fire-and-forget; settle it before asserting.
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("stores the exact body, then sets the durable marker", async () => {
    const body = committedBody();
    const pending = persistCompletionResumeOwed("svc-1", body);
    // The marker must never be visible ahead of the body it promises: a
    // reload between the two would land on the mismatch path.
    expect(completionResumeOwed("svc-1")).toBe(false);
    await pending;
    expect(completionResumeOwed("svc-1")).toBe(true);
    expect(await restoreCompletionResumeBody("svc-1")).toEqual(body);
  });

  it("still sets the marker when the body cannot be stored (today's behavior)", async () => {
    globalThis.indexedDB = undefined;
    await persistCompletionResumeOwed("svc-1", committedBody());
    expect(completionResumeOwed("svc-1")).toBe(true);
    expect(await restoreCompletionResumeBody("svc-1")).toBeNull();
  });

  it("restores nothing when the marker is absent, even if a body row exists", async () => {
    await putCompletionResumeBody("svc-1", committedBody());
    expect(completionResumeOwed("svc-1")).toBe(false);
    expect(await restoreCompletionResumeBody("svc-1")).toBeNull();
  });

  it("prune deletes aged bodies whose marker is gone and keeps owed ones", async () => {
    const past = Date.now() - PRUNE_GRACE_MS - 1000;
    await putCompletionResumeBody("svc-owed", committedBody(), past);
    localStorage.setItem("waves_completion_resume_owed_svc-owed", "1");
    await putCompletionResumeBody("svc-orphan", committedBody(), past);
    expect(await pruneCompletionResumeBodies(completionResumeOwed)).toBe(1);
    expect(await getCompletionResumeBody("svc-orphan")).toBeNull();
    expect(await getCompletionResumeBody("svc-owed")).not.toBeNull();
    expect(await pruneCompletionResumeBodies(() => false)).toBe(1);
  });

  it("prune leaves a freshly written body alone — its marker may still be in flight in another tab", async () => {
    await putCompletionResumeBody("svc-fresh", committedBody());
    expect(await pruneCompletionResumeBodies(() => false)).toBe(0);
    expect(await getCompletionResumeBody("svc-fresh")).not.toBeNull();
    // Past the grace window the same un-owed row is an orphan.
    expect(await pruneCompletionResumeBodies(() => false, Date.now() + PRUNE_GRACE_MS + 1)).toBe(1);
  });

  it("clear removes both the marker and the body", async () => {
    await persistCompletionResumeOwed("svc-1", committedBody());
    clearCompletionResumeOwed("svc-1");
    await settle();
    expect(completionResumeOwed("svc-1")).toBe(false);
    expect(await getCompletionResumeBody("svc-1")).toBeNull();
  });
});

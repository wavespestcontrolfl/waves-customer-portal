// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  pruneRecapClipDrafts,
  putRecapClipDraft,
  getRecapClipDraft,
  DRAFT_RETENTION_MS,
  deleteFastCompletionAttempt,
  getFastCompletionAttempt,
  listFastCompletionAttempts,
  pruneFastCompletionAttempts,
  putFastCompletionAttempt,
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

const FAST_DB = "waves-fast-completion-attempts";
const FAST_STORE = "bodies";
const fastKey = (serviceId, operatorId) => `fast-complete:${operatorId}:${serviceId}`;

function openSecondConnection() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FAST_DB, 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function rawPut(connection, key, record) {
  return new Promise((resolve, reject) => {
    const tx = connection.transaction(FAST_STORE, "readwrite");
    tx.objectStore(FAST_STORE).put(record, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const fastRecord = (serviceId, operatorId, body, summary, storedAt = Date.now()) => ({
  version: 1,
  operatorId,
  serviceId,
  body,
  summary,
  storedAt,
});

beforeEach(() => {
  // Fresh database AND fresh marker per test.
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

describe("completion resume store (IndexedDB)", () => {
  it("keeps Fast Complete attempts exact and private to operator plus service", async () => {
    const attempt = {
      body: committedBody(),
      summary: "Taurus SC · Ants",
    };
    expect(await putFastCompletionAttempt("svc-1", "tech-a", attempt)).toBe(true);
    expect(await getFastCompletionAttempt("svc-1", "tech-a")).toEqual({
      available: true,
      attempt: expect.objectContaining({
        version: 1,
        operatorId: "tech-a",
        serviceId: "svc-1",
        body: attempt.body,
        summary: attempt.summary,
      }),
    });
    expect(await getFastCompletionAttempt("svc-1", "tech-b")).toEqual({ available: true, attempt: null });
    expect(await getFastCompletionAttempt("svc-2", "tech-a")).toEqual({ available: true, attempt: null });
    expect(await deleteFastCompletionAttempt("svc-1", "tech-a", attempt.body)).toBe(true);
    expect((await getFastCompletionAttempt("svc-1", "tech-a")).attempt).toBeNull();
  });

  it("survives the legacy unmarked-body pruner in an older open tab", async () => {
    const past = Date.now() - PRUNE_GRACE_MS - 1000;
    const attempt = { body: committedBody(), summary: "saved retry" };
    await putFastCompletionAttempt("svc-1", "tech-a", attempt, past);
    // The legacy pruner is deliberately key-agnostic, exactly as in the
    // previous release. Prove it deletes even a prefixed legacy row.
    await putCompletionResumeBody(fastKey("svc-legacy", "tech-a"), attempt.body, past);
    expect(await pruneCompletionResumeBodies(() => false)).toBe(1);
    expect(await getCompletionResumeBody(fastKey("svc-legacy", "tech-a"))).toBeNull();
    expect((await getFastCompletionAttempt("svc-1", "tech-a")).attempt).toMatchObject(attempt);
  });

  it("discovers only the current operator's attempts without needing today's route IDs", async () => {
    await putFastCompletionAttempt("prior-day", "tech-a", { body: committedBody(), summary: "Earlier visit" });
    await putFastCompletionAttempt("moved-visit", "tech-a", { body: committedBody(), summary: "Moved visit" });
    await putFastCompletionAttempt("private-visit", "tech-b", { body: committedBody(), summary: "Other operator" });
    const reads = ["get", "getAll", "openCursor"].map((method) => vi.spyOn(IDBObjectStore.prototype, method));
    const result = await listFastCompletionAttempts("tech-a");
    for (const read of reads) { expect(read).not.toHaveBeenCalled(); read.mockRestore(); }
    expect(result.available).toBe(true);
    expect(result.attempts.map((row) => row.serviceId).sort()).toEqual(["moved-visit", "prior-day"]);
    expect(result.attempts.every((row) => row.operatorId === "tech-a")).toBe(true);
    expect(result.attempts.every((row) => !("body" in row))).toBe(true);
    expect(await listFastCompletionAttempts("tech-c")).toEqual({ available: true, attempts: [] });
    globalThis.indexedDB = undefined;
    expect(await listFastCompletionAttempts("tech-a")).toEqual({ available: false, attempts: [] });
  });

  it("uses the idempotency key as a cross-tab compare-and-set fence", async () => {
    const first = { ...committedBody(), idempotencyKey: "attempt-a" };
    const newer = { ...committedBody(), idempotencyKey: "attempt-b", technicianNotes: "New tab" };
    await putFastCompletionAttempt("svc-1", "tech-a", { body: first, summary: "Attempt A" });
    const secondConnection = await openSecondConnection();
    await rawPut(secondConnection, fastKey("svc-1", "tech-a"), fastRecord("svc-1", "tech-a", newer, "Attempt B"));

    expect(await putFastCompletionAttempt("svc-1", "tech-a", {
      body: { ...first, reportRulesConfirmed: true }, summary: "Late A",
    })).toBe(false);
    expect(await deleteFastCompletionAttempt("svc-1", "tech-a", first)).toBe(false);
    expect((await getFastCompletionAttempt("svc-1", "tech-a")).attempt).toMatchObject({
      body: newer,
      summary: "Attempt B",
    });
    expect(await deleteFastCompletionAttempt("svc-1", "tech-a", newer)).toBe(true);
    secondConnection.close();
  });

  it("fences confirmation updates and stale deletes even under the same request key", async () => {
    const original = committedBody();
    const confirmed = { ...original, reportRulesConfirmed: true };
    await putFastCompletionAttempt("svc-1", "tech-a", { body: original, summary: "Original" });
    expect(await putFastCompletionAttempt("svc-1", "tech-a", {
      body: confirmed, expectedBody: original, summary: "Confirmed",
    })).toBe(true);
    expect(await putFastCompletionAttempt("svc-1", "tech-a", {
      body: original, expectedBody: original, summary: "Stale tab",
    })).toBe(false);
    expect(await deleteFastCompletionAttempt("svc-1", "tech-a", original)).toBe(false);
    expect((await getFastCompletionAttempt("svc-1", "tech-a")).attempt.body).toEqual(confirmed);
    expect(await deleteFastCompletionAttempt("svc-1", "tech-a", confirmed)).toBe(true);
    expect(await putFastCompletionAttempt("svc-1", "tech-a", {
      body: confirmed, expectedBody: confirmed, summary: "Discarded tab",
    })).toBe(false);
  });

  it("lists lightweight metadata after upgrading existing Fast Complete rows", async () => {
    const db = await new Promise((resolve) => {
      const open = indexedDB.open(FAST_DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(FAST_STORE);
      open.onsuccess = () => resolve(open.result);
    });
    await rawPut(db, fastKey("old-visit", "tech-a"), fastRecord("old-visit", "tech-a", committedBody(), "Existing visit"));
    db.close();
    const result = await listFastCompletionAttempts("tech-a");
    expect(result).toEqual({ available: true, attempts: [{
      operatorId: "tech-a", serviceId: "old-visit", storedAt: expect.any(Number), summary: "Existing visit",
    }] });
    expect((await getFastCompletionAttempt("old-visit", "tech-a")).attempt.body).toEqual(committedBody());
  });

  it("prunes only Fast Complete attempts past the 14-day retention window", async () => {
    const old = Date.now() - DRAFT_RETENTION_MS - 1000;
    await putFastCompletionAttempt("svc-old", "tech-a", { body: committedBody(), summary: "old" }, old);
    await putFastCompletionAttempt("svc-live", "tech-a", { body: committedBody(), summary: "live" });
    await putCompletionResumeBody("regular-completion", committedBody(), old);

    expect(await pruneFastCompletionAttempts()).toBe(1);
    expect((await getFastCompletionAttempt("svc-old", "tech-a")).attempt).toBeNull();
    expect((await getFastCompletionAttempt("svc-live", "tech-a")).attempt).not.toBeNull();
    expect(await getCompletionResumeBody("regular-completion")).toEqual(committedBody());
  });

  it("a sweep scoped to one operator never touches another operator's attempts (pre-push P0 on 1dc0f16fb9)", async () => {
    const eightDays = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    await putFastCompletionAttempt("svc-tech-old", "tech-a", { body: committedBody(), summary: "tech old" }, eightDays);
    await putFastCompletionAttempt("svc-tech-new", "tech-a", { body: committedBody(), summary: "tech new" });
    await putFastCompletionAttempt("svc-owner-old", "owner-b", { body: committedBody(), summary: "owner old" }, eightDays);

    expect(await pruneFastCompletionAttempts(Date.now(), sevenDays, { operatorId: "tech-a" })).toBe(1);
    expect((await getFastCompletionAttempt("svc-tech-old", "tech-a")).attempt).toBeNull();
    expect((await getFastCompletionAttempt("svc-tech-new", "tech-a")).attempt).not.toBeNull();
    expect((await getFastCompletionAttempt("svc-owner-old", "owner-b")).attempt).not.toBeNull();
  });

  it("a sweep by the server's access cutoff never deletes a retry the server would still take (pre-push P0 on f405ea3185)", async () => {
    const at = (iso) => new Date(iso).getTime();
    const dated = (scheduledDate) => ({ ...committedBody(), expectedVisit: { customerId: "cust-1", scheduledDate } });
    // Visit and save both before the cutoff: past it.
    await putFastCompletionAttempt("svc-past", "tech-a", { body: dated("2026-09-24"), summary: "past" }, at("2026-09-24T15:00:00Z"));
    // On the cutoff day, which the server still allows (>=): kept.
    await putFastCompletionAttempt("svc-edge", "tech-a", { body: dated("2026-09-26"), summary: "edge" }, at("2026-09-26T15:00:00Z"));
    // Saved after the cutoff for an earlier visit: the later day keeps it.
    await putFastCompletionAttempt("svc-later", "tech-a", { body: dated("2026-09-20"), summary: "later" }, at("2026-09-28T15:00:00Z"));
    // No visit date: left to the age sweep.
    await putFastCompletionAttempt("svc-undated", "tech-a", { body: committedBody(), summary: "undated" }, at("2026-09-20T15:00:00Z"));
    // Another operator's: never touched.
    await putFastCompletionAttempt("svc-owner", "owner-b", { body: dated("2026-09-20"), summary: "owner" }, at("2026-09-20T15:00:00Z"));

    expect(await pruneFastCompletionAttempts(Date.now(), undefined, { operatorId: "tech-a", scheduledCutoff: "2026-09-26" })).toBe(1);
    expect((await getFastCompletionAttempt("svc-past", "tech-a")).attempt).toBeNull();
    for (const [serviceId, operatorId] of [["svc-edge", "tech-a"], ["svc-later", "tech-a"], ["svc-undated", "tech-a"], ["svc-owner", "owner-b"]]) {
      expect((await getFastCompletionAttempt(serviceId, operatorId)).attempt).not.toBeNull();
    }
  });

  it("atomically rechecks age so a second connection's refresh survives prune", async () => {
    const old = Date.now() - DRAFT_RETENTION_MS - 1000;
    const body = { ...committedBody(), idempotencyKey: "refresh-key" };
    await putFastCompletionAttempt("svc-race", "tech-a", { body, summary: "stale" }, old);
    const secondConnection = await openSecondConnection();
    const target = fastKey("svc-race", "tech-a");
    const storePrototype = Object.getPrototypeOf(secondConnection.transaction(FAST_STORE, "readonly").objectStore(FAST_STORE));
    const originalGet = storePrototype.get;
    let refresh = null;
    const getSpy = vi.spyOn(storePrototype, "get").mockImplementation(function get(key) {
      const request = originalGet.call(this, key);
      if (String(key) === target && !refresh) {
        request.addEventListener("success", () => {
          refresh = rawPut(secondConnection, target, fastRecord("svc-race", "tech-a", body, "refreshed"));
        }, { once: true });
      }
      return request;
    });

    expect(await pruneFastCompletionAttempts()).toBe(1);
    await refresh;
    getSpy.mockRestore();
    expect((await getFastCompletionAttempt("svc-race", "tech-a")).attempt).toMatchObject({
      summary: "refreshed",
      body,
    });
    secondConnection.close();
  });

  it("reports unavailable Fast Complete storage separately from an empty scope", async () => {
    globalThis.indexedDB = undefined;
    expect(await getFastCompletionAttempt("svc-1", "tech-a")).toEqual({ available: false, attempt: null });
    expect(await putFastCompletionAttempt("svc-1", "tech-a", { body: committedBody(), summary: "visit" })).toBe(false);
    expect(await deleteFastCompletionAttempt("svc-1", "tech-a", committedBody())).toBe(false);
  });

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

describe("recap clip drafts", () => {
  it("the recap sweep removes only aged recap clips, never other drafts", async () => {
    const old = Date.now() - DRAFT_RETENTION_MS - 1000;
    await putRecapClipDraft("svc-1", { draft: { role: "perimeter" } }, "tech-1", old);
    await putRecapClipDraft("svc-2", { draft: { role: "eaves" } }, "tech-1");
    await putCompletionDraft("svc-1", { notes: "aged completion draft" }, "tech-1", old);

    const pruned = await pruneRecapClipDrafts();

    expect(pruned).toEqual([{ serviceId: "svc-1", scope: "recap:tech-1" }]);
    expect(await getRecapClipDraft("svc-1", "tech-1")).toBeNull();
    expect(await getRecapClipDraft("svc-2", "tech-1")).not.toBeNull();
    expect(await getCompletionDraft("svc-1", "tech-1")).toEqual({ notes: "aged completion draft" });
  });
});

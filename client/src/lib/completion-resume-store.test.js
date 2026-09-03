// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import {
  deleteCompletionResumeBody,
  getCompletionResumeBody,
  putCompletionResumeBody,
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
  // The body write is fire-and-forget; settle it before asserting.
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("sets the durable marker and stores the exact body beside it", async () => {
    const body = committedBody();
    persistCompletionResumeOwed("svc-1", body);
    expect(completionResumeOwed("svc-1")).toBe(true);
    await settle();
    expect(await restoreCompletionResumeBody("svc-1")).toEqual(body);
  });

  it("keeps the marker when the body cannot be stored (today's behavior)", async () => {
    globalThis.indexedDB = undefined;
    persistCompletionResumeOwed("svc-1", committedBody());
    expect(completionResumeOwed("svc-1")).toBe(true);
    expect(await restoreCompletionResumeBody("svc-1")).toBeNull();
  });

  it("restores nothing when the marker is absent, even if a body row exists", async () => {
    await putCompletionResumeBody("svc-1", committedBody());
    expect(completionResumeOwed("svc-1")).toBe(false);
    expect(await restoreCompletionResumeBody("svc-1")).toBeNull();
  });

  it("clear removes both the marker and the body", async () => {
    persistCompletionResumeOwed("svc-1", committedBody());
    await settle();
    clearCompletionResumeOwed("svc-1");
    await settle();
    expect(completionResumeOwed("svc-1")).toBe(false);
    expect(await getCompletionResumeBody("svc-1")).toBeNull();
  });
});

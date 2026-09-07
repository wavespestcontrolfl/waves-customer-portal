// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => { sessionStorage.clear(); vi.resetModules(); });
afterEach(async () => {
  (await import("./emailDrafts")).clearEmailDrafts();
  vi.restoreAllMocks();
});

describe("local email editor recovery", () => {
  it("persists the send before submission and restores an interrupted send as unknown", async () => {
    let store = await import("./emailDrafts");
    const session = store.loadEmailDrafts("fixture-owner");
    const attempt = { id: "fixture-attempt", status: "running", snapshot: { to: "a@example.invalid", subject: "Fixture", body: "Hello" } };
    expect(store.updateEmailSendAttempt(session, "compose", attempt)).toBe(true);
    expect(store.updateEmailSendAttempt(session, "compose", { ...attempt, id: "duplicate" })).toBe(false);
    vi.resetModules(); store = await import("./emailDrafts");
    expect(store.loadEmailDrafts("fixture-owner").attempts.compose).toMatchObject({ id: attempt.id, status: "outcome_unknown" });
    expect(store.loadEmailDrafts("another-owner").attempts).toEqual({});
  });

  it("preserves an uncertain guard when draft edits, outcome writes or reconciliation exceed storage quota", async () => {
    let store = await import("./emailDrafts");
    const session = store.loadEmailDrafts("fixture-owner");
    const attempt = { id: "fixture-attempt", status: "running", snapshot: "Reply", replyId: "a" };
    store.updateEmailSendAttempt(session, "reply:a", attempt);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Quota"); });
    store.updateEmailDrafts(session, drafts => ({ ...drafts, replies: { a: "Edited" } }));
    expect(store.updateEmailSendAttempt(session, "reply:a", { ...attempt, status: "outcome_unknown" }, attempt.id)).toBe(false);
    expect(store.updateEmailSendAttempt(session, "reply:a", null, attempt.id)).toBe(false);
    const persisted = sessionStorage.getItem("waves_admin_email_drafts_v1");
    // A real reload also removes the old module's unload listener.
    store.clearEmailDrafts(); vi.restoreAllMocks();
    sessionStorage.setItem("waves_admin_email_drafts_v1", persisted);
    vi.resetModules(); store = await import("./emailDrafts");
    expect(store.loadEmailDrafts("fixture-owner").attempts["reply:a"]).toMatchObject({ id: attempt.id, status: "outcome_unknown" });
  });

  it("refuses to begin a send when its guard cannot be saved", async () => {
    const store = await import("./emailDrafts");
    const session = store.loadEmailDrafts("fixture-owner");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Quota"); });
    expect(store.updateEmailSendAttempt(session, "compose", { id: "attempt", status: "running", snapshot: {} })).toBe(false);
    expect(session.attempts).toEqual({});
  });

  it("recovers typed drafts after a module reload and isolates another verified account", async () => {
    let store = await import("./emailDrafts");
    const session = store.loadEmailDrafts("fixture-owner-a");
    store.updateEmailDrafts(session, () => ({ compose: { to: "recipient@example.invalid", subject: "Fixture", body: "Unsent text" }, replies: { "fixture-message": "Unsent reply" } }));
    vi.resetModules();
    store = await import("./emailDrafts");
    expect(store.loadEmailDrafts("fixture-owner-a").drafts.replies["fixture-message"]).toBe("Unsent reply");
    expect(store.loadEmailDrafts("fixture-owner-b").drafts.compose.body).toBe("");
    expect(store.loadEmailDrafts("fixture-owner-b").drafts.replies).toEqual({});
  });

  it("keeps navigation recoverable when storage fails and remembers that reload is unsafe", async () => {
    const store = await import("./emailDrafts");
    const session = store.loadEmailDrafts("fixture-owner");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Synthetic quota failure"); });
    expect(store.updateEmailDrafts(session, (d) => ({ ...d, replies: { a: "Keep this" } })).saved).toBe(false);
    expect(store.loadEmailDrafts("fixture-owner")).toMatchObject({ saved: false, drafts: { replies: { a: "Keep this" } } });
  });

  it("does not recover an old draft when storing its removal fails", async () => {
    let store = await import("./emailDrafts");
    const session = store.loadEmailDrafts("fixture-owner");
    store.updateEmailDrafts(session, (d) => ({ ...d, replies: { a: "Already sent or discarded" } }));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Synthetic quota failure"); });
    store.updateEmailDrafts(session, (d) => ({ ...d, replies: {} }));
    vi.resetModules(); store = await import("./emailDrafts");
    expect(store.loadEmailDrafts("fixture-owner").drafts.replies).toEqual({});
  });

  it("sign-out invalidates outstanding callbacks so they cannot resurrect discarded session data", async () => {
    const store = await import("./emailDrafts");
    const oldSession = store.loadEmailDrafts("fixture-owner");
    expect(store.setEmailSending(oldSession, "compose", true)).toBe(true);
    store.clearEmailDrafts();
    const current = store.loadEmailDrafts("fixture-owner");
    expect(store.updateEmailDrafts(oldSession, (d) => ({ ...d, replies: { a: "Late AI answer" } }))).toBeNull();
    expect(store.setEmailSending(oldSession, "compose", false)).toBe(false);
    expect(current.sending.compose).toBe(false);
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving); expect(leaving.defaultPrevented).toBe(false);
    expect(current.drafts.replies).toEqual({});
  });
});

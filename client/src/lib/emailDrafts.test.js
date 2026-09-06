// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => { sessionStorage.clear(); vi.resetModules(); });
afterEach(() => vi.restoreAllMocks());

describe("local email editor recovery", () => {
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

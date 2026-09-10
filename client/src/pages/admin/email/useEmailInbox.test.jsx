// @vitest-environment jsdom
import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adminFetch = vi.fn();
vi.mock("./emailApi", () => ({ adminFetch: (...args) => adminFetch(...args) }));

import useEmailInbox from "./useEmailInbox";

const json = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

function inboxCalls() {
  return adminFetch.mock.calls
    .map(([path]) => path)
    .filter((path) => path.startsWith("/api/admin/email/inbox"));
}

describe("useEmailInbox search (F0579)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    adminFetch.mockImplementation((path) => {
      if (path.startsWith("/api/admin/email/oauth/status")) return json({ connected: true });
      if (path.startsWith("/api/admin/email/inbox")) return json({ emails: [], total: 0 });
      return json({});
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    adminFetch.mockReset();
  });

  it("sends one inbox request after the typing pause, not one per keystroke", async () => {
    const wrapper = ({ children }) => <MemoryRouter initialEntries={["/admin/communications"]}>{children}</MemoryRouter>;
    const { result } = renderHook(() => useEmailInbox(true, () => {}), { wrapper });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // Searching from page 2: the page reset must ride the same commit as
    // the query, or the list asks for page 1 of the OLD query first.
    act(() => { result.current.setPage(2); });
    await act(async () => { await Promise.resolve(); });
    const before = inboxCalls().length;
    expect(before).toBeGreaterThan(0);
    expect(inboxCalls()[before - 1]).toContain("page=2");

    act(() => { result.current.setSearch("p"); });
    act(() => { result.current.setSearch("pr"); });
    act(() => { result.current.setSearch("price"); });
    await act(async () => { vi.advanceTimersByTime(299); });
    expect(inboxCalls().length).toBe(before);

    await act(async () => { vi.advanceTimersByTime(1); });
    const after = inboxCalls();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]).toContain("search=price");
    expect(after[after.length - 1]).toContain("page=1");
  });
});

describe("useEmailInbox reclassify and attachment feedback", () => {
  const wrapper = ({ children }) => <MemoryRouter initialEntries={["/admin/communications"]}>{children}</MemoryRouter>;
  const row = { id: "m1", classification: "quarantined", is_read: true };
  const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
  let handlers;
  beforeEach(() => {
    handlers = {};
    adminFetch.mockImplementation((path, options) => {
      if (path.startsWith("/api/admin/email/oauth/status")) return json({ connected: true });
      if (path.startsWith("/api/admin/email/inbox")) return json({ emails: [row], total: 1 });
      const custom = Object.keys(handlers).find((prefix) => path.startsWith(prefix));
      if (custom) return handlers[custom](path, options);
      return json({});
    });
  });
  afterEach(() => { cleanup(); adminFetch.mockReset(); });

  it("surfaces the server's reclassify error and re-reads the row after a partial success", async () => {
    const serverError = "Reclassified, but the follow-up action failed — quarantine kept; run reclassify again to retry it";
    handlers["/api/admin/email/message/m1/reclassify"] = () => Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({ error: serverError }) });
    handlers["/api/admin/email/message/m1"] = () => json({ ...row, classification: "quote_request" });
    const { result } = renderHook(() => useEmailInbox(true, () => {}), { wrapper });
    await flush();
    await act(async () => { await result.current.handleReclassify("m1"); });
    expect(result.current.actionFeedback).toEqual({ error: true, message: serverError });
    expect(adminFetch.mock.calls.some(([path]) => path === "/api/admin/email/message/m1")).toBe(true);
    expect(result.current.visibleEmails.find((email) => email.id === "m1").classification).toBe("quote_request");
  });

  it("falls back to the generic reclassify message when the failure carries no payload", async () => {
    handlers["/api/admin/email/message/m1/reclassify"] = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.reject(new Error("no body")) });
    const { result } = renderHook(() => useEmailInbox(true, () => {}), { wrapper });
    await flush();
    await act(async () => { await result.current.handleReclassify("m1"); });
    expect(result.current.actionFeedback).toEqual({ error: true, message: "Could not reclassify the email. Try again." });
  });

  it("drops the error from a superseded attachment download", async () => {
    const createObjectURL = vi.fn(() => "blob:one");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    let rejectFirst;
    let first = true;
    handlers["/api/admin/email/message/m1/attachment/"] = () => {
      if (first) { first = false; return new Promise((_, reject) => { rejectFirst = reject; }); }
      return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(new Blob(["x"])) });
    };
    const { result } = renderHook(() => useEmailInbox(true, () => {}), { wrapper });
    await flush();
    const event = { preventDefault: () => {} };
    const att = { gmail_attachment_id: "a1", filename: "receipt.pdf" };
    let pending;
    act(() => { pending = result.current.handleDownloadAttachment(event, row, att); });
    await act(async () => { await result.current.handleDownloadAttachment(event, row, att); });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    await act(async () => { rejectFirst(new Error("network")); await pending; });
    expect(result.current.actionFeedback).toBeNull();
  });

  it("still reports the error when the latest attachment download fails", async () => {
    handlers["/api/admin/email/message/m1/attachment/"] = () => Promise.reject(new Error("network"));
    const { result } = renderHook(() => useEmailInbox(true, () => {}), { wrapper });
    await flush();
    await act(async () => { await result.current.handleDownloadAttachment({ preventDefault: () => {} }, row, { gmail_attachment_id: "a1" }); });
    expect(result.current.actionFeedback).toEqual({ error: true, message: "Could not download the attachment. Try again.", source: "attachment" });
  });
});

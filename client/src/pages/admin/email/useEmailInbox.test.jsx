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
    const before = inboxCalls().length;
    expect(before).toBeGreaterThan(0);

    act(() => { result.current.setSearch("p"); });
    act(() => { result.current.setSearch("pr"); });
    act(() => { result.current.setSearch("price"); });
    await act(async () => { vi.advanceTimersByTime(299); });
    expect(inboxCalls().length).toBe(before);

    await act(async () => { vi.advanceTimersByTime(1); });
    const after = inboxCalls();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]).toContain("search=price");
  });
});

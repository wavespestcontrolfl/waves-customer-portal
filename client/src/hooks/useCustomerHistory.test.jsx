// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminFetch } from "../utils/admin-fetch";
import useCustomerHistory from "./useCustomerHistory";

vi.mock("../utils/admin-fetch", () => ({ adminFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const params = { customerId: "synthetic-a", kind: "comms", enabled: true, query: "channel=all" };

describe("customer history pagination", () => {
  it("appends older messages once and preserves the first page read boundary", async () => {
    const readScope = { conversationIds: ["conversation-a"], readBefore: "2024-01-01T00:00:00.000Z" };
    const older = deferred();
    adminFetch.mockResolvedValueOnce({ comms: [{ id: "newer" }], hasMore: true, nextCursor: "older", readScope })
      .mockReturnValueOnce(older.promise);
    const { result } = renderHook(() => useCustomerHistory(params));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => { result.current.loadOlder(); result.current.loadOlder(); });
    expect(adminFetch).toHaveBeenCalledTimes(2);
    expect(adminFetch.mock.calls[1][0]).toContain("cursor=older");
    await act(async () => older.resolve({ comms: [{ id: "newer" }, { id: "older" }], hasMore: false, readScope: { readBefore: "changed" } }));
    expect(result.current.items.map((item) => item.id)).toEqual(["newer", "older"]);
    expect(result.current.meta.readScope).toEqual(readScope);
    expect(result.current.hasMore).toBe(false);
  });

  it("retains existing history and retries the same cursor after an older-page failure", async () => {
    adminFetch.mockResolvedValueOnce({ comms: [{ id: "newer" }], hasMore: true, nextCursor: "cursor-1" })
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValueOnce({ comms: [{ id: "older" }], hasMore: false });
    const { result } = renderHook(() => useCustomerHistory(params));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    await act(async () => result.current.loadOlder());
    expect(result.current.items).toEqual([{ id: "newer" }]);
    expect(result.current.error).toBe("Temporary failure");
    await act(async () => result.current.retry());
    expect(adminFetch.mock.calls[2][0]).toContain("cursor=cursor-1");
    expect(result.current.items).toHaveLength(2);
  });

  it("resets cursors for a channel change and ignores a late page from the old filter", async () => {
    const older = deferred();
    adminFetch.mockResolvedValueOnce({ comms: [{ id: "sms" }], hasMore: true, nextCursor: "old-cursor" })
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce({ comms: [{ id: "call" }], hasMore: false });
    const { result, rerender } = renderHook(({ query }) => useCustomerHistory({ ...params, query }), { initialProps: { query: "channel=all" } });
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => { result.current.loadOlder(); });
    rerender({ query: "channel=voice" });
    await waitFor(() => expect(result.current.items).toEqual([{ id: "call" }]));
    expect(adminFetch.mock.calls[2][0]).toContain("channel=voice");
    expect(adminFetch.mock.calls[2][0]).not.toContain("cursor=");
    await act(async () => older.resolve({ comms: [{ id: "stale" }] }));
    expect(result.current.items).toEqual([{ id: "call" }]);
  });

  it("ignores a late customer response and does not fetch for a disabled role", async () => {
    const old = deferred();
    adminFetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ timeline: [{ id: "b" }] });
    const { result, rerender } = renderHook((props) => useCustomerHistory({ ...params, kind: "timeline", ...props }),
      { initialProps: { customerId: "synthetic-a", enabled: true } });
    rerender({ customerId: "synthetic-b", enabled: true });
    await waitFor(() => expect(result.current.items).toEqual([{ id: "b" }]));
    await act(async () => old.resolve({ timeline: [{ id: "a" }] }));
    expect(result.current.items).toEqual([{ id: "b" }]);
    rerender({ customerId: "synthetic-b", enabled: false });
    expect(result.current.items).toEqual([]);
    expect(adminFetch).toHaveBeenCalledTimes(2);
  });
});

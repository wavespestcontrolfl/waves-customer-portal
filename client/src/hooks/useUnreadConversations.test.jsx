// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import useUnreadConversations, { notifyUnreadChanged } from "./useUnreadConversations";
import { adminFetch } from "../utils/admin-fetch";
vi.mock("../utils/admin-fetch", () => ({ adminFetch: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(cleanup);
it("counts conversations for the global badge", async () => {
  adminFetch.mockResolvedValue({ conversations: 2, messages: 9 });
  const { result } = renderHook(() => useUnreadConversations());
  await waitFor(() => expect(result.current).toBe(2));
  expect(adminFetch).toHaveBeenCalledWith("/admin/communications/unread-count");
});
it("scopes the profile badge and refreshes after an acknowledged read", async () => {
  adminFetch.mockResolvedValueOnce({ conversations: 2 }).mockResolvedValue({ conversations: 0 });
  const { result } = renderHook(() => useUnreadConversations(true, "customer-a"));
  await waitFor(() => expect(result.current).toBe(2));
  expect(adminFetch).toHaveBeenCalledWith("/admin/communications/unread-count?customerId=customer-a");
  act(notifyUnreadChanged);
  await waitFor(() => expect(result.current).toBe(0));
});
it("retains the last confirmed count if refresh fails", async () => {
  adminFetch.mockResolvedValueOnce({ conversations: 3 }).mockRejectedValue(new Error("Unavailable"));
  const { result } = renderHook(() => useUnreadConversations(true, "customer-a"));
  await waitFor(() => expect(result.current).toBe(3));
  act(notifyUnreadChanged);
  await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(2));
  expect(result.current).toBe(3);
});
it("does not read admin counts when disabled", () => {
  const { result } = renderHook(() => useUnreadConversations(false, "customer-a"));
  expect(result.current).toBe(0);
  expect(adminFetch).not.toHaveBeenCalled();
});

it("ignores a previous customer's response after switching customers", async () => {
  let resolvePrevious;
  adminFetch.mockImplementationOnce(() => new Promise(resolve => { resolvePrevious = resolve; }))
    .mockResolvedValue({ conversations: 1 });
  const { result, rerender } = renderHook(({ id }) => useUnreadConversations(true, id), { initialProps: { id: "customer-a" } });
  rerender({ id: "customer-b" });
  await waitFor(() => expect(result.current).toBe(1));
  await act(async () => { resolvePrevious({ conversations: 5 }); });
  expect(result.current).toBe(1);
});

it("does not restore an old count when a poll finishes after the read refresh", async () => {
  let resolvePoll;
  adminFetch.mockImplementationOnce(() => new Promise(resolve => { resolvePoll = resolve; }))
    .mockResolvedValue({ conversations: 0 });
  const { result } = renderHook(() => useUnreadConversations(true, "customer-a"));
  act(notifyUnreadChanged);
  await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(2));
  await act(async () => { resolvePoll({ conversations: 3 }); });
  expect(result.current).toBe(0);
});

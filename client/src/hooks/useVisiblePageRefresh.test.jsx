// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import useVisiblePageRefresh from "./useVisiblePageRefresh";

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("refreshes visible pages on the interval, resume, focus, and reconnect", async () => {
  const refresh = vi.fn(() => Promise.resolve());
  renderHook(() => useVisiblePageRefresh(refresh));

  act(() => vi.advanceTimersByTime(30_000));
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => Promise.resolve());

  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  act(() => vi.advanceTimersByTime(30_000));
  expect(refresh).toHaveBeenCalledTimes(1);

  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => Promise.resolve());
  act(() => window.dispatchEvent(new Event("focus")));
  await act(async () => Promise.resolve());
  act(() => window.dispatchEvent(new Event("online")));
  expect(refresh).toHaveBeenCalledTimes(4);
});

it("does not start another refresh when intervals and lifecycle events overlap a slow refresh", async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const refresh = vi.fn(() => pending);
  renderHook(() => useVisiblePageRefresh(refresh));

  act(() => vi.advanceTimersByTime(30_000));
  expect(refresh).toHaveBeenCalledTimes(1);
  act(() => {
    vi.advanceTimersByTime(60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
  });
  expect(refresh).toHaveBeenCalledTimes(1);

  await act(async () => resolve());
  act(() => window.dispatchEvent(new Event("focus")));
  expect(refresh).toHaveBeenCalledTimes(2);
});

it("removes lifecycle listeners and polling on unmount", () => {
  const refresh = vi.fn();
  const view = renderHook(() => useVisiblePageRefresh(refresh));
  view.unmount();

  act(() => {
    vi.advanceTimersByTime(30_000);
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
  });
  expect(refresh).not.toHaveBeenCalled();
});

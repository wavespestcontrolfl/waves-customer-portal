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

it("does not overlap slow requests or run while offline or editing", async () => {
  let finish;
  const refresh = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
  renderHook(() => useVisiblePageRefresh(refresh, { intervalMs: 60000 }));
  await act(async () => vi.advanceTimersByTime(60000));
  act(() => {
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(60000);
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  const input = document.createElement("textarea");
  document.body.append(input);
  input.focus();
  await act(async () => vi.advanceTimersByTime(60000));
  expect(refresh).toHaveBeenCalledTimes(1);
  input.remove();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  act(() => window.dispatchEvent(new Event("focus")));
  expect(refresh).toHaveBeenCalledTimes(1);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  act(() => window.dispatchEvent(new Event("online")));
  expect(refresh).toHaveBeenCalledTimes(2);
  await act(async () => finish());
});

it("supports resume-only reads and disables refresh while a draft is open", async () => {
  const refresh = vi.fn();
  const { rerender } = renderHook(({ enabled }) => useVisiblePageRefresh(refresh, { intervalMs: 0, enabled }), {
    initialProps: { enabled: false },
  });
  await act(async () => { window.dispatchEvent(new Event("focus")); vi.advanceTimersByTime(300000); });
  expect(refresh).not.toHaveBeenCalled();
  rerender({ enabled: true });
  await act(async () => vi.advanceTimersByTime(300000));
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("continues refreshing after a filter select retains focus", async () => {
  const refresh = vi.fn();
  const select = document.createElement("select");
  document.body.append(select);
  select.focus();
  renderHook(() => useVisiblePageRefresh(refresh));
  await act(async () => vi.advanceTimersByTime(30000));
  expect(refresh).toHaveBeenCalledTimes(1);
  select.remove();
});

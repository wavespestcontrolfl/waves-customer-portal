// @vitest-environment jsdom
/**
 * PR #4405 Codex round 4, P1 — a confirmed gate value must not outlive a
 * mid-session flip.
 *
 * A TTL on the module cache is necessary but NOT sufficient: the hook's effect
 * runs on mount (and on retry), so with no timer an already-open tab keeps
 * whatever it first resolved, which is exactly the reported failure. Two things
 * close it: the mounted hook re-probes on an interval and on tab focus, and
 * `ensureStackingFresh()` revalidates immediately before a money submission.
 *
 * A later Codex P1 (an older head, useDiscountStacking.js:160) went further:
 * ensureStackingFresh must not trust an already-fresh cache either — a
 * submit-time check needs the LIVE answer, not "recently confirmed," since a
 * flip can land between the last poll and the click. The
 * "ensureStackingFresh guards the money submission itself" block below
 * proves it always re-probes, even inside the TTL window.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  useDiscountStackingState,
  ensureStackingFresh,
  __resetDiscountStackingCache,
} from './useDiscountStacking';

const TTL = 60000;

function mockGate(enabled) {
  return vi.fn(async () => ({ ok: true, json: async () => ({ enabled }) }));
}

beforeEach(() => {
  __resetDiscountStackingCache();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.setItem('waves_admin_token', 't');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __resetDiscountStackingCache();
});

describe('a mounted surface tracks a mid-session gate flip', () => {
  it('re-probes after the TTL and picks up the new value without a remount', async () => {
    const fetchMock = mockGate(true);
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useDiscountStackingState());
    await waitFor(() => expect(result.current.known).toBe(true));
    expect(result.current.enabled).toBe(true);

    // The gate is turned OFF by a deploy while this tab stays open.
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ enabled: false }) }));
    await act(async () => { vi.advanceTimersByTime(TTL + 1000); });

    // Without the interval the hook would still report enabled:true forever.
    await waitFor(() => expect(result.current.enabled).toBe(false));
    expect(result.current.known).toBe(true);
  });

  it('re-probes when the tab is focused again', async () => {
    const fetchMock = mockGate(true);
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useDiscountStackingState());
    await waitFor(() => expect(result.current.enabled).toBe(true));

    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ enabled: false }) }));
    // A focus return is only meaningful once the cached value is stale.
    await act(async () => { vi.advanceTimersByTime(TTL + 1000); });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(result.current.enabled).toBe(false));
  });
});

describe('ensureStackingFresh guards the money submission itself', () => {
  it('always re-probes past the cache, even well inside the TTL, so a submit sees a same-second flip', async () => {
    const fetchMock = mockGate(true);
    vi.stubGlobal('fetch', fetchMock);
    expect(await ensureStackingFresh()).toEqual({ enabled: true, known: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Still well inside the TTL window — a cache-trusting ensureStackingFresh
    // would skip this fetch entirely and return the stale `true`. Codex P1
    // (useDiscountStacking.js:160, an older head): submit-time gate checks
    // must never rely on the interval/visibilitychange cache, which can be
    // up to CACHE_TTL_MS behind a flip that happened between the last probe
    // and this click.
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ enabled: false }) }));
    expect(await ensureStackingFresh()).toEqual({ enabled: false, known: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('joins an already-inflight poll instead of firing a duplicate request', async () => {
    let resolveFetch;
    const fetchMock = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    // A background poll (from useDiscountStackingState's own effect) starts
    // the in-flight request first.
    const { result } = renderHook(() => useDiscountStackingState());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // A submit click's ensureStackingFresh() lands while that request is
    // still outstanding — it must await the SAME request, not fire a second.
    const submitCheck = ensureStackingFresh();
    resolveFetch({ ok: true, json: async () => ({ enabled: true }) });
    expect(await submitCheck).toEqual({ enabled: true, known: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.enabled).toBe(true));
  });

  it('reports known:false when the probe fails, so a submitter blocks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await ensureStackingFresh()).toEqual({ enabled: false, known: false });
  });

  it('backs off after a failure instead of hammering the API on repeated submit clicks', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('down'); });
    vi.stubGlobal('fetch', fetchMock);
    expect(await ensureStackingFresh()).toEqual({ enabled: false, known: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A second submit attempt moments later — still inside the backoff
    // window — must not re-hit a hard-down API.
    expect(await ensureStackingFresh()).toEqual({ enabled: false, known: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

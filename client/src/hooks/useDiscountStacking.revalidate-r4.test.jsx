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
  it('returns the NEW value when the cached one has gone stale', async () => {
    const fetchMock = mockGate(true);
    vi.stubGlobal('fetch', fetchMock);
    expect(await ensureStackingFresh()).toEqual({ enabled: true, known: true });

    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ enabled: false }) }));
    // Inside the TTL the confirmed value is still trusted — no refetch.
    expect(await ensureStackingFresh()).toEqual({ enabled: true, known: true });

    vi.advanceTimersByTime(TTL + 1000);
    // Past it, the submission path sees the real current value, so a caller
    // comparing against the value its preview used can refuse to post.
    expect(await ensureStackingFresh()).toEqual({ enabled: false, known: true });
  });

  it('reports known:false when the probe fails, so a submitter blocks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await ensureStackingFresh()).toEqual({ enabled: false, known: false });
  });
});

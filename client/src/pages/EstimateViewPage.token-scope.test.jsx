// @vitest-environment jsdom
// P1-6: the public estimate view must be token-scoped — a :token change
// remounts the page so no reservation / Stripe intent / CTA / success state
// survives an A→B navigation, and a slow /data fetch for A can't render A's
// PII under B's URL. The remount wrapper (key={token}) is what enforces this.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let currentToken = 'token-A';
vi.mock('react-router-dom', () => ({
  useParams: () => ({ token: currentToken }),
  useSearchParams: () => [new URLSearchParams(''), vi.fn()],
}));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

import EstimateViewPage from './EstimateViewPage';

function dataUrlTokens(fetchMock) {
  return fetchMock.mock.calls
    .map(([url]) => String(url))
    .map((u) => u.match(/\/estimates\/([^/]+)\/data/))
    .filter(Boolean)
    .map((m) => m[1]);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  currentToken = 'token-A';
});

describe('EstimateViewPage token scoping', () => {
  it('refetches for the new token and mounts a fresh instance when :token changes', async () => {
    // 404 short-circuits the load cleanly (the "link isn't valid" screen).
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<EstimateViewPage />);
    await waitFor(() => expect(dataUrlTokens(fetchMock)).toContain('token-A'));

    // Navigate to a different estimate token on the SAME route.
    currentToken = 'token-B';
    rerender(<EstimateViewPage />);

    // The remount re-runs the load effect for B — proving a fresh instance
    // (the stale A instance is unmounted; its state/late resolve can't surface).
    await waitFor(() => expect(dataUrlTokens(fetchMock)).toContain('token-B'));
  });

  it('aborts the in-flight fetch for the old token on a token change (no late global side effects)', async () => {
    // Token A's response never resolves during the test; capture its signal.
    const signalsByToken = {};
    const fetchMock = vi.fn((url, opts = {}) => {
      const token = String(url).match(/\/estimates\/([^/]+)\/data/)?.[1];
      signalsByToken[token] = opts.signal;
      if (token === 'token-A') return new Promise(() => {}); // pending forever
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<EstimateViewPage />);
    await waitFor(() => expect(signalsByToken['token-A']).toBeInstanceOf(AbortSignal));
    expect(signalsByToken['token-A'].aborted).toBe(false);

    // Navigate to B while A is still in flight → A's fetch must be aborted, so
    // a late A resolve can't run loadEstimate's global setGlassDefault side effect.
    currentToken = 'token-B';
    rerender(<EstimateViewPage />);

    await waitFor(() => expect(signalsByToken['token-A'].aborted).toBe(true));
  });

  it('aborts a pending SECONDARY refresh (retry) on a token change, not just the mount fetch', async () => {
    // Mount fetch for A fails → load-error screen; the retry is a non-mount
    // loadEstimate() call site and must ride the same component-lifetime
    // signal, or its late resolve could still run setGlassDefault for A
    // after navigating to B.
    let aCalls = 0;
    let retrySignal;
    const fetchMock = vi.fn((url, opts = {}) => {
      const token = String(url).match(/\/estimates\/([^/]+)\/data/)?.[1];
      if (token === 'token-A') {
        aCalls += 1;
        if (aCalls === 1) return Promise.reject(new Error('network down'));
        retrySignal = opts.signal;
        return new Promise(() => {}); // retry pending forever
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<EstimateViewPage />);
    const retryButton = await screen.findByRole('button', { name: 'Try again' });
    fireEvent.click(retryButton);
    await waitFor(() => expect(retrySignal).toBeInstanceOf(AbortSignal));
    expect(retrySignal.aborted).toBe(false);

    currentToken = 'token-B';
    rerender(<EstimateViewPage />);

    await waitFor(() => expect(retrySignal.aborted).toBe(true));
  });
});

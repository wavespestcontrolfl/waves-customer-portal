// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useDiscountStacking,
  useDiscountStackingState,
  __resetDiscountStackingCache,
} from './useDiscountStacking';

function Probe() {
  const enabled = useDiscountStacking();
  return <div data-testid="state">{enabled ? 'on' : 'off'}</div>;
}

function KnownProbe() {
  const { enabled, known, retry } = useDiscountStackingState();
  return (
    <div>
      <div data-testid="state">{enabled ? 'on' : 'off'}</div>
      <div data-testid="known">{known ? 'known' : 'unknown'}</div>
      <button type="button" onClick={retry}>retry</button>
    </div>
  );
}

beforeEach(() => {
  __resetDiscountStackingCache();
  localStorage.setItem('waves_admin_token', 'test-token');
  vi.restoreAllMocks();
});
afterEach(cleanup);

describe('useDiscountStacking', () => {
  it('starts off and turns on once the server reports the gate live', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ enabled: true }) })));
    render(<Probe />);
    expect(screen.getByTestId('state')).toHaveTextContent('off');
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('on'));
  });

  it('stays off for a dark gate, an error response, a thrown fetch, or a missing token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ enabled: false }) })));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('off'));
    cleanup();

    __resetDiscountStackingCache();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('off'));
    cleanup();

    __resetDiscountStackingCache();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('off'));
    cleanup();

    __resetDiscountStackingCache();
    localStorage.removeItem('waves_admin_token');
    const noTokenFetch = vi.fn();
    vi.stubGlobal('fetch', noTokenFetch);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('off'));
    expect(noTokenFetch).not.toHaveBeenCalled();
  });

  it('asks the server once per session, however many surfaces ask', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ enabled: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<><Probe /><Probe /><Probe /></>);
    await waitFor(() => expect(screen.getAllByTestId('state')[2]).toHaveTextContent('on'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/admin\/discounts\/stacking$/);
  });

  // Codex round-2 P1: a transient probe failure must not pin `false` for the
  // rest of the SPA session — that would strand a surface previewing
  // single-discount math while the real (unreachable) server gate is ON and
  // compounds on save. `known` lets a money-submitting caller refuse to act
  // on an unconfirmed answer instead of confidently computing the wrong one.
  it('does not permanently cache a transient probe failure, and reports known:false meanwhile', async () => {
    let now = 1_000_000;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true }) });
      vi.stubGlobal('fetch', fetchMock);

      render(<KnownProbe />);
      await waitFor(() => expect(screen.getByTestId('known')).toHaveTextContent('unknown'));
      expect(screen.getByTestId('state')).toHaveTextContent('off');
      cleanup();

      // Still inside the backoff window — a fresh mount must not hammer a
      // hard-down API, but must also not have latched a permanent answer.
      render(<KnownProbe />);
      await waitFor(() => expect(screen.getByTestId('known')).toHaveTextContent('unknown'));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      cleanup();

      // Backoff elapsed: the regression under test is caching `false`
      // forever, which would leave this stuck on off/unknown forever
      // instead of re-probing and learning the real (true) answer.
      now += 16000;
      render(<KnownProbe />);
      await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('on'));
      expect(screen.getByTestId('known')).toHaveTextContent('known');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('useDiscountStackingState reports known:true immediately once a value is cached from a prior probe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ enabled: true }) })));
    render(<KnownProbe />);
    await waitFor(() => expect(screen.getByTestId('known')).toHaveTextContent('known'));
    cleanup();
    // A second mount with the module cache already warm should read known
    // synchronously on first render, no flash of "unknown".
    render(<KnownProbe />);
    expect(screen.getByTestId('known')).toHaveTextContent('known');
    expect(screen.getByTestId('state')).toHaveTextContent('on');
  });

  // Codex #4405 P1: a SUCCESSFUL probe used to be cached for the rest of the
  // SPA session — an open tab would keep previewing/submitting the old
  // semantics across a mid-session GATE_DISCOUNT_STACKING flip while the
  // server's money endpoints read the live env var on every request.
  describe('confirmed-value TTL', () => {
    it('does not re-fetch a confirmed value within the TTL window', async () => {
      let now = 1_000_000;
      const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ enabled: true }) }));
        vi.stubGlobal('fetch', fetchMock);

        render(<KnownProbe />);
        await waitFor(() => expect(screen.getByTestId('known')).toHaveTextContent('known'));
        cleanup();

        // Well within the TTL — a fresh mount reads the still-fresh cache
        // synchronously, no second fetch.
        now += 59000;
        render(<KnownProbe />);
        expect(screen.getByTestId('known')).toHaveTextContent('known');
        expect(screen.getByTestId('state')).toHaveTextContent('on');
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        dateSpy.mockRestore();
      }
    });

    it('a confirmed value past the TTL reports known:false again until revalidated, and a money submission must not proceed on it', async () => {
      let now = 1_000_000;
      const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true }) })
          // The server flips the gate OFF mid-session; a stale cache must
          // not keep reporting the old `true` as confirmed.
          .mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: false }) });
        vi.stubGlobal('fetch', fetchMock);

        render(<KnownProbe />);
        await waitFor(() => expect(screen.getByTestId('known')).toHaveTextContent('known'));
        expect(screen.getByTestId('state')).toHaveTextContent('on');
        cleanup();

        // Past the 60s TTL: the cached `true` is no longer trustworthy on
        // its own — the very first synchronous render (before the re-probe
        // resolves) must already report known:false, so a caller gating a
        // money submission on `known` cannot fire mid-flip on the stale value.
        now += 61000;
        render(<KnownProbe />);
        expect(screen.getByTestId('known')).toHaveTextContent('unknown');
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        // Revalidation lands the real (now false) answer.
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('off'));
        expect(screen.getByTestId('known')).toHaveTextContent('known');
      } finally {
        dateSpy.mockRestore();
      }
    });
  });
});

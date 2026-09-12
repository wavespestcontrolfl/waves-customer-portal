// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADDRESS_ASK_LOOKUP_TIMEOUT_MS,
  addressAskNoticesMatch,
  recheckAddressAskAtSubmit,
  useAddressAskLookup,
} from './CreateAppointmentModal.jsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('useAddressAskLookup', () => {
  it('stays pending across a customer switch and ignores the first customer response', async () => {
    const first = deferred();
    const second = deferred();
    const fetcher = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(
      ({ customerId }) => useAddressAskLookup(customerId, fetcher),
      { initialProps: { customerId: 'customer-a' } },
    );

    expect(result.current).toMatchObject({ addressAsk: null, addressAskPending: true });
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('customer-a'), { signal: expect.any(AbortSignal) });
    const firstSignal = fetcher.mock.calls[0][1].signal;

    rerender({ customerId: 'customer-b' });
    expect(result.current).toMatchObject({ addressAsk: null, addressAskPending: true });
    expect(firstSignal.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('customer-b'), { signal: expect.any(AbortSignal) });

    await act(async () => {
      first.resolve({ items: [{ reason_code: 'address_unverified', payload: { address_as_heard: 'old address' } }] });
      await first.promise;
    });
    expect(result.current).toMatchObject({ addressAsk: null, addressAskPending: true });

    await act(async () => {
      second.resolve({ items: [{ reason_code: 'on_file_proof_customer_mismatch' }] });
      await second.promise;
    });
    await waitFor(() => expect(result.current.addressAskPending).toBe(false));
    expect(result.current.addressAsk?.reason).toContain('different customer');
  });

  it('settles fail-open when the lookup fails', async () => {
    const request = deferred();
    const fetcher = vi.fn(() => request.promise);
    const { result } = renderHook(() => useAddressAskLookup('customer-a', fetcher));

    expect(result.current.addressAskPending).toBe(true);
    await act(async () => {
      request.reject(new Error('offline'));
      try { await request.promise; } catch { /* expected */ }
    });

    await waitFor(() => expect(result.current.addressAskPending).toBe(false));
    expect(result.current).toMatchObject({ addressAsk: null, addressAskStatus: 'error' });
  });

  it('times out fail-open, aborts the request, and ignores a late response', async () => {
    vi.useFakeTimers();
    const request = deferred();
    const fetcher = vi.fn(() => request.promise);
    const { result } = renderHook(() => useAddressAskLookup('customer-a', fetcher));
    const signal = fetcher.mock.calls[0][1].signal;

    expect(result.current.addressAskPending).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ADDRESS_ASK_LOOKUP_TIMEOUT_MS);
    });
    expect(signal.aborted).toBe(true);
    expect(result.current).toMatchObject({
      addressAsk: null,
      addressAskPending: false,
      addressAskStatus: 'error',
    });

    await act(async () => {
      request.resolve({ items: [{ reason_code: 'address_unverified' }] });
      await request.promise;
    });
    expect(result.current).toMatchObject({
      addressAsk: null,
      addressAskPending: false,
      addressAskStatus: 'error',
    });
  });

  it('gives a newly selected customer the full timeout budget', async () => {
    vi.useFakeTimers();
    const timeoutMs = 100;
    const fetcher = vi.fn(() => new Promise(() => {}));
    const { result, rerender } = renderHook(
      ({ customerId }) => useAddressAskLookup(customerId, fetcher, timeoutMs),
      { initialProps: { customerId: 'customer-a' } },
    );
    const firstSignal = fetcher.mock.calls[0][1].signal;

    await act(async () => { await vi.advanceTimersByTimeAsync(90); });
    rerender({ customerId: 'customer-b' });
    expect(firstSignal.aborted).toBe(true);
    const secondSignal = fetcher.mock.calls[1][1].signal;

    await act(async () => { await vi.advanceTimersByTimeAsync(99); });
    expect(result.current).toMatchObject({ addressAskPending: true, addressAskStatus: 'loading' });
    expect(secondSignal.aborted).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current).toMatchObject({ addressAskPending: false, addressAskStatus: 'error' });
    expect(secondSignal.aborted).toBe(true);
  });

  it('aborts an in-flight lookup when the component unmounts', () => {
    const fetcher = vi.fn(() => new Promise(() => {}));
    const { unmount } = renderHook(() => useAddressAskLookup('customer-a', fetcher));
    const signal = fetcher.mock.calls[0][1].signal;

    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });
});

describe('submission-time address review', () => {
  const notice = (heard) => ({
    unitOnly: false,
    readbackOnly: false,
    reason: 'the address from the call did not validate',
    heard,
    building: null,
    candidates: [],
  });

  it('holds when a card is filed after the initial lookup', async () => {
    const request = deferred();
    const check = recheckAddressAskAtSubmit({
      customerId: 'customer-a',
      seenNotice: null,
      fetcher: () => request.promise,
      timeoutMs: 100,
    });

    request.resolve({
      items: [{ reason_code: 'address_unverified', payload: { address_as_heard: 'new evidence' } }],
    });
    await expect(check).resolves.toMatchObject({
      status: 'ready',
      changed: true,
      notice: { heard: 'new evidence' },
    });
  });

  it('holds when displayed evidence changes and allows the same notice', async () => {
    const changed = await recheckAddressAskAtSubmit({
      customerId: 'customer-a',
      seenNotice: notice('old evidence'),
      fetcher: async () => ({
        items: [{ reason_code: 'address_unverified', payload: { address_as_heard: 'new evidence' } }],
      }),
    });
    const same = await recheckAddressAskAtSubmit({
      customerId: 'customer-a',
      seenNotice: changed.notice,
      fetcher: async () => ({
        items: [{ reason_code: 'address_unverified', payload: { address_as_heard: 'new evidence' } }],
      }),
    });

    expect(changed.changed).toBe(true);
    expect(same).toMatchObject({ status: 'ready', changed: false });
    expect(addressAskNoticesMatch(changed.notice, same.notice)).toBe(true);
  });

  it('holds with a cleared notice so the operator sees that the prior warning is gone', async () => {
    await expect(recheckAddressAskAtSubmit({
      customerId: 'customer-a',
      seenNotice: notice('previous evidence'),
      fetcher: async () => ({ items: [] }),
    })).resolves.toMatchObject({ status: 'ready', changed: true, notice: null });
  });

  it('fails open on error or timeout', async () => {
    const failed = await recheckAddressAskAtSubmit({
      customerId: 'customer-a',
      seenNotice: null,
      fetcher: async () => { throw new Error('offline'); },
    });
    expect(failed).toMatchObject({ status: 'error', changed: false, notice: null });

    vi.useFakeTimers();
    const timedOutCheck = recheckAddressAskAtSubmit({
      customerId: 'customer-a',
      seenNotice: null,
      fetcher: () => new Promise(() => {}),
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(timedOutCheck).resolves.toMatchObject({ status: 'error', changed: false, notice: null });
  });

  it('cancels a stale-customer check and ignores its late completion', async () => {
    const request = deferred();
    const controller = new AbortController();
    const check = recheckAddressAskAtSubmit({
      customerId: 'customer-a',
      seenNotice: null,
      fetcher: () => request.promise,
      signal: controller.signal,
    });

    controller.abort();
    await expect(check).resolves.toMatchObject({ status: 'cancelled', changed: false, notice: null });
    request.resolve({ items: [{ reason_code: 'address_unverified' }] });
    await request.promise;
  });
});

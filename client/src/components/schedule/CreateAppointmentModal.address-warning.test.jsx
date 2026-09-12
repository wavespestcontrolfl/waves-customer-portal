// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAddressAskLookup } from './CreateAppointmentModal.jsx';

afterEach(cleanup);

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
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('customer-a'));

    rerender({ customerId: 'customer-b' });
    expect(result.current).toMatchObject({ addressAsk: null, addressAskPending: true });
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('customer-b'));

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
});

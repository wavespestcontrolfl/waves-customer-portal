// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CreateAppointmentModal, {
  ADDRESS_ASK_LOOKUP_TIMEOUT_MS,
  addressAskNoticesMatch,
  recheckAddressAskAtSubmit,
  useAddressAskLookup,
} from './CreateAppointmentModal.jsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: vi.fn(async () => body),
  };
}

function futureDate(days = 30) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function installModalFetch({ firstScheduleRequest, secondScheduleRequest, submitAddressRequest } = {}) {
  let addressRequests = 0;
  const fetcher = vi.fn((input, options = {}) => {
    const url = String(input);
    if (url.includes('/admin/triage?')) {
      addressRequests += 1;
      if (addressRequests === 2 && submitAddressRequest) return submitAddressRequest.promise;
      return Promise.resolve(jsonResponse({ items: [] }));
    }
    if (url.includes('/admin/services?')) {
      const name = url.includes('Second') ? 'Second seasonal service' : 'First seasonal service';
      return Promise.resolve(jsonResponse({
        services: [{
          id: name.startsWith('First') ? 'service-first' : 'service-second',
          name,
          billing_type: 'recurring',
          frequency: 'seasonal_feb_oct',
          visits_per_year: 9,
          base_price: 100,
          default_duration_minutes: 30,
        }],
      }));
    }
    if (url.endsWith('/admin/schedule') && options.method === 'POST') {
      const scheduleRequestCount = fetcher.mock.calls.filter(
        ([calledUrl, calledOptions]) => String(calledUrl).endsWith('/admin/schedule') && calledOptions?.method === 'POST',
      ).length;
      if (scheduleRequestCount === 1) {
        return firstScheduleRequest?.promise || Promise.resolve(jsonResponse({ id: 'appointment-committed' }));
      }
      if (scheduleRequestCount === 2 && secondScheduleRequest) return secondScheduleRequest.promise;
      return Promise.resolve(jsonResponse({ id: 'unexpected-later-appointment' }));
    }
    if (url.includes('/properties?context=appointment_address')) {
      return Promise.resolve(jsonResponse({ properties: [], canChangeAppointmentAddress: false }));
    }
    if (url.includes('/schedule-estimates')) return Promise.resolve(jsonResponse({ estimates: [] }));
    if (url.endsWith('/admin/technicians')) return Promise.resolve(jsonResponse({ technicians: [] }));
    if (url.endsWith('/admin/discounts')) return Promise.resolve(jsonResponse([]));
    if (url.endsWith('/annual-prepay-availability')) return Promise.resolve(jsonResponse({ enabled: false }));
    if (url.endsWith('/card-request-availability')) return Promise.resolve(jsonResponse({ enabled: false }));
    if (url.endsWith('/admin/dispatch/slot-check')) {
      return Promise.resolve(jsonResponse({ ok: true, results: [{ conflicts: [] }] }));
    }
    if (url.includes('/admin/schedule/find-time')) return Promise.resolve(jsonResponse({ gated: true }));
    throw new Error(`Unhandled fetch in CreateAppointmentModal test: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, getAddressRequestCount: () => addressRequests };
}

async function addTwoSeasonalServices() {
  const firstSearch = screen.getByPlaceholderText('Search services');
  fireEvent.change(firstSearch, { target: { value: 'First' } });
  fireEvent.click(await screen.findByRole('button', { name: /First seasonal service/ }));

  fireEvent.click(screen.getByRole('button', { name: /Add service/ }));
  const secondSearch = screen.getByPlaceholderText('Search to add service');
  fireEvent.change(secondSearch, { target: { value: 'Second' } });
  fireEvent.click(await screen.findByRole('button', { name: /Second seasonal service/ }));

  const submit = screen.getByRole('button', { name: 'Schedule appointment' });
  await waitFor(() => expect(submit.disabled).toBe(false));
  return submit;
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

describe('CreateAppointmentModal submit cancellation', () => {
  const customer = { id: 'customer-a', firstName: 'Ada', lastName: 'Lovelace' };

  it('reports a committed first group once after unmount and skips later booking posts', async () => {
    const firstScheduleRequest = deferred();
    const { fetcher } = installModalFetch({ firstScheduleRequest });
    const onCreated = vi.fn();
    const onChange = vi.fn();
    const scheduledDate = futureDate();
    const view = render(
      <CreateAppointmentModal
        defaultCustomer={customer}
        defaultDate={scheduledDate}
        defaultWindowStart="09:00"
        onClose={vi.fn()}
        onCreated={onCreated}
        onChange={onChange}
      />,
    );
    const submit = await addTwoSeasonalServices();

    fireEvent.click(submit);
    await waitFor(() => expect(fetcher.mock.calls.filter(
      ([url, options]) => String(url).endsWith('/admin/schedule') && options?.method === 'POST',
    )).toHaveLength(1));
    const firstScheduleBody = JSON.parse(fetcher.mock.calls.find(
      ([url, options]) => String(url).endsWith('/admin/schedule') && options?.method === 'POST',
    )[1].body);
    expect(firstScheduleBody).toMatchObject({
      serviceId: 'service-first',
      serviceAddons: [],
      recurringPattern: 'seasonal_feb_oct',
    });
    view.unmount();

    await act(async () => {
      firstScheduleRequest.resolve(jsonResponse({ id: 'appointment-committed' }));
      await firstScheduleRequest.promise;
    });

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    expect(onCreated).toHaveBeenCalledWith(
      { id: 'appointment-committed', scheduledDate },
      { background: true },
    );
    expect(onChange).toHaveBeenCalledWith(
      { id: 'appointment-committed', scheduledDate },
      { background: true },
    );
    expect(fetcher.mock.calls.filter(
      ([url, options]) => String(url).endsWith('/admin/schedule') && options?.method === 'POST',
    )).toHaveLength(1);
    expect(fetcher.mock.calls.some(
      ([url, options]) => String(url).includes('/annual-prepay-invoice') && options?.method === 'POST',
    )).toBe(false);
  });

  it('reports the first committed group without a late error alert when the second post fails after unmount', async () => {
    const secondScheduleRequest = deferred();
    const { fetcher } = installModalFetch({ secondScheduleRequest });
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onCreated = vi.fn();
    const onChange = vi.fn();
    const scheduledDate = futureDate();
    const view = render(
      <CreateAppointmentModal
        defaultCustomer={customer}
        defaultDate={scheduledDate}
        defaultWindowStart="09:00"
        onClose={vi.fn()}
        onCreated={onCreated}
        onChange={onChange}
      />,
    );
    const submit = await addTwoSeasonalServices();

    fireEvent.click(submit);
    await waitFor(() => expect(fetcher.mock.calls.filter(
      ([url, options]) => String(url).endsWith('/admin/schedule') && options?.method === 'POST',
    )).toHaveLength(2));
    view.unmount();

    await act(async () => {
      secondScheduleRequest.resolve(jsonResponse(
        { error: 'late server failure' },
        { ok: false, status: 500 },
      ));
      await secondScheduleRequest.promise;
    });

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    expect(onCreated).toHaveBeenCalledWith(
      { id: 'appointment-committed', scheduledDate },
      { background: true },
    );
    expect(onChange).toHaveBeenCalledWith(
      { id: 'appointment-committed', scheduledDate },
      { background: true },
    );
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('does not report creation when unmounted before the first booking post', async () => {
    const submitAddressRequest = deferred();
    const { fetcher, getAddressRequestCount } = installModalFetch({ submitAddressRequest });
    const onCreated = vi.fn();
    const onChange = vi.fn();
    const view = render(
      <CreateAppointmentModal
        defaultCustomer={customer}
        defaultDate={futureDate()}
        defaultWindowStart="09:00"
        onClose={vi.fn()}
        onCreated={onCreated}
        onChange={onChange}
      />,
    );
    const submit = await addTwoSeasonalServices();

    fireEvent.click(submit);
    await waitFor(() => expect(getAddressRequestCount()).toBe(2));
    const submitAddressSignal = fetcher.mock.calls.filter(
      ([url]) => String(url).includes('/admin/triage?'),
    )[1][1].signal;
    view.unmount();

    expect(submitAddressSignal.aborted).toBe(true);
    await act(async () => {
      submitAddressRequest.resolve(jsonResponse({ items: [] }));
      await submitAddressRequest.promise;
    });
    await act(async () => { await Promise.resolve(); });

    expect(onCreated).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.some(
      ([url, options]) => String(url).endsWith('/admin/schedule') && options?.method === 'POST',
    )).toBe(false);
  });
});

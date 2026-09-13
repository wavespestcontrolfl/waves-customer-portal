// @vitest-environment jsdom
import React from 'react';
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

const PREPAY_PREVIEW = {
  eligible: true,
  visitsPerYear: 9,
  perVisit: 100,
  annualBase: 900,
  discountAmount: 0,
  discountLabel: '',
  prepayTotal: 900,
  mintPayload: { source: 'test' },
};

function installModalFetch({
  firstScheduleRequest,
  secondScheduleRequest,
  submitAddressRequest,
  freshPrepayRequest,
  prepayInvoiceRequest,
  enablePrepay = false,
} = {}) {
  let addressRequests = 0;
  let prepayPreviews = 0;
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
    if (url.endsWith('/annual-prepay-availability')) {
      return Promise.resolve(jsonResponse({ enabled: enablePrepay }));
    }
    if (url.includes('/annual-prepay-preview?')) {
      prepayPreviews += 1;
      if (prepayPreviews === 2 && freshPrepayRequest) return freshPrepayRequest.promise;
      return Promise.resolve(jsonResponse(PREPAY_PREVIEW));
    }
    if (url.includes('/annual-prepay-invoice') && options.method === 'POST') {
      return prepayInvoiceRequest?.promise || Promise.resolve(jsonResponse({ invoice: {}, delivery: {} }));
    }
    if (url.endsWith('/card-request-availability')) return Promise.resolve(jsonResponse({ enabled: false }));
    if (url.endsWith('/admin/dispatch/slot-check')) {
      return Promise.resolve(jsonResponse({ ok: true, results: [{ conflicts: [] }] }));
    }
    if (url.includes('/admin/schedule/find-time')) return Promise.resolve(jsonResponse({ gated: true }));
    throw new Error(`Unhandled fetch in CreateAppointmentModal test: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return {
    fetcher,
    getAddressRequestCount: () => addressRequests,
    getPrepayPreviewCount: () => prepayPreviews,
  };
}

async function addOneSeasonalService() {
  const firstSearch = screen.getByPlaceholderText('Search services');
  fireEvent.change(firstSearch, { target: { value: 'First' } });
  fireEvent.click(await screen.findByRole('button', { name: /First seasonal service/ }));
}

async function addTwoSeasonalServices() {
  await addOneSeasonalService();
  fireEvent.click(screen.getByRole('button', { name: /Add service/ }));
  const secondSearch = screen.getByPlaceholderText('Search to add service');
  fireEvent.change(secondSearch, { target: { value: 'Second' } });
  fireEvent.click(await screen.findByRole('button', { name: /Second seasonal service/ }));

  const submit = screen.getByRole('button', { name: 'Schedule appointment' });
  await waitFor(() => expect(submit.disabled).toBe(false));
  return submit;
}

const CUSTOMER = { id: 'customer-a', firstName: 'Ada', lastName: 'Lovelace' };
const schedulePosts = (fetcher) => fetcher.mock.calls.filter(
  ([url, options]) => String(url).endsWith('/admin/schedule') && options?.method === 'POST',
);
const prepayInvoicePosts = (fetcher) => fetcher.mock.calls.filter(
  ([url, options]) => String(url).includes('/annual-prepay-invoice') && options?.method === 'POST',
);
function renderBooking(props = {}) {
  const callbacks = { onClose: vi.fn(), onCreated: vi.fn(), onChange: vi.fn(), ...props };
  const scheduledDate = props.defaultDate || futureDate();
  const view = render(<CreateAppointmentModal
    defaultCustomer={CUSTOMER}
    defaultDate={scheduledDate}
    defaultWindowStart="09:00"
    {...callbacks}
  />);
  return { ...callbacks, scheduledDate, view };
}
async function beginBooking(requests = {}) {
  const { fetcher, ...fetchState } = installModalFetch(requests);
  const booking = renderBooking();
  fireEvent.click(await addTwoSeasonalServices());
  await waitFor(() => expect(schedulePosts(fetcher).length).toBeGreaterThan(0));
  return { fetcher, ...fetchState, ...booking };
}
async function beginPrepayBooking(requests = {}) {
  const { fetcher, ...fetchState } = installModalFetch({ ...requests, enablePrepay: true });
  const booking = renderBooking();
  await addOneSeasonalService();
  fireEvent.click(await screen.findByRole('button', { name: /Annual prepay — invoices/ }));
  const submit = screen.getByRole('button', { name: 'Schedule appointment' });
  await waitFor(() => expect(submit.disabled).toBe(false));
  fireEvent.click(submit);
  await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
  return { fetcher, ...fetchState, ...booking };
}
function expectBackgroundRefresh({ onCreated, onChange, scheduledDate, id }) {
  const appointment = id ? { id, scheduledDate } : { scheduledDate };
  expect(onCreated).toHaveBeenCalledWith(appointment, { background: true });
  expect(onChange).toHaveBeenCalledWith(appointment, { background: true });
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
  const notice = (heard, cardId = 'card-a', callId = 'call-a') => ({
    cardId,
    callId,
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

  it.each([
    ['a replacement card on the same call', 'card-a', 'call-a', 'card-b', 'call-a', true],
    ['a card from a different call', 'card-a', 'call-a', 'card-b', 'call-b', true],
    ['the identical card and call', 'card-a', 'call-a', 'card-a', 'call-a', false],
  ])('%s is compared by identity even when the visible evidence is unchanged', async (
    _label, seenCardId, seenCallId, freshCardId, freshCallId, changed,
  ) => {
    const result = await recheckAddressAskAtSubmit({
      customerId: 'customer-a',
      seenNotice: notice('same evidence', seenCardId, seenCallId),
      fetcher: async () => ({
        items: [{
          id: freshCardId,
          call_log_id: freshCallId,
          reason_code: 'address_unverified',
          payload: { address_as_heard: 'same evidence' },
        }],
      }),
    });

    expect(result).toMatchObject({
      status: 'ready',
      changed,
      notice: { cardId: freshCardId, callId: freshCallId, heard: 'same evidence' },
    });
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
  it('reports a committed first group once after unmount and skips later booking posts', async () => {
    const firstScheduleRequest = deferred();
    const state = await beginBooking({ firstScheduleRequest });
    const firstScheduleBody = JSON.parse(schedulePosts(state.fetcher)[0][1].body);
    expect(firstScheduleBody).toMatchObject({
      serviceId: 'service-first',
      serviceAddons: [],
      recurringPattern: 'seasonal_feb_oct',
    });
    state.view.unmount();
    await act(async () => {
      firstScheduleRequest.resolve(jsonResponse({ id: 'appointment-committed' }));
      await firstScheduleRequest.promise;
    });

    await waitFor(() => expect(state.onCreated).toHaveBeenCalledTimes(1));
    expectBackgroundRefresh({ ...state, id: 'appointment-committed' });
    expect(schedulePosts(state.fetcher)).toHaveLength(1);
    expect(state.fetcher.mock.calls.some(
      ([url, options]) => String(url).includes('/annual-prepay-invoice') && options?.method === 'POST',
    )).toBe(false);
  });

  it('reports the first committed group without a late error alert when the second post fails after unmount', async () => {
    const secondScheduleRequest = deferred();
    const state = await beginBooking({ secondScheduleRequest });
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});
    await waitFor(() => expect(schedulePosts(state.fetcher)).toHaveLength(2));
    state.view.unmount();

    await act(async () => {
      secondScheduleRequest.resolve(jsonResponse(
        { error: 'late server failure' },
        { ok: false, status: 500 },
      ));
      await secondScheduleRequest.promise;
    });

    await waitFor(() => expect(state.onCreated).toHaveBeenCalledTimes(1));
    expectBackgroundRefresh({ ...state, id: 'appointment-committed' });
    expect(alertMock).not.toHaveBeenCalled();
  });

  it.each(['network failure', 'JSON response failure'])(
    'refreshes after the closed first POST has an ambiguous %s',
    async (failureKind) => {
      const firstScheduleRequest = deferred();
      const state = await beginBooking({ firstScheduleRequest });
      const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});
      state.view.unmount();
      await act(async () => {
        if (failureKind === 'network failure') firstScheduleRequest.reject(new Error('connection lost'));
        else firstScheduleRequest.resolve({
          ok: true,
          status: 200,
          json: vi.fn(async () => { throw new Error('truncated response'); }),
        });
        try { await firstScheduleRequest.promise; } catch { /* expected */ }
      });

      await waitFor(() => expect(state.onCreated).toHaveBeenCalledTimes(1));
      expectBackgroundRefresh(state);
      expect(schedulePosts(state.fetcher)).toHaveLength(1);
      expect(state.fetcher.mock.calls.some(
        ([url, options]) => String(url).includes('/annual-prepay-invoice') && options?.method === 'POST',
      )).toBe(false);
      expect(alertMock).not.toHaveBeenCalled();
    },
  );

  it('silently refreshes after a failed POST while keeping the retry draft open', async () => {
    const firstScheduleRequest = deferred();
    const state = await beginBooking({ firstScheduleRequest });
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    await act(async () => {
      firstScheduleRequest.resolve(jsonResponse({ error: 'failed' }, { ok: false, status: 500 }));
      await firstScheduleRequest.promise;
    });

    await waitFor(() => expect(state.onCreated).toHaveBeenCalledTimes(1));
    expectBackgroundRefresh(state);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(schedulePosts(state.fetcher)).toHaveLength(1);
  });

  it('releases a failed attempt and retries only its unsaved group', async () => {
    const secondScheduleRequest = deferred();
    const state = await beginBooking({ secondScheduleRequest });
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    await waitFor(() => expect(schedulePosts(state.fetcher)).toHaveLength(2));
    await act(async () => {
      secondScheduleRequest.resolve(jsonResponse({ error: 'retry this group' }, { ok: false, status: 500 }));
      await secondScheduleRequest.promise;
    });
    await waitFor(() => expect(state.onCreated).toHaveBeenCalledTimes(1));
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(state.fetcher)).toHaveLength(3));
    expect(schedulePosts(state.fetcher).map(([, options]) => JSON.parse(options.body).serviceId))
      .toEqual(['service-first', 'service-second', 'service-second']);
    await waitFor(() => expect(state.onCreated).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(state.onCreated).toHaveBeenLastCalledWith({
      id: 'unexpected-later-appointment', scheduledDate: state.scheduledDate,
    });
  });

  it('surfaces a prepay preview failure while completing the committed booking', async () => {
    const freshPrepayRequest = deferred();
    const state = await beginPrepayBooking({ freshPrepayRequest });
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});
    await waitFor(() => expect(state.getPrepayPreviewCount()).toBe(2));
    await act(async () => {
      freshPrepayRequest.reject(new Error('preview unavailable'));
      try { await freshPrepayRequest.promise; } catch { /* expected */ }
    });
    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining('preview unavailable'));
    expect(prepayInvoicePosts(state.fetcher)).toHaveLength(0);
    await waitFor(() => expect(state.onCreated).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(state.onCreated).toHaveBeenCalledWith({
      id: 'appointment-committed', scheduledDate: state.scheduledDate,
    });
    expect(schedulePosts(state.fetcher)).toHaveLength(1);
  });

  it.each([true, false])('preserves prepay delivery feedback when delivery.ok is %s', async (ok) => {
    const prepayInvoiceRequest = deferred();
    const state = await beginPrepayBooking({ prepayInvoiceRequest });
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});
    await waitFor(() => expect(prepayInvoicePosts(state.fetcher)).toHaveLength(1));
    await act(async () => {
      prepayInvoiceRequest.resolve(jsonResponse({ invoice: {}, delivery: { ok } }));
      await prepayInvoiceRequest.promise;
    });
    if (ok) expect(alertMock).not.toHaveBeenCalled();
    else expect(alertMock).toHaveBeenCalledWith(expect.stringContaining('SENDING IT FAILED'));
    await waitFor(() => expect(state.onCreated).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(state.onCreated).toHaveBeenCalledWith({
      id: 'appointment-committed', scheduledDate: state.scheduledDate,
    });
    expect(prepayInvoicePosts(state.fetcher)).toHaveLength(1);
  });

  it('turns the delayed success callback into a background refresh after close', async () => {
    const secondScheduleRequest = deferred();
    const state = await beginBooking({ secondScheduleRequest });
    await waitFor(() => expect(schedulePosts(state.fetcher)).toHaveLength(2));
    await act(async () => {
      secondScheduleRequest.resolve(jsonResponse({ id: 'appointment-second' }));
      await secondScheduleRequest.promise;
    });
    await screen.findByText(/2 appointment series created/);
    state.view.unmount();

    await waitFor(() => expect(state.onCreated).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expectBackgroundRefresh({ ...state, id: 'appointment-committed' });
  });

  it('stops before the invoice POST when closed during the post-booking prepay preview', async () => {
    const freshPrepayRequest = deferred();
    const state = await beginPrepayBooking({ freshPrepayRequest });
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});
    await waitFor(() => expect(state.getPrepayPreviewCount()).toBe(2));
    state.view.unmount();
    await act(async () => {
      freshPrepayRequest.resolve(jsonResponse(PREPAY_PREVIEW));
      await freshPrepayRequest.promise;
    });

    await waitFor(() => expect(state.onCreated).toHaveBeenCalledTimes(1));
    expectBackgroundRefresh({ ...state, id: 'appointment-committed' });
    expect(prepayInvoicePosts(state.fetcher)).toHaveLength(0);
    expect(alertMock).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'])(
    'suppresses late UI when a prepay invoice POST %ss after close',
    async (outcome) => {
      const prepayInvoiceRequest = deferred();
      const state = await beginPrepayBooking({ prepayInvoiceRequest });
      const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});
      await waitFor(() => expect(prepayInvoicePosts(state.fetcher)).toHaveLength(1));
      state.view.unmount();
      await act(async () => {
        if (outcome === 'resolve') {
          prepayInvoiceRequest.resolve(jsonResponse({ invoice: {}, delivery: {}, warnings: [] }));
        } else prepayInvoiceRequest.reject(new Error('connection lost'));
        try { await prepayInvoiceRequest.promise; } catch { /* expected */ }
      });

      await waitFor(() => expect(state.onCreated).toHaveBeenCalledTimes(1));
      expectBackgroundRefresh({ ...state, id: 'appointment-committed' });
      expect(state.onChange).toHaveBeenCalledTimes(1);
      expect(alertMock).not.toHaveBeenCalled();
    },
  );

  it('does not report creation when unmounted before the first booking post', async () => {
    const submitAddressRequest = deferred();
    const { fetcher, getAddressRequestCount } = installModalFetch({ submitAddressRequest });
    const state = renderBooking();

    fireEvent.click(await addTwoSeasonalServices());
    await waitFor(() => expect(getAddressRequestCount()).toBe(2));
    const submitAddressSignal = fetcher.mock.calls.filter(
      ([url]) => String(url).includes('/admin/triage?'),
    )[1][1].signal;
    state.view.unmount();

    expect(submitAddressSignal.aborted).toBe(true);
    await act(async () => {
      submitAddressRequest.resolve(jsonResponse({ items: [] }));
      await submitAddressRequest.promise;
    });
    await act(async () => { await Promise.resolve(); });

    expect(state.onCreated).not.toHaveBeenCalled();
    expect(state.onChange).not.toHaveBeenCalled();
    expect(schedulePosts(fetcher)).toHaveLength(0);
  });
});

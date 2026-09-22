// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureStackingFresh, useDiscountStackingState } from '../../hooks/useDiscountStacking';
vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: true, known: true })),
}));
import CreateAppointmentModal, {
  ADDRESS_ASK_LOOKUP_TIMEOUT_MS,
  addressAskNoticesMatch,
  recheckAddressAskAtSubmit,
  useAddressAskLookup,
} from './CreateAppointmentModal.jsx';

afterEach(() => {
  cleanup();
  vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: false, known: true, retry: vi.fn() });
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
  discounts = [],
  basePrice = 100,
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
          service_key: name.startsWith('First') ? 'svc_first' : 'svc_second',
          name,
          billing_type: 'recurring',
          frequency: 'seasonal_feb_oct',
          visits_per_year: 9,
          base_price: basePrice,
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
    if (url.endsWith('/admin/discounts')) return Promise.resolve(jsonResponse(discounts));
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


describe('appointment discount submission eligibility', () => {
  it('requires removing an unmatched scoped discount before booking', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    const { fetcher } = installModalFetch({ discounts: [{
      id: 'termite-only', name: 'Termite only', discount_type: 'fixed_amount',
      amount: 10, is_active: true, show_in_invoices: true, service_key_filter: 'termite_bond',
    }] });
    renderBooking();
    await addOneSeasonalService();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'termite-only' } });
    await screen.findByText('This appointment discount does not match any selected service. Change or remove it before saving.');
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(schedulePosts(fetcher)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Remove discount' }));
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body).discountId).toBeUndefined();
  });

  // Codex pre-push audit P1 (this PR): manualPrepayPlan's price previously
  // summed lineEffectiveNetAmount alone — every line's OWN discount, never
  // the appointment-level one — so an appointment discount left the annual
  // prepay preview (and the price it POSTS to the server) at the pre-stack
  // total. The server's own post-booking eligibility check then disagreed
  // with the inflated price and silently skipped minting the invoice.
  it('prices the annual-prepay preview with the fully stacked appointment-discount total', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    const { fetcher } = installModalFetch({
      enablePrepay: true,
      discounts: [{
        id: 'mil', name: 'Military Discount', discount_type: 'fixed_amount',
        amount: 10, is_active: true, show_in_invoices: true,
      }],
    });
    renderBooking();
    await addOneSeasonalService();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'mil' } });
    await screen.findByText('Military Discount: -$10.00');
    fireEvent.click(await screen.findByRole('button', { name: /Annual prepay — invoices/ }));
    await waitFor(() => expect(fetcher.mock.calls.some(
      ([url]) => String(url).includes('/annual-prepay-preview?'),
    )).toBe(true));
    const [previewUrl] = fetcher.mock.calls.find(([url]) => String(url).includes('/annual-prepay-preview?'));
    const price = new URL(previewUrl, 'http://test').searchParams.get('price');
    // $100 line, 10% appointment discount: $90 stacked, never the raw $100
    // lineEffectiveNetAmount sum the bug used to post.
    expect(price).toBe('90');
  });
});

describe('recurring prepay preview scoping (Codex pre-push audit P1, round 2)', () => {
  it("scopes the visits-x-price preview to the recurring group's own stacked total, not every service in the booking", async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    installModalFetch({ discounts: [{
      id: 'mil', name: 'Military Discount', discount_type: 'fixed_amount',
      amount: 10, is_active: true, show_in_invoices: true,
    }] });
    renderBooking();
    await addOneSeasonalService();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'mil' } });
    await screen.findByText('Military Discount: -$10.00');
    fireEvent.change(screen.getByPlaceholderText('Ongoing'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Collect prepayment' }));
    // $100 line, $10 appointment discount: $90/visit x 3 = $270, never the
    // unscoped appointmentDiscountPreview.total the earlier bug used.
    await screen.findByText((_, node) => node?.textContent === '3 visits \u00d7 $90.00 = $270.00');
  });
});

describe('appointment discount stale-gate retry (Codex pre-push audit P1)', () => {
  // ensureStackingFresh() can disagree with the preview (or fail) at
  // submit time while the POLLING hook's own `known` flag is still true —
  // that leaves staleStackingNotice set with stackingUnconfirmedBlocksSave
  // false. The banner's Retry button used to fall through to
  // pickAppointmentDiscount(''), silently discarding the operator's
  // selection instead of retrying.
  it('retries the gate probe instead of removing the discount when only the submit-time check went stale', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    const retry = vi.fn();
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry });
    vi.mocked(ensureStackingFresh).mockResolvedValueOnce({ enabled: false, known: true });
    const { fetcher } = installModalFetch({ discounts: [{
      id: 'mil', name: 'Military Discount', discount_type: 'fixed_amount',
      amount: 10, is_active: true, show_in_invoices: true,
    }] });
    renderBooking();
    await addOneSeasonalService();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'mil' } });
    const submit = await screen.findByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await screen.findByText('Could not confirm the discount-stacking status — retry before saving.');
    expect(schedulePosts(fetcher)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    // The selection survives the retry — never silently removed.
    expect(picker.value).toBe('mil');
    expect(retry).toHaveBeenCalled();
  });
});

describe('appointment discount gate-drift protection (Codex pre-push audit P1, round 3)', () => {
  // The background poll behind useDiscountStackingState can flip
  // stackingEnabled after a discount is already selected. The picker can
  // only ever be REACHED while the gate reads confirmed-on, so the pick is
  // always made under a true snapshot — this simulates the live value
  // moving out from under that snapshot via a rerender with a new mocked
  // hook return, exactly like a real background poll landing.
  async function pickThenFlipGateTo(nextEnabled) {
    const retry = vi.fn();
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry });
    const { fetcher } = installModalFetch({ discounts: [{
      id: 'mil', name: 'Military Discount', discount_type: 'fixed_amount',
      amount: 10, is_active: true, show_in_invoices: true,
    }] });
    const booking = renderBooking();
    await addOneSeasonalService();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'mil' } });
    await screen.findByText('Military Discount: -$10.00');

    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: nextEnabled, known: true, retry });
    booking.view.rerender(<CreateAppointmentModal
      defaultCustomer={CUSTOMER}
      defaultDate={booking.scheduledDate}
      defaultWindowStart="09:00"
      onClose={booking.onClose}
      onCreated={booking.onCreated}
      onChange={booking.onChange}
    />);
    return { booking, fetcher, retry };
  }

  it('flip true -> false after picking: blocks Save, shows the retry banner, and keeps the selection visible — never silently drops it', async () => {
    const { fetcher } = await pickThenFlipGateTo(false);
    await screen.findByText('Could not confirm the discount-stacking status — retry before saving.');
    // Never silently stripped: the picker still shows the pick and the
    // preview still reflects its dollars, even though the LIVE gate now
    // disagrees with what was selected under.
    expect(screen.getByLabelText('Appointment discount').value).toBe('mil');
    expect(screen.getByText('Military Discount: -$10.00')).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(schedulePosts(fetcher)).toHaveLength(0);
  });

  it('a later flip back to the ORIGINAL gate (false -> true) never needed to have silently dropped the selection either', async () => {
    const { booking, fetcher } = await pickThenFlipGateTo(false);
    await screen.findByText('Could not confirm the discount-stacking status — retry before saving.');
    // Still selected and still previewed through the blocked window —
    // this is the invariant the true -> false flip already proved; the
    // false -> true transition below must never have depended on it
    // breaking that invariant at any point.
    expect(screen.getByLabelText('Appointment discount').value).toBe('mil');

    // The poll lands again, back to the value the pick was originally made
    // under — this transition is the false -> true direction the true ->
    // false test above does not cover, exercised via the SAME symmetric
    // (order-independent) mismatch check, not a second one-directional path.
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    booking.view.rerender(<CreateAppointmentModal
      defaultCustomer={CUSTOMER}
      defaultDate={booking.scheduledDate}
      defaultWindowStart="09:00"
      onClose={booking.onClose}
      onCreated={booking.onCreated}
      onChange={booking.onChange}
    />);
    // The selection was never silently dropped by either flip — it reads
    // back exactly as the operator left it, and the total the operator
    // agreed to (again matching the live gate) is safe to submit.
    expect(screen.getByLabelText('Appointment discount').value).toBe('mil');
    expect(screen.getByText('Military Discount: -$10.00')).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body).discountId).toBe('mil');
  });

  // Codex pre-push audit P0 (round 4): retryAppointmentDiscountGate used to
  // re-freeze appointmentDiscountGateSnapshot to a CONFIRMED-off answer and
  // fall through — appointmentDiscount then read null on the very next
  // render (discounts never apply under a confirmed-off gate), silently
  // dropping the banner AND the discount's dollars in the same render with
  // nothing telling the operator it happened. The fix explicitly clears the
  // selection and raises a toast so the removal is always an ANNOUNCED
  // consequence of the operator's own Retry click.
  it('Retry resolving to a confirmed-off gate clears the discount with a visible toast, never silently', async () => {
    const { fetcher } = await pickThenFlipGateTo(false);
    await screen.findByText('Could not confirm the discount-stacking status — retry before saving.');
    vi.mocked(ensureStackingFresh).mockResolvedValueOnce({ enabled: false, known: true });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Discount stacking is now off — the appointment discount was removed. Add it again if stacking comes back on.');
    // The picker honestly reflects the removal — never a silent revert. The
    // gate reads confirmed-off now with nothing selected, so the whole
    // appointment-discount section correctly disappears (same as any other
    // gate-off render that never had a pick at all).
    await waitFor(() => expect(screen.queryByLabelText('Appointment discount')).toBeNull());
    expect(screen.queryByText('Military Discount: -$10.00')).toBeNull();
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body).discountId).toBeUndefined();
  });

  // Codex pre-push audit P1 (round 5): the picker <select> was never
  // disabled during an active drift/unconfirmed banner, so an operator
  // re-picking (instead of clicking Retry) froze
  // appointmentDiscountGateSnapshot to the then-LIVE (still-drifted) value
  // via the ordinary pickAppointmentDiscount path — discarding the fresh
  // pick with zero feedback the moment the drift check re-evaluated, a
  // path none of the Retry-focused tests above covered.
  it('disables the picker while a drift/unconfirmed banner is showing, so a re-pick cannot silently discard itself', async () => {
    await pickThenFlipGateTo(false);
    await screen.findByText('Could not confirm the discount-stacking status — retry before saving.');
    const picker = screen.getByLabelText('Appointment discount');
    expect(picker.disabled).toBe(true);
    // The DOM `disabled` attribute stops genuine user interaction; the
    // handler ALSO refuses a re-pick directly (pickAppointmentDiscount's
    // own discountSaveBlockedReason guard) so a change event delivered by
    // any other means still cannot re-freeze the snapshot to the live,
    // still-drifted value. Re-selecting the SAME tier is enough to exercise
    // this — any non-empty presetId hits the guarded branch.
    fireEvent.change(picker, { target: { value: 'mil' } });
    expect(picker.value).toBe('mil');
    expect(screen.getByText('Military Discount: -$10.00')).toBeTruthy();
  });
});

describe('GitHub review round 1 on PR #4656', () => {
  // P1 (:2531): compound=false only changes STACKING ORDER in
  // stackVisitDiscounts, never its per-discount ROUNDING — it always uses
  // cent-exact integer half-up math. The server's UNGATED path
  // (calculateDiscountDollars) keeps the OLDER float rounding instead: 5%
  // of $20.70 is $1.03 there (IEEE754 float noise), never the half-up
  // $1.04. groupStackedPerVisitTotal ran the stacked engine even with the
  // gate off and even with NO appointment discount selected at all — an
  // ordinary per-LINE discount, unrelated to this PR's own feature, so the
  // collect-prepayment payload/preview disagreed with the persisted total
  // on plain gate-off bookings.
  it('gate OFF: the prepay preview uses the SAME legacy float rounding as the server, not stackVisitDiscounts\' cent-exact half-up', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: false, known: true, retry: vi.fn() });
    installModalFetch({
      basePrice: 20.70,
      discounts: [{
        id: 'five-pct', name: 'Five Percent', discount_type: 'percentage',
        amount: 5, is_active: true, show_in_invoices: true,
      }],
    });
    renderBooking();
    await addOneSeasonalService();
    // Gate off never renders the appointment-level picker — apply the
    // discount as an ordinary LINE pick, exactly like any pre-lane save.
    fireEvent.focus(screen.getByPlaceholderText('Search discounts for First seasonal service...'));
    fireEvent.click(await screen.findByRole('button', { name: /Five Percent/ }));
    fireEvent.change(screen.getByPlaceholderText('Ongoing'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Collect prepayment' }));
    // $20.70 - $1.03 (legacy float rounding) = $19.67/visit x 2 = $39.34.
    await screen.findByText((_, node) => node?.textContent === '2 visits × $19.67 = $39.34');
  });

  it('gate ON: the SAME line discount now goes through the cent-exact half-up engine (server\'s canonical restack)', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    installModalFetch({
      basePrice: 20.70,
      discounts: [{
        id: 'five-pct', name: 'Five Percent', discount_type: 'percentage',
        amount: 5, is_active: true, show_in_invoices: true,
      }],
    });
    renderBooking();
    await addOneSeasonalService();
    fireEvent.focus(screen.getByPlaceholderText('Search discounts for First seasonal service...'));
    fireEvent.click(await screen.findByRole('button', { name: /Five Percent/ }));
    fireEvent.change(screen.getByPlaceholderText('Ongoing'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Collect prepayment' }));
    // $20.70 - $1.04 (cent-exact half-up) = $19.66/visit x 2 = $39.32.
    await screen.findByText((_, node) => node?.textContent === '2 visits × $19.66 = $39.32');
  });

  // P1 (:2472): a candidate preset's non-stackable conflict must be checked
  // against the SUBMIT GROUP its OWN catalog scope actually resolves to —
  // not a fixed group[0] baseline. A split seasonal booking has one group
  // per seasonal line; a preset scoped to the SECOND line's service must be
  // checked against the SECOND group's own picks, not the first (empty) one.
  it('filters a scoped candidate against the submit group it actually resolves to, not always group[0]', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    installModalFetch({
      discounts: [
        {
          id: 'silver', name: 'Silver', discount_type: 'percentage', amount: 10,
          is_active: true, show_in_invoices: true, stack_group: 'tier',
        },
        {
          id: 'gold', name: 'Gold', discount_type: 'percentage', amount: 15,
          is_active: true, show_in_invoices: true, stack_group: 'tier',
          service_key_filter: 'svc_second',
        },
      ],
    });
    renderBooking();
    await addTwoSeasonalServices();
    // Silver goes on the SECOND line — its own (second) submit group.
    fireEvent.focus(screen.getByPlaceholderText('Search discounts for Second seasonal service...'));
    fireEvent.click(await screen.findByRole('button', { name: /Silver/ }));
    await screen.findByText('Silver - 10%');
    // Gold is scoped to svc_second (the SECOND group) and shares Silver's
    // non-stackable tier group — it must be EXCLUDED from the appointment
    // picker's options. Checked against a fixed group[0] (First, no picks),
    // the pre-fix code found no conflict and wrongly offered it.
    const picker = await screen.findByLabelText('Appointment discount');
    const optionNames = Array.from(picker.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionNames.some((t) => t.startsWith('Gold'))).toBe(false);
  });

  // P1 (:3100): the freshness check must be the LAST thing before EACH
  // group's own POST, re-run per group in a multi-group (split seasonal)
  // save — not just once up front, before mosquito/address-ask awaits and
  // any earlier groups' own POSTs.
  it('re-checks the gate freshness before EVERY group\'s POST in a multi-group save, not only once up front', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    // First group's own pre-POST probe still agrees with the pick-time
    // snapshot; the SECOND group's probe finds the gate has since moved.
    vi.mocked(ensureStackingFresh)
      .mockResolvedValueOnce({ enabled: true, known: true })
      .mockResolvedValueOnce({ enabled: false, known: true });
    const { fetcher } = installModalFetch({ discounts: [{
      id: 'mil', name: 'Military Discount', discount_type: 'fixed_amount',
      amount: 10, is_active: true, show_in_invoices: true,
    }] });
    renderBooking();
    const submit = await addTwoSeasonalServices();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'mil' } });
    fireEvent.click(submit);
    // The first (unscoped -> first) group's POST lands; the second group's
    // own pre-POST check catches the drift and refuses to post it.
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    await screen.findByText('Could not confirm the discount-stacking status — retry before saving.');
    expect(schedulePosts(fetcher)).toHaveLength(1);
  });

  // P2 (:2021): the custom fixed-amount prompt only checked `amount > 0`,
  // so Infinity/1e309 passed through — the preview clamped it to a "free
  // visit" but JSON.stringify turns a non-finite discountAmount into null
  // on the wire, and the server falls back to the custom preset's catalog
  // amount of 0, saving the visit at full price.
  it('rejects a non-finite custom appointment-discount amount, matching the percentage prompt\'s own guard', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    installModalFetch({ discounts: [{
      id: 'custom-amt', name: 'Custom amount', discount_type: 'fixed_amount',
      discount_key: 'custom_dollar', amount: 0, is_active: true, show_in_invoices: true,
    }] });
    vi.spyOn(window, 'prompt').mockReturnValue('Infinity');
    renderBooking();
    await addOneSeasonalService();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'custom-amt' } });
    // Rejected outright — never applied, never shown as a "free visit".
    expect(picker.value).toBe('');
    expect(screen.queryByText(/Custom amount:/)).toBeNull();
  });
});

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
  servicesDropdownResponse,
  // Queued /admin/schedule/preview responses, consumed one per call — each
  // a function (groups) => { regime, results } (or throws, for a fetch
  // failure). Once exhausted, falls back to the default no-error echo.
  previewResponses,
} = {}) {
  let addressRequests = 0;
  let prepayPreviews = 0;
  let previewCalls = 0;
  const fetcher = vi.fn((input, options = {}) => {
    const url = String(input);
    if (url.includes('/admin/triage?')) {
      addressRequests += 1;
      if (addressRequests === 2 && submitAddressRequest) return submitAddressRequest.promise;
      return Promise.resolve(jsonResponse({ items: [] }));
    }
    if (url.includes('/admin/services?')) {
      // 'Monthly'/'Quarterly' return YEAR-ROUND recurring services (merge
      // into ONE submit group together, unlike the seasonal First/Second
      // pair below, each of which always books its own separate group).
      if (url.includes('Monthly') || url.includes('Quarterly')) {
        const monthName = url.includes('Monthly') ? 'Monthly recurring service' : 'Quarterly recurring service';
        return Promise.resolve(jsonResponse({
          services: [{
            id: url.includes('Monthly') ? 'service-monthly' : 'service-quarterly',
            service_key: url.includes('Monthly') ? 'svc_monthly' : 'svc_quarterly',
            name: monthName,
            billing_type: 'recurring',
            frequency: url.includes('Monthly') ? 'monthly' : 'quarterly',
            base_price: basePrice,
            default_duration_minutes: 30,
          }],
        }));
      }
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
    if (url.endsWith('/admin/schedule/services-dropdown')) {
      if (servicesDropdownResponse === undefined) throw new Error('services-dropdown not mocked for this test');
      return Promise.resolve(jsonResponse(servicesDropdownResponse));
    }
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
    // GitHub round 4 item 2 (Codex, blocked push 2 on PR #4656): the
    // debounced server-preview verification fetch — not asserted on by
    // most tests in this file, just needs a valid, non-throwing response
    // so an in-flight 350ms timer from an EARLIER test never leaks a
    // synchronous throw into a LATER one's execution window.
    if (url.endsWith('/admin/schedule/preview') && options.method === 'POST') {
      const groups = JSON.parse(options.body || '{}').groups || [];
      const queued = Array.isArray(previewResponses) ? previewResponses[previewCalls] : undefined;
      previewCalls += 1;
      if (queued) return Promise.resolve(jsonResponse(queued(groups)));
      // Echo one no-error, no-price result per requested group so
      // previewGroupError never blocks Submit in tests that don't
      // exercise it specifically. Deliberately NO `price` field: this
      // mock does not replicate real pricing math, and
      // groupStackedPerVisitTotal now reads a fresh preview row's price
      // when one is present (round 5 P0) -- a fabricated price here would
      // silently override every OTHER test's own (correct) locally-
      // computed display/prepay assertions once the debounce resolves.
      // Omitting it makes that same read fall through to the local
      // computation, unchanged, exactly as before this fix existed.
      return Promise.resolve(jsonResponse({ regime: true, results: groups.map((g) => ({ key: g.key })) }));
    }
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
  // P1 (:2531), UPDATED per the round 4 structural finding: compound=false
  // only changes STACKING ORDER in stackVisitDiscounts, never its
  // per-discount ROUNDING — it always uses cent-exact integer half-up
  // math. This test used to pin the server's UNGATED path
  // (calculateDiscountDollars) at the OLDER float rounding (5% of $20.70
  // as $1.03, IEEE754 float noise) to match it — that was correct at the
  // time, but slice 9 of #4405 (#4658, merged to main and into this
  // branch) made calculateDiscountDollars share the SAME cent-exact
  // percentageDiscountDollars helper for its own percentage branch
  // UNCONDITIONALLY ("not itself gated... whether or not
  // GATE_DISCOUNT_STACKING is live" — see that function's own comment;
  // also documented in this repo's CLAUDE.md: "The corrected cent-exact
  // rounding... is live regardless of the gate"). previewLineDiscount
  // (this component's own base per-line preview, used whenever no
  // appointment-level discount rides the group) still did the OLD plain
  // `baseAmount * (amt / 100)` float division, so after that merge landed
  // this component's gate-OFF preview UNDERSHOT the server's actual
  // persisted total by a cent on every gate-off percentage-discount line
  // — the exact class of bug this whole file exists to catch, just with
  // the mismatch now running the OTHER direction from what this test used
  // to pin. Fixed by sharing lib/discountStack's percentageDiscountDollars
  // in previewLineDiscount too, removing the legacy-float special case
  // outright rather than adding a second one to track.
  it('gate OFF: the prepay preview now matches the server\'s own cent-exact half-up rounding too, not the pre-slice-9 legacy float figure', async () => {
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
    // $20.70 - $1.04 (cent-exact half-up, matching the server regardless
    // of gate) = $19.66/visit x 2 = $39.32 — never the stale $19.67/$39.34
    // legacy-float figure.
    await screen.findByText((_, node) => node?.textContent === '2 visits × $19.66 = $39.32');
    expect(screen.queryByText((_, node) => node?.textContent === '2 visits × $19.67 = $39.34')).toBeNull();
  });

  it('gate ON: the SAME line discount goes through the cent-exact half-up engine (server\'s canonical restack), same figure as gate off', async () => {
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
  //
  // UPDATED per the round 4 structural fix (Codex, blocked push 2 on PR
  // #4656): the check now fires only for the group whose OWN pricing
  // depends on the live gate (groupRegimeDependent), not for every group
  // merely because a discount is selected somewhere. A SOLO fixed
  // appointment discount with no line discount on either group is
  // provably gate-invariant for BOTH groups (this engine's fixed-credit
  // pool and cent-exact rounding produce the identical total either way —
  // only a line discount actually interacting with the appointment
  // discount in the SAME group can move the total), so scoping the
  // discount to svc_first alone no longer exercises "checked per group,
  // not just once" the way the original (unscoped) fixture did. Scoped to
  // svc_second instead: the FIRST group (no discount at all) now legitimately
  // skips the check and posts with no probe call, and the SECOND group's
  // own check is the one that fires and catches the drift — still proving
  // the check runs at EACH group's own turn, on the group that actually
  // needs it, not once up front for the whole booking.
  it('re-checks the gate freshness before EVERY group\'s POST in a multi-group save, not only once up front', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    // The FIRST group carries no discount at all, so its own submit never
    // calls ensureStackingFresh — this single mocked resolution is
    // consumed by the SECOND group's own check, which finds the gate has
    // since moved.
    vi.mocked(ensureStackingFresh).mockResolvedValueOnce({ enabled: false, known: true });
    const { fetcher } = installModalFetch({ discounts: [{
      id: 'mil', name: 'Military Discount', discount_type: 'fixed_amount',
      amount: 10, is_active: true, show_in_invoices: true, service_key_filter: 'svc_second',
    }] });
    renderBooking();
    const submit = await addTwoSeasonalServices();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'mil' } });
    // GitHub round 4 item 2 (Codex, blocked push 2): a discount pick
    // starts a new debounced server-preview verification round; Submit is
    // held until it lands (previewConfirming) — wait for that here,
    // exactly as the operator would.
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    // The first group (no discount, gate-invariant) posts with no probe;
    // the second group's (scoped, discount-bearing) own pre-POST check
    // catches the drift and refuses to post it.
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body).discountId).toBeUndefined();
    await screen.findByText('Could not confirm the discount-stacking status — retry before saving.');
    expect(schedulePosts(fetcher)).toHaveLength(1);
    expect(ensureStackingFresh).toHaveBeenCalledTimes(1);
  });

  // Companion to the above: proves the NARROWING itself — a discount-free
  // group in a multi-group save must not get stuck behind an unrelated
  // group's own committed-then-drifted discount (the exact Codex P1: "the
  // remaining group carries no discount... the booking cannot finish in
  // this session").
  it('a discount-free group still saves cleanly even after the OTHER group committed a discount and the gate then drifted', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    const retry = vi.fn();
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry });
    const secondScheduleRequest = deferred();
    const { fetcher } = installModalFetch({
      secondScheduleRequest,
      discounts: [{
        id: 'mil', name: 'Military Discount', discount_type: 'fixed_amount', amount: 10,
        is_active: true, show_in_invoices: true, service_key_filter: 'svc_first',
      }],
    });
    const booking = renderBooking();
    const submit = await addTwoSeasonalServices();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'mil' } });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    // First (discount-bearing, scoped) commits; Second (no discount at
    // all) is still in flight.
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(2));
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body).discountId).toBe('mil');
    await act(async () => {
      secondScheduleRequest.resolve(jsonResponse({ error: 'failed' }, { ok: false, status: 500 }));
      await secondScheduleRequest.promise;
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Schedule appointment' }).disabled).toBe(false));

    // The gate drifts off AFTER the discount-bearing group already
    // committed. Per the round-4 :3513 fix, the frozen snapshot never
    // updates again — but the SECOND group carries no discount at all, so
    // its own retry must not get stuck behind that permanently-diverged
    // snapshot.
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: false, known: true, retry });
    booking.view.rerender(<CreateAppointmentModal
      defaultCustomer={CUSTOMER}
      defaultDate={booking.scheduledDate}
      defaultWindowStart="09:00"
      onClose={booking.onClose}
      onCreated={booking.onCreated}
      onChange={booking.onChange}
    />);
    const submit2 = screen.getByRole('button', { name: 'Schedule appointment' });
    expect(submit2.disabled).toBe(false);
    fireEvent.click(submit2);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(3));
    expect(JSON.parse(schedulePosts(fetcher)[2][1].body).discountId).toBeUndefined();
    expect(JSON.parse(schedulePosts(fetcher)[2][1].body).expected_discount_stacking).toBeUndefined();
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

  // P1 (GitHub round 1, extra thread :2196): the services-dropdown route
  // serves a HARDCODED fallback (no explicit flag) when its own
  // services-table query fails — an incomplete catalog, missing several
  // genuinely excluded keys. Trusting it as complete would preview (and
  // let Save through on) a percentage discount the server's real
  // exclusion catalog refuses on save. Detected client-side: every
  // fallback item lacks a real catalog `id` (built from a bare helper,
  // not a services-table row), unlike a real response.
  it('treats the services-dropdown fallback catalog as unresolved, never as a complete exclusion list', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    installModalFetch({
      discounts: [{
        id: 'ten-pct', name: 'Ten Percent', discount_type: 'percentage',
        amount: 10, is_active: true, show_in_invoices: true,
      }],
      // Shaped exactly like the route's real hardcoded fallback: items
      // with no `id` at all.
      servicesDropdownResponse: {
        groups: [{
          category: 'termite',
          items: [{
            name: 'Termite Bond', duration: 60, priceMin: 45, priceMax: 45,
            serviceKey: 'termite_bond_10yr', excludedFromPercentDiscount: true,
          }],
        }],
      },
    });
    renderBooking();
    await addOneSeasonalService();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'ten-pct' } });
    await screen.findByText('Could not confirm which services this percentage discount excludes — retry before saving.');
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    expect(submit.disabled).toBe(true);
  });

  // P1 (GitHub round 1, extra thread :2539): a percentage discount can
  // resolve a real submit GROUP (its own catalog scope matched one) while
  // still reaching ZERO lines within it — every matched service is
  // percent-excluded (e.g. a booking that is only a termite bond). The
  // preview/POST already compute $0 correctly, but Save stayed enabled
  // with the discount still visibly selected.
  it('blocks Save when a percentage discount matches a group but every line in it is percent-excluded', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    installModalFetch({
      discounts: [{
        id: 'ten-pct', name: 'Ten Percent', discount_type: 'percentage',
        amount: 10, is_active: true, show_in_invoices: true,
      }],
      // A REAL (id-bearing) catalog — never the fallback path above —
      // that marks the booking's only line as percent-excluded.
      servicesDropdownResponse: {
        groups: [{
          category: 'pest_control',
          items: [{
            id: 'svc-first-row', name: 'First seasonal service', duration: 30,
            serviceKey: 'svc_first', excludedFromPercentDiscount: true,
          }],
        }],
      },
    });
    renderBooking();
    await addOneSeasonalService();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'ten-pct' } });
    await screen.findByText('This appointment discount does not match any selected service. Change or remove it before saving.');
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove discount' }));
    await waitFor(() => expect(submit.disabled).toBe(false));
  });
});

describe('GitHub review round 2 on PR #4656', () => {
  // P1 (:1981): stack-group filtering must key off the FROZEN regime
  // (appointmentDiscountCompound), never the live stackingEnabled — a gate
  // drift after an appointment-level non-stackable tier was picked must
  // not expose the unfiltered catalog to the LINE pickers.
  it('keeps stack-group filtering active in the line picker during a gate drift', async () => {
    const retry = vi.fn();
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry });
    installModalFetch({
      discounts: [
        { id: 'silver', name: 'Silver', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true, stack_group: 'tier' },
        { id: 'gold', name: 'Gold', discount_type: 'percentage', amount: 15, is_active: true, show_in_invoices: true, stack_group: 'tier' },
      ],
    });
    const booking = renderBooking();
    await addOneSeasonalService();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'silver' } });
    await screen.findByText('Silver - 10%');

    // The poll drifts — the appointment slot stays frozen/shown, but the
    // live gate now disagrees.
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: false, known: true, retry });
    booking.view.rerender(<CreateAppointmentModal
      defaultCustomer={CUSTOMER}
      defaultDate={booking.scheduledDate}
      defaultWindowStart="09:00"
      onClose={booking.onClose}
      onCreated={booking.onCreated}
      onChange={booking.onChange}
    />);
    await screen.findByText('Could not confirm the discount-stacking status — retry before saving.');

    // The line-level picker must still hide Gold (same non-stackable tier
    // as the frozen appointment-level Silver) — never fall back to the
    // unfiltered catalog just because the live gate currently disagrees.
    fireEvent.focus(screen.getByPlaceholderText('Search discounts for First seasonal service...'));
    expect(screen.queryByRole('button', { name: /^Gold/ })).toBeNull();
  });

  // P1 (:4392): once any group of a split save has committed, the
  // appointment discount is frozen outright — a retry cannot replace or
  // remove it, and a change here can never reach the already-created group.
  it('freezes the appointment discount after a partial multi-group save', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    const secondScheduleRequest = deferred();
    const { fetcher } = installModalFetch({
      secondScheduleRequest,
      discounts: [{ id: 'mil', name: 'Military Discount', discount_type: 'fixed_amount', amount: 10, is_active: true, show_in_invoices: true }],
    });
    renderBooking();
    const submit = await addTwoSeasonalServices();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'mil' } });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    // First group's POST lands; the second is still in flight.
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(2));
    // A group has already committed — frozen now, before the second POST
    // even resolves.
    await waitFor(() => expect(screen.getByLabelText('Appointment discount').disabled).toBe(true));
    fireEvent.change(picker, { target: { value: '' } });
    expect(picker.value).toBe('mil');
    await act(async () => {
      secondScheduleRequest.resolve(jsonResponse({ error: 'failed' }, { ok: false, status: 500 }));
      await secondScheduleRequest.promise;
    });
    // Still frozen after the failure the operator would retry from.
    expect(screen.getByLabelText('Appointment discount').disabled).toBe(true);
  });

  // Carried finding: a cadence edit can MERGE two previously-separate
  // submit groups — an appointment-level tier scoped to a seasonal
  // service and a conflicting LINE tier on a separate quarterly service
  // are both valid picks while the groups are still separate; changing
  // the seasonal line's cadence to quarterly merges them, and the two
  // picks must be re-validated, not silently left to both persist.
  it('re-validates existing selections when a cadence edit merges their submit groups', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    installModalFetch({
      discounts: [
        { id: 'silver', name: 'Silver', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true, stack_group: 'tier', service_key_filter: 'svc_first' },
        { id: 'gold', name: 'Gold', discount_type: 'percentage', amount: 15, is_active: true, show_in_invoices: true, stack_group: 'tier' },
      ],
      // A REAL (id-bearing) catalog with nothing excluded — Silver (a
      // percentage discount) needs this resolved to actually reach its
      // line at all; an unresolved catalog would block Save on that
      // (already-tested) reason first, masking this one.
      servicesDropdownResponse: {
        groups: [{
          category: 'pest_control',
          items: [
            { id: 'svc-first-row', name: 'First seasonal service', duration: 30, serviceKey: 'svc_first', excludedFromPercentDiscount: false },
            { id: 'svc-quarterly-row', name: 'Quarterly recurring service', duration: 30, serviceKey: 'svc_quarterly', excludedFromPercentDiscount: false },
          ],
        }],
      },
    });
    renderBooking();
    await addOneSeasonalService();
    fireEvent.click(screen.getByRole('button', { name: /Add service/ }));
    fireEvent.change(screen.getByPlaceholderText('Search to add service'), { target: { value: 'Quarterly' } });
    fireEvent.click(await screen.findByRole('button', { name: /Quarterly recurring service/ }));

    // Silver rides the seasonal group (its own catalog scope).
    const apptPicker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(apptPicker, { target: { value: 'silver' } });
    await screen.findByText('Silver - 10%');

    // Gold on the quarterly line — valid right now: a DIFFERENT group.
    fireEvent.focus(screen.getByPlaceholderText('Search discounts for Quarterly recurring service...'));
    fireEvent.click(await screen.findByRole('button', { name: /Gold/ }));
    await screen.findByText('Gold (Quarterly recurring service)');
    expect(screen.queryByText(/can.t both apply/)).toBeNull();

    // The cadence edit merges the seasonal line into the SAME (quarterly)
    // group Gold already rides.
    const cadenceSelect = screen.getByLabelText('Repeats for First seasonal service');
    fireEvent.change(cadenceSelect, { target: { value: 'quarterly' } });
    await waitFor(() => expect(cadenceSelect.value).toBe('quarterly'));

    await screen.findByText("Gold and Silver can't both apply to the same line — remove one before saving.");
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    expect(submit.disabled).toBe(true);
  });

  // Carried finding (:2592/round-2 P1): the preview must stack in
  // SUBMISSION order (each group's own cadence-sorted lines), not raw UI
  // insertion order — stackVisitDiscounts' fixed-credit remainder
  // tie-break is by array index, so a different order can put an odd
  // remainder cent on a different line and change the FINAL total.
  it('previews the fully stacked total in submission (cadence-sorted) order, matching the server', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    installModalFetch({
      basePrice: 100,
      discounts: [
        { id: 'half-off', name: 'Half Off', discount_type: 'percentage', amount: 50, is_active: true, show_in_invoices: true },
        { id: 'credit', name: 'Ten Oh Three', discount_type: 'fixed_amount', amount: 10.03, is_active: true, show_in_invoices: true },
      ],
    });
    renderBooking();
    // Added in UI order Quarterly (first), Monthly (second) — the SERVER's
    // own cadence sort books the shorter interval (monthly) FIRST within
    // the merged year-round group, the OPPOSITE of UI insertion order.
    fireEvent.change(screen.getByPlaceholderText('Search services'), { target: { value: 'Quarterly' } });
    fireEvent.click(await screen.findByRole('button', { name: /Quarterly recurring service/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add service/ }));
    fireEvent.change(screen.getByPlaceholderText('Search to add service'), { target: { value: 'Monthly' } });
    fireEvent.click(await screen.findByRole('button', { name: /Monthly recurring service/ }));

    // 50% off the quarterly line (the UI-first, server-SECOND line).
    fireEvent.focus(screen.getByPlaceholderText('Search discounts for Quarterly recurring service...'));
    fireEvent.click(await screen.findByRole('button', { name: /Half Off/ }));

    const apptPicker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(apptPicker, { target: { value: 'credit' } });

    // $142.47 (server, monthly-first stacking order) — never $142.48 (the
    // pre-fix UI-insertion-order total).
    await screen.findByText((_, node) => node?.textContent === 'Total: $142.47');
    expect(screen.queryByText((_, node) => node?.textContent === 'Total: $142.48')).toBeNull();
  });
});

describe('GitHub review round 2 follow-up on PR #4656 (P0 :2571, P1 :4483)', () => {
  // P0: an UNSCOPED appointment discount always resolves to group[0] --
  // once one group has committed with it, removing that group's own
  // service must never let a retry re-resolve (and re-POST) the SAME
  // credit against whichever group is now first.
  it('never re-posts a committed appointment discount after removing its group and retrying', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    const secondScheduleRequest = deferred();
    const { fetcher } = installModalFetch({
      secondScheduleRequest,
      discounts: [{ id: 'mil', name: 'Military Discount', discount_type: 'fixed_amount', amount: 10, is_active: true, show_in_invoices: true }],
    });
    renderBooking();
    const submit = await addTwoSeasonalServices();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'mil' } });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    // First (unscoped -> group[0], "First seasonal service") group's POST
    // lands carrying the discount; the second is still in flight.
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(2));
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body).discountId).toBe('mil');
    await act(async () => {
      secondScheduleRequest.resolve(jsonResponse({ error: 'failed' }, { ok: false, status: 500 }));
      await secondScheduleRequest.promise;
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Schedule appointment' }).disabled).toBe(false));

    // Remove "First seasonal service" -- the ONLY line in the group that
    // actually committed the discount. Without the commit-lock, an
    // unscoped discount would now silently re-resolve to "Second seasonal
    // service"'s group (now group[0]) and re-post the same credit. WITH
    // the lock, the discount's own committed group no longer exists at
    // all -- correctly read as unmatched (the same
    // appointmentDiscountHasNoGroup path an unreachable scope already
    // uses), blocking Save with its own named recovery rather than
    // silently either re-posting OR silently dropping it.
    const removeButtons = screen.getAllByRole('button', { name: 'Remove line item' });
    fireEvent.click(removeButtons[0]);
    await screen.findByText('This appointment discount does not match any selected service. Change or remove it before saving.');
    const submit2 = screen.getByRole('button', { name: 'Schedule appointment' });
    expect(submit2.disabled).toBe(true);
    fireEvent.click(submit2);
    expect(schedulePosts(fetcher)).toHaveLength(2);

    // The labeled recovery unblocks the retry.
    fireEvent.click(screen.getByRole('button', { name: 'Remove discount' }));
    await waitFor(() => expect(submit2.disabled).toBe(false));
    fireEvent.click(submit2);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(3));
    // The retry's ONLY new POST (for "Second seasonal service") must NOT
    // carry the discount again -- it already saved once, on the group
    // that no longer exists.
    expect(JSON.parse(schedulePosts(fetcher)[2][1].body).discountId).toBeUndefined();
  });

  // P1: the discount picker must be locked from the SYNCHRONOUS instant
  // submit starts -- including the address-ask recheck await that runs
  // BEFORE the first appointment POST, well before any group has
  // committed (createdGroupKeysRef is still empty the whole time).
  it('refuses a discount change during the pre-POST address-ask recheck, and saves the price that was actually displayed', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    const submitAddressRequest = deferred();
    const { fetcher } = installModalFetch({
      submitAddressRequest,
      discounts: [{ id: 'mil', name: 'Military Discount', discount_type: 'fixed_amount', amount: 10, is_active: true, show_in_invoices: true }],
    });
    renderBooking();
    await addOneSeasonalService();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'mil' } });
    await screen.findByText('Military Discount: -$10.00');

    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    // Now inside the pre-POST address-ask recheck await -- no group has
    // committed yet (createdGroupKeysRef is still empty), but the
    // synchronous submit lock is already set.
    await waitFor(() => expect(picker.disabled).toBe(true));
    fireEvent.change(picker, { target: { value: '' } });
    expect(picker.value).toBe('mil');

    await act(async () => {
      submitAddressRequest.resolve(jsonResponse({ items: [] }));
      await submitAddressRequest.promise;
    });
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    // The saved price matches exactly what was displayed before the
    // refused mid-flight change -- discountId 'mil' still on the wire.
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body).discountId).toBe('mil');
  });
});

describe('GitHub review round 3 on PR #4656', () => {
  // P1 (:3471): a confirmed-off Retry after a group has ALREADY committed
  // the discount must never clear the local selection or claim it was
  // removed -- the committed group's own saved row still carries it.
  //
  // UPDATED per the round 4 structural finding (:3513, see
  // appointmentDiscountGateDrifted's own comment): this used to expect a
  // "Could not confirm..." banner to appear and require an explicit Retry
  // click even AFTER the discount's own group had already committed --
  // clicking that Retry used to also re-price the committed group under
  // the newly-live regime (the exact bug :3513 reports). Once retrying no
  // longer touches the committed group's frozen pricing at all, a drift
  // banner whose only remaining job would be to gate that now-inert Retry
  // serves no purpose -- Save simply stays enabled and the remaining group
  // posts without ever needing a confirmation click.
  it('preserves a committed appointment discount through a live gate drift, without ever blocking or requiring a Retry for it', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    const retry = vi.fn();
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry });
    const secondScheduleRequest = deferred();
    const { fetcher } = installModalFetch({
      secondScheduleRequest,
      discounts: [{ id: 'mil', name: 'Military Discount', discount_type: 'fixed_amount', amount: 10, is_active: true, show_in_invoices: true }],
    });
    const booking = renderBooking();
    const submit = await addTwoSeasonalServices();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'mil' } });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(2));
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body).discountId).toBe('mil');
    await act(async () => {
      secondScheduleRequest.resolve(jsonResponse({ error: 'failed' }, { ok: false, status: 500 }));
      await secondScheduleRequest.promise;
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Schedule appointment' }).disabled).toBe(false));

    // The background poll drifts to confirmed-off AFTER the first group
    // committed.
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: false, known: true, retry });
    booking.view.rerender(<CreateAppointmentModal
      defaultCustomer={CUSTOMER}
      defaultDate={booking.scheduledDate}
      defaultWindowStart="09:00"
      onClose={booking.onClose}
      onCreated={booking.onCreated}
      onChange={booking.onChange}
    />);

    // NEVER cleared, NEVER announced as removed, and NEVER blocked on a
    // confirmation banner -- the committed group's own saved row still
    // carries it, and nothing further depends on the now-drifted live gate.
    expect(screen.queryByText('Could not confirm the discount-stacking status — retry before saving.')).toBeNull();
    expect(screen.queryByText('Discount stacking is now off — the appointment discount was removed. Add it again if stacking comes back on.')).toBeNull();
    expect(screen.getByLabelText('Appointment discount').value).toBe('mil');
    expect(screen.getByText('Military Discount: -$10.00')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Schedule appointment' }).disabled).toBe(false);

    // The remaining group retries clean, with no Retry click needed --
    // locked to the ALREADY-committed group (round 2's own fix), so it
    // correctly does NOT re-carry it.
    const submit2 = screen.getByRole('button', { name: 'Schedule appointment' });
    fireEvent.click(submit2);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(3));
    expect(JSON.parse(schedulePosts(fetcher)[2][1].body).discountId).toBeUndefined();
  });

  // Codex pre-push audit P0 (round 11): checking createdGroupKeysRef's
  // overall SIZE (ANY group committed) instead of
  // appointmentDiscountCommittedGroupKeyRef (THIS discount's OWN group)
  // let an UNRELATED group's success "preserve" a discount that was never
  // actually saved anywhere -- its own (scoped) group still failed. That
  // preserved discount kept posting on retry while compound=false made
  // groupStackedPerVisitTotal stop reflecting it in the client-computed
  // prepaid.totalAmount, so the posted prepaid total and the server's own
  // discounted charge silently diverged.
  it('clears a discount whose OWN group never committed, even though an unrelated group already did', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    const retry = vi.fn();
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry });
    const secondScheduleRequest = deferred();
    const { fetcher } = installModalFetch({
      secondScheduleRequest,
      discounts: [{
        id: 'mil', name: 'Military Discount', discount_type: 'fixed_amount', amount: 10,
        is_active: true, show_in_invoices: true, service_key_filter: 'svc_second',
      }],
    });
    const booking = renderBooking();
    const submit = await addTwoSeasonalServices();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'mil' } });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    // "First seasonal service" (unrelated to the discount's own scope)
    // commits; "Second seasonal service" (the discount's OWN group) is
    // still in flight.
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(2));
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body).discountId).toBeUndefined();
    expect(JSON.parse(schedulePosts(fetcher)[1][1].body).discountId).toBe('mil');
    await act(async () => {
      secondScheduleRequest.resolve(jsonResponse({ error: 'failed' }, { ok: false, status: 500 }));
      await secondScheduleRequest.promise;
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Schedule appointment' }).disabled).toBe(false));

    // The gate flips off -- the discount was never actually saved anywhere.
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: false, known: true, retry });
    booking.view.rerender(<CreateAppointmentModal
      defaultCustomer={CUSTOMER}
      defaultDate={booking.scheduledDate}
      defaultWindowStart="09:00"
      onClose={booking.onClose}
      onCreated={booking.onCreated}
      onChange={booking.onChange}
    />);
    await screen.findByText('Could not confirm the discount-stacking status — retry before saving.');
    vi.mocked(ensureStackingFresh).mockResolvedValue({ enabled: false, known: true });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    // CLEARED and announced -- correctly, since it was never actually
    // saved anywhere, unlike the "own group already committed" case above.
    await screen.findByText('Discount stacking is now off — the appointment discount was removed. Add it again if stacking comes back on.');
    await waitFor(() => expect(screen.queryByLabelText('Appointment discount')).toBeNull());
  });
});

describe('GitHub review round 3 P1 :2116 on PR #4656', () => {
  // A REAL zero-percent, non-stackable catalog tier (WaveGuard Bronze) is
  // NOT a custom preset -- it has no discount_key and is not
  // variable_percentage. Selecting it must never prompt, and the posted
  // amount must stay the catalog's own 0, never an operator-typed value.
  it('never prompts for WaveGuard Bronze and posts no operator amount override', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('50');
    const { fetcher } = installModalFetch({
      discounts: [{
        id: 'bronze', name: 'WaveGuard Bronze', discount_type: 'percentage', amount: 0, is_active: true, show_in_invoices: true,
      }],
      servicesDropdownResponse: {
        groups: [{
          category: 'pest_control',
          items: [{ id: 'svc-first-row', name: 'First seasonal service', duration: 30, serviceKey: 'svc_first', excludedFromPercentDiscount: false }],
        }],
      },
    });
    renderBooking();
    await addOneSeasonalService();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'bronze' } });
    expect(promptSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(/WaveGuard Bronze: -\$/)).toBeNull();
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    const body = JSON.parse(schedulePosts(fetcher)[0][1].body);
    expect(body.discountId).toBe('bronze');
    // Never the prompt's '50' -- the catalog's own 0, untouched.
    expect(body.discountAmount).toBe(0);
  });
});

describe('GitHub review round 3 P2 :4599 on PR #4656', () => {
  // A LINE-vs-LINE conflict (no appointment-level discount involved at
  // all) has no single safe action pickAppointmentDiscount('') can take --
  // the banner must direct the operator to the per-line controls instead
  // of offering a button that silently does nothing.
  it('directs to the per-line controls instead of a no-op "Remove discount" button for a line-vs-line conflict', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    installModalFetch({
      discounts: [
        { id: 'silver', name: 'Silver', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true, stack_group: 'tier' },
        { id: 'gold', name: 'Gold', discount_type: 'percentage', amount: 15, is_active: true, show_in_invoices: true, stack_group: 'tier' },
      ],
      servicesDropdownResponse: {
        groups: [{
          category: 'pest_control',
          items: [
            { id: 'svc-first-row', name: 'First seasonal service', duration: 30, serviceKey: 'svc_first', excludedFromPercentDiscount: false },
            { id: 'svc-quarterly-row', name: 'Quarterly recurring service', duration: 30, serviceKey: 'svc_quarterly', excludedFromPercentDiscount: false },
          ],
        }],
      },
    });
    renderBooking();
    await addOneSeasonalService();
    fireEvent.click(screen.getByRole('button', { name: /Add service/ }));
    fireEvent.change(screen.getByPlaceholderText('Search to add service'), { target: { value: 'Quarterly' } });
    fireEvent.click(await screen.findByRole('button', { name: /Quarterly recurring service/ }));

    // Silver on the FIRST (seasonal) line, Gold on the quarterly line --
    // valid right now, two SEPARATE groups.
    fireEvent.focus(screen.getByPlaceholderText('Search discounts for First seasonal service...'));
    fireEvent.click(await screen.findByRole('button', { name: /Silver/ }));
    await screen.findByText('Silver (First seasonal service)');
    fireEvent.focus(screen.getByPlaceholderText('Search discounts for Quarterly recurring service...'));
    fireEvent.click(await screen.findByRole('button', { name: /Gold/ }));
    await screen.findByText('Gold (Quarterly recurring service)');

    // The cadence edit merges the two groups -- no appointment-level
    // discount is selected at all, so this is a pure LINE-vs-LINE conflict.
    fireEvent.change(screen.getByLabelText('Repeats for First seasonal service'), { target: { value: 'quarterly' } });
    await screen.findByText("Silver and Gold can't both apply to the same line — remove one from its line above before saving.");
    // The only "Remove discount" buttons are the two PER-LINE ones
    // (Silver's and Gold's own "x" controls) -- no banner-level button
    // was added for this reason, since it would be a no-op
    // (pickAppointmentDiscount('') clears nothing when no appointment-
    // level discount is selected at all).
    expect(screen.getAllByRole('button', { name: 'Remove discount' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Schedule appointment' }).disabled).toBe(true);
  });
});

describe('GitHub review round 3 disclosed audit item on PR #4656', () => {
  // A LINE-only booking (no appointment discount at all) still needs
  // submit-time gate revalidation -- groupStackedPerVisitTotal has used
  // the stacking gate for ROUNDING since round 1 regardless of whether an
  // appointment discount is selected. This mock's `ensureStackingFresh`
  // resolves DISAGREEING with the frozen `appointmentDiscountCompound`
  // snapshot the pick was made under, which is what this check actually
  // guards — the exact cents a stale vs. fresh regime would each produce
  // (a per-line-only case now agrees either way per the round 4 finding
  // below; a fixed-credit-plus-percentage interaction can still diverge)
  // is not what's being pinned here, only that a disagreement blocks
  // Save before the POST goes out at all.
  it('revalidates the gate before submit for a line-only prepay-collecting booking', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    vi.mocked(ensureStackingFresh).mockResolvedValueOnce({ enabled: false, known: true });
    const { fetcher } = installModalFetch({
      basePrice: 20.70,
      enablePrepay: true,
      discounts: [{ id: 'five-pct', name: 'Five Percent', discount_type: 'percentage', amount: 5, is_active: true, show_in_invoices: true }],
    });
    renderBooking();
    await addOneSeasonalService();
    // An ordinary LINE discount -- no appointment-level pick at all.
    fireEvent.focus(screen.getByPlaceholderText('Search discounts for First seasonal service...'));
    fireEvent.click(await screen.findByRole('button', { name: /Five Percent/ }));
    fireEvent.change(screen.getByPlaceholderText('Ongoing'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Collect prepayment' }));

    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const submitBtn = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submitBtn.disabled).toBe(false));
    fireEvent.click(submitBtn);
    // With zero groups committed (created: 0), submitFailureNotice routes
    // the block through the blocking alert, not a persistent on-screen
    // banner -- matching this file's own convention for a first-attempt
    // failure on a single-group booking.
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(
      expect.stringContaining('the discount-stacking setting changed while this was open'),
    ));
    expect(schedulePosts(fetcher)).toHaveLength(0);
  });
});

describe('GitHub review round 4 on PR #4656', () => {
  // P1 (:3185): manualPrepayPlan ("Bill annual prepay") prices through the
  // SAME groupStackedPerVisitTotal/regime as collectPrepay, so a
  // line-discounted booking with billAsManualPrepay armed depends on the
  // gate exactly like a collectPrepay booking does — but the submit-time
  // revalidation used to check collectPrepay only. Mirrors the existing
  // "revalidates the gate before submit for a line-only prepay-collecting
  // booking" pin one section up, with "Bill annual prepay" armed instead
  // of the "Collect prepayment" checkbox.
  it('revalidates the gate before submit for a manual annual-prepay booking with a line discount', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    vi.mocked(ensureStackingFresh).mockResolvedValueOnce({ enabled: false, known: true });
    const { fetcher } = installModalFetch({
      basePrice: 20.70,
      enablePrepay: true,
      discounts: [{ id: 'five-pct', name: 'Five Percent', discount_type: 'percentage', amount: 5, is_active: true, show_in_invoices: true }],
    });
    renderBooking();
    await addOneSeasonalService();
    // An ordinary LINE discount -- no appointment-level pick at all.
    fireEvent.focus(screen.getByPlaceholderText('Search discounts for First seasonal service...'));
    fireEvent.click(await screen.findByRole('button', { name: /Five Percent/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Annual prepay — invoices/ }));

    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const submitBtn = screen.getByRole('button', { name: 'Schedule appointment' });
    fireEvent.click(submitBtn);
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(
      expect.stringContaining('the discount-stacking setting changed while this was open'),
    ));
    expect(schedulePosts(fetcher)).toHaveLength(0);
  });

  // P1 (:3513): once the discount's OWN group has committed under
  // stacking-ON, a LATER group's own failure followed by a live gate drift
  // to confirmed-off must not silently re-price the ALREADY-SAVED group
  // under the OTHER regime — appointmentDiscountGateSnapshot (and
  // therefore appointmentDiscountCompound, which appointmentDiscountPreview
  // reads directly every render) must stay frozen at whatever regime the
  // committed group actually saved under. No Retry banner/click is
  // involved here at all (see appointmentDiscountGateDrifted's own
  // comment) — the drift alone, with no action taken, must never move
  // the displayed total.
  it('keeps the committed group priced under its ORIGINAL regime through a live gate drift, with no banner or Retry needed', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    const retry = vi.fn();
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry });
    const secondScheduleRequest = deferred();
    const { fetcher } = installModalFetch({
      secondScheduleRequest,
      discounts: [
        { id: 'half', name: 'Half Off', discount_type: 'percentage', amount: 50, is_active: true, show_in_invoices: true },
        {
          id: 'credit', name: 'Ten Oh Three', discount_type: 'fixed_amount', amount: 10.03,
          is_active: true, show_in_invoices: true, service_key_filter: 'svc_first',
        },
      ],
    });
    const booking = renderBooking();
    const submit = await addTwoSeasonalServices();
    // 50% line discount on First -- the SAME line the scoped appointment
    // credit reaches, so their interaction (fixed credit BEFORE line
    // percentage, compound-ordered) actually changes the total by regime.
    fireEvent.focus(screen.getByPlaceholderText('Search discounts for First seasonal service...'));
    fireEvent.click(await screen.findByRole('button', { name: /Half Off/ }));
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'credit' } });

    // Compound (stacking ON): the $10.03 fixed credit comes off First's
    // full $100 FIRST ($89.97 left), then 50% off that remainder ($44.99)
    // -- $55.01 net for First, $100 untouched for Second -- $144.98 total.
    await screen.findByText((_, node) => node?.textContent === 'Total: $144.98');

    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(2));
    // First (the discount's own, scoped group) committed; Second is still
    // in flight.
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body).discountId).toBe('credit');
    await act(async () => {
      secondScheduleRequest.resolve(jsonResponse({ error: 'failed' }, { ok: false, status: 500 }));
      await secondScheduleRequest.promise;
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Schedule appointment' }).disabled).toBe(false));

    // The gate drifts to confirmed-off AFTER First already committed.
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: false, known: true, retry });
    booking.view.rerender(<CreateAppointmentModal
      defaultCustomer={CUSTOMER}
      defaultDate={booking.scheduledDate}
      defaultWindowStart="09:00"
      onClose={booking.onClose}
      onCreated={booking.onCreated}
      onChange={booking.onChange}
    />);
    // No banner, no block -- the discount's own group already committed,
    // so this drift changes nothing further to reconcile.
    expect(screen.queryByText('Could not confirm the discount-stacking status — retry before saving.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Schedule appointment' }).disabled).toBe(false);

    // The selection stays (round 3's own fix) AND its regime stays frozen
    // at stacking-ON (THIS fix) -- $144.98, never the $139.97 a re-priced
    // compound=false total would show for the ALREADY-SAVED First group.
    expect(screen.getByText((_, node) => node?.textContent === 'Total: $144.98')).toBeTruthy();
    expect(screen.queryByText((_, node) => node?.textContent === 'Total: $139.97')).toBeNull();
  });
});

describe('GitHub round 4 item 2: the preview request matches the real POST body (PR #4656)', () => {
  const previewPost = (fetcher) => fetcher.mock.calls.filter(
    ([url, options]) => String(url).endsWith('/admin/schedule/preview') && options?.method === 'POST',
  );
  const groupFromPreview = (fetcher, matchName) => {
    const [, options] = previewPost(fetcher).at(-1);
    const groups = JSON.parse(options.body).groups;
    return groups.find((g) => g.serviceType === matchName);
  };

  // The $142.47 case (fixed appointment credit + line percentage,
  // cadence-sorted): previewGroupRequests is built from the SAME
  // lineBaseAmount/lineDiscountFields/lineDiscountAmount closures the real
  // submit loop itself uses, so the preview request and the real POST
  // describe the identical group by construction — proven here by
  // comparing the two request bodies directly, not re-deriving the price.
  it('the $142.47 fixed-credit + line-percentage preview request matches the real POST for the same group', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    const { fetcher } = installModalFetch({
      basePrice: 100,
      discounts: [
        { id: 'half-off', name: 'Half Off', discount_type: 'percentage', amount: 50, is_active: true, show_in_invoices: true },
        { id: 'credit', name: 'Ten Oh Three', discount_type: 'fixed_amount', amount: 10.03, is_active: true, show_in_invoices: true },
      ],
    });
    renderBooking();
    fireEvent.change(screen.getByPlaceholderText('Search services'), { target: { value: 'Quarterly' } });
    fireEvent.click(await screen.findByRole('button', { name: /Quarterly recurring service/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add service/ }));
    fireEvent.change(screen.getByPlaceholderText('Search to add service'), { target: { value: 'Monthly' } });
    fireEvent.click(await screen.findByRole('button', { name: /Monthly recurring service/ }));
    fireEvent.focus(screen.getByPlaceholderText('Search discounts for Quarterly recurring service...'));
    fireEvent.click(await screen.findByRole('button', { name: /Half Off/ }));
    const apptPicker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(apptPicker, { target: { value: 'credit' } });
    await screen.findByText((_, node) => node?.textContent === 'Total: $142.47');

    await waitFor(() => expect(previewPost(fetcher).length).toBeGreaterThan(0));
    const previewGroup = groupFromPreview(fetcher, 'Monthly recurring service');
    expect(previewGroup).toMatchObject({
      discountId: 'credit', discountType: 'fixed_amount', discountAmount: 10.03,
      serviceAddons: [expect.objectContaining({ discountId: 'half-off', discountType: 'percentage', discountAmount: 50 })],
    });

    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    const realBody = JSON.parse(schedulePosts(fetcher)[0][1].body);
    // The SAME group, addressed by the SAME server-side field names,
    // carries the SAME discount identity/amounts either way. 'half-off'
    // rides the Quarterly line, which is the ADDON in server (monthly-
    // first) order — same as previewGroup.serviceAddons[0] above.
    expect(realBody.discountId).toBe(previewGroup.discountId);
    expect(realBody.discountAmount).toBe(previewGroup.discountAmount);
    expect(realBody.serviceAddons[0].discountId).toBe(previewGroup.serviceAddons[0].discountId);
    expect(realBody.serviceAddons[0].discountAmount).toBe(previewGroup.serviceAddons[0].discountAmount);
  });

  // The $39.32 case (line-only, collectPrepay): same parity proof for a
  // group with no appointment-level discount at all.
  it('the $39.32 line-only prepay preview request matches the real POST for the same group', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    const { fetcher } = installModalFetch({
      basePrice: 20.70,
      discounts: [{ id: 'five-pct', name: 'Five Percent', discount_type: 'percentage', amount: 5, is_active: true, show_in_invoices: true }],
    });
    renderBooking();
    await addOneSeasonalService();
    fireEvent.focus(screen.getByPlaceholderText('Search discounts for First seasonal service...'));
    fireEvent.click(await screen.findByRole('button', { name: /Five Percent/ }));
    fireEvent.change(screen.getByPlaceholderText('Ongoing'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Collect prepayment' }));
    await screen.findByText((_, node) => node?.textContent === '2 visits × $19.66 = $39.32');

    await waitFor(() => expect(previewPost(fetcher).length).toBeGreaterThan(0));
    const previewGroup = groupFromPreview(fetcher, 'First seasonal service');
    expect(previewGroup).toMatchObject({
      primaryLinePrice: 20.70,
      primaryLineDiscount: expect.objectContaining({ discountId: 'five-pct', discountType: 'percentage', discountAmount: 5 }),
      isRecurring: true, collectPrepay: true,
    });

    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    const realBody = JSON.parse(schedulePosts(fetcher)[0][1].body);
    expect(realBody.primaryLineDiscount?.discountId).toBe(previewGroup.primaryLineDiscount.discountId);
    expect(realBody.primaryLineDiscount?.discountAmount).toBe(previewGroup.primaryLineDiscount.discountAmount);
  });
});

describe('GitHub round 5 P1 (Codex, blocked push 5 on PR #4656) — explicit zero primary price parity', () => {
  const previewPost = (fetcher) => fetcher.mock.calls.filter(
    ([url, options]) => String(url).endsWith('/admin/schedule/preview') && options?.method === 'POST',
  );

  // The real submit body sends primaryLinePrice: 0 for a non-mosquito
  // primary EXPLICITLY priced at zero (groupHasPrice's own formula, in
  // appointmentGroupRequestBody) -- the preview request used to send
  // null instead (amountOrNull gated preserveZero to mosquito lines
  // only), inflating the preview to the catalog price and, with a
  // discounted paid add-on and collectPrepay, posting a HIGHER prepaid
  // total than the preview showed -- exactly what the server's own
  // PREPAY_TOTAL_DIVERGED check (round 4) would then reject.
  it('previews primaryLinePrice: 0 for an explicit-zero primary, matching the real POST, not null', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    const { fetcher } = installModalFetch({
      basePrice: 100,
      discounts: [{ id: 'half-off', name: 'Half Off', discount_type: 'percentage', amount: 50, is_active: true, show_in_invoices: true }],
    });
    renderBooking();
    fireEvent.change(screen.getByPlaceholderText('Search services'), { target: { value: 'Quarterly' } });
    fireEvent.click(await screen.findByRole('button', { name: /Quarterly recurring service/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add service/ }));
    fireEvent.change(screen.getByPlaceholderText('Search to add service'), { target: { value: 'Monthly' } });
    fireEvent.click(await screen.findByRole('button', { name: /Monthly recurring service/ }));
    // Monthly (server order: primary) explicitly priced at $0 -- a
    // deliberate waiver, not a blank/auto price.
    const priceInputs = screen.getAllByPlaceholderText('0.00');
    fireEvent.change(priceInputs[1], { target: { value: '0' } });
    // Quarterly (server order: addon) keeps its normal $100 and carries
    // the discount -- this is what makes the group regime-dependent and
    // starts the preview fetch at all.
    fireEvent.focus(screen.getByPlaceholderText('Search discounts for Quarterly recurring service...'));
    fireEvent.click(await screen.findByRole('button', { name: /Half Off/ }));

    await waitFor(() => expect(previewPost(fetcher).length).toBeGreaterThan(0));
    const [, options] = previewPost(fetcher).at(-1);
    const previewGroup = JSON.parse(options.body).groups.find((g) => g.serviceType === 'Monthly recurring service');
    expect(previewGroup.primaryLinePrice).toBe(0);

    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    const realBody = JSON.parse(schedulePosts(fetcher)[0][1].body);
    expect(realBody.primaryLinePrice).toBe(previewGroup.primaryLinePrice);
  });
});

describe('GitHub round 4 item 3 follow-up (Codex, blocked push 3 on PR #4656)', () => {
  // P1 (:3378): after the appointment-discount group commits,
  // appointmentDiscountCompound freezes (round 4's own :3513 fix) — a
  // DIFFERENT, remaining group that carries only ITS OWN line discount
  // (never the appointment discount at all) must revalidate against the
  // LIVE gate, not the appointment discount's now-permanently-frozen
  // snapshot. Before this fix, comparing every group against that one
  // frozen value meant a remaining group's own submit could never pass
  // again once the gate drifted post-commit, even when the live gate
  // genuinely matches what its OWN (never-frozen) total was computed
  // under.
  it("a remaining group's own line discount revalidates against the LIVE gate, not the committed group's frozen appointment-discount snapshot", async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    const retry = vi.fn();
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry });
    const secondScheduleRequest = deferred();
    const { fetcher } = installModalFetch({
      secondScheduleRequest,
      discounts: [
        {
          id: 'credit', name: 'Ten Oh Three', discount_type: 'fixed_amount', amount: 10.03,
          is_active: true, show_in_invoices: true, service_key_filter: 'svc_first',
        },
        { id: 'five-pct', name: 'Five Percent', discount_type: 'percentage', amount: 5, is_active: true, show_in_invoices: true },
      ],
    });
    const booking = renderBooking();
    const submit = await addTwoSeasonalServices();
    const picker = await screen.findByLabelText('Appointment discount');
    fireEvent.change(picker, { target: { value: 'credit' } });
    // Second group's OWN, unrelated line discount.
    fireEvent.focus(screen.getByPlaceholderText('Search discounts for Second seasonal service...'));
    fireEvent.click(await screen.findByRole('button', { name: /Five Percent/ }));
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    // First (the appointment discount's own, scoped group) commits;
    // Second (its own line discount) is still in flight.
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(2));
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body).discountId).toBe('credit');
    await act(async () => {
      secondScheduleRequest.resolve(jsonResponse({ error: 'failed' }, { ok: false, status: 500 }));
      await secondScheduleRequest.promise;
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Schedule appointment' }).disabled).toBe(false));

    // The gate drifts off AFTER First committed -- appointmentDiscountCompound
    // freezes at true (round 4's :3513 fix) and never updates again. The
    // NEW live value (false) is what ensureStackingFresh will confirm on
    // retry, and it's also what stackingEnabled (live) now reads --
    // Second's OWN revalidation must compare against THAT, not the frozen
    // snapshot, so a probe confirming the ALREADY-CURRENT live value must
    // not read as a mismatch.
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: false, known: true, retry });
    booking.view.rerender(<CreateAppointmentModal
      defaultCustomer={CUSTOMER}
      defaultDate={booking.scheduledDate}
      defaultWindowStart="09:00"
      onClose={booking.onClose}
      onCreated={booking.onCreated}
      onChange={booking.onChange}
    />);
    vi.mocked(ensureStackingFresh).mockResolvedValue({ enabled: false, known: true });
    const submit2 = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit2.disabled).toBe(false));
    fireEvent.click(submit2);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(3));
    // Second group's retry succeeded, carrying its OWN line discount --
    // never blocked behind First's unrelated, now-frozen snapshot.
    expect(JSON.parse(schedulePosts(fetcher)[2][1].body).primaryLineDiscount?.discountId).toBe('five-pct');
  });
});

describe('GitHub round 4 P1 :3916 (Codex, blocked push 4 on PR #4656)', () => {
  // A 'ready' preview response that still carries a per-group error is a
  // SUCCESSFUL fetch (not a network failure) -- the auto-retry above fires
  // once for exactly this case; a persistent (second) error surfaces
  // through discountSaveBlockedReason's own banner with a visible,
  // working Retry button, rather than leaving Save silently disabled.
  it('surfaces a persistent preview group error with a message and a working Retry, and clears once the retry succeeds', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    const { fetcher } = installModalFetch({
      basePrice: 100,
      discounts: [{ id: 'five-pct', name: 'Five Percent', discount_type: 'percentage', amount: 5, is_active: true, show_in_invoices: true }],
      previewResponses: [
        // Attempt 1 (initial).
        (groups) => ({ regime: true, results: groups.map((g) => ({ key: g.key, error: 'discount temporarily unavailable' })) }),
        // Attempt 2 (the ONE automatic retry) -- still failing, so it must
        // surface, not loop forever.
        (groups) => ({ regime: true, results: groups.map((g) => ({ key: g.key, error: 'discount temporarily unavailable' })) }),
        // Attempt 3 (the operator's own manual Retry click) -- resolves.
        (groups) => ({ regime: true, results: groups.map((g) => ({ key: g.key, price: 95 })) }),
      ],
    });
    renderBooking();
    await addOneSeasonalService();
    fireEvent.focus(screen.getByPlaceholderText('Search discounts for First seasonal service...'));
    fireEvent.click(await screen.findByRole('button', { name: /Five Percent/ }));

    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    // Exact string, not a substring/function predicate: a function
    // matcher checking textContent.includes(...) matches BOTH the
    // innermost <span> and its ancestor banner <div> (whose own
    // textContent also contains it), and getByText/findByText throw
    // "multiple elements" for that -- swallowed by findByText's own
    // retry loop until it times out, reading as "never found" instead of
    // the real ambiguity. An exact full-text match hits only the <span>.
    await screen.findByText(
      "Couldn't confirm today's price (discount temporarily unavailable) — retry before saving.",
      {},
      { timeout: 4000 },
    );
    expect(submit.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText("Couldn't confirm today's price (discount temporarily unavailable) — retry before saving.")).toBeNull(), { timeout: 4000 });
    await waitFor(() => expect(submit.disabled).toBe(false));

    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
  });
});

describe('GitHub round 4 item 1 (Codex, blocked push 4 on PR #4656) — prepaid total sourced from the preview', () => {
  // "close by construction... the create POST sends exactly the amounts
  // from that response" — the posted prepaid.totalAmount now comes from
  // serverPreview's OWN prepay.perVisit for a regime-dependent group, not
  // a second client-side recomputation of it. Deliberately queues a
  // per-visit figure ($42) that disagrees with what the naive local
  // $20.70-at-5%-off math would give ($19.66), so a pass here proves the
  // SERVER's number is what's actually posted, not a coincidence of
  // matching math.
  it('posts prepaid.totalAmount computed from the preview response, not the client engine', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    const { fetcher } = installModalFetch({
      basePrice: 20.70,
      enablePrepay: true,
      discounts: [{ id: 'five-pct', name: 'Five Percent', discount_type: 'percentage', amount: 5, is_active: true, show_in_invoices: true }],
      previewResponses: [
        (groups) => ({ regime: true, results: groups.map((g) => ({ key: g.key, price: 42, prepay: { perVisit: 42, totalAmount: 84 } })) }),
      ],
    });
    renderBooking();
    await addOneSeasonalService();
    fireEvent.focus(screen.getByPlaceholderText('Search discounts for First seasonal service...'));
    fireEvent.click(await screen.findByRole('button', { name: /Five Percent/ }));
    fireEvent.change(screen.getByPlaceholderText('Ongoing'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Collect prepayment' }));

    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    const body = JSON.parse(schedulePosts(fetcher)[0][1].body);
    // 2 visits x the PREVIEW's $42/visit = $84 -- never the client
    // engine's own $19.66/visit x 2 = $39.32.
    expect(body.prepaid.totalAmount).toBe(84);
  });

  // GitHub round 5 P0 (Codex, blocked push 5): the round-4 fix made the
  // POSTED prepaid.totalAmount preview-sourced without also making the
  // DISPLAYED "N visits x $X" text read the same number -- an operator
  // could see one figure and have a DIFFERENT one actually billed.
  // groupStackedPerVisitTotal (the one function both the display and the
  // POST now funnel through) reads a fresh preview row's price first, so
  // this proves the DISPLAY updates to match the preview too, not just
  // the wire.
  it('displays the "N visits x $X" prepay preview from the server preview, not the client engine, once it lands', async () => {
    vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: true, known: true, retry: vi.fn() });
    installModalFetch({
      basePrice: 20.70,
      discounts: [{ id: 'five-pct', name: 'Five Percent', discount_type: 'percentage', amount: 5, is_active: true, show_in_invoices: true }],
      previewResponses: [
        (groups) => ({ regime: true, results: groups.map((g) => ({ key: g.key, price: 42, prepay: { perVisit: 42, totalAmount: 84 } })) }),
      ],
    });
    renderBooking();
    await addOneSeasonalService();
    fireEvent.focus(screen.getByPlaceholderText('Search discounts for First seasonal service...'));
    fireEvent.click(await screen.findByRole('button', { name: /Five Percent/ }));
    fireEvent.change(screen.getByPlaceholderText('Ongoing'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Collect prepayment' }));

    // Before the preview lands, the local (client engine) figure still
    // shows -- this fix does not change that transient window.
    await screen.findByText((_, node) => node?.textContent === '2 visits × $19.66 = $39.32');
    // Once the preview resolves, the display SWITCHES to its number.
    await screen.findByText((_, node) => node?.textContent === '2 visits × $42.00 = $84.00');
    expect(screen.queryByText((_, node) => node?.textContent === '2 visits × $19.66 = $39.32')).toBeNull();
  });
});

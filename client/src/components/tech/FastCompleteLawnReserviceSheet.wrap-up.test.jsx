// @vitest-environment jsdom
// The lawn re-service Fast Complete sheet with the Wrap-up section (GATE_FAST_COMPLETE_WRAP_UP; owner
// 2026-10-10 "show on": the review request is shown and starts on). Gate off it is as it was; gate on and
// untouched it posts today's flags plus requestReview true (and no `reviewTiming`); a free callback
// shows no pay-link row and keeps includePayLink true; each change rides the body; the sheet is locked
// while the review send-time re-check reads. Synthetic data only.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FastCompleteLawnReserviceSheet from './FastCompleteLawnReserviceSheet';

vi.setConfig({ testTimeout: 30000 });

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

const CATALOG = [{ id: 'celsius', name: 'Celsius WG', category: 'herbicide', formulation: 'WG' }];
const VISIT = {
  id: 'svc-lawn', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-lawn', serviceKey: 'lawn_re_service',
  serviceType: 'Lawn Care Re-Service', scheduledDate: '2026-10-04', address: { line1: '123 Main St' }, status: 'confirmed',
};
const SERVICE = {
  id: 'svc-lawn', customerId: 'cust-1', customerName: 'Pat Jones', serviceType: 'Lawn Re-Service', address: '123 Main St', timeLabel: '2:00 PM',
  onSiteAt: new Date(Date.now() - 9 * 60 * 1000).toISOString(),
};
// A re-service the billing rule says invoices (it carries a price): the pay-link row follows that rule.
const BILLED_SERVICE = { ...SERVICE, estimatedPrice: 90, createInvoiceOnComplete: true };
const PREVIEW = { schedulerEnabled: true, at: '2026-10-12T14:00:00.000Z', bucket: 'b1', reviewSequencesEnabled: true, cadenceTickMinutesOfHour: [14, 44] };

function contextOf(wrapUp) {
  return {
    enabled: true, eligible: true, reason: null, service: VISIT, customerRequest: null, products: CATALOG,
    methods: [{ value: 'spot_treatment', label: 'Spot treatment', common: true, requiresSqft: false }],
    lawnSqft: 6400,
    lastVisit: {
      serviceRecordId: 'rec-1', serviceDate: '2026-09-20', serviceType: 'Lawn Care',
      products: [{ productId: 'celsius', name: 'Celsius WG', totalAmount: 1.5, amountUnit: 'oz', method: 'spot_treatment', areaValue: null, areaUnit: null }],
    },
    ...(wrapUp ? { wrapUp: true } : {}),
  };
}

// `holdRereads`: the first send-time read answers, later ones wait for request.release().
function makeRequest({ wrapUp = true, seeds = { exteriorMinutes: 30, interiorMinutes: 0 }, nextVisit = null, holdRereads = false } = {}) {
  const calls = [];
  const held = [];
  let previewReads = 0;
  const request = vi.fn(async (path, options) => {
    calls.push({ path, body: options?.body ? JSON.parse(options.body) : null });
    const bare = path.split('?')[0];
    if (bare.endsWith('/lawn-reservice/fast-context')) return contextOf(wrapUp);
    if (bare.endsWith('/reentry-defaults')) return seeds;
    if (bare === '/admin/schedule/next-visit') return { nextVisit };
    if (bare === '/admin/reviews/send-time-preview') {
      previewReads += 1;
      if (holdRereads && previewReads > 1) return new Promise((resolve) => { held.push(() => resolve(PREVIEW)); });
      return PREVIEW;
    }
    if (bare.endsWith('/complete')) return { success: true };
    return {};
  });
  request.calls = calls;
  request.completes = () => calls.filter((call) => call.path.endsWith('/complete'));
  request.reads = (pattern) => calls.filter((call) => pattern.test(call.path));
  request.release = () => held.forEach((resolve) => resolve());
  return request;
}

async function openSheet(request, service = SERVICE, props = {}) {
  render(<FastCompleteLawnReserviceSheet service={service} request={request} onClose={() => {}} {...props} />);
  await screen.findByRole('button', { name: /^Celsius WG/ });
}
const issue = (name) => within(screen.getByRole('heading', { name: 'Treating for' }).closest('section')).getByRole('button', { name });
// Celsius on, the three required taps set.
function tapRequired() {
  fireEvent.click(screen.getByRole('button', { name: /^Celsius WG/ }));
  fireEvent.click(issue('Dollarweed'));
  fireEvent.click(within(within(screen.getByRole('group', { name: 'Celsius WG' })).getByRole('group', { name: 'For' })).getByRole('button', { name: 'Dollarweed' }));
  fireEvent.click(screen.getByRole('button', { name: 'Moderate' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fair' }));
  fireEvent.click(within(within(screen.getByRole('group', { name: 'Celsius WG' })).getByRole('group', { name: 'Where' })).getByRole('button', { name: 'Front lawn' }));
}
const completeButton = () => screen.getByRole('button', { name: 'Complete lawn re-service' });
async function complete(request) {
  fireEvent.click(completeButton());
  await waitFor(() => expect(request.completes().length).toBeGreaterThan(0));
  return request.completes()[0].body;
}
const wrapUpHeading = () => screen.queryByRole('heading', { name: 'Wrap-up' });
const WRAP_UP_KEYS = ['reviewTiming', 'reviewDelayMinutes', 'reviewScheduledFor', 'timeOnSite', 'reentryExteriorMinutes', 'reentryInteriorMinutes', 'nextVisitAdjustmentNote'];
// What the sheet posts today.
const TODAY = { sendCompletionSms: true, requestReview: false, includePayLink: true };

describe('gate off (the context carries no wrapUp)', () => {
  test('no Wrap-up, no extra reads, and today\'s flags exactly (no customerRecapMode)', async () => {
    const request = makeRequest({ wrapUp: false });
    await openSheet(request);
    tapRequired();
    expect(wrapUpHeading()).toBeNull();
    const body = await complete(request);
    expect(body).toMatchObject(TODAY);
    expect(body).not.toHaveProperty('customerRecapMode');
    for (const key of [...WRAP_UP_KEYS, 'wrapUpReviewAsk']) expect(body).not.toHaveProperty(key);
    expect(request.reads(/reentry-defaults|next-visit|send-time-preview/)).toEqual([]);
  });
});

describe('gate on', () => {
  test('shows the section; untouched it posts today\'s body with one change: requestReview true', async () => {
    const request = makeRequest();
    await openSheet(request);
    expect(await screen.findByRole('heading', { name: 'Wrap-up' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Send review request' }).checked).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'Send completion text' }).checked).toBe(true);
    expect(screen.getAllByRole('heading', { name: 'Time on-site' })).toHaveLength(1);
    // A free callback invoices nothing: no pay-link row, and the pay link stays at today's true.
    expect(screen.queryByRole('checkbox', { name: /Include payment link/ })).toBeNull();
    tapRequired();
    const body = await complete(request);
    expect(body).toMatchObject({ ...TODAY, requestReview: true, wrapUpReviewAsk: true });
    expect(body).not.toHaveProperty('customerRecapMode');
    for (const key of WRAP_UP_KEYS) expect(body).not.toHaveProperty(key);
  });

  test('a visit that invoices shows the pay-link row, on, and the choice rides the body', async () => {
    const request = makeRequest();
    await openSheet(request, BILLED_SERVICE);
    const row = await screen.findByRole('checkbox', { name: /Include payment link/ });
    expect(row.checked).toBe(true);
    fireEvent.click(row);
    tapRequired();
    const body = await complete(request);
    expect(body).toMatchObject({ sendCompletionSms: true, requestReview: true, wrapUpReviewAsk: true, includePayLink: false });
  });

  test('each change rides the body', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'op-1', role: 'admin' }));
    const request = makeRequest({ nextVisit: { id: 'svc-2', date: '2026-11-05', serviceType: 'Lawn Care' } });
    await openSheet(request);
    fireEvent.change(await screen.findByLabelText('Adjust time on site (minutes)'), { target: { value: '35' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Decrease Exterior (dry-down) by 5 minutes' }));
    fireEvent.change(screen.getByLabelText('Review request timing'), { target: { value: 'tomorrow_8' } });
    tapRequired();
    const body = await complete(request);
    expect(body).toMatchObject({
      ...TODAY, requestReview: true, wrapUpReviewAsk: true, reviewTiming: 'tomorrow_8', reviewDelayMinutes: 0, timeOnSite: 35, reentryExteriorMinutes: 25,
    });
    expect(body.reviewScheduledFor).toMatch(/^\d{4}-\d{2}-\d{2}T08:00$/);
  });

  test('review off posts today\'s requestReview false and no timing', async () => {
    const request = makeRequest();
    await openSheet(request);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    tapRequired();
    const body = await complete(request);
    expect(body).toMatchObject(TODAY);
    for (const key of [...WRAP_UP_KEYS, 'wrapUpReviewAsk']) expect(body).not.toHaveProperty(key);
  });
});

describe('while the review send time is being re-checked', () => {
  const previewReads = (request) => request.reads(/send-time-preview/).length;

  async function startHeldComplete(props = {}) {
    const request = makeRequest({ holdRereads: true });
    await openSheet(request, SERVICE, props);
    tapRequired();
    await waitFor(() => expect(previewReads(request)).toBeGreaterThan(0));
    fireEvent.click(completeButton());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' }).disabled).toBe(true));
    return request;
  }

  test('the form, Complete, Close and Esc are inert, a second tap does nothing, and nothing is posted', async () => {
    const onClose = vi.fn();
    const request = await startHeldComplete({ onClose });
    expect(screen.getByRole('checkbox', { name: 'Send completion text' }).matches(':disabled')).toBe(true);
    expect(completeButton().disabled).toBe(true);
    const before = previewReads(request);
    fireEvent.click(completeButton());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(previewReads(request)).toBe(before);
    expect(onClose).not.toHaveBeenCalled();
    expect(request.completes()).toHaveLength(0);
    await act(async () => { request.release(); });
    await waitFor(() => expect(request.completes().length).toBe(1));
  });

  test('an answer that lands after the sheet is gone posts nothing', async () => {
    const request = await startHeldComplete();
    cleanup();
    await act(async () => { request.release(); });
    await act(async () => { await Promise.resolve(); });
    expect(request.completes()).toHaveLength(0);
  });
});

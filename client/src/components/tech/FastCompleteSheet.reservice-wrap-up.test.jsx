// @vitest-environment jsdom
// The pest re-service SHORT form with the Wrap-up section (GATE_FAST_COMPLETE_WRAP_UP; owner 2026-10-10
// "show on": the review request is shown and starts on). Gate off it is as it was; gate on and untouched
// it posts what it posts today plus requestReview true; the fixed text carries no pay link, so the section
// has no pay-link row and the pay link stays false; with the fixed text itself off (GATE_FAST_COMPLETE_RECAP)
// the section is not shown and the all-false flags go; the sheet is locked while the review send-time
// re-check reads. Synthetic data only.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FastCompleteSheet from './FastCompleteSheet';

vi.setConfig({ testTimeout: 30000 });

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

const CATALOG = [
  { id: 'taurus', name: 'Taurus SC', category: 'Insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' },
  { id: 'talstar', name: 'Atticus Talak 7.9 F', category: 'Insecticide' },
  { id: 'surfactant', name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant' },
];
const VISIT = {
  id: 'svc-1', customerName: 'Pat Jones', hasPhone: true, customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-1',
  serviceType: 'Pest Control Re-Service', scheduledDate: '2026-09-26', address: { line1: '123 Main St' },
  serviceKey: 'pest_re_service', status: 'confirmed',
};
const SERVICE = {
  id: 'svc-1', customerId: 'cust-1', customerName: 'Pat Jones', serviceType: 'Pest Re-Service', address: '123 Main St', timeLabel: '2:00 PM',
  recapEnabled: true, estimatedPrice: 95, createInvoiceOnComplete: true, onSiteAt: new Date(Date.now() - 9 * 60 * 1000).toISOString(),
};
const PREVIEW = { schedulerEnabled: true, at: '2026-10-12T14:00:00.000Z', bucket: 'b1', reviewSequencesEnabled: true, cadenceTickMinutesOfHour: [14, 44] };

// `holdRereads`: the first send-time read answers, later ones wait for request.release().
function makeRequest({ wrapUp = true, seeds = { exteriorMinutes: 30, interiorMinutes: 0 }, nextVisit = null, holdRereads = false } = {}) {
  const calls = [];
  const held = [];
  let previewReads = 0;
  const request = vi.fn(async (path, options) => {
    calls.push({ path, body: options?.body ? JSON.parse(options.body) : null });
    const bare = path.split('?')[0];
    if (bare.endsWith('/pest-recap/context')) return { ok: true, eligible: true, service: VISIT, products: CATALOG, existingRecord: null, ...(wrapUp ? { wrapUp: true } : {}) };
    if (bare.endsWith('/tech-rating-allowed')) return { allowed: true, scaleLabels: null };
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
  render(<FastCompleteSheet service={service} request={request} onClose={() => {}} {...props} />);
  await screen.findByRole('button', { name: /Taurus SC/ });
}
const tapRequired = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
  fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
  fireEvent.click(screen.getByRole('button', { name: 'Moderate' }));
};
const completeButton = () => screen.getByRole('button', { name: 'Complete re-service' });
async function complete(request) {
  fireEvent.click(completeButton());
  await waitFor(() => expect(request.completes().length).toBeGreaterThan(0));
  return request.completes()[0].body;
}
const wrapUpHeading = () => screen.queryByRole('heading', { name: 'Wrap-up' });
const WRAP_UP_KEYS = ['reviewTiming', 'reviewDelayMinutes', 'reviewScheduledFor', 'timeOnSite', 'reentryExteriorMinutes', 'reentryInteriorMinutes', 'nextVisitAdjustmentNote'];
// What the short form posts today with the fixed text on.
const TODAY = { sendCompletionSms: true, requestReview: false, includePayLink: false, customerRecapMode: 'reservice_fixed' };

describe('gate off (the context carries no wrapUp)', () => {
  test('no Wrap-up, no extra reads, and today\'s flags exactly', async () => {
    const request = makeRequest({ wrapUp: false });
    await openSheet(request);
    tapRequired();
    expect(wrapUpHeading()).toBeNull();
    const body = await complete(request);
    expect(body).toMatchObject(TODAY);
    for (const key of [...WRAP_UP_KEYS, 'wrapUpReviewAsk']) expect(body).not.toHaveProperty(key);
    expect(request.reads(/reentry-defaults|next-visit|send-time-preview/)).toEqual([]);
  });

  test('the fixed text off (GATE_FAST_COMPLETE_RECAP): all-false flags, as before', async () => {
    const request = makeRequest({ wrapUp: false });
    await openSheet(request, { ...SERVICE, recapEnabled: false });
    tapRequired();
    const body = await complete(request);
    expect(body).toMatchObject({ sendCompletionSms: false, requestReview: false, includePayLink: false });
    expect(body).not.toHaveProperty('customerRecapMode');
  });
});

describe('gate on', () => {
  test('shows the section; untouched it posts today\'s body with one change: requestReview true', async () => {
    const request = makeRequest();
    await openSheet(request);
    expect(await screen.findByRole('heading', { name: 'Wrap-up' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Send review request' }).checked).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'Send completion text' }).checked).toBe(true);
    // The fixed text carries no pay link: no row, even on a visit that invoices.
    expect(screen.queryByRole('checkbox', { name: /Include payment link/ })).toBeNull();
    tapRequired();
    const body = await complete(request);
    expect(body).toMatchObject({ ...TODAY, requestReview: true, wrapUpReviewAsk: true });
    for (const key of WRAP_UP_KEYS) expect(body).not.toHaveProperty(key);
  });

  test('the section sits after the tip area and the clock shows once', async () => {
    await openSheet(makeRequest());
    expect(await screen.findByRole('heading', { name: 'Wrap-up' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: 'Time on-site' })).toHaveLength(1);
  });

  test('each change rides the body; the pay link stays false', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'op-1', role: 'admin' }));
    const request = makeRequest({ nextVisit: { id: 'svc-2', date: '2026-11-05', serviceType: 'Pest Control' } });
    await openSheet(request);
    fireEvent.change(await screen.findByLabelText('Adjust time on site (minutes)'), { target: { value: '35' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Decrease Exterior (dry-down) by 5 minutes' }));
    fireEvent.change(screen.getByLabelText('Review request timing'), { target: { value: 'tomorrow_8' } });
    tapRequired();
    const body = await complete(request);
    expect(body).toMatchObject({
      ...TODAY, requestReview: true, wrapUpReviewAsk: true, includePayLink: false, reviewTiming: 'tomorrow_8', reviewDelayMinutes: 0, timeOnSite: 35, reentryExteriorMinutes: 25,
    });
    expect(body.reviewScheduledFor).toMatch(/^\d{4}-\d{2}-\d{2}T08:00$/);
  });

  test('review off posts requestReview false and no timing', async () => {
    const request = makeRequest();
    await openSheet(request);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    tapRequired();
    const body = await complete(request);
    expect(body).toMatchObject(TODAY);
    for (const key of [...WRAP_UP_KEYS, 'wrapUpReviewAsk']) expect(body).not.toHaveProperty(key);
  });

  test('completion text off posts sendCompletionSms false and keeps the fixed-text mode (the server accepts it)', async () => {
    const request = makeRequest();
    await openSheet(request);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send completion text' }));
    tapRequired();
    const body = await complete(request);
    expect(body).toMatchObject({ sendCompletionSms: false, includePayLink: false, customerRecapMode: 'reservice_fixed', requestReview: true, wrapUpReviewAsk: true });
  });

  test('the fixed text off (GATE_FAST_COMPLETE_RECAP): no section at all, and the all-false flags go', async () => {
    const request = makeRequest();
    await openSheet(request, { ...SERVICE, recapEnabled: false });
    tapRequired();
    expect(wrapUpHeading()).toBeNull();
    const body = await complete(request);
    expect(body).toMatchObject({ sendCompletionSms: false, requestReview: false, includePayLink: false });
    expect(body).not.toHaveProperty('customerRecapMode');
    for (const key of [...WRAP_UP_KEYS, 'wrapUpReviewAsk']) expect(body).not.toHaveProperty(key);
    expect(request.reads(/reentry-defaults|next-visit|send-time-preview/)).toEqual([]);
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
    // The answer lands: the sheet unlocks and posts once.
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

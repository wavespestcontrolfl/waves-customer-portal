// @vitest-environment jsdom
// Tree & Shrub Fast Complete with the Wrap-up section (GATE_FAST_COMPLETE_WRAP_UP): gate off the
// sheet is as it was (no section, no clock, no extra reads, the four customer-text flags); gate on
// and untouched it posts the same four flags; each change rides the /complete body.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FastCompleteTreeShrubSheet from './FastCompleteTreeShrubSheet';

vi.mock('../../lib/completion-photo', () => ({
  prepareCompletionPhoto: vi.fn(async (file) => ({
    data: `data:image/jpeg;base64,${file.name}`,
    name: file.name,
    capturedAt: '2026-10-04T14:00:00.000Z',
  })),
}));
vi.setConfig({ testTimeout: 30000 });

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

const CATALOG = [{ id: 'iron', name: 'Chelated Iron Plus', category: 'micronutrient', tsFlags: {} }];
const VISIT = {
  id: 'svc-ts', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-ts',
  serviceType: 'Tree & Shrub Program', scheduledDate: '2026-10-04', address: { line1: '123 Main St' }, status: 'confirmed',
};
const SERVICE = {
  id: 'svc-ts', customerId: 'cust-1', customerName: 'Pat Jones', serviceType: 'Tree & Shrub', address: '123 Main St', timeLabel: '2:00 PM',
  onSiteAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
};
const context = (wrapUp) => ({
  eligible: true, reason: null, service: VISIT, products: CATALOG,
  monthProducts: [{ productId: 'iron', method: 'foliar_spray' }],
  lastVisit: { plantGroups: ['Palms'], areasTreated: [], products: [] },
  warnings: [],
  ...(wrapUp ? { wrapUp: true } : {}),
});
const PREVIEW = { schedulerEnabled: true, at: '2026-10-12T14:00:00.000Z', bucket: 'b1', reviewSequencesEnabled: true, cadenceTickMinutesOfHour: [14, 44] };

// `holdRereads`: the first preview read answers, every later one waits until request.release().
function makeRequest({ wrapUp = true, previews = [PREVIEW], seeds = { exteriorMinutes: 30, interiorMinutes: 0 }, nextVisit = null, holdRereads = false } = {}) {
  const calls = [];
  const queue = [...previews];
  const held = [];
  let previewReads = 0;
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/tree-shrub/fast-context')) return context(wrapUp);
    if (path.includes('/reentry-defaults')) return seeds;
    if (path.startsWith('/admin/schedule/next-visit')) return { nextVisit };
    if (path.startsWith('/admin/reviews/send-time-preview')) {
      previewReads += 1;
      if (holdRereads && previewReads > 1) return new Promise((resolve) => { held.push(() => resolve(PREVIEW)); });
      return queue.length > 1 ? queue.shift() : queue[0];
    }
    if (path.endsWith('/tech-tips')) return { available: false };
    if (path.endsWith('/complete')) return { success: true };
    return {};
  });
  request.calls = calls;
  request.release = () => held.forEach((resolve) => resolve());
  return request;
}

async function openSheet(request, props = {}) {
  render(<FastCompleteTreeShrubSheet service={SERVICE} request={request} onClose={() => {}} {...props} />);
  await screen.findByRole('button', { name: /^Chelated Iron Plus/ });
  fireEvent.change(screen.getByLabelText('Front beds photo file'), { target: { files: [new File(['x'], 'front.jpg', { type: 'image/jpeg' })] } });
  await screen.findByAltText('Front beds photo');
  fireEvent.change(screen.getByLabelText('Back or side landscape photo file'), { target: { files: [new File(['x'], 'back.jpg', { type: 'image/jpeg' })] } });
  await screen.findByAltText('Back or side landscape photo');
  fireEvent.click(screen.getByRole('button', { name: 'Good' }));
}
const complete = async (request) => {
  fireEvent.click(screen.getByRole('button', { name: 'Complete tree & shrub' }));
  await waitFor(() => expect(request.calls.some((c) => c.path.endsWith('/complete'))).toBe(true));
  return JSON.parse(request.calls.find((c) => c.path.endsWith('/complete')).options.body);
};
const FOUR_FLAGS = { sendCompletionSms: true, requestReview: true, includePayLink: true, reviewTiming: 'auto' };
const WRAP_UP_KEYS = ['timeOnSite', 'reentryExteriorMinutes', 'reentryInteriorMinutes', 'nextVisitAdjustmentNote', 'reviewDelayMinutes', 'reviewScheduledFor'];
const opened = (request) => request.calls.map((c) => c.path);

describe('gate off', () => {
  test('no Wrap-up, no clock, no extra reads, and the four flags exactly', async () => {
    const request = makeRequest({ wrapUp: false });
    await openSheet(request);
    expect(screen.queryByRole('heading', { name: 'Wrap-up' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Time on-site' })).toBeNull();
    const body = await complete(request);
    expect(body).toMatchObject(FOUR_FLAGS);
    for (const key of WRAP_UP_KEYS) expect(body).not.toHaveProperty(key);
    expect(opened(request).filter((path) => /reentry-defaults|next-visit|send-time-preview/.test(path))).toEqual([]);
  });
});

describe('gate on', () => {
  test('shows the clock and the section after the tips, and untouched posts the same four flags', async () => {
    const request = makeRequest();
    await openSheet(request);
    expect(screen.getByRole('heading', { name: 'Time on-site' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Wrap-up' })).toBeTruthy();
    const body = await complete(request);
    expect(body).toMatchObject(FOUR_FLAGS);
    for (const key of WRAP_UP_KEYS) expect(body).not.toHaveProperty(key);
  });

  test('each change rides the body', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'op-1', role: 'admin' }));
    const request = makeRequest({ nextVisit: { id: 'svc-2', date: '2026-11-05', serviceType: 'Tree & Shrub' } });
    await openSheet(request);
    fireEvent.change(await screen.findByLabelText('Adjust time on site (minutes)'), { target: { value: '40' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Increase Exterior (dry-down) by 5 minutes' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Send completion text' }));
    fireEvent.change(screen.getByLabelText('Review request timing'), { target: { value: 'customer_requested' } });
    const body = await complete(request);
    expect(body).toMatchObject({
      sendCompletionSms: false, requestReview: true, includePayLink: true, reviewTiming: 'customer_requested', reviewDelayMinutes: 0, reviewScheduledFor: null,
      timeOnSite: 40, reentryExteriorMinutes: 35,
    });
    expect(body).not.toHaveProperty('reentryInteriorMinutes');
  });

  test('a changed Automatic review time stops the first Complete; the second goes', async () => {
    const request = makeRequest({ previews: [PREVIEW, { ...PREVIEW, bucket: 'b2' }] });
    await openSheet(request);
    await screen.findByRole('heading', { name: 'Wrap-up' });
    await waitFor(() => expect(opened(request).some((path) => path.startsWith('/admin/reviews/send-time-preview'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Complete tree & shrub' }));
    expect((await screen.findByRole('alert', {}, { timeout: 4000 })).textContent).toMatch(/Submit again to confirm/);
    expect(opened(request).some((path) => path.endsWith('/complete'))).toBe(false);
    const body = await complete(request);
    expect(body).toMatchObject(FOUR_FLAGS);
  });
});

describe('while the review send time is being re-checked', () => {
  async function startHeldComplete(props = {}) {
    const request = makeRequest({ holdRereads: true });
    await openSheet(request, props);
    await waitFor(() => expect(opened(request).some((path) => path.startsWith('/admin/reviews/send-time-preview'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Complete tree & shrub' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' }).disabled).toBe(true));
    return request;
  }

  test('the form, Complete and Close are inert, a second tap does nothing, and nothing is posted', async () => {
    const onClose = vi.fn();
    const request = await startHeldComplete({ onClose });
    expect(screen.getByRole('checkbox', { name: 'Send completion text' }).matches(':disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /^Chelated Iron Plus/ }).closest('fieldset').disabled).toBe(true);
    const reads = () => opened(request).filter((path) => path.startsWith('/admin/reviews/send-time-preview')).length;
    const before = reads();
    const complete = document.querySelector('.tech-visit-footer .tech-visit-complete');
    expect(complete.disabled).toBe(true);
    fireEvent.click(complete);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(reads()).toBe(before);
    expect(onClose).not.toHaveBeenCalled();
    expect(opened(request).some((path) => path.endsWith('/complete'))).toBe(false);
    // The answer lands: the sheet unlocks and posts once.
    await act(async () => { request.release(); });
    await waitFor(() => expect(opened(request).some((path) => path.endsWith('/complete'))).toBe(true));
    expect(opened(request).filter((path) => path.endsWith('/complete'))).toHaveLength(1);
  });

  test('an answer that lands after the sheet is gone posts nothing', async () => {
    const request = makeRequest({ holdRereads: true });
    await openSheet(request);
    await waitFor(() => expect(opened(request).some((path) => path.startsWith('/admin/reviews/send-time-preview'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Complete tree & shrub' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' }).disabled).toBe(true));
    cleanup();
    await act(async () => { request.release(); });
    await act(async () => { await Promise.resolve(); });
    expect(opened(request).some((path) => path.endsWith('/complete'))).toBe(false);
  });
});

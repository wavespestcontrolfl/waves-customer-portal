// @vitest-environment jsdom
// The Fast Complete Wrap-up section (GATE_FAST_COMPLETE_WRAP_UP): its defaults, the full form's
// show / hide / disable rules for each row, the body fragment it yields and the submit-time
// guards on the review send-time preview. Synthetic data only; every request is a stub.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FastCompleteWrapUp, { useWrapUp } from './FastCompleteWrapUp';

const FOUR_FLAGS = { sendCompletionSms: true, requestReview: true, includePayLink: true, reviewTiming: 'auto' };
const SERVICE = { id: 'svc-1', customerId: 'cust-1', serviceType: 'Lawn Care' };
const INVOICING = { ...SERVICE, estimatedPrice: 90, createInvoiceOnComplete: true };
const PREVIEW = { schedulerEnabled: true, at: '2026-10-12T14:00:00.000Z', bucket: 'b1', reviewSequencesEnabled: true, cadenceTickMinutesOfHour: [14, 44], bundlesImmediateAsk: false };

let wrapUp;
function Harness({ service = SERVICE, request, enabled = true, ...options }) {
  wrapUp = useWrapUp({ enabled, service, request, base: '/admin/dispatch/svc-1', ...options });
  return <FastCompleteWrapUp wrapUp={wrapUp} />;
}

// A stub of the three reads the section makes. `previews` answers each preview read in turn (the last repeats).
function makeRequest({ seeds = { exteriorMinutes: 0, interiorMinutes: 0 }, nextVisit = null, previews = [PREVIEW] } = {}) {
  const queue = [...previews];
  const request = vi.fn(async (path) => {
    if (path.includes('/reentry-defaults')) return seeds;
    if (path.startsWith('/admin/schedule/next-visit')) return { nextVisit };
    if (path.startsWith('/admin/reviews/send-time-preview')) {
      const answer = queue.length > 1 ? queue.shift() : queue[0];
      if (answer instanceof Error) throw answer;
      return answer;
    }
    return {};
  });
  return request;
}

const setRole = (role) => localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'op-1', role }));
const show = async (props = {}) => {
  const request = props.request || makeRequest();
  render(<Harness {...props} request={request} />);
  // The review row is drawn once the section is on; the preview answers after.
  await screen.findByRole('checkbox', { name: 'Send review request' });
  await waitFor(() => expect(request.mock.calls.some(([path]) => path.startsWith('/admin/reviews/send-time-preview'))).toBe(true));
  return request;
};
const pickTiming = (value) => fireEvent.change(screen.getByLabelText('Review request timing'), { target: { value } });

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

describe('defaults', () => {
  test('text and review on, automatic timing, and untouched it yields exactly the four flags', async () => {
    await show();
    expect(screen.getByRole('heading', { name: 'Wrap-up' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Send completion text' }).checked).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'Send review request' }).checked).toBe(true);
    expect(screen.getByLabelText('Review request timing').value).toBe('auto');
    expect(wrapUp.fields()).toEqual(FOUR_FLAGS);
  });

  test('disabled, it draws nothing, reads nothing and still yields the four flags', () => {
    const request = makeRequest();
    render(<Harness enabled={false} request={request} />);
    expect(screen.queryByRole('heading', { name: 'Wrap-up' })).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(wrapUp.fields()).toEqual(FOUR_FLAGS);
  });
});

describe('adjust time on site', () => {
  test('is for an admin only: a technician sees no row and posts no timeOnSite', async () => {
    setRole('technician');
    await show();
    expect(screen.queryByLabelText('Adjust time on site (minutes)')).toBeNull();
    expect(wrapUp.fields()).not.toHaveProperty('timeOnSite');
  });

  test('an admin sees it; blank sends nothing and a number posts as the full form does', async () => {
    setRole('admin');
    await show();
    const input = screen.getByLabelText('Adjust time on site (minutes)');
    expect(input.placeholder).toBe('Use timer');
    expect(wrapUp.fields()).not.toHaveProperty('timeOnSite');
    fireEvent.change(input, { target: { value: '45' } });
    expect(wrapUp.fields().timeOnSite).toBe(45);
    fireEvent.change(input, { target: { value: '' } });
    expect(wrapUp.fields()).not.toHaveProperty('timeOnSite');
  });

  test('a value outside 1 to 720 stops the submit and says so; the number never ships', async () => {
    setRole('admin');
    await show();
    fireEvent.change(screen.getByLabelText('Adjust time on site (minutes)'), { target: { value: '800' } });
    expect(wrapUp.fields()).not.toHaveProperty('timeOnSite');
    let ok;
    await act(async () => { ok = await wrapUp.check(); });
    expect(ok).toBe(false);
    expect((await screen.findByRole('alert')).textContent).toBe('Adjusted time on site must be 1–720 minutes.');
  });
});

describe('re-entry countdown', () => {
  test('shows only the sides the server seeds, and posts a side only once it moves off its seed', async () => {
    await show({ request: makeRequest({ seeds: { exteriorMinutes: 30, interiorMinutes: 0 } }) });
    await screen.findByText('Re-entry countdown');
    expect(screen.getByText('30 min')).toBeTruthy();
    expect(screen.queryByText('Interior re-entry')).toBeNull();
    expect(wrapUp.fields()).toEqual(FOUR_FLAGS);
    fireEvent.click(screen.getByRole('button', { name: 'Increase Exterior (dry-down) by 5 minutes' }));
    expect(screen.getByText('35 min')).toBeTruthy();
    expect(wrapUp.fields().reentryExteriorMinutes).toBe(35);
    expect(wrapUp.fields()).not.toHaveProperty('reentryInteriorMinutes');
    fireEvent.click(screen.getByRole('button', { name: 'Decrease Exterior (dry-down) by 5 minutes' }));
    expect(wrapUp.fields()).toEqual(FOUR_FLAGS);
  });

  test('the interior side steps by 15 and no seeds (or a failed read) hides both', async () => {
    await show({ request: makeRequest({ seeds: { exteriorMinutes: 0, interiorMinutes: 120 } }) });
    await screen.findByText('2 hr');
    fireEvent.click(screen.getByRole('button', { name: 'Decrease Interior re-entry by 15 minutes' }));
    expect(wrapUp.fields().reentryInteriorMinutes).toBe(105);
    cleanup();
    const failing = vi.fn(async (path) => { if (path.includes('/reentry-defaults')) throw new Error('down'); return path.startsWith('/admin/reviews') ? PREVIEW : {}; });
    await show({ request: failing });
    expect(screen.queryByText('Re-entry countdown')).toBeNull();
    expect(wrapUp.fields()).toEqual(FOUR_FLAGS);
  });
});

describe('completion text and payment link', () => {
  test('the payment link row needs a visit that invoices and the text on', async () => {
    await show();
    expect(screen.queryByRole('checkbox', { name: /Include payment link/ })).toBeNull();
    cleanup();
    await show({ service: INVOICING });
    const link = screen.getByRole('checkbox', { name: /Include payment link in the text/ });
    expect(link.checked).toBe(true);
    fireEvent.click(link);
    expect(wrapUp.fields().includePayLink).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Send completion text' }));
    expect(screen.queryByRole('checkbox', { name: /Include payment link/ })).toBeNull();
    // A stale false never posts when the text is off.
    expect(wrapUp.fields()).toMatchObject({ sendCompletionSms: false, includePayLink: true });
  });

  test('a third-party payer shows its banner and no payment link row', async () => {
    await show({ service: { ...INVOICING, billedToPayer: { name: 'Fixture Property Group' } } });
    expect(screen.getByText(/Billed to Fixture Property Group/)).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Include payment link/ })).toBeNull();
    expect(wrapUp.fields().includePayLink).toBe(true);
  });

  test('a visit already paid, or an unpriced re-service, does not invoice, so no payment link row', async () => {
    await show({ service: { ...INVOICING, invoiceStatus: 'paid' } });
    expect(screen.queryByRole('checkbox', { name: /Include payment link/ })).toBeNull();
    cleanup();
    await show({ service: { ...SERVICE, createInvoiceOnComplete: true, serviceType: 'Lawn Re-service' } });
    expect(screen.queryByRole('checkbox', { name: /Include payment link/ })).toBeNull();
  });
});

describe('review request', () => {
  test('unticked it posts requestReview false and hides the timing', async () => {
    await show();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Send review request' }));
    expect(wrapUp.fields().requestReview).toBe(false);
    expect(screen.queryByLabelText('Review request timing')).toBeNull();
  });

  test('suppressed (a customer concern) it reads "Review request suppressed", is disabled and posts false', async () => {
    const request = makeRequest();
    render(<Harness request={request} customerConcern />);
    const box = await screen.findByRole('checkbox', { name: 'Review request suppressed' });
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    expect(screen.queryByLabelText('Review request timing')).toBeNull();
    expect(wrapUp.fields().requestReview).toBe(false);
    // No review, so the send-time preview is never read.
    expect(request.mock.calls.some(([path]) => path.startsWith('/admin/reviews'))).toBe(false);
    let ok;
    await act(async () => { ok = await wrapUp.check(); });
    expect(ok).toBe(true);
  });

  test('the timing choices are the full form\'s', async () => {
    await show();
    expect([...screen.getByLabelText('Review request timing').options].map((o) => o.value)).toEqual(['auto', 'customer_requested', 'tomorrow_8', 'custom']);
  });

  test('"customer asked for the link" and "tomorrow 8 AM" post their timing and an explicit delay', async () => {
    await show();
    pickTiming('customer_requested');
    expect(wrapUp.fields()).toMatchObject({ reviewTiming: 'customer_requested', reviewDelayMinutes: 0, reviewScheduledFor: null });
    pickTiming('tomorrow_8');
    expect(wrapUp.fields()).toMatchObject({ reviewTiming: 'tomorrow_8', reviewDelayMinutes: 0 });
    expect(wrapUp.fields().reviewScheduledFor).toMatch(/^\d{4}-\d{2}-\d{2}T08:00$/);
  });

  test('the hint follows the server preview', async () => {
    await show();
    await screen.findByText(/Review text goes out separately/);
    cleanup();
    await show({ request: makeRequest({ previews: [{ ...PREVIEW, schedulerEnabled: false }] }) });
    await screen.findByText(/Automated review texts are paused/);
  });
});

describe('custom review time', () => {
  const future = () => {
    const d = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00`;
  };

  test('shows a date-time box with the full form\'s 30-day ceiling and posts the chosen time', async () => {
    await show();
    pickTiming('custom');
    const box = screen.getByLabelText('Custom review time');
    expect(box.max).toMatch(/^\d{4}-\d{2}-\d{2}T23:59$/);
    fireEvent.change(box, { target: { value: future() } });
    expect(wrapUp.fields()).toMatchObject({ reviewTiming: 'custom', reviewDelayMinutes: 0, reviewScheduledFor: future() });
  });

  test('an empty or past time stops the submit with the full form\'s words', async () => {
    await show();
    pickTiming('custom');
    let ok;
    await act(async () => { ok = await wrapUp.check(); });
    expect(ok).toBe(false);
    expect((await screen.findByRole('alert')).textContent).toBe('Choose a review request time.');
    fireEvent.change(screen.getByLabelText('Custom review time'), { target: { value: '2020-01-01T10:00' } });
    await act(async () => { ok = await wrapUp.check(); });
    expect(ok).toBe(false);
    expect((await screen.findByRole('alert')).textContent).toBe('Choose a future review request time.');
    fireEvent.change(screen.getByLabelText('Custom review time'), { target: { value: future() } });
    await act(async () => { ok = await wrapUp.check(); });
    expect(ok).toBe(true);
  });
});

describe('the submit-time check of the send-time preview', () => {
  test('Automatic reads the preview again; the same bucket goes on', async () => {
    const request = await show({ request: makeRequest({ previews: [PREVIEW, { ...PREVIEW, at: '2026-10-12T15:00:00.000Z' }] }) });
    const reads = () => request.mock.calls.filter(([path]) => path.startsWith('/admin/reviews/send-time-preview')).length;
    const before = reads();
    let ok;
    await act(async () => { ok = await wrapUp.check(); });
    expect(ok).toBe(true);
    expect(reads()).toBe(before + 1);
  });

  test('a changed bucket stops once and asks for a second look', async () => {
    await show({ request: makeRequest({ previews: [PREVIEW, { ...PREVIEW, bucket: 'b2' }] }) });
    let ok;
    await act(async () => { ok = await wrapUp.check(); });
    expect(ok).toBe(false);
    expect((await screen.findByRole('alert')).textContent).toMatch(/The automatic review time changed to .* Submit again to confirm\./);
  });

  test('a failed re-check stops once, then the next submit goes on', async () => {
    await show({ request: makeRequest({ previews: [PREVIEW, new Error('down')] }) });
    let ok;
    await act(async () => { ok = await wrapUp.check(); });
    expect(ok).toBe(false);
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be re-checked/);
    await act(async () => { ok = await wrapUp.check(); });
    expect(ok).toBe(true);
  });

  test('an unknown scheduler state is read again for every timing; a known one is not for a fixed timing', async () => {
    const request = await show({ request: makeRequest({ previews: [PREVIEW] }) });
    pickTiming('customer_requested');
    const reads = () => request.mock.calls.filter(([path]) => path.startsWith('/admin/reviews/send-time-preview')).length;
    const before = reads();
    let ok;
    await act(async () => { ok = await wrapUp.check(); });
    expect(ok).toBe(true);
    expect(reads()).toBe(before);
    cleanup();
    const unknown = await show({ request: makeRequest({ previews: [null] }) });
    pickTiming('customer_requested');
    const unknownBefore = unknown.mock.calls.filter(([path]) => path.startsWith('/admin/reviews/send-time-preview')).length;
    await act(async () => { ok = await wrapUp.check(); });
    expect(ok).toBe(false);
    expect(unknown.mock.calls.filter(([path]) => path.startsWith('/admin/reviews/send-time-preview')).length).toBe(unknownBefore + 1);
  });
});

describe('next scheduled visit', () => {
  // No note box: the server stores no next-visit note, so the sheet does not take one.
  test('shows the next visit and posts nothing for it', async () => {
    await show({ request: makeRequest({ nextVisit: { id: 'svc-2', date: '2026-11-05', serviceType: 'Lawn Care' } }) });
    await screen.findByText('Next scheduled visit');
    expect(screen.getByText('Thu, Nov 5')).toBeTruthy();
    expect(wrapUp.fields()).toEqual(FOUR_FLAGS);
    expect(screen.queryByRole('button', { name: 'Needs adjustment?' })).toBeNull();
  });

  test('with no next visit there is no card', async () => {
    await show();
    expect(screen.queryByText('Next scheduled visit')).toBeNull();
  });
});

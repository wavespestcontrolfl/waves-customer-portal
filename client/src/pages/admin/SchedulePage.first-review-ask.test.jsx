// @vitest-environment jsdom
// First review ask (GATE_REVIEW_FIRST_ASK_LOCK, owner 2026-10-26): in the Complete Service panel a customer
// never asked for a review sees the box as "First review ask", on and kept on; turning it off asks to confirm
// the one reason, "Complaint on site", and cancelling keeps it on. A customer asked before keeps today's box.
// Synthetic data only; every request is a stub.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';

vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

const service = {
  id: 'first-ask-visit',
  customerId: 'first-ask-customer',
  customerName: 'Synthetic Customer',
  serviceType: 'Pest Control',
  status: 'confirmed',
  scheduledDate: '2099-01-01',
  estimatedPrice: 100,
};
const PREVIEW = { schedulerEnabled: true, at: '2099-01-01T14:00:00.000Z', bucket: 'b1', reviewSequencesEnabled: true, cadenceTickMinutesOfHour: [14, 44], bundlesImmediateAsk: false };

function stubFetch(preview) {
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true,
    json: async () => (String(url).includes('/admin/reviews/send-time-preview') ? preview : { customer: {}, actions: [], available: false }),
  })));
}

async function renderPanel() {
  const onSubmit = vi.fn().mockResolvedValue({});
  await act(async () => {
    render(<CompletionPanel service={service} products={[]} onClose={vi.fn()} onSubmit={onSubmit} />);
  });
  return onSubmit;
}

async function submit(onSubmit) {
  const button = await screen.findByRole('button', { name: /^Complete & Send Recap/i });
  await waitFor(() => expect(button.disabled).toBe(false));
  await act(async () => fireEvent.click(button));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  return onSubmit.mock.calls[0][1];
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('alert', vi.fn());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe.each([[1024, 'desktop'], [390, 'phone']])('the review box at %i px (%s)', (width) => {
  beforeEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }); });

  it('a customer never asked sees "First review ask", on, and an untouched submit adds no reason', async () => {
    stubFetch({ ...PREVIEW, firstReviewAsk: true });
    const onSubmit = await renderPanel();
    const box = await screen.findByRole('checkbox', { name: 'First review ask' });
    expect(box.checked).toBe(true);
    const body = await submit(onSubmit);
    expect(body.requestReview).toBe(true);
    expect(body).not.toHaveProperty('reviewOptOutReason');
  });

  it('turning it off asks to confirm "Complaint on site"; cancelling keeps it on', async () => {
    stubFetch({ ...PREVIEW, firstReviewAsk: true });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onSubmit = await renderPanel();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'First review ask' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatch(/Complaint on site/);
    expect(screen.getByRole('checkbox', { name: 'First review ask' }).checked).toBe(true);
    const body = await submit(onSubmit);
    expect(body.requestReview).toBe(true);
    expect(body).not.toHaveProperty('reviewOptOutReason');
  });

  it('confirming turns it off, keeps the label, and the submit carries the reason; turning it on again drops the reason', async () => {
    stubFetch({ ...PREVIEW, firstReviewAsk: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onSubmit = await renderPanel();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'First review ask' }));
    expect(screen.getByRole('checkbox', { name: 'First review ask' }).checked).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'First review ask' }));
    expect(screen.getByRole('checkbox', { name: 'First review ask' }).checked).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'First review ask' }));
    const body = await submit(onSubmit);
    expect(body.requestReview).toBe(false);
    expect(body.reviewOptOutReason).toBe('complaint_on_site');
  });

  it('a customer asked before keeps today\'s box: no confirm, no reason', async () => {
    stubFetch({ ...PREVIEW, firstReviewAsk: false });
    const confirm = vi.spyOn(window, 'confirm');
    const onSubmit = await renderPanel();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    expect(confirm).not.toHaveBeenCalled();
    const body = await submit(onSubmit);
    expect(body.requestReview).toBe(false);
    expect(body).not.toHaveProperty('reviewOptOutReason');
  });

  it('gate off (the preview carries no verdict): today\'s box and body', async () => {
    stubFetch(PREVIEW);
    const confirm = vi.spyOn(window, 'confirm');
    const onSubmit = await renderPanel();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Send review request' }));
    expect(confirm).not.toHaveBeenCalled();
    const body = await submit(onSubmit);
    expect(body.requestReview).toBe(false);
    expect(body).not.toHaveProperty('reviewOptOutReason');
  });
});

describe('the preview read names the visit', () => {
  it('asks the server about this visit so it can say whether the customer was never asked', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    stubFetch({ ...PREVIEW, firstReviewAsk: true });
    await renderPanel();
    await screen.findByRole('checkbox', { name: 'First review ask' });
    const urls = fetch.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/admin/reviews/send-time-preview'));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).toContain('serviceId=first-ask-visit');
  });
});

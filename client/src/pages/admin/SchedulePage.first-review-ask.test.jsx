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

describe('a saved draft (autosave and restore)', () => {
  const draftKey = `waves_completion_draft_${service.id}`;
  const restore = async () => {
    const onSubmit = await renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    return onSubmit;
  };
  beforeEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 }); });

  it('the confirmed reason is saved with the draft and restored: the box stays off and the submit carries it', async () => {
    stubFetch({ ...PREVIEW, firstReviewAsk: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderPanel();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'First review ask' }));
    fireEvent.change(screen.getByPlaceholderText('Notes about this service...'), { target: { value: 'Draft note' } });
    await waitFor(() => expect(JSON.parse(localStorage.getItem(draftKey) || '{}')).toMatchObject({ requestReview: false, reviewOptOutReason: 'complaint_on_site' }), { timeout: 3000 });
    cleanup();
    const onSubmit = await restore();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'First review ask' }).checked).toBe(false));
    const body = await submit(onSubmit);
    expect(body.requestReview).toBe(false);
    expect(body.reviewOptOutReason).toBe('complaint_on_site');
  });

  it('a draft restored with the box off and no reason reads the verdict, shows "First review ask" and re-arms it on', async () => {
    localStorage.setItem(draftKey, JSON.stringify({ serviceId: service.id, notes: 'Older draft', requestReview: false }));
    stubFetch({ ...PREVIEW, firstReviewAsk: true });
    const onSubmit = await restore();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'First review ask' }).checked).toBe(true));
    const body = await submit(onSubmit);
    expect(body.requestReview).toBe(true);
    expect(body).not.toHaveProperty('reviewOptOutReason');
  });

  it('a first read that failed does not hide the first ask: the off box reads the verdict once more', async () => {
    localStorage.setItem(draftKey, JSON.stringify({ serviceId: service.id, notes: 'Older draft', requestReview: false }));
    let previewReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (!String(url).includes('/admin/reviews/send-time-preview')) return { ok: true, json: async () => ({ customer: {}, actions: [], available: false }) };
      previewReads += 1;
      return previewReads === 1 ? { ok: false, json: async () => null } : { ok: true, json: async () => ({ ...PREVIEW, firstReviewAsk: true }) };
    }));
    const onSubmit = await restore();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'First review ask' }).checked).toBe(true));
    expect(previewReads).toBeGreaterThanOrEqual(2);
    expect((await submit(onSubmit)).requestReview).toBe(true);
  });

  it('a draft restored with the box off, for a customer asked before, stays off as today', async () => {
    localStorage.setItem(draftKey, JSON.stringify({ serviceId: service.id, notes: 'Older draft', requestReview: false }));
    stubFetch({ ...PREVIEW, firstReviewAsk: false });
    const onSubmit = await restore();
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('send-time-preview'))).toBe(true));
    expect(screen.getByRole('checkbox', { name: 'Send review request' }).checked).toBe(false);
    const body = await submit(onSubmit);
    expect(body.requestReview).toBe(false);
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

// @vitest-environment jsdom
// The full Complete Service form's "Needs adjustment?" box under the next scheduled visit
// (owner 2026-10-12, "store it"): the server now stores the note on that visit, so the body carries
// the note (trimmed, 300 characters at most) beside the id of the visit the card showed. Both renders
// (the phone layout and the desktop one) are covered; an untouched card posts neither key.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';

vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

const service = {
  id: 'next-note-visit',
  customerId: 'next-note-customer',
  customerName: 'Synthetic Customer',
  serviceType: 'Pest Control',
  status: 'confirmed',
  scheduledDate: '2099-01-01',
  estimatedPrice: 100,
};
const NEXT_VISIT = { id: '00000000-0000-4000-8000-0000000000aa', date: '2099-02-01', serviceType: 'Quarterly Pest Control' };

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    let data = { customer: {}, actions: [], available: false };
    if (String(url).includes('/admin/schedule/next-visit')) data = { nextVisit: NEXT_VISIT };
    return { ok: true, json: async () => data };
  }));
}

async function renderPanel(onSubmit) {
  await act(async () => {
    render(<CompletionPanel service={service} products={[]} onClose={vi.fn()} onSubmit={onSubmit} />);
  });
  await screen.findByText(/Next scheduled visit/i);
}

async function complete(onSubmit) {
  const submit = await screen.findByRole('button', { name: /^Complete & Send Recap/i });
  await waitFor(() => expect(submit.disabled).toBe(false));
  await act(async () => fireEvent.click(submit));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  return onSubmit.mock.calls[0][1];
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('alert', vi.fn());
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe.each([['desktop', 1024, '...'], ['phone', 390, '…']])('the next-visit note on the %s layout', (_name, width, ellipsis) => {
  beforeEach(() => { vi.stubGlobal('innerWidth', width); });

  it('posts the trimmed note with the id of the next visit shown', async () => {
    const onSubmit = vi.fn().mockResolvedValue({});
    await renderPanel(onSubmit);
    fireEvent.click(await screen.findByRole('button', { name: 'Needs adjustment?' }));
    const box = screen.getByPlaceholderText(/Note about next visit adjustment/);
    expect(box.maxLength).toBe(300);
    // The two renders differ only in their placeholder's ellipsis: this proves which one mounted.
    expect(box.placeholder.endsWith(ellipsis)).toBe(true);
    expect(box.placeholder.endsWith(ellipsis === '…' ? '...' : '…')).toBe(false);
    fireEvent.change(box, { target: { value: '  Gate code changed ' } });
    const body = await complete(onSubmit);
    expect(body.nextVisitAdjustmentNote).toBe('Gate code changed');
    expect(body.nextVisitId).toBe(NEXT_VISIT.id);
  });

  it('untouched, or opened and left blank, posts neither key', async () => {
    const onSubmit = vi.fn().mockResolvedValue({});
    await renderPanel(onSubmit);
    fireEvent.click(await screen.findByRole('button', { name: 'Needs adjustment?' }));
    fireEvent.change(screen.getByPlaceholderText(/Note about next visit adjustment/), { target: { value: '   ' } });
    const body = await complete(onSubmit);
    expect(body).not.toHaveProperty('nextVisitAdjustmentNote');
    expect(body).not.toHaveProperty('nextVisitId');
  });
});

// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';

vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

const service = {
  id: 'draft-test-visit', customerId: 'draft-test-customer',
  customerName: 'Synthetic Customer', serviceType: 'Pest Control',
  status: 'confirmed', scheduledDate: '2099-01-01', estimatedPrice: 100,
};
const key = `waves_completion_draft_${service.id}`;
const readDraft = () => JSON.parse(localStorage.getItem(key) || 'null');
const notes = () => screen.getByPlaceholderText('Notes about this service...');

async function mount(props = {}) {
  let view;
  await act(async () => {
    view = render(<StrictMode><CompletionPanel service={service} products={[]}
      onClose={vi.fn()} onSubmit={vi.fn().mockResolvedValue({})} {...props} /></StrictMode>);
  });
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, json: async () => ({ customer: {}, actions: [], available: false }),
  })));
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('completion draft departure', () => {
  it('saves the latest note and preference when leaving before autosave', async () => {
    const view = await mount();
    fireEvent.change(notes(), { target: { value: 'Older saved note' } });
    act(() => vi.advanceTimersByTime(700));
    fireEvent.change(notes(), { target: { value: 'Latest unsaved note' } });
    fireEvent.click(screen.getByLabelText('Send completion SMS to customer'));
    view.unmount();
    expect(readDraft()).toMatchObject({ notes: 'Latest unsaved note', sendSms: false });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    expect(notes().value).toBe('Latest unsaved note');
    expect(screen.getByLabelText('Send completion SMS to customer').checked).toBe(false);
  });

  it('keeps an unopened saved draft intact and does not resurrect a discarded draft', async () => {
    localStorage.setItem(key, JSON.stringify({ serviceId: service.id, notes: 'Saved note' }));
    const first = await mount();
    first.unmount();
    expect(readDraft().notes).toBe('Saved note');
    const second = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Discard', exact: true }));
    second.unmount();
    act(() => vi.advanceTimersByTime(1000));
    expect(readDraft()).toBeNull();
  });

  it('does not resurrect a draft after successful completion', async () => {
    const onSubmit = vi.fn().mockResolvedValue({});
    const view = await mount({ onSubmit });
    fireEvent.change(notes(), { target: { value: 'Completed visit note' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Complete & Send Recap/i }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    view.unmount();
    act(() => vi.advanceTimersByTime(1500));
    expect(readDraft()).toBeNull();
  });

  it('clears the flushed draft when an in-flight completion succeeds after departure', async () => {
    let finish;
    const onSubmit = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const view = await mount({ onSubmit });
    fireEvent.change(notes(), { target: { value: 'In-flight visit note' } });
    // Submit re-checks the automatic review send time first (one awaited fetch).
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Complete & Send Recap/i })); });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(readDraft().notes).toBe('In-flight visit note');
    await act(async () => finish({}));
    expect(readDraft()).toBeNull();
  });

  it('does not save an empty draft on departure', async () => {
    const view = await mount();
    view.unmount();
    expect(readDraft()).toBeNull();
  });
});


describe('completion review timing across midnight', () => {
  it.each([
    { cadence: true, window: true, expected: /about Thu,? 8:14 AM/ },
    { cadence: false, window: true, expected: /about Thu,? 8:00 AM/ },
    { cadence: true, window: false, expected: /about Thu,? 12:14 AM/ },
  ])('uses the delivery tick date for cadence=$cadence, window=$window', async ({ cadence, window, expected }) => {
    vi.setSystemTime(new Date('2030-01-01T16:00:00Z'));
    vi.stubGlobal('fetch', vi.fn(async (url) => ({
      ok: true,
      json: async () => String(url).includes('/send-time-preview') ? {
        schedulerEnabled: true, reviewSequencesEnabled: cadence,
        smsSendWindowEnabled: window, cadenceTickMinutesOfHour: [14, 44],
        legacyTickMinutesOfHour: [0, 15, 30, 45],
      } : { customer: {}, actions: [], available: false },
    })));
    await mount();
    const timing = document.querySelector('option[value="custom"]').parentElement;
    fireEvent.change(timing, { target: { value: 'custom' } });
    fireEvent.change(document.querySelector('input[type="datetime-local"]'), {
      target: { value: '2030-01-02T23:50' },
    });
    expect(screen.getByText(expected)).toBeTruthy();
    expect(screen.queryByText(/about Wed,? 8:/)).toBeNull();
  });
});


describe('completion review preview availability', () => {
  it('clears a previously available scheduler when the polling refresh fails', async () => {
    let previewAvailable = true;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/send-time-preview')) {
        if (!previewAvailable) throw new Error('preview unavailable');
        return { ok: true, json: async () => ({ schedulerEnabled: true, reviewSequencesEnabled: true, smsSendWindowEnabled: true, cadenceTickMinutesOfHour: [14, 44] }) };
      }
      return { ok: true, json: async () => ({ customer: {}, actions: [], available: false }) };
    }));
    await mount();
    fireEvent.change(document.querySelector('option[value="customer_requested"]').parentElement, { target: { value: 'customer_requested' } });
    expect(screen.getByText(/An existing cadence keeps its schedule/)).toBeTruthy();
    previewAvailable = false;
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(screen.getByText(/Whether automated review texts can send is not known yet/)).toBeTruthy();
    expect(screen.queryByText(/An existing cadence keeps its schedule/)).toBeNull();
    previewAvailable = true;
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(screen.getByText(/An existing cadence keeps its schedule/)).toBeTruthy();
  });

  it.each([false, true])('records requested links without promising to move an existing cadence (unpaid invoice: %s)', async (unpaid) => {
    vi.stubGlobal('fetch', vi.fn(async (url) => ({
      ok: true,
      json: async () => String(url).includes('/send-time-preview')
        ? { schedulerEnabled: true, reviewSequencesEnabled: true, smsSendWindowEnabled: true }
        : { customer: {}, actions: [], available: false },
    })));
    await mount({ service: { ...service, completionInvoiceAlreadySent: unpaid, invoiceStatus: unpaid ? 'sent' : 'paid' } });
    fireEvent.change(document.querySelector('option[value="customer_requested"]').parentElement, { target: { value: 'customer_requested' } });
    expect(screen.getByText(/An existing cadence keeps its schedule/)).toBeTruthy();
    expect(screen.queryByText(/as soon as the send window allows|then goes out at the next/)).toBeNull();
    if (unpaid) expect(screen.getByText(/New review enrollment waits for invoice payment and visit eligibility/)).toBeTruthy();
  });
});

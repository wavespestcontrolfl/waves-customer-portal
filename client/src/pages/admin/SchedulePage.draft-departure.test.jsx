// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel, createCompletionIdempotencyKey } from './SchedulePage';

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
  it('creates a usable completion key when WebKit has no randomUUID', () => {
    vi.stubGlobal('crypto', {});
    const first = createCompletionIdempotencyKey(service.id);
    const second = createCompletionIdempotencyKey(service.id);
    expect(first).toMatch(/^complete_draft-test-visit_\d+-[a-z0-9]+$/);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(120);
  });
  it('prepares the canonical form and restores its photos without completing a service', async () => {
    const onSubmit = vi.fn();
    const onPrepared = vi.fn().mockResolvedValue(undefined);
    const photos = [{ data: 'data:image/jpeg;base64,c3ludGhldGlj', name: 'fixture.jpg', capturedAt: '2020-01-01T12:00:00Z' }];
    await mount({ onSubmit, onPrepared, preparedDraft: { serviceId: service.id, notes: 'Prepared report note', servicePhotos: photos } });
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    expect(notes().value).toBe('Prepared report note');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Save service form/i }));
    });
    expect(onPrepared).toHaveBeenCalledTimes(1);
    expect(onPrepared.mock.calls[0][1]).toMatchObject({ technicianNotes: 'Prepared report note', completionPhotos: [expect.objectContaining(photos[0])] });
    expect(onPrepared.mock.calls[0][2].servicePhotos).toEqual(photos);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Save service form/i })).toBeTruthy();
  });
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
    fireEvent.click(screen.getByRole('button', { name: /^Complete & Send Recap/i }));
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

// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel, completionResumeOwed, restoreCompletionResumeBody } from './SchedulePage';
import { getCompletionDraft, putCompletionDraft } from '../../lib/completion-resume-store';

vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlagReady: () => ({ enabled: false, ready: true }) }));
const service = { id: 'recovery-visit', customerId: 'recovery-customer', customerName: 'Synthetic Customer',
  serviceType: 'Pest Control', status: 'confirmed', scheduledDate: '2099-01-01', estimatedPrice: 100 };
const key = `waves_completion_draft_${service.id}`;
const photos = [{ name: 'exterior.jpg', data: 'data:image/jpeg;base64,AAAA', capturedAt: '2099-01-01T12:00:00Z', caption: 'Exterior treatment' }];
const submitButton = () => screen.getByRole('button', { name: /^(Complete & Send Recap|Complete Service|Resume Closeout)/i });
async function mount(onSubmit = vi.fn().mockResolvedValue({})) {
  const view = render(<CompletionPanel service={service} products={[]} onClose={vi.fn()} onSubmit={onSubmit} />);
  await screen.findByPlaceholderText('Notes about this service...');
  return view;
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('alert', vi.fn());
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ customer: {}, actions: [], available: false }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('completion photos in an unsubmitted draft', () => {
  async function seed() {
    const draft = { serviceId: service.id, draftId: 'draft-one', savedAt: '2099-01-01T12:00:00Z',
      notes: 'Exterior inspected', generationPhotoCount: 1, servicePhotos: photos, sendSms: false };
    const { servicePhotos: _photos, ...metadata } = draft;
    localStorage.setItem(key, JSON.stringify(metadata));
    await putCompletionDraft(service.id, draft);
  }

  it('restores photos and captions, saves the latest edits on departure, and clears after completion', async () => {
    await seed();
    const first = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    expect(screen.getByAltText('exterior.jpg').getAttribute('src')).toBe(photos[0].data);
    fireEvent.change(screen.getByPlaceholderText('Notes about this service...'), { target: { value: 'Latest field note' } });
    first.unmount();
    expect(await getCompletionDraft(service.id)).toMatchObject({ notes: 'Latest field note', servicePhotos: photos, sendSms: false });
    const submit = vi.fn().mockResolvedValue({});
    const second = await mount(submit);
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    await act(async () => fireEvent.click(submitButton()));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][1].completionPhotos[0]).toMatchObject({ data: photos[0].data, caption: photos[0].caption });
    second.unmount();
    expect(await getCompletionDraft(service.id)).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('deletes a discarded photo draft without letting pending writes resurrect it', async () => {
    await seed();
    const view = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Discard', exact: true }));
    view.unmount();
    expect(await getCompletionDraft(service.id)).toBeNull();
  });
});

describe('committed completion failures survive closing and reopening', () => {
  it.each([
    'terminal_invoice_lookup_failed', 'historic_setup_fee_alert_failed', 'unminted_setup_fee_lookup_failed',
    'terminal_invoice_manual_billing_alert_failed', 'unminted_setup_fee_alert_failed',
  ])('%s preserves the exact request and key for one retry', async (code) => {
    const failedSubmit = vi.fn().mockRejectedValue(Object.assign(new Error('Closeout saved; retry the remaining step'), { status: 503, code }));
    const first = await mount(failedSubmit);
    fireEvent.change(screen.getByPlaceholderText('Notes about this service...'), { target: { value: 'Original closeout' } });
    await act(async () => fireEvent.click(submitButton()));
    await waitFor(() => expect(completionResumeOwed(service.id)).toBe(true));
    const submittedBody = failedSubmit.mock.calls[0][1];
    first.unmount();
    expect(await restoreCompletionResumeBody(service.id)).toEqual(submittedBody);
    const retry = vi.fn().mockResolvedValue({});
    const second = await mount(retry);
    await act(async () => fireEvent.click(submitButton()));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry.mock.calls[0][1]).toEqual(submittedBody);
    expect(completionResumeOwed(service.id)).toBe(false);
    second.unmount();
  });
});

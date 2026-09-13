// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel, completionResumeOwed, restoreCompletionResumeBody } from './SchedulePage';
import { getCompletionDraft, putCompletionDraft } from '../../lib/completion-resume-store';
import * as completionStore from '../../lib/completion-resume-store';

vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlagReady: () => ({ enabled: false, ready: true }) }));
const service = { id: 'recovery-visit', customerId: 'recovery-customer', customerName: 'Synthetic Customer',
  serviceType: 'Pest Control', status: 'confirmed', scheduledDate: '2099-01-01', estimatedPrice: 100 };
const key = `waves_completion_draft_${service.id}`;
const photos = [{ name: 'exterior.jpg', data: 'data:image/jpeg;base64,AAAA', capturedAt: '2099-01-01T12:00:00Z', caption: 'Exterior treatment' }];
const submitButton = () => screen.getByRole('button', { name: /^(Complete & Send Recap|Complete Service|Resume Closeout)/i });
async function mount(onSubmit = vi.fn().mockResolvedValue({})) {
  const view = render(<CompletionPanel service={service} products={[]} onClose={vi.fn()} onSubmit={onSubmit} />);
  await screen.findByPlaceholderText('Notes about this service...');
  // The form renders before the IndexedDB draft lookup settles; the Restore
  // prompt / photo recovery appear once it does.
  await waitFor(() => expect(screen.queryByText('Loading saved draft…')).toBeNull());
  return view;
}

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('alert', vi.fn());
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ customer: {}, actions: [], available: false }) })));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

  it('never offers one admin\'s draft to the next operator on a shared browser', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-a' }));
    const draft = { serviceId: service.id, owner: 'tech-a', draftId: 'draft-one', savedAt: '2099-01-01T12:00:00Z',
      notes: 'Private note', generationPhotoCount: 1, servicePhotos: photos, sendSms: false };
    const { servicePhotos: _photos, ...metadata } = draft;
    localStorage.setItem(key, JSON.stringify(metadata));
    await putCompletionDraft(service.id, draft, 'tech-a');
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-b' }));
    const view = await mount();
    expect(screen.queryByRole('button', { name: 'Restore', exact: true })).toBeNull();
    expect(screen.queryByAltText('exterior.jpg')).toBeNull();
    view.unmount();
    // Tech A's draft is untouched for their next login.
    expect(await getCompletionDraft(service.id, 'tech-a')).toMatchObject({ notes: 'Private note', servicePhotos: photos });
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-a' }));
    await mount();
    expect(screen.getByRole('button', { name: 'Restore', exact: true })).toBeTruthy();
  });

  it('deletes a discarded photo draft without letting pending writes resurrect it', async () => {
    await seed();
    const view = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Discard', exact: true }));
    view.unmount();
    expect(await getCompletionDraft(service.id)).toBeNull();
  });

  it('does not offer a discarded draft whose IndexedDB delete never committed (Codex #4091 P2)', async () => {
    await seed();
    const first = await mount();
    // The delete is issued but the page dies before it commits: the full
    // photo-bearing row survives with no metadata.
    vi.spyOn(completionStore, 'deleteCompletionDraft').mockResolvedValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Discard', exact: true }));
    expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem(`${key}_discarded`)).toBe('draft-one');
    first.unmount();
    vi.restoreAllMocks();
    expect(await getCompletionDraft(service.id)).toMatchObject({ draftId: 'draft-one' });
    await mount();
    expect(screen.queryByRole('button', { name: 'Restore', exact: true })).toBeNull();
    await waitFor(async () => expect(await getCompletionDraft(service.id)).toBeNull());
    await waitFor(() => expect(localStorage.getItem(`${key}_discarded`)).toBeNull());
  });

  it('a tombstone for an older draftId never suppresses a draft minted after the discard', async () => {
    localStorage.setItem(`${key}_discarded`, 'draft-zero');
    await seed();
    await mount();
    expect(screen.getByRole('button', { name: 'Restore', exact: true })).toBeTruthy();
    expect(localStorage.getItem(`${key}_discarded`)).toBeNull();
  });

  it('restores persisted photos with newer fields when the departure write is lost', async () => {
    await seed();
    const first = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    await getCompletionDraft(service.id);
    // A departing page can save synchronous metadata without committing IDB.
    vi.spyOn(completionStore, 'putCompletionDraft').mockResolvedValue(false);
    fireEvent.change(screen.getByPlaceholderText('Notes about this service...'), { target: { value: 'Latest field note' } });
    fireEvent(window, new Event('pagehide'));
    first.unmount();
    expect(JSON.parse(localStorage.getItem(key)).notes).toBe('Latest field note');
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    expect(screen.getByPlaceholderText('Notes about this service...').value).toBe('Latest field note');
    expect(screen.getByAltText('exterior.jpg').getAttribute('src')).toBe(photos[0].data);
    expect(screen.queryByText(/saved photos could not be restored/)).toBeNull();
  });

  it('does not restore a removed photo when its departure write is lost', async () => {
    await seed();
    const first = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    await getCompletionDraft(service.id);
    vi.spyOn(completionStore, 'putCompletionDraft').mockResolvedValue(false);
    fireEvent.click(screen.getByAltText('exterior.jpg').parentElement.querySelector('button'));
    fireEvent.change(screen.getByPlaceholderText('Notes about this service...'), { target: { value: 'Photo removed' } });
    fireEvent(window, new Event('pagehide'));
    first.unmount();
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    expect(screen.getByPlaceholderText('Notes about this service...').value).toBe('Photo removed');
    expect(screen.queryByAltText('exterior.jpg')).toBeNull();
  });

  it('keeps the stored photo revision when the restore-time IndexedDB write is interrupted', async () => {
    await seed();
    const first = await mount();
    // Restore must not read as a photo change: the metadata written right
    // after Restore keeps draftId 'draft-one', which is what the still-valid
    // stored photos carry when this write never commits (Codex #4091 P1).
    vi.spyOn(completionStore, 'putCompletionDraft').mockResolvedValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    fireEvent(window, new Event('pagehide'));
    first.unmount();
    expect(JSON.parse(localStorage.getItem(key)).draftId).toBe('draft-one');
    vi.restoreAllMocks();
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    expect(screen.getByAltText('exterior.jpg').getAttribute('src')).toBe(photos[0].data);
    expect(screen.queryByText(/saved photos could not be restored/)).toBeNull();
  });

  it('restores the technician-approved photo summary with its photo set and carries it on departure', async () => {
    // The summary describes the saved photo set; a reload or billing detour
    // must bring it back with the photos or the submit path silently omits
    // the reviewed customer narrative (Codex r-375c002 P1).
    const draft = { serviceId: service.id, draftId: 'draft-one', savedAt: '2099-01-01T12:00:00Z',
      notes: 'Exterior inspected', generationPhotoCount: 1, servicePhotos: photos, sendSms: false,
      typedPhotoSummary: 'Exterior perimeter treated; no active harborage seen.' };
    const { servicePhotos: _photos, ...metadata } = draft;
    localStorage.setItem(key, JSON.stringify(metadata));
    await putCompletionDraft(service.id, draft);
    const first = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    const summary = screen.getByDisplayValue('Exterior perimeter treated; no active harborage seen.');
    fireEvent.change(summary, { target: { value: 'Exterior perimeter treated; monitor the north bed.' } });
    first.unmount();
    expect(await getCompletionDraft(service.id)).toMatchObject({
      servicePhotos: photos, typedPhotoSummary: 'Exterior perimeter treated; monitor the north bed.',
    });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    expect(screen.getByDisplayValue('Exterior perimeter treated; monitor the north bed.')).toBeTruthy();
  });

  it('retains failed uploads across reloads and retries only photos, with one request per double tap', async () => {
    await seed();
    const completion = vi.fn().mockResolvedValue({ serviceRecordId: 'record-1', completionPhotoUpload: { failed: 1 } });
    const first = await mount(completion);
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    await act(async () => fireEvent.click(submitButton()));
    await screen.findByRole('button', { name: 'Retry photo uploads' });
    expect(completionResumeOwed(service.id)).toBe(true);
    first.unmount();
    expect(await getCompletionDraft(service.id)).toMatchObject({
      pendingPhotoCompletion: { serviceRecordId: 'record-1' }, servicePhotos: [{ data: photos[0].data }],
    });

    const originalFetch = fetch.getMockImplementation();
    let failUpload = true;
    const uploads = [];
    const reconciles = [];
    fetch.mockImplementation(async (url, options) => {
      if (url === `/api/tech/services/${service.id}/photos`) {
        uploads.push(options);
        return { ok: !failUpload, status: 503, json: async () => failUpload ? { error: 'Upload unavailable' } : { photo: { id: 'photo-1' } } };
      }
      if (url === `/api/tech/services/${service.id}/photos/reconcile`) {
        reconciles.push(options);
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return originalFetch(url, options);
    });
    const resubmit = vi.fn();
    const second = await mount(resubmit);
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'Retry photo uploads' })));
    expect(resubmit).not.toHaveBeenCalled();
    expect(completionResumeOwed(service.id)).toBe(true);
    expect(await getCompletionDraft(service.id)).toMatchObject({ servicePhotos: [{ data: photos[0].data }] });
    second.unmount();

    failUpload = false;
    const third = await mount(resubmit);
    const retry = await screen.findByRole('button', { name: 'Retry photo uploads' });
    await act(async () => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(uploads).toHaveLength(2);
    expect(uploads[1].body.get('caption')).toBe(photos[0].caption);
    expect(uploads[1].headers['Content-Type']).toBeUndefined();
    expect(resubmit).not.toHaveBeenCalled();
    expect(completion).toHaveBeenCalledTimes(1);
    // The failed retry never reconciles; the successful one reconciles once.
    expect(reconciles).toHaveLength(1);
    expect(reconciles[0].method).toBe('POST');
    expect(completionResumeOwed(service.id)).toBe(false);
    third.unmount();
    expect(await getCompletionDraft(service.id)).toBeNull();
  });

  it('keeps the autosaved photo revision when closeout reports failed uploads, so a lost IndexedDB write still reopens recovery (Codex r-63b2098 P1)', async () => {
    const draft = { serviceId: service.id, draftId: 'draft-one', savedAt: '2020-01-01T12:00:00Z',
      notes: 'Exterior inspected', generationPhotoCount: 1, servicePhotos: photos, sendSms: false };
    const { servicePhotos: _photos, ...metadata } = draft;
    localStorage.setItem(key, JSON.stringify(metadata));
    await putCompletionDraft(service.id, draft);
    const completion = vi.fn().mockResolvedValue({ serviceRecordId: 'record-1', completionPhotoUpload: { failed: 1 } });
    const first = await mount(completion);
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    // The page dies while the recovery draft's IndexedDB write is in flight:
    // localStorage already names the revision, IndexedDB still holds the
    // autosave under its id.
    vi.spyOn(completionStore, 'putCompletionDraft').mockResolvedValue(true);
    await act(async () => fireEvent.click(submitButton()));
    await screen.findByRole('button', { name: 'Retry photo uploads' });
    expect(JSON.parse(localStorage.getItem(key))).toMatchObject({ draftId: 'draft-one', pendingPhotoCompletion: { serviceRecordId: 'record-1' } });
    first.unmount();
    vi.restoreAllMocks();
    expect(await getCompletionDraft(service.id)).toMatchObject({ draftId: 'draft-one', servicePhotos: photos });

    const uploads = [];
    const originalFetch = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, options) => {
      if (url === `/api/tech/services/${service.id}/photos`) { uploads.push(options); return { ok: true, json: async () => ({ photo: { id: 'photo-1' } }) }; }
      if (url === `/api/tech/services/${service.id}/photos/reconcile`) return { ok: true, json: async () => ({ ok: true }) };
      return originalFetch(url, options);
    });
    const resubmit = vi.fn();
    await mount(resubmit);
    // Recovery reopens on the stored photos — never a Restore prompt for a
    // visit whose closeout already succeeded.
    const retry = await screen.findByRole('button', { name: 'Retry photo uploads' });
    expect(screen.queryByRole('button', { name: 'Restore', exact: true })).toBeNull();
    await act(async () => fireEvent.click(retry));
    expect(resubmit).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(1);
    expect(uploads[0].body.get('caption')).toBe(photos[0].caption);
    expect(uploads[0].body.get('sortOrder')).toBe('0');
  });

  it('a server-side reconcileOwed with every photo attached keeps recovery open and finishes with one reconcile, no uploads', async () => {
    await seed();
    const completion = vi.fn().mockResolvedValue({ serviceRecordId: 'record-1', completionPhotoUpload: { failed: 0, reconcileOwed: true } });
    const first = await mount(completion);
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    await act(async () => fireEvent.click(submitButton()));
    await screen.findByText(/report still needs updating/);
    expect(screen.getByRole('button', { name: 'Finish report update' })).toBeTruthy();
    expect(completionResumeOwed(service.id)).toBe(true);
    first.unmount();
    expect(await getCompletionDraft(service.id)).toMatchObject({ reconcileOwed: true, servicePhotos: [], pendingPhotoCompletion: { serviceRecordId: 'record-1' } });

    const originalFetch = fetch.getMockImplementation();
    const uploads = [];
    const reconciles = [];
    fetch.mockImplementation(async (url, options) => {
      if (url === `/api/tech/services/${service.id}/photos`) { uploads.push(options); return { ok: true, json: async () => ({}) }; }
      if (url === `/api/tech/services/${service.id}/photos/reconcile`) { reconciles.push(options); return { ok: true, json: async () => ({ ok: true }) }; }
      return originalFetch(url, options);
    });
    const resubmit = vi.fn();
    const second = await mount(resubmit);
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'Finish report update' })));
    expect(uploads).toHaveLength(0);
    expect(reconciles).toHaveLength(1);
    expect(resubmit).not.toHaveBeenCalled();
    expect(completionResumeOwed(service.id)).toBe(false);
    second.unmount();
    expect(await getCompletionDraft(service.id)).toBeNull();
  });

  it('keeps the recovery marker when the uploads land but the report reconciliation fails', async () => {
    await seed();
    const completion = vi.fn().mockResolvedValue({ serviceRecordId: 'record-1', completionPhotoUpload: { failed: 1 } });
    const first = await mount(completion);
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    await act(async () => fireEvent.click(submitButton()));
    await screen.findByRole('button', { name: 'Retry photo uploads' });
    first.unmount();

    const originalFetch = fetch.getMockImplementation();
    let failReconcile = true;
    const uploads = [];
    const reconciles = [];
    fetch.mockImplementation(async (url, options) => {
      if (url === `/api/tech/services/${service.id}/photos`) {
        uploads.push(options);
        return { ok: true, json: async () => ({ photo: { id: 'photo-1' } }) };
      }
      if (url === `/api/tech/services/${service.id}/photos/reconcile`) {
        reconciles.push(options);
        return { ok: !failReconcile, status: 409, json: async () => failReconcile ? { code: 'report_render_in_flight' } : { ok: true } };
      }
      return originalFetch(url, options);
    });
    const resubmit = vi.fn();
    const second = await mount(resubmit);
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'Retry photo uploads' })));
    expect(uploads).toHaveLength(1);
    expect(reconciles).toHaveLength(1);
    // Photos are uploaded, so the panel must not offer to upload them again —
    // but recovery is NOT complete until the server rebuilds the report.
    expect(completionResumeOwed(service.id)).toBe(true);
    await screen.findByText(/report could not be updated yet/);
    expect(screen.getByRole('button', { name: 'Finish report update' })).toBeTruthy();
    second.unmount();
    expect(await getCompletionDraft(service.id)).toMatchObject({ reconcileOwed: true, servicePhotos: [], pendingPhotoCompletion: { serviceRecordId: 'record-1' } });

    failReconcile = false;
    const third = await mount(resubmit);
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'Finish report update' })));
    expect(uploads).toHaveLength(1);
    expect(reconciles).toHaveLength(2);
    expect(resubmit).not.toHaveBeenCalled();
    expect(completionResumeOwed(service.id)).toBe(false);
    third.unmount();
    expect(await getCompletionDraft(service.id)).toBeNull();
  });

  it('a late field edit cannot replace the pending photo recovery while storage settles', async () => {
    await seed();
    const view = await mount(vi.fn().mockResolvedValue({ serviceRecordId: 'record-1', completionPhotoUpload: { failed: 1 } }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    const originalPut = completionStore.putCompletionDraft;
    let releaseStorage;
    const storageWait = new Promise((resolve) => { releaseStorage = resolve; });
    let writingRecovery = false;
    vi.spyOn(completionStore, 'putCompletionDraft').mockImplementation((id, draft) => {
      if (draft.pendingPhotoCompletion && !writingRecovery) {
        writingRecovery = true;
        return storageWait.then(() => originalPut(id, draft));
      }
      return originalPut(id, draft);
    });
    fireEvent.click(submitButton());
    await waitFor(() => expect(writingRecovery).toBe(true));
    fireEvent.change(screen.getByPlaceholderText('Notes about this service...'), { target: { value: 'Late edit while closeout settles' } });
    await act(async () => releaseStorage());
    await screen.findByRole('button', { name: 'Retry photo uploads' });
    view.unmount();
    expect(await getCompletionDraft(service.id)).toMatchObject({ pendingPhotoCompletion: { serviceRecordId: 'record-1' } });
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

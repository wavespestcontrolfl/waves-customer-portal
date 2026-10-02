// @vitest-environment jsdom
// Photos in the notes box (GATE_NOTE_BOX_PHOTOS, owner "ok go" 2026-10-02 on
// the Fast Complete mockup v8): with the schedule's per-visit flag on, the
// Complete Service form puts the visit's photos inside the notes box, each
// with a description typed (or said) in place; the description is the
// photo's caption, sent to Generate and frozen with the photo. Off, or on a
// lawn or tree, shrub & palm visit, the form's photo section is unchanged.
// Seeds photos through a restored draft, like
// SchedulePage.report-photo-captions.test.jsx.
import { IDBFactory } from 'fake-indexeddb';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';
import { putCompletionDraft } from '../../lib/completion-resume-store';

const base = {
  id: 'note-box-visit', customerId: 'note-box-customer', customerName: 'Synthetic Customer',
  serviceType: 'Pest Control', status: 'confirmed', scheduledDate: '2099-01-01', estimatedPrice: 100,
};
const photos = [
  { name: 'porch.jpg', data: 'data:image/jpeg;base64,AAAA', capturedAt: '2099-01-01T12:00:00Z', caption: 'Ants at the front porch.', captionSource: 'ai' },
  { name: 'sink.jpg', data: 'data:image/jpeg;base64,BBBB', capturedAt: '2099-01-01T12:01:00Z' },
];

let generateReportCalls;
beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('alert', vi.fn());
  localStorage.clear();
  generateReportCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (url.includes('generate-report')) {
      generateReportCalls.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ report: 'WHAT WE DID\n\nTreated the perimeter.\n\nWHAT WE FOUND\n\nNo activity noted.' }) };
    }
    return { ok: true, json: async () => ({ customer: {}, actions: [], available: false }) };
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function restoreWithPhotos(service, onSubmit = vi.fn().mockResolvedValue({})) {
  const draft = {
    serviceId: service.id, draftId: 'draft-one', savedAt: '2099-01-01T12:00:00Z',
    notes: 'Treated the exterior perimeter.', generationPhotoCount: photos.length, servicePhotos: photos, sendSms: false,
  };
  const { servicePhotos: _photos, ...metadata } = draft;
  localStorage.setItem(`waves_completion_draft_${service.id}`, JSON.stringify(metadata));
  await putCompletionDraft(service.id, draft);
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={onSubmit} />);
  await screen.findByPlaceholderText('Notes about this service...');
  await waitFor(() => expect(screen.queryByText('Loading saved draft…')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
  return onSubmit;
}

describe('photos in the notes box', () => {
  it('on: the photos sit in the notes box with their descriptions, and the photo section is gone', async () => {
    await restoreWithPhotos({ ...base, noteBoxPhotosEnabled: true });
    expect(await screen.findByRole('button', { name: 'Describe photo 1' })).toBeTruthy();
    expect(screen.getByText('Notes and photos')).toBeTruthy();
    expect(screen.queryByText('Service Photos')).toBeNull();
    expect(screen.getByText('Ants at the front porch.')).toBeTruthy();
    expect(screen.getByText('Add a description')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Add photo/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Describe with AI' })).toBeTruthy();
  });

  it('a description typed in place is the photo\'s caption: Generate reads it, and the completion sends it as the tech\'s', async () => {
    const onSubmit = await restoreWithPhotos({ ...base, noteBoxPhotosEnabled: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Describe photo 2' }));
    fireEvent.change(screen.getByLabelText('Description for photo 2'), { target: { value: 'Droppings under the kitchen sink.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save description' }));
    expect(screen.getByText('Droppings under the kitchen sink.')).toBeTruthy();

    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
    await waitFor(() => expect(generateReportCalls.length).toBe(1));
    expect(generateReportCalls[0].photoCaptions).toEqual(['Ants at the front porch.', 'Droppings under the kitchen sink.']);

    const submit = screen.getByRole('button', { name: /^(Complete & Send Recap|Complete Service)/i });
    await waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => fireEvent.click(submit));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const sent = onSubmit.mock.calls[0][1].completionPhotos;
    expect(sent[0]).toMatchObject({ caption: 'Ants at the front porch.', aiTags: { captionSource: 'ai' } });
    expect(sent[1]).toMatchObject({ caption: 'Droppings under the kitchen sink.' });
    expect(sent[1]).not.toHaveProperty('aiTags');
  });

  it('removing a photo from the notes box drops it and its description', async () => {
    await restoreWithPhotos({ ...base, noteBoxPhotosEnabled: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove photo 1' }));
    await waitFor(() => expect(screen.queryByText('Ants at the front porch.')).toBeNull());
    expect(screen.getByRole('button', { name: 'Describe photo 1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Describe photo 2' })).toBeNull();
  });

  it.each([
    ['off', { ...base }],
    ['a tree & shrub visit', { ...base, serviceType: 'Tree & Shrub Care', noteBoxPhotosEnabled: true }],
  ])('%s: the form keeps its photo section', async (_label, service) => {
    await restoreWithPhotos(service);
    expect(await screen.findByText('Service Photos')).toBeTruthy();
    expect(screen.queryByText('Notes and photos')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Describe photo 1' })).toBeNull();
    expect(within(document.body).getAllByRole('button', { name: '×' }).length).toBe(photos.length);
  });
});

// @vitest-environment jsdom
// Fast Complete: the visit note (typed or dictated), the photo manager entry
// and the one-tip picker. The rest of the sheet is pinned in
// FastCompleteSheet.test.jsx.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// The mic: a supported browser whose transcript the test delivers by hand.
const dictation = vi.hoisted(() => ({ onTranscript: null, options: null, state: { listening: false, mode: 'speech', starting: false, uploading: false } }));
vi.mock('../../hooks/useSpeechDictation', () => ({
  default: (onTranscript, options) => {
    dictation.onTranscript = onTranscript;
    dictation.options = options;
    return { supported: true, toggle: () => {}, cancel: () => {}, ...dictation.state };
  },
}));
vi.mock('./TechServicePhotosModal', () => ({
  default: ({ serviceId, onClose }) => (
    <div role="dialog" aria-label="Photo manager">
      <span>{`photos for ${serviceId}`}</span>
      <button type="button" onClick={onClose}>Done with photos</button>
    </div>
  ),
}));

import FastCompleteSheet from './FastCompleteSheet';

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  dictation.state = { listening: false, mode: 'speech', starting: false, uploading: false };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const CATALOG = [
  { id: 'taurus', name: 'Taurus SC', category: 'Insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' },
  { id: 'talstar', name: 'Atticus Talak 7.9 F', category: 'Insecticide' },
  { id: 'surfactant', name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant' },
];
const CONTEXT_SERVICE = {
  id: 'svc-1', customerName: 'Pat Jones', customerId: 'cust-1', propertyId: 'prop-1',
  serviceType: 'Pest Control Re-Service', scheduledDate: '2026-09-26', address: { line1: '123 Main St' },
  serviceKey: 'pest_re_service', status: 'confirmed',
};
const tip = (id, label, extra = {}) => ({ id, label, keywords: [], copy: `${label} copy. More detail.`, ...extra });
const TIP_LIBRARY = {
  available: true,
  groups: [
    { id: 'moisture', label: 'Moisture', tips: [tip('hose_bib', 'Fix drips at hose bibs', { keywords: ['ghost ants'] }), tip('under_sink', 'Check under the kitchen sink')] },
    { id: 'lighting', label: 'Lighting', tips: [tip('warm_bulbs', 'Warm porch bulbs'), tip('motion', 'Lights on a motion sensor'), tip('aim_away', 'Aim landscape lights away')] },
  ],
  lastSent: { warm_bulbs: '2026-08-03' },
  conditions: { irrigation_on_file: false },
};

function makeRequest({ tips = { available: false }, photos = [] } = {}) {
  const calls = [];
  let photoList = photos;
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options });
    if (path.split('?')[0].endsWith('/pest-recap/context')) return { ok: true, eligible: true, reportFlow: true, service: CONTEXT_SERVICE, products: CATALOG };
    if (path.endsWith('/tech-rating-allowed')) return { allowed: false };
    if (path.endsWith('/tech-tips')) {
      if (tips instanceof Error) throw tips;
      return tips;
    }
    if (path.endsWith('/photos')) return { photos: photoList };
    if (path.endsWith('/complete')) return { success: true };
    return {};
  });
  request.calls = calls;
  request.setPhotos = (next) => { photoList = next; };
  return request;
}

const SERVICE = { id: 'svc-1', customerName: 'Pat Jones', serviceType: 'Pest Re-Service', address: '123 Main St', timeLabel: '2:00 PM' };

async function openSheet(request) {
  render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} />);
  await screen.findByRole('button', { name: /Taurus SC/ });
}

async function completeAndReadBody(request) {
  fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
  fireEvent.click(screen.getByRole('button', { name: 'Outside' }));
  fireEvent.click(screen.getByRole('button', { name: 'Complete re-service' }));
  await waitFor(() => expect(request.calls.some((c) => c.path.endsWith('/complete'))).toBe(true));
  return JSON.parse(request.calls.find((c) => c.path.endsWith('/complete')).options.body);
}

describe('FastCompleteSheet visit note', () => {
  test('the note is on the sheet from the start and what is dictated joins what was typed', async () => {
    const request = makeRequest();
    await openSheet(request);

    const note = screen.getByLabelText('Tell me about the visit');
    fireEvent.change(note, { target: { value: 'Sprayed the garage threshold.' } });
    // The mic is told which visit it is for, so a phone without speech
    // recognition can send a recorded clip for transcription.
    expect(dictation.options).toEqual({ uploadServiceId: 'svc-1' });
    React.act(() => dictation.onTranscript('Ghost ants at the kitchen window.'));
    expect(note.value).toBe('Sprayed the garage threshold. Ghost ants at the kitchen window.');

    const body = await completeAndReadBody(request);
    expect(body.technicianNotes).toBe('Sprayed the garage threshold. Ghost ants at the kitchen window.');
  });
});

describe('FastCompleteSheet recorded dictation', () => {
  async function fillRequired(request) {
    await openSheet(request);
    fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Outside' }));
    return screen.getByRole('button', { name: 'Complete re-service' });
  }

  test('a clip still recording holds the completion until it is stopped', async () => {
    dictation.state = { listening: true, mode: 'upload', uploading: false };
    const submit = await fillRequired(makeRequest());
    expect(submit.disabled).toBe(true);
    expect(screen.getByText('Finish dictating before you complete.')).toBeTruthy();
  });

  test('a clip being transcribed holds the completion and the mic', async () => {
    dictation.state = { listening: false, mode: 'upload', uploading: true };
    const submit = await fillRequired(makeRequest());
    expect(submit.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Transcribing' }).disabled).toBe(true);
  });

  test('the completion and photos wait from the mic tap, while the phone is still asking for the mic', async () => {
    dictation.state = { listening: false, mode: 'upload', starting: true, uploading: false };
    const submit = await fillRequired(makeRequest());
    expect(submit.disabled).toBe(true);
    expect(screen.getByText('Finish dictating before you complete.')).toBeTruthy();
    const photos = screen.getByRole('button', { name: 'Add photos' });
    expect(photos.disabled).toBe(true);
    fireEvent.click(photos);
    expect(screen.queryByRole('dialog', { name: 'Photo manager' })).toBeNull();
  });

  test('photos wait until a recorded clip is finished', async () => {
    dictation.state = { listening: true, mode: 'upload', uploading: false };
    await fillRequired(makeRequest());
    const photos = screen.getByRole('button', { name: 'Add photos' });
    expect(photos.disabled).toBe(true);
    fireEvent.click(photos);
    expect(screen.queryByRole('dialog', { name: 'Photo manager' })).toBeNull();
  });

  // The full form is another page and carries nothing over from the sheet,
  // so leaving for it mid-clip would drop the dictation.
  test.each([
    ['still starting', { starting: true }],
    ['recording', { listening: true }],
    ['being transcribed', { uploading: true }],
  ])('Full form and + Other product wait while a clip is %s', async (_, clipState) => {
    dictation.state = { listening: false, mode: 'upload', starting: false, uploading: false, ...clipState };
    const onFullForm = vi.fn();
    render(<FastCompleteSheet service={SERVICE} request={makeRequest()} onClose={() => {}} onFullForm={onFullForm} />);
    await screen.findByRole('button', { name: /Taurus SC/ });
    const fullForm = screen.getByRole('button', { name: 'Full form' });
    const otherProduct = screen.getByRole('button', { name: '+ Other product' });
    // The mic reports the clip from an effect after the form mounts, so the
    // hold lands a render later.
    await waitFor(() => expect(fullForm.disabled).toBe(true));
    expect(otherProduct.disabled).toBe(true);
    fireEvent.click(fullForm);
    fireEvent.click(otherProduct);
    expect(onFullForm).not.toHaveBeenCalled();
    // With the catalog loaded, + Other product opens the picker, not the full form.
    expect(screen.queryByRole('dialog', { name: 'Add a product' })).toBeNull();
  });

  test('live speech recognition never holds the completion', async () => {
    dictation.state = { listening: true, mode: 'speech', uploading: false };
    const submit = await fillRequired(makeRequest());
    expect(submit.disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Add photos' }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Full form' }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: '+ Other product' }).disabled).toBe(false);
  });
});

describe('FastCompleteSheet photos', () => {
  test('opens the photo manager for this visit and re-reads the count when it closes', async () => {
    const request = makeRequest({ photos: [] });
    await openSheet(request);

    expect(screen.getByText('Optional')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add photos' }));
    expect(screen.getByText('photos for svc-1')).toBeTruthy();

    request.setPhotos([{ id: 'p1' }, { id: 'p2' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Done with photos' }));
    expect(await screen.findByText('2 added')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Photo manager' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add or view photos' })).toBeTruthy();
  });

  test('the sheet is inert and hidden from assistive tech while the photo manager is open', async () => {
    const request = makeRequest();
    await openSheet(request);
    const sheet = screen.getByRole('dialog', { name: 'Complete re-service' });
    expect(sheet.hasAttribute('inert')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Add photos' }));
    expect(sheet.getAttribute('aria-hidden')).toBe('true');
    expect(sheet.hasAttribute('inert')).toBe(true);
    // The photo manager sits outside the hidden sheet.
    expect(sheet.contains(screen.getByText('photos for svc-1'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Done with photos' }));
    expect(sheet.hasAttribute('aria-hidden')).toBe(false);
    expect(sheet.hasAttribute('inert')).toBe(false);
  });

  test('a first count still in flight never overwrites the count read after the manager closes', async () => {
    const request = makeRequest();
    const base = request.getMockImplementation();
    let releaseFirst;
    let photoReads = 0;
    request.mockImplementation(async (path, options) => {
      if (path.endsWith('/photos')) {
        photoReads += 1;
        if (photoReads === 1) {
          await new Promise((resolve) => { releaseFirst = resolve; });
          return { photos: [] };
        }
        return { photos: [{ id: 'p1' }] };
      }
      return base(path, options);
    });
    await openSheet(request);

    fireEvent.click(screen.getByRole('button', { name: 'Add photos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done with photos' }));
    expect(await screen.findByText('1 added')).toBeTruthy();

    await React.act(async () => { releaseFirst(); });
    expect(screen.getByText('1 added')).toBeTruthy();
  });

  test('a photo count that cannot be read never blocks the sheet', async () => {
    const request = makeRequest();
    const base = request.getMockImplementation();
    request.mockImplementation(async (path, options) => {
      if (path.endsWith('/photos')) throw new Error('offline');
      return base(path, options);
    });
    await openSheet(request);
    expect(screen.getByRole('button', { name: 'Add photos' })).toBeTruthy();
    const body = await completeAndReadBody(request);
    expect(body.visitOutcome).toBe('completed');
  });
});

describe('FastCompleteSheet tip for the customer', () => {
  test('with the picker unavailable nothing is shown and no tip is sent', async () => {
    const request = makeRequest({ tips: { available: false } });
    await openSheet(request);
    expect(screen.queryByText('Tip for the customer')).toBeNull();
    const body = await completeAndReadBody(request);
    expect(body.techTips).toBeNull();
  });

  test('a failed tips read hides the picker and leaves the sheet usable', async () => {
    const request = makeRequest({ tips: new Error('tips down') });
    await openSheet(request);
    expect(screen.queryByText('Tip for the customer')).toBeNull();
    const body = await completeAndReadBody(request);
    expect(body.techTips).toBeNull();
  });

  test('a tips read that has not answered never holds the sheet; the picker appears when it does', async () => {
    const request = makeRequest();
    const base = request.getMockImplementation();
    let answerTips;
    request.mockImplementation(async (path, options) => {
      if (path.endsWith('/tech-tips')) return new Promise((resolve) => { answerTips = resolve; });
      return base(path, options);
    });
    await openSheet(request);
    // The form is usable with the tips read still open.
    expect(screen.getByLabelText('Tell me about the visit')).toBeTruthy();
    expect(screen.queryByText('Tip for the customer')).toBeNull();

    await React.act(async () => { answerTips(TIP_LIBRARY); });
    expect(await screen.findByText('Tip for the customer')).toBeTruthy();
  });

  const searchTips = (value) => fireEvent.change(screen.getByLabelText('Search tips'), { target: { value } });
  const tipButton = (name) => screen.getByRole('button', { name });

  test('no tip is listed until the tech searches; a pick shows alone and one tip goes on the wire (owner 2026-10-12)', async () => {
    const request = makeRequest({ tips: TIP_LIBRARY });
    await openSheet(request);
    await screen.findByText('Tip for the customer');

    expect(screen.getByText('Pick 1 (optional)')).toBeTruthy();
    // Nothing from the library before a search, and no "Show all".
    for (const name of [/Fix drips at hose bibs/, /Check under the kitchen sink/, /Warm porch bulbs/, /Lights on a motion sensor/, /Aim landscape lights away/]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();

    searchTips('light');
    expect(tipButton(/Lights on a motion sensor/)).toBeTruthy();
    expect(tipButton(/Aim landscape lights away/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Fix drips at hose bibs/ })).toBeNull();
    // A tip this customer already received says when.
    searchTips('porch');
    expect(tipButton(/Warm porch bulbs/).textContent).toContain('sent Aug 3');

    searchTips('sink');
    fireEvent.click(tipButton(/Check under the kitchen sink/));
    // The pick shows alone, pressed, with Remove tip; the search is gone until it is removed.
    expect(tipButton(/Check under the kitchen sink/).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByLabelText('Search tips')).toBeNull();
    expect(screen.getByText('1 picked')).toBeTruthy();

    const body = await completeAndReadBody(request);
    expect(body.techTips).toEqual({ ids: ['under_sink'], custom: null });
  });

  test('Remove tip, or a tap on the picked tip, clears it and brings the search back', async () => {
    const request = makeRequest({ tips: TIP_LIBRARY });
    await openSheet(request);
    await screen.findByText('Tip for the customer');
    searchTips('hose');
    fireEvent.click(tipButton(/Fix drips at hose bibs/));
    fireEvent.click(tipButton('Remove tip'));
    expect(screen.getByLabelText('Search tips')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove tip' })).toBeNull();

    searchTips('hose');
    fireEvent.click(tipButton(/Fix drips at hose bibs/));
    fireEvent.click(tipButton(/Fix drips at hose bibs/));
    expect(screen.getByLabelText('Search tips')).toBeTruthy();
    const body = await completeAndReadBody(request);
    expect(body.techTips).toEqual({ ids: [], custom: null });
  });

  test('a search reads keywords and the whole library, and says when nothing matches', async () => {
    const library = { ...TIP_LIBRARY, more: [tip('flea_yard', 'Open up where pets rest outside', { pests: ['Fleas'], keywords: ['dog run'] })] };
    const request = makeRequest({ tips: library });
    await openSheet(request);
    await screen.findByText('Tip for the customer');

    searchTips('ghost ants');
    expect(tipButton(/Fix drips at hose bibs/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Warm porch bulbs/ })).toBeNull();

    searchTips('zzz');
    expect(screen.getByText('No tips match.')).toBeTruthy();

    // A tip off this visit's list (`more`) is found, picked, and goes on the wire.
    searchTips('dog run');
    fireEvent.click(tipButton(/Open up where pets rest outside/));
    expect(tipButton(/Open up where pets rest outside/).getAttribute('aria-pressed')).toBe('true');
    const body = await completeAndReadBody(request);
    expect(body.techTips).toEqual({ ids: ['flea_yard'], custom: null });
  });

  test('the tech\'s own line has the note\'s microphone, and a spoken line joins what is there (owner 2026-10-09)', async () => {
    const request = makeRequest({ tips: TIP_LIBRARY });
    await openSheet(request);
    await screen.findByText('Tip for the customer');
    expect(screen.queryByRole('button', { name: 'Say your own tip' })).toBeNull();
    searchTips('hose');
    fireEvent.click(screen.getByRole('button', { name: /Fix drips at hose bibs/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Write your own' }));
    expect(screen.getByRole('button', { name: 'Say your own tip' })).toBeTruthy();
    // The last mic mounted is the tip's: its words go on the tip line, not the note.
    React.act(() => dictation.onTranscript('I brushed the mud dauber nests off the lanai'));
    React.act(() => dictation.onTranscript('and it is ready for paint.'));
    expect(screen.getByLabelText('Your own tip (one sentence)').value).toBe('I brushed the mud dauber nests off the lanai and it is ready for paint.');
    expect(screen.getByLabelText('Tell me about the visit').value).toBe('');
    // The spoken line replaces the library pick, as a typed one does.
    expect(screen.queryByRole('button', { name: 'Remove tip' })).toBeNull();
    expect(screen.getByRole('button', { name: /Fix drips at hose bibs/ }).getAttribute('aria-pressed')).toBe('false');
  });

  test('a tip the tech writes replaces a library pick, and the other way round', async () => {
    const request = makeRequest({ tips: TIP_LIBRARY });
    await openSheet(request);
    await screen.findByText('Tip for the customer');

    searchTips('hose');
    fireEvent.click(screen.getByRole('button', { name: /Fix drips at hose bibs/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Write your own' }));
    const own = screen.getByLabelText('Your own tip (one sentence)');
    expect(own.getAttribute('maxlength')).toBe('240');
    fireEvent.change(own, { target: { value: 'Keep the pet bowls off the lanai overnight.' } });
    // The typed line replaces the pick: the search is back, with the tip unpicked in its results.
    expect(screen.queryByRole('button', { name: 'Remove tip' })).toBeNull();
    expect(screen.getByRole('button', { name: /Fix drips at hose bibs/ }).getAttribute('aria-pressed')).toBe('false');

    searchTips('motion');
    fireEvent.click(screen.getByRole('button', { name: /Lights on a motion sensor/ }));
    expect(screen.queryByLabelText('Your own tip (one sentence)')?.value || '').toBe('');

    fireEvent.click(screen.getByRole('button', { name: /Lights on a motion sensor/ }));
    fireEvent.change(screen.getByLabelText('Your own tip (one sentence)'), { target: { value: '  Trim the hedge off the wall.  ' } });
    const body = await completeAndReadBody(request);
    expect(body.techTips).toEqual({ ids: [], custom: 'Trim the hedge off the wall.' });
  });
});

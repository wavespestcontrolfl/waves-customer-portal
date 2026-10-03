// @vitest-environment jsdom
// Voice fill on the report flow (GATE_FAST_COMPLETE_VOICE_FILL, delivered as the
// `voiceFillEnabled` prop; owner 2026-10-03: recurring pest too). On any pest
// visit the sheet opens in the report flow, the products the note names are read
// when the report is written and land as rows the tech confirms:
//  - the read rides beside the note's facts, before the report is written, and
//    the report is written from the rows as the read leaves them;
//  - every row the read set waits on a ✓, and every Check on a tap, before
//    Complete & send;
//  - a failed read fills nothing and holds nothing;
//  - the note's mic hands its clip to the sheet (our transcriber), not the
//    browser's speech recognition.
// Gate off, nothing here happens (FastCompleteSheet.report-flow.test.jsx).
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';

vi.mock('./TechTreatmentZoneModal', () => ({ default: () => null }));
vi.mock('./TechServicePhotosModal', () => ({ default: () => null }));
// The note's mic: what the sheet hands it is what matters here.
const mic = { props: null };
vi.mock('./DictationButton', () => ({
  default: (props) => {
    mic.props = props;
    return <button type="button">Talk about the visit</button>;
  },
}));

import FastCompleteSheet from './FastCompleteSheet';
import { NOTE_CLIP_ERROR, useNoteClip } from './FastCompleteVoiceFill';

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); mic.props = null; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const CATALOG = [
  { id: 'taurus', name: 'Taurus SC', category: 'Insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' },
  { id: 'talstar', name: 'Atticus Talak 7.9 F', category: 'Insecticide' },
  { id: 'surfactant', name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant' },
  { id: 'gel', name: 'Advion Ant Bait Gel', category: 'Bait' },
];
const REGULAR = {
  id: 'svc-1', customerName: 'Pat Jones', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-1',
  serviceType: 'Quarterly Pest Control', scheduledDate: '2026-10-01', address: { line1: '123 Main St' },
  serviceKey: 'pest_general_quarterly', status: 'confirmed',
};
const REPORT = ['WHAT WE FOUND', 'Ants on the counter.', '', 'WHAT WE DID AND WHY', 'We treated the kitchen.', '', 'WHAT TO EXPECT', 'Fewer ants.', '', "WHAT'S NEXT", 'Wipe the counters.'].join('\n');
const NOTE = 'Ants on the kitchen counter. Six ounces of Taurus inside, and five grams of the Advion gel on the counter edge.';
const FACTS = { available: true, status: 'read', areas: ['Inside'], pests: ['ants'] };
const read = (products, unclear = []) => ({ enabled: true, available: true, status: 'read', products, unclear });
const TAURUS_SIX = { productId: 'taurus', amount: 6, unit: 'fl_oz', sameAsLast: false, method: 'spot_treatment', heard: 'Six ounces of Taurus' };
const GEL_FIVE = { productId: 'gel', amount: 5, unit: 'g', sameAsLast: false, method: 'bait_placement', heard: 'five grams of the Advion gel' };

function makeRequest({ fill = read([TAURUS_SIX]) } = {}) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options, body: typeof options?.body === 'string' ? JSON.parse(options.body) : null });
    if (path.split('?')[0].endsWith('/pest-recap/context')) return { ok: true, eligible: true, reportFlow: true, service: REGULAR, products: CATALOG };
    if (path.endsWith('/tech-rating-allowed')) return { allowed: true, firstVisit: false, scaleLabels: null };
    if (path.endsWith('/tech-tips')) return { available: false };
    if (path.split('?')[0].endsWith('/promises')) return { available: false, promises: [] };
    if (path.split('?')[0].endsWith('/blog-posts')) return { available: false, posts: [] };
    if (path.endsWith('/photos')) return { photos: [] };
    if (path.split('?')[0].endsWith('/treatment-zone')) return { enabled: true, treatmentZone: null };
    if (path === '/admin/schedule/generate-report') return { report: REPORT };
    if (path.endsWith('/voice-facts')) return FACTS;
    if (path.endsWith('/voice-fill/products')) {
      const answer = typeof request.fill === 'function' ? request.fill() : request.fill;
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (path.endsWith('/complete')) return { success: true };
    return {};
  });
  request.fill = fill;
  request.calls = calls;
  request.bodies = (suffix) => calls.filter((call) => call.path.endsWith(suffix)).map((call) => call.body);
  return request;
}

const SERVICE = {
  id: 'svc-1', customerName: 'Pat Jones', serviceType: 'Quarterly Pest Control', address: '123 Main St', timeLabel: '9:00 AM',
  reportFlow: true, traceEligible: true, lat: 27.4, lng: -82.5, technicianName: 'Adam',
};

async function openSheet(request, props = { voiceFillEnabled: true }) {
  render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} onCompleted={() => {}} {...props} />);
  await screen.findByText(/Taurus SC 4 fl oz/);
}
async function generate(label = 'Generate AI report') {
  if (label === 'Generate AI report') {
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
    fireEvent.click(screen.getByRole('button', { name: '3, moderate' }));
  }
  fireEvent.click(screen.getByRole('button', { name: label }));
  await screen.findByText('Report the customer will see');
}
const completeButton = () => screen.getByRole('button', { name: 'Complete & send' });
const confirmList = () => screen.getByRole('region', { name: 'Confirm what I filled' });
const sent = (request) => request.bodies('/complete')[0];

describe('report flow, voice fill off', () => {
  test('no product read is asked for, and the mic is as it was', async () => {
    const request = makeRequest();
    await openSheet(request, {});
    expect(mic.props.clipHandler).toBeUndefined();
    await generate();
    expect(request.bodies('/voice-fill/products')).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Confirm what I filled' })).toBeNull();
    expect(completeButton().disabled).toBe(false);
  });
});

describe('report flow, voice fill on: products from the note', () => {
  test('the read rides beside the note\'s facts, before the report is written', async () => {
    const request = makeRequest();
    await openSheet(request);
    await generate();
    const order = request.calls.map((call) => call.path).filter((path) => /voice-facts|voice-fill|generate-report/.test(path));
    expect(order).toEqual(['/admin/dispatch/svc-1/voice-facts', '/admin/dispatch/svc-1/fast-complete/voice-fill/products', '/admin/schedule/generate-report']);
    expect(request.bodies('/voice-fill/products')).toEqual([{ note: NOTE }]);
  });

  test('a spoken amount lands on the house-mix row, waits on ✓, then goes on the record', async () => {
    const request = makeRequest();
    await openSheet(request);
    await generate();
    const item = within(confirmList()).getByText(/Taurus SC — 6 fl oz/);
    expect(item.textContent).toContain('Heard: “Six ounces of Taurus”');
    expect(screen.getByText('Confirm the products I filled.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Taurus SC — 6 fl oz' }));
    expect(screen.queryByRole('region', { name: 'Confirm what I filled' })).toBeNull();
    // confirming is not a change to what the report was written from
    expect(screen.queryByRole('button', { name: 'Write it again' })).toBeNull();
    fireEvent.click(completeButton());
    await screen.findByTestId('fast-complete-sent');
    const taurus = sent(request).products.find((p) => p.productId === 'taurus');
    expect(taurus).toMatchObject({ totalAmount: 6, amountUnit: 'fl_oz', applicationMethod: 'spot_treatment' });
    // a product the note did not name keeps the amount it opened with
    expect(sent(request).products.find((p) => p.productId === 'talstar')).toMatchObject({ totalAmount: 4, amountUnit: 'fl_oz' });
  });

  test('a product the note names that is not on the sheet is added, and the report is written with it', async () => {
    const request = makeRequest({ fill: read([TAURUS_SIX, GEL_FIVE]) });
    await openSheet(request);
    await generate();
    const [payload] = request.bodies('/generate-report');
    expect(payload.products.map((p) => [p.name, p.applicationMethod])).toContainEqual(['Advion Ant Bait Gel', 'bait_placement']);
    expect(payload.productsApplied).toContain('Advion Ant Bait Gel');
    expect(within(confirmList()).getByText(/Advion Ant Bait Gel — 5 g/)).toBeTruthy();
    // the report was written from these rows: nothing is stale
    expect(screen.queryByRole('button', { name: 'Write it again' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Taurus SC — 6 fl oz' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Advion Ant Bait Gel — 5 g' }));
    fireEvent.click(completeButton());
    await screen.findByTestId('fast-complete-sent');
    expect(sent(request).products.find((p) => p.productId === 'gel')).toMatchObject({ totalAmount: 5, amountUnit: 'g', applicationMethod: 'bait_placement' });
  });

  test('a spray\'s way stays the note\'s own read: the product\'s spoken way is not a tap', async () => {
    const request = makeRequest({ fill: read([{ ...TAURUS_SIX, method: 'perimeter_spray' }]) });
    await openSheet(request);
    await generate();
    // voice-facts heard no perimeter, so the spray is a spot treatment
    expect(request.bodies('/generate-report')[0].products.find((p) => p.name === 'Taurus SC').applicationMethod).toBe('spot_treatment');
    expect(screen.queryByRole('region', { name: 'Check' })).toBeNull();
  });

  test('what the read could not settle is a Check that holds the send until the tech taps it', async () => {
    const request = makeRequest({ fill: read([], [{ heard: 'the other stuff', reason: 'unknown_product' }]) });
    await openSheet(request);
    await generate();
    expect(within(screen.getByRole('region', { name: 'Check' })).getByText(/the other stuff/)).toBeTruthy();
    expect(screen.getByText("Check what I couldn't fill.")).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '✓ Got it' }));
    expect(completeButton().disabled).toBe(false);
  });

  test('a Check the tech answered is not raised again when the report is written again', async () => {
    const request = makeRequest({ fill: read([], [{ heard: 'the other stuff', reason: 'unknown_product' }]) });
    await openSheet(request);
    await generate();
    fireEvent.click(screen.getByRole('button', { name: '✓ Got it' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to the visit' }));
    fireEvent.click(screen.getByRole('button', { name: '4, elevated' }));
    await generate('Write it again');
    await waitFor(() => expect(request.bodies('/voice-fill/products')).toHaveLength(2));
    expect(screen.queryByRole('region', { name: 'Check' })).toBeNull();
    expect(completeButton().disabled).toBe(false);
  });

  test('a product the tech removed after the read stays removed on the next read', async () => {
    const request = makeRequest({ fill: read([GEL_FIVE]) });
    await openSheet(request);
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the visit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: /^Advion Ant Bait Gel/ }));
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    // removing the row answers its confirm
    expect(screen.queryByRole('region', { name: 'Confirm what I filled' })).toBeNull();
    // the same note, read again: the reader may quote other words for it this time
    request.fill = read([{ ...GEL_FIVE, heard: 'grams of the Advion gel on the counter edge' }]);
    await generate('Write it again');
    await waitFor(() => expect(request.bodies('/voice-fill/products')).toHaveLength(2));
    expect(request.bodies('/generate-report')[1].productsApplied).not.toContain('Advion');
    expect(screen.queryByRole('region', { name: 'Confirm what I filled' })).toBeNull();
  });

  test('saying it again another way (an edited note) brings a removed product back', async () => {
    const request = makeRequest({ fill: read([GEL_FIVE]) });
    await openSheet(request);
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the visit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: /^Advion Ant Bait Gel/ }));
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: `${NOTE} Two grams of the Advion gel by the sink.` } });
    request.fill = read([{ ...GEL_FIVE, amount: 2, heard: 'Two grams of the Advion gel' }]);
    await generate('Write it again');
    await waitFor(() => expect(request.bodies('/voice-fill/products')).toHaveLength(2));
    expect(request.bodies('/generate-report')[1].productsApplied).toContain('Advion Ant Bait Gel');
    expect(within(confirmList()).getByText(/Advion Ant Bait Gel — 2 g/)).toBeTruthy();
  });

  test.each([
    ['the read fails', () => ({ enabled: true, available: true, status: 'failed', reason: 'model_failed', products: [], unclear: [] })],
    ['the read is down', () => Object.assign(new Error('down'), { status: 502 })],
  ])('%s: nothing is filled, nothing is held, and the report is still written', async (_name, fill) => {
    const request = makeRequest({ fill });
    await openSheet(request);
    await generate();
    expect(screen.queryByRole('region', { name: 'Confirm what I filled' })).toBeNull();
    expect(completeButton().disabled).toBe(false);
    fireEvent.click(completeButton());
    await screen.findByTestId('fast-complete-sent');
    expect(sent(request).products.find((p) => p.productId === 'taurus')).toMatchObject({ totalAmount: 4 });
  });

  test('the gate going off since the sheet opened (404) stops the read, and the report is still written', async () => {
    const request = makeRequest({ fill: () => Object.assign(new Error('Request failed (404)'), { status: 404 }) });
    await openSheet(request);
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the visit' }));
    fireEvent.click(screen.getByRole('button', { name: '4, elevated' }));
    await generate('Write it again');
    await waitFor(() => expect(request.bodies('/generate-report')).toHaveLength(2));
    expect(request.bodies('/voice-fill/products')).toHaveLength(1);
  });
});

describe('report flow, voice fill on: the note\'s mic', () => {
  test('the mic hands its clip to the sheet, which sends it to our transcriber and adds the words to the note', async () => {
    const request = makeRequest();
    request.mockImplementation(((base) => async (path, options) => {
      if (path.endsWith('/voice-fill/dictation')) {
        request.calls.push({ path, options, body: null });
        return { text: 'Six ounces of Taurus inside.' };
      }
      return base(path, options);
    })(request.getMockImplementation()));
    await openSheet(request);
    expect(typeof mic.props.clipHandler).toBe('function');
    await act(async () => { await mic.props.clipHandler(new Blob(['clip'], { type: 'audio/mp4' }), 6.4); });
    const call = request.calls.find((c) => c.path === '/admin/dispatch/svc-1/fast-complete/voice-fill/dictation');
    expect(call.options.method).toBe('POST');
    expect(call.options.body).toBeInstanceOf(FormData);
    expect(call.options.body.get('duration_seconds')).toBe('6');
    expect(call.options.body.get('audio').name).toBe('note.mp4');
    expect(screen.getByLabelText('Tell me about the visit').value).toBe('Six ounces of Taurus inside.');
  });
});

describe('useNoteClip', () => {
  const clip = () => new Blob(['clip'], { type: 'audio/webm;codecs=opus' });
  const setup = (request, onText = vi.fn()) => ({ onText, ...renderHook(() => useNoteClip({ enabled: true, request, serviceId: 'svc-1', onText })) });

  test('off: there is no clip handler, so the mic keeps its own way', () => {
    const { result } = renderHook(() => useNoteClip({ enabled: false, request: vi.fn(), serviceId: 'svc-1', onText: vi.fn() }));
    expect(result.current.onClip).toBeUndefined();
  });

  test('silence asks the tech to try again and adds nothing', async () => {
    const { result, onText } = setup(vi.fn(async () => ({ text: '' })));
    await act(async () => { await result.current.onClip(clip(), 3); });
    expect(onText).not.toHaveBeenCalled();
    expect(result.current.error).toBe("Didn't catch anything. Tap the mic and try again.");
  });

  test('a failed clip shows the short message', async () => {
    const { result, onText } = setup(vi.fn(async () => { throw Object.assign(new Error('x'), { status: 502 }); }));
    await act(async () => { await result.current.onClip(clip(), 3); });
    expect(onText).not.toHaveBeenCalled();
    expect(result.current.error).toBe(NOTE_CLIP_ERROR);
  });

  test('the gate going off (404) hands the mic back, with no error', async () => {
    const { result } = setup(vi.fn(async () => { throw Object.assign(new Error('x'), { status: 404 }); }));
    await act(async () => { await result.current.onClip(clip(), 3); });
    expect(result.current.onClip).toBeUndefined();
    expect(result.current.error).toBe('');
  });

  test('an empty recording asks for nothing', async () => {
    const request = vi.fn();
    const { result } = setup(request);
    await act(async () => { await result.current.onClip(new Blob([]), 0); });
    expect(request).not.toHaveBeenCalled();
  });
});

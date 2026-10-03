// @vitest-environment jsdom
// Voice fill on the lawn re-service sheet (GATE_FAST_COMPLETE_VOICE_FILL, the
// `voiceFillEnabled` prop; owner 2026-10-03: "and lawn as well"):
//  - the note's mic hands its clip to the sheet (our transcriber);
//  - "Fill products from my note" reads the products the note names and lands
//    them on the sheet's own rows: a suggestion tile turned on, an amount, a way;
//  - every row the read set waits on a ✓, every unsettled item on a tap, before
//    Complete;
//  - what the tech set is kept (the difference is a Check), and a tile the tech
//    turned back off stays off on the next read.
// Off, the sheet is exactly as before (FastCompleteLawnReserviceSheet.test.jsx).
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mic = { props: null };
vi.mock('./DictationButton', () => ({
  default: (props) => {
    mic.props = props;
    return <button type="button">Talk about the visit</button>;
  },
}));

import FastCompleteLawnReserviceSheet from './FastCompleteLawnReserviceSheet';
import { LAWN_FILL_ERROR } from './FastCompleteVoiceFill';

vi.setConfig({ testTimeout: 30000 });
beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); mic.props = null; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const CATALOG = [
  { id: 'celsius', name: 'Celsius WG', category: 'herbicide', formulation: 'WG' },
  { id: 'headway', name: 'Headway G', category: 'fungicide', formulation: 'granular' },
  { id: 'dismiss', name: 'Dismiss NXT', category: 'herbicide', formulation: 'SC' },
];
const VISIT = {
  id: 'svc-lawn', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-lawn', serviceKey: 'lawn_re_service',
  serviceType: 'Lawn Care Re-Service', scheduledDate: '2026-10-04', address: { line1: '123 Main St' }, status: 'confirmed',
};
const SERVICE = { id: 'svc-lawn', customerName: 'Pat Jones', serviceType: 'Lawn Re-Service', address: '123 Main St', timeLabel: '2:00 PM' };
const CONTEXT = {
  enabled: true, eligible: true, reason: null, service: VISIT, customerRequest: null, products: CATALOG,
  methods: [
    { value: 'spot_treatment', label: 'Spot treatment', common: true, requiresSqft: false },
    { value: 'broadcast_spray', label: 'Broadcast spray', common: true, requiresSqft: true },
    { value: 'granular_broadcast', label: 'Granular broadcast', common: true, requiresSqft: true },
  ],
  lawnSqft: 6400,
  lastVisit: {
    serviceRecordId: 'rec-1', serviceDate: '2026-09-20', serviceType: 'Lawn Care',
    products: [
      { productId: 'celsius', name: 'Celsius WG', totalAmount: 1.5, amountUnit: 'oz', method: 'spot_treatment', areaValue: null, areaUnit: null },
      { productId: 'headway', name: 'Headway G', totalAmount: null, amountUnit: null, method: null, areaValue: null, areaUnit: null },
    ],
  },
};
const NOTE = 'Spot treated the dollarweed out back with half an ounce of Celsius and put down three pounds of Headway.';
const read = (products, unclear = []) => ({ enabled: true, available: true, status: 'read', products, unclear });
const CELSIUS_HALF = { productId: 'celsius', amount: 0.5, unit: 'oz', sameAsLast: false, method: 'spot_treatment', heard: 'half an ounce of Celsius' };
const HEADWAY_THREE = { productId: 'headway', amount: 3, unit: 'lb', sameAsLast: false, method: 'granular_broadcast', heard: 'three pounds of Headway' };

function makeRequest({ fill = read([CELSIUS_HALF]) } = {}) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/lawn-reservice/fast-context')) return CONTEXT;
    if (path.endsWith('/voice-fill/products')) {
      const answer = typeof request.fill === 'function' ? request.fill() : request.fill;
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (path.endsWith('/voice-fill/dictation')) return { text: 'Half an ounce of Celsius out back.' };
    if (path.endsWith('/complete')) return { success: true };
    return {};
  });
  request.fill = fill;
  request.calls = calls;
  request.fills = () => calls.filter((c) => c.path.endsWith('/voice-fill/products')).map((c) => JSON.parse(c.options.body));
  return request;
}

async function openSheet(request, props = { voiceFillEnabled: true }) {
  render(<FastCompleteLawnReserviceSheet service={SERVICE} request={request} onClose={() => {}} {...props} />);
  await screen.findByRole('button', { name: /^Celsius WG/ });
}
const typeNote = (text = NOTE) => fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: text } });
const fillButton = () => screen.getByRole('button', { name: 'Fill products from my note' });
async function fill(request, count = 1) {
  fireEvent.click(fillButton());
  await waitFor(() => expect(request.fills()).toHaveLength(count));
  await waitFor(() => expect(fillButton().getAttribute('aria-busy')).not.toBe('true'));
}
const tile = (name) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const editorFor = (name) => screen.getByRole('group', { name });
const confirmList = () => screen.getByRole('region', { name: 'Confirm what I filled' });
const completeButton = () => screen.getByRole('button', { name: 'Complete lawn re-service' });

describe('lawn re-service, voice fill off', () => {
  test('no fill button, and the mic is as it was', async () => {
    await openSheet(makeRequest(), {});
    expect(screen.queryByRole('button', { name: 'Fill products from my note' })).toBeNull();
    expect(mic.props.clipHandler).toBeUndefined();
  });
});

describe('lawn re-service, voice fill on', () => {
  test('the note\'s mic hands its clip to the sheet, and the words join the note', async () => {
    const request = makeRequest();
    await openSheet(request);
    await act(async () => { await mic.props.clipHandler(new Blob(['clip'], { type: 'audio/webm' }), 5); });
    const call = request.calls.find((c) => c.path === '/admin/dispatch/svc-lawn/fast-complete/voice-fill/dictation');
    expect(call.options.body).toBeInstanceOf(FormData);
    expect(screen.getByLabelText('Tell me about the visit').value).toBe('Half an ounce of Celsius out back.');
  });

  test('the fill button waits for a note, then sends it', async () => {
    const request = makeRequest();
    await openSheet(request);
    expect(fillButton().disabled).toBe(true);
    typeNote();
    expect(fillButton().disabled).toBe(false);
    await fill(request);
    expect(request.fills()).toEqual([{ note: NOTE }]);
  });

  test('a suggestion tile the note names is turned on with the spoken amount, and waits on ✓', async () => {
    const request = makeRequest();
    await openSheet(request);
    expect(tile('Celsius WG').getAttribute('aria-pressed')).toBe('false');
    typeNote();
    await fill(request);
    expect(tile('Celsius WG').getAttribute('aria-pressed')).toBe('true');
    // the spoken amount replaces last time's 1.5 oz on a tile nobody had tapped
    expect(within(editorFor('Celsius WG')).getByLabelText('How much?').value).toBe('0.5');
    // under an ounce of a dry product shows in grams, as the tile shows it
    const item = within(confirmList()).getByText(/Celsius WG — 14\.2 g/);
    expect(item.textContent).toContain('Heard: “half an ounce of Celsius”');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Celsius WG — 14.2 g' }));
    expect(screen.queryByRole('region', { name: 'Confirm what I filled' })).toBeNull();
  });

  test('an unconfirmed fill holds Complete once everything else is set', async () => {
    const request = makeRequest();
    await openSheet(request);
    typeNote();
    await fill(request);
    fireEvent.click(within(screen.getByRole('heading', { name: 'Treating for' }).closest('section')).getByRole('button', { name: 'Dollarweed' }));
    fireEvent.click(within(within(editorFor('Celsius WG')).getByRole('group', { name: 'For' })).getByRole('button', { name: 'Dollarweed' }));
    fireEvent.click(within(within(editorFor('Celsius WG')).getByRole('group', { name: 'Where' })).getByRole('button', { name: 'Back lawn' }));
    fireEvent.click(screen.getByRole('button', { name: 'Moderate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fair' }));
    expect(screen.getByText('Confirm the products I filled.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Celsius WG — 14.2 g' }));
    expect(completeButton().disabled).toBe(false);
    fireEvent.click(completeButton());
    await waitFor(() => expect(request.calls.some((c) => c.path.endsWith('/complete'))).toBe(true));
    const body = JSON.parse(request.calls.find((c) => c.path.endsWith('/complete')).options.body);
    expect(body.products).toEqual([expect.objectContaining({ productId: 'celsius', totalAmount: 0.5, amountUnit: 'oz', applicationMethod: 'spot_treatment' })]);
  });

  test('a way the note says is set on a tile that had none, with the square feet that way needs', async () => {
    const request = makeRequest({ fill: read([HEADWAY_THREE]) });
    await openSheet(request);
    typeNote();
    await fill(request);
    expect(tile('Headway G').getAttribute('aria-pressed')).toBe('true');
    expect(within(confirmList()).getByText(/Headway G — 3 lb · Granular broadcast/)).toBeTruthy();
    // granular broadcast needs square feet: seeded from the lawn size, as a tap would
    expect(within(editorFor('Headway G')).getByDisplayValue('6400')).toBeTruthy();
  });

  test('a product the note names that is not a tile is added from the catalog', async () => {
    const request = makeRequest({ fill: read([{ productId: 'dismiss', amount: 2, unit: 'fl_oz', sameAsLast: false, method: '', heard: 'two ounces of Dismiss' }]) });
    await openSheet(request);
    typeNote();
    await fill(request);
    expect(within(confirmList()).getByText(/Dismiss NXT — 2 fl oz/)).toBeTruthy();
    expect(within(editorFor('Dismiss NXT')).getByLabelText('How much?').value).toBe('2');
  });

  test('a product named with no amount and no way is still added, and the sheet asks for both', async () => {
    const request = makeRequest({ fill: read([{ productId: 'dismiss', amount: null, unit: '', sameAsLast: false, method: '', heard: 'used Dismiss' }]) });
    await openSheet(request);
    typeNote('I used Dismiss on the sedge.');
    await fill(request);
    expect(within(confirmList()).getByText(/^Dismiss NXT/)).toBeTruthy();
    expect(within(editorFor('Dismiss NXT')).getByLabelText('How much?').value).toBe('');
    expect(screen.getByText('Enter the amount for Dismiss NXT.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
  });

  test('an amount the tech typed is kept: the difference is a Check, never a change', async () => {
    const request = makeRequest();
    await openSheet(request);
    fireEvent.click(tile('Celsius WG'));
    fireEvent.change(within(editorFor('Celsius WG')).getByLabelText('How much?'), { target: { value: '2' } });
    typeNote();
    await fill(request);
    expect(within(editorFor('Celsius WG')).getByLabelText('How much?').value).toBe('2');
    expect(within(screen.getByRole('region', { name: 'Check' })).getByText('You entered 2 oz; heard 14.2 g for Celsius WG.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Confirm what I filled' })).toBeNull();
    // changing the amount answers the Check
    fireEvent.change(within(editorFor('Celsius WG')).getByLabelText('How much?'), { target: { value: '0.5' } });
    expect(screen.queryByRole('region', { name: 'Check' })).toBeNull();
  });

  test('what the read could not settle is a Check the tech taps away, and it is not raised again', async () => {
    const request = makeRequest({ fill: read([], [{ heard: 'the blue stuff', reason: 'unknown_product' }]) });
    await openSheet(request);
    typeNote();
    await fill(request);
    expect(within(screen.getByRole('region', { name: 'Check' })).getByText(/the blue stuff/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '✓ Got it' }));
    await fill(request, 2);
    expect(screen.queryByRole('region', { name: 'Check' })).toBeNull();
  });

  test('a tile the tech turned back off stays off on the next read', async () => {
    const request = makeRequest();
    await openSheet(request);
    typeNote();
    await fill(request);
    fireEvent.click(tile('Celsius WG'));
    expect(tile('Celsius WG').getAttribute('aria-pressed')).toBe('false');
    // turning it off answers its confirm
    expect(screen.queryByRole('region', { name: 'Confirm what I filled' })).toBeNull();
    await fill(request, 2);
    expect(tile('Celsius WG').getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Confirm what I filled' })).toBeNull();
  });

  test('saying it again another way (an edited note) brings a turned-off product back', async () => {
    const request = makeRequest();
    await openSheet(request);
    typeNote();
    await fill(request);
    fireEvent.click(tile('Celsius WG'));
    typeNote('Actually I used a full ounce of Celsius out back.');
    request.fill = read([{ ...CELSIUS_HALF, amount: 1, heard: 'a full ounce of Celsius' }]);
    await fill(request, 2);
    expect(tile('Celsius WG').getAttribute('aria-pressed')).toBe('true');
    expect(within(confirmList()).getByText(/Celsius WG — 1 oz/)).toBeTruthy();
  });

  test.each([
    ['the read fails', () => ({ enabled: true, available: true, status: 'failed', reason: 'model_failed', products: [], unclear: [] })],
    ['the read is down', () => Object.assign(new Error('down'), { status: 502 })],
  ])('%s: a short message, nothing filled, nothing held', async (_name, answer) => {
    const request = makeRequest({ fill: answer });
    await openSheet(request);
    typeNote();
    await fill(request);
    expect(screen.getByText(LAWN_FILL_ERROR)).toBeTruthy();
    expect(tile('Celsius WG').getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Confirm what I filled' })).toBeNull();
  });

  test('the gate going off since the sheet opened (404) takes the button away, with no error', async () => {
    const request = makeRequest({ fill: () => Object.assign(new Error('Request failed (404)'), { status: 404 }) });
    await openSheet(request);
    typeNote();
    fireEvent.click(fillButton());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Fill products from my note' })).toBeNull());
    expect(screen.queryByText(LAWN_FILL_ERROR)).toBeNull();
  });
});

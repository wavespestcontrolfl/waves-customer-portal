// @vitest-environment jsdom
// Voice fill on a specialty visit's report flow (GATE_FAST_COMPLETE_VOICE_FILL;
// owner 2026-10-03 "do item 2": bed bug, cockroach, flea, mosquito and the rest).
// A lane or typed visit's own read fills its record, never its products, so:
//  - the products the note names are read and land as rows the tech confirms,
//    like on a pest visit;
//  - such a sheet opens with no product, so Generate reads the note for products
//    FIRST; a note that names none stays on the visit, held as an empty list
//    always is, and no report is written;
//  - no row follows a How here, so each row takes the way said for it.
// Off, an empty product list holds Generate exactly as before
// (FastCompleteSheet.lane-flow.test.jsx).
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('./TechTreatmentZoneModal', () => ({ default: () => null }));
vi.mock('./TechServicePhotosModal', () => ({ default: () => null }));
const mic = { props: null };
vi.mock('./DictationButton', () => ({
  default: (props) => {
    mic.props = props;
    return <button type="button">Talk about the visit</button>;
  },
}));

import FastCompleteSheet from './FastCompleteSheet';

vi.setConfig({ testTimeout: 30000 });
beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); mic.props = null; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const CATALOG = [
  { id: 'taurus', name: 'Taurus SC', category: 'Insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' },
  { id: 'temprid', name: 'Temprid FX', category: 'Insecticide' },
];
const VISIT = {
  id: 'svc-bb', customerName: 'Pat Jones', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-bb',
  serviceType: 'Bed Bug Treatment', scheduledDate: '2026-10-02', address: { line1: '123 Main St' },
  serviceKey: 'bed_bug_treatment', status: 'confirmed',
};
const NOTE = 'Second treatment. Treated the master bedroom with one ounce of Temprid, live ones on the couch seams.';
const LANE_READ = {
  available: true, status: 'read', lane: 'bed_bug_treatment',
  areas: [{ area: 'Primary bedroom', quote: 'treated the master bedroom' }],
  findings: [
    { group: 'bed_bug_visit_stage', value: 'Scheduled follow-up treatment', quote: 'second treatment' },
    { group: 'bed_bug_evidence', value: 'Live adults', quote: 'live ones on the couch seams' },
  ],
  unclearGroups: [],
};
const REPORT = 'WHAT WE FOUND\nLive bed bugs on the couch seams.\n\nWHAT WE DID AND WHY\nWe treated the bedroom.';
const read = (products, unclear = []) => ({ enabled: true, available: true, status: 'read', products, unclear });
const TEMPRID_ONE = { productId: 'temprid', amount: 1, unit: 'fl_oz', sameAsLast: false, method: '', heard: 'one ounce of Temprid' };

function makeRequest({ fill = read([TEMPRID_ONE]) } = {}) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options, body: typeof options?.body === 'string' ? JSON.parse(options.body) : null });
    if (path.split('?')[0].endsWith('/pest-recap/context')) return { ok: true, eligible: false, lane: 'bed_bug_treatment', service: VISIT, products: CATALOG };
    if (path.endsWith('/tech-rating-allowed')) return { allowed: false };
    if (path.endsWith('/tech-tips')) return { available: false };
    if (path.split('?')[0].endsWith('/promises')) return { available: false, promises: [] };
    if (path.split('?')[0].endsWith('/blog-posts')) return { available: false, posts: [] };
    if (path.endsWith('/photos')) return { photos: [] };
    if (path.split('?')[0].endsWith('/treatment-zone')) return { enabled: true, treatmentZone: null };
    if (path === '/admin/schedule/generate-report') return { report: REPORT };
    if (path.endsWith('/lane-facts')) return LANE_READ;
    if (path.endsWith('/voice-fill/products')) return typeof request.fill === 'function' ? request.fill() : request.fill;
    if (path.endsWith('/complete')) return { success: true };
    return {};
  });
  request.fill = fill;
  request.calls = calls;
  request.bodies = (suffix) => calls.filter((call) => call.path.endsWith(suffix)).map((call) => call.body);
  request.order = () => calls.map((call) => call.path).filter((path) => /lane-facts|voice-fill|generate-report/.test(path)).map((path) => path.split('/').pop());
  return request;
}

const SERVICE = {
  id: 'svc-bb', customerName: 'Pat Jones', serviceType: 'Bed Bug Treatment', address: '123 Main St', timeLabel: '9:00 AM',
  reportFlow: true, laneFlow: true, laneKey: 'bed_bug_treatment', traceEligible: false, lat: 27.4, lng: -82.5, technicianName: 'Adam',
};
const generateButton = () => screen.getByRole('button', { name: 'Generate AI report' });
async function openSheet(request, props = { voiceFillEnabled: true }) {
  render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} onCompleted={() => {}} {...props} />);
  await screen.findByRole('button', { name: 'Generate AI report' }, { timeout: 10000 });
}
const typeNote = (note = NOTE) => fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: note } });
async function generate(note = NOTE) {
  typeNote(note);
  await waitFor(() => expect(generateButton().disabled).toBe(false), { timeout: 10000 });
  fireEvent.click(generateButton());
}
const NO_PRODUCT = /Add the product you applied/;

describe('a specialty visit, voice fill off', () => {
  test('an empty product list holds Generate, as before', async () => {
    const request = makeRequest();
    await openSheet(request, {});
    typeNote();
    await screen.findByText(NO_PRODUCT);
    expect(generateButton().disabled).toBe(true);
    expect(mic.props.clipHandler).toBeUndefined();
  });
});

describe('a specialty visit, voice fill on', () => {
  test('the mic hands its clip to the sheet', async () => {
    await openSheet(makeRequest());
    expect(typeof mic.props.clipHandler).toBe('function');
  });

  test('with no product on the sheet, Generate reads the note for products first, then writes the report from them', async () => {
    const request = makeRequest();
    await openSheet(request);
    await generate();
    await screen.findByText('Report the customer will see', {}, { timeout: 10000 });
    // the products read comes first and only once; the lane's own read follows
    expect(request.order()).toEqual(['products', 'lane-facts', 'generate-report']);
    const written = request.bodies('generate-report')[0];
    expect(written.products).toEqual([expect.objectContaining({ productId: 'temprid' })]);
    expect(written.productsApplied).toBe('Temprid FX');
    // the row waits on ✓ before the send
    const confirms = screen.getByRole('region', { name: 'Confirm what I filled' });
    expect(within(confirms).getByText(/Temprid FX — 1 fl oz/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Temprid FX — 1 fl oz' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    expect(request.bodies('/complete')[0].products).toEqual([expect.objectContaining({ productId: 'temprid', totalAmount: 1, amountUnit: 'fl_oz' })]);
  });

  test('a note that names no product stays on the visit: held, and no report is written', async () => {
    const request = makeRequest({ fill: read([]) });
    await openSheet(request);
    await generate('Second treatment in the master bedroom.');
    await screen.findByText(NO_PRODUCT);
    expect(generateButton().disabled).toBe(true);
    expect(request.bodies('generate-report')).toEqual([]);
    expect(request.bodies('/lane-facts')).toEqual([]);
    // saying the product (an edited note) opens Generate again
    request.fill = read([TEMPRID_ONE]);
    await generate();
    await screen.findByText('Report the customer will see', {}, { timeout: 10000 });
    expect(request.bodies('generate-report')).toHaveLength(1);
  });

  test('a failed read with no product on the sheet holds the same way', async () => {
    const request = makeRequest({ fill: () => { throw Object.assign(new Error('down'), { status: 502 }); } });
    await openSheet(request);
    await generate();
    await screen.findByText(NO_PRODUCT);
    expect(request.bodies('generate-report')).toEqual([]);
  });

  test('no row follows a How here: the way said for a product is set on its row', async () => {
    const request = makeRequest({ fill: read([{ ...TEMPRID_ONE, method: 'broadcast_spray', heard: 'broadcast sprayed one ounce of Temprid' }]) });
    await openSheet(request);
    await generate();
    await screen.findByText('Report the customer will see', {}, { timeout: 10000 });
    expect(request.bodies('generate-report')[0].products[0].applicationMethod).toBe('broadcast_spray');
    expect(within(screen.getByRole('region', { name: 'Confirm what I filled' })).getByText(/Temprid FX — 1 fl oz · Broadcast spray/)).toBeTruthy();
  });

  test('a product the tech already added is read beside the lane\'s own read, and its spoken amount fills in', async () => {
    const request = makeRequest();
    await openSheet(request);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add a product' })).getByRole('button', { name: /^Taurus SC\b/ }));
    fireEvent.change(within(screen.getByRole('group', { name: 'Taurus SC' })).getByLabelText('How much?'), { target: { value: '2' } });
    await generate();
    await screen.findByText('Report the customer will see', {}, { timeout: 10000 });
    expect(request.order()).toEqual(['lane-facts', 'products', 'generate-report']);
    expect(request.bodies('generate-report')[0].productsApplied).toBe('Taurus SC, Temprid FX');
  });
});

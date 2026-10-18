// @vitest-environment jsdom
// The one-tap report (GATE_ONE_TAP_REPORT, owner 2026-10-17): on the recurring
// pest report sheet, whose context says `oneTap: true`,
//  - the report is written in the background when the tech taps the 1-5 rating;
//  - the note is not read for products (its facts are still read);
//  - a product at 0 in stock holds nothing, and a line says so;
//  - the trace is optional: typed feet cover a perimeter spray with no saved trace.
// A re-service (and, with it, every lane, typed, station and prepare path), a first
// cleanout that opens with no house mix, and a context without the key keep the sheet
// as it was (FastCompleteSheet.report-flow.test.jsx).
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('./TechTreatmentZoneModal', () => ({ default: () => null }));
vi.mock('./TechServicePhotosModal', () => ({ default: () => null }));

import FastCompleteSheet from './FastCompleteSheet';

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const CATALOG = [
  { id: 'taurus', name: 'Taurus SC', category: 'Insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' },
  { id: 'talstar', name: 'Atticus Talak 7.9 F', category: 'Insecticide' },
  { id: 'surfactant', name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant' },
];
const REGULAR = {
  id: 'svc-1', customerName: 'Pat Jones', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-1',
  serviceType: 'Quarterly Pest Control', scheduledDate: '2026-10-01', address: { line1: '123 Main St' },
  serviceKey: 'pest_general_quarterly', status: 'confirmed',
};
const RESERVICE = { ...REGULAR, serviceType: 'Pest Control Re-Service', serviceKey: 'pest_re_service' };
const REPORT = ['WHAT WE FOUND', 'Ants on the counter.', '', 'WHAT WE DID AND WHY', 'We treated the kitchen.', '', 'WHAT TO EXPECT', 'Fewer ants.', '', "WHAT'S NEXT", 'Wipe the counters.'].join('\n');
const NOTE = 'Ants on the kitchen counter, light. Sprayed around the outside of the house.';
const FACTS = { available: true, status: 'read', areas: ['Inside', 'Outside'], pests: ['ants'] };
const PERIMETER = { ...FACTS, spray: 'perimeter' };
const NO_STOCK = () => CATALOG.map((p) => (p.id === 'taurus' ? { ...p, inventory_unit: 'fl_oz', inventory_on_hand: '0.0000' } : p));

function makeRequest({
  service = REGULAR, facts = FACTS, trace = { enabled: true, treatmentZone: null }, products = CATALOG, context = { oneTap: true }, reportGate = null,
} = {}) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options, body: options?.body ? JSON.parse(options.body) : null });
    if (path.split('?')[0].endsWith('/pest-recap/context')) return { ok: true, eligible: true, reportFlow: true, service, products: typeof products === 'function' ? products() : products, ...context };
    if (path.endsWith('/tech-rating-allowed')) return { allowed: true, firstVisit: false, scaleLabels: null };
    if (path.endsWith('/tech-tips')) return { available: false };
    if (path.split('?')[0].endsWith('/promises')) return { available: false, promises: [] };
    if (path.split('?')[0].endsWith('/blog-posts')) return { available: false, posts: [] };
    if (path.endsWith('/photos')) return { photos: [] };
    if (path.split('?')[0].endsWith('/treatment-zone')) return trace;
    if (path === '/admin/schedule/generate-report') {
      if (reportGate) await reportGate;
      return { report: REPORT };
    }
    if (path.endsWith('/voice-facts')) return facts;
    if (path.endsWith('/voice-fill/products')) return { enabled: true, available: true, status: 'read', products: [], unclear: [] };
    if (path.endsWith('/complete')) return { success: true };
    return {};
  });
  request.calls = calls;
  request.bodies = (suffix) => calls.filter((call) => call.path.endsWith(suffix)).map((call) => call.body);
  return request;
}

const SERVICE = {
  id: 'svc-1', customerName: 'Pat Jones', serviceType: 'Quarterly Pest Control', address: '123 Main St', timeLabel: '9:00 AM',
  reportFlow: true, traceEligible: true, lat: 27.4, lng: -82.5, technicianName: 'Adam',
};

async function openSheet(request, props = {}) {
  render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} onCompleted={() => {}} voiceFillEnabled {...props} />);
  await screen.findByText(/Taurus SC 4 fl oz/);
}
const writeNote = () => fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
const tapRating = () => fireEvent.click(screen.getByRole('button', { name: '3, moderate' }));
const reportCalls = (request) => request.bodies('/generate-report');
const completeButton = () => screen.getByRole('button', { name: 'Complete & send' });
// The footer button waits on the visit's photos and promises; opening the report is its click.
// (Once the rating tap's write has landed the label reads "Back to the report".)
const STEP_BUTTON = /^(Generate AI report|Back to the report)$/;
async function openReport() {
  await waitFor(() => expect(screen.getByRole('button', { name: STEP_BUTTON }).disabled).toBe(false), { timeout: 10000 });
  fireEvent.click(screen.getByRole('button', { name: STEP_BUTTON }));
  await screen.findByText('Report the customer will see', {}, { timeout: 10000 });
}

describe('one-tap: the rating tap starts the writer', () => {
  test('a rating tap writes the report while the visit step stays shown; Generate then shows it with no second write', async () => {
    const request = makeRequest();
    await openSheet(request);
    writeNote();
    tapRating();
    await waitFor(() => expect(reportCalls(request)).toHaveLength(1));
    // still the visit step
    expect(screen.getByLabelText('Tell me about the visit')).toBeTruthy();
    expect(screen.queryByText('Report the customer will see')).toBeNull();
    // the note's facts were read, the products were not
    expect(request.bodies('/voice-facts')).toEqual([{ note: NOTE }]);
    await openReport();
    expect(reportCalls(request)).toHaveLength(1);
    expect(request.bodies('/voice-fill/products')).toEqual([]);
    expect(screen.queryByText('Confirm the products I filled.')).toBeNull();
    expect(screen.queryByText("Check what I couldn't fill.")).toBeNull();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    // a change after the write makes the report stale as it always did
    fireEvent.click(screen.getByRole('button', { name: 'Back to the visit' }));
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: `${NOTE} Two nests.` } });
    expect(screen.getByRole('button', { name: 'Write it again' }).disabled).toBe(false);
    expect(reportCalls(request)).toHaveLength(1);
  });

  test('while the write runs the button stays live and only opens the report; it never starts a second write', async () => {
    let release;
    const reportGate = new Promise((resolve) => { release = resolve; });
    const request = makeRequest({ reportGate });
    await openSheet(request);
    writeNote();
    tapRating();
    await waitFor(() => expect(reportCalls(request)).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
    expect(await screen.findByText('Writing the report…')).toBeTruthy();
    expect(reportCalls(request)).toHaveLength(1);
    release();
    await screen.findByText('Report the customer will see');
    expect(reportCalls(request)).toHaveLength(1);
  });

  test('one rating tap is one write: a second tap on a current report asks for nothing', async () => {
    const request = makeRequest();
    await openSheet(request);
    writeNote();
    tapRating();
    await waitFor(() => expect(reportCalls(request)).toHaveLength(1));
    tapRating();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reportCalls(request)).toHaveLength(1);
  });

  test('a context without the key writes nothing on the tap, and reads the note for products', async () => {
    const request = makeRequest({ context: {} });
    await openSheet(request);
    writeNote();
    tapRating();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reportCalls(request)).toHaveLength(0);
    await openReport();
    expect(request.bodies('/voice-fill/products')).toEqual([{ note: NOTE }]);
  });
});

describe('one-tap: a product at 0 in stock', () => {
  test('holds nothing: the line shows on both steps, Check stock stays, and the visit goes out', async () => {
    const request = makeRequest({ products: NO_STOCK });
    await openSheet(request);
    const line = 'Taurus SC shows 0 in stock. You can still send. Tell the office to restock it.';
    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.queryByText('Taurus SC shows 0 in stock. Update inventory or remove it.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Check stock' })).toBeTruthy();
    writeNote();
    tapRating();
    await openReport();
    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check stock' })).toBeTruthy();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(completeButton());
    await screen.findByTestId('fast-complete-sent');
    expect(request.bodies('/complete')).toHaveLength(1);
  });

  test('every product at 0 in stock gets its own line, with one Check stock', async () => {
    const twoOut = () => CATALOG.map((p) => (p.id === 'surfactant' ? p : { ...p, inventory_unit: 'fl_oz', inventory_on_hand: '0.0000' }));
    await openSheet(makeRequest({ products: twoOut }));
    expect(screen.getByText('Taurus SC shows 0 in stock. You can still send. Tell the office to restock it.')).toBeTruthy();
    expect(screen.getByText('Atticus Talak 7.9 F shows 0 in stock. You can still send. Tell the office to restock it.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Check stock' })).toHaveLength(1);
  });

  test('gate off: the hold stays as it was', async () => {
    await openSheet(makeRequest({ products: NO_STOCK, context: {} }));
    writeNote();
    tapRating();
    expect(screen.getByText('Taurus SC shows 0 in stock. Update inventory or remove it.')).toBeTruthy();
    expect(screen.queryByText(/You can still send/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(true);
  });
});

describe('one-tap: the trace is optional', () => {
  test('a perimeter spray with no saved trace asks for the feet, and they go on the record', async () => {
    const request = makeRequest({ facts: PERIMETER });
    await openSheet(request);
    writeNote();
    tapRating();
    await openReport();
    expect(screen.getByText('Type the feet you sprayed, or trace it.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    expect(screen.queryByText(/Use the Full form/)).toBeNull();
    // the trace stays offered
    expect(screen.getByRole('button', { name: 'Auto-trace the house' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Trace where we sprayed' })).toBeTruthy();
    const feet = screen.getByLabelText('Feet sprayed');
    expect(feet.getAttribute('inputmode')).toBe('numeric');
    for (const bad of ['0', '12.5', '-4', '']) {
      fireEvent.change(feet, { target: { value: bad } });
      expect(completeButton().disabled).toBe(true);
    }
    fireEvent.change(feet, { target: { value: '180' } });
    expect(screen.queryByText('Type the feet you sprayed, or trace it.')).toBeNull();
    // typed feet are not what the writer reads: the report is still current
    expect(screen.queryByRole('button', { name: 'Write it again' })).toBeNull();
    expect(reportCalls(request)).toHaveLength(1);
    expect(completeButton().disabled).toBe(false);
    fireEvent.click(completeButton());
    await screen.findByTestId('fast-complete-sent');
    const [body] = request.bodies('/complete');
    const perimeter = body.products.filter((product) => product.applicationMethod === 'perimeter_spray');
    expect(perimeter.length).toBeGreaterThan(0);
    for (const product of perimeter) expect([product.areaValue, product.areaUnit]).toEqual([180, 'linear_ft']);
  });

  test('a saved trace gives the feet: no input, and the trace\'s feet are sent', async () => {
    const zone = { linear_ft: 150, capture_mode: 'perimeter', updated_at: '2026-10-02T05:00:00.000Z' };
    const request = makeRequest({ facts: PERIMETER, trace: { enabled: true, treatmentZone: zone } });
    await openSheet(request);
    writeNote();
    tapRating();
    await openReport();
    expect(screen.queryByLabelText('Feet sprayed')).toBeNull();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    fireEvent.click(completeButton());
    await screen.findByTestId('fast-complete-sent');
    const [body] = request.bodies('/complete');
    for (const product of body.products.filter((p) => p.applicationMethod === 'perimeter_spray')) {
      expect([product.areaValue, product.areaUnit]).toEqual([150, 'linear_ft']);
    }
  });

  test('a visit that cannot be traced still takes typed feet, with no Full form hold', async () => {
    const request = makeRequest({ facts: PERIMETER });
    render(<FastCompleteSheet service={{ ...SERVICE, traceEligible: false }} request={request} onClose={() => {}} onCompleted={() => {}} voiceFillEnabled />);
    await screen.findByText(/Taurus SC 4 fl oz/);
    writeNote();
    tapRating();
    await openReport();
    expect(screen.getByText('Type the feet you sprayed, or trace it.')).toBeTruthy();
    expect(screen.queryByText(/can’t be traced here/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Auto-trace the house' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Feet sprayed'), { target: { value: '90' } });
    expect(completeButton().disabled).toBe(false);
  });

  test('gate off: the trace hold stays and there is no feet input', async () => {
    const request = makeRequest({ facts: PERIMETER, context: {} });
    await openSheet(request, { voiceFillEnabled: false });
    writeNote();
    tapRating();
    await openReport();
    expect(screen.getByText('Trace where you sprayed: Taurus SC is a perimeter spray.')).toBeTruthy();
    expect(screen.queryByLabelText('Feet sprayed')).toBeNull();
    expect(completeButton().disabled).toBe(true);
  });
});

describe('one-tap: not a plain recurring pest report', () => {
  test('a re-service keeps its sheet: the tap writes nothing, the note is read for products, the trace hold stays', async () => {
    const request = makeRequest({ service: RESERVICE, facts: PERIMETER });
    render(<FastCompleteSheet service={{ ...SERVICE, serviceType: 'Pest Control Re-Service' }} request={request} onClose={() => {}} onCompleted={() => {}} voiceFillEnabled />);
    await screen.findByText(/Taurus SC/);
    writeNote();
    tapRating();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reportCalls(request)).toHaveLength(0);
    await openReport();
    expect(request.bodies('/voice-fill/products')).toEqual([{ note: NOTE }]);
    expect(screen.queryByLabelText('Feet sprayed')).toBeNull();
  });

  test('a first cleanout opens with no house mix: the tap writes nothing and Generate still reads the note for products', async () => {
    const CLEANOUT = { ...REGULAR, serviceType: 'Initial Pest Cleanout', serviceKey: 'pest_initial_cleanout' };
    const request = makeRequest({ service: CLEANOUT });
    render(<FastCompleteSheet service={{ ...SERVICE, serviceType: 'Initial Pest Cleanout' }} request={request} onClose={() => {}} onCompleted={() => {}} voiceFillEnabled />);
    await screen.findByRole('button', { name: 'Generate AI report' });
    expect(screen.getByText('None selected')).toBeTruthy();
    writeNote();
    tapRating();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reportCalls(request)).toHaveLength(0);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
    await waitFor(() => expect(request.bodies('/voice-fill/products')).toEqual([{ note: NOTE }]));
  });
});

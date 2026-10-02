// @vitest-environment jsdom
// Fast Complete report flow (GATE_FAST_COMPLETE_REPORT, owner "ok go"
// 2026-10-01): talk, generate the AI report, read it, trace the spray, send.
// These pin what the sheet asks for, the report request, the facts read from
// the note, the /complete body (billing and customer text as the full form),
// the trace's part in how a spray is recorded, a stale report, an edited
// report and its heads-up, and the sent view.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('./TechTreatmentZoneModal', () => ({
  default: ({ onSaved, onClose }) => (
    <div role="dialog" aria-label="Tracer">
      <button type="button" onClick={() => onSaved({ linear_ft: 182, capture_mode: 'perimeter' })}>Save trace</button>
      <button type="button" onClick={onClose}>Close tracer</button>
    </div>
  ),
}));
vi.mock('./TechServicePhotosModal', () => ({
  default: ({ onClose }) => (
    <div role="dialog" aria-label="Photo manager">
      <button type="button" onClick={onClose}>Done with photos</button>
    </div>
  ),
}));

import FastCompleteSheet from './FastCompleteSheet';
import { perimeterFeetOf, reportParts } from './FastCompleteReport';

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
const REPORT = [
  'WHAT WE FOUND',
  'You asked us back because ants returned to the kitchen counter. Ghost ants were trailing along the counter, with light activity.',
  '',
  'WHAT WE DID AND WHY',
  'We placed bait along the counter edge and treated around the outside of the house.',
  '',
  'WHAT TO EXPECT',
  'You may see a few more ants near the bait for a few days.',
  '',
  "WHAT'S NEXT",
  'Keeping the counters wiped helps the bait work.',
].join('\n');
const NOTE = 'Ghost ants on the kitchen counter, light. Baited the counter edge, sprayed around the outside of the house.';
const FACTS = { available: true, status: 'read', areas: ['Inside', 'Outside'], pests: ['ghost ants'] };

function makeRequest({
  service = REGULAR, rating = { allowed: true, firstVisit: false, scaleLabels: null }, report = REPORT, facts = FACTS,
  trace = { enabled: true, treatmentZone: null }, complete = [{ success: true }], photos = [], products = CATALOG,
  promises = { available: false, promises: [] },
} = {}) {
  const calls = [];
  const completes = [...complete];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options, body: options?.body ? JSON.parse(options.body) : null });
    if (path.split('?')[0].endsWith('/pest-recap/context')) return { ok: true, eligible: true, service, products: typeof products === 'function' ? products() : products };
    if (path.endsWith('/tech-rating-allowed')) return rating;
    if (path.endsWith('/tech-tips')) return { available: false };
    if (path.split('?')[0].endsWith('/promises')) return typeof promises === 'function' ? promises(path) : promises;
    if (path.endsWith('/photos')) return typeof photos === 'function' ? photos() : { photos };
    if (path.endsWith('/treatment-zone')) return trace;
    if (path === '/admin/schedule/generate-report') {
      if (report instanceof Error) throw report;
      return { report };
    }
    if (path.endsWith('/voice-facts')) return facts;
    if (path.endsWith('/complete')) {
      const next = completes.length > 1 ? completes.shift() : completes[0];
      if (next instanceof Error) throw next;
      return next;
    }
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

async function openSheet(request, service = SERVICE) {
  render(<FastCompleteSheet service={service} request={request} onClose={() => {}} onCompleted={() => {}} />);
  await screen.findByText(/Taurus SC 4 fl oz/);
}

async function generate({ note = NOTE, rating = '3, moderate' } = {}) {
  fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: note } });
  if (rating) fireEvent.click(screen.getByRole('button', { name: rating }));
  fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
  await screen.findByText('Report the customer will see');
}

function conflict(code, message) {
  const err = new Error(message);
  err.status = 409;
  err.code = code;
  return err;
}

describe('the visit step', () => {
  test('a regular pest visit opens as a service: no pest, where or how taps, customer not home with full access', async () => {
    await openSheet(makeRequest());
    expect(screen.getByRole('heading', { name: 'Complete service' })).toBeTruthy();
    for (const gone of ['Ants', 'Outside', 'Inside', 'Spot treatment', 'Perimeter spray', 'Light']) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull();
    }
    expect(screen.getByRole('button', { name: 'Not home — full access' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Home — spoke with them' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Not home — partial access' }).getAttribute('aria-pressed')).toBe('false');
    const tracker = screen.getByRole('group', { name: 'Pest activity' });
    expect(within(tracker).getAllByRole('button').map((button) => button.textContent)).toEqual(['1', '2', '3', '4', '5']);
    expect(screen.getByText('1 = very low · 2 = low · 3 = moderate · 4 = elevated · 5 = high')).toBeTruthy();
    // The products as one line, opened on Edit.
    expect(screen.getByText(/Taurus SC 4 fl oz · Atticus Talak 7\.9 F 4 fl oz/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('button', { name: /Taurus SC — 4 fl oz/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByRole('button', { name: /Taurus SC — 4 fl oz/ })).toBeNull();
  });

  test('the tracker holds the report until a rating is picked', async () => {
    await openSheet(makeRequest());
    expect(screen.getByText('Pick the pest activity, 1 to 5.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '2, low' }));
    expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false);
  });

  test('a first visit opens the tracker at 5 and sends it as the untouched prefill', async () => {
    const request = makeRequest({ rating: { allowed: true, firstVisit: true, scaleLabels: null } });
    await openSheet(request);
    expect(screen.getByRole('button', { name: '5, high' }).getAttribute('aria-pressed')).toBe('true');
    await generate({ rating: null });
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    const [body] = request.bodies('/complete');
    expect(body.clientPestRating).toBe(5);
    expect(body.clientPestRatingPrefilled).toBe(true);
  });

  test('a stock at zero holds the report, and Check stock on the visit step re-reads it', async () => {
    let stock = '0.0000';
    const products = () => CATALOG.map((p) => (p.id === 'taurus' ? { ...p, inventory_unit: 'fl_oz', inventory_on_hand: stock } : p));
    await openSheet(makeRequest({ products }));
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
    fireEvent.click(screen.getByRole('button', { name: '3, moderate' }));
    expect(screen.getByText('Taurus SC shows 0 in stock. Update inventory or remove it.')).toBeTruthy();
    const generateButton = screen.getByRole('button', { name: 'Generate AI report' });
    expect(generateButton.disabled).toBe(true);
    // The office restocks it: the sheet holds until the tech checks.
    stock = '64.0000';
    fireEvent.click(screen.getByRole('button', { name: 'Check stock' }));
    await waitFor(() => expect(generateButton.disabled).toBe(false));
    expect(screen.queryByRole('button', { name: 'Check stock' })).toBeNull();
  });

  test('the tracker reads the server\'s scale labels', async () => {
    await openSheet(makeRequest({ rating: { allowed: true, scaleLabels: ['None', 'Barely', 'Some', 'Moderate', 'A lot', 'Severe'] } }));
    expect(screen.getByRole('button', { name: '5, severe' })).toBeTruthy();
  });
});

describe('generate and read', () => {
  test('the report request carries the note and the taps; the note\'s facts are read beside it', async () => {
    const request = makeRequest();
    await openSheet(request);
    fireEvent.click(screen.getByRole('button', { name: 'Home — spoke with them' }));
    await generate();
    const [payload] = request.bodies('/generate-report');
    // The note is read first, and the report is written from exactly what
    // the record will say: where, the pests, how the sprays went down.
    const order = request.calls.map((call) => call.path).filter((path) => /voice-facts|generate-report/.test(path));
    expect(order).toEqual(['/admin/dispatch/svc-1/voice-facts', '/admin/schedule/generate-report']);
    expect(request.bodies('/voice-facts')).toEqual([{ note: NOTE }]);
    expect(payload).toMatchObject({
      scheduledServiceId: 'svc-1',
      serviceNotes: NOTE,
      customerInteraction: 'Customer home — spoke with them',
      pestActivityRating: 3,
      includeCustomerComms: true,
      technicianName: 'Adam',
      serviceDate: 'October 1, 2026',
      areasServiced: ['Inside', 'Outside'],
    });
    expect(payload).not.toHaveProperty('fresh');
    expect(payload.products.map((product) => [product.name, product.applicationMethod, product.applicationArea, product.targets])).toEqual([
      ['Taurus SC', 'spot_treatment', 'Inside, Outside', ['ghost ants']],
      ['Atticus Talak 7.9 F', 'spot_treatment', 'Inside, Outside', ['ghost ants']],
      ['LESCO 90/10 Nonionic Surfactant', 'spot_treatment', 'Inside, Outside', ['ghost ants']],
    ]);
    // The four parts, titled, and what was heard.
    for (const title of ['What we found', 'What we did and why', 'What to expect', 'What’s next']) {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    }
    expect(screen.getByText('We placed bait along the counter edge and treated around the outside of the house.')).toBeTruthy();
    expect(screen.getByTestId('fast-complete-heard').textContent).toBe('Heard from you: treated inside and outside · for ghost ants');
  });

  test('photo captions ride the report request, as the full form sends them', async () => {
    const request = makeRequest({ photos: [{ id: 'p1', url: 'https://example.test/p1.jpg', caption: 'Counter edge' }, { id: 'p2', url: 'https://example.test/p2.jpg' }] });
    await openSheet(request);
    expect(await screen.findByText('2 added')).toBeTruthy();
    await generate();
    const [payload] = request.bodies('/generate-report');
    expect(payload.photoCount).toBe(2);
    expect(payload.photoCaptions).toEqual(['Counter edge']);
    expect(screen.getByText('With your 2 photos.')).toBeTruthy();
  });

  test('a failed write says so and offers to try again', async () => {
    await openSheet(makeRequest({ report: Object.assign(new Error('Writer is busy.'), { status: 503 }) }));
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
    fireEvent.click(screen.getByRole('button', { name: '3, moderate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
    expect(await screen.findByText('Writer is busy. Try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete & send' })).toBeNull();
  });

  // Where product went down decides the indoor re-entry wait on the
  // customer's report: nothing is sent until the note has told where.
  test('a note the facts could not be read from holds the send until written again', async () => {
    const request = makeRequest({ facts: { available: true, status: 'failed', areas: [], pests: [] } });
    await openSheet(request);
    await generate();
    // The footer says why; the report card shows no heard line.
    expect(screen.getByText('Couldn’t read where you treated from your note. Write it again to retry.')).toBeTruthy();
    expect(screen.queryByTestId('fast-complete-heard')).toBeNull();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Write again' }));
    await waitFor(() => expect(request.bodies('/voice-facts')).toHaveLength(2));
  });

  test('a note that never says where holds the send until it does', async () => {
    await openSheet(makeRequest({ facts: { available: true, status: 'read', areas: [], pests: ['ants'] } }));
    await generate();
    expect(screen.getByTestId('fast-complete-heard').textContent).toBe('Heard from you: where you treated: not heard · for ants');
    expect(screen.getByText('Say where you treated (inside, outside or garage) in your note, then write it again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
  });

  test('a note too long to read holds the send and says to shorten it', async () => {
    await openSheet(makeRequest({ facts: { available: true, status: 'too_long', areas: [], pests: [] } }));
    await generate();
    expect(screen.getByText('Your note is too long to read where you treated. Shorten it, then write it again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
  });

  test('a voice-facts outage holds the send too', async () => {
    const request = makeRequest();
    request.mockImplementation(async (path, options) => {
      request.calls.push({ path, options, body: options?.body ? JSON.parse(options.body) : null });
      if (path.endsWith('/voice-facts')) throw Object.assign(new Error('down'), { status: 503 });
      if (path.split('?')[0].endsWith('/pest-recap/context')) return { ok: true, eligible: true, service: REGULAR, products: CATALOG };
      if (path.endsWith('/tech-rating-allowed')) return { allowed: true, firstVisit: false, scaleLabels: null };
      if (path === '/admin/schedule/generate-report') return { report: REPORT };
      if (path.endsWith('/treatment-zone')) return { enabled: true, treatmentZone: null };
      if (path.endsWith('/photos')) return { photos: [] };
      return { available: false };
    });
    await openSheet(request);
    await generate();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
  });

  test('a change to the visit after the report makes it stale until it is written again (fresh)', async () => {
    const request = makeRequest();
    await openSheet(request);
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the visit' }));
    fireEvent.click(screen.getByRole('button', { name: '4, elevated' }));
    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(request.bodies('/generate-report')).toHaveLength(2));
    expect(request.bodies('/generate-report')[1]).toMatchObject({ pestActivityRating: 4, fresh: true });
    expect(await screen.findByRole('button', { name: 'Complete & send' })).toBeTruthy();
  });

  test('a stale report holds Complete & send', async () => {
    await openSheet(makeRequest());
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the visit' }));
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: `${NOTE} Also the garage.` } });
    // The visit step offers to write again rather than go back to the old report.
    expect(screen.getByRole('button', { name: 'Write it again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back to the report' })).toBeNull();
  });

  test('a rate the tech changes after the report makes it stale', async () => {
    await openSheet(makeRequest());
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the visit' }));
    expect(screen.getByRole('button', { name: 'Back to the report' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit amounts' }));
    fireEvent.change(screen.getByLabelText('Taurus SC rate'), { target: { value: '0.5' } });
    expect(screen.getByRole('button', { name: 'Write it again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back to the report' })).toBeNull();
  });

  test('the report waits for the photo list, and a photo added after it is written makes it stale', async () => {
    let list = [{ id: 'p1', url: 'https://example.test/p1.jpg', caption: 'Counter edge' }];
    let releasePhotos;
    const firstRead = new Promise((resolve) => { releasePhotos = resolve; });
    let reads = 0;
    const request = makeRequest({ photos: () => (reads++ === 0 ? firstRead.then(() => ({ photos: list })) : { photos: list }) });
    await openSheet(request);
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
    fireEvent.click(screen.getByRole('button', { name: '3, moderate' }));
    expect(screen.getByText('Loading photos…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(true);
    releasePhotos();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
    await screen.findByText('Report the customer will see');
    expect(request.bodies('/generate-report')[0].photoCaptions).toEqual(['Counter edge']);
    fireEvent.click(screen.getByRole('button', { name: 'Back to the visit' }));
    list = [...list, { id: 'p2', url: 'https://example.test/p2.jpg', caption: 'Slider track' }];
    fireEvent.click(screen.getByRole('button', { name: 'Add or view photos' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Done with photos' }));
    expect(await screen.findByRole('button', { name: 'Write it again' })).toBeTruthy();
  });

  test('Write again on the report asks for a fresh draft of the same visit', async () => {
    const request = makeRequest();
    await openSheet(request);
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Write again' }));
    await waitFor(() => expect(request.bodies('/generate-report')).toHaveLength(2));
    expect(request.bodies('/generate-report')[1].fresh).toBe(true);
  });
});

describe('complete and send', () => {
  test('a regular visit posts the full completion with the report, the heard facts and the full form\'s customer text', async () => {
    const request = makeRequest({
      complete: [{ success: true, completionSmsStatus: 'sent', invoiceId: 'inv-1', invoiceTotal: 95, invoiceStatus: 'sent' }],
    });
    await openSheet(request);
    fireEvent.click(screen.getByRole('button', { name: 'Home — spoke with them' }));
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    const [body] = request.bodies('/complete');
    expect(body).toMatchObject({
      visitOutcome: 'completed',
      technicianNotes: REPORT,
      reportDraftBase: REPORT,
      areasServiced: ['Inside', 'Outside'],
      customerInteraction: 'tech_home_spoke_with_them',
      clientPestRating: 3,
      sendCompletionSms: true,
      includePayLink: true,
      requestReview: true,
      techTips: null,
    });
    expect(body).not.toHaveProperty('clientPestRatingPrefilled');
    expect(body).not.toHaveProperty('customerRecapMode');
    expect(body.expectedVisit).toBeTruthy();
    expect(body.products[0]).toMatchObject({
      productId: 'taurus', applicationMethod: 'spot_treatment', targets: ['ghost ants'], applicationArea: 'Inside, Outside', amountUnit: 'fl_oz',
    });
    expect(body.products[0]).not.toHaveProperty('areaValue');
    expect(screen.getByRole('heading', { name: 'Service complete' })).toBeTruthy();
    expect(screen.getByText('The report went to the customer by text.')).toBeTruthy();
    expect(screen.getByText('Bill: $95.00 due.')).toBeTruthy();
  });

  test('a text the server held back says so, with its reason', async () => {
    await openSheet(makeRequest({ complete: [{ success: true, completionSmsStatus: 'blocked', completionSmsError: 'customer opted out of texts' }] }));
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    expect(screen.getByText('No text went: customer opted out of texts.')).toBeTruthy();
  });

  test('a promise marked Done shows as closed only when the server closed it', async () => {
    const OPEN = [
      { id: 'p-1', description: 'Check under the dishwasher', source: 'call', madeAt: '2026-09-29T15:00:00.000Z', version: 'v1' },
      { id: 'p-2', description: 'Look at the garage door seal', source: 'text', madeAt: '2026-09-29T15:00:00.000Z', version: 'v1' },
    ];
    let completed = false;
    // After the completion the open list no longer has p-1 (closed); p-2's
    // mark did not hold (reworded meanwhile), so it is still open.
    const promises = () => (completed ? { available: true, promises: [OPEN[1]], total: 1 } : { available: true, promises: OPEN, total: 2 });
    const request = makeRequest({ promises, complete: [{ success: true, completionSmsStatus: 'sent' }] });
    const original = request.getMockImplementation();
    request.mockImplementation(async (path, options) => {
      if (path.endsWith('/complete')) completed = true;
      return original(path, options);
    });
    await openSheet(request);
    for (const description of ['Check under the dishwasher', 'Look at the garage door seal']) {
      const group = screen.getByRole('group', { name: `Mark: ${description}` });
      fireEvent.click(within(group).getByRole('button', { name: 'Done' }));
    }
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    expect(await screen.findByText('Promise closed: Check under the dishwasher')).toBeTruthy();
    expect(screen.getByText('Still open: Look at the garage door seal. The office will settle it.')).toBeTruthy();
    const reread = request.calls.map((call) => call.path).filter((path) => path.includes('/promises?include='));
    expect(reread).toEqual(['/admin/dispatch/svc-1/promises?include=p-1%2Cp-2']);
  });

  test('a re-service sends the report text with no pay link and no review ask', async () => {
    const request = makeRequest({ service: RESERVICE });
    await openSheet(request, { ...SERVICE, serviceType: 'Pest Control Re-Service' });
    expect(screen.getByRole('heading', { name: 'Complete re-service' })).toBeTruthy();
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    const [body] = request.bodies('/complete');
    expect(body).toMatchObject({ sendCompletionSms: true, includePayLink: false, requestReview: false });
    expect(body).not.toHaveProperty('customerRecapMode');
  });

  test('a perimeter heard in the note waits for the trace, which gives the sprays their length', async () => {
    const request = makeRequest({ facts: { ...FACTS, spray: 'perimeter' } });
    await openSheet(request);
    await generate();
    expect(request.bodies('/generate-report')[0].products[0].applicationMethod).toBe('perimeter_spray');
    expect(screen.getByTestId('fast-complete-heard').textContent).toBe('Heard from you: treated inside and outside · perimeter spray · for ghost ants');
    expect(screen.getByText('Trace where you sprayed: Taurus SC is a perimeter spray.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Trace where we sprayed' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save trace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close tracer' }));
    expect(await screen.findByText('Perimeter traced · 182 ft')).toBeTruthy();
    // The trace gives the length only: the report is not stale.
    expect(screen.queryByText(/You changed the visit/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    const [body] = request.bodies('/complete');
    expect(body.products.map((product) => [product.applicationMethod, product.areaValue, product.areaUnit])).toEqual([
      ['perimeter_spray', 182, 'linear_ft'], ['perimeter_spray', 182, 'linear_ft'], ['perimeter_spray', 182, 'linear_ft'],
    ]);
  });

  test('a trace with no perimeter in the note leaves the sprays spot treatments', async () => {
    const request = makeRequest({ trace: { enabled: true, treatmentZone: { linear_ft: 140.4, capture_mode: 'perimeter' } } });
    await openSheet(request);
    await generate();
    expect(screen.getByText('Perimeter traced · 140 ft')).toBeTruthy();
    expect(screen.getByText('With the trace.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    const [body] = request.bodies('/complete');
    expect(body.products[0]).toMatchObject({ applicationMethod: 'spot_treatment' });
    expect(body.products[0]).not.toHaveProperty('areaValue');
  });

  test('a perimeter saved before the report is written counts with its length', async () => {
    const request = makeRequest({
      facts: { ...FACTS, spray: 'perimeter' },
      trace: { enabled: true, treatmentZone: { linear_ft: 140.4, capture_mode: 'perimeter' } },
    });
    await openSheet(request);
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    expect(request.bodies('/complete')[0].products[0]).toMatchObject({ applicationMethod: 'perimeter_spray', areaValue: 140, areaUnit: 'linear_ft' });
  });

  test('a perimeter on a visit that cannot be traced here points to the Full form', async () => {
    await openSheet(makeRequest({ facts: { ...FACTS, spray: 'perimeter' }, trace: { enabled: false, treatmentZone: null } }));
    await generate();
    expect(screen.getByText('Taurus SC is a perimeter spray and this visit can’t be traced here. Use the Full form.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
  });

  test('the trace step is left out when the map is off or the visit takes no trace', async () => {
    await openSheet(makeRequest({ trace: { enabled: false, treatmentZone: null } }));
    await generate();
    expect(screen.queryByRole('button', { name: 'Trace where we sprayed' })).toBeNull();
    cleanup();
    await openSheet(makeRequest(), { ...SERVICE, traceEligible: false });
    await generate();
    expect(screen.queryByRole('button', { name: 'Trace where we sprayed' })).toBeNull();
  });

  test('an edited report goes as the notes, with what was written as its base', async () => {
    const request = makeRequest();
    await openSheet(request);
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const edited = REPORT.replace('for a few days', 'for a week or so');
    fireEvent.change(screen.getByLabelText('Edit the report'), { target: { value: edited } });
    fireEvent.click(screen.getByRole('button', { name: 'Done editing' }));
    expect(screen.getByText('Edited by you')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    const [body] = request.bodies('/complete');
    expect(body.technicianNotes).toBe(edited);
    expect(body.reportDraftBase).toBe(REPORT);
  });

  test('the edited-report heads-up: Send as is resends the same body and key with the confirmation', async () => {
    const request = makeRequest({
      complete: [conflict('report_rules_review', 'Refused words: "safe"'), { success: true, completionSmsStatus: 'sent' }],
    });
    await openSheet(request);
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    expect(await screen.findByText('Refused words: "safe"')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send as is' }));
    await screen.findByTestId('fast-complete-sent');
    const [first, second] = request.bodies('/complete');
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.reportRulesConfirmed).toBe(true);
    expect({ ...second, reportRulesConfirmed: undefined }).toEqual({ ...first, reportRulesConfirmed: undefined });
  });

  test('Go back from the heads-up returns to the report without sending', async () => {
    const request = makeRequest({ complete: [conflict('report_rules_review', 'Refused words: "safe"'), { success: true }] });
    await openSheet(request);
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Go back' }));
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(false);
    expect(request.bodies('/complete')).toHaveLength(1);
  });
});

describe('reportParts', () => {
  test('titles alone, inline after a colon, or with a curly apostrophe', () => {
    expect(reportParts('WHAT WE FOUND: Ants on the slider.\nWHAT’S NEXT\nWipe the counters.')).toEqual([
      { title: 'What we found', text: 'Ants on the slider.' },
      { title: 'What’s next', text: 'Wipe the counters.' },
    ]);
    expect(reportParts("WHAT WE DID\nTreated the lanai.\n\nWHAT WE FOUND\nNo activity.")).toEqual([
      { title: 'What we did', text: 'Treated the lanai.' },
      { title: 'What we found', text: 'No activity.' },
    ]);
  });

  test('a sentence that opens like a title stays text', () => {
    expect(reportParts('What we found today was light activity.')).toEqual([{ title: null, text: 'What we found today was light activity.' }]);
  });
});

describe('perimeterFeetOf', () => {
  test('a perimeter trace gives its rounded length; anything else gives none', () => {
    expect(perimeterFeetOf({ linear_ft: 181.6, capture_mode: 'perimeter' })).toBe(182);
    expect(perimeterFeetOf({ linear_ft: 120 })).toBe(120);
    expect(perimeterFeetOf({ linear_ft: 120, capture_mode: 'interior' })).toBeNull();
    expect(perimeterFeetOf({ linear_ft: 0, capture_mode: 'perimeter' })).toBeNull();
    expect(perimeterFeetOf(null)).toBeNull();
  });
});

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
  default: ({ onSaved, onClose, expectedPropertyId }) => (
    <div role="dialog" aria-label="Tracer" data-expected-property={String(expectedPropertyId)}>
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
    if (path.endsWith('/treatment-zone')) return typeof trace === 'function' ? trace() : trace;
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

describe('the visit the tech tapped', () => {
  test('a visit the office moved to another service since the schedule loaded is not completed here', async () => {
    const request = makeRequest({ service: { ...REGULAR, serviceType: 'Bi-Monthly Pest Control', serviceKey: 'pest_general_bimonthly' } });
    render(<FastCompleteSheet service={{ ...SERVICE, routedServiceKey: 'pest_general_quarterly' }} request={request} onClose={() => {}} onCompleted={() => {}} />);
    expect(await screen.findByText('This visit changed since your schedule loaded. Close and reopen it from the schedule.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate AI report' })).toBeNull();
  });

  test('the same service key under a new stored name is a changed visit too', async () => {
    const request = makeRequest({ service: { ...REGULAR, serviceType: 'Monthly Pest Control' } });
    render(<FastCompleteSheet service={{ ...SERVICE, routedServiceType: 'Quarterly Pest Control', routedServiceKey: 'pest_general_quarterly' }} request={request} onClose={() => {}} onCompleted={() => {}} />);
    expect(await screen.findByText('This visit changed since your schedule loaded. Close and reopen it from the schedule.')).toBeTruthy();
  });

  test('a row whose name the schedule cleaned up opens: the stored name is what is compared (codex r7)', async () => {
    const stored = 'Pest Control Service - 1 hour - $117';
    const request = makeRequest({ service: { ...REGULAR, serviceType: stored } });
    render(<FastCompleteSheet service={{ ...SERVICE, serviceType: 'Pest Control Service', routedServiceType: stored, routedServiceKey: 'pest_general_quarterly' }} request={request} onClose={() => {}} onCompleted={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Generate AI report' })).toBeTruthy();
    expect(screen.queryByText('This visit changed since your schedule loaded. Close and reopen it from the schedule.')).toBeNull();
  });
});

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

  test('a visit the house mix is not for (an initial cleanout) starts with nothing picked', async () => {
    const request = makeRequest({ service: { ...REGULAR, serviceType: 'Initial Pest Cleanout', serviceKey: 'pest_initial_cleanout' } });
    render(<FastCompleteSheet service={{ ...SERVICE, serviceType: 'Initial Pest Cleanout' }} request={request} onClose={() => {}} onCompleted={() => {}} />);
    await screen.findByRole('button', { name: 'Generate AI report' });
    expect(screen.queryByText(/Taurus SC 4 fl oz/)).toBeNull();
    expect(screen.queryByText(/Atticus Talak/)).toBeNull();
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
    // Two places stay on the visit; no product is said to have gone everywhere.
    expect(payload.products.map((product) => [product.name, product.applicationMethod, product.applicationArea, product.targets])).toEqual([
      ['Taurus SC', 'spot_treatment', undefined, ['ghost ants']],
      ['Atticus Talak 7.9 F', 'spot_treatment', undefined, ['ghost ants']],
      ['LESCO 90/10 Nonionic Surfactant', 'spot_treatment', undefined, ['ghost ants']],
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

  test('a place heard but denied in the note holds the send until it is said plainly', async () => {
    await openSheet(makeRequest({ facts: { available: true, status: 'read', areas: ['Outside'], unclearAreas: ['Inside'], pests: [] } }));
    await generate();
    expect(screen.getByTestId('fast-complete-heard').textContent).toBe('Heard from you: treated outside · not clear: inside');
    expect(screen.getByText('It isn’t clear whether you treated inside. Say plainly where you treated, then write it again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
  });

  test('a perimeter heard but not held up by the note holds the send, never a spot treatment (GitHub Codex P1)', async () => {
    await openSheet(makeRequest({ facts: { available: true, status: 'read', areas: ['Outside'], unclearAreas: [], pests: [], spray: null, unclearSpray: true } }));
    await generate();
    expect(screen.getByTestId('fast-complete-heard').textContent).toBe('Heard from you: treated outside · not clear: how you sprayed');
    expect(screen.getByText('It isn’t clear how you sprayed. Say plainly whether you sprayed around the house, sprayed spots, or didn’t spray, then write it again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
  });

  test('a note that says no spraying holds the send while a spray is still on the visit (GitHub Codex P1)', async () => {
    const request = makeRequest({ facts: { available: true, status: 'read', areas: ['Inside'], unclearAreas: [], pests: ['ants'], spray: null, noSpray: true } });
    await openSheet(request);
    await generate({ note: "Didn't spray today; placed bait inside along the counter for ants." });
    expect(screen.getByTestId('fast-complete-heard').textContent).toBe('Heard from you: treated inside · no spraying · for ants');
    expect(screen.getByText('Your note says you didn’t spray, but Taurus SC is a spray. Remove it or change how it went down, then write it again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
  });

  test('the report waits for the promise list to answer, so a mark is never left out (Codex #5538)', async () => {
    const request = makeRequest({ promises: () => new Promise(() => {}) });
    await openSheet(request);
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
    fireEvent.click(screen.getByRole('button', { name: '3, moderate' }));
    expect(screen.getByText('Loading promises…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(true);
  });

  test('a note that names no pest holds the send: every product would go on the record for nothing (Codex #5538)', async () => {
    await openSheet(makeRequest({ facts: { available: true, status: 'read', areas: ['Outside'], unclearAreas: [], pests: [] } }));
    await generate({ note: 'Sprayed spots outside.' });
    expect(screen.getByText('Say what pest you treated for (ants, roaches, spiders…) in your note, then write it again.')).toBeTruthy();
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

  test('a rate typed for spot spraying is not recorded under a perimeter the note turned out to say (codex r7)', async () => {
    const request = makeRequest({
      facts: { ...FACTS, spray: 'perimeter' },
      trace: { enabled: true, treatmentZone: { linear_ft: 150, capture_mode: 'perimeter' } },
    });
    await openSheet(request);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit amounts' }));
    fireEvent.change(screen.getByLabelText('Taurus SC rate'), { target: { value: '0.5' } });
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    const taurus = request.bodies('/complete')[0].products.find((product) => product.productId === 'taurus');
    expect(taurus.applicationMethod).toBe('perimeter_spray');
    expect(taurus.rate).not.toBe(0.5);
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

  test('a photo read still landing after the manager closes holds the send', async () => {
    const list = [{ id: 'p1', url: 'https://example.test/p1.jpg', caption: 'Counter edge' }];
    let releaseRefresh;
    let reads = 0;
    const request = makeRequest({
      photos: () => (reads++ === 0 ? { photos: list } : new Promise((resolve) => { releaseRefresh = () => resolve({ photos: list }); })),
    });
    await openSheet(request);
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the visit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add or view photos' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Done with photos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to the report' }));
    // The refresh has not landed: nothing is current, so nothing can go.
    expect(screen.getByText('Loading photos…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
    releaseRefresh();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(false));
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
      productId: 'taurus', applicationMethod: 'spot_treatment', targets: ['ghost ants'], amountUnit: 'fl_oz',
    });
    expect(body.products[0]).not.toHaveProperty('areaValue');
    expect(body.products[0]).not.toHaveProperty('applicationArea');
    expect(screen.getByRole('heading', { name: 'Service complete' })).toBeTruthy();
    expect(screen.getByText('The report went to the customer.')).toBeTruthy();
    expect(screen.getByText('Bill: $95.00 due.')).toBeTruthy();
  });

  test('a bill to a third-party payer is never shown as the customer\'s balance (Codex #5538)', async () => {
    await openSheet(makeRequest({ complete: [{ success: true, completionSmsStatus: 'sent', invoiceId: 'inv-1', invoiceTotal: 95, invoiceStatus: 'sent', invoicePayerBilled: true }] }));
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    expect(screen.getByText('Bill: $95.00, billed to the payer on file.')).toBeTruthy();
    expect(screen.queryByText('Bill: $95.00 due.')).toBeNull();
  });

  test('a visit the annual prepay covers is settled: never shown as due, never offered for payment (codex r11)', async () => {
    await openSheet(makeRequest({ complete: [{ success: true, completionSmsStatus: 'sent', invoiceId: 'inv-1', invoiceToken: 'tok-1', invoiceTotal: 95, invoiceStatus: 'prepaid' }] }));
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    expect(screen.getByText('Bill: covered by the annual prepay.')).toBeTruthy();
    expect(screen.queryByText(/Take payment now/)).toBeNull();
  });

  test('a text the server held back says so, with its reason', async () => {
    await openSheet(makeRequest({ complete: [{ success: true, completionSmsStatus: 'blocked', completionSmsError: 'customer opted out of texts' }] }));
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    expect(screen.getByText('No text or app message went out: customer opted out of texts.')).toBeTruthy();
  });

  test('no phone on file names the message that did not go, never that nothing went (the report email goes on its own)', async () => {
    await openSheet(makeRequest({ complete: [{ success: true, completionSmsStatus: 'no_phone' }] }));
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    expect(screen.getByText('No phone on file, so no text or app message went out. The report is in the customer’s portal.')).toBeTruthy();
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
    expect(await screen.findByText('Off the customer’s open list: Check under the dishwasher')).toBeTruthy();
    expect(screen.getByText('Still open: Look at the garage door seal. The office will settle it.')).toBeTruthy();
    const reread = request.calls.map((call) => call.path).filter((path) => path.includes('/promises?include='));
    expect(reread).toEqual(['/admin/dispatch/svc-1/promises?include=p-1%2Cp-2']);
  });

  test('one place heard goes on each product, as the full form fills it', async () => {
    const request = makeRequest({ facts: { ...FACTS, areas: ['Outside'] } });
    await openSheet(request);
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    const [body] = request.bodies('/complete');
    expect(body.areasServiced).toEqual(['Outside']);
    expect(body.products.map((product) => product.applicationArea)).toEqual(['Outside', 'Outside', 'Outside']);
  });

  test('a bill the pay link did not reach can be paid now on the tech\'s phone', async () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    const request = makeRequest({
      complete: [{
        success: true, completionSmsStatus: 'blocked', completionSmsError: 'customer opted out of texts',
        invoiceId: 'inv-1', invoiceToken: 'tok-1', invoiceTotal: 95, invoiceStatus: 'sent', invoicePaymentActionRequired: true,
      }],
    });
    await openSheet(request);
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Take payment now ($95.00)' }));
    expect(opened).toHaveBeenCalledWith('/pay/tok-1', '_blank', 'noopener,noreferrer');
  });

  test.each([
    ['the pay link went with the report', { completionSmsStatus: 'sent', completionSmsType: 'service_report_v1_with_invoice', invoiceStatus: 'sent' }],
    ['the bill is paid', { completionSmsStatus: 'sent', invoiceStatus: 'paid', invoiceTotal: 0 }],
    ['nothing is owed now', { completionSmsStatus: 'sent', invoicePaymentActionRequired: false }],
  ])('no pay-now offer when %s', async (_label, extra) => {
    const request = makeRequest({ complete: [{ success: true, invoiceId: 'inv-1', invoiceToken: 'tok-1', invoiceTotal: 95, invoicePaymentActionRequired: true, ...extra }] });
    await openSheet(request);
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    expect(screen.queryByTestId('fast-complete-collect')).toBeNull();
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

  test('a callback booked under a regular service key is a re-service: no pay link, no review ask', async () => {
    const request = makeRequest({ service: { ...REGULAR, isCallback: true } });
    await openSheet(request);
    expect(screen.getByRole('heading', { name: 'Complete re-service' })).toBeTruthy();
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    const [body] = request.bodies('/complete');
    expect(body).toMatchObject({ sendCompletionSms: true, includePayLink: false, requestReview: false });
    // Echoed for the server to re-check under its lock: an office change to
    // or from a callback since the sheet opened is refused, never billed on
    // the stale choice.
    expect(body.expectedVisit).toMatchObject({ isCallback: true });
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
    // The tracer saves bound to the property this sheet loaded (Codex #5538).
    expect((await screen.findByRole('dialog', { name: 'Tracer' })).getAttribute('data-expected-property')).toBe('prop-1');
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

  test('a spot visit has no trace step, and a trace already saved holds the send (the report would show a sprayed perimeter)', async () => {
    const request = makeRequest({ trace: { enabled: true, treatmentZone: { linear_ft: 140.4, capture_mode: 'perimeter' } } });
    await openSheet(request);
    await generate();
    expect(screen.queryByText('Perimeter traced · 140 ft')).toBeNull();
    expect(screen.queryByText('With the trace.')).toBeNull();
    expect(screen.getByText('Your saved trace shows a spray around the house, but your note says spots only. Say plainly how you sprayed, then write it again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
    expect(request.bodies('/complete')).toEqual([]);
  });

  test('a product set to Perimeter spray by hand gets the trace step even when the note says spots', async () => {
    const products = [...CATALOG, { id: 'gentrol', name: 'Gentrol IGR', category: 'Insecticide' }];
    await openSheet(makeRequest({ products }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    const picker = screen.getByRole('dialog', { name: 'Add a product' });
    fireEvent.click(within(picker).getByRole('button', { name: /^Gentrol IGR\b/ }));
    const editor = screen.getByRole('group', { name: 'Gentrol IGR' });
    fireEvent.click(within(within(editor).getByRole('group', { name: 'How' })).getByRole('button', { name: 'Perimeter spray' }));
    fireEvent.change(within(editor).getByLabelText('How much?'), { target: { value: '1' } });
    await generate();
    expect(screen.getByRole('button', { name: 'Trace where we sprayed' })).toBeTruthy();
    expect(screen.getByText('Trace where you sprayed: Gentrol IGR is a perimeter spray.')).toBeTruthy();
  });

  test('a trace read that failed holds the send until it reads (a saved perimeter would still show)', async () => {
    let failing = true;
    const request = makeRequest({ trace: () => {
      if (failing) throw new Error('offline');
      return { enabled: true, treatmentZone: null };
    } });
    await openSheet(request);
    await generate();
    expect(screen.getByText('Couldn’t check for a saved trace. Check the trace again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Check the trace again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(false));
  });

  test('a way picked by hand for an added product stays when the note is read (codex r8)', async () => {
    const products = [...CATALOG, { id: 'gentrol', name: 'Gentrol IGR', category: 'Insecticide' }];
    const request = makeRequest({
      products,
      facts: { ...FACTS, spray: 'perimeter' },
      trace: { enabled: true, treatmentZone: { linear_ft: 150, capture_mode: 'perimeter' } },
    });
    await openSheet(request);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add a product' })).getByRole('button', { name: /^Gentrol IGR\b/ }));
    const editor = screen.getByRole('group', { name: 'Gentrol IGR' });
    fireEvent.click(within(within(editor).getByRole('group', { name: 'How' })).getByRole('button', { name: 'Spot treatment' }));
    fireEvent.change(within(editor).getByLabelText('How much?'), { target: { value: '1' } });
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    const body = request.bodies('/complete')[0];
    expect(body.products.find((product) => product.productId === 'gentrol')).toMatchObject({ applicationMethod: 'spot_treatment' });
    expect(body.products.find((product) => product.productId === 'gentrol')).not.toHaveProperty('areaValue');
    expect(body.products.find((product) => product.productId === 'taurus')).toMatchObject({ applicationMethod: 'perimeter_spray', areaValue: 150 });
  });

  test('an "Interior spray too" trace holds the send until the note says inside was treated (pre-push P1)', async () => {
    const request = makeRequest({
      facts: { ...FACTS, areas: ['Outside'], spray: 'perimeter' },
      trace: { enabled: true, treatmentZone: { linear_ft: 150, capture_mode: 'interior' } },
    });
    await openSheet(request);
    await generate();
    expect(screen.getByText('Your trace says you sprayed inside too, but your note doesn’t say you treated inside. Say where you treated, or trace again without Interior spray.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
  });

  test('a spot visit with no trace saved completes with spot treatments and no trace step', async () => {
    const request = makeRequest();
    await openSheet(request);
    await generate();
    expect(screen.queryByRole('button', { name: 'Trace where we sprayed' })).toBeNull();
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
  test('a perimeter trace gives its rounded length; an outline gives none', () => {
    expect(perimeterFeetOf({ linear_ft: 181.6, capture_mode: 'perimeter' })).toBe(182);
    expect(perimeterFeetOf({ linear_ft: 120 })).toBe(120);
    // "Interior spray too" keeps the perimeter's length.
    expect(perimeterFeetOf({ linear_ft: 120, capture_mode: 'interior' })).toBe(120);
    expect(perimeterFeetOf({ linear_ft: 120, capture_mode: 'yard' })).toBeNull();
    expect(perimeterFeetOf({ linear_ft: 120, capture_mode: 'lawn_highlight' })).toBeNull();
    expect(perimeterFeetOf({ linear_ft: 0, capture_mode: 'perimeter' })).toBeNull();
    expect(perimeterFeetOf(null)).toBeNull();
  });
});

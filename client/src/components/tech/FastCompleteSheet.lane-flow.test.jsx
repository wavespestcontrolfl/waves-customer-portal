// @vitest-environment jsdom
// Lane voice fill on the tech's Fast Complete sheet (GATE_LANE_VOICE_FILL,
// Fast Complete step 2, owner "ok go" 2026-10-02 on the mockup v8): a bed
// bug, fire ant, tick, bee & wasp, mud dauber or mosquito visit opens the
// report flow, and Generate first reads the visit's own record from the note
// (POST /admin/dispatch/:id/lane-facts). The record fills only what is still
// empty and nobody picked; "<Lane> record heard from you" shows each field
// with the words it came from and a Change; the report and the completion
// are written from the record (its places, its findings as observations).
// No pest facts, no house mix, no trace step on the sheet.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('./TechTreatmentZoneModal', () => ({ default: () => <div role="dialog" aria-label="Tracer" /> }));
vi.mock('./TechServicePhotosModal', () => ({ default: () => <div role="dialog" aria-label="Photo manager" /> }));

import FastCompleteSheet from './FastCompleteSheet';
import { EMPTY_LANE_RECORD, changeLaneRecord, mergeLaneRecord } from './FastCompleteReport';
import { SERVICE_COMPLETION_PRESETS } from '../../lib/service-completion-presets';

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// The pest house mix is in the catalog, so a sheet that seeded it would show
// it.
const CATALOG = [
  { id: 'taurus', name: 'Taurus SC', category: 'Insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' },
  { id: 'talstar', name: 'Atticus Talak 7.9 F', category: 'Insecticide' },
  { id: 'surfactant', name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant' },
  { id: 'temprid', name: 'Temprid FX', category: 'Insecticide' },
  { id: 'mist', name: 'Example Mosquito Concentrate', category: 'Insecticide' },
];
const VISIT = {
  id: 'svc-bb', customerName: 'Pat Jones', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-bb',
  serviceType: 'Bed Bug Treatment', scheduledDate: '2026-10-02', address: { line1: '123 Main St' },
  serviceKey: 'bed_bug_treatment', status: 'confirmed',
};
const NOTE = 'Second treatment. Treated the master bedroom and the living room couch, live ones on the couch seams. They had everything bagged.';
const READ = {
  available: true,
  status: 'read',
  lane: 'bed_bug_treatment',
  areas: [
    { area: 'Primary bedroom', quote: 'treated the master bedroom' },
    { area: 'Furniture / upholstery', quote: 'the living room couch' },
  ],
  findings: [
    { group: 'bed_bug_visit_stage', value: 'Scheduled follow-up treatment', quote: 'second treatment' },
    { group: 'bed_bug_evidence', value: 'Live adults', quote: 'live ones on the couch seams' },
    { group: 'bed_bug_prep', value: 'Preparation complete', quote: 'they had everything bagged' },
  ],
  unclearGroups: [],
};
const REPORT = 'WHAT WE FOUND\nLive bed bugs on the couch seams.\n\nWHAT WE DID AND WHY\nWe treated the bedroom and the couch.';

function makeRequest({
  visit = VISIT, lane = 'bed_bug_treatment', laneFacts = READ, trace = { enabled: true, treatmentZone: null }, complete = { success: true },
} = {}) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options, body: options?.body ? JSON.parse(options.body) : null });
    if (path.split('?')[0].endsWith('/pest-recap/context')) return { ok: true, eligible: false, lane, service: visit, products: CATALOG };
    if (path.endsWith('/tech-rating-allowed')) return { allowed: false };
    if (path.endsWith('/tech-tips')) return { available: false };
    if (path.split('?')[0].endsWith('/promises')) return { available: false, promises: [] };
    if (path.split('?')[0].endsWith('/blog-posts')) return { available: false, posts: [] };
    if (path.endsWith('/photos')) return { photos: [] };
    if (path.split('?')[0].endsWith('/treatment-zone')) return typeof trace === 'function' ? trace(path, options) : trace;
    if (path === '/admin/schedule/generate-report') return { report: REPORT };
    if (path.endsWith('/lane-facts')) return typeof laneFacts === 'function' ? laneFacts() : laneFacts;
    if (path.endsWith('/voice-facts')) throw new Error('a lane visit never reads the pest facts');
    if (path.endsWith('/complete')) return complete;
    return {};
  });
  request.bodies = (suffix) => calls.filter((call) => call.path.endsWith(suffix)).map((call) => call.body);
  return request;
}

const SERVICE = {
  id: 'svc-bb', customerName: 'Pat Jones', serviceType: 'Bed Bug Treatment', address: '123 Main St', timeLabel: '9:00 AM',
  reportFlow: true, laneFlow: true, laneKey: 'bed_bug_treatment', traceEligible: false, lat: 27.4, lng: -82.5, technicianName: 'Adam',
};

async function openSheet(request, service = SERVICE) {
  render(<FastCompleteSheet service={service} request={request} onClose={() => {}} onCompleted={() => {}} />);
  // The first render pays the sheet's cold import; a slow machine gets time.
  await screen.findByRole('button', { name: 'Generate AI report' }, { timeout: 5000 });
}

function addProduct(name, amount, how = null) {
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Add a product' })).getByRole('button', { name: new RegExp(`^${name}\\b`) }));
  const editor = screen.getByRole('group', { name });
  if (how) fireEvent.click(within(within(editor).getByRole('group', { name: 'How' })).getByRole('button', { name: how }));
  fireEvent.change(within(editor).getByLabelText('How much?'), { target: { value: amount } });
}

async function generate(note = NOTE) {
  fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: note } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
  await screen.findByText('Report the customer will see', {}, { timeout: 5000 });
}

const recordCard = () => screen.getByRole('region', { name: 'Bed bug record heard from you' });
// A field's row on the card: its label, its value, the words heard.
const fieldRow = (label) => within(recordCard()).getByText(label).closest('.tech-lane-row');

describe('the lane record on the sheet', () => {
  test('reads the visit\'s own record from the note, shows each field with its words, and writes the report and the completion from it', async () => {
    const request = makeRequest();
    await openSheet(request);
    // Never the pest house mix.
    expect(screen.getByText('None selected')).toBeTruthy();
    addProduct('Temprid FX', '1');
    await generate();
    expect(request.bodies('/lane-facts')).toEqual([{ note: NOTE }]);
    expect(request.bodies('/voice-facts')).toEqual([]);
    const written = request.bodies('generate-report')[0];
    expect(written.areasServiced).toEqual(['Primary bedroom', 'Furniture / upholstery']);
    expect(written.observations).toEqual(['Scheduled follow-up treatment', 'Live adults', 'Preparation complete']);
    expect(written.products).toEqual([expect.objectContaining({ productId: 'temprid', targets: [] })]);
    expect(written.products[0]).not.toHaveProperty('applicationArea');

    expect(within(fieldRow('Where')).getByText('Primary bedroom · Furniture / upholstery')).toBeTruthy();
    expect(within(fieldRow('Where')).getByText('“treated the master bedroom” · “the living room couch”')).toBeTruthy();
    expect(within(fieldRow('Evidence observed')).getByText('Live adults')).toBeTruthy();
    expect(within(fieldRow('Evidence observed')).getByText('“live ones on the couch seams”')).toBeTruthy();
    // No pest facts line, no trace step.
    expect(screen.queryByTestId('fast-complete-heard')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Trace where we sprayed' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    const body = request.bodies('/complete')[0];
    expect(body).toMatchObject({
      areasServiced: ['Primary bedroom', 'Furniture / upholstery'],
      structuredObservations: ['Scheduled follow-up treatment', 'Live adults', 'Preparation complete'],
      traceSeen: null,
      technicianNotes: REPORT,
    });
    expect(body.products).toEqual([expect.objectContaining({ productId: 'temprid', targets: [], applicationMethod: 'spot_treatment' })]);
    expect(body.products[0]).not.toHaveProperty('applicationArea');
    expect(body.products[0]).not.toHaveProperty('areaValue');
  });

  test('one place goes on every product as its application area', async () => {
    const request = makeRequest({ laneFacts: { ...READ, areas: [READ.areas[0]] } });
    await openSheet(request);
    addProduct('Temprid FX', '1');
    await generate();
    expect(request.bodies('generate-report')[0].products[0]).toMatchObject({ applicationArea: 'Primary bedroom' });
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    expect(request.bodies('/complete')[0].products[0]).toMatchObject({ applicationArea: 'Primary bedroom' });
  });

  test('Change is the tech\'s own pick: the report goes stale, and writing it again never overwrites the pick', async () => {
    const request = makeRequest();
    await openSheet(request);
    addProduct('Temprid FX', '1');
    await generate();
    fireEvent.click(within(recordCard()).getByRole('button', { name: 'Change Evidence observed' }));
    fireEvent.click(within(within(recordCard()).getByRole('group', { name: 'Evidence observed' })).getByRole('button', { name: 'Live nymphs' }));
    // The pick is the answer: the choices close.
    expect(within(recordCard()).queryByRole('group', { name: 'Evidence observed' })).toBeNull();
    expect(within(fieldRow('Evidence observed')).getByText('Live nymphs')).toBeTruthy();
    // The words heard were for another value.
    expect(within(fieldRow('Evidence observed')).queryByText('“live ones on the couch seams”')).toBeNull();
    expect(screen.getByText(/You changed the visit after this report was written/)).toBeTruthy();
    // A stale report is written again before it can be sent.
    expect(screen.queryByRole('button', { name: 'Complete & send' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(request.bodies('generate-report')).toHaveLength(2));
    expect(request.bodies('/lane-facts')).toHaveLength(2);
    expect(request.bodies('generate-report')[1].observations).toEqual(['Scheduled follow-up treatment', 'Live nymphs', 'Preparation complete']);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(false));
    expect(within(fieldRow('Evidence observed')).getByText('Live nymphs')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    expect(request.bodies('/complete')[0].structuredObservations).toEqual(['Scheduled follow-up treatment', 'Live nymphs', 'Preparation complete']);
  });

  test('a place toggled by hand stays the tech\'s: a later read never refills the places', async () => {
    const request = makeRequest();
    await openSheet(request);
    addProduct('Temprid FX', '1');
    await generate();
    fireEvent.click(within(recordCard()).getByRole('button', { name: 'Change Where' }));
    fireEvent.click(within(within(recordCard()).getByRole('group', { name: 'Where' })).getByRole('button', { name: 'Furniture / upholstery' }));
    // Places take several: the list stays open.
    expect(within(recordCard()).getByRole('group', { name: 'Where' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(request.bodies('generate-report')).toHaveLength(2));
    expect(request.bodies('generate-report')[1].areasServiced).toEqual(['Primary bedroom']);
  });

  test('a group the note left unclear asks to be picked', async () => {
    const request = makeRequest({
      laneFacts: { ...READ, findings: READ.findings.filter((entry) => entry.group !== 'bed_bug_prep'), unclearGroups: ['bed_bug_prep'] },
    });
    await openSheet(request);
    addProduct('Temprid FX', '1');
    await generate();
    expect(within(fieldRow('Preparation status')).getByText('Not clear from your note. Pick one.')).toBeTruthy();
    expect(request.bodies('generate-report')[0].observations).toEqual(['Scheduled follow-up treatment', 'Live adults']);
  });

  test('a read that failed fills nothing and says so; the report is still written and the tech picks each field', async () => {
    let reads = 0;
    const request = makeRequest({ laneFacts: () => { reads += 1; if (reads === 1) throw new Error('offline'); return { ...READ, areas: [], findings: [] }; } });
    await openSheet(request);
    addProduct('Temprid FX', '1');
    await generate();
    expect(within(recordCard()).getByText('Couldn’t read your note for this just now. Pick each one, or write the report again.')).toBeTruthy();
    expect(within(fieldRow('Evidence observed')).getByText('Not picked')).toBeTruthy();
    expect(request.bodies('generate-report')[0]).toMatchObject({ areasServiced: [], observations: [] });
    // No place, no send: the report would drop the outdoor re-entry wait
    // (codex local r3 on #5629). The tech picks one, and the report is
    // written again from it.
    expect(screen.getByText('Pick where you treated: tap Change beside Where.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
    fireEvent.click(within(recordCard()).getByRole('button', { name: 'Change Where' }));
    fireEvent.click(within(within(recordCard()).getByRole('group', { name: 'Where' })).getByRole('button', { name: 'Primary bedroom' }));
    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(request.bodies('generate-report')).toHaveLength(2));
    expect(request.bodies('generate-report')[1].areasServiced).toEqual(['Primary bedroom']);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(false));
  });

  test('a read that heard no place holds the send until the tech picks one', async () => {
    const request = makeRequest({ laneFacts: { ...READ, areas: [] } });
    await openSheet(request);
    addProduct('Temprid FX', '1');
    await generate();
    expect(within(fieldRow('Where')).getByText('Not said')).toBeTruthy();
    expect(screen.getByText('Pick where you treated: tap Change beside Where.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
  });
});

describe('what holds a lane visit\'s send', () => {
  test('a product set to Perimeter spray by hand: the sheet can\'t trace a lane visit, so it says to use the Full form', async () => {
    const request = makeRequest();
    await openSheet(request);
    addProduct('Temprid FX', '1', 'Perimeter spray');
    await generate();
    expect(screen.getByText('Temprid FX is a perimeter spray and this visit can’t be traced here. Use the Full form.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Trace where we sprayed' })).toBeNull();
  });

  test('a saved perimeter trace no perimeter spray backs would show on the customer\'s report: remove it or use the Full form', async () => {
    const request = makeRequest({ trace: { enabled: true, treatmentZone: { linear_ft: 120, capture_mode: 'perimeter', updated_at: '2026-10-02T14:00:00Z' } } });
    await openSheet(request);
    addProduct('Temprid FX', '1');
    await generate();
    expect(await screen.findByText('Your saved trace would show on the customer’s report, but nothing on this visit was sprayed around the house. Remove the trace, or use the Full form.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove the trace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
  });

  test('a perimeter spray with a saved trace goes on the record with its length, and the card says the trace is on the report', async () => {
    const request = makeRequest({ trace: { enabled: true, treatmentZone: { linear_ft: 120, capture_mode: 'perimeter', updated_at: '2026-10-02T14:00:00Z' } } });
    await openSheet(request);
    addProduct('Temprid FX', '1', 'Perimeter spray');
    await generate();
    expect(screen.getByText('With the trace.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    const body = request.bodies('/complete')[0];
    expect(body.traceSeen).toBe('2026-10-02T14:00:00Z');
    expect(body.products[0]).toMatchObject({ applicationMethod: 'perimeter_spray', areaValue: 120, areaUnit: 'linear_ft' });
  });
});

describe('a saved outline on a lane visit (codex local r2 on #5629)', () => {
  const OUTLINE = (mode) => ({ enabled: true, treatmentZone: { capture_mode: mode, updated_at: '2026-10-02T14:00:00Z' } });

  test('a mosquito yard outline stands with a fog/ULV mist: it goes on the report, and the card says so', async () => {
    const visit = { ...VISIT, serviceType: 'Mosquito Control (Monthly)', serviceKey: 'mosquito_monthly' };
    const request = makeRequest({
      visit, lane: 'mosquito', trace: OUTLINE('yard'),
      laneFacts: { available: true, status: 'read', lane: 'mosquito', areas: [{ area: 'Yard vegetation', quote: 'the yard' }], findings: [], unclearGroups: [] },
    });
    await openSheet(request, { ...SERVICE, serviceType: 'Mosquito Control (Monthly)', laneKey: 'mosquito' });
    addProduct('Example Mosquito Concentrate', '2');
    await generate('Misted the yard.');
    expect(screen.getByText('With the trace.')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    const body = request.bodies('/complete')[0];
    expect(body.traceSeen).toBe('2026-10-02T14:00:00Z');
    expect(body.products[0]).toMatchObject({ applicationMethod: 'fog_ulv' });
    expect(body.products[0]).not.toHaveProperty('areaValue');
  });

  test('a lawn outline with no product spread across an area holds: remove it or use the Full form', async () => {
    const visit = { ...VISIT, serviceType: 'Fire Ant Treatment', serviceKey: 'fire_ant' };
    const request = makeRequest({
      visit, lane: 'fire_ant', trace: OUTLINE('lawn'),
      laneFacts: { available: true, status: 'read', lane: 'fire_ant', areas: [{ area: 'Front lawn', quote: 'front lawn' }], findings: [], unclearGroups: [] },
    });
    await openSheet(request, { ...SERVICE, serviceType: 'Fire Ant Treatment', laneKey: 'fire_ant' });
    addProduct('Temprid FX', '1');
    await generate('Drenched two mounds.');
    expect(await screen.findByText('Your saved outline would show on the customer’s report as the area treated, but nothing on this visit was broadcast, spread or misted across an area. Remove the trace, or use the Full form.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove the trace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
  });

  test('a lawn outline stands with a broadcast spray picked for the product', async () => {
    const visit = { ...VISIT, serviceType: 'Fire Ant Treatment', serviceKey: 'fire_ant' };
    const request = makeRequest({
      visit, lane: 'fire_ant', trace: OUTLINE('lawn'),
      laneFacts: { available: true, status: 'read', lane: 'fire_ant', areas: [{ area: 'Front lawn', quote: 'front lawn' }], findings: [], unclearGroups: [] },
    });
    await openSheet(request, { ...SERVICE, serviceType: 'Fire Ant Treatment', laneKey: 'fire_ant' });
    addProduct('Temprid FX', '1', 'Broadcast spray');
    await generate('Broadcast the front lawn.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(false));
  });
});

describe('an "Interior spray too" trace on a lane visit (codex local r4 on #5629)', () => {
  const INTERIOR = { enabled: true, treatmentZone: { capture_mode: 'interior', linear_ft: 150, updated_at: '2026-10-02T14:00:00Z' } };
  const TICK_VISIT = { ...VISIT, serviceType: 'Tick Control', serviceKey: 'tick_control' };
  const tickRead = (areas) => ({ available: true, status: 'read', lane: 'tick_control', areas, findings: [], unclearGroups: [] });
  const TICK_SERVICE = { ...SERVICE, serviceType: 'Tick Control', laneKey: 'tick_control' };

  test('holds while the record lists no place inside: the map would claim indoor treatment the record does not', async () => {
    const request = makeRequest({ visit: TICK_VISIT, lane: 'tick_control', trace: INTERIOR, laneFacts: tickRead([{ area: 'Front lawn', quote: 'front lawn' }]) });
    await openSheet(request, TICK_SERVICE);
    addProduct('Temprid FX', '1', 'Perimeter spray');
    await generate('Sprayed around the house and the front lawn.');
    expect(await screen.findByText('Your trace says you sprayed inside too, but no place on the record is inside. Add the place inside (Change beside Where), or remove the trace.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove the trace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(true);
  });

  test('sends once the record lists a place inside, with the trace\'s length on the perimeter spray', async () => {
    const request = makeRequest({
      visit: TICK_VISIT, lane: 'tick_control', trace: INTERIOR,
      laneFacts: tickRead([{ area: 'Front lawn', quote: 'front lawn' }, { area: 'Interior pet areas', quote: 'the pet areas inside' }]),
    });
    await openSheet(request, TICK_SERVICE);
    addProduct('Temprid FX', '1', 'Perimeter spray');
    await generate('Sprayed around the house, the front lawn and the pet areas inside.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Complete & send' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    expect(request.bodies('/complete')[0].products[0]).toMatchObject({ applicationMethod: 'perimeter_spray', areaValue: 150, areaUnit: 'linear_ft' });
  });
});

describe('the visit the tech tapped', () => {
  test('a visit that no longer reads as the lane it was routed as needs the full form', async () => {
    const request = makeRequest({ lane: null });
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} onCompleted={() => {}} />);
    expect(await screen.findByText('This visit needs the full form.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate AI report' })).toBeNull();
  });

  test('a lane visit that is a callback is never seeded with the pest house mix', async () => {
    const visit = { ...VISIT, serviceType: 'Mud Dauber Removal', serviceKey: 'mud_dauber_removal', isCallback: true };
    const request = makeRequest({ visit, lane: 'mud_dauber_removal' });
    await openSheet(request, { ...SERVICE, serviceType: 'Mud Dauber Removal', laneKey: 'mud_dauber_removal' });
    expect(screen.getByText('None selected')).toBeTruthy();
    expect(screen.queryByText(/Taurus SC/)).toBeNull();
  });
});

describe('how a lane visit\'s products go down (codex local r1 on #5629)', () => {
  const MOSQUITO_VISIT = { ...VISIT, serviceType: 'Mosquito Control (Monthly)', serviceKey: 'mosquito_monthly' };
  const MOSQUITO_READ = {
    available: true, status: 'read', lane: 'mosquito',
    areas: [{ area: 'Shrubs / landscape beds', quote: 'misted the shrubs' }],
    findings: [{ group: 'mosquito_activity', value: 'Moderate mosquito activity', quote: 'moderate activity' }],
    unclearGroups: [],
  };
  const MOSQUITO_SERVICE = { ...SERVICE, serviceType: 'Mosquito Control (Monthly)', laneKey: 'mosquito' };

  test('a mosquito visit\'s methodless liquid is a barrier mist (fog/ULV), as the full form records it, with no area to measure', async () => {
    const request = makeRequest({ visit: MOSQUITO_VISIT, lane: 'mosquito', laneFacts: MOSQUITO_READ });
    await openSheet(request, MOSQUITO_SERVICE);
    addProduct('Example Mosquito Concentrate', '2');
    const how = within(screen.getByRole('group', { name: 'Example Mosquito Concentrate' })).getByRole('group', { name: 'How' });
    expect(within(how).getByRole('button', { name: 'Fog/ULV' }).getAttribute('aria-pressed')).toBe('true');
    await generate('Misted the shrubs, moderate activity.');
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    const product = request.bodies('/complete')[0].products[0];
    expect(product).toMatchObject({ productId: 'mist', applicationMethod: 'fog_ulv', applicationArea: 'Shrubs / landscape beds' });
    expect(product).not.toHaveProperty('areaValue');
  });

  test('a lane visit offers the full form\'s specialty ways, and the one picked is recorded', async () => {
    const request = makeRequest();
    await openSheet(request);
    addProduct('Temprid FX', '1', 'Broadcast spray');
    const how = within(screen.getByRole('group', { name: 'Temprid FX' })).getByRole('group', { name: 'How' });
    for (const way of ['Spot treatment', 'Perimeter spray', 'Bait placement', 'Granular', 'Broadcast spray', 'Fog/ULV', 'Soil drench']) {
      expect(within(how).getByRole('button', { name: way })).toBeTruthy();
    }
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Complete & send' }));
    await screen.findByTestId('fast-complete-sent');
    expect(request.bodies('/complete')[0].products[0]).toMatchObject({ applicationMethod: 'broadcast_spray' });
  });

  test('a spray with no way picked goes down as a spot treatment, and says so', async () => {
    const request = makeRequest();
    await openSheet(request);
    addProduct('Temprid FX', '1');
    expect(within(screen.getByRole('group', { name: 'Temprid FX' })).getByText('Spot treatment until you pick another way')).toBeTruthy();
  });

  test('work done without a product goes on the Full form, which records its action (heat, steam, nest removal, an inspection)', async () => {
    const request = makeRequest();
    await openSheet(request);
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: 'Heat treatment, whole unit.' } });
    expect(screen.getByText('Add the product you applied. Work done without one (heat, steam, nest removal, an inspection) goes on the Full form.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(true);
  });
});

describe('the record\'s rules', () => {
  const bedBug = SERVICE_COMPLETION_PRESETS.bed_bug_treatment;
  const fireAnt = SERVICE_COMPLETION_PRESETS.fire_ant;
  const facts = (overrides = {}) => ({ status: 'read', areas: [], findings: [], unclearGroups: [], ...overrides });

  test('a read fills only empty, unpicked fields, and the places only while none are set', () => {
    const picked = changeLaneRecord(EMPTY_LANE_RECORD, 'bed_bug_evidence', 'Eggs', bedBug);
    const filled = mergeLaneRecord(picked, facts({ areas: READ.areas, findings: READ.findings }), bedBug);
    expect(filled.values).toEqual({ bed_bug_evidence: 'Eggs', bed_bug_visit_stage: 'Scheduled follow-up treatment', bed_bug_prep: 'Preparation complete' });
    expect(filled.heard.values.bed_bug_evidence).toBeUndefined();
    expect(filled.areas).toEqual(['Primary bedroom', 'Furniture / upholstery']);
    const again = mergeLaneRecord(filled, facts({ areas: [{ area: 'Closets', quote: 'closets' }], findings: [{ group: 'bed_bug_prep', value: 'Preparation not completed', quote: 'nothing bagged' }] }), bedBug);
    expect(again.areas).toEqual(['Primary bedroom', 'Furniture / upholstery']);
    expect(again.values.bed_bug_prep).toBe('Preparation complete');
  });

  test('places cleared by hand stay cleared', () => {
    const cleared = changeLaneRecord(changeLaneRecord(EMPTY_LANE_RECORD, 'areas', 'Closets', bedBug), 'areas', 'Closets', bedBug);
    expect(cleared.areas).toEqual([]);
    expect(mergeLaneRecord(cleared, facts({ areas: READ.areas }), bedBug).areas).toEqual([]);
  });

  test('a value that would drop a chosen one stays unpicked, and a pick drops a value its tap excludes', () => {
    const chosen = changeLaneRecord(EMPTY_LANE_RECORD, 'fire_ant_distribution', 'Widespread activity', fireAnt);
    const merged = mergeLaneRecord(chosen, facts({ findings: [{ group: 'fire_ant_evidence', value: 'No active fire ants observed', quote: 'no active mounds' }] }), fireAnt);
    expect(merged.values).toEqual({ fire_ant_distribution: 'Widespread activity' });
    const none = changeLaneRecord(chosen, 'fire_ant_evidence', 'No active fire ants observed', fireAnt);
    expect(none.values).toEqual({ fire_ant_evidence: 'No active fire ants observed' });
  });

  test('values and places off the lane\'s lists never land', () => {
    const merged = mergeLaneRecord(EMPTY_LANE_RECORD, facts({
      areas: [{ area: 'Kitchen', quote: 'kitchen' }],
      findings: [{ group: 'bed_bug_evidence', value: 'Ants', quote: 'ants' }, { group: 'made_up', value: 'Live adults', quote: 'live' }],
    }), bedBug);
    expect(merged.areas).toEqual([]);
    expect(merged.values).toEqual({});
  });

  test('a read that failed changes nothing', () => {
    const record = changeLaneRecord(EMPTY_LANE_RECORD, 'bed_bug_evidence', 'Eggs', bedBug);
    expect(mergeLaneRecord(record, { status: 'failed', areas: [], findings: [], unclearGroups: [] }, bedBug)).toBe(record);
  });
});

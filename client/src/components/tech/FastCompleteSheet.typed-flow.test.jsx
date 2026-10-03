// @vitest-environment jsdom
// Typed voice fill on the tech's Fast Complete sheet (GATE_TYPED_VOICE_FILL,
// Fast Complete step 3, owner "ok go" 2026-10-02 on the mockup v8): a
// cockroach, flea, inspection, rodent or other typed visit the reader reads
// opens the report flow, and Generate first reads the visit's own typed form
// from the note (POST /admin/dispatch/:id/typed-facts, sending the record's
// present values for the server to judge beside). The record fills only what
// is still empty and nobody picked; "<Form> record heard from you" shows each
// field with the words it came from and a Change; the report and the
// completion are written from the record (structuredFindings, the form's own
// treated areas, and the activity score when the tech sets it). No pest
// facts, no 1 to 5 rating, no house mix, no product needed, no trace step.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('./TechTreatmentZoneModal', () => ({ default: () => <div role="dialog" aria-label="Tracer" /> }));
vi.mock('./TechServicePhotosModal', () => ({ default: () => <div role="dialog" aria-label="Photo manager" /> }));

import FastCompleteSheet from './FastCompleteSheet';

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// The pest house mix is in the catalog, so a sheet that seeded it would show
// it.
const CATALOG = [
  { id: 'taurus', name: 'Taurus SC', category: 'Insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' },
  { id: 'talstar', name: 'Atticus Talak 7.9 F', category: 'Insecticide' },
  { id: 'surfactant', name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant' },
  { id: 'gel', name: 'Example Roach Gel', category: 'Insecticide' },
];
const TECH_SCORE_LABELS = { 0: 'None', 1: 'Very low', 2: 'Low', 3: 'Moderate', 4: 'High', 5: 'Severe' };
// The served cockroach form (activity-indicators.js findingsSchemaForType).
const ROACH_SCHEMA = {
  type: 'cockroach',
  label: 'Cockroach Treatment',
  fields: [
    { key: 'species', label: 'Species', type: 'select', required: true, options: ['German', 'American', 'Smoky brown', 'Mixed', 'Unknown'] },
    { key: 'activity_level', label: 'Activity level', type: 'select', required: true, options: ['None observed', 'Low', 'Moderate', 'Heavy', 'Severe'] },
    { key: 'activity_locations', label: 'Activity locations', type: 'chips', detail: true, options: ['Kitchen', 'Bathrooms', 'Behind refrigerator'] },
    { key: 'areas_treated', label: 'Areas treated', type: 'chips', options: ['Kitchen', 'Bathrooms', 'Under sinks', 'Exterior perimeter'] },
    { key: 'work_completed', label: 'Work completed', type: 'chips', autoFilled: true, options: ['Bait placement', 'Crack & crevice treatment'] },
  ],
  activity: { label: 'Roach Activity', deriveField: 'activity_level', techScoreLabels: TECH_SCORE_LABELS },
};
const VISIT = {
  id: 'svc-roach', customerName: 'Pat Jones', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-roach',
  serviceType: 'Cockroach Control', scheduledDate: '2026-10-02', address: { line1: '123 Main St' },
  serviceKey: 'cockroach_control', status: 'confirmed',
};
const NOTE = 'German roaches, heavy behind the fridge. Gel bait in the kitchen and under the sinks.';
const READ = {
  available: true,
  status: 'read',
  type: 'cockroach',
  values: { species: 'German', activity_level: 'Heavy', areas_treated: 'Kitchen, Under sinks' },
  heard: {
    species: [{ value: 'German', quote: 'german roaches' }],
    activity_level: [{ value: 'Heavy', quote: 'heavy behind the fridge' }],
    areas_treated: [{ value: 'Kitchen', quote: 'gel bait in the kitchen' }, { value: 'Under sinks', quote: 'under the sinks' }],
  },
  unclearFields: [],
};
const REPORT = 'WHAT WE FOUND\nGerman roaches behind the refrigerator.\n\nWHAT WE DID AND WHY\nWe baited the kitchen and under the sinks.';

function makeRequest({
  visit = VISIT, typedType = 'cockroach', typedFacts = READ, trace = { enabled: true, treatmentZone: null }, complete = { success: true },
  traceOnReport, followupBooking, scheduleFollowup = () => ({ appointment: { scheduledDate: '2026-10-15' } }),
} = {}) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options, body: options?.body ? JSON.parse(options.body) : null });
    if (path.split('?')[0].endsWith('/pest-recap/context')) {
      return {
        ok: true, eligible: false, lane: null, ...(typedType ? { typedType } : {}), service: visit, products: CATALOG,
        ...(traceOnReport === undefined ? {} : { traceOnReport }),
        ...(followupBooking === undefined ? {} : { followupBooking }),
      };
    }
    // The rating contract allows a rating on a first visit: a typed visit
    // still asks for none.
    if (path.endsWith('/tech-rating-allowed')) return { allowed: true, firstVisit: true };
    if (path.endsWith('/tech-tips')) return { available: false };
    if (path.split('?')[0].endsWith('/promises')) return { available: false, promises: [] };
    if (path.split('?')[0].endsWith('/blog-posts')) return { available: false, posts: [] };
    if (path.endsWith('/photos')) return { photos: [] };
    if (path.split('?')[0].endsWith('/treatment-zone')) return trace;
    if (path === '/admin/schedule/generate-report') return { report: REPORT };
    if (path.endsWith('/typed-facts')) return typeof typedFacts === 'function' ? typedFacts() : typedFacts;
    if (path.endsWith('/voice-facts') || path.endsWith('/lane-facts')) throw new Error('a typed visit reads only its own form');
    if (path.endsWith('/complete')) return complete;
    if (path.endsWith('/schedule-followup')) return scheduleFollowup();
    return {};
  });
  request.bodies = (suffix) => calls.filter((call) => call.path.endsWith(suffix)).map((call) => call.body);
  return request;
}

const SERVICE = {
  id: 'svc-roach', customerName: 'Pat Jones', serviceType: 'Cockroach Control', address: '123 Main St', timeLabel: '9:00 AM',
  reportFlow: true, laneFlow: false, laneKey: null, typedFlow: true, typedType: 'cockroach', typedSchema: ROACH_SCHEMA,
  traceEligible: false, lat: 27.4, lng: -82.5, technicianName: 'Adam',
};

async function openSheet(request, service = SERVICE) {
  render(<FastCompleteSheet service={service} request={request} onClose={() => {}} onCompleted={() => {}} />);
  // The first render pays the sheet's cold import; a slow machine gets time.
  await screen.findByRole('button', { name: 'Generate AI report' }, { timeout: 5000 });
}

function addProduct(name, amount) {
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Add a product' })).getByRole('button', { name: new RegExp(`^${name}\\b`) }));
  fireEvent.change(within(screen.getByRole('group', { name })).getByLabelText('How much?'), { target: { value: amount } });
}

async function generate(note = NOTE) {
  fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: note } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
  await screen.findByText('Report the customer will see', {}, { timeout: 5000 });
}

const recordCard = (label = 'Cockroach Treatment') => screen.getByRole('region', { name: `${label} record heard from you` });
// A field's row on the card: its label, its value, the words heard.
const fieldRow = (label, card = recordCard()) => within(card).getByText(label).closest('.tech-lane-row');
const pick = (field, option, card = recordCard()) => {
  fireEvent.click(within(card).getByRole('button', { name: `Change ${field}` }));
  fireEvent.click(within(within(card).getByRole('group', { name: field })).getByRole('button', { name: option }));
};
const sendButton = () => screen.getByRole('button', { name: 'Complete & send' });

describe('the typed record on the sheet', () => {
  test('reads the visit\'s own form from the note with the record\'s present values, shows each field with its words, and writes the report and the completion from it', async () => {
    const request = makeRequest();
    await openSheet(request);
    // Never the pest house mix, and no 1 to 5 rating: the form keeps its own
    // activity.
    expect(screen.getByText('None selected')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Pest activity' })).toBeNull();
    addProduct('Example Roach Gel', '1');
    await generate();
    expect(request.bodies('/typed-facts')).toEqual([{ note: NOTE, current: {}, scoreSet: false }]);
    const written = request.bodies('generate-report')[0];
    expect(written.structuredFindings).toEqual({ type: 'cockroach', values: READ.values });
    expect(written.typedActivityScore).toBeNull();
    expect(written.areasServiced).toEqual(['Kitchen', 'Under sinks']);
    expect(written.pestActivityRating).toBeNull();
    expect(written).not.toHaveProperty('observations');

    expect(within(fieldRow('Species (required)')).getByText('German')).toBeTruthy();
    expect(within(fieldRow('Species (required)')).getByText('“german roaches”')).toBeTruthy();
    expect(within(fieldRow('Areas treated')).getByText('Kitchen, Under sinks')).toBeTruthy();
    expect(within(fieldRow('Areas treated')).getByText('“gel bait in the kitchen” · “under the sinks”')).toBeTruthy();
    // A field filled from the products is never on the card; an optional
    // one the note did not fill waits behind More detail.
    expect(within(recordCard()).queryByText('Work completed')).toBeNull();
    expect(within(recordCard()).queryByText('Activity locations')).toBeNull();
    expect(within(recordCard()).getByRole('button', { name: 'More detail (1)' })).toBeTruthy();
    // No pest facts line, no trace step.
    expect(screen.queryByTestId('fast-complete-heard')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Trace where we sprayed' })).toBeNull();

    fireEvent.click(sendButton());
    await screen.findByTestId('fast-complete-sent');
    const body = request.bodies('/complete')[0];
    expect(body).toMatchObject({
      structuredFindings: { type: 'cockroach', values: READ.values },
      areasServiced: ['Kitchen', 'Under sinks'],
      traceSeen: null,
      technicianNotes: REPORT,
    });
    // A derived score is the server's; the 1 to 5 rating is not asked.
    expect(body).not.toHaveProperty('activityScore');
    expect(body).not.toHaveProperty('clientPestRating');
    expect(body).not.toHaveProperty('structuredObservations');
    expect(body.products).toEqual([expect.objectContaining({ productId: 'gel' })]);
  });

  test('a typed visit needs no product: its work is in its own form', async () => {
    const request = makeRequest({ typedFacts: { ...READ, values: { species: 'German', activity_level: 'Low' } } });
    await openSheet(request);
    await generate('German roaches, low. Inspected and talked with the customer about sanitation.');
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await screen.findByTestId('fast-complete-sent');
    expect(request.bodies('/complete')[0]).toMatchObject({ products: [], areasServiced: [] });
  });

  test('Change is the tech\'s own pick: the report goes stale, the reader is told it is set, and writing it again never overwrites it', async () => {
    const request = makeRequest();
    await openSheet(request);
    await generate();
    pick('Species', 'American');
    // A pick closes the choices.
    expect(within(recordCard()).queryByRole('group', { name: 'Species' })).toBeNull();
    expect(within(fieldRow('Species (required)')).getByText('American')).toBeTruthy();
    // The words heard were for another value.
    expect(within(fieldRow('Species (required)')).queryByText('“german roaches”')).toBeNull();
    expect(screen.getByText(/You changed the visit after this report was written/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete & send' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(request.bodies('generate-report')).toHaveLength(2));
    // The pick goes to the reader as present; the answer naming German
    // again never writes over it.
    expect(request.bodies('/typed-facts')[1].current).toEqual({ ...READ.values, species: 'American' });
    expect(request.bodies('generate-report')[1].structuredFindings.values).toEqual({ ...READ.values, species: 'American' });
    expect(within(fieldRow('Species (required)')).getByText('American')).toBeTruthy();
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await screen.findByTestId('fast-complete-sent');
    expect(request.bodies('/complete')[0].structuredFindings.values.species).toBe('American');
  });

  test('a pick drops the words a fill stood on, even when the filled value is picked again', async () => {
    const request = makeRequest();
    await openSheet(request);
    await generate();
    pick('Species', 'American');
    pick('Species', 'German');
    expect(within(fieldRow('Species (required)')).getByText('German')).toBeTruthy();
    expect(within(fieldRow('Species (required)')).queryByText('“german roaches”')).toBeNull();
    // A field nobody touched keeps its words.
    expect(within(fieldRow('Activity level (required)')).getByText('“heavy behind the fridge”')).toBeTruthy();
  });

  test('a required field the note left unclear asks to be picked and holds the send until it is', async () => {
    const values = { species: 'German', areas_treated: 'Kitchen' };
    const request = makeRequest({ typedFacts: { ...READ, values, unclearFields: ['activity_level'] } });
    await openSheet(request);
    addProduct('Example Roach Gel', '1');
    await generate();
    expect(within(fieldRow('Activity level (required)')).getByText('Not clear from your note. Pick one.')).toBeTruthy();
    expect(screen.getByText('Pick Activity level: tap Change beside it.')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    pick('Activity level', 'Moderate');
    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(request.bodies('generate-report')).toHaveLength(2));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    // One place goes on the product as its application area.
    fireEvent.click(sendButton());
    await screen.findByTestId('fast-complete-sent');
    expect(request.bodies('/complete')[0].products[0]).toMatchObject({ applicationArea: 'Kitchen' });
  });

  test('a read that failed fills nothing and says so; the report is still written and the tech picks each field', async () => {
    const request = makeRequest({ typedFacts: () => { throw new Error('offline'); } });
    await openSheet(request);
    await generate();
    expect(within(recordCard()).getByText('Couldn’t read your note for this just now. Pick each one, or write the report again.')).toBeTruthy();
    expect(within(fieldRow('Species (required)')).getByText('Not picked')).toBeTruthy();
    expect(request.bodies('generate-report')[0].structuredFindings).toEqual({ type: 'cockroach', values: {} });
    expect(screen.getByText('Pick Species: tap Change beside it.')).toBeTruthy();
  });

  test('a record that already holds every field the note could fill is not read again, and nothing says a read failed', async () => {
    let reads = 0;
    const request = makeRequest({
      typedFacts: () => {
        reads += 1;
        return reads === 1 ? READ : { available: true, status: 'nothing_to_fill', type: 'cockroach', values: {}, heard: {}, unclearFields: [] };
      },
    });
    await openSheet(request);
    await generate();
    pick('Species', 'American');
    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(request.bodies('generate-report')).toHaveLength(2));
    expect(within(recordCard()).queryByText('Couldn’t read your note for this just now. Pick each one, or write the report again.')).toBeNull();
    expect(request.bodies('generate-report')[1].structuredFindings.values).toEqual({ ...READ.values, species: 'American' });
  });

  test('an answer for another form fills nothing', async () => {
    const request = makeRequest({ typedFacts: { ...READ, type: 'flea' } });
    await openSheet(request);
    await generate();
    expect(request.bodies('generate-report')[0].structuredFindings.values).toEqual({});
  });
});

describe('what holds a typed visit\'s send', () => {
  test('nothing found keeps the report\'s standard wording, which only the Full form sends', async () => {
    const request = makeRequest({ typedFacts: { ...READ, values: { species: 'German', activity_level: 'None observed' } } });
    await openSheet(request);
    await generate('German roach follow-up, none observed.');
    expect(screen.getByText('Nothing was found on this record, so the customer’s report uses its standard wording, not this one. Use the Full form.')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
  });

  test('a product with no place on the form\'s own area field: pick where you treated', async () => {
    const request = makeRequest({ typedFacts: { ...READ, values: { species: 'German', activity_level: 'Heavy' } } });
    await openSheet(request);
    addProduct('Example Roach Gel', '1');
    await generate();
    expect(screen.getByText('Pick where you treated: tap Change beside Areas treated.')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    pick('Areas treated', 'Kitchen');
    // Areas take several: the list stays open.
    expect(within(recordCard()).getByRole('group', { name: 'Areas treated' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(request.bodies('generate-report')).toHaveLength(2));
    expect(request.bodies('generate-report')[1].areasServiced).toEqual(['Kitchen']);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
  });

  test('a product on a form whose places only the Full form picks (a pest inspection): the Full form', async () => {
    const schema = {
      type: 'pest_inspection',
      label: 'Pest Inspection',
      fields: [
        { key: 'severity', label: 'Severity', type: 'select', required: true, options: ['None observed', 'Low', 'Moderate', 'Heavy', 'Severe'] },
        { key: 'areas_inspected', label: 'Areas inspected', type: 'chips', detail: true, options: ['Exterior perimeter', 'Garage'] },
      ],
      activity: null,
    };
    const request = makeRequest({
      visit: { ...VISIT, serviceType: 'Pest Inspection', serviceKey: 'pest_inspection' },
      typedType: 'pest_inspection',
      typedFacts: { available: true, status: 'read', type: 'pest_inspection', values: { severity: 'Low' }, heard: {}, unclearFields: [] },
    });
    await openSheet(request, { ...SERVICE, serviceType: 'Pest Inspection', typedType: 'pest_inspection', typedSchema: schema });
    addProduct('Example Roach Gel', '1');
    await generate('Low activity at the garage. Spot treated.');
    expect(screen.getByText('Where you applied the product is picked on the Full form. Use the Full form.')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
  });

  test('a saved trace the customer\'s report would show: remove it or use the Full form', async () => {
    const request = makeRequest({
      trace: { enabled: true, treatmentZone: { linear_ft: 120, capture_mode: 'perimeter', updated_at: '2026-10-02T14:00:00Z' } },
      traceOnReport: true,
    });
    await openSheet(request);
    await generate();
    expect(await screen.findByText('This visit has a saved trace the customer’s report would show, and this sheet doesn’t check it. Remove the trace, or use the Full form.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove the trace' })).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
  });

  test('a saved trace the report would not show holds nothing', async () => {
    const request = makeRequest({
      trace: { enabled: true, treatmentZone: { linear_ft: 120, capture_mode: 'perimeter', updated_at: '2026-10-02T14:00:00Z' } },
      traceOnReport: false,
    });
    await openSheet(request);
    await generate();
    await waitFor(() => expect(sendButton().disabled).toBe(false));
  });
});

describe('a form whose activity score the tech sets (rodent inspection)', () => {
  const RODENT_SCHEMA = {
    type: 'rodent_inspection',
    label: 'Rodent Inspection',
    fields: [
      { key: 'areas_inspected', label: 'Areas inspected', type: 'chips', required: true, options: ['Exterior perimeter', 'Attic interior', 'Garage'] },
      { key: 'activity_found', label: 'Activity found', type: 'select', required: true, options: ['Yes', 'No'] },
      { key: 'evidence_observed', label: 'Evidence observed', type: 'chips', detail: true, requiredUnless: { field: 'activity_found', value: 'No' }, options: ['Droppings', 'Gnaw marks'] },
      { key: 'recommended_service', label: 'Recommended service', type: 'select', required: true, options: ['Rodent trapping program', 'Exclusion repairs'] },
      { key: 'urgency', label: 'Urgency', type: 'select', required: true, options: ['Routine', 'Soon', 'High'] },
    ],
    activity: { label: 'Rodent Activity', deriveField: null, techScoreLabels: TECH_SCORE_LABELS },
  };
  const RODENT_READ = {
    available: true,
    status: 'read',
    type: 'rodent_inspection',
    values: { areas_inspected: 'Attic interior', activity_found: 'Yes', recommended_service: 'Rodent trapping program', urgency: 'Soon' },
    heard: {},
    unclearFields: [],
  };
  const open = async (request) => openSheet(request, {
    ...SERVICE, serviceType: 'Rodent Inspection', typedType: 'rodent_inspection', typedSchema: RODENT_SCHEMA,
  });
  const card = () => recordCard('Rodent Inspection');

  test('a field the findings now require shows on the card and holds the send; the score is picked and sent as the technician\'s', async () => {
    const request = makeRequest({
      visit: { ...VISIT, serviceType: 'Rodent Inspection', serviceKey: 'rodent_inspection' }, typedType: 'rodent_inspection', typedFacts: RODENT_READ,
    });
    await open(request);
    await generate('Droppings in the attic, recommend trapping soon.');
    // Activity found makes the evidence required, so it leaves the drawer.
    expect(within(fieldRow('Evidence observed (required)', card())).getByText('Not said')).toBeTruthy();
    expect(screen.getByText('Pick Evidence observed: tap Change beside it.')).toBeTruthy();
    pick('Evidence observed', 'Droppings', card());
    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(request.bodies('generate-report')).toHaveLength(2));
    // The score is the tech's: no read gives it.
    expect(await screen.findByText('Pick the rodent activity score, 0 to 5.')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(within(within(card()).getByRole('group', { name: 'Rodent Activity' })).getByRole('button', { name: '3 Moderate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(request.bodies('generate-report')).toHaveLength(3));
    expect(request.bodies('generate-report')[2]).toMatchObject({
      structuredFindings: { type: 'rodent_inspection', values: { ...RODENT_READ.values, evidence_observed: 'Droppings' } },
      typedActivityScore: 3,
    });
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await screen.findByTestId('fast-complete-sent');
    expect(request.bodies('/complete')[0]).toMatchObject({ activityScore: 3, activityScoreSource: 'technician' });
  });
});

describe('the visit the tech tapped', () => {
  test('a visit that no longer reads as the form it was routed as needs the full form', async () => {
    const request = makeRequest({ typedType: null });
    render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} onCompleted={() => {}} />);
    expect(await screen.findByText('This visit needs the full form.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate AI report' })).toBeNull();
  });
});

describe('a typed inspection\'s credit (step 3: inspections)', () => {
  const INSPECTION_SCHEMA = {
    type: 'pest_inspection',
    label: 'Pest Inspection',
    fields: [{ key: 'severity', label: 'Severity', type: 'select', required: true, options: ['None observed', 'Low', 'Moderate', 'Heavy', 'Severe'] }],
    activity: null,
  };
  const inspectionRequest = () => makeRequest({
    visit: { ...VISIT, serviceType: 'Pest Inspection', serviceKey: 'pest_inspection' },
    typedType: 'pest_inspection',
    typedFacts: { available: true, status: 'read', type: 'pest_inspection', values: { severity: 'Moderate' }, heard: {}, unclearFields: [] },
  });
  const INSPECTION = { ...SERVICE, serviceType: 'Pest Inspection', typedType: 'pest_inspection', typedSchema: INSPECTION_SCHEMA, inspectionCredit: true };
  const creditButton = () => within(screen.getByRole('region', { name: 'Inspection credit' })).getByRole('button', { name: 'Credit this inspection toward booked service' });

  test('is on unless the tech turns it off, and the completion says which', async () => {
    const request = inspectionRequest();
    await openSheet(request, INSPECTION);
    await generate('Moderate ghost ant activity in the kitchen.');
    expect(creditButton().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(creditButton());
    expect(creditButton().getAttribute('aria-pressed')).toBe('false');
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await screen.findByTestId('fast-complete-sent');
    expect(request.bodies('/complete')[0]).toMatchObject({ offerInspectionCredit: false });
  });

  test('left on, it is offered', async () => {
    const request = inspectionRequest();
    await openSheet(request, INSPECTION);
    await generate('Moderate ghost ant activity in the kitchen.');
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await screen.findByTestId('fast-complete-sent');
    expect(request.bodies('/complete')[0]).toMatchObject({ offerInspectionCredit: true });
  });

  test('a visit that offers no credit shows no toggle and sends no choice', async () => {
    const request = makeRequest();
    await openSheet(request);
    await generate();
    expect(screen.queryByRole('region', { name: 'Inspection credit' })).toBeNull();
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await screen.findByTestId('fast-complete-sent');
    expect(request.bodies('/complete')[0]).not.toHaveProperty('offerInspectionCredit');
  });
});

describe('after sending: the follow-up a completion suggests (step 3)', () => {
  const SUGGESTED = { success: true, followupSuggestion: { required: true, suggestedDate: '2026-10-15', days: 14 } };
  const sendIt = async (request) => {
    await openSheet(request);
    await generate();
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await screen.findByTestId('fast-complete-sent');
  };

  test('one tap books it on the suggested day, pending until the office confirms it', async () => {
    const request = makeRequest({ complete: SUGGESTED, followupBooking: true });
    await sendIt(request);
    expect(screen.getByText('Follow-up suggested: Thursday, October 15 (14 days)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Book the follow-up' }));
    expect(await screen.findByText('Follow-up booked for Thursday, October 15. It stays pending until the office confirms it.')).toBeTruthy();
    expect(request.bodies('/schedule-followup')).toEqual([{ date: '2026-10-15' }]);
    expect(screen.queryByRole('button', { name: 'Book the follow-up' })).toBeNull();
  });

  test('one already on the books says so', async () => {
    const request = makeRequest({
      complete: SUGGESTED, followupBooking: true, scheduleFollowup: () => ({ alreadyScheduled: true, appointment: { scheduledDate: '2026-10-16' } }),
    });
    await sendIt(request);
    fireEvent.click(screen.getByRole('button', { name: 'Book the follow-up' }));
    expect(await screen.findByText('A follow-up is already on the books for Friday, October 16.')).toBeTruthy();
  });

  test('a booking that fails says so and can be tried again', async () => {
    const request = makeRequest({ complete: SUGGESTED, followupBooking: true, scheduleFollowup: () => { throw new Error('Could not book.'); } });
    await sendIt(request);
    fireEvent.click(screen.getByRole('button', { name: 'Book the follow-up' }));
    expect(await screen.findByText('Could not book. Try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Book the follow-up' })).toBeTruthy();
  });

  test.each([
    ['the switch off (GATE_TYPED_VOICE_FILL)', { complete: SUGGESTED, followupBooking: false }],
    ['an older server that says nothing', { complete: SUGGESTED }],
    ['no follow-up suggested', { complete: { success: true, followupSuggestion: { required: false } }, followupBooking: true }],
  ])('%s: no booking', async (_label, options) => {
    const request = makeRequest(options);
    await sendIt(request);
    expect(screen.queryByTestId('fast-complete-followup')).toBeNull();
  });
});

describe('counts and the technician\'s rating (step 4)', () => {
  const TRAP_SCHEMA = {
    type: 'rodent_trapping',
    label: 'Rodent Trapping',
    fields: [
      { key: 'species', label: 'Species', type: 'select', required: true, options: ['Roof rat', 'Norway rat', 'House mouse', 'Mixed', 'Unknown'] },
      { key: 'trap_visit_type', label: 'This visit', type: 'select', required: true, internal: true, options: ['Initial setup', 'Follow-up check'] },
      { key: 'traps_checked', label: 'Traps checked', type: 'count' },
      { key: 'captures', label: 'Captures', type: 'count' },
      { key: 'trap_actions', label: 'Trap actions', type: 'chips', detail: true, options: ['Traps reset', 'Traps moved', 'Bait/lure refreshed'] },
    ],
    activity: { label: 'Rodent Activity', deriveField: null, techScoreLabels: TECH_SCORE_LABELS },
  };
  const TRAP_READ = {
    available: true,
    status: 'read',
    type: 'rodent_trapping',
    values: { species: 'Roof rat', trap_visit_type: 'Follow-up check', traps_checked: '8', captures: '2' },
    heard: {
      species: [{ value: 'Roof rat', quote: 'the roof rats' }],
      trap_visit_type: [{ value: 'Follow-up check', quote: 'follow-up check on the roof rats' }],
      traps_checked: [{ value: '8', quote: 'checked all 8 traps' }],
      captures: [{ value: '2', quote: '2 caught by the ac chase' }],
    },
    unclearFields: [],
    score: { value: 2, quote: "i'd call it a 2" },
  };
  const trapRequest = (typedFacts = TRAP_READ, extra = {}) => makeRequest({
    visit: { ...VISIT, serviceType: 'Rodent Trapping Follow-up', serviceKey: 'rodent_trapping' }, typedType: 'rodent_trapping', typedFacts, ...extra,
  });
  const TRAPS = { ...SERVICE, serviceType: 'Rodent Trapping Follow-up', typedType: 'rodent_trapping', typedSchema: TRAP_SCHEMA };
  const TRAP_NOTE = 'Follow-up check on the roof rats. Checked all 8 traps in the attic, 2 caught by the AC chase. I\'d call it a 2.';
  const trapCard = () => recordCard('Rodent Trapping');
  const scoreButton = (label) => within(within(trapCard()).getByRole('group', { name: 'Rodent Activity' })).getByRole('button', { name: label });

  test('a rodent trap check: the counts and the technician\'s rating fill from the note, each with its words, and go on the completion as theirs', async () => {
    const request = trapRequest();
    await openSheet(request, TRAPS);
    await generate(TRAP_NOTE);
    expect(request.bodies('/typed-facts')).toEqual([{ note: TRAP_NOTE, current: {}, scoreSet: false }]);
    expect(within(trapCard()).getByLabelText('Traps checked').value).toBe('8');
    expect(within(trapCard()).getByText('“checked all 8 traps”')).toBeTruthy();
    expect(scoreButton('2 Low').getAttribute('aria-pressed')).toBe('true');
    expect(within(trapCard()).getByText('“i\'d call it a 2”')).toBeTruthy();
    expect(request.bodies('generate-report')[0].typedActivityScore).toBe(2);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await screen.findByTestId('fast-complete-sent');
    expect(request.bodies('/complete')[0]).toMatchObject({
      structuredFindings: { type: 'rodent_trapping', values: TRAP_READ.values },
      activityScore: 2,
      activityScoreSource: 'technician',
    });
  });

  test('a rating picked by hand is the tech\'s: its words go, the reader is told it is set, and it is never filled over', async () => {
    const request = trapRequest();
    await openSheet(request, TRAPS);
    await generate(TRAP_NOTE);
    fireEvent.click(scoreButton('4 High'));
    expect(within(trapCard()).queryByText('“i\'d call it a 2”')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(request.bodies('generate-report')).toHaveLength(2));
    expect(request.bodies('/typed-facts')[1].scoreSet).toBe(true);
    expect(scoreButton('4 High').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(scoreButton('2 Low'));
    expect(within(trapCard()).queryByText('“i\'d call it a 2”')).toBeNull();
  });

  test('two values heard in the same words show those words once', async () => {
    const request = trapRequest({
      ...TRAP_READ,
      values: { ...TRAP_READ.values, trap_actions: 'Traps reset, Bait/lure refreshed' },
      heard: {
        ...TRAP_READ.heard,
        trap_actions: [{ value: 'Traps reset', quote: 'reset and re-baited all of them' }, { value: 'Bait/lure refreshed', quote: 'reset and re-baited all of them' }],
      },
    });
    await openSheet(request, TRAPS);
    await generate(TRAP_NOTE);
    expect(within(fieldRow('Trap actions', trapCard())).getByText('“reset and re-baited all of them”')).toBeTruthy();
  });

  test('a count the note left unclear asks for the number', async () => {
    const request = trapRequest({ ...TRAP_READ, values: { species: 'Roof rat', trap_visit_type: 'Follow-up check' }, unclearFields: ['traps_checked'] });
    await openSheet(request, TRAPS);
    await generate(TRAP_NOTE);
    expect(within(trapCard()).getByText('Not clear from your note. Enter the number.')).toBeTruthy();
  });

  test('an initial setup holds the send until its trap count is set, the count named as the traps set', async () => {
    const request = trapRequest({
      ...TRAP_READ, values: { species: 'Roof rat', trap_visit_type: 'Initial setup' }, heard: {}, score: { value: 2, quote: "i'd call it a 2" },
    });
    await openSheet(request, TRAPS);
    await generate('Initial setup for the roof rats. I\'d call it a 2.');
    expect(screen.getByText('An initial setup must record how many traps were set — enter the count as a whole number, or set this visit to "Follow-up check"')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(within(trapCard()).getByLabelText('Traps set'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(request.bodies('generate-report')).toHaveLength(2));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
  });

  test('a bait station visit whose consumption says nothing was found keeps the standard wording, which only the Full form sends', async () => {
    const schema = {
      type: 'rodent_bait_station',
      label: 'Rodent Bait Station Check',
      fields: [
        { key: 'stations_checked', label: 'Stations checked', type: 'count', required: true },
        { key: 'bait_consumption', label: 'Bait consumption', type: 'select', required: true, options: ['None', 'Light', 'Moderate', 'Heavy', 'Empty'] },
      ],
      activity: { label: 'Bait Station Activity', deriveField: 'bait_consumption', deriveScores: { None: 0, Light: 2, Moderate: 3, Heavy: 4, Empty: 5 } },
    };
    const request = makeRequest({
      visit: { ...VISIT, serviceType: 'Rodent Bait Stations', serviceKey: 'rodent_bait_quarterly' },
      typedType: 'rodent_bait_station',
      typedFacts: { available: true, status: 'read', type: 'rodent_bait_station', values: { stations_checked: '12', bait_consumption: 'None' }, heard: {}, unclearFields: [] },
    });
    await openSheet(request, { ...SERVICE, serviceType: 'Rodent Bait Stations', typedType: 'rodent_bait_station', typedSchema: schema });
    await generate('Checked all 12 stations, no bait taken.');
    expect(screen.getByText('Nothing was found on this record, so the customer’s report uses its standard wording, not this one. Use the Full form.')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
  });

  describe('a termite bait station visit\'s places', () => {
    const schema = {
      type: 'termite_bait_station',
      label: 'Termite Bait Station Inspection',
      fields: [
        { key: 'stations_checked', label: 'Stations checked', type: 'count', required: true },
        { key: 'termite_activity', label: 'Termite activity', type: 'select', required: true, options: ['None observed', 'Active termites present', 'Previous feeding noted'] },
        { key: 'bait_consumption', label: 'Bait consumption', type: 'select', required: true, options: ['None — bait intact', 'Light feeding', 'Moderate feeding', 'Heavy feeding'] },
      ],
      activity: { label: 'Termite Activity', deriveField: 'termite_activity', deriveScores: { 'None observed': 0, 'Previous feeding noted': 1, 'Active termites present': 4 } },
    };
    const termiteRequest = () => makeRequest({
      visit: { ...VISIT, serviceType: 'Termite Monitoring', serviceKey: 'termite_monitoring' },
      typedType: 'termite_bait_station',
      typedFacts: {
        available: true, status: 'read', type: 'termite_bait_station', heard: {}, unclearFields: [],
        values: { stations_checked: '14', termite_activity: 'Previous feeding noted', bait_consumption: 'Light feeding' },
      },
    });
    const TERMITE = { ...SERVICE, serviceType: 'Termite Monitoring', typedType: 'termite_bait_station', typedSchema: schema };

    test('bait placed in the stations needs no place', async () => {
      const request = termiteRequest();
      await openSheet(request, TERMITE);
      addProduct('Example Roach Gel', '1');
      await generate('Checked all 14 stations, light feeding, previous feeding noted.');
      await waitFor(() => expect(sendButton().disabled).toBe(false));
    });

    test('a product sprayed as well: where it went is picked on the Full form', async () => {
      const request = termiteRequest();
      await openSheet(request, TERMITE);
      addProduct('Taurus SC', '1');
      await generate('Checked all 14 stations, light feeding, previous feeding noted. Spot treated the garage.');
      expect(screen.getByText('Where you applied the product is picked on the Full form. Use the Full form.')).toBeTruthy();
      expect(sendButton().disabled).toBe(true);
    });
  });
});

// @vitest-environment jsdom
// Bait station visits on the one-screen Fast Complete sheet with the station
// map on (GATE_STATION_FAST_COMPLETE, owner 2026-10-08): the sheet loads the
// property's station registry (GET /admin/dispatch/:id/property-map), shows
// "N stations, all OK", the note names exceptions by station number (read by
// POST /admin/dispatch/:id/typed-facts when the request carries the stations),
// each exception is a chip the tech taps to correct, and the completion posts
// `termiteStations` and the typed station counts exactly as the full form does
// (client/src/lib/station-checks.js is the one copy of the count rule).
// Adding, moving or retiring a station, a station with no pin and a registry
// that failed to load stay on the full form.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('./TechTreatmentZoneModal', () => ({ default: () => <div role="dialog" aria-label="Tracer" /> }));
vi.mock('./TechServicePhotosModal', () => ({ default: () => <div role="dialog" aria-label="Photo manager" /> }));

import FastCompleteSheet from './FastCompleteSheet';
import { stationAutoCounts, stationCheckEntry } from '../../lib/station-checks';

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const TERMITE_SCHEMA = {
  type: 'termite_bait_station',
  label: 'Termite Bait Station Inspection',
  fields: [
    { key: 'total_stations', label: 'Total stations on property', type: 'count', detail: true },
    { key: 'stations_checked', label: 'Stations checked', type: 'count', required: true },
    { key: 'stations_inaccessible', label: 'Stations inaccessible', type: 'count', detail: true },
    { key: 'stations_with_activity', label: 'Stations with termite activity', type: 'count' },
    { key: 'termite_activity', label: 'Termite activity', type: 'select', required: true, options: ['None observed', 'Active termites present', 'Previous feeding noted'] },
    { key: 'bait_consumption', label: 'Bait consumption', type: 'select', required: true, options: ['None — bait intact', 'Light feeding', 'Moderate feeding', 'Heavy feeding'] },
  ],
  activity: { label: 'Termite Activity', deriveField: 'termite_activity', deriveScores: { 'None observed': 0, 'Previous feeding noted': 1, 'Active termites present': 4 } },
};
const RODENT_SCHEMA = {
  type: 'rodent_bait_station',
  label: 'Rodent Bait Station Check',
  fields: [
    { key: 'stations_checked', label: 'Stations checked', type: 'count', required: true },
    { key: 'stations_inaccessible', label: 'Stations inaccessible', type: 'count', detail: true },
    { key: 'bait_consumption', label: 'Bait consumption level', type: 'select', required: true, options: ['None', 'Light', 'Moderate', 'Heavy', 'Empty'] },
  ],
  activity: { label: 'Bait Station Activity', deriveField: 'bait_consumption', deriveScores: { None: 0, Light: 2, Moderate: 3, Heavy: 4, Empty: 5 } },
};
const VISIT = {
  id: 'svc-station', customerName: 'Pat Jones', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-station',
  serviceType: 'Termite Monitoring', scheduledDate: '2026-10-08', address: { line1: '123 Main St' },
  serviceKey: 'termite_monitoring', status: 'confirmed',
};
const circle = { type: 'circle', cx: 0.4, cy: 0.5, r: 0.03 };
const station = (n, program = 'termite', extra = {}) => ({ id: `st-${program}-${n}`, number: n, program, label: null, geometryImage: circle, staleMark: false, ...extra });
const TERMITE_REGISTRY = { available: true, stationsLoaded: true, stations: [station(1), station(2), station(3), station(4)] };
const NOTE = 'Station 2 had activity. I replaced the bait in 3.';
const TERMITE_READ = {
  available: true, status: 'read', type: 'termite_bait_station', heard: {}, unclearFields: [],
  values: { termite_activity: 'Previous feeding noted', bait_consumption: 'Light feeding' },
  stationRead: 'read',
  stationExceptions: [
    { id: 'st-termite-2', number: 2, status: 'activity', quote: 'station 2 had activity' },
    { id: 'st-termite-3', number: 3, status: 'serviced', quote: 'i replaced the bait in 3' },
  ],
};
const REPORT = 'WHAT WE FOUND\nSome activity at one station.\n\nWHAT WE DID AND WHY\nWe replaced bait.';

function makeRequest({
  visit = VISIT, typedType = 'termite_bait_station', typedFacts = TERMITE_READ, registry = TERMITE_REGISTRY, complete = { success: true },
} = {}) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options, body: options?.body ? JSON.parse(options.body) : null });
    if (path.split('?')[0].endsWith('/pest-recap/context')) return { ok: true, eligible: false, lane: null, typedType, service: visit, products: [] };
    if (path.endsWith('/tech-rating-allowed')) return { allowed: true, firstVisit: true };
    if (path.endsWith('/tech-tips')) return { available: false };
    if (path.split('?')[0].endsWith('/promises')) return { available: false, promises: [] };
    if (path.split('?')[0].endsWith('/blog-posts')) return { available: false, posts: [] };
    if (path.endsWith('/photos')) return { photos: [] };
    if (path.split('?')[0].endsWith('/treatment-zone')) return { enabled: true, treatmentZone: null };
    if (path.endsWith('/property-map')) {
      if (registry instanceof Error) throw registry;
      return registry;
    }
    if (path === '/admin/schedule/generate-report') return { report: REPORT };
    if (path.endsWith('/typed-facts')) return typedFacts;
    if (path.endsWith('/voice-facts') || path.endsWith('/lane-facts')) throw new Error('a typed visit reads only its own form');
    if (path.endsWith('/complete')) return complete;
    return {};
  });
  request.bodies = (suffix) => calls.filter((call) => call.path.endsWith(suffix)).map((call) => call.body);
  request.paths = () => calls.map((call) => call.path);
  return request;
}

const TERMITE = {
  id: 'svc-station', customerName: 'Pat Jones', serviceType: 'Termite Monitoring', address: '123 Main St', timeLabel: '9:00 AM',
  reportFlow: true, laneFlow: false, laneKey: null, typedFlow: true, typedType: 'termite_bait_station', typedSchema: TERMITE_SCHEMA,
  stationsFlow: true, traceEligible: false, lat: 27.4, lng: -82.5, technicianName: 'Adam',
};
const RODENT = { ...TERMITE, serviceType: 'Rodent Bait Stations', typedType: 'rodent_bait_station', typedSchema: RODENT_SCHEMA };

async function openSheet(request, service = TERMITE) {
  render(<FastCompleteSheet service={service} request={request} onClose={() => {}} onCompleted={() => {}} />);
  await screen.findByRole('button', { name: 'Generate AI report' }, { timeout: 10000 });
}

async function generate(note = NOTE) {
  fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: note } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false), { timeout: 10000 });
  fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
  await screen.findByText('Report the customer will see', {}, { timeout: 10000 });
}

const stationsCard = () => screen.getByRole('region', { name: 'Bait stations' });
const sendButton = () => screen.getByRole('button', { name: 'Complete & send' });
const send = async (request) => {
  await waitFor(() => expect(sendButton().disabled).toBe(false));
  fireEvent.click(sendButton());
  await screen.findByTestId('fast-complete-sent');
  return request.bodies('/complete')[0];
};

// What the full form would send for the same statuses, built from the shared
// rule and entry helper.
const fullFormBody = (stations, statuses, program) => ({
  termiteStations: stations.map((s) => stationCheckEntry(s.id, statuses)),
  counts: stationAutoCounts({ program, activeKeys: stations.map((s) => s.id), statuses }),
});

describe('a termite bait station visit with the station map on', () => {
  test('all OK: "N stations, all OK", and the completion posts a check for every station and the counts the full form writes', async () => {
    const request = makeRequest({ typedFacts: { ...TERMITE_READ, stationExceptions: [] } });
    await openSheet(request);
    await generate('Checked every station. Light feeding, previous feeding noted.');
    expect(within(stationsCard()).getByText('4 stations, all OK')).toBeTruthy();
    // The count fields the stations fill are not asked for.
    expect(screen.queryByText('Stations checked (required)')).toBeNull();
    const body = await send(request);
    const expected = fullFormBody(TERMITE_REGISTRY.stations.map((s) => ({ id: s.id })), {}, 'termite');
    expect(body.termiteStations).toEqual(expected.termiteStations);
    expect(body.termiteStations.every((entry) => entry.status === 'ok' && !('touched' in entry))).toBe(true);
    expect(body.structuredFindings.values).toMatchObject(expected.counts);
    expect(expected.counts).toEqual({ total_stations: '4', stations_checked: '4', stations_inaccessible: '0', stations_with_activity: '0' });
    expect(body.visitOutcome).toBe('completed');
  }, 20000);

  test('the note names exceptions by station number: a chip each, with its words, sent as the full form sends them', async () => {
    const request = makeRequest();
    await openSheet(request);
    await generate();
    // The read carried the stations the sheet shows.
    expect(request.bodies('/typed-facts')[0].stations).toEqual(TERMITE_REGISTRY.stations.map((s) => ({ id: s.id, number: s.number })));
    const card = stationsCard();
    expect(within(card).getByText('4 stations, 2 flagged, the rest OK')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Station 2: Activity' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Station 3: Serviced' })).toBeTruthy();
    expect(within(card).getByText('Station 2: “station 2 had activity”')).toBeTruthy();
    const body = await send(request);
    const statuses = { 'st-termite-2': 'activity', 'st-termite-3': 'serviced' };
    const expected = fullFormBody(TERMITE_REGISTRY.stations.map((s) => ({ id: s.id })), statuses, 'termite');
    expect(body.termiteStations).toEqual(expected.termiteStations);
    expect(body.termiteStations.filter((entry) => entry.touched).map((entry) => entry.id)).toEqual(['st-termite-2', 'st-termite-3']);
    expect(body.structuredFindings.values).toMatchObject(expected.counts);
    expect(expected.counts.stations_with_activity).toBe('1');
  }, 20000);

  test('a tap on a chip changes the status that is sent; past "No access" it goes back to OK', async () => {
    const request = makeRequest();
    await openSheet(request);
    await generate();
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Station 2: Activity' }));
    expect(within(stationsCard()).getByRole('button', { name: 'Station 2: Serviced' })).toBeTruthy();
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Station 3: Serviced' }));
    expect(within(stationsCard()).getByRole('button', { name: 'Station 3: No access' })).toBeTruthy();
    // The count fields follow the taps, so the report is out of date.
    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(request.bodies('generate-report')).toHaveLength(2));
    // A second read never writes over what the tech tapped.
    expect(within(stationsCard()).getByRole('button', { name: 'Station 2: Serviced' })).toBeTruthy();
    expect(within(stationsCard()).getByRole('button', { name: 'Station 3: No access' })).toBeTruthy();
    const body = await send(request);
    const statuses = { 'st-termite-2': 'serviced', 'st-termite-3': 'inaccessible' };
    const expected = fullFormBody(TERMITE_REGISTRY.stations.map((s) => ({ id: s.id })), statuses, 'termite');
    expect(body.termiteStations).toEqual(expected.termiteStations);
    expect(body.structuredFindings.values).toMatchObject({ ...expected.counts, stations_with_activity: '0', stations_inaccessible: '1', stations_checked: '3' });
  }, 30000);

  test('a station the note did not name is flagged with a tap; a chip tapped round to OK leaves the station unmarked', async () => {
    const request = makeRequest({ typedFacts: { ...TERMITE_READ, stationExceptions: [] } });
    await openSheet(request);
    await generate('Checked every station. Light feeding, previous feeding noted.');
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Flag a station' }));
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Station 4' }));
    expect(within(stationsCard()).getByRole('button', { name: 'Station 4: Activity' })).toBeTruthy();
    for (let i = 0; i < 3; i += 1) fireEvent.click(within(stationsCard()).getByRole('button', { name: /^Station 4:/ }));
    expect(within(stationsCard()).queryByRole('button', { name: /^Station 4:/ })).toBeNull();
    expect(within(stationsCard()).getByText('4 stations, all OK')).toBeTruthy();
    // Back where the report was written from, so it is still current.
    const body = await send(request);
    expect(body.termiteStations).toEqual(TERMITE_REGISTRY.stations.map((s) => ({ id: s.id, status: 'ok' })));
  }, 30000);

  test('the sheet adds, moves and retires nothing: only status entries are posted', async () => {
    const request = makeRequest();
    await openSheet(request);
    await generate();
    const body = await send(request);
    for (const entry of body.termiteStations) {
      expect(Object.keys(entry).sort()).toEqual(expect.arrayContaining(['id', 'status']));
      expect(entry).not.toHaveProperty('shape');
      expect(entry).not.toHaveProperty('retire');
    }
  }, 20000);
});

describe('what the sheet hands to the full form', () => {
  const heldWith = async (registry, message, request = makeRequest({ registry })) => {
    await openSheet(request);
    await generate();
    // The card says it, and so does the footer hold.
    expect(screen.getAllByText(message).length).toBeGreaterThan(0);
    expect(sendButton().disabled).toBe(true);
    // The header offers the full form once the sheet says so.
    expect(screen.getByRole('button', { name: /full form/i })).toBeTruthy();
    return request;
  };

  test('a station with no pin (hidden by drift)', async () => {
    const registry = { ...TERMITE_REGISTRY, stations: [station(1), station(2), station(3, 'termite', { geometryImage: null, staleMark: true })] };
    const request = await heldWith(registry, 'Station 3 has no pin on the map. Use the Full form.');
    // No reader call carries a roster it cannot judge.
    expect(request.bodies('/typed-facts')[0]).not.toHaveProperty('stations');
  }, 20000);

  test('a registry that failed to load, or a map that is not available', async () => {
    await heldWith(new Error('network'), 'Couldn’t load this property’s stations. Use the Full form.');
    cleanup();
    await heldWith({ available: true, stationsLoaded: false, stations: [] }, 'Couldn’t load this property’s stations. Use the Full form.');
    cleanup();
    await heldWith({ available: false, reason: 'missing_coordinates' }, 'Couldn’t load this property’s stations. Use the Full form.');
  }, 40000);

  test('a property with no station on record', async () => {
    await heldWith({ available: true, stationsLoaded: true, stations: [] }, 'No stations are on record for this property. Use the Full form.');
  }, 20000);

  test('only the visit\'s own program counts: a rodent station beside a termite visit is not on the sheet', async () => {
    const registry = { ...TERMITE_REGISTRY, stations: [...TERMITE_REGISTRY.stations, station(9, 'rodent')] };
    const request = makeRequest({ registry, typedFacts: { ...TERMITE_READ, stationExceptions: [] } });
    await openSheet(request);
    await generate('Checked every station.');
    expect(within(stationsCard()).getByText('4 stations, all OK')).toBeTruthy();
    expect(request.bodies('/typed-facts')[0].stations).toHaveLength(4);
  }, 20000);
});

describe('a rodent bait station visit', () => {
  const rodentRegistry = { available: true, stationsLoaded: true, stations: [station(1, 'rodent'), station(2, 'rodent'), station(3, 'rodent')] };
  const rodentRead = (values) => ({
    available: true, status: 'read', type: 'rodent_bait_station', heard: {}, unclearFields: [], values,
    stationRead: 'read', stationExceptions: [{ id: 'st-rodent-2', number: 2, status: 'activity', quote: 'bait eaten at station 2' }],
  });
  const rodentVisit = { ...VISIT, serviceType: 'Rodent Bait Stations', serviceKey: 'rodent_bait_quarterly' };

  test('reads Consumption, and sends the rodent counts only', async () => {
    const request = makeRequest({ visit: rodentVisit, typedType: 'rodent_bait_station', registry: rodentRegistry, typedFacts: rodentRead({ bait_consumption: 'Light' }) });
    await openSheet(request, RODENT);
    await generate('Bait eaten at station 2.');
    expect(within(stationsCard()).getByRole('button', { name: 'Station 2: Consumption' })).toBeTruthy();
    const body = await send(request);
    const expected = fullFormBody(rodentRegistry.stations.map((s) => ({ id: s.id })), { 'st-rodent-2': 'activity' }, 'rodent');
    expect(body.termiteStations).toEqual(expected.termiteStations);
    expect(body.structuredFindings.values).toMatchObject(expected.counts);
    expect(body.structuredFindings.values).not.toHaveProperty('total_stations');
    expect(body.structuredFindings.values).not.toHaveProperty('stations_with_activity');
  }, 20000);

  test('a consumption mark beside a bait consumption level of None holds the send, as the completion would refuse it', async () => {
    const request = makeRequest({ visit: rodentVisit, typedType: 'rodent_bait_station', registry: rodentRegistry, typedFacts: rodentRead({ bait_consumption: 'None' }) });
    await openSheet(request, RODENT);
    await generate('Bait eaten at station 2.');
    expect(screen.getByText(/marked with bait consumption this visit, but the Bait consumption level reads "None"/)).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
  }, 20000);
});

describe('gate off is today\'s sheet', () => {
  test('a station visit routed without the station flow loads no stations and posts none', async () => {
    const request = makeRequest({ typedFacts: { ...TERMITE_READ, stationRead: undefined, stationExceptions: undefined, values: { stations_checked: '12', termite_activity: 'Previous feeding noted', bait_consumption: 'Light feeding' } } });
    await openSheet(request, { ...TERMITE, stationsFlow: false });
    await generate('Checked all 12 stations.');
    expect(screen.queryByRole('region', { name: 'Bait stations' })).toBeNull();
    const body = await send(request);
    expect(request.paths().some((path) => path.endsWith('/property-map'))).toBe(false);
    expect(request.bodies('/typed-facts')[0]).not.toHaveProperty('stations');
    expect(body).not.toHaveProperty('termiteStations');
    expect(body.structuredFindings.values.stations_checked).toBe('12');
  }, 20000);
});

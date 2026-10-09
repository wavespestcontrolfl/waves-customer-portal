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
    if (path.endsWith('/typed-facts')) return typeof typedFacts === 'function' ? typedFacts() : typedFacts;
    if (path.endsWith('/voice-facts') || path.endsWith('/lane-facts')) throw new Error('a typed visit reads only its own form');
    if (path.endsWith('/complete')) return typeof complete === 'function' ? complete() : complete;
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
  // Generate is held too, so the first report is never written without the
  // station read; the footer says why and the header offers the Full form.
  const heldWith = async (registry, message, request = makeRequest({ registry })) => {
    await openSheet(request);
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
    await waitFor(() => expect(screen.getAllByText(message).length).toBeGreaterThan(0), { timeout: 10000 });
    expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: /full form/i })).toBeTruthy();
    expect(request.bodies('/typed-facts')).toEqual([]);
    expect(request.bodies('generate-report')).toEqual([]);
    return request;
  };

  test('a station with no pin (hidden by drift)', async () => {
    const registry = { ...TERMITE_REGISTRY, stations: [station(1), station(2), station(3, 'termite', { geometryImage: null, staleMark: true })] };
    await heldWith(registry, 'Station 3 has no pin on the map. Use the Full form.');
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

describe('the report is written from the tech\'s station statuses', () => {
  test('Generate waits for the stations to load: the first report is never written without the station read', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const request = makeRequest();
    const inner = request.getMockImplementation();
    request.mockImplementation(async (path, options) => {
      if (path.endsWith('/property-map')) await gate;
      return inner(path, options);
    });
    render(<FastCompleteSheet service={TERMITE} request={request} onClose={() => {}} onCompleted={() => {}} />);
    await screen.findByLabelText('Tell me about the visit', {}, { timeout: 10000 });
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
    await waitFor(() => expect(screen.getAllByText('Loading the stations…').length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(true);
    release();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false), { timeout: 10000 });
    fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
    await screen.findByText('Report the customer will see', {}, { timeout: 10000 });
    // The first read carried the stations, and the writer was told their statuses.
    expect(request.bodies('/typed-facts')[0].stations).toHaveLength(4);
    expect(request.bodies('generate-report')[0].stationChecks).toEqual([{ number: 2, status: 'activity' }, { number: 3, status: 'serviced' }]);
  }, 30000);

  const rodentRegistry = { available: true, stationsLoaded: true, stations: [station(1, 'rodent'), station(2, 'rodent'), station(3, 'rodent')] };
  const rodentRequest = () => makeRequest({
    visit: { ...VISIT, serviceType: 'Rodent Bait Stations', serviceKey: 'rodent_bait_quarterly' },
    typedType: 'rodent_bait_station',
    registry: rodentRegistry,
    typedFacts: {
      available: true, status: 'read', type: 'rodent_bait_station', heard: {}, unclearFields: [], values: { bait_consumption: 'Light' },
      stationRead: 'read', stationExceptions: [{ id: 'st-rodent-2', number: 2, status: 'activity', quote: 'bait eaten at station 2' }],
    },
  });

  test('a chip tap after Generate marks the report stale even when the counts do not move, and the regenerated writer payload carries the corrected status', async () => {
    const request = rodentRequest();
    await openSheet(request, RODENT);
    await generate('Bait eaten at station 2.');
    expect(request.bodies('generate-report')[0].stationChecks).toEqual([{ number: 2, status: 'activity' }]);
    expect(screen.queryByText(/You changed the visit after this report was written/)).toBeNull();
    const countsBefore = request.bodies('generate-report')[0].structuredFindings.values;
    // Consumption -> Serviced: the rodent counts are the same.
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Station 2: Consumption' }));
    expect(within(stationsCard()).getByRole('button', { name: 'Station 2: Serviced' })).toBeTruthy();
    expect(screen.getByText(/You changed the visit after this report was written/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete & send' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(request.bodies('generate-report')).toHaveLength(2));
    const second = request.bodies('generate-report')[1];
    expect(second.stationChecks).toEqual([{ number: 2, status: 'serviced' }]);
    expect(second.structuredFindings.values).toEqual(countsBefore);
    // The read does not write over the tap, and the completion matches the report.
    const body = await send(request);
    expect(body.termiteStations.find((entry) => entry.id === 'st-rodent-2')).toEqual({ id: 'st-rodent-2', status: 'serviced', touched: true });
  }, 30000);

  test('clearing a heard exception sends an empty list: every station OK, over the note', async () => {
    const request = rodentRequest();
    await openSheet(request, RODENT);
    await generate('Bait eaten at station 2.');
    for (let i = 0; i < 3; i += 1) fireEvent.click(within(stationsCard()).getByRole('button', { name: /^Station 2:/ }));
    expect(within(stationsCard()).getByText('3 stations, all OK')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(request.bodies('generate-report')).toHaveLength(2));
    expect(request.bodies('generate-report')[1].stationChecks).toEqual([]);
  }, 30000);
});

describe('"all stations OK" is only said when the note\'s station read is known to have succeeded', () => {
  const failed = { ...TERMITE_READ, stationRead: 'failed', stationExceptions: [] };
  const noVerdict = (() => { const { stationRead: _a, stationExceptions: _b, ...rest } = TERMITE_READ; return rest; })();
  // The typed fields are read fine; the station read did not succeed.
  const cases = [
    ['the station read timed out or its model failed (the server says failed)', failed],
    ['the answer carries no station verdict at all', noVerdict],
    ['the station read says something else than read', { ...TERMITE_READ, stationRead: 'no_stations' }],
  ];

  test.each(cases)('%s: no report is written, nothing is asserted, and the card says it was not read', async (_label, typedFacts) => {
    const request = makeRequest({ typedFacts });
    await openSheet(request);
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false), { timeout: 10000 });
    fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
    await screen.findByText(/Couldn’t read the stations from your note\. Try again/, {}, { timeout: 10000 });
    // The typed fields were read, but no report was written, and no station fact went anywhere.
    expect(request.bodies('/typed-facts')).toHaveLength(1);
    expect(request.bodies('generate-report')).toEqual([]);
    expect(request.bodies('/complete')).toEqual([]);
    expect(within(stationsCard()).getByText('4 stations. Couldn’t read them from your note.')).toBeTruthy();
    expect(within(stationsCard()).queryByText(/all OK/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Complete & send' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  }, 30000);

  test('a typed read that never answers is the same: failed, nothing asserted', async () => {
    const request = makeRequest({ typedFacts: () => { throw new Error('timeout'); } });
    await openSheet(request);
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false), { timeout: 10000 });
    fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
    await screen.findByText(/Couldn’t read the stations from your note\. Try again/, {}, { timeout: 10000 });
    expect(request.bodies('generate-report')).toEqual([]);
  }, 30000);

  test('Try again: a read that succeeds goes on with the exceptions the note named', async () => {
    let calls = 0;
    const request = makeRequest({ typedFacts: () => { calls += 1; return calls === 1 ? failed : TERMITE_READ; } });
    await openSheet(request);
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false), { timeout: 10000 });
    fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
    await screen.findByText(/Couldn’t read the stations from your note\. Try again/, {}, { timeout: 10000 });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Report the customer will see', {}, { timeout: 10000 });
    expect(request.bodies('generate-report')).toHaveLength(1);
    expect(request.bodies('generate-report')[0].stationChecks).toEqual([{ number: 2, status: 'activity' }, { number: 3, status: 'serviced' }]);
    expect(within(stationsCard()).getByText('4 stations, 2 flagged, the rest OK')).toBeTruthy();
    const body = await send(request);
    expect(body.termiteStations.filter((entry) => entry.touched).map((entry) => entry.status)).toEqual(['activity', 'serviced']);
  }, 30000);

  test('a note edited after a successful read is held until it is read again', async () => {
    const request = makeRequest();
    await openSheet(request);
    await generate();
    expect(within(stationsCard()).getByText('4 stations, 2 flagged, the rest OK')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the visit' }));
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: `${NOTE} Also the gate was locked at station 4.` } });
    // The edited note is not read for stations: the report is out of date and
    // only writing it again (which reads the note) goes on; no Complete.
    expect(screen.queryByRole('button', { name: 'Complete & send' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(request.bodies('/typed-facts')).toHaveLength(2));
    await waitFor(() => expect(request.bodies('generate-report')).toHaveLength(2));
    expect(request.bodies('/typed-facts')[1].note).toContain('gate was locked');
    expect(request.bodies('/typed-facts')[1].stations).toHaveLength(4);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
  }, 30000);

  test('the tech can mark the stations by hand and confirm: the hand marks stand, with no read of the note for them', async () => {
    const request = makeRequest({ typedFacts: failed });
    await openSheet(request);
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false), { timeout: 10000 });
    fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
    await screen.findByText(/Couldn’t read the stations from your note\. Try again/, {}, { timeout: 10000 });
    expect(request.bodies('generate-report')).toEqual([]);
    // Station 2 by hand, then the confirmation.
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Flag a station' }));
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Station 2' }));
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Stations checked by hand' }));
    expect(within(stationsCard()).getByText('4 stations, checked by hand, 1 flagged, the rest OK')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Report the customer will see', {}, { timeout: 10000 });
    // The hand marks went to the writer, and the note was not asked for stations again.
    expect(request.bodies('generate-report')[0].stationChecks).toEqual([{ number: 2, status: 'activity' }]);
    expect(request.bodies('/typed-facts')).toHaveLength(2);
    expect(request.bodies('/typed-facts')[1]).not.toHaveProperty('stations');
    const body = await send(request);
    expect(body.termiteStations.map((entry) => entry.status)).toEqual(['ok', 'activity', 'ok', 'ok']);
    expect(body.structuredFindings.values).toMatchObject({ stations_checked: '4', stations_with_activity: '1' });
  }, 40000);
});

// The note is read twice on the server, side by side: the form's fields and the
// stations. Each read has its own verdict, and neither may swallow the other's
// (Codex P2 on #6205). The four combinations, what each ends in.
describe('the typed read and the station read are independent: all four combinations', () => {
  const typedFailed = { available: true, status: 'failed', type: 'termite_bait_station', values: {}, heard: {}, unclearFields: [] };
  const stationsRead = { stationRead: 'read', stationExceptions: TERMITE_READ.stationExceptions };
  const stationsFailed = { stationRead: 'failed', stationExceptions: [] };
  const typedOk = { available: true, status: 'read', type: 'termite_bait_station', heard: {}, unclearFields: [], values: TERMITE_READ.values };
  // A station read that returned something that did not verify: failed, "unresolved",
  // with the exceptions that did verify beside it.
  const stationsUnresolved = { stationRead: 'failed', stationReadDetail: 'unresolved', stationExceptions: [TERMITE_READ.stationExceptions[0]] };
  const FAILED_MSG = /Couldn’t read the stations from your note\. Try again/;
  const UNRESOLVED_MSG = /Couldn’t match everything you said about the stations\. Mark them by hand and confirm\./;
  const TABLE = [
    ['typed ok, stations read', { ...typedOk, ...stationsRead }, { report: true, typedFilled: true, stationsRead: true }],
    ['typed failed, stations read', { ...typedFailed, ...stationsRead }, { report: true, typedFilled: false, stationsRead: true }],
    ['typed ok, stations failed', { ...typedOk, ...stationsFailed }, { report: false, message: FAILED_MSG, summary: '4 stations. Couldn’t read them from your note.' }],
    ['both failed', { ...typedFailed, ...stationsFailed }, { report: false, message: FAILED_MSG, summary: '4 stations. Couldn’t read them from your note.' }],
    ['typed ok, stations unresolved', { ...typedOk, ...stationsUnresolved }, { report: false, message: UNRESOLVED_MSG, summary: '4 stations. Couldn’t match everything you said about them.' }],
    ['typed failed, stations unresolved', { ...typedFailed, ...stationsUnresolved }, { report: false, message: UNRESOLVED_MSG, summary: '4 stations. Couldn’t match everything you said about them.' }],
  ];

  test.each(TABLE)('%s', async (_label, typedFacts, expected) => {
    const request = makeRequest({ typedFacts });
    await openSheet(request);
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false), { timeout: 10000 });
    fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
    if (!expected.report) {
      // Stations not known: no report, nothing asserted, whatever the form read said.
      await screen.findByText(expected.message, {}, { timeout: 10000 });
      expect(request.bodies('generate-report')).toEqual([]);
      expect(within(stationsCard()).getByText(expected.summary)).toBeTruthy();
      expect(within(stationsCard()).queryByText(/all OK/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Complete & send' })).toBeNull();
      return;
    }
    await screen.findByText('Report the customer will see', {}, { timeout: 10000 });
    // The stations were read, so their verdict stands whatever the form read said.
    expect(screen.queryByText(/Couldn’t read the stations/)).toBeNull();
    expect(request.bodies('generate-report')[0].stationChecks).toEqual([{ number: 2, status: 'activity' }, { number: 3, status: 'serviced' }]);
    expect(within(stationsCard()).getByText('4 stations, 2 flagged, the rest OK')).toBeTruthy();
    expect(within(stationsCard()).getByRole('button', { name: 'Station 2: Activity' })).toBeTruthy();
    const recordCard = screen.getByRole('region', { name: 'Termite Bait Station Inspection record heard from you' });
    if (expected.typedFilled) {
      expect(within(recordCard).getByText('Previous feeding noted')).toBeTruthy();
      const body = await send(request);
      expect(body.termiteStations.filter((entry) => entry.touched)).toHaveLength(2);
    } else {
      // A typed read that failed keeps its own behavior: the card says so and
      // the required fields are the tech's to pick, so the send is held on them.
      expect(within(recordCard).getByText(/Couldn’t read your note for this just now/)).toBeTruthy();
      expect(screen.getAllByText('Pick Termite activity: tap Change beside it.').length).toBeGreaterThan(0);
      expect(sendButton().disabled).toBe(true);
    }
  }, 30000);
});

describe('the Full form stays reachable on a station visit', () => {
  const fullFormButton = () => screen.queryByRole('button', { name: /full form/i });

  test('with the stations loaded and the note read, the header still offers the Full form (add, move and retire a station, inspection only)', async () => {
    const request = makeRequest();
    await openSheet(request);
    expect(fullFormButton()).toBeTruthy();
    await generate();
    expect(within(stationsCard()).getByText('4 stations, 2 flagged, the rest OK')).toBeTruthy();
    expect(fullFormButton()).toBeTruthy();
  }, 30000);

  test('a typed visit with no stations flow keeps the rule it had: no Full form until the sheet says it is needed', async () => {
    const request = makeRequest({ typedFacts: { ...TERMITE_READ, stationRead: undefined, stationExceptions: undefined } });
    await openSheet(request, { ...TERMITE, stationsFlow: false });
    expect(fullFormButton()).toBeNull();
  }, 20000);
});

describe('a read that is refreshed or whose roster went stale', () => {
  test('"Write it again" whose station read fails on a note already read stands on that read: the report is written again and the visit completes', async () => {
    let calls = 0;
    const request = makeRequest({ typedFacts: () => { calls += 1; return calls === 1 ? TERMITE_READ : { ...TERMITE_READ, stationRead: 'failed', stationExceptions: [] }; } });
    await openSheet(request);
    await generate();
    // A chip tap makes the report stale; the refresh's station read then fails.
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Station 2: Activity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(request.bodies('generate-report')).toHaveLength(2));
    expect(screen.queryByText(/Couldn’t read the stations/)).toBeNull();
    // Written from the known stations: the tech's tap, and what the first read heard.
    expect(request.bodies('generate-report')[1].stationChecks).toEqual([{ number: 2, status: 'serviced' }, { number: 3, status: 'serviced' }]);
    expect(within(stationsCard()).getByText('4 stations, 2 flagged, the rest OK')).toBeTruthy();
    const body = await send(request);
    expect(body.termiteStations.filter((entry) => entry.touched).map((entry) => entry.status)).toEqual(['serviced', 'serviced']);
  }, 30000);

  test('a failed read for a note with no earlier successful read still stops the report', async () => {
    const request = makeRequest({ typedFacts: { ...TERMITE_READ, stationRead: 'failed', stationExceptions: [] } });
    await openSheet(request);
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false), { timeout: 10000 });
    fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
    await screen.findByText(/Couldn’t read the stations from your note\. Try again/, {}, { timeout: 10000 });
    expect(request.bodies('generate-report')).toEqual([]);
  }, 30000);

  test('a refresh that finds something it cannot place withdraws the earlier read: held, with the hand check offered', async () => {
    let calls = 0;
    const request = makeRequest({ typedFacts: () => { calls += 1; return calls === 1 ? TERMITE_READ : { ...TERMITE_READ, stationRead: 'failed', stationReadDetail: 'unresolved', stationExceptions: TERMITE_READ.stationExceptions }; } });
    await openSheet(request);
    await generate();
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Station 2: Activity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    await screen.findByText(/Couldn’t match everything you said about the stations/, {}, { timeout: 10000 });
    expect(request.bodies('generate-report')).toHaveLength(1);
    expect(within(stationsCard()).getByRole('button', { name: 'Stations checked by hand' })).toBeTruthy();
  }, 30000);

  test('the server saying the roster changed loads the registry again and asks for another try', async () => {
    let calls = 0;
    const request = makeRequest({
      typedFacts: () => {
        calls += 1;
        return calls === 1 ? { ...TERMITE_READ, stationRead: 'failed', stationReadDetail: 'roster_changed', stationExceptions: [] } : TERMITE_READ;
      },
    });
    await openSheet(request);
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false), { timeout: 10000 });
    const mapCalls = () => request.paths().filter((path) => path.endsWith('/property-map')).length;
    expect(mapCalls()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
    await screen.findByText(/The stations on this property changed/, {}, { timeout: 10000 });
    expect(request.bodies('generate-report')).toEqual([]);
    await waitFor(() => expect(mapCalls()).toBe(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await screen.findByText('Report the customer will see', {}, { timeout: 10000 });
    expect(request.bodies('generate-report')[0].stationChecks).toEqual([{ number: 2, status: 'activity' }, { number: 3, status: 'serviced' }]);
  }, 30000);
});

describe('part of what the note said about the stations could not be pinned down', () => {
  const unresolved = {
    ...TERMITE_READ,
    stationRead: 'failed',
    stationReadDetail: 'unresolved',
    stationExceptions: [TERMITE_READ.stationExceptions[0]],
  };

  async function generateUnresolved(request) {
    await openSheet(request);
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: NOTE } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false), { timeout: 10000 });
    fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
    await screen.findByText(/Couldn’t match everything you said about the stations/, {}, { timeout: 10000 });
  }

  test('no report, nothing asserted, Complete held; the exceptions that verified are pre-marked for the tech to see', async () => {
    const request = makeRequest({ typedFacts: unresolved });
    await generateUnresolved(request);
    expect(request.bodies('generate-report')).toEqual([]);
    expect(request.bodies('/complete')).toEqual([]);
    const card = stationsCard();
    expect(within(card).getByText('4 stations. Couldn’t match everything you said about them.')).toBeTruthy();
    expect(within(card).queryByText(/all OK/)).toBeNull();
    expect(within(card).getByRole('button', { name: 'Station 2: Activity' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Stations checked by hand' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete & send' })).toBeNull();
  }, 30000);

  test('the hand check goes on: the hand marks (the pre-marked chip changed by the tech) are what is sent', async () => {
    const request = makeRequest({ typedFacts: unresolved });
    await generateUnresolved(request);
    // Station 2 was pre-marked Activity; the tech makes it Serviced, flags station 4, and confirms.
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Station 2: Activity' }));
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Flag a station' }));
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Station 4' }));
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Stations checked by hand' }));
    expect(within(stationsCard()).getByText('4 stations, checked by hand, 2 flagged, the rest OK')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Report the customer will see', {}, { timeout: 10000 });
    expect(request.bodies('generate-report')[0].stationChecks).toEqual([{ number: 2, status: 'serviced' }, { number: 4, status: 'activity' }]);
    const body = await send(request);
    expect(body.termiteStations.map((entry) => entry.status)).toEqual(['ok', 'serviced', 'ok', 'activity']);
  }, 40000);

  test('Try again with a note that now reads clean goes on with the exceptions it named', async () => {
    let calls = 0;
    const request = makeRequest({ typedFacts: () => { calls += 1; return calls === 1 ? unresolved : TERMITE_READ; } });
    await generateUnresolved(request);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Report the customer will see', {}, { timeout: 10000 });
    expect(within(stationsCard()).getByText('4 stations, 2 flagged, the rest OK')).toBeTruthy();
  }, 30000);
});

describe('the completion is bound to the stations the sheet checked', () => {
  test('the body names the stations it checked (stationRosterSeen), exactly the entries it posts', async () => {
    const request = makeRequest();
    await openSheet(request);
    await generate();
    const body = await send(request);
    expect(body.stationRosterSeen).toEqual(TERMITE_REGISTRY.stations.map((s) => s.id));
    expect(body.stationRosterSeen).toEqual(body.termiteStations.map((entry) => entry.id));
  }, 30000);

  test('a station-less sheet sends no marker', async () => {
    const request = makeRequest({ typedFacts: { ...TERMITE_READ, stationRead: undefined, stationExceptions: undefined, values: { stations_checked: '12', termite_activity: 'Previous feeding noted', bait_consumption: 'Light feeding' } } });
    await openSheet(request, { ...TERMITE, stationsFlow: false });
    await generate('Checked all 12 stations.');
    const body = await send(request);
    expect(body).not.toHaveProperty('stationRosterSeen');
  }, 30000);

  test('the server saying the stations changed loads them again, holds the send until the note is read again, and a fresh try goes on', async () => {
    let completes = 0;
    const err = Object.assign(new Error('The stations on this property changed, so they are loaded again. Try again.'), { status: 409, code: 'station_roster_changed' });
    const request = makeRequest({ complete: () => { completes += 1; if (completes === 1) throw err; return { success: true }; } });
    await openSheet(request);
    await generate();
    const mapCalls = () => request.paths().filter((path) => path.endsWith('/property-map')).length;
    expect(mapCalls()).toBe(1);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await screen.findByText(/The stations on this property changed, so they are loaded again\. Try again\./, {}, { timeout: 10000 });
    await waitFor(() => expect(mapCalls()).toBe(2));
    // What was read against the old roster no longer stands: the report is written again.
    expect(screen.queryByRole('button', { name: 'Complete & send' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(request.bodies('generate-report')).toHaveLength(2));
    const body = await send(request);
    expect(request.bodies('/complete')).toHaveLength(2);
    // A new key for the corrected completion.
    expect(request.bodies('/complete')[1].idempotencyKey).not.toBe(request.bodies('/complete')[0].idempotencyKey);
    expect(body.stationRosterSeen).toHaveLength(4);
  }, 40000);
});

// Push audit P1 on #6205: a remark with no station number ("I couldn't check the
// back corner station") comes back as an unresolved read with NO numbered
// exception. Nothing is marked, nothing is asserted, and the hand check goes on.
describe('a station remark with no number', () => {
  const CORNER_NOTE = 'Checked them all. I couldn’t check the back corner station.';
  const corner = { ...TERMITE_READ, stationRead: 'failed', stationReadDetail: 'unresolved', stationExceptions: [] };

  test('holds with nothing asserted; the tech marks the station by hand and confirms, and the hand marks are sent', async () => {
    const request = makeRequest({ typedFacts: corner });
    await openSheet(request);
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: CORNER_NOTE } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false), { timeout: 10000 });
    fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
    await screen.findByText(/Couldn’t match everything you said about the stations\. Mark them by hand and confirm\./, {}, { timeout: 10000 });
    expect(request.bodies('generate-report')).toEqual([]);
    expect(within(stationsCard()).queryByText(/all OK/)).toBeNull();
    expect(within(stationsCard()).queryByRole('group', { name: 'Flagged stations' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Complete & send' })).toBeNull();
    // Station 4 is the back corner one: no access, by hand.
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Flag a station' }));
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Station 4' }));
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Station 4: Activity' }));
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Station 4: Serviced' }));
    fireEvent.click(within(stationsCard()).getByRole('button', { name: 'Stations checked by hand' }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Report the customer will see', {}, { timeout: 10000 });
    expect(request.bodies('generate-report')[0].stationChecks).toEqual([{ number: 4, status: 'inaccessible' }]);
    const body = await send(request);
    expect(body.termiteStations.map((entry) => entry.status)).toEqual(['ok', 'ok', 'ok', 'inaccessible']);
    expect(body.structuredFindings.values).toMatchObject({ stations_checked: '3', stations_inaccessible: '1' });
  }, 40000);
});

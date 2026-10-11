// @vitest-environment jsdom
// The pest sheet's report flow with the Wrap-up section (GATE_FAST_COMPLETE_WRAP_UP): a recurring pest
// visit, a typed (cockroach) visit and a bait station visit post the customer text they always posted
// when the gate is off or the section is untouched (no `reviewTiming`: the report flow never sent one);
// each change rides the body; a re-service and a part of a grouped stop show no Wrap-up; the sheet is
// locked while the review send-time re-check reads. Synthetic data only.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FastCompleteSheet from './FastCompleteSheet';

vi.mock('./TechTreatmentZoneModal', () => ({ default: () => null }));
vi.mock('./TechServicePhotosModal', () => ({ default: () => null }));
vi.setConfig({ testTimeout: 30000 });

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

const CATALOG = [{ id: 'taurus', name: 'Taurus SC', category: 'Insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' }];
const REGULAR = {
  id: 'svc-1', customerName: 'Pat Jones', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-1',
  serviceType: 'Quarterly Pest Control', scheduledDate: '2026-10-01', address: { line1: '123 Main St' },
  serviceKey: 'pest_general_quarterly', status: 'confirmed',
};
const SERVICE = {
  id: 'svc-1', customerId: 'cust-1', customerName: 'Pat Jones', serviceType: 'Quarterly Pest Control', address: '123 Main St', timeLabel: '9:00 AM',
  reportFlow: true, traceEligible: true, onSiteAt: new Date(Date.now() - 9 * 60 * 1000).toISOString(),
  estimatedPrice: 95, createInvoiceOnComplete: true,
};
const REPORT = 'WHAT WE FOUND\nGhost ants, light.\n\nWHAT WE DID AND WHY\nWe baited the counter edge.\n\nWHAT TO EXPECT\nA few more ants for a few days.\n\nWHAT\'S NEXT\nKeep counters wiped.';
const NOTE = 'Ghost ants on the kitchen counter, light. Baited the counter edge.';
const FACTS = { available: true, status: 'read', areas: ['Inside', 'Outside'], pests: ['ghost ants'] };
const PREVIEW = { schedulerEnabled: true, at: '2026-10-12T14:00:00.000Z', bucket: 'b1', reviewSequencesEnabled: true, cadenceTickMinutesOfHour: [14, 44] };

const ROACH_SCHEMA = {
  type: 'cockroach',
  label: 'Cockroach Treatment',
  fields: [
    { key: 'species', label: 'Species', type: 'select', required: true, options: ['German', 'American', 'Smoky brown', 'Mixed', 'Unknown'] },
    { key: 'activity_level', label: 'Activity level', type: 'select', required: true, options: ['None observed', 'Low', 'Moderate', 'Heavy', 'Severe'] },
    { key: 'areas_treated', label: 'Areas treated', type: 'chips', options: ['Kitchen', 'Bathrooms', 'Under sinks', 'Exterior perimeter'] },
  ],
  activity: { label: 'Roach Activity', deriveField: 'activity_level', techScoreLabels: { 0: 'None', 1: 'Very low', 2: 'Low', 3: 'Moderate', 4: 'High', 5: 'Severe' } },
};
const ROACH_READ = {
  available: true, status: 'read', type: 'cockroach',
  values: { species: 'German', activity_level: 'Heavy', areas_treated: 'Kitchen' },
  heard: { species: [{ value: 'German', quote: 'german roaches' }], activity_level: [{ value: 'Heavy', quote: 'heavy behind the fridge' }], areas_treated: [{ value: 'Kitchen', quote: 'in the kitchen' }] },
  unclearFields: [],
};
const ROACH_VISIT = { ...REGULAR, id: 'svc-roach', serviceType: 'Cockroach Control', serviceKey: 'cockroach_control' };
const ROACH_SERVICE = { ...SERVICE, id: 'svc-roach', serviceType: 'Cockroach Control', laneFlow: false, laneKey: null, typedFlow: true, typedType: 'cockroach', typedSchema: ROACH_SCHEMA, traceEligible: false };

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
const circle = { type: 'circle', cx: 0.4, cy: 0.5, r: 0.03 };
const station = (n) => ({ id: `st-termite-${n}`, number: n, program: 'termite', label: null, geometryImage: circle, staleMark: false });
const TERMITE_VISIT = { ...REGULAR, id: 'svc-station', serviceType: 'Termite Monitoring', serviceKey: 'termite_monitoring' };
const TERMITE_SERVICE = { ...SERVICE, id: 'svc-station', serviceType: 'Termite Monitoring', laneFlow: false, laneKey: null, typedFlow: true, typedType: 'termite_bait_station', typedSchema: TERMITE_SCHEMA, stationsFlow: true, traceEligible: false };
const TERMITE_READ = {
  available: true, status: 'read', type: 'termite_bait_station', heard: {}, unclearFields: [],
  values: { termite_activity: 'Previous feeding noted', bait_consumption: 'Light feeding' }, stationRead: 'read', stationExceptions: [],
};

// A stub of the whole admin API the sheet talks to. `holdRereads`: the first send-time read answers, later ones wait for request.release().
function makeRequest({ kind = 'regular', wrapUp = true, service, seeds = { exteriorMinutes: 30, interiorMinutes: 0 }, nextVisit = null, holdRereads = false } = {}) {
  const calls = [];
  const held = [];
  let previewReads = 0;
  const visit = service || { regular: REGULAR, roach: ROACH_VISIT, station: TERMITE_VISIT }[kind];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, body: options?.body ? JSON.parse(options.body) : null });
    const bare = path.split('?')[0];
    if (bare.endsWith('/pest-recap/context')) {
      const typed = { roach: 'cockroach', station: 'termite_bait_station' }[kind];
      return { ok: true, eligible: kind === 'regular', reportFlow: true, lane: null, ...(typed ? { typedType: typed } : {}), service: visit, products: CATALOG, ...(wrapUp ? { wrapUp: true } : {}) };
    }
    if (bare.endsWith('/tech-rating-allowed')) return { allowed: true, firstVisit: false, scaleLabels: null };
    if (bare.endsWith('/tech-tips')) return { available: false };
    if (bare.endsWith('/promises')) return { available: false, promises: [] };
    if (bare.endsWith('/blog-posts')) return { available: false, posts: [] };
    if (bare.endsWith('/photos')) return { photos: [] };
    if (bare.endsWith('/treatment-zone/last')) return { available: false };
    if (bare.endsWith('/treatment-zone')) return { enabled: true, treatmentZone: null };
    if (bare.endsWith('/property-map')) return { available: true, stationsLoaded: true, stations: [station(1), station(2)] };
    if (bare === '/admin/schedule/generate-report') return { report: REPORT };
    if (bare.endsWith('/voice-facts')) return FACTS;
    if (bare.endsWith('/typed-facts')) return kind === 'station' ? TERMITE_READ : ROACH_READ;
    if (bare.endsWith('/reentry-defaults')) return seeds;
    if (bare === '/admin/schedule/next-visit') return { nextVisit };
    if (bare === '/admin/reviews/send-time-preview') {
      previewReads += 1;
      if (holdRereads && previewReads > 1) return new Promise((resolve) => { held.push(() => resolve(PREVIEW)); });
      return PREVIEW;
    }
    if (bare.endsWith('/complete')) return { success: true };
    return {};
  });
  request.calls = calls;
  request.bodies = (suffix) => calls.filter((call) => call.path.endsWith(suffix)).map((call) => call.body);
  request.reads = (pattern) => calls.filter((call) => pattern.test(call.path));
  request.release = () => held.forEach((resolve) => resolve());
  return request;
}

async function openSheet(request, service = SERVICE, props = {}) {
  render(<FastCompleteSheet service={service} request={request} onClose={() => {}} onCompleted={() => {}} {...props} />);
  await screen.findByRole('button', { name: 'Generate AI report' }, { timeout: 10000 });
}
async function generate(note = NOTE) {
  const box = screen.queryByLabelText('Tell me about the visit');
  if (box) fireEvent.change(box, { target: { value: note } });
  const rating = screen.queryByRole('button', { name: '3, moderate' });
  if (rating) fireEvent.click(rating);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Generate AI report' }).disabled).toBe(false), { timeout: 10000 });
  fireEvent.click(screen.getByRole('button', { name: 'Generate AI report' }));
  await screen.findByText('Report the customer will see', {}, { timeout: 10000 });
}
const sendButton = () => screen.getByRole('button', { name: 'Complete & send' });
async function send(request) {
  await waitFor(() => expect(sendButton().disabled).toBe(false));
  fireEvent.click(sendButton());
  await screen.findByTestId('fast-complete-sent');
  return request.bodies('/complete')[0];
}
const wrapUpHeading = () => screen.queryByRole('heading', { name: 'Wrap-up' });
const WRAP_UP_KEYS = ['reviewTiming', 'reviewDelayMinutes', 'reviewScheduledFor', 'timeOnSite', 'reentryExteriorMinutes', 'reentryInteriorMinutes', 'nextVisitAdjustmentNote'];
const expectToday = (body) => {
  expect(body).toMatchObject({ sendCompletionSms: true, includePayLink: true, requestReview: true });
  for (const key of WRAP_UP_KEYS) expect(body).not.toHaveProperty(key);
};

describe.each([
  ['a recurring pest visit', 'regular', SERVICE],
  ['a typed (cockroach) visit', 'roach', ROACH_SERVICE],
  ['a bait station visit', 'station', TERMITE_SERVICE],
])('%s', (_label, kind, service) => {
  test('gate off: no Wrap-up, no extra reads, the customer text it always posted and no reviewTiming', async () => {
    const request = makeRequest({ kind, wrapUp: false });
    await openSheet(request, service);
    await generate();
    expect(wrapUpHeading()).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Time on-site' })).toBeNull();
    expectToday(await send(request));
    expect(request.reads(/reentry-defaults|next-visit|send-time-preview/)).toEqual([]);
  });

  test('gate on, untouched: the section is on the report step with the clock, and the body is the same customer text with no reviewTiming', async () => {
    const request = makeRequest({ kind });
    await openSheet(request, service);
    expect(wrapUpHeading()).toBeNull();
    expect(screen.getByRole('heading', { name: 'Time on-site' })).toBeTruthy();
    await generate();
    expect(wrapUpHeading()).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Time on-site' })).toBeTruthy();
    expectToday(await send(request));
  });
});

describe('the recurring pest visit with the Wrap-up on', () => {
  test('each change rides the body; Automatic again drops the reviewTiming key', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'op-1', role: 'admin' }));
    const request = makeRequest({ nextVisit: { id: 'svc-2', date: '2026-11-05', serviceType: 'Quarterly Pest Control' } });
    await openSheet(request);
    await generate();
    fireEvent.change(await screen.findByLabelText('Adjust time on site (minutes)'), { target: { value: '40' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Increase Exterior (dry-down) by 5 minutes' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Include payment link in the text/ }));
    fireEvent.change(screen.getByLabelText('Review request timing'), { target: { value: 'customer_requested' } });
    expect(await screen.findByText('Thu, Nov 5')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Needs adjustment?' })).toBeNull();
    const body = await send(request);
    expect(body).toMatchObject({
      sendCompletionSms: true, includePayLink: false, requestReview: true, reviewTiming: 'customer_requested', reviewDelayMinutes: 0, reviewScheduledFor: null,
      timeOnSite: 40, reentryExteriorMinutes: 35,
    });
    expect(body).not.toHaveProperty('nextVisitAdjustmentNote');
  });

  test('picking another timing and back to Automatic posts no reviewTiming, as before', async () => {
    const request = makeRequest();
    await openSheet(request);
    await generate();
    const timing = screen.getByLabelText('Review request timing');
    fireEvent.change(timing, { target: { value: 'tomorrow_8' } });
    fireEvent.change(timing, { target: { value: 'auto' } });
    expectToday(await send(request));
  });

  test('a changed Automatic review time stops the first Complete; the second goes', async () => {
    const request = makeRequest();
    await openSheet(request);
    await generate();
    await waitFor(() => expect(request.reads(/send-time-preview/).length).toBeGreaterThan(0));
    // The re-check at submit answers a different bucket than the one on screen.
    const original = request.getMockImplementation();
    request.mockImplementation(async (path, options) => {
      if (path.startsWith('/admin/reviews/send-time-preview')) return { ...PREVIEW, bucket: 'b2' };
      return original(path, options);
    });
    fireEvent.click(sendButton());
    expect((await screen.findByRole('alert', {}, { timeout: 4000 })).textContent).toMatch(/Submit again to confirm/);
    expect(request.bodies('/complete')).toHaveLength(0);
    expectToday(await send(request));
  });
});

describe('visits that keep their fixed customer text', () => {
  test('a re-service in the report flow shows no Wrap-up and sends no pay link and no review ask', async () => {
    const request = makeRequest({ service: { ...REGULAR, serviceType: 'Pest Control Re-Service', serviceKey: 'pest_re_service' } });
    await openSheet(request, { ...SERVICE, serviceType: 'Pest Control Re-Service' });
    await generate();
    expect(wrapUpHeading()).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Time on-site' })).toBeNull();
    const body = await send(request);
    expect(body).toMatchObject({ sendCompletionSms: true, includePayLink: false, requestReview: false });
    expect(request.reads(/reentry-defaults|next-visit|send-time-preview/)).toEqual([]);
  });

  test('a callback booked under a regular service key is a re-service: no Wrap-up', async () => {
    const request = makeRequest({ service: { ...REGULAR, isCallback: true } });
    await openSheet(request);
    await generate();
    expect(wrapUpHeading()).toBeNull();
    expect(await send(request)).toMatchObject({ includePayLink: false, requestReview: false });
  });

  test('a part of a grouped stop (prepare mode) shows no Wrap-up and hands over the same customer text', async () => {
    const onPrepared = vi.fn();
    const request = makeRequest();
    await openSheet(request, SERVICE, { onPrepared, sharedNote: NOTE });
    await generate();
    expect(wrapUpHeading()).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Time on-site' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save for this stop' }));
    await screen.findByText('Saved for this stop');
    expectToday(onPrepared.mock.calls[0][1]);
    expect(request.reads(/reentry-defaults|next-visit|send-time-preview/)).toEqual([]);
    expect(request.bodies('/complete')).toHaveLength(0);
  });
});

describe('while the review send time is being re-checked', () => {
  async function startHeldComplete(props = {}) {
    const request = makeRequest({ holdRereads: true });
    await openSheet(request, SERVICE, props);
    await generate();
    await waitFor(() => expect(request.reads(/send-time-preview/).length).toBeGreaterThan(0));
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' }).disabled).toBe(true));
    return request;
  }

  test('the form, Complete, Close and Esc are inert, a second tap does nothing, and nothing is posted until the answer lands', async () => {
    const onClose = vi.fn();
    const request = await startHeldComplete({ onClose });
    expect(screen.getByRole('checkbox', { name: 'Send completion text' }).matches(':disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Back to the visit' }).disabled).toBe(true);
    const complete = document.querySelector('.tech-visit-footer .tech-visit-complete');
    expect(complete.disabled).toBe(true);
    const before = request.reads(/send-time-preview/).length;
    fireEvent.click(complete);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(request.reads(/send-time-preview/).length).toBe(before);
    expect(onClose).not.toHaveBeenCalled();
    expect(request.bodies('/complete')).toHaveLength(0);
    await act(async () => { request.release(); });
    await waitFor(() => expect(request.bodies('/complete')).toHaveLength(1));
  });

  test('an answer that lands after the sheet is gone posts nothing', async () => {
    const request = await startHeldComplete();
    cleanup();
    await act(async () => { request.release(); });
    await act(async () => { await Promise.resolve(); });
    expect(request.bodies('/complete')).toHaveLength(0);
  });
});

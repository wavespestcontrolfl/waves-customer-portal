import { describe, expect, it } from 'vitest';
import { currentStopOf, groupServicesIntoStops, nextStopOf, stillOpenStopsOf, stopArrivalMs, stopSummaryLabel, stopWindow, stopPropertyAlerts, stopHasCustomerSentPhotos } from './routeStops';

const visit = { id: 'v1', serviceCount: 2 };

describe('groupServicesIntoStops (visit-group-scope.md §3)', () => {
  it('rows sharing a visit become ONE stop in feed order; others stay single', () => {
    const stops = groupServicesIntoStops([
      { id: 'a', status: 'pending', visit },
      { id: 'b', status: 'pending' },
      { id: 'c', status: 'pending', visit },
    ]);
    expect(stops.map((s) => s.key)).toEqual(['visit:v1', 'row:b']);
    expect(stops[0].isVisit).toBe(true);
    expect(stops[0].services.map((s) => s.id)).toEqual(['a', 'c']);
    expect(stops[1].isVisit).toBe(false);
  });
  it('primary is the first non-terminal member; nextStop skips fully terminal stops', () => {
    const stops = groupServicesIntoStops([
      { id: 'a', status: 'completed', visit },
      { id: 'c', status: 'confirmed', visit },
      { id: 'd', status: 'completed' },
      { id: 'e', status: 'pending' },
    ]);
    expect(stops[0].primary.id).toBe('c');
    expect(nextStopOf(stops).key).toBe('visit:v1');
    expect(nextStopOf(groupServicesIntoStops([{ id: 'd', status: 'completed' }]))).toBe(null);
  });
  it('a lone row carrying a visit id is not rendered as a visit', () => {
    const [stop] = groupServicesIntoStops([{ id: 'a', status: 'pending', visit }]);
    expect(stop.isVisit).toBe(false);
    expect(stopSummaryLabel(stop)).toBe(null);
  });
  it('summary label sums estimated durations', () => {
    const [stop] = groupServicesIntoStops([
      { id: 'a', status: 'pending', visit, estimatedDuration: 30 },
      { id: 'c', status: 'pending', visit, estimatedDuration: 25 },
    ]);
    expect(stopSummaryLabel(stop)).toBe('2 services · ~55 min');
  });
});

describe('stopWindow / stopPropertyAlerts (codex #3603 r1)', () => {
  it('a grouped stop spans the union of member windows; a single row keeps its own display', () => {
    const [grouped] = groupServicesIntoStops([
      { id: 'a', status: 'pending', visit, windowStart: '10:00', windowEnd: '11:00' },
      { id: 'c', status: 'pending', visit, windowStart: '09:00', windowEnd: '10:00' },
    ]);
    expect(stopWindow(grouped)).toEqual({ windowStart: '09:00', windowEnd: '11:00', windowDisplay: null });
    const [single] = groupServicesIntoStops([{ id: 'x', status: 'pending', windowStart: '13:00', windowEnd: '14:00', windowDisplay: '1–2 PM' }]);
    expect(stopWindow(single)).toEqual({ windowStart: '13:00', windowEnd: '14:00', windowDisplay: '1–2 PM' });
  });
  it('a duplicate gate line keeps the copy tagged with its directory entry', () => {
    const tagged = { type: 'gate', text: 'Gate: 4242 (neighborhood)', neighborhoodEntryId: 'e1', neighborhoodEntryCode: '4242', reportedWrong: false };
    const [grouped] = groupServicesIntoStops([
      { id: 'a', status: 'skipped', visit, propertyAlerts: [{ type: 'gate', text: 'Gate: 4242 (neighborhood)' }, 'Dog in yard'] },
      { id: 'c', status: 'pending', visit, propertyAlerts: [tagged] },
    ]);
    expect(stopPropertyAlerts(grouped)).toEqual([tagged, 'Dog in yard']);
  });
  it('merges every member\'s alerts, deduplicated by text, keeping object form', () => {
    const [grouped] = groupServicesIntoStops([
      { id: 'a', status: 'pending', visit, propertyAlerts: [{ type: 'gate', text: 'Gate 1234' }, 'Dog in yard'] },
      { id: 'c', status: 'pending', visit, propertyAlerts: ['Gate 1234', { type: 'chemical', text: 'Exterior only' }] },
    ]);
    expect(stopPropertyAlerts(grouped)).toEqual([{ type: 'gate', text: 'Gate 1234' }, 'Dog in yard', { type: 'chemical', text: 'Exterior only' }]);
  });
});

// Customer-visit-photos scope doc §5.4 item 2 (PR 3b) — the stop chip.
describe('stopHasCustomerSentPhotos (PR 3b)', () => {
  it('false for a single row with no flag', () => {
    const [stop] = groupServicesIntoStops([{ id: 'a', status: 'pending' }]);
    expect(stopHasCustomerSentPhotos(stop)).toBe(false);
  });
  it('true for a single row the server flagged', () => {
    const [stop] = groupServicesIntoStops([{ id: 'a', status: 'pending', customerSentPhotos: true }]);
    expect(stopHasCustomerSentPhotos(stop)).toBe(true);
  });
  it('a grouped stop reads true when ANY member carries the flag — shown once for the whole stop', () => {
    const [stop] = groupServicesIntoStops([
      { id: 'a', status: 'pending', visit, customerSentPhotos: false },
      { id: 'c', status: 'pending', visit, customerSentPhotos: true },
    ]);
    expect(stop.isVisit).toBe(true);
    expect(stopHasCustomerSentPhotos(stop)).toBe(true);
  });
  it('false when gate-off omitted the field entirely on every member (undefined, not false)', () => {
    const [stop] = groupServicesIntoStops([
      { id: 'a', status: 'pending', visit },
      { id: 'c', status: 'pending', visit },
    ]);
    expect(stopHasCustomerSentPhotos(stop)).toBe(false);
  });
  it('null/undefined stop is false, never a throw', () => {
    expect(stopHasCustomerSentPhotos(null)).toBe(false);
    expect(stopHasCustomerSentPhotos(undefined)).toBe(false);
  });
});

// The tech starts the next stop before finishing the last one in the app:
// the current stop is the one arrived at LAST, not the first on site.
describe('currentStopOf / stillOpenStopsOf', () => {
  const at = (id, status, checkInTime) => ({ id, status, checkInTime });
  it('picks the on-site stop arrived at last, not the first one on site', () => {
    const stops = groupServicesIntoStops([
      at('a', 'completed', '2026-11-04T15:00:00Z'),
      at('b', 'on_site', '2026-11-04T17:02:00Z'),
      at('c', 'on_site', '2026-11-04T18:33:00Z'),
      at('d', 'on_site', '2026-11-04T19:07:00Z'),
      at('e', 'confirmed'),
    ]);
    expect(currentStopOf(stops).primary.id).toBe('d');
    expect(stillOpenStopsOf(stops, currentStopOf(stops)).map((st) => st.primary.id)).toEqual(['b', 'c']);
  });
  it('orders the still-open stops oldest arrival first whatever the route order', () => {
    const stops = groupServicesIntoStops([
      at('a', 'on_site', '2026-11-04T18:00:00Z'),
      at('b', 'on_site', '2026-11-04T16:00:00Z'),
      at('c', 'on_site', '2026-11-04T19:00:00Z'),
    ]);
    const current = currentStopOf(stops);
    expect(current.primary.id).toBe('c');
    expect(stillOpenStopsOf(stops, current).map((st) => st.primary.id)).toEqual(['b', 'a']);
  });
  it('keeps route order when no on-site stop has a readable time, and a timed stop beats an untimed one', () => {
    const untimed = groupServicesIntoStops([at('a', 'on_site'), at('b', 'on_site', 'not a date')]);
    expect(currentStopOf(untimed).primary.id).toBe('a');
    const mixed = groupServicesIntoStops([at('a', 'on_site'), at('b', 'on_site', '2026-11-04T16:00:00Z')]);
    expect(currentStopOf(mixed).primary.id).toBe('b');
    expect(stopArrivalMs(mixed[0])).toBeNull();
  });
  it('falls back to the en_route stop, then the next stop, and stills nothing open', () => {
    const enRoute = groupServicesIntoStops([at('a', 'completed'), at('b', 'confirmed'), at('c', 'en_route')]);
    expect(currentStopOf(enRoute).primary.id).toBe('c');
    const next = groupServicesIntoStops([at('a', 'completed'), at('b', 'confirmed')]);
    expect(currentStopOf(next).primary.id).toBe('b');
    expect(stillOpenStopsOf(next, currentStopOf(next))).toEqual([]);
    expect(currentStopOf([])).toBeNull();
  });
  it('reads a grouped stop\'s arrival from its earliest on-site member', () => {
    const stops = groupServicesIntoStops([
      { id: 'a', status: 'on_site', visit: { id: 'v' }, checkInTime: '2026-11-04T17:30:00Z' },
      { id: 'b', status: 'on_site', visit: { id: 'v' }, checkInTime: '2026-11-04T17:00:00Z' },
    ]);
    expect(stopArrivalMs(stops[0])).toBe(Date.parse('2026-11-04T17:00:00Z'));
  });
});

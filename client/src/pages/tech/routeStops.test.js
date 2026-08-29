import { describe, expect, it } from 'vitest';
import { groupServicesIntoStops, nextStopOf, stopSummaryLabel, stopWindow, stopPropertyAlerts } from './routeStops';

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
  it('merges every member\'s alerts, deduplicated by text, keeping object form', () => {
    const [grouped] = groupServicesIntoStops([
      { id: 'a', status: 'pending', visit, propertyAlerts: [{ type: 'gate', text: 'Gate 1234' }, 'Dog in yard'] },
      { id: 'c', status: 'pending', visit, propertyAlerts: ['Gate 1234', { type: 'chemical', text: 'Exterior only' }] },
    ]);
    expect(stopPropertyAlerts(grouped)).toEqual([{ type: 'gate', text: 'Gate 1234' }, 'Dog in yard', { type: 'chemical', text: 'Exterior only' }]);
  });
});

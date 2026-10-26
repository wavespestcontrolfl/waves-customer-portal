import { describe, expect, it } from 'vitest';
import { acceptedRowsFor, accessLinesOf, scheduleAccessOn } from './schedule-access';

// Alert text exactly as server/services/nextstop-alerts.js composes it.
const row = (alerts, extra = {}) => ({ id: 'visit-1', scheduleAccessEnabled: true, propertyAlerts: alerts, ...extra });

describe('accessLinesOf', () => {
  it('draws nothing while the gate is off, even when the row has gate alerts', () => {
    const off = { id: 'visit-1', propertyAlerts: [{ type: 'gate', text: 'Gate: 1234' }] };
    expect(scheduleAccessOn(off)).toBe(false);
    expect(accessLinesOf(off)).toEqual([]);
    expect(accessLinesOf({ ...off, scheduleAccessEnabled: 'true' })).toEqual([]);
    expect(accessLinesOf(null)).toEqual([]);
  });

  it("reads the customer's own gate code and the profile's other codes", () => {
    const lines = accessLinesOf(row([
      { type: 'gate', text: 'Gate: 1234' },
      { type: 'gate', text: 'Yard: 5678' },
      { type: 'gate', text: 'Garage: 2468' },
      { type: 'gate', text: 'Lockbox: 1357' },
      { type: 'pet', text: '2 dogs' },
      { type: 'access', text: 'Side gate: left' },
    ]));
    expect(lines.map((l) => [l.label, l.value, l.kind, l.neighborhood])).toEqual([
      ['Gate', '1234', 'neighborhood_gate', false],
      ['Yard', '5678', 'property_gate', false],
      ['Garage', '2468', 'garage', false],
      ['Lockbox', '1357', 'lockbox', false],
    ]);
    expect(lines.every((l) => l.codeLike && !l.unconfirmed)).toBe(true);
  });

  it('tags a neighborhood code, and an unconfirmed one, and keeps its entry for the actions', () => {
    const lines = accessLinesOf(row([
      { type: 'gate', text: 'Gate: #4821 (neighborhood)', neighborhoodEntryId: 'e-1', neighborhoodEntryCode: '#4821', reportedWrong: false },
      { type: 'gate', text: 'North gate: #2424 (neighborhood, confirm on site)', neighborhoodEntryId: 'e-2', neighborhoodEntryCode: '#2424', reportedWrong: true },
    ]));
    expect(lines[0]).toMatchObject({ label: 'Gate', value: '#4821', kind: 'neighborhood_gate', neighborhood: true, unconfirmed: false, entryId: 'e-1', entryCode: '#4821', reportedWrong: false });
    expect(lines[1]).toMatchObject({ label: 'North gate', value: '#2424', kind: 'neighborhood_gate', neighborhood: true, unconfirmed: true, entryId: 'e-2', reportedWrong: true });
  });

  it('a neighborhood entry with directions reads as text, and a gate label never takes a profile kind', () => {
    const lines = accessLinesOf(row([
      { type: 'gate', text: 'Garage: press call box button 102 and wait for the guard (neighborhood)' },
    ]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'neighborhood_gate', neighborhood: true, codeLike: false });
    expect(lines[0].value).toBe('press call box button 102 and wait for the guard');
  });

  it('skips malformed and repeated lines', () => {
    const lines = accessLinesOf(row([
      { type: 'gate', text: 'Gate: 1234' },
      { type: 'gate', text: 'Gate: 1234' },
      { type: 'gate', text: 'no separator' },
      { type: 'gate', text: 'Gate: ' },
      { type: 'gate' },
      null,
    ]));
    expect(lines.map((l) => l.value)).toEqual(['1234']);
  });
});

describe('acceptedRowsFor', () => {
  const service = { id: 'visit-1' };
  const lines = accessLinesOf(row([{ type: 'gate', text: 'Gate: # 4821' }, { type: 'gate', text: 'Lockbox: 1357' }]));

  it('keeps standing codes and this visit\'s one-visit codes, never another visit\'s', () => {
    const rows = [
      { id: 'a', kind: 'door', code: '9999', life: 'standing' },
      { id: 'b', kind: 'door', code: '8888', life: 'visit', scheduledServiceId: 'visit-1' },
      { id: 'c', kind: 'door', code: '7777', life: 'visit', scheduledServiceId: 'visit-2' },
    ];
    expect(acceptedRowsFor(service, rows, lines).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('hides a row only when a line shows the same code for the same access point', () => {
    const rows = [
      { id: 'same', kind: 'neighborhood_gate', code: '#4821', life: 'standing' },
      { id: 'other-point', kind: 'door', code: '1357', life: 'standing' },
      { id: 'with-directions', kind: 'lockbox', code: '1357', instructions: 'left of the door', life: 'standing' },
      { id: 'pass', kind: 'pass', code: null, instructions: 'https://pass.example.invalid/abc', life: 'standing' },
      { id: 'empty', kind: 'other', code: null, instructions: null, life: 'standing' },
    ];
    expect(acceptedRowsFor(service, rows, lines).map((r) => r.id)).toEqual(['other-point', 'with-directions', 'pass']);
  });

  it('copes with a missing list', () => {
    expect(acceptedRowsFor(service, undefined, lines)).toEqual([]);
  });
});

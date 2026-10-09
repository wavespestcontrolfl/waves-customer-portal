// @vitest-environment jsdom
// The station checks for one visit, composed (useStationChecks): "all stations OK"
// is asserted, to the report writer (currentChecks) or to the record (entries),
// only when the note's read is KNOWN to have succeeded for the CURRENT note text,
// or the tech confirmed the stations by hand.
import { describe, expect, test, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { NO_STATION_READ, useStationChecks } from './FastCompleteStations';

const circle = { type: 'circle', cx: 0.4, cy: 0.5, r: 0.03 };
const REGISTRY = {
  available: true, stationsLoaded: true,
  stations: [1, 2, 3].map((n) => ({ id: `st-${n}`, number: n, program: 'termite', geometryImage: circle, staleMark: false })),
};
const SERVICE = { id: 'svc-1', typedType: 'termite_bait_station' };
const N = 'station 2 had activity';
const read = (result, note, ok = true, extra = {}) => {
  act(() => { result.current.stationRead.begin(note); });
  let message;
  act(() => { message = result.current.stationRead.check({ stationRead: ok ? 'read' : 'failed', ...extra }, note); });
  return message;
};

async function mount(initialNote = N) {
  const request = vi.fn(async () => REGISTRY);
  const hook = renderHook(({ note }) => useStationChecks({ service: SERVICE, request, enabled: true, note }), { initialProps: { note: initialNote } });
  await vi.waitFor(() => expect(hook.result.current.state).toBe('ready'));
  return { ...hook, request };
}

describe('useStationChecks', () => {
  test('before any read nothing is asserted: no checks for the writer, no entries for the record', async () => {
    const { result } = await mount();
    expect(result.current.readStatus).toBe('none');
    expect(result.current.currentChecks()).toBeNull();
    expect(result.current.entries()).toEqual([]);
    expect(result.current.gate.complete).toMatch(/hasn’t been read/);
  });

  test('a read that succeeded for this note asserts; a changed note is not read again; the same text is', async () => {
    const { result, rerender } = await mount();
    act(() => { result.current.stationRead.begin(N); });
    expect(result.current.readStatus).toBe('reading');
    expect(result.current.entries()).toEqual([]);
    expect(read(result, N)).toBe('');
    expect(result.current.readStatus).toBe('ok');
    expect(result.current.currentChecks()).toEqual([]);
    expect(result.current.entries()).toHaveLength(3);
    expect(result.current.gate.complete).toBe('');
    rerender({ note: `${N}. Station 3 was buried.` });
    expect(result.current.readStatus).toBe('none');
    expect(result.current.currentChecks()).toBeNull();
    expect(result.current.entries()).toEqual([]);
    expect(result.current.gate.complete).toMatch(/hasn’t been read/);
    rerender({ note: N });
    expect(result.current.readStatus).toBe('ok');
  });

  test('a failed read asserts nothing and says why; a failed refresh of a note already read changes nothing', async () => {
    const { result } = await mount();
    expect(read(result, N, false)).toMatch(/Couldn’t read the stations from your note/);
    expect(result.current.readStatus).toBe('failed');
    expect(result.current.currentChecks()).toBeNull();
    expect(result.current.entries()).toEqual([]);
    expect(result.current.gate.complete).toMatch(/Couldn’t read the stations/);
    expect(result.current.cardOpen).toBe(true);
    read(result, N);
    expect(result.current.readStatus).toBe('ok');
    // The refresh begins and fails: the note stays read.
    act(() => { result.current.stationRead.begin(N); });
    expect(result.current.readStatus).toBe('ok');
    // It stands on the retained read: no failure for the report write.
    expect(read(result, N, false)).toBe('');
    expect(result.current.readStatus).toBe('ok');
    expect(result.current.currentChecks()).toEqual([]);
  });

  test('an unresolved read asserts nothing, says why, and pre-marks the exceptions that verified', async () => {
    const { result } = await mount();
    act(() => { result.current.stationRead.begin(N); });
    let message;
    act(() => {
      message = result.current.stationRead.check({
        stationRead: 'failed', stationReadDetail: 'unresolved', stationExceptions: [{ id: 'st-2', status: 'activity', quote: N }],
      }, N);
    });
    expect(message).toMatch(/Couldn’t match everything you said about the stations/);
    expect(result.current.readStatus).toBe('unresolved');
    expect(result.current.currentChecks()).toBeNull();
    expect(result.current.entries()).toEqual([]);
    expect(result.current.gate.complete).toMatch(/Mark them by hand and confirm/);
    expect(result.current.marks.statuses).toEqual({ 'st-2': 'activity' });
    // The hand check then stands on the marks the tech sees.
    act(() => { result.current.confirmByHand(); });
    expect(result.current.currentChecks()).toEqual([{ number: 2, status: 'activity' }]);
  });

  test('a roster that changed under the sheet loads the registry again and clears what was read', async () => {
    const { result, request } = await mount();
    read(result, N);
    const message = read(result, N, false, { stationReadDetail: 'roster_changed' });
    expect(message).toMatch(/changed/);
    expect(result.current.readStatus).toBe('none');
    expect(result.current.entries()).toEqual([]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });

  test('confirmed by hand: the hand marks stand, and the note is not read for stations', async () => {
    const { result } = await mount();
    act(() => { result.current.flag('st-2'); });
    expect(result.current.currentChecks()).toBeNull();
    act(() => { result.current.confirmByHand(); });
    expect(result.current.readStatus).toBe('hand');
    expect(result.current.stationRead).toBe(NO_STATION_READ);
    expect(result.current.currentChecks()).toEqual([{ number: 2, status: 'activity' }]);
    expect(result.current.entries().map((entry) => entry.status)).toEqual(['ok', 'activity', 'ok']);
    act(() => { result.current.readFromNote(); });
    expect(result.current.currentChecks()).toBeNull();
    expect(result.current.stationRead).not.toBe(NO_STATION_READ);
  });

  test('a visit with no stations flow is inert', async () => {
    const request = vi.fn(async () => REGISTRY);
    const { result } = renderHook(() => useStationChecks({ service: SERVICE, request, enabled: false, note: N }));
    expect(result.current.active).toBe(false);
    expect(result.current.stationRead).toBe(NO_STATION_READ);
    expect(result.current.entries()).toEqual([]);
    expect(result.current.gate.generate).toBe('');
    expect(request).not.toHaveBeenCalled();
  });
});

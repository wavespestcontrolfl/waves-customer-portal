// @vitest-environment jsdom
// The station read's state per note version (GATE_STATION_FAST_COMPLETE): "all
// stations OK" may be asserted, to the report writer (currentChecks) or to the
// record (entries), only when the note's read is KNOWN to have succeeded for the
// CURRENT note text, or the tech confirmed the stations by hand.
import { describe, expect, test, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useStationChecks } from './FastCompleteStations';

const circle = { type: 'circle', cx: 0.4, cy: 0.5, r: 0.03 };
const REGISTRY = {
  available: true, stationsLoaded: true,
  stations: [1, 2, 3].map((n) => ({ id: `st-${n}`, number: n, program: 'termite', geometryImage: circle, staleMark: false })),
};
const SERVICE = { id: 'svc-1', typedType: 'termite_bait_station' };

async function mount(initialNote = 'station 2 had activity') {
  const request = vi.fn(async () => REGISTRY);
  const hook = renderHook(({ note }) => useStationChecks({ service: SERVICE, request, enabled: true, note }), { initialProps: { note: initialNote } });
  await vi.waitFor(() => expect(hook.result.current.state).toBe('ready'));
  return hook;
}

describe('useStationChecks read state', () => {
  test('before any read nothing is asserted: no checks for the writer, no entries for the record', async () => {
    const { result } = await mount();
    expect(result.current.readStatus).toBe('none');
    expect(result.current.assertable()).toBe(false);
    expect(result.current.currentChecks()).toBeNull();
    expect(result.current.entries()).toEqual([]);
    expect(result.current.readHold).toMatch(/hasn’t been read/);
  });

  test('a read that succeeded for this note asserts; a changed note is not read again', async () => {
    const { result, rerender } = await mount();
    act(() => { result.current.stationRead.begin('station 2 had activity'); });
    expect(result.current.readStatus).toBe('reading');
    expect(result.current.entries()).toEqual([]);
    act(() => { result.current.stationRead.settle(true, 'station 2 had activity'); });
    expect(result.current.readStatus).toBe('ok');
    expect(result.current.currentChecks()).toEqual([]);
    expect(result.current.entries()).toHaveLength(3);
    expect(result.current.readHold).toBe('');
    rerender({ note: 'station 2 had activity. Station 3 was buried.' });
    expect(result.current.readStatus).toBe('none');
    expect(result.current.assertable()).toBe(false);
    expect(result.current.currentChecks()).toBeNull();
    expect(result.current.entries()).toEqual([]);
    expect(result.current.readHold).toMatch(/hasn’t been read/);
    // Back to the text that was read.
    rerender({ note: 'station 2 had activity' });
    expect(result.current.readStatus).toBe('ok');
  });

  test('a failed read asserts nothing and holds with a plain message; a failed refresh never downgrades a note already read', async () => {
    const { result } = await mount();
    act(() => { result.current.stationRead.begin('station 2 had activity'); });
    act(() => { result.current.stationRead.settle(false, 'station 2 had activity'); });
    expect(result.current.readStatus).toBe('failed');
    expect(result.current.currentChecks()).toBeNull();
    expect(result.current.entries()).toEqual([]);
    expect(result.current.readHold).toMatch(/Couldn’t read the stations/);
    act(() => { result.current.stationRead.settle(true, 'station 2 had activity'); });
    act(() => { result.current.stationRead.settle(false, 'station 2 had activity'); });
    expect(result.current.readStatus).toBe('ok');
  });

  test('confirmed by hand: the hand marks stand, and the note is not read for stations', async () => {
    const { result } = await mount();
    act(() => { result.current.flag('st-2'); });
    expect(result.current.assertable()).toBe(false);
    act(() => { result.current.confirmByHand(); });
    expect(result.current.readStatus).toBe('hand');
    expect(result.current.stationRead).toBeNull();
    expect(result.current.currentChecks()).toEqual([{ number: 2, status: 'activity' }]);
    expect(result.current.entries().map((entry) => entry.status)).toEqual(['ok', 'activity', 'ok']);
    act(() => { result.current.readFromNote(); });
    expect(result.current.currentChecks()).toBeNull();
    expect(result.current.stationRead).not.toBeNull();
  });
});

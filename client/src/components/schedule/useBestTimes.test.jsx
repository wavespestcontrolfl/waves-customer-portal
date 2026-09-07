// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useBestTimes } from './useBestTimes';

afterEach(() => { vi.unstubAllGlobals(); });

const daySlot = {
  date: '2035-01-02', start_time: '10:00', end_time: '11:00', detour_minutes: 12, drive_in_minutes: 8,
  insertion: { after_name: 'Stop C', after_stop_id: 's-c' }, technician: { id: 'tech', name: 'A' },
};
const rangeSlot = {
  date: '2035-01-03', start_time: '13:00', end_time: '14:00', detour_minutes: 3, drive_in_minutes: 5,
  insertion: { after_name: null, after_stop_id: null }, technician: { id: 'tech', name: 'A' },
};

it('scores the picked hour on the day and searches the next 3 days for the single best date+hour', async () => {
  const fetch = vi.fn().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init.body);
    return body.dateFrom === body.dateTo
      ? { ok: true, json: async () => ({ slots: [daySlot], picked: { start: '09:00', fits: true, detour_minutes: 57, drive_in_minutes: 37, from_home_base: true, from_name: null, technician: { id: 'tech', name: 'A' } } }) }
      : { ok: true, json: async () => ({ slots: [rangeSlot] }) };
  });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({
    date: '2035-01-02', serviceId: 'fixture', technicianId: 'tech', pickedStart: '09:00', rangeFrom: '2035-01-01', sameDayFloorMin: 14 * 60,
  }));
  await waitFor(() => expect(result.current.bestInRange).not.toBeNull());
  const bodies = fetch.mock.calls.map((c) => JSON.parse(c[1].body));
  expect(bodies).toHaveLength(2);
  expect(bodies.find((b) => b.pickedStart)).toMatchObject({ dateFrom: '2035-01-02', dateTo: '2035-01-02', pickedStart: '09:00', topN: 3, slotStepMinutes: 60 });
  expect(bodies.find((b) => !b.pickedStart)).toMatchObject({ dateFrom: '2035-01-01', dateTo: '2035-01-04', topN: 1, sameDayFloorMin: 840 });
  expect(bodies.every((b) => b.sameDayFloorMin === 840)).toBe(true);
  expect(result.current.picked).toEqual({
    start: '09:00', fits: true, detourMinutes: 57, driveInMinutes: 37, fromHomeBase: true, fromName: null,
    technicianId: 'tech', technicianName: null,
  });
  expect(result.current.bestTimes[0]).toMatchObject({ date: '2035-01-02', start: '10:00', driveInMinutes: 8, fromHomeBase: false, fromName: 'Stop C' });
  expect(result.current.bestInRange).toMatchObject({ date: '2035-01-03', start: '13:00', driveInMinutes: 5, fromHomeBase: true });
});

it('trims a stored HH:MM:SS window to the picked hour (edit form initial state)', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slots: [] }) });
  vi.stubGlobal('fetch', fetch);
  renderHook(() => useBestTimes({ date: '2035-01-02', serviceId: 'fixture', technicianId: 'tech', pickedStart: '09:00:00', pickedEnd: '12:00:00' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ pickedStart: '09:00', pickedEnd: '12:00' });
});

it('skips the range search without rangeFrom and never sends a half-typed picked hour', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slots: [] }) });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({ date: '2035-01-02', serviceId: 'fixture', technicianId: 'tech', pickedStart: '9' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(JSON.parse(fetch.mock.calls[0][1].body).pickedStart).toBeUndefined();
  expect(result.current.picked).toBeNull();
  expect(result.current.bestInRange).toBeNull();
});

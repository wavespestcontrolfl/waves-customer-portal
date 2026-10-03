// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useBestTimes, resetSummaryAvailability } from './useBestTimes';

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

it('enabled:false searches nothing — the edit form turns the hint off for a completed visit', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slots: [] }) });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({
    enabled: false, date: '2035-01-02', serviceId: 'fixture', technicianId: 'tech', pickedStart: '09:00', rangeFrom: '2035-01-01',
  }));
  // Past the hook's 300ms debounce: nothing may have been sent.
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(fetch).not.toHaveBeenCalled();
  expect(result.current).toMatchObject({ bestTimes: [], picked: null, bestInRange: null, checking: false });
});

it('a pending Service address travels as propertyId and a change re-runs the search (edit form)', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slots: [] }) });
  vi.stubGlobal('fetch', fetch);
  const { rerender } = renderHook(
    (props) => useBestTimes({ date: '2035-01-02', serviceId: 'fixture', technicianId: 'tech', ...props }),
    { initialProps: { propertyId: undefined } },
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect('propertyId' in JSON.parse(fetch.mock.calls[0][1].body)).toBe(false);
  rerender({ propertyId: 'prop-2' });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ propertyId: 'prop-2', serviceId: 'fixture' });
});

it('durationEdit rides only when the caller saves the duration (edit form); a move sends none', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slots: [] }) });
  vi.stubGlobal('fetch', fetch);
  const { rerender } = renderHook(
    (props) => useBestTimes({ date: '2035-01-02', serviceId: 'fixture', technicianId: 'tech', arrivalWindows: true, durationMinutes: 60, ...props }),
    { initialProps: { durationEdit: undefined } },
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect('durationEdit' in JSON.parse(fetch.mock.calls[0][1].body)).toBe(false);
  rerender({ durationEdit: true });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ durationEdit: true, durationMinutes: 60 });
});

// ---- summary mode (availability strip) ----

beforeEach(() => { resetSummaryAvailability(); });

const summaryAnswer = {
  slots: [daySlot],
  picked: { start: '14:00', fits: false, reason: 'arrival_window' },
  summary: {
    days: [
      { date: '2035-01-01', status: 'full', hours: [] },
      { date: '2035-01-02', status: 'open', hours: [{ start_time: '10:00', end_time: '11:00', detour_minutes: 12, technician: { id: 'tech', name: 'A' } }] },
    ],
  },
};

it('summary mode: one search around the picked date answers availability and nothing else', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => summaryAnswer });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({
    summary: true, date: '2035-01-05', serviceId: 'fixture', technicianId: 'tech', pickedStart: '14:00', pickedEnd: '15:00', rangeFrom: '2035-01-01',
  }));
  await waitFor(() => expect(result.current.availability).not.toBeNull());
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
    hint: true, summary: true, dateFrom: '2035-01-02', dateTo: '2035-01-12', pickedDate: '2035-01-05', pickedStart: '14:00', pickedEnd: '15:00',
  });
  expect(result.current.availability).toEqual({
    pickedDate: '2035-01-05',
    days: [
      { date: '2035-01-01', status: 'full', hours: [] },
      { date: '2035-01-02', status: 'open', hours: [{ date: '2035-01-02', start: '10:00', end: '11:00', detourMinutes: 12, technicianId: 'tech', technicianName: null }] },
    ],
    picked: { start: '14:00', fits: false, reason: 'arrival_window', detourMinutes: null },
  });
  expect(result.current.bestTimes).toEqual([]);
  expect(result.current.bestInRange).toBeNull();
});

it('summary mode keeps "could not check" apart from a miss', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ ...summaryAnswer, picked: { start: '14:00', fits: null, reason: 'route_unverified' } }),
  }));
  const { result } = renderHook(() => useBestTimes({ summary: true, date: '2035-01-05', serviceId: 'fixture', technicianId: 'tech', pickedStart: '14:00' }));
  await waitFor(() => expect(result.current.availability).not.toBeNull());
  expect(result.current.availability.picked).toMatchObject({ fits: null, reason: 'route_unverified' });
});

it('gate off (no summary in the answer): falls back to the two searches and stops asking', async () => {
  const fetch = vi.fn().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ slots: body.dateFrom === body.dateTo ? [daySlot] : [rangeSlot] }) };
  });
  vi.stubGlobal('fetch', fetch);
  const props = { summary: true, serviceId: 'fixture', technicianId: 'tech', pickedStart: '09:00', rangeFrom: '2035-01-01' };
  const { result, rerender } = renderHook((p) => useBestTimes(p), { initialProps: { ...props, date: '2035-01-02' } });
  await waitFor(() => expect(result.current.bestInRange).not.toBeNull());
  expect(result.current.availability).toBeNull();
  expect(fetch.mock.calls.map((c) => !!JSON.parse(c[1].body).summary)).toEqual([true, false, false]);
  expect(result.current.bestTimes[0]).toMatchObject({ date: '2035-01-02', start: '10:00' });
  // The next pick does not ask for a summary again.
  rerender({ ...props, date: '2035-01-03' });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
  expect(fetch.mock.calls.slice(3).some((c) => JSON.parse(c[1].body).summary)).toBe(false);
});

it('hints gated altogether (parent kill switch): one request, then none for the cooldown', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ gated: true, slots: [] }) });
  vi.stubGlobal('fetch', fetch);
  const props = { summary: true, serviceId: 'fixture', technicianId: 'tech', pickedStart: '09:00', rangeFrom: '2035-01-01' };
  const { result, rerender } = renderHook((p) => useBestTimes(p), { initialProps: { ...props, date: '2035-01-02' } });
  await waitFor(() => expect(result.current.checking).toBe(false));
  expect(fetch).toHaveBeenCalledOnce();
  rerender({ ...props, date: '2035-01-03' });
  rerender({ ...props, summary: false, date: '2035-01-04' });
  await new Promise((r) => { setTimeout(r, 400); });
  expect(fetch).toHaveBeenCalledOnce();
  expect(result.current.availability).toBeNull();
  expect(result.current.bestTimes).toEqual([]);
});

it('a failed summary request falls back without marking the gate off', async () => {
  let call = 0;
  const fetch = vi.fn().mockImplementation(async () => {
    call += 1;
    return call === 1 ? { ok: false, json: async () => ({ error: 'boom' }) } : { ok: true, json: async () => ({ slots: [daySlot] }) };
  });
  vi.stubGlobal('fetch', fetch);
  const props = { summary: true, serviceId: 'fixture', technicianId: 'tech' };
  const { result, rerender } = renderHook((p) => useBestTimes(p), { initialProps: { ...props, date: '2035-01-02' } });
  await waitFor(() => expect(result.current.bestTimes).toHaveLength(1));
  rerender({ ...props, date: '2035-01-03' });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  expect(JSON.parse(fetch.mock.calls[2][1].body).summary).toBe(true);
});

it('a past date never asks for a summary', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slots: [] }) });
  vi.stubGlobal('fetch', fetch);
  renderHook(() => useBestTimes({ summary: true, date: '2020-01-02', serviceId: 'fixture', technicianId: 'tech' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(JSON.parse(fetch.mock.calls[0][1].body).summary).toBeUndefined();
});

it('a re-check for the same visit holds the last summary as stale instead of clearing it', async () => {
  let release;
  const fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => summaryAnswer })
    .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => summaryAnswer }); }));
  vi.stubGlobal('fetch', fetch);
  const props = { summary: true, date: '2035-01-05', serviceId: 'fixture', technicianId: 'tech' };
  const { result, rerender } = renderHook((p) => useBestTimes(p), { initialProps: { ...props, pickedStart: '14:00' } });
  await waitFor(() => expect(result.current.availability).not.toBeNull());
  expect(result.current.availability.stale).toBeUndefined();
  rerender({ ...props, pickedStart: '15:00' });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(result.current.availability).toMatchObject({ stale: true });
  release();
  await waitFor(() => expect(result.current.availability.stale).toBeUndefined());
  // A different visit never inherits the previous one's days.
  rerender({ ...props, serviceId: 'other-fixture', pickedStart: '15:00' });
  expect(result.current.availability).toBeNull();
});


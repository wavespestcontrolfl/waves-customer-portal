// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useBestTimes, resetHintsGated, resetOpenTimesUi } from './useBestTimes';
import { etDateString } from '../../lib/timezone';

afterEach(() => { vi.unstubAllGlobals(); });

const daySlot = {
  date: '2035-01-02', start_time: '10:00', end_time: '11:00', detour_minutes: 12, drive_in_minutes: 8,
  insertion: { after_name: 'Stop C', after_stop_id: 's-c' }, technician: { id: 'tech', name: 'A' },
};

it('trims a stored HH:MM:SS window to the picked hour (edit form initial state)', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slots: [] }) });
  vi.stubGlobal('fetch', fetch);
  renderHook(() => useBestTimes({ date: '2035-01-02', serviceId: 'fixture', technicianId: 'tech', pickedStart: '09:00:00', pickedEnd: '12:00:00' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ pickedStart: '09:00', pickedEnd: '12:00' });
});

it('never sends a half-typed picked hour', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slots: [] }) });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({ date: '2035-01-02', serviceId: 'fixture', technicianId: 'tech', pickedStart: '9' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(JSON.parse(fetch.mock.calls[0][1].body).pickedStart).toBeUndefined();
  expect(result.current.availability).toBeNull();
});

it('enabled:false searches nothing — the edit form turns the hint off for a completed visit', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slots: [] }) });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({
    enabled: false, date: '2035-01-02', serviceId: 'fixture', technicianId: 'tech', pickedStart: '09:00',
  }));
  // Past the hook's 300ms debounce: nothing may have been sent.
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(fetch).not.toHaveBeenCalled();
  expect(result.current).toMatchObject({ availability: null, pickedByTech: [], checking: false });
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

// ---- the availability strip's search ----

beforeEach(() => { resetHintsGated(); });

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

it('passes a last-resort day through, and a closed day stays closed', async () => {
  const hours = [{ start_time: '10:00', end_time: '11:00', detour_minutes: 12, technician: { id: 'tech', name: 'A' } }];
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      ...summaryAnswer,
      summary: {
        days: [
          { date: '2035-01-07', status: 'open', last_resort: true, hours },
          { date: '2035-01-08', status: 'open', closed: true, hours },
          { date: '2035-01-09', status: 'open', last_resort: false, hours },
        ],
      },
    }),
  });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({
    date: '2035-01-05', serviceId: 'fixture', technicianId: 'tech', pickedStart: '14:00', pickedEnd: '15:00',
  }));
  await waitFor(() => expect(result.current.availability).not.toBeNull());
  const [sunday, closed, plain] = result.current.availability.days;
  expect(sunday).toMatchObject({ date: '2035-01-07', last_resort: true });
  expect(sunday.closed).toBeUndefined();
  expect(closed.closed).toBe(true);
  expect(plain.last_resort).toBeUndefined();
});

it('one search around the picked date answers availability', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => summaryAnswer });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({
    date: '2035-01-05', serviceId: 'fixture', technicianId: 'tech', pickedStart: '14:00', pickedEnd: '15:00',
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
      { date: '2035-01-02', status: 'open', hours: [{
        date: '2035-01-02', start: '10:00', end: '11:00', detourMinutes: 12, driveInMinutes: null, fromHomeBase: null, fromName: null,
        driveSource: null, rainChance: null, stopsThatDay: null, technicianId: 'tech', technicianName: null,
      }] },
    ],
    best: null,
    picked: {
      start: '14:00', fits: false, reason: 'arrival_window', detourMinutes: null,
      driveInMinutes: null, fromHomeBase: null, fromName: null, driveSource: null, rainChance: null,
    },
  });
});

it('a pick two weeks out asks once more for the next-7-days row (Codex #6045 r1)', async () => {
  const far = {
    ...summaryAnswer,
    summary: { ...summaryAnswer.summary, best: { day: [], week: [], week_covered: false } },
  };
  const week = {
    slots: [],
    summary: { days: [], best: { day: [], week: [{ date: '2035-01-02', start_time: '10:00', end_time: '11:00', detour_minutes: 12 }], week_covered: true } },
  };
  const fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => far })
    .mockResolvedValueOnce({ ok: true, json: async () => week });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({
    bestRows: true, date: '2035-01-05', serviceId: 'fixture', technicianId: 'tech', pickedStart: '14:00',
  }));
  await waitFor(() => expect(result.current.availability).not.toBeNull());
  expect(fetch).toHaveBeenCalledTimes(2);
  // The picked search keeps its window around the pick (Codex #6045 r2).
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ bestRows: true, dateFrom: '2035-01-02', dateTo: '2035-01-12' });
  const second = JSON.parse(fetch.mock.calls[1][1].body);
  expect(second).toMatchObject({ summary: true, pickedDate: '2035-01-05' });
  expect(second.pickedStart).toBeUndefined();
  expect(result.current.availability.best.weekCovered).toBe(true);
  expect(result.current.availability.best.week.map((h) => h.start)).toEqual(['10:00']);
  // The pills stay the picked search's days.
  expect(result.current.availability.days.map((d) => d.date)).toEqual(['2035-01-01', '2035-01-02']);
});

it('best rows send the booking\'s services on every request, the week fallback included (Codex #6102 r1)', async () => {
  const far = {
    ...summaryAnswer,
    summary: { ...summaryAnswer.summary, best: { day: [], week: [], week_covered: false } },
  };
  const week = { slots: [], summary: { days: [], best: { day: [], week: [], week_covered: true } } };
  const fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => far })
    .mockResolvedValueOnce({ ok: true, json: async () => week });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({
    bestRows: true, date: '2035-01-05', serviceId: 'fixture', technicianId: 'tech', pickedStart: '14:00',
    serviceTypes: ['General Pest Control', 'WDO Inspection'],
    serviceKeys: ['pest_general_quarterly', ''],
  }));
  await waitFor(() => expect(result.current.availability).not.toBeNull());
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const call of fetch.mock.calls) {
    expect(JSON.parse(call[1].body).serviceTypes).toEqual(['General Pest Control', 'WDO Inspection']);
    // The selected catalog rows' keys ride in the same order (Codex #6120 r1).
    expect(JSON.parse(call[1].body).serviceKeys).toEqual(['pest_general_quarterly', '']);
  }
});

it('without bestRows never asks for the rows', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => summaryAnswer });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({ date: '2035-01-05', serviceId: 'fixture', technicianId: 'tech', pickedStart: '14:00' }));
  await waitFor(() => expect(result.current.availability).not.toBeNull());
  expect(JSON.parse(fetch.mock.calls[0][1].body).bestRows).toBeUndefined();
  expect(fetch).toHaveBeenCalledOnce();
});

it('keeps "could not check" apart from a miss', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ ...summaryAnswer, picked: { start: '14:00', fits: null, reason: 'route_unverified' } }),
  }));
  const { result } = renderHook(() => useBestTimes({ date: '2035-01-05', serviceId: 'fixture', technicianId: 'tech', pickedStart: '14:00' }));
  await waitFor(() => expect(result.current.availability).not.toBeNull());
  expect(result.current.availability.picked).toMatchObject({ fits: null, reason: 'route_unverified' });
});

it('an answer with no summary shows no strip and does not fall back to other searches', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slots: [daySlot] }) });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({ date: '2035-01-02', serviceId: 'fixture', technicianId: 'tech', pickedStart: '09:00' }));
  await waitFor(() => expect(result.current.checking).toBe(false));
  expect(result.current.availability).toBeNull();
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ hint: true, summary: true });
});

it('hints gated altogether (kill switch): one request, then none for the cooldown', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ gated: true, slots: [] }) });
  vi.stubGlobal('fetch', fetch);
  const props = { serviceId: 'fixture', technicianId: 'tech', pickedStart: '09:00' };
  const { result, rerender } = renderHook((p) => useBestTimes(p), { initialProps: { ...props, date: '2035-01-02' } });
  await waitFor(() => expect(result.current.checking).toBe(false));
  expect(fetch).toHaveBeenCalledOnce();
  rerender({ ...props, date: '2035-01-03' });
  await new Promise((r) => { setTimeout(r, 400); });
  expect(fetch).toHaveBeenCalledOnce();
  expect(result.current.availability).toBeNull();
  expect(result.current.gated).toBe(true);
});

it('a failed search shows no strip and the next pick asks again', async () => {
  let call = 0;
  const fetch = vi.fn().mockImplementation(async () => {
    call += 1;
    return call === 1 ? { ok: false, json: async () => ({ error: 'boom' }) } : { ok: true, json: async () => summaryAnswer };
  });
  vi.stubGlobal('fetch', fetch);
  const props = { serviceId: 'fixture', technicianId: 'tech' };
  const { result, rerender } = renderHook((p) => useBestTimes(p), { initialProps: { ...props, date: '2035-01-02' } });
  await waitFor(() => expect(result.current.checking).toBe(false));
  expect(result.current.availability).toBeNull();
  expect(result.current.gated).toBe(false);
  rerender({ ...props, date: '2035-01-03' });
  await waitFor(() => expect(result.current.availability).not.toBeNull());
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('a past date searches nothing (the engine never searches before today)', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => summaryAnswer });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({ date: '2020-01-02', serviceId: 'fixture', technicianId: 'tech' }));
  await new Promise((r) => { setTimeout(r, 400); });
  expect(fetch).not.toHaveBeenCalled();
  expect(result.current).toMatchObject({ availability: null, checking: false, gated: false });
});

it('a re-check for the same visit holds the last summary as stale instead of clearing it', async () => {
  let release;
  const fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => summaryAnswer })
    .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => summaryAnswer }); }));
  vi.stubGlobal('fetch', fetch);
  const props = { date: '2035-01-05', serviceId: 'fixture', technicianId: 'tech' };
  const { result, rerender } = renderHook((p) => useBestTimes(p), { initialProps: { ...props, pickedStart: '14:00' } });
  await waitFor(() => expect(result.current.availability).not.toBeNull());
  expect(result.current.availability.stale).toBeUndefined();
  rerender({ ...props, pickedStart: '15:00' });
  // Stale from the very render that carries the new input, before the
  // debounce or any request: the old verdict never paints as current.
  expect(result.current.availability).toMatchObject({ stale: true });
  expect(fetch).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(result.current.availability).toMatchObject({ stale: true });
  release();
  await waitFor(() => expect(result.current.availability.stale).toBeUndefined());
  // A different visit never inherits the previous one's days.
  rerender({ ...props, serviceId: 'other-fixture', pickedStart: '15:00' });
  expect(result.current.availability).toBeNull();
});

it('the move choice on a shared stop rides the request, and changing it searches again', async () => {
  const fetch = vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ slots: [daySlot] }) }));
  vi.stubGlobal('fetch', fetch);
  const { rerender } = renderHook(({ moveScope }) => useBestTimes({ date: '2035-01-02', serviceId: 'combo-fixture', technicianId: 'tech', arrivalWindows: true, moveScope }), { initialProps: { moveScope: 'together' } });
  // Only this hook's own requests (an earlier test's debounce can still fire).
  const scopes = () => fetch.mock.calls.map((c) => JSON.parse(c[1].body)).filter((body) => body.serviceId === 'combo-fixture').map((body) => body.moveScope);
  await waitFor(() => expect(scopes().length).toBeGreaterThan(0));
  expect([...new Set(scopes())]).toEqual(['together']);
  rerender({ moveScope: 'separate' });
  await waitFor(() => expect(scopes()).toContain('separate'));
});


it('prices the typed hour on every route in auto mode and drops the single-route verdict', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
    slots: [],
    summary: { days: [] },
    pickedByTech: [{ start: '13:00', fits: true, detour_minutes: 12, drive_in_minutes: 9, from_home_base: false, from_name: 'S', technician: { id: 't-b', name: 'Tech B' } }],
  }) });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({ date: '2035-01-02', customerId: 'fixture', compareTechsAt: '13:00' }));
  await waitFor(() => expect(result.current.pickedByTech).toHaveLength(1));
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ pickedStart: '13:00', compareTechs: true });
  expect(result.current.pickedByTech[0]).toMatchObject({ technicianId: 't-b', detourMinutes: 12 });
});

it('never compares routes once one technician is chosen', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slots: [] }) });
  vi.stubGlobal('fetch', fetch);
  renderHook(() => useBestTimes({ date: '2035-01-02', customerId: 'fixture', technicianId: 'tech', compareTechsAt: '13:00' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(body.compareTechs).toBeUndefined();
  expect(body.pickedStart).toBeUndefined();
});

// ---- the open-times box's list (GATE_OPEN_TIMES_BOX, owner 2026-10-25) ----

const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const listHour = { start_time: '10:00', end_time: '11:00', detour_minutes: 6, technician: { id: 'tech', name: 'Fixture Tech' }, rain_tier: 2 };
// Routes the box question (GET /find-time/ui) and the searches.
function routedFetch({ ui, answer }) {
  return vi.fn(async (url, init) => {
    if (String(url).endsWith('/find-time/ui')) return { ok: true, json: async () => ({ ok: true, openTimes: ui }) };
    const body = JSON.parse(init.body);
    return { ok: true, json: async () => answer(body) };
  });
}
const listOf = (body) => ({
  slots: [],
  summary: {
    days: [{ date: body.dateFrom, status: 'open', hours: [listHour] }],
    open_times: { from: body.dateFrom, to: body.dateTo },
  },
});
const searches = (fetch) => fetch.mock.calls.filter(([url]) => !String(url).endsWith('/ui')).map(([, init]) => JSON.parse(init.body));

beforeEach(() => { resetOpenTimesUi(); });

it('open times: one search from today for four weeks on every route; a new hour or date inside them searches nothing', async () => {
  const today = etDateString();
  const fetch = routedFetch({ ui: true, answer: listOf });
  vi.stubGlobal('fetch', fetch);
  const { result, rerender } = renderHook((props) => useBestTimes({
    serviceId: 'fixture', technicianId: 'tech', arrivalWindows: true, bestRows: true, openTimes: true, techPick: true, ...props,
  }), { initialProps: { date: addDays(today, 3), pickedStart: '09:00' } });
  await waitFor(() => expect(result.current.availability?.openTimes?.from).toBe(today));
  const [body] = searches(fetch);
  expect(body).toMatchObject({ summary: true, openTimes: true, dateFrom: today, dateTo: addDays(today, 27), serviceId: 'fixture', hint: true });
  expect(body).not.toHaveProperty('pickedStart');
  expect(body).not.toHaveProperty('bestRows');
  // Only Quick Move's sheet sends quickMove.
  expect(body).not.toHaveProperty('quickMove');
  // Tech pick: the list covers every technician's route.
  expect(body).not.toHaveProperty('technicianId');
  expect(result.current.availability.days[0].hours[0]).toMatchObject({ start: '10:00', technicianName: 'Fixture Tech', rainTier: 2, detourMinutes: 6 });
  rerender({ date: addDays(today, 9), pickedStart: '13:00' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(searches(fetch)).toHaveLength(1);
  expect(result.current.availability.stale).toBeUndefined();
});

it('open times: a screen that cannot change the technician lists that route only', async () => {
  const today = etDateString();
  const fetch = routedFetch({ ui: true, answer: listOf });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({ date: addDays(today, 3), serviceId: 'fixture', technicianId: 'tech', openTimes: true }));
  await waitFor(() => expect(result.current.availability?.openTimes?.from).toBeTruthy());
  expect(searches(fetch)[0]).toMatchObject({ technicianId: 'tech', openTimes: true });
});

it('open times: a date past the four weeks asks for that one day, keeping the list', async () => {
  const today = etDateString();
  const far = addDays(today, 40);
  const fetch = routedFetch({ ui: true, answer: listOf });
  vi.stubGlobal('fetch', fetch);
  const { result, rerender } = renderHook((props) => useBestTimes({ serviceId: 'fixture', technicianId: 'tech', openTimes: true, ...props }), {
    initialProps: { date: addDays(today, 3) },
  });
  await waitFor(() => expect(result.current.availability?.openTimes?.from).toBeTruthy());
  rerender({ date: far });
  await waitFor(() => expect(result.current.availability?.days.map((day) => day.date)).toEqual([today, far]));
  const sent = searches(fetch);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({ dateFrom: far, dateTo: far, openTimes: true });
});

it('box off: the strip search as before, picked hour and best-times rows included', async () => {
  const fetch = routedFetch({ ui: false, answer: () => summaryAnswer });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({
    date: '2035-01-02', serviceId: 'fixture', technicianId: 'tech', pickedStart: '14:00', bestRows: true, openTimes: true, techPick: true,
  }));
  await waitFor(() => expect(result.current.availability?.days).toHaveLength(2));
  const [body] = searches(fetch);
  expect(body).toMatchObject({ summary: true, bestRows: true, pickedStart: '14:00', technicianId: 'tech', dateFrom: '2034-12-30', dateTo: '2035-01-09' });
  expect(body).not.toHaveProperty('openTimes');
  expect(result.current.availability.openTimes).toBeUndefined();
});

it('an answer without the list (the box was turned off since) draws the strip', async () => {
  const today = etDateString();
  const fetch = routedFetch({ ui: true, answer: (body) => (body.openTimes ? { slots: [], summary: { days: [] } } : summaryAnswer) });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({ date: '2035-01-02', serviceId: 'fixture', technicianId: 'tech', pickedStart: '14:00', openTimes: true }));
  await waitFor(() => expect(result.current.availability?.days).toHaveLength(2));
  const sent = searches(fetch);
  expect(sent[0]).toMatchObject({ openTimes: true, dateFrom: today });
  expect(sent[sent.length - 1]).toMatchObject({ pickedStart: '14:00', dateFrom: '2034-12-30' });
  expect(result.current.availability.openTimes).toBeUndefined();
});

it('open times: a closed picker forgets its list, so reopening searches the schedule again', async () => {
  const today = etDateString();
  const fetch = routedFetch({ ui: true, answer: listOf });
  vi.stubGlobal('fetch', fetch);
  const { result, rerender } = renderHook((props) => useBestTimes({
    date: addDays(today, 3), serviceId: 'fixture', technicianId: 'tech', openTimes: true, ...props,
  }), { initialProps: { enabled: true } });
  await waitFor(() => expect(result.current.availability?.openTimes?.from).toBeTruthy());
  rerender({ enabled: false });
  expect(result.current.availability).toBeNull();
  rerender({ enabled: true });
  await waitFor(() => expect(searches(fetch)).toHaveLength(2));
  await waitFor(() => expect(result.current.availability?.openTimes?.from).toBeTruthy());
});

it('open times: a far day whose lookup failed is marked unchecked, never shown as a day with no open times', async () => {
  const today = etDateString();
  const far = addDays(today, 40);
  const fetch = vi.fn(async (url, init) => {
    if (String(url).endsWith('/find-time/ui')) return { ok: true, json: async () => ({ ok: true, openTimes: true }) };
    const body = JSON.parse(init.body);
    if (body.dateFrom === far) return { ok: false, status: 502, json: async () => ({ error: 'upstream' }) };
    return { ok: true, json: async () => listOf(body) };
  });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({ date: far, serviceId: 'fixture', technicianId: 'tech', openTimes: true }));
  await waitFor(() => expect(result.current.availability?.openTimes?.from).toBe(today));
  expect(result.current.availability.days.find((day) => day.date === far)).toEqual({ date: far, status: 'unchecked', hours: [] });
});

it('Quick Move: the search says so, for the server to pick its route check', async () => {
  const fetch = routedFetch({ ui: true, answer: listOf });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useBestTimes({
    serviceId: 'fixture', technicianId: 'tech', bestRows: true, openTimes: true, quickMove: true, date: addDays(etDateString(), 1),
  }));
  await waitFor(() => expect(result.current.availability?.openTimes?.from).toBeTruthy());
  expect(searches(fetch)[0]).toMatchObject({ hint: true, openTimes: true, quickMove: true });
});

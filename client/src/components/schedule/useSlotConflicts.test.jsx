// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSlotConflicts } from './useSlotConflicts';

afterEach(() => { vi.unstubAllGlobals(); });

const answer = (results) => vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, results }) });
const sentTarget = (fetch, call = 0) => JSON.parse(fetch.mock.calls[call][1].body).targets[0];
const slot = { date: '2035-01-02', windowStart: '16:00', windowEnd: '17:00', serviceId: 'fixture-visit', technicianId: 'fixture-tech', durationMinutes: 60 };

it('asks the slot check about the picked slot and gives back its overlap rows', async () => {
  const fetch = answer([{ conflicts: [{ windowStart: '16:00', windowEnd: '17:00' }] }]);
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useSlotConflicts({ ...slot, excludeServiceIds: ['fixture-visit'] }));
  await waitFor(() => expect(result.current.conflicts).toHaveLength(1));
  expect(fetch.mock.calls[0][0]).toMatch(/\/admin\/dispatch\/slot-check$/);
  expect(sentTarget(fetch)).toEqual({
    date: '2035-01-02', window: { start: '16:00', end: '17:00' }, excludeServiceIds: ['fixture-visit'],
    serviceId: 'fixture-visit', technicianId: 'fixture-tech', durationMinutes: 60,
  });
});

// The server judges a move on the visit's stored length, and an edit of the length on the length sent.
it('durationEdit rides only when the caller saves the duration (edit form); a move sends none', async () => {
  const fetch = answer([{ conflicts: [] }]);
  vi.stubGlobal('fetch', fetch);
  const { rerender } = renderHook((props) => useSlotConflicts({ ...slot, ...props }), { initialProps: { durationEdit: undefined } });
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect('durationEdit' in sentTarget(fetch)).toBe(false);
  rerender({ durationEdit: true });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(sentTarget(fetch, 1)).toMatchObject({ durationEdit: true, durationMinutes: 60, serviceId: 'fixture-visit' });
  rerender({ durationEdit: false });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect('durationEdit' in sentTarget(fetch, 2)).toBe(false);
});

// GATE_TECH_SHIFT_HOURS: the shift line of the picked slot, beside the overlap rows.
it('gives back the shift line of the picked slot, null without one, and clears it when the slot changes', async () => {
  const LINE = "Synthetic Tech's shift is 8:00 AM to 5:00 PM. This visit is outside those hours.";
  let resolveSecond;
  const fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, results: [{ conflicts: [], shiftWarning: LINE }] }) })
    .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));
  vi.stubGlobal('fetch', fetch);
  const { result, rerender } = renderHook((props) => useSlotConflicts({ ...slot, ...props }), { initialProps: {} });
  expect(result.current.shiftWarning).toBeNull();
  await waitFor(() => expect(result.current.shiftWarning).toBe(LINE));
  // A new slot: the old line goes at once, before the new answer.
  rerender({ windowStart: '15:00', windowEnd: '16:00' });
  expect(result.current.shiftWarning).toBeNull();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  // An answer with no key (the gate off), or a key that is no text: no line.
  resolveSecond({ ok: true, json: async () => ({ ok: true, results: [{ conflicts: [], shiftWarning: { text: LINE } }] }) });
  await waitFor(() => expect(result.current.checking).toBe(false));
  expect(result.current.shiftWarning).toBeNull();
});

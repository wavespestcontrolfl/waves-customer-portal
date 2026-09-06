// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, renderHook, waitFor } from '@testing-library/react';
import BestTimeHint from './BestTimeHint';
import SlotConflictNotice from './SlotConflictNotice';
import { useBestTimes } from './useBestTimes';
import { useSlotConflicts } from './useSlotConflicts';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows the estimated arrival separately from the chosen promise and picking only fills that promise', () => {
  const onPick = vi.fn();
  const slot = { start: '09:00', end: '10:00', estimatedArrival: '09:44', detourMinutes: 9, arrivalWindows: true };
  render(<BestTimeHint bestTimes={[slot]} onPick={onPick} currentStart="12:00" />);
  fireEvent.click(screen.getByRole('button', { name: '9:00 AM · arrive ~9:44 AM · +9 min drive' }));
  expect(onPick).toHaveBeenCalledWith(slot);
  expect(screen.getByText(/arrivals stay within each customer's 2-hour window/)).toBeTruthy();
});

it('renders a route warning without incorrectly calling overlapping arrival promises a double-booking', () => {
  const warning = 'The route cannot keep every promised arrival window. Choose another window.';
  render(<SlotConflictNotice conflicts={[{ warning, reason: 'arrival_window' }]} />);
  expect(screen.getByText(warning)).toBeTruthy();
  expect(screen.queryByText(/double-book/)).toBeNull();
});

it('keeps the arrival estimate supplied by the picker API', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slots: [{
    start_time: '09:00', end_time: '10:00', estimated_arrival: '09:44', route_mode: 'arrival_windows',
    technician: { id: 'tech' }, detour_minutes: 9,
  }] }) }));
  const { result } = renderHook(() => useBestTimes({ date: '2035-01-01', serviceId: 'fixture', technicianId: 'tech', arrivalWindows: true }));
  await waitFor(() => expect(result.current.bestTimes).toHaveLength(1));
  expect(result.current.bestTimes[0]).toMatchObject({ estimatedArrival: '09:44', arrivalWindows: true });
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ arrivalWindows: true, serviceId: 'fixture' });
});

it('refreshes the live route check with the edited technician and full service duration', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [{ conflicts: [] }] }) });
  vi.stubGlobal('fetch', fetch);
  const props = { date: '2035-01-01', serviceId: 'fixture', technicianId: 'tech-a', windowStart: '09:00', windowEnd: '10:00', durationMinutes: 60 };
  const { rerender } = renderHook(p => useSlotConflicts(p), { initialProps: props });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  rerender({ ...props, technicianId: 'tech-b', durationMinutes: 120 });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(fetch.mock.calls[1][1].body).targets[0]).toMatchObject({
    serviceId: 'fixture', technicianId: 'tech-b', durationMinutes: 120,
  });
});

it('keeps unmigrated hint callers on their existing route contract', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slots: [] }) });
  vi.stubGlobal('fetch', fetch);
  renderHook(() => useBestTimes({ date: '2035-01-01', serviceId: 'fixture', technicianId: 'tech' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ arrivalWindows: false });
});

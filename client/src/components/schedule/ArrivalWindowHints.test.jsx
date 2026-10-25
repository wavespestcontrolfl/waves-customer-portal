// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, renderHook, waitFor } from '@testing-library/react';
import SlotConflictNotice from './SlotConflictNotice';
import { useBestTimes } from './useBestTimes';
import { useSlotConflicts } from './useSlotConflicts';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('renders a route warning without incorrectly calling overlapping arrival promises a double-booking', () => {
  const warning = 'The route cannot keep every promised arrival window. Choose another window.';
  render(<SlotConflictNotice conflicts={[{ warning, reason: 'arrival_window' }]} />);
  expect(screen.getByText(warning)).toBeTruthy();
  expect(screen.queryByText(/double-book/)).toBeNull();
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

it('keeps unmigrated availability callers on their existing route contract', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slots: [] }) });
  vi.stubGlobal('fetch', fetch);
  renderHook(() => useBestTimes({ date: '2035-01-01', serviceId: 'fixture', technicianId: 'tech' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ arrivalWindows: false, hint: true, summary: true });
});

it('sends the arrival-window flag the picker asked for', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slots: [] }) });
  vi.stubGlobal('fetch', fetch);
  renderHook(() => useBestTimes({ date: '2035-01-01', serviceId: 'fixture', technicianId: 'tech', arrivalWindows: true }));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ arrivalWindows: true, serviceId: 'fixture' });
});

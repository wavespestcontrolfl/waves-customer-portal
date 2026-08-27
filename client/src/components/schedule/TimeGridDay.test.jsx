// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TimeGridDay from './TimeGridDay';

let mockActive = null;
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }) => <div>{children}</div>,
  useDndContext: () => ({ active: mockActive }),
  PointerSensor: function PointerSensor() {},
  useSensor: () => ({}),
  useSensors: () => [],
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, isDragging: false }),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  pointerWithin: vi.fn(),
}));

const SERVICES = [
  {
    id: 'svc-1', customerName: 'First Customer', status: 'confirmed',
    windowStart: '08:00', windowEnd: '09:00', windowDisplay: '8–9 AM',
    technicianId: 'tech-1', technicianName: 'Alex Tech',
  },
  {
    id: 'svc-2', customerName: 'Second Customer', status: 'confirmed',
    windowStart: '10:00', windowEnd: '11:00', windowDisplay: '10–11 AM',
    technicianId: 'tech-1', technicianName: 'Alex Tech',
  },
];

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
  global.fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    .mockResolvedValueOnce({ ok: false, status: 409, statusText: 'Conflict', text: async () => 'conflict' });
  window.alert = vi.fn();
});

afterEach(() => {
  mockActive = null;
  cleanup();
  vi.restoreAllMocks();
});

describe('TimeGridDay bulk reconciliation', () => {
  it('reports a partial unassign and refreshes the schedule from server truth', async () => {
    const onChange = vi.fn();
    render(
      <TimeGridDay
        date="2026-07-15"
        services={SERVICES}
        technicians={[{ id: 'tech-1', name: 'Alex Tech' }]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByTitle(/First Customer/), { shiftKey: true });
    fireEvent.click(screen.getByTitle(/Second Customer/), { shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Unassign all' }));

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(
      'Bulk unassign partially completed: 1 unassigned, 1 failed. The schedule has been refreshed.',
    ));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('TimeGridDay hour-aligned grid', () => {
  it('displays from 6 AM and EVERY row accepts drops / drag-create (no 8 AM floor), snapped to the hour', async () => {
    const { snapSlotIdxToHourMin, isBookableSlotIdx } = await import('./TimeGridDay');
    const { container } = render(
      <TimeGridDay
        date="2026-07-15"
        services={[...SERVICES, {
          id: 'svc-early', customerName: 'Early Customer', status: 'confirmed',
          windowStart: '07:00', windowEnd: '08:00', windowDisplay: '7–8 AM',
          technicianId: 'tech-1', technicianName: 'Alex Tech',
        }]}
        technicians={[{ id: 'tech-1', name: 'Alex Tech' }]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('6 AM')).toBeInTheDocument();
    expect(screen.getByText('8 AM')).toBeInTheDocument();
    // A legacy 7 AM visit is not hidden from dispatch.
    expect(screen.getByTitle(/Early Customer/)).toBeInTheDocument();
    // No row is muted for being early — the former 8 AM floor is gone.
    const rows = container.querySelectorAll('[data-slot-min]');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.getAttribute('aria-disabled')).toBe(null);
    }
    // 30-min visual rows from 06:00: idx 0 (06:00) and idx 3 (07:30 → 07:00)
    // are bookable; idx 4 = 08:00 and idx 5 = 08:30 both snap to 08:00.
    // Nothing lands on :30.
    expect(isBookableSlotIdx(0)).toBe(true);
    expect(isBookableSlotIdx(3)).toBe(true);
    expect(isBookableSlotIdx(4)).toBe(true);
    expect(snapSlotIdxToHourMin(4)).toBe(8 * 60);
    expect(snapSlotIdxToHourMin(5)).toBe(8 * 60);
    expect(snapSlotIdxToHourMin(9)).toBe(10 * 60);
    for (let idx = 0; idx < 28; idx += 1) expect(snapSlotIdxToHourMin(idx) % 60).toBe(0);
  });
});

describe('TimeGridDay day-end fit', () => {
  it('a row is bookable only if the dragged visit would end by 8 PM; drag-create pre-fill never runs past it', async () => {
    const { isBookableSlotIdx } = await import('./TimeGridDay');
    const IDX_19 = (19 - 6) * 2; // 30-min rows from 06:00 → 19:00
    expect(isBookableSlotIdx(IDX_19, 60)).toBe(true);
    expect(isBookableSlotIdx(IDX_19, 120)).toBe(false);
    expect(isBookableSlotIdx(IDX_19 - 2, 120)).toBe(true); // 18:00 + 2h = 20:00 fits
    expect(isBookableSlotIdx(IDX_19 + 1, 60)).toBe(true); // 19:30 row snaps to 19:00

    // A 2-hour visit in flight disables the 19:00 row while 18:00 stays open.
    mockActive = { data: { current: { service: { id: 'svc-long', windowStart: '09:00', windowEnd: '11:00' } } } };
    const { container } = render(
      <TimeGridDay
        date="2026-07-15"
        services={SERVICES}
        technicians={[{ id: 'tech-1', name: 'Alex Tech' }]}
        onChange={vi.fn()}
      />,
    );
    const row = (min) => container.querySelector(`[data-slot-min="${min}"]`);
    expect(row(19 * 60).getAttribute('aria-disabled')).toBe('true');
    expect(row(18 * 60).getAttribute('aria-disabled')).toBeNull();
  });
});

describe('TimeGridDay bulk move (date-only)', () => {
  it('sends newWindow: null for a windowless visit (stays windowless) and the own window for a timed one', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({}) }; });
    render(
      <TimeGridDay
        date="2026-07-15"
        services={[
          SERVICES[0],
          {
            id: 'svc-anytime', customerName: 'Anytime Customer', status: 'confirmed',
            // Unassigned + windowless: renders in the unassigned rail, where
            // shift-click adds it to the bulk selection.
            windowStart: null, windowEnd: null, windowDisplay: 'Anytime',
            technicianId: null, technicianName: null,
          },
        ]}
        technicians={[{ id: 'tech-1', name: 'Alex Tech' }]}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle(/First Customer/), { shiftKey: true });
    fireEvent.click(screen.getByTitle(/Anytime Customer/), { shiftKey: true });
    const dateInput = screen.getByLabelText(/Move to/);
    fireEvent.change(dateInput, { target: { value: '2026-07-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(calls).toHaveLength(2));
    const byId = Object.fromEntries(calls.map((c) => [c.url.split('/').slice(-2)[0], c.body]));
    expect(byId['svc-anytime']).toMatchObject({ newDate: '2026-07-20', newWindow: null });
    expect(byId['svc-1']).toMatchObject({ newDate: '2026-07-20', newWindow: '08:00-09:00' });
    expect(window.alert).not.toHaveBeenCalled();
  });
});

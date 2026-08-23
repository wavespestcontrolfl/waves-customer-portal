// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TimeGridDay from './TimeGridDay';

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }) => <div>{children}</div>,
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
  it('still DISPLAYS from 6 AM (existing early rows render) but only rows from 8 AM accept drops / drag-create, snapped to the hour', async () => {
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
    // Rows before 8 AM are muted + disabled (no droppable, no drag-create).
    const rows = container.querySelectorAll('[data-slot-min]');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const min = Number(row.getAttribute('data-slot-min'));
      expect(row.getAttribute('aria-disabled')).toBe(min < 8 * 60 ? 'true' : null);
    }
    // 30-min visual rows from 06:00: idx 0..3 (06:00–07:30) are not bookable;
    // idx 4 = 08:00 and idx 5 = 08:30 both snap to 08:00. Nothing lands on :30.
    expect(isBookableSlotIdx(3)).toBe(false);
    expect(isBookableSlotIdx(4)).toBe(true);
    expect(snapSlotIdxToHourMin(4)).toBe(8 * 60);
    expect(snapSlotIdxToHourMin(5)).toBe(8 * 60);
    expect(snapSlotIdxToHourMin(9)).toBe(10 * 60);
    for (let idx = 0; idx < 28; idx += 1) expect(snapSlotIdxToHourMin(idx) % 60).toBe(0);
  });
});

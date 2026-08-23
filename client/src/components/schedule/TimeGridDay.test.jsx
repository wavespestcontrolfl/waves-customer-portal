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
  it('starts at 8 AM (no pre-opening rows) and snaps every drop row to its hour', async () => {
    const { snapSlotIdxToHourMin } = await import('./TimeGridDay');
    render(
      <TimeGridDay
        date="2026-07-15"
        services={SERVICES}
        technicians={[{ id: 'tech-1', name: 'Alex Tech' }]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByText('6 AM')).toBeNull();
    expect(screen.queryByText('7 AM')).toBeNull();
    expect(screen.getByText('8 AM')).toBeInTheDocument();
    // 30-min visual rows: idx 0 = 08:00, idx 1 = 08:30 → snaps to 08:00,
    // idx 5 = 10:30 → snaps to 10:00. Nothing can land on a :30 start.
    expect(snapSlotIdxToHourMin(0)).toBe(8 * 60);
    expect(snapSlotIdxToHourMin(1)).toBe(8 * 60);
    expect(snapSlotIdxToHourMin(4)).toBe(10 * 60);
    expect(snapSlotIdxToHourMin(5)).toBe(10 * 60);
    for (let idx = 0; idx < 24; idx += 1) expect(snapSlotIdxToHourMin(idx) % 60).toBe(0);
  });
});

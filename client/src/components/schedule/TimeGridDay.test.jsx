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

// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TimeGridDays from './TimeGridDays';

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }) => <div>{children}</div>,
  PointerSensor: function PointerSensor() {},
  useSensor: () => ({}),
  useSensors: () => [],
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, isDragging: false }),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  pointerWithin: vi.fn(),
}));

function response(payload) {
  return { ok: true, json: async () => payload };
}

function week(startDate, customerName) {
  return {
    startDate,
    days: [{
      date: startDate,
      dayOfWeek: 'Monday',
      dayNum: '13',
      services: [{
        id: `svc-${startDate}`,
        customerName,
        status: 'confirmed',
        windowStart: '08:00',
        windowEnd: '09:00',
        technicianId: 'tech-1',
        technicianName: 'Alex Tech',
      }],
    }],
  };
}

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
  global.fetch = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TimeGridDays rain chips', () => {
  it('shows red at ≥50, amber at ≥40, and nothing below 40 or when null', async () => {
    const day = (date, dayOfWeek, dayNum, rainChance) => ({
      date, dayOfWeek, dayNum, services: [], rainChance,
    });
    fetch.mockResolvedValueOnce(response({
      startDate: '2026-07-13',
      days: [
        day('2026-07-13', 'Mon', '13', 55),
        day('2026-07-14', 'Tue', '14', 42),
        day('2026-07-15', 'Wed', '15', 20),
        day('2026-07-16', 'Thu', '16', null),
      ],
    }));

    render(<TimeGridDays date="2026-07-13" dayCount={7} />);

    const red = await screen.findByText('55%');
    expect(red).toBeInTheDocument();
    expect(red.className).toContain('text-alert-fg');

    const amber = screen.getByText('42%');
    expect(amber.className).toContain('text-amber-800');
    expect(amber.className).not.toContain('text-alert-fg');

    // 20% and null render no chip at all — exception-based display.
    expect(screen.queryByText('20%')).not.toBeInTheDocument();
    expect(screen.getAllByTitle(/chance of rain/)).toHaveLength(2);
  });
});

describe('TimeGridDays week loading', () => {
  it('clears the prior week on failure and retries the requested week', async () => {
    fetch
      .mockResolvedValueOnce(response(week('2026-07-13', 'Old Week Customer')))
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Unavailable', text: async () => 'temporarily unavailable' })
      .mockResolvedValueOnce(response(week('2026-07-20', 'New Week Customer')));

    const { rerender } = render(<TimeGridDays date="2026-07-15" dayCount={7} />);
    expect(await screen.findByText('Old Week Customer')).toBeInTheDocument();

    rerender(<TimeGridDays date="2026-07-22" dayCount={7} />);

    await waitFor(() => expect(screen.getByText(/Failed to load this week/)).toBeInTheDocument());
    expect(screen.queryByText('Old Week Customer')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('New Week Customer')).toBeInTheDocument();
    expect(fetch).toHaveBeenLastCalledWith(
      '/api/admin/schedule/week?start=2026-07-20',
      expect.any(Object),
    );
  });
});

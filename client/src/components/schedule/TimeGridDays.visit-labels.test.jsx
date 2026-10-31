// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TimeGridDays from './TimeGridDays';

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }) => <div>{children}</div>,
  PointerSensor: function PointerSensor() {},
  useSensor: () => ({}),
  useSensors: () => [],
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, isDragging: false }),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useDndContext: () => ({ active: null }),
  pointerWithin: vi.fn(),
}));

const visit = (id, customerName, windowStart, windowEnd) => ({
  id, customerName, status: 'confirmed', windowStart, windowEnd,
  technicianId: 'tech-1', technicianName: 'Alex Tech', serviceType: 'Pest control',
});

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      startDate: '2026-07-13',
      days: [{
        date: '2026-07-13', dayOfWeek: 'Mon', dayNum: '13',
        services: [
          visit('hour', 'Hour Customer', '08:00', '09:00'),
          visit('half', 'Half Customer', '11:00', '11:30'),
        ],
      }],
    }),
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Dispatch visit labels sit at the repo's 14px readability floor. The 30-minute
// block cannot stack three 14px lines, so its time shares the name's row; every
// piece of text is still on the page and on the block's title.
describe('TimeGridDays visit labels at the 14px floor', () => {
  it('renders the visit name, time and service line at 14px with no 10/11px text left on the block', async () => {
    render(<TimeGridDays date="2026-07-13" dayCount={7} />);
    const name = await screen.findByRole('button', { name: 'Hour Customer' });
    const block = name.closest('[title]');
    expect(block.className).toContain('text-14');
    expect(block.className).not.toMatch(/\btext-1[01]\b/);
    expect(name.className).toContain('text-14');
    expect(block.querySelector('.text-10, .text-11')).toBeNull();
    // An hour-long block keeps time, name and service/tech on their own lines.
    expect(block.textContent).toContain('8 AM');
    expect(block.textContent).toContain('Pest control · Alex Tech');
  });

  it('puts a sub-hour block’s time on the name row and keeps the full text on the title', async () => {
    render(<TimeGridDays date="2026-07-13" dayCount={7} />);
    const name = await screen.findByRole('button', { name: 'Half Customer' });
    const block = name.closest('[title]');
    expect(block).toHaveAttribute('title', expect.stringContaining('Half Customer'));
    expect(block).toHaveAttribute('title', expect.stringContaining('Pest control'));
    expect(block).toHaveAttribute('title', expect.stringContaining('Alex Tech'));
    const row = name.parentElement.parentElement;
    expect(row.className).toContain('flex');
    expect(row.textContent).toMatch(/11 AM.*Half Customer/);
  });
});

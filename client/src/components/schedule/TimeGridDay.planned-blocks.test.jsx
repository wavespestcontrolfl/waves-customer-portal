// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TimeGridDay from './TimeGridDay';

vi.mock('./RescheduleConfirmModal', () => ({ default: () => null }));
vi.mock('@dnd-kit/core', () => ({
  DndContext: (props) => <div>{props.children}</div>,
  useDndContext: () => ({ active: null }),
  PointerSensor: function PointerSensor() {},
  useSensor: () => ({}),
  useSensors: () => [],
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, isDragging: false }),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  pointerWithin: vi.fn(),
}));

const TECHS = [{ id: 'tech-1', name: 'Alex Tech' }];
// Grid: 6 AM top, 32px per 30 minutes.
const topOf = (min) => ((min - 360) / 30) * 32;

function visit(id, name, windowStart, extra = {}) {
  const hour = Number(windowStart.slice(0, 2));
  return {
    id, customerName: name, status: 'confirmed', serviceType: 'General Pest Control',
    windowStart, windowEnd: `${String(hour + 1).padStart(2, '0')}:00`, windowDisplay: `${hour}–${hour + 1}`,
    technicianId: 'tech-1', technicianName: 'Alex Tech', ...extra,
  };
}

function renderDay(services, props = {}) {
  return render(<TimeGridDay date="2026-11-25" services={services} technicians={TECHS} {...props} />);
}

const block = (name) => screen.getByTitle(new RegExp(name));

// jsdom has no PointerEvent: the resize drag reads clientY from the event.
if (!window.PointerEvent) window.PointerEvent = class PointerEvent extends MouseEvent {};

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('TimeGridDay planned blocks', () => {
  it('draws a planned visit at its planned arrival, as tall as its planned minutes', () => {
    renderDay([visit('a', 'Planned Pat', '10:00', { plannedArrivalMin: 645, plannedMinutes: 35 })]);
    const el = block('Planned Pat');
    expect(parseFloat(el.style.top)).toBeCloseTo(topOf(645));
    expect(parseFloat(el.style.height)).toBeCloseTo((35 / 30) * 32);
  });

  it('keeps today\'s drawing at the window start when the planned fields are missing or partial', () => {
    renderDay([
      visit('a', 'Plain Pat', '10:00'),
      visit('b', 'Half Hal', '13:00', { plannedArrivalMin: 800 }),
      visit('c', 'Zero Zed', '15:00', { plannedArrivalMin: 900, plannedMinutes: 0 }),
      visit('d', 'Null Nan', '17:00', { plannedArrivalMin: null, plannedMinutes: null }),
    ]);
    for (const [name, start] of [['Plain Pat', 600], ['Half Hal', 780], ['Zero Zed', 900], ['Null Nan', 1020]]) {
      const el = block(name);
      expect(parseFloat(el.style.top)).toBeCloseTo(topOf(start));
      expect(parseFloat(el.style.height)).toBeCloseTo(64);
    }
    // The fallback still leads with the booked window text.
    expect(screen.getByText('10–11')).toBeInTheDocument();
    expect(screen.queryByText(/^window /)).toBeNull();
  });

  it('shows a short planned block as one line: route number, time, name, service, minutes, window chip', () => {
    renderDay([visit('a', 'Planned Pat', '10:00', { plannedArrivalMin: 645, plannedMinutes: 35 })]);
    const chip = screen.getByText('window 10–12');
    const line = chip.parentElement;
    expect(line).toHaveClass('flex');
    expect(line.textContent).toMatch(/^1\s*10:45\s*Planned Pat\s*·\s*General Pest Control\s*·\s*35 min\s*window 10–12$/);
    expect(chip).toHaveStyle({ fontSize: '14px' });
  });

  it('flags a planned arrival outside the promised window with a red edge and a tooltip', () => {
    renderDay([
      visit('a', 'Late Lou', '10:00', { plannedArrivalMin: 12 * 60 + 15, plannedMinutes: 35 }),
      visit('b', 'Fine Fay', '14:00', { plannedArrivalMin: 14 * 60 + 40, plannedMinutes: 35 }),
    ]);
    const late = block('Late Lou');
    expect(late.style.borderLeft).toBe('3px solid rgb(220, 38, 38)');
    expect(late.getAttribute('title')).toMatch(/Planned arrival 12:15 · 35 min — outside the window 10–12/);
    const fine = block('Fine Fay');
    expect(fine.style.borderLeft).not.toContain('220, 38, 38');
    expect(fine.getAttribute('title')).toMatch(/Planned arrival 2:40 · 35 min$|Planned arrival 2:40 · 35 min\n/);
    expect(fine.getAttribute('title')).not.toMatch(/outside/);
  });

  it('stacks back-to-back planned stops full width, while overlapping booked windows still split', () => {
    // Same booked hour, but the route plans them one after the other.
    renderDay([
      visit('a', 'First Fran', '09:00', { plannedArrivalMin: 540, plannedMinutes: 35 }),
      visit('b', 'Second Sam', '09:00', { plannedArrivalMin: 580, plannedMinutes: 35 }),
    ]);
    expect(block('First Fran').style.width).toBe('calc(100% - 4px)');
    expect(block('Second Sam').style.width).toBe('calc(100% - 4px)');
    cleanup();
    renderDay([visit('a', 'First Fran', '09:00'), visit('b', 'Second Sam', '09:00')]);
    expect(block('First Fran').style.width).toBe('calc(50% - 4px)');
    expect(block('Second Sam').style.width).toBe('calc(50% - 4px)');
  });

  it('puts planned blocks that really overlap side by side', () => {
    renderDay([
      visit('a', 'First Fran', '09:00', { plannedArrivalMin: 540, plannedMinutes: 60 }),
      visit('b', 'Second Sam', '09:00', { plannedArrivalMin: 570, plannedMinutes: 60 }),
    ]);
    expect(block('First Fran').style.width).toBe('calc(50% - 4px)');
  });

  it('falls back when the planned arrival is outside the grid', () => {
    renderDay([visit('a', 'Night Ned', '10:00', { plannedArrivalMin: 21 * 60, plannedMinutes: 35 })]);
    expect(parseFloat(block('Night Ned').style.top)).toBeCloseTo(topOf(600));
  });

  it('keeps resize a length edit: no movement changes nothing, a slot drag adds 30 minutes', async () => {
    renderDay([visit('a', 'Planned Pat', '10:00', { plannedArrivalMin: 645, plannedMinutes: 35 })]);
    const handle = screen.getByTitle('Drag to resize');
    fireEvent.pointerDown(handle, { clientY: 100 });
    fireEvent(window, new MouseEvent('pointerup', { clientY: 100 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.pointerDown(handle, { clientY: 100 });
    fireEvent(window, new MouseEvent('pointermove', { clientY: 132 }));
    fireEvent(window, new MouseEvent('pointerup', { clientY: 132 }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    // The visit's real length (the one-hour window) plus one slot: 10:00 to 11:30.
    expect(JSON.parse(fetch.mock.calls[0][1].body).newWindow).toBe('10:00-11:30');
  });
});

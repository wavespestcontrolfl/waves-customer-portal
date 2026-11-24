// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TimeGridDay from './TimeGridDay';

const dnd = vi.hoisted(() => ({ props: null }));
const modal = vi.hoisted(() => ({ props: null }));
vi.mock('./RescheduleConfirmModal', () => ({ default: (props) => { modal.props = props; return null; } }));
vi.mock('@dnd-kit/core', () => ({
  DndContext: (props) => { dnd.props = props; return <div>{props.children}</div>; },
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

// What the customer was told: an hour-level promise on the day.
const toldAt = (window) => ({ level: 'hour', dayOnly: false, date: '2026-11-25', window });

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
afterEach(() => { cleanup(); vi.restoreAllMocks(); modal.props = null; localStorage.removeItem('waves_admin_user'); });

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
      visit('a', 'Late Lou', '10:00', { plannedArrivalMin: 12 * 60 + 15, plannedMinutes: 35, told: toldAt('10:00 AM - 12:00 PM') }),
      visit('b', 'Fine Fay', '14:00', { plannedArrivalMin: 14 * 60 + 40, plannedMinutes: 35, told: toldAt('2:00 PM - 4:00 PM') }),
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

  it('saves an up-drag of one slot on a short planned block as 30 minutes off the booked hour', async () => {
    // Planned 35 min on a one-hour booking: the preview clamps at 30 minutes,
    // but the save is the pointer's whole slots on the booking (60 - 30).
    renderDay([visit('a', 'Planned Pat', '10:00', { plannedArrivalMin: 645, plannedMinutes: 35 })]);
    const handle = screen.getByTitle('Drag to resize');
    fireEvent.pointerDown(handle, { clientY: 200 });
    fireEvent(window, new MouseEvent('pointermove', { clientY: 168 }));
    fireEvent(window, new MouseEvent('pointerup', { clientY: 168 }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetch.mock.calls[0][1].body).newWindow).toBe('10:00-10:30');
  });

  it('draws a 15-minute planned stop at its real height and keeps the next quarter-hour stop in the same lane', () => {
    renderDay([
      visit('a', 'Quick Quin', '09:00', { plannedArrivalMin: 540, plannedMinutes: 15 }),
      visit('b', 'Next Nat', '09:00', { plannedArrivalMin: 555, plannedMinutes: 15 }),
    ]);
    expect(parseFloat(block('Quick Quin').style.height)).toBeCloseTo(16);
    expect(parseFloat(block('Next Nat').style.top)).toBeCloseTo(topOf(555));
    expect(block('Quick Quin').style.width).toBe('calc(100% - 4px)');
    expect(block('Next Nat').style.width).toBe('calc(100% - 4px)');
  });

  it('drops the old plan from a visit moved to another hour while the confirmation is open', () => {
    renderDay([
      visit('a', 'Moved Mo', '10:00', { plannedArrivalMin: 12 * 60 + 15, plannedMinutes: 35, told: toldAt('10:00 AM - 12:00 PM') }),
      visit('b', 'Stays Stu', '08:00', { plannedArrivalMin: 8 * 60, plannedMinutes: 35 }),
    ]);
    // Before the move it is drawn at its plan, outside its 10-12 window.
    expect(block('Moved Mo').style.borderLeft).toContain('220, 38, 38');
    act(() => {
      dnd.props.onDragEnd({
        active: { data: { current: { service: visit('a', 'Moved Mo', '10:00') } } },
        over: { data: { current: { techId: 'tech-1', slotMin: 14 * 60 } } },
      });
    });
    const moved = block('Moved Mo');
    expect(parseFloat(moved.style.top)).toBeCloseTo(topOf(14 * 60));
    expect(parseFloat(moved.style.height)).toBeCloseTo(64);
    expect(moved.style.borderLeft).not.toContain('220, 38, 38');
    expect(moved.getAttribute('title')).not.toMatch(/Planned arrival/);
    // The rest of the route keeps its plan until the refresh.
    expect(parseFloat(block('Stays Stu').style.top)).toBeCloseTo(topOf(480));
    expect(parseFloat(block('Stays Stu').style.height)).toBeCloseTo((35 / 30) * 32);
  });

  describe('the promised window', () => {
    const planned = { plannedArrivalMin: 12 * 60 + 15, plannedMinutes: 35 };

    it('holds an hour-level visit to the window the customer was told, not the booked hour', () => {
      renderDay([visit('a', 'Told Tom', '10:00', {
        ...planned, scheduledDate: '2026-11-25',
        told: { level: 'hour', dayOnly: false, date: '2026-11-25', window: '12:00 PM - 2:00 PM' },
      })]);
      const el = block('Told Tom');
      expect(screen.getByText('window 12–2')).toBeInTheDocument();
      // 12:15 is inside the told 12-2 window: no alert, even though the booking now reads 10.
      expect(el.style.borderLeft).not.toContain('220, 38, 38');
      cleanup();
      renderDay([visit('a', 'Told Tom', '10:00', {
        ...planned, plannedArrivalMin: 14 * 60 + 30, scheduledDate: '2026-11-25',
        told: { level: 'hour', dayOnly: false, date: '2026-11-25', window: '12:00 PM - 2:00 PM' },
      })]);
      expect(block('Told Tom').style.borderLeft).toContain('220, 38, 38');
      expect(block('Told Tom').getAttribute('title')).toMatch(/outside the window 12–2/);
    });

    it('shows no hour chip and no alert for a day-only promise', () => {
      renderDay([visit('a', 'Day Dee', '10:00', { ...planned, told: { level: 'day', dayOnly: true, date: null, window: null } })]);
      expect(screen.queryByText(/^window /)).toBeNull();
      expect(block('Day Dee').style.borderLeft).not.toContain('220, 38, 38');
      expect(block('Day Dee').getAttribute('title')).not.toMatch(/outside/);
    });

    it('shows the booked window as a chip only, never the red edge, when no promise is recorded', () => {
      renderDay([
        visit('a', 'None Nan', '10:00', { ...planned, told: { level: 'none', dayOnly: false, date: null, window: null } }),
        visit('b', 'Bare Bo', '14:00', { plannedArrivalMin: 17 * 60, plannedMinutes: 35 }),
      ]);
      expect(screen.getAllByText(/^window /)).toHaveLength(2);
      expect(block('None Nan').style.borderLeft).not.toContain('220, 38, 38');
      expect(block('Bare Bo').style.borderLeft).not.toContain('220, 38, 38');
    });
  });

  it('draws no Open marker over a visit drawn away from its booked hour', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T11:00:00Z')); // 6:00 AM ET
    // Booked 10:00, planned 11:15: the 11 AM hour is open for booking, but the
    // visit is drawn there.
    renderDay(
      [visit('a', 'Late Lou', '10:00', { plannedArrivalMin: 11 * 60 + 15, plannedMinutes: 35 })],
      { onCreateSlot: vi.fn() },
    );
    vi.useRealTimers();
    expect(screen.queryByLabelText(/Book open hour 11–12 AM/)).toBeNull();
    expect(screen.getByLabelText(/Book open hour 12–1 PM/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Book open hour 9–10 AM/)).toBeInTheDocument();
  });

  describe('dragging a block drawn away from its booked hour', () => {
    const drag = (svc, over, delta) => act(() => {
      dnd.props.onDragEnd({ active: { data: { current: { service: svc } } }, over: { data: { current: over } }, delta });
    });
    beforeEach(() => localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' })));

    it('keeps the booked start when it is dropped straight across onto another technician', () => {
      // Drawn at 11:15 (the pointer is in the 11 AM slot), booked at 10:00.
      const svc = visit('a', 'Across Al', '10:00', { plannedArrivalMin: 11 * 60 + 15, plannedMinutes: 35 });
      render(<TimeGridDay date="2026-11-25" services={[svc]} technicians={[...TECHS, { id: 'tech-2', name: 'Bo Tech' }]} />);
      drag(svc, { techId: 'tech-2', slotMin: 11 * 60 }, { x: 200, y: 0 });
      expect(modal.props.open).toBe(true);
      expect(modal.props.fromMinutes).toBe(10 * 60);
      expect(modal.props.toMinutes).toBe(10 * 60);
      expect(modal.props.technicianChange).toBeTruthy();
    });

    it('moves the booking by the hours it was dragged', () => {
      const svc = visit('a', 'Down Dan', '10:00', { plannedArrivalMin: 11 * 60 + 15, plannedMinutes: 35 });
      renderDay([svc]);
      drag(svc, { techId: 'tech-1', slotMin: 13 * 60 }, { x: 0, y: 128 }); // two hours down
      expect(modal.props.open).toBe(true);
      expect(modal.props.fromMinutes).toBe(10 * 60);
      expect(modal.props.toMinutes).toBe(12 * 60);
    });
  });

  it('sends nothing when an up-drag on a 30-minute booking clamps back to 30 minutes', async () => {
    renderDay([visit('a', 'Half Hal', '10:00', { windowEnd: '10:30' })]);
    const handle = screen.getByTitle('Drag to resize');
    fireEvent.pointerDown(handle, { clientY: 200 });
    fireEvent(window, new MouseEvent('pointermove', { clientY: 168 }));
    fireEvent(window, new MouseEvent('pointerup', { clientY: 168 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
  });
});

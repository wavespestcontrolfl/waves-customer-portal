// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TimeGridDay from './TimeGridDay';

const dnd = vi.hoisted(() => ({ props: null }));
const modal = vi.hoisted(() => ({ props: null }));
const dndState = vi.hoisted(() => ({ active: null, drops: [] }));
vi.mock('./RescheduleConfirmModal', () => ({ default: (props) => { modal.props = props; return null; } }));
vi.mock('@dnd-kit/core', () => ({
  DndContext: (props) => { dnd.props = props; return <div>{props.children}</div>; },
  useDndContext: () => ({ active: dndState.active }),
  PointerSensor: function PointerSensor() {},
  useSensor: () => ({}),
  useSensors: () => [],
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, isDragging: false }),
  useDroppable: (props) => {
    const setNodeRef = vi.fn();
    dndState.drops.push({ ...props, setNodeRef });
    return { setNodeRef, isOver: false };
  },
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

const drag = (svc, over, delta) => act(() => {
  dnd.props.onDragEnd({ active: { data: { current: { service: svc } } }, over: { data: { current: over } }, delta });
});

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
afterEach(() => { cleanup(); vi.restoreAllMocks(); modal.props = null; dndState.active = null; dndState.drops = []; localStorage.removeItem('waves_admin_user'); });

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

  it('moves the Open marker out of sight under a visit drawn away from its booked hour, keeping the booking action', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T11:00:00Z')); // 6:00 AM ET
    // Booked 10:00, planned 11:15: the 11 AM hour is open for booking, but the
    // visit is drawn there.
    const onCreateSlot = vi.fn();
    renderDay(
      [visit('a', 'Late Lou', '10:00', { plannedArrivalMin: 11 * 60 + 15, plannedMinutes: 35 })],
      { onCreateSlot },
    );
    vi.useRealTimers();
    const hidden = screen.getByLabelText(/Book open hour 11 AM–12 PM/);
    expect(hidden).toHaveClass('sr-only');
    expect(screen.queryByText('Open · 11 AM–12 PM')).toBeInTheDocument(); // text is for screen readers
    fireEvent.click(hidden);
    expect(onCreateSlot).toHaveBeenCalledWith(expect.objectContaining({ techId: 'tech-1', windowStart: '11:00', windowEnd: '12:00' }));
    // Other open hours keep the visible marker.
    expect(screen.getByLabelText(/Book open hour 12–1 PM/)).not.toHaveClass('sr-only');
    expect(screen.getByLabelText(/Book open hour 9–10 AM/)).not.toHaveClass('sr-only');
  });

  describe('dragging a block drawn away from its booked hour', () => {
    beforeEach(() => localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' })));

    const TWO = [...TECHS, { id: 'tech-2', name: 'Bo Tech' }];

    it('keeps a legacy 09:30 booking exactly when it is dropped straight across onto another technician', () => {
      // Booked 09:30, drawn at 11:15: the pointer sits in the 11 AM slot.
      const svc = visit('a', 'Across Al', '09:30', { windowEnd: '10:30', plannedArrivalMin: 11 * 60 + 15, plannedMinutes: 35 });
      render(<TimeGridDay date="2026-11-25" services={[svc]} technicians={TWO} />);
      drag(svc, { techId: 'tech-2', slotMin: 11 * 60 }, { x: 200, y: 8 });
      expect(modal.props.open).toBe(true);
      expect(modal.props.fromMinutes).toBe(9 * 60 + 30);
      expect(modal.props.toMinutes).toBe(9 * 60 + 30);
      expect(modal.props.toWindow).toBe('09:30-10:30');
      expect(modal.props.technicianChange).toBeTruthy();
    });

    it('moves a 17:00 two-hour booking drawn at 19:00 straight across, through the registered 19:00 slot', () => {
      const svc = visit('a', 'Late Lou', '17:00', { windowEnd: '19:00', estimatedDuration: 120, plannedArrivalMin: 19 * 60, plannedMinutes: 35 });
      dndState.active = { data: { current: { service: svc } } };
      const { container } = render(<TimeGridDay date="2026-11-25" services={[svc]} technicians={TWO} />);
      // Where a two-hour visit would not fit, the slot is only dimmed: it is
      // still a registered drop target with its node attached.
      const slot = container.querySelectorAll('[data-slot-min="1140"]')[2];
      expect(slot.getAttribute('aria-disabled')).toBe('true');
      const entry = dndState.drops.filter((d) => d.id === 'slot-tech-2-26').at(-1);
      expect(entry.disabled).toBe(false);
      expect(entry.setNodeRef).toHaveBeenCalledWith(slot);
      // The drop the real droppable would report.
      drag(svc, { techId: entry.data.techId, slotMin: entry.data.slotMin }, { x: 200, y: 0 });
      expect(modal.props.open).toBe(true);
      expect(modal.props.fromMinutes).toBe(17 * 60);
      expect(modal.props.toMinutes).toBe(17 * 60);
    });

    it('takes the slot under the pointer when the block is dragged up or down, like any other block', () => {
      const svc = visit('a', 'Down Dan', '10:00', { plannedArrivalMin: 11 * 60 + 15, plannedMinutes: 35 });
      renderDay([svc]);
      // Dropped on the highlighted 13:00 fit.
      drag(svc, { techId: 'tech-1', slotMin: 13 * 60 }, { x: 0, y: 128 });
      expect(modal.props.open).toBe(true);
      expect(modal.props.fromMinutes).toBe(10 * 60);
      expect(modal.props.toMinutes).toBe(13 * 60);
      // A half-hour row snaps down to its hour.
      drag(svc, { techId: 'tech-1', slotMin: 13 * 60 }, { x: 0, y: 160 });
      expect(modal.props.toMinutes).toBe(13 * 60);
    });

    it('still refuses a real vertical move to a slot the visit does not fit', () => {
      const svc = visit('a', 'Long Len', '17:00', { windowEnd: '19:00', estimatedDuration: 120, plannedArrivalMin: 18 * 60, plannedMinutes: 35 });
      renderDay([svc]);
      drag(svc, { techId: 'tech-1', slotMin: 19 * 60 }, { x: 0, y: 64 });
      expect(modal.props.open).toBeFalsy();
    });

    it('judges a group\'s late alert at the stop arrival, not a later service\'s own start', () => {
      // Van reaches the stop at 10:45, inside the told 9-11 window; the second
      // service starts at 11:20 after the first one's work.
      const told = { level: 'hour', dayOnly: false, date: '2026-11-25', window: '9:00 AM - 11:00 AM' };
      renderDay([
        visit('g1', 'First Fi', '09:00', { visitId: 'v1', told, plannedArrivalMin: 10 * 60 + 45, plannedMinutes: 35, plannedStopArrivalMin: 10 * 60 + 45 }),
        visit('g2', 'Second Si', '09:00', { visitId: 'v1', told, plannedArrivalMin: 11 * 60 + 20, plannedMinutes: 35, plannedStopArrivalMin: 10 * 60 + 45 }),
      ]);
      expect(block('Second Si').style.borderLeft).not.toContain('220, 38, 38');
      expect(block('Second Si').getAttribute('title')).not.toMatch(/outside/);
      cleanup();
      // Reached at 11:30 the stop is late for every service of it.
      renderDay([visit('g2', 'Second Si', '09:00', { visitId: 'v1', told, plannedArrivalMin: 12 * 60 + 5, plannedMinutes: 35, plannedStopArrivalMin: 11 * 60 + 30 })]);
      expect(block('Second Si').style.borderLeft).toContain('220, 38, 38');
    });
  });

  it('keeps the promise check and a planned-time tooltip when the planned arrival is off the grid', () => {
    // Booked 17:00, told 5-7 PM, but the route reaches it at 8:15 PM: off the grid.
    renderDay([visit('a', 'Night Ned', '17:00', {
      plannedArrivalMin: 20 * 60 + 15, plannedMinutes: 35, scheduledDate: '2026-11-25',
      told: { level: 'hour', dayOnly: false, date: '2026-11-25', window: '5:00 PM - 7:00 PM' },
    })]);
    const el = block('Night Ned');
    // Still drawn at its booked spot...
    expect(parseFloat(el.style.top)).toBeCloseTo(topOf(17 * 60));
    expect(parseFloat(el.style.height)).toBeCloseTo(64);
    // ...with the alert and the planned time.
    expect(el.style.borderLeft).toContain('220, 38, 38');
    expect(el.getAttribute('title')).toMatch(/Service planned 8:15 PM \(off the grid\) · stop reached 8:15 PM · window 5–7 PM · after the promise/);
  });

  it('shows both times, labelled, for a later service of a group planned off the grid', () => {
    // The stop is reached at 5:45 PM (inside 5-7), the second service starts at 8:15 PM, off the grid.
    renderDay([visit('g2', 'Second Si', '17:00', {
      visitId: 'v1', scheduledDate: '2026-11-25', plannedArrivalMin: 20 * 60 + 15, plannedMinutes: 35, plannedStopArrivalMin: 17 * 60 + 45,
      told: { level: 'hour', dayOnly: false, date: '2026-11-25', window: '5:00 PM - 7:00 PM' },
    })]);
    const title = block('Second Si').getAttribute('title');
    expect(title).toMatch(/Service planned 8:15 PM \(off the grid\) · stop reached 5:45 PM · window 5–7 PM/);
    expect(title).not.toMatch(/after the promise/);
    expect(block('Second Si').style.borderLeft).not.toContain('220, 38, 38');
  });

  it('holds a stop on both sides of midnight to a promise window that crosses it', () => {
    const night = { level: 'hour', dayOnly: false, date: '2026-11-25', window: '11:00 PM - 1:00 AM' };
    const base = { plannedMinutes: 20, scheduledDate: '2026-11-25', told: night };
    renderDay([
      visit('a', 'Before Bo', '19:00', { ...base, plannedArrivalMin: 23 * 60 + 50 }),
      visit('b', 'After Al', '19:00', { ...base, plannedArrivalMin: 24 * 60 + 50 }),
      visit('c', 'Late Lo', '19:00', { ...base, plannedArrivalMin: 25 * 60 + 10 }),
    ]);
    expect(block('Before Bo').style.borderLeft).not.toContain('220, 38, 38');
    expect(block('After Al').style.borderLeft).not.toContain('220, 38, 38');
    expect(block('Late Lo').style.borderLeft).toContain('220, 38, 38');
    expect(block('Late Lo').getAttribute('title')).toMatch(/window 11 PM–1 AM · after the promise/);
  });

  it('labels the window chip by its source, and says exactly why a booked window is not a promise', () => {
    const base = { plannedMinutes: 35, scheduledDate: '2026-11-25' };
    renderDay([
      visit('a', 'Told Tom', '10:00', { ...base, plannedArrivalMin: 10 * 60 + 30, told: toldAt('10:00 AM - 12:00 PM') }),
      visit('b', 'None Nan', '12:00', { ...base, plannedArrivalMin: 12 * 60 + 30, told: { level: 'none', dayOnly: false, date: null, window: null } }),
      visit('c', 'Bare Bo', '14:00', { ...base, plannedArrivalMin: 14 * 60 + 30 }),
      visit('d', 'Blank Bea', '16:00', { ...base, plannedArrivalMin: 16 * 60 + 30, told: { level: 'hour', dayOnly: false, date: null, window: null } }),
      visit('e', 'Other Ola', '08:00', { ...base, plannedArrivalMin: 8 * 60 + 30, told: { level: 'hour', dayOnly: false, date: '2026-11-20', window: '8:00 AM - 10:00 AM' } }),
    ]);
    expect(screen.getByText('window 10–12')).toHaveAttribute('title', 'Promised arrival window');
    expect(screen.getByText('window 12–2')).toHaveAttribute('title', 'Booked arrival window (no promise on record)');
    expect(screen.getByText('window 2–4')).toHaveAttribute('title', 'Booked arrival window (promise not shown on this feed)');
    expect(screen.getByText('window 4–6')).toHaveAttribute('title', 'Booked arrival window (promise time not readable)');
    expect(screen.getByText('window 8–10')).toHaveAttribute('title', 'Booked arrival window (promise was for another date)');
  });

  it('quotes the stop arrival, not the later service\'s own start, in a group\'s late alert', () => {
    const told = { level: 'hour', dayOnly: false, date: '2026-11-25', window: '9:00 AM - 11:00 AM' };
    renderDay([visit('g2', 'Second Si', '09:00', {
      visitId: 'v1', told, scheduledDate: '2026-11-25', plannedArrivalMin: 12 * 60 + 5, plannedMinutes: 35, plannedStopArrivalMin: 11 * 60 + 30,
    })]);
    const title = block('Second Si').getAttribute('title');
    expect(title).toMatch(/outside the window 9–11 \(stop reached 11:30\)/);
    expect(title).not.toMatch(/stop reached 12:05/);
  });

  it('drops a 09:00-10:30 booking carrying the feed\'s 60-minute estimate at 13:00 as 13:00-14:30', () => {
    const svc = visit('a', 'Ninety Nan', '09:00', { windowEnd: '10:30', estimatedDuration: 60, plannedArrivalMin: 9 * 60 + 15, plannedMinutes: 35 });
    renderDay([svc]);
    drag(svc, { techId: 'tech-1', slotMin: 13 * 60 }, { x: 0, y: 256 });
    expect(modal.props.open).toBe(true);
    expect(modal.props.toWindow).toBe('13:00-14:30');
    expect(modal.props.durationMinutes).toBe(90);
  });

  it('checks the day end and the drop hint against the booked length, not the estimate', () => {
    // 18:00-19:30 booked (estimate 60): 19:00 would end at 20:30.
    const svc = visit('a', 'Long Len', '18:00', { windowEnd: '19:30', estimatedDuration: 60 });
    dndState.active = { data: { current: { service: svc } } };
    const { container } = render(<TimeGridDay date="2026-11-25" services={[svc]} technicians={TECHS} />);
    expect(container.querySelectorAll('[data-slot-min="1140"]')[0].getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelectorAll('[data-slot-min="1080"]')[0].getAttribute('aria-disabled')).toBeNull();
    drag(svc, { techId: 'tech-1', slotMin: 19 * 60 }, { x: 0, y: 64 });
    expect(modal.props.open).toBeFalsy();
  });

  it('resizes from the booked window span when the feed filled a 60-minute estimate', async () => {
    // 09:00-10:30 booking, estimate null in the stored row (the feed shows 60).
    renderDay([visit('a', 'Ninety Nan', '09:00', { windowEnd: '10:30', estimatedDuration: 60 })]);
    const handle = screen.getByTitle('Drag to resize');
    fireEvent.pointerDown(handle, { clientY: 200 });
    fireEvent(window, new MouseEvent('pointermove', { clientY: 232 }));
    fireEvent(window, new MouseEvent('pointerup', { clientY: 232 }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetch.mock.calls[0][1].body).newWindow).toBe('09:00-11:00');
  });

  it('never lengthens a 15-minute booking dragged up (the 30-minute floor sends nothing)', async () => {
    renderDay([visit('a', 'Quarter Quin', '10:00', { windowEnd: '10:15' })]);
    const handle = screen.getByTitle('Drag to resize');
    fireEvent.pointerDown(handle, { clientY: 200 });
    fireEvent(window, new MouseEvent('pointermove', { clientY: 168 }));
    fireEvent(window, new MouseEvent('pointerup', { clientY: 168 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
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

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
        }, {
          id: 'svc-predawn', customerName: 'Predawn Customer', status: 'confirmed',
          windowStart: '05:00', windowEnd: '06:00', windowDisplay: '5–6 AM',
          technicianId: 'tech-1', technicianName: 'Alex Tech',
        }, {
          id: 'svc-predawn-2', customerName: 'Night Customer', status: 'confirmed',
          windowStart: '01:00', windowEnd: '02:00', windowDisplay: '1–2 AM',
          technicianId: 'tech-1', technicianName: 'Alex Tech',
        }, {
          id: 'svc-crossing', customerName: 'Crossing Customer', status: 'confirmed',
          windowStart: '05:00', windowEnd: '07:00', windowDisplay: '5–7 AM',
          technicianId: 'tech-1', technicianName: 'Alex Tech',
        }]}
        technicians={[{ id: 'tech-1', name: 'Alex Tech' }]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('6 AM')).toBeInTheDocument();
    expect(screen.getByText('8 AM')).toBeInTheDocument();
    // A 7 AM visit is not hidden from dispatch, and neither is one timed
    // BEFORE the grid's first row — it is pinned to the 6 AM row instead.
    expect(screen.getByTitle(/Early Customer/)).toBeInTheDocument();
    expect(screen.getByTitle(/Predawn Customer/)).toBeInTheDocument();
    // Two pre-grid visits that don't overlap in real time DO overlap once
    // pinned — they get separate lanes, never one block hiding the other.
    const predawn = screen.getByTitle(/Predawn Customer/).closest('[style]');
    const night = screen.getByTitle(/Night Customer/).closest('[style]');
    expect(night).toBeInTheDocument();
    expect(predawn.style.left).not.toBe(night.style.left);
    // A visit that CROSSES the first row is clipped to its visible portion
    // (05:00–07:00 draws as one 60-min block from 06:00), not shifted — so
    // it never fakes an overlap with the real 07:00 visit, which keeps a
    // full-width lane of its own.
    const crossing = screen.getByTitle(/Crossing Customer/).closest('[style]');
    const early = screen.getByTitle(/Early Customer/).closest('[style]');
    const first = screen.getByTitle(/First Customer/).closest('[style]');
    expect(crossing.style.top).toBe(night.style.top); // pinned on the first row
    expect(early.style.left).toBe(first.style.left); // 07:00 visit: its own full-width lane, no fake overlap
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

describe('TimeGridDay closeout-owed chip', () => {
  it('marks a completed block, an all-day stop, and a rail item that still owe their closeout', () => {
    const owedBlock = { ...SERVICES[0], id: 'svc-owed', status: 'completed' };
    const owedAllDay = { id: 'svc-allday', customerName: 'All Day Customer', status: 'completed', technicianId: 'tech-1', technicianName: 'Alex Tech' };
    const owedRail = { id: 'svc-rail', customerName: 'Rail Customer', status: 'completed', windowStart: '13:00', windowEnd: '14:00' };
    const finished = { ...SERVICES[1], id: 'svc-done', status: 'completed' };
    render(
      <TimeGridDay
        date="2026-07-15"
        services={[owedBlock, owedAllDay, owedRail, finished]}
        technicians={[{ id: 'tech-1', name: 'Alex Tech' }]}
        owesCompletion={(svc) => ['svc-owed', 'svc-allday', 'svc-rail'].includes(svc.id)}
      />,
    );
    expect(screen.getAllByText('Closeout owed')).toHaveLength(3);
  });
});

describe('TimeGridDay all-day closeout-owed chip', () => {
  it('routes the all-day chip through onEdit even though the stop button opens the customer profile', () => {
    const onEdit = vi.fn();
    const onViewCustomer = vi.fn();
    const owedAllDay = { id: 'svc-allday', customerId: 'cust-1', customerName: 'All Day Customer', status: 'completed', technicianId: 'tech-1', technicianName: 'Alex Tech' };
    render(
      <TimeGridDay
        date="2026-07-15"
        services={[owedAllDay]}
        technicians={[{ id: 'tech-1', name: 'Alex Tech' }]}
        owesCompletion={(svc) => svc.id === 'svc-allday'}
        onEdit={onEdit}
        onViewCustomer={onViewCustomer}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Closeout owed' }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'svc-allday' }));
    expect(onViewCustomer).not.toHaveBeenCalled();
  });
});

describe('TimeGridDay visit-group office actions', () => {
  const SAME_CUSTOMER = [
    {
      id: 'svc-lawn', customerId: 'cust-h', customerName: 'Houser Customer', status: 'confirmed',
      windowStart: '11:00', windowEnd: '12:00', windowDisplay: '11–12', technicianId: 'tech-1', technicianName: 'Alex Tech',
    },
    {
      id: 'svc-pest', customerId: 'cust-h', customerName: 'Houser Pest', status: 'confirmed',
      windowStart: '14:00', windowEnd: '15:00', windowDisplay: '2–3 PM', technicianId: 'tech-1', technicianName: 'Alex Tech',
    },
  ];

  it('offers Combine only for two or more rows of one customer, and posts them to the group route', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ visit: { id: 'v1' }, moved: [{ id: 'svc-pest', start: '12:00', end: '13:00' }] }),
    });
    const onChange = vi.fn();
    render(
      <TimeGridDay
        date="2026-09-04"
        services={[...SERVICES, ...SAME_CUSTOMER]}
        technicians={[{ id: 'tech-1', name: 'Alex Tech' }]}
        onChange={onChange}
      />,
    );
    // Two different customers: no Combine.
    fireEvent.click(screen.getByTitle(/First Customer/), { shiftKey: true });
    fireEvent.click(screen.getByTitle(/Second Customer/), { shiftKey: true });
    expect(screen.queryByRole('button', { name: 'Combine' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    fireEvent.click(screen.getByTitle(/Houser Customer/), { shiftKey: true });
    expect(screen.queryByRole('button', { name: 'Combine' })).toBeNull();
    fireEvent.click(screen.getByTitle(/Houser Pest/), { shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Combine' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toMatch(/\/admin\/visits\/group$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ serviceIds: ['svc-lawn', 'svc-pest'] });
    expect(window.alert).toHaveBeenCalledWith(expect.stringMatching(/Moved 1 service to follow the earlier one: 12 PM–1 PM\. No text was sent/));
  });

  it('shows the server refusal sentence, not the JSON envelope', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 409, statusText: 'Conflict',
      text: async () => JSON.stringify({ error: 'This customer is on autopay — visits are not grouped until grouped autopay ships.', code: 'visit_group_refused' }),
    });
    render(
      <TimeGridDay date="2026-09-04" services={SAME_CUSTOMER} technicians={[{ id: 'tech-1', name: 'Alex Tech' }]} onChange={vi.fn()} />,
    );
    fireEvent.click(screen.getByTitle(/Houser Customer/), { shiftKey: true });
    fireEvent.click(screen.getByTitle(/Houser Pest/), { shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Combine' }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(
      'Combine failed: This customer is on autopay — visits are not grouped until grouped autopay ships.',
    ));
  });

  it('offers Separate for exactly one grouped row and posts to the split route', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ visit: { id: 'v1' } }) });
    const onChange = vi.fn();
    const grouped = SAME_CUSTOMER.map((s) => ({ ...s, visit: { id: 'v1', serviceCount: 2, serviceTypes: ['Lawn', 'Pest'] } }));
    render(
      <TimeGridDay date="2026-09-04" services={grouped} technicians={[{ id: 'tech-1', name: 'Alex Tech' }]} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTitle(/Houser Pest/), { shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Separate' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const [url, init] = fetch.mock.calls[0];
    expect(url).toMatch(/\/admin\/visits\/v1\/split$/);
    expect(JSON.parse(init.body)).toEqual({ serviceId: 'svc-pest' });
    // Two grouped rows selected: Combine (already one visit) but no Separate.
    fireEvent.click(screen.getByTitle(/Houser Customer/), { shiftKey: true });
    fireEvent.click(screen.getByTitle(/Houser Pest/), { shiftKey: true });
    expect(screen.queryByRole('button', { name: 'Separate' })).toBeNull();
  });
});

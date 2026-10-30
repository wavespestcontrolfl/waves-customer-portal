// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TimeGridDays from './TimeGridDays';

const dnd = vi.hoisted(() => ({ props: null }));
const modal = vi.hoisted(() => ({ props: null }));
vi.mock('./RescheduleConfirmModal', () => ({
  default: (props) => {
    modal.props = props;
    return props.open ? <div>Move confirmation</div> : null;
  },
}));

vi.mock('@dnd-kit/core', () => ({
  DndContext: (props) => { dnd.props = props; return <div>{props.children}</div>; },
  PointerSensor: function PointerSensor() {},
  useSensor: () => ({}),
  useSensors: () => [],
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, isDragging: false }),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useDndContext: () => ({ active: null }),
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

describe('TimeGridDays bookable rows', () => {
  it('every row from 6 AM is bookable (no 8 AM floor), drops snap to the hour, and late rows respect the visit duration', async () => {
    const { snapSlotIdxToHourMin, isBookableSlotIdx } = await import('./TimeGridDays');
    // 30-min rows from 06:00: idx 0 = 06:00, idx 4 = 08:00.
    expect(isBookableSlotIdx(0)).toBe(true);
    expect(isBookableSlotIdx(3)).toBe(true);
    expect(isBookableSlotIdx(4)).toBe(true);
    expect(snapSlotIdxToHourMin(5)).toBe(8 * 60);
    const IDX_19 = (19 - 6) * 2;
    expect(isBookableSlotIdx(IDX_19, 60)).toBe(true);
    expect(isBookableSlotIdx(IDX_19, 120)).toBe(false);
  });
});

describe('TimeGridDays closeout-owed chip', () => {
  it('flags a completed week row that still owes its closeout and opens it through onEdit', async () => {
    const onEdit = vi.fn();
    const payload = week('2026-07-13', 'Owed Customer');
    payload.days[0].services[0] = { ...payload.days[0].services[0], id: 'svc-owed', status: 'completed', has_service_record: false };
    payload.days[0].services.push({ id: 'svc-done', customerName: 'Done Customer', status: 'completed', has_service_record: true, windowStart: '10:00', windowEnd: '11:00', technicianId: 'tech-1', technicianName: 'Alex Tech' });
    fetch.mockResolvedValueOnce(response(payload));
    render(
      <TimeGridDays
        date="2026-07-13"
        dayCount={7}
        owesCompletion={(svc) => svc.status === 'completed' && svc.has_service_record === false}
        onEdit={onEdit}
      />,
    );
    expect(await screen.findAllByText('Closeout owed')).toHaveLength(1);
    fireEvent.click(screen.getByTitle(/Owed Customer/));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'svc-owed' }));
  });
});

describe('TimeGridDays committed move followed by a failed week read', () => {
  const service = {
    id: 'svc-1',
    customerName: 'Synthetic Customer',
    status: 'confirmed',
    windowStart: '09:00',
    windowEnd: '10:00',
    technicianId: 'tech-1',
    technicianName: 'Alex Tech',
  };
  const movedService = { ...service, windowStart: '10:00', windowEnd: '11:00' };
  const payload = (services) => ({
    startDate: '2026-11-02',
    days: [
      { date: '2026-11-02', dayOfWeek: 'Mon', dayNum: 2, services: services[0] },
      { date: '2026-11-03', dayOfWeek: 'Tue', dayNum: 3, services: services[1] },
    ],
  });
  const unavailable = { ok: false, status: 503, statusText: 'Unavailable', text: async () => 'refresh temporarily unavailable' };

  it('keeps the moved result, says it moved, and retries only the refresh', async () => {
    vi.stubGlobal('alert', vi.fn());
    let gets = 0;
    let posts = 0;
    fetch.mockImplementation(async (url, opts = {}) => {
      if (opts.method === 'POST') { posts += 1; return response({ success: true, notificationSent: true }); }
      gets += 1;
      if (gets === 1) return response(payload([[service], []]));
      if (gets === 2) return unavailable;
      return response(payload([[], [movedService]]));
    });
    const onChange = vi.fn();
    render(<TimeGridDays date="2026-11-02" dayCount={7} onChange={onChange} />);
    await screen.findByText('Synthetic Customer');

    await act(async () => dnd.props.onDragEnd({
      active: { data: { current: { service } } },
      over: { data: { current: { date: '2026-11-03', slotMin: 600 } } },
    }));
    expect(modal.props.open).toBe(true);
    await act(async () => { await modal.props.onConfirm({ notificationType: 'sms', scope: 'this_only' }); });

    // The move committed: no failure alert, confirmation closed, parent told.
    expect(posts).toBe(1);
    expect(alert).not.toHaveBeenCalled();
    expect(modal.props.open).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Moved. Could not refresh the schedule.');
    // The moved state stays: the visit sits on Tuesday, not back on Monday.
    const column = (label) => screen.getByText(new RegExp(`^${label} `)).closest('.flex-1.relative');
    expect(within(column('Tue')).getByText('Synthetic Customer')).toBeInTheDocument();
    expect(within(column('Mon')).queryByText('Synthetic Customer')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(gets).toBe(3);
    expect(posts).toBe(1); // retry re-reads only; the move is never re-sent
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Synthetic Customer')).toBeInTheDocument();
  });

  it('keeps the notice up when the retry also fails', async () => {
    let gets = 0;
    fetch.mockImplementation(async (url, opts = {}) => {
      if (opts.method === 'POST') return response({ success: true });
      gets += 1;
      return gets === 1 ? response(payload([[service], []])) : unavailable;
    });
    render(<TimeGridDays date="2026-11-02" dayCount={7} />);
    await screen.findByText('Synthetic Customer');
    await act(async () => dnd.props.onDragEnd({
      active: { data: { current: { service } } },
      over: { data: { current: { date: '2026-11-03', slotMin: 600 } } },
    }));
    await act(async () => { await modal.props.onConfirm({ notificationType: 'none', scope: 'this_only' }); });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(gets).toBe(3));
    expect(screen.getByRole('alert')).toHaveTextContent('Moved. Could not refresh the schedule.');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('still reports a real move failure and reverts when the POST itself fails', async () => {
    vi.stubGlobal('alert', vi.fn());
    fetch.mockImplementation(async (url, opts = {}) => {
      if (opts.method === 'POST') return { ok: false, status: 500, statusText: 'Boom', text: async () => 'move refused' };
      return response(payload([[service], []]));
    });
    const onChange = vi.fn();
    render(<TimeGridDays date="2026-11-02" dayCount={7} onChange={onChange} />);
    await screen.findByText('Synthetic Customer');
    await act(async () => dnd.props.onDragEnd({
      active: { data: { current: { service } } },
      over: { data: { current: { date: '2026-11-03', slotMin: 600 } } },
    }));
    await act(async () => { await modal.props.onConfirm({ notificationType: 'none', scope: 'this_only' }); });
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('Reschedule failed'));
    expect(modal.props.open).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

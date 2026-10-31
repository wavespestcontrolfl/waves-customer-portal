// @vitest-environment jsdom
// Month-grid drag is a date-only move: the visit must keep its stored
// window. The month feed sends duration 30 when estimated_duration_minutes is
// null, and a drop used to post 09:00-09:30 for a 09:00-10:30 visit.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonthViewV2 } from './CalendarViewsV2';

const dnd = vi.hoisted(() => ({ props: null }));
const modal = vi.hoisted(() => ({ props: null }));

vi.mock('@dnd-kit/core', () => ({
  DndContext: (props) => { dnd.props = props; return <div>{props.children}</div>; },
  PointerSensor: function PointerSensor() {},
  useSensor: () => ({}),
  useSensors: () => [],
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, isDragging: false }),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  pointerWithin: vi.fn(),
}));

vi.mock('./RescheduleConfirmModal', () => ({
  default: (props) => {
    modal.props = props;
    return props.open
      ? <button type="button" onClick={() => props.onConfirm({ notificationType: 'none', scope: 'this_only' })}>Confirm move</button>
      : null;
  },
}));

function monthPayload(service) {
  const days = Array.from({ length: 7 }, (_, index) => ({
    date: `2026-07-${String(6 + index).padStart(2, '0')}`,
    dayNum: 6 + index,
    isCurrentMonth: true,
    isToday: false,
    services: index === 0 ? [service] : [],
    count: index === 0 ? 1 : 0,
  }));
  return {
    weeks: [days],
    summary: { totalServices: 1, completed: 0, pending: 1, uniqueCustomers: 1, byCategory: {} },
  };
}

async function dragToJuly7(service) {
  fetch.mockImplementation((url, options = {}) => {
    if (options.method === 'POST') return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
    return Promise.resolve({ ok: true, json: async () => monthPayload(service) });
  });
  render(<MonthViewV2 date="2026-07-01" onDateClick={vi.fn()} onViewCustomer={vi.fn()} />);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/admin/schedule/month?month=2026-07', expect.anything()));
  await act(async () => dnd.props.onDragEnd({
    active: { data: { current: { service } } },
    over: { data: { current: { date: '2026-07-07' } } },
  }));
  expect(modal.props.open).toBe(true);
  const confirmDuration = modal.props.durationMinutes;
  fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }));
  await waitFor(() => expect(fetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true));
  const [, postOptions] = fetch.mock.calls.find(([, options]) => options?.method === 'POST');
  return { body: JSON.parse(postOptions.body), confirmDuration };
}

const base = {
  id: 'svc-1',
  customerName: 'Sample Customer',
  customerId: 'customer-1',
  serviceType: 'Pest Control',
  status: 'confirmed',
};

describe('MonthViewV2 drag keeps the stored window', () => {
  beforeEach(() => {
    localStorage.setItem('waves_admin_token', 'test-token');
    global.fetch = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('posts the full stored window when the feed fell back to duration 30', async () => {
    const { body, confirmDuration } = await dragToJuly7({ ...base, windowStart: '09:00:00', windowEnd: '10:30:00', duration: 30 });
    expect(body).toMatchObject({ newDate: '2026-07-07', newWindow: '09:00-10:30' });
    expect(confirmDuration).toBe(90);
  });

  it('uses the duration when the visit has no stored end', async () => {
    const { body } = await dragToJuly7({ ...base, windowStart: '09:00', windowEnd: null, duration: 45 });
    expect(body).toMatchObject({ newDate: '2026-07-07', newWindow: '09:00-09:45' });
  });

  it('keeps a windowless visit windowless', async () => {
    const { body } = await dragToJuly7({ ...base, windowStart: null, windowEnd: null, duration: 30 });
    expect(body).toMatchObject({ newDate: '2026-07-07', newWindow: null });
  });
});

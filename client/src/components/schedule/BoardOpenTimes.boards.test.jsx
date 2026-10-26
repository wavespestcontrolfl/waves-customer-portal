// @vitest-environment jsdom
// Open times on the Dispatch day and week grids (GATE_BOARD_OPEN_TIMES): a
// drag lights the hours that fit the visit (the day grid on every route, the
// week grid on the visit's own route); the drop path is unchanged.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TimeGridDay from './TimeGridDay';
import TimeGridDays from './TimeGridDays';

// The drag library, with the context's handlers kept so a test can start and cancel a drag.
const dnd = vi.hoisted(() => ({ props: null }));
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

const DATE = '2035-01-02';
const VISIT = {
  id: 'svc-1', customerId: 'cust-1', customerName: 'First Customer', serviceType: 'Pest Control', status: 'confirmed',
  windowStart: '08:00', windowEnd: '09:00', windowDisplay: '8–9 AM', technicianId: 'tech-1', technicianName: 'Alex Tech',
};
const TECHS = [{ id: 'tech-1', name: 'Alex Tech' }, { id: 'tech-2', name: 'Blair Tech' }];
const hour = (start, detour, techId) => ({
  start_time: start, end_time: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`, detour_minutes: detour, technician: { id: techId },
});
const openTimes = (days) => ({ ok: true, json: async () => ({ slots: [], summary: { days, open_times: { from: days[0].date, to: days[days.length - 1].date } } }) });
const findBodies = () => fetch.mock.calls.filter(([url]) => String(url).includes('/find-time')).map(([, init]) => JSON.parse(init.body));
const dragStart = (service) => act(() => { dnd.props.onDragStart({ active: { data: { current: { service } } } }); });
const column = (name) => screen.getByText(name, { selector: 'span.truncate' }).closest('div.relative');

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
  dnd.props = null;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('day grid', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async (url) => (String(url).includes('/find-time')
      ? openTimes([{ date: DATE, status: 'open', hours: [hour('10:00', 5, 'tech-1'), hour('09:00', 41, 'tech-2')] }])
      : { ok: true, json: async () => ({}) }));
  });

  it('a drag lights each technician\'s fitting hours in place of the Open blocks; a cancel puts them back', async () => {
    render(<TimeGridDay date={DATE} services={[VISIT]} technicians={TECHS} onCreateSlot={vi.fn()} openTimesOnDrag />);
    expect(screen.getAllByRole('button', { name: /Book open hour/ }).length).toBeGreaterThan(0);
    dragStart(VISIT);
    await waitFor(() => expect(screen.getAllByTestId('board-open-time')).toHaveLength(2));
    expect(findBodies()).toEqual([expect.objectContaining({ serviceId: 'svc-1', dateFrom: DATE, dateTo: DATE, openTimes: true })]);
    expect(findBodies()[0]).not.toHaveProperty('technicianId');
    // Each route's hour in its own column: Alex's +5 is the best, Blair's +41 is amber.
    expect(within(column('Alex Tech')).getByTestId('board-open-time')).toHaveTextContent('adds ~5 minBest');
    const blair = within(column('Blair Tech')).getByTestId('board-open-time');
    expect(blair).toHaveTextContent('adds ~41 min');
    expect(blair).toHaveAttribute('data-far', 'true');
    expect(screen.queryAllByRole('button', { name: /Book open hour/ })).toHaveLength(0);
    act(() => { dnd.props.onDragCancel(); });
    expect(screen.queryAllByTestId('board-open-time')).toHaveLength(0);
    expect(screen.getAllByRole('button', { name: /Book open hour/ }).length).toBeGreaterThan(0);
  });

  it('gate off: a drag asks nothing and lights nothing', async () => {
    render(<TimeGridDay date={DATE} services={[VISIT]} technicians={TECHS} onCreateSlot={vi.fn()} />);
    dragStart(VISIT);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(findBodies()).toHaveLength(0);
    expect(screen.queryAllByTestId('board-open-time')).toHaveLength(0);
  });
});

describe('week grid', () => {
  const week = {
    startDate: '2035-01-01',
    days: [
      { date: '2035-01-01', dayOfWeek: 'Monday', dayNum: '1', services: [VISIT] },
      { date: '2035-01-02', dayOfWeek: 'Tuesday', dayNum: '2', services: [] },
    ],
  };
  beforeEach(() => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/find-time')) {
        return openTimes([{ date: '2035-01-01', status: 'full', hours: [] }, { date: '2035-01-02', status: 'open', hours: [hour('13:00', 7, 'tech-1')] }]);
      }
      return { ok: true, json: async () => week };
    });
  });

  it('a drag lights the visit\'s own route day by day; an unassigned visit lights nothing', async () => {
    render(<TimeGridDays date="2035-01-01" dayCount={7} openTimesOnDrag />);
    await screen.findByText('First Customer');
    dragStart(VISIT);
    await waitFor(() => expect(screen.getAllByTestId('board-open-time')).toHaveLength(1));
    expect(findBodies()).toEqual([expect.objectContaining({ technicianId: 'tech-1', dateFrom: '2035-01-01', dateTo: '2035-01-02' })]);
    expect(screen.getByTestId('board-open-time')).toHaveTextContent('adds ~7 minBest');
    act(() => { dnd.props.onDragCancel(); });
    dragStart({ ...VISIT, id: 'svc-9', technicianId: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(findBodies()).toHaveLength(1);
    expect(screen.queryAllByTestId('board-open-time')).toHaveLength(0);
  });
});

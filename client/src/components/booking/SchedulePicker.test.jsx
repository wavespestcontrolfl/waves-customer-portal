// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SchedulePicker, { pickerRange } from './SchedulePicker';

vi.mock('../../lib/timezone', () => ({ etDateString: () => '2026-09-07' }));

afterEach(cleanup);

const DAY = {
  date: '2026-09-08',
  fullDate: 'Tuesday, September 8',
  nearby: true,
  slots: [
    { slotId: 'a', start_time: '09:00', start_label: '9:00 AM', nearby: true },
    { slotId: 'b', start_time: '09:00', start_label: '9:00 AM', nearby: false },
    { slotId: 'c', start_time: '13:00', start_label: '1:00 PM', nearby: false },
  ],
};

describe('SchedulePicker', () => {
  it('labels only the route-optimal time as nearby, not every time on a nearby day', () => {
    render(<SchedulePicker availability={{ days: [DAY] }} selectedDate={DAY.date} onSelectDay={() => {}} selectedSlot={null} onSelectSlot={() => {}} />);
    expect(screen.getAllByText('Tech nearby')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Choose 1:00 PM on Tuesday, September 8$/ })).toBeInTheDocument();
  });

  it('resolves a ranked pick by slotId when two technicians share a start time', () => {
    const onSelectSlot = vi.fn();
    render(
      <SchedulePicker
        availability={{ days: [DAY] }}
        rankedSlots={[{ slotId: 'b', date: DAY.date, start_time: '09:00' }]}
        selectedDate={DAY.date}
        onSelectDay={() => {}}
        selectedSlot={null}
        onSelectSlot={onSelectSlot}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Pick/ }));
    expect(onSelectSlot).toHaveBeenCalledWith(expect.objectContaining({ slotId: 'b' }));
  });
});

describe('empty availability', () => {
  it('still shows the submit error when a refresh comes back with no days', () => {
    render(<SchedulePicker availability={{ days: [] }} selectedDate={null} onSelectDay={() => {}} selectedSlot={null} onSelectSlot={() => {}} submitError="That time was just taken — here are the latest open times." empty={<p>Nothing open.</p>} />);
    expect(screen.getByRole('alert')).toHaveTextContent('just taken');
    expect(screen.getByText('Nothing open.')).toBeInTheDocument();
  });
});

describe('PickerBestTimes ordering', () => {
  it('orders same-nearby picks by engine rank, not list order, before slicing to three', () => {
    // /book hands the curated list chronologically; rank 1 sits last.
    const slots = [
      { start_time: '08:00', start_label: '8:00 AM', nearby: false, rank: 3 },
      { start_time: '10:00', start_label: '10:00 AM', nearby: false, rank: 4 },
      { start_time: '12:00', start_label: '12:00 PM', nearby: false, rank: 2 },
      { start_time: '14:00', start_label: '2:00 PM', nearby: false, rank: 1 },
    ];
    const day = { ...DAY, nearby: false, slots };
    render(
      <SchedulePicker
        availability={{ days: [day] }}
        rankedSlots={slots.map((s) => ({ date: day.date, start_time: s.start_time }))}
        selectedDate={day.date}
        onSelectDay={() => {}}
        selectedSlot={null}
        onSelectSlot={() => {}}
      />,
    );
    const chips = screen.getAllByRole('button', { name: /Pick/ }).map((b) => b.textContent);
    expect(chips.map((t) => t.match(/\d{1,2}:\d{2} [AP]M/)[0])).toEqual(['2:00 PM', '12:00 PM', '8:00 AM']);
  });
});

describe('pickerRange', () => {
  it('starts the grid at a first opening that sits past the two-week window', () => {
    // A picked date 15 days out must not draw two weeks of empty cells first.
    expect(pickerRange([{ date: '2026-09-22' }])).toEqual({ rangeFrom: '2026-09-22', rangeTo: '2026-10-05' });
    // Inside the window the grid keeps today as its origin.
    expect(pickerRange([{ date: '2026-09-15' }])).toEqual({ rangeFrom: '2026-09-07', rangeTo: '2026-09-20' });
  });
});

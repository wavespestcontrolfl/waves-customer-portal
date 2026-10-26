// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RescheduleModal } from './SchedulePage';

vi.mock('../../components/schedule/useSlotConflicts', () => ({ useSlotConflicts: () => ({ conflicts: [] }) }));
const bestTimes = vi.hoisted(() => ({ args: null }));
vi.mock('../../components/schedule/useBestTimes', () => ({
  useBestTimes: (args) => { bestTimes.args = args; return { pickedByTech: [], availability: undefined }; },
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const service = { id: 'fixture-visit', customerName: 'Fixture customer', serviceType: 'Pest service', scheduledDate: '2035-01-02', windowStart: '08:00', windowEnd: '09:30' };

it('keeps the duration and notification choice when rescheduling through labeled fields', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ options: [] }) }));
  vi.stubGlobal('fetch', fetchMock);
  const onClose = vi.fn(), onRescheduled = vi.fn();
  render(<RescheduleModal service={service} onClose={onClose} onRescheduled={onRescheduled} />);
  const dialog = screen.getByRole('dialog', { name: 'Reschedule service' });
  expect(dialog).toHaveAttribute('data-ui-density', 'comfortable');
  fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Fixture note' } });
  expect(screen.getByLabelText('Client booking notifications')).toHaveValue('none');
  fireEvent.click(screen.getByRole('button', { name: /Pick Custom Date/ }));
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2035-01-03' } });
  fireEvent.change(screen.getByLabelText('Start Time'), { target: { value: '10:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reschedule', exact: true }));
  await waitFor(() => expect(onRescheduled).toHaveBeenCalledOnce());
  const write = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST');
  expect(write).toBeTruthy();
  expect(JSON.parse(write[1].body)).toMatchObject({ newDate: '2035-01-03', newWindow: { start: '10:00', end: '11:30' }, reasonText: 'Fixture note', notifyCustomer: false, deriveWindowFromCurrentVisit: true });
  expect(onClose).toHaveBeenCalledOnce();
});

it('cancels without requesting a reschedule', () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ options: [] }) }));
  vi.stubGlobal('fetch', fetchMock);
  const onClose = vi.fn();
  render(<RescheduleModal service={service} onClose={onClose} onRescheduled={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});

it('the custom picker asks for the open-times box on the visit\'s own route (GATE_OPEN_TIMES_BOX)', () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ options: [] }) })));
  render(<RescheduleModal service={{ ...service, technicianId: 'fixture-tech' }} onClose={vi.fn()} onRescheduled={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /Pick Custom Date/ }));
  expect(bestTimes.args).toMatchObject({ openTimes: true, technicianId: 'fixture-tech' });
  // The reschedule cannot change the technician: no tech pick.
  expect(bestTimes.args.techPick).toBeFalsy();
});

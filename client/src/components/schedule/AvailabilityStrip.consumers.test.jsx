// @vitest-environment jsdom
// The availability strip on the three screens PR 3 adds it to: each shows
// the strip from the hook's summary answer and drops the route warning the
// strip already states (the double-booking notice stays).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RescheduleConfirmModal from './RescheduleConfirmModal';
import RainOutSheet from './RainOutSheet';
import CreateAppointmentModal from './CreateAppointmentModal';
import { visitServiceArgs } from './visitServiceArgs';

const hooks = vi.hoisted(() => ({ availability: null, conflicts: [] }));
vi.mock('./useBestTimes', () => ({
  useBestTimes: (args) => {
    hooks.bestTimesArgs = args;
    return { bestTimes: [], picked: null, bestInRange: null, availability: hooks.availability, checking: false };
  },
}));
vi.mock('./useSlotConflicts', () => ({ useSlotConflicts: () => ({ conflicts: hooks.conflicts }) }));

const DATE = '2035-01-02';
const hour = (start, over = {}) => ({
  date: DATE, start, end: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`, detourMinutes: 4,
  technicianId: 'tech-1', technicianName: null, ...over,
});
const missAt = (start) => ({
  pickedDate: DATE,
  picked: { start, fits: false, reason: 'arrival_window', detourMinutes: null },
  days: [{ date: DATE, status: 'open', hours: [hour('11:00'), hour('13:00')] }],
});
const ROUTE_WARNING = { warning: 'Fixture route warning: an arrival window would be missed.' };
const DOUBLE_BOOKING = { customerName: 'Fixture Neighbor', windowStart: '09:00', windowEnd: '10:00' };

const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
  vi.stubGlobal('scrollTo', vi.fn());
  hooks.availability = null;
  hooks.conflicts = [];
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('drag-drop confirm: a display-only strip, and the route warning it covers is dropped', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ enabled: false })));
  hooks.availability = missAt('09:00');
  hooks.conflicts = [ROUTE_WARNING, DOUBLE_BOOKING];
  render(
    <RescheduleConfirmModal
      open customerName="Fixture Customer" fromDate="2035-01-01" fromMinutes={480} toDate={DATE} toMinutes={540}
      serviceId="svc-1" technicianId="tech-1" toWindow="09:00-10:00" onConfirm={vi.fn()} onCancel={vi.fn()}
    />,
  );
  expect(screen.getByTestId('availability-strip')).toHaveTextContent("9 AM");
  expect(screen.getByTestId('availability-strip')).toHaveTextContent("doesn't fit");
  for (const chip of screen.getAllByTestId('availability-hour')) expect(chip).toBeDisabled();
  expect(screen.queryByText(ROUTE_WARNING.warning)).not.toBeInTheDocument();
  expect(screen.getByText(/Fixture Neighbor is already booked/)).toBeInTheDocument();
});

it('drag-drop confirm: asks for the best-times rows with the visit\'s services and shows them display-only', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ enabled: false })));
  hooks.availability = {
    ...missAt('09:00'),
    best: { day: [hour('11:00', { rainChance: 15 })], week: [hour('10:00', { date: '2035-01-03', rainChance: 65 })], weekCovered: true },
  };
  render(
    <RescheduleConfirmModal
      open customerName="Fixture Customer" fromDate="2035-01-01" fromMinutes={480} toDate={DATE} toMinutes={540}
      serviceId="svc-1" technicianId="tech-1" toWindow="09:00-10:00" onConfirm={vi.fn()} onCancel={vi.fn()}
      {...visitServiceArgs({ serviceType: 'Fixture Lawn Care', serviceKey: 'fixture_lawn' })}
    />,
  );
  const rows = await screen.findAllByTestId('best-row');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('15% rain');
  expect(rows[1]).toHaveTextContent('65% rain');
  for (const chip of screen.getAllByTestId('availability-hour')) expect(chip).toBeDisabled();
  expect(hooks.bestTimesArgs).toMatchObject({ bestRows: true, serviceTypes: ['Fixture Lawn Care'], serviceKeys: ['fixture_lawn'] });
});

it('visitServiceArgs: the primary service, add-on lines and a shared stop, keys in the same order', () => {
  expect(visitServiceArgs(
    { service_type: 'Fixture Pest', service_key: 'fixture_pest', visit: { serviceTypes: ['Fixture Pest', 'Fixture Mosquito'] } },
    [{ serviceType: 'Fixture Lawn Care', serviceKey: 'fixture_lawn' }, { serviceType: '' }],
  )).toEqual({ serviceTypes: ['Fixture Pest', 'Fixture Lawn Care', 'Fixture Mosquito'], serviceKeys: ['fixture_pest', 'fixture_lawn', ''] });
  expect(visitServiceArgs(null)).toEqual({ serviceTypes: [], serviceKeys: [] });
});

it('drag-drop confirm with the gate off: no strip, the route warning stays', () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ enabled: false })));
  hooks.conflicts = [ROUTE_WARNING];
  render(
    <RescheduleConfirmModal
      open customerName="Fixture Customer" fromDate="2035-01-01" fromMinutes={480} toDate={DATE} toMinutes={540}
      serviceId="svc-1" technicianId="tech-1" toWindow="09:00-10:00" onConfirm={vi.fn()} onCancel={vi.fn()}
    />,
  );
  expect(screen.queryByTestId('availability-strip')).not.toBeInTheDocument();
  expect(screen.getByText(ROUTE_WARNING.warning)).toBeInTheDocument();
});

it('rain-out: on a preset the strip is display-only (the preset fixes the time)', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).includes('/rain-out-options')
    ? json({ sameDay: [], days: [{ kind: 'day', date: DATE, window: { start: '09:00', end: '10:00' } }], service: { window: { start: '08:00', end: '09:00' } } })
    : json({}))));
  hooks.availability = missAt('09:00');
  render(<RainOutSheet service={{ id: 'svc-1', technicianId: 'tech-1', customerId: 'cust-1', scheduledDate: '2035-01-01' }} onClose={vi.fn()} onDone={vi.fn()} />);
  const strip = await screen.findByTestId('availability-strip');
  expect(strip).toHaveTextContent("doesn't fit");
  for (const chip of screen.getAllByTestId('availability-hour')) expect(chip).toBeDisabled();
});

it('rain-out: asks for the best-times rows and shows each chip with its hourly rain, like New Appointment', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).includes('/rain-out-options')
    ? json({
      sameDay: [{ kind: 'same_day', date: DATE, window: { start: '14:00', end: '15:00' }, display: 'Today, 2:00 PM-3:00 PM', rainChance: 80 }],
      days: [{ kind: 'day', date: DATE, window: { start: '09:00', end: '10:00' }, display: 'Fixture day, 9:00 AM-10:00 AM', rainChance: 74, rainScope: 'day' }],
      service: { window: { start: '08:00', end: '09:00' } },
    })
    : json({}))));
  hooks.availability = {
    ...missAt('14:00'),
    best: {
      day: [hour('11:00', { rainChance: 15, driveInMinutes: 8, driveSource: 'google' })],
      week: [hour('10:00', { date: '2035-01-03', rainChance: 65 })],
      weekCovered: true,
    },
  };
  render(<RainOutSheet service={{ id: 'svc-1', technicianId: 'tech-1', customerId: 'cust-1', scheduledDate: '2035-01-01', serviceType: 'Fixture Lawn Care' }} onClose={vi.fn()} onDone={vi.fn()} />);
  const rows = await screen.findAllByTestId('best-row');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('15% rain');
  expect(rows[1]).toHaveTextContent('65% rain');
  expect(hooks.bestTimesArgs).toMatchObject({ bestRows: true, serviceTypes: ['Fixture Lawn Care'], serviceKeys: [''] });
  // A "later today" preset carries its own hour's chance; a day-level fallback says so.
  expect(screen.getByText('80% rain')).toBeInTheDocument();
  expect(screen.getByText('74% rain that day')).toBeInTheDocument();
});

it('new appointment: taking a chip sets the date, the hour and the technician it was scored for', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    if (u.endsWith('/admin/technicians')) return json({ technicians: [{ id: 'tech-1', name: 'Fixture Tech' }] });
    if (u.includes('/properties?context=appointment_address')) return json({ properties: [], canChangeAppointmentAddress: false });
    if (u.includes('/schedule-estimates')) return json({ estimates: [] });
    if (u.endsWith('/admin/dispatch/slot-check')) return json({ ok: true, results: [{ conflicts: [] }] });
    return json({});
  }));
  hooks.availability = { ...missAt('09:00'), picked: null };
  render(
    <CreateAppointmentModal
      defaultCustomer={{ id: 'cust-1', firstName: 'Fixture', lastName: 'Customer' }}
      defaultDate={DATE} defaultWindowStart="09:00" onClose={vi.fn()} onCreated={vi.fn()} onChange={vi.fn()}
    />,
  );
  const strip = await screen.findByTestId('availability-strip');
  const eleven = [...strip.querySelectorAll('[data-testid="availability-hour"]')].find((chip) => chip.textContent.startsWith('11 AM'));
  expect(eleven).toBeEnabled();
  fireEvent.click(eleven);
  await waitFor(() => expect(screen.getAllByTestId('availability-hour').find((chip) => chip.textContent.startsWith('11 AM'))).toHaveAttribute('aria-pressed', 'true'));
});

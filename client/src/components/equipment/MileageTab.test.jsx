// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MileageTab from './MileageTab';

const today = { date: '2026-10-29', total_miles: 44.5, business_miles: 40.5, trip_count: 3, drive_minutes: 80, idle_minutes: 7, customer_stops: 2, irs_deduction: 29.36 };
const mtd = { month: '2026-10-01', total_miles: 150.5, business_miles: 146.5, trip_count: 5, irs_deduction: 106.21, fuel_consumed_gal: 6.5, drive_days: 2, avg_daily_miles: 75.3 };
const liveOne = { id: 'imei-1', imei: 'imei-1', nickname: 'Truck One', isRunning: false };
const liveTwo = { id: 'imei-2', imei: 'imei-2', nickname: 'Truck Two', isRunning: true };

const BASE = { today, mtd, live_vehicle: liveOne };
const WITH_VEHICLES = {
  ...BASE,
  vehicles: [
    {
      vehicle_id: 'imei-2', vehicle_name: 'Truck Two', technician: 'Sample Alpha',
      today: { ...today, total_miles: 30.5 }, mtd: { ...mtd, total_miles: 130.5, business_miles: 130.5, irs_deduction: 94.61 },
    },
    {
      vehicle_id: 'imei-1', vehicle_name: 'Truck One', technician: null,
      today: { ...today, total_miles: 14 }, mtd: { ...mtd, total_miles: 20, business_miles: 16, irs_deduction: 11.6 },
    },
  ],
  live_vehicles: [{ ...liveOne, technician: null }, { ...liveTwo, technician: 'Sample Alpha' }, { id: 'imei-3', imei: 'imei-3', nickname: 'New Van', isRunning: false, technician: 'Sample Beta' }],
};

function mockDashboard(body) {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('MileageTab dashboard, per vehicle', () => {
  it('gate off (no vehicles lists): no vehicle table and today\'s headings', async () => {
    mockDashboard(BASE);
    render(<MileageTab />);
    await screen.findByText('Today — 2026-10-29');
    expect(screen.queryByText('Vehicles')).not.toBeInTheDocument();
    expect(screen.queryByText(/All vehicles/)).not.toBeInTheDocument();
    expect(screen.getByText('Live Vehicle Status')).toBeInTheDocument();
  });

  it('gate on: one row per vehicle with technician, miles, deduction and live state; totals read All vehicles', async () => {
    mockDashboard(WITH_VEHICLES);
    render(<MileageTab />);
    await screen.findByText('Vehicles');
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    const [two, one, three] = rows.map(r => within(r).getAllByRole('cell').map(c => c.textContent));
    expect(two).toEqual(['Truck Two', 'Sample Alpha', '30.5', '130.5', '130.5', '$94.61', 'RUNNING']);
    expect(one).toEqual(['Truck One', '--', '14.0', '20.0', '16.0', '$11.60', 'STOPPED']);
    // a tracker with no trips yet still shows, at zero
    expect(three).toEqual(['New Van', 'Sample Beta', '0.0', '0.0', '0.0', '$0.00', 'STOPPED']);
    await waitFor(() => expect(screen.getByText('All vehicles · Today — 2026-10-29')).toBeInTheDocument());
    expect(screen.getByText('All vehicles — month to date')).toBeInTheDocument();
  });

  it('gate on with no mileage rows yet: live vehicles alone make the rows', async () => {
    mockDashboard({ ...BASE, vehicles: [], live_vehicles: [{ ...liveOne, technician: 'Sample Beta' }] });
    render(<MileageTab />);
    await screen.findByText('Vehicles');
    const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell').map(c => c.textContent);
    expect(cells.slice(0, 2)).toEqual(['Truck One', 'Sample Beta']);
  });
});

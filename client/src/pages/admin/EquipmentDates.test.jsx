// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EquipmentMaintenancePage from './EquipmentMaintenancePage';
import EquipmentCalibrationPanel from './EquipmentCalibrationPanel';

const id = '00000000-0000-4000-8000-000000000001';
const asset = {
  id, name: 'Synthetic vehicle', category: 'vehicle', status: 'active',
  purchase_date: '2026-01-01T00:00:00.000Z', warranty_expiration: '2026-03-08',
  current_miles: 100, next_maintenance: { task_name: 'Next inspection', next_due_at: '2026-11-01' },
};
const schedule = { id: 'schedule-example', task_name: 'Synthetic inspection', next_due_at: '2026-12-31T00:00:00.000Z' };
const calibration = { id: 'calibration-example', carrier_gal_per_1000: 2, expires_at: '2026-03-09T02:00:00Z', verified_at: '2026-01-01T02:00:00Z' };
let requests;
beforeEach(() => {
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const pathname = new URL(url, 'http://localhost').pathname;
    requests.push({ pathname, options });
    let body = {};
    if (pathname.endsWith('/equipment-systems/reconciliation')) body = { systems: [] };
    else if (pathname.endsWith('/equipment-systems')) body = { systems: [{ id, name: 'Synthetic rig', asset_ids: [] }] };
    else if (pathname.includes('/equipment-systems/')) body = { calibration };
    else if (pathname.endsWith('/equipment-maintenance')) body = { equipment: [asset] };
    else if (pathname.endsWith('/schedules/due')) body = { schedules: [schedule] };
    else if (pathname.endsWith('/mileage')) body = { logs: [{ id: 'log-example', log_date: '2026-01-02T00:00:00.000Z', total_miles: 20 }], summary: {} };
    else if (pathname.endsWith('/' + id)) body = { equipment: asset, schedules: [schedule], recentRecords: [{ id: 'record-example', task_name: 'Recorded service', performed_at: '2026-01-01T02:00:00Z' }] };
    return { ok: true, json: async () => body };
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function openVerification() {
  const view = render(<EquipmentCalibrationPanel />);
  await screen.findByRole('option', { name: /Synthetic rig/ });
  fireEvent.change(view.container.querySelector('select'), { target: { value: id } });
  fireEvent.click(await screen.findByRole('button', { name: 'Verify Calibration', exact: true }));
  return view;
}

function measuredInput(label) {
  const text = screen.getByText(label, { exact: true });
  return text.parentElement.querySelector('input');
}

describe('Equipment calendar dates', () => {
  it('preserves purchase, warranty, due and mileage days while formatting actual timestamps in Eastern time', async () => {
    render(<MemoryRouter><EquipmentMaintenancePage embedded /></MemoryRouter>);
    const name = await screen.findByText(asset.name, { exact: true });
    expect(screen.getByText('(11/1/2026)')).toBeInTheDocument();
    fireEvent.click(name);
    expect(await screen.findByText('1/1/2026', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('Expires 3/8/2026')).toBeInTheDocument();
    expect(screen.getByText('12/31/2026', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('12/31/2025', { exact: true })).toBeInTheDocument();
    expect(await screen.findByText('1/2/2026', { exact: true })).toBeInTheDocument();
  });

  it('preserves the upcoming schedule day in Analytics', async () => {
    render(<MemoryRouter><EquipmentMaintenancePage embedded initialTab="analytics" /></MemoryRouter>);
    expect(await screen.findByText('12/31/2026', { exact: true })).toBeInTheDocument();
  });

  it.each([
    ['2026-09-09T23:30:00-04:00', '2026-09-09'],
    ['2026-12-31T23:30:00-05:00', '2026-12-31'],
    ['2026-03-07T23:30:00-05:00', '2026-03-07'],
  ])('defaults verification to the Eastern day at %s', async (now, day) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now));
    const view = await openVerification();
    expect(view.container.querySelector('input[type="date"]')).toHaveValue(day);
  });

  it.each([
    ['2026-03-08', '2026-03-08T16:00:00.000Z'],
    ['2026-11-01', '2026-11-01T17:00:00.000Z'],
  ])('serializes noon Eastern on %s with the correct daylight-saving offset', async (day, expected) => {
    const view = await openVerification();
    fireEvent.change(measuredInput('Measured sqft'), { target: { value: '1000' } });
    fireEvent.change(measuredInput('Measured gallons'), { target: { value: '2' } });
    fireEvent.change(view.container.querySelector('input[type="date"]'), { target: { value: day } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Field Verified', exact: true }));
    await waitFor(() => expect(requests.some(r => r.options.method === 'POST')).toBe(true));
    const write = requests.find(r => r.options.method === 'POST');
    expect(JSON.parse(write.options.body)).toEqual({
      verified_test_area_sqft: 1000, verified_captured_gallons: 2,
      verified_at: expected, verification_notes: null,
    });
  });

  it('treats calibration expiry and verification values as timestamps', async () => {
    await openVerification();
    expect(screen.getByText('3/8/2026', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('Verified 12/31/2025', { exact: true })).toBeInTheDocument();
  });
});

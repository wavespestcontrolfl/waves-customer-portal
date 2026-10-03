// @vitest-environment jsdom
// Technician allow-list (owner 2026-10-02): equipment is READ-ONLY for a
// technician login, except calibration entry and verification (owner
// 2026-10-03). Every other write control is hidden for a technician (the
// routes 403 at the staff default-deny flip) and still shown to an admin.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EquipmentPage from './EquipmentPage';
import EquipmentMaintenancePage from './EquipmentMaintenancePage';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));

const ok = (body) => ({ ok: true, json: async () => body });
const ASSET = { id: 'e1', name: 'Synthetic sprayer', category: 'sprayer', status: 'active' };
const MIX = { id: 'mix-1', name: 'Synthetic mix', products: [] };
const ALERTS = [{ id: 'a1', severity: 'high', title: 'Synthetic alert' }];
const VEHICLE = { id: 'v1', name: 'Synthetic truck', category: 'vehicle', status: 'active' };
const SYSTEM = { id: 'sys-1', name: 'Synthetic system' };

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/equipment-maintenance/alerts')) return ok({ alerts: ALERTS });
    if (u.includes('/equipment-maintenance/analytics/overview')) return ok({ total_assets: 1 });
    if (/\/equipment-maintenance\/v1$/.test(u)) {
      return ok({ equipment: VEHICLE, schedules: [], recentRecords: [], costOfOwnership: {} });
    }
    if (u.includes('/equipment-maintenance/v1/mileage')) return ok({ logs: [] });
    if (u.endsWith('/admin/equipment-maintenance')) return ok({ equipment: [VEHICLE] });
    if (u.includes('/equipment-systems/reconciliation')) return ok({ systems: [] });
    if (/\/equipment-systems\/sys-1/.test(u)) return ok({ system: SYSTEM, active_calibration: null });
    if (u.endsWith('/admin/equipment-systems')) return ok({ systems: [SYSTEM] });
    if (u.includes('/tank-mixes')) return ok({ tank_mixes: [MIX] });
    if (u.includes('/equipment/equipment')) return ok({ equipment: [ASSET] });
    return ok({});
  }));
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Shell({ role }) {
  return <Outlet context={{ user: { role } }} />;
}
function mountPage(query, role) {
  render(<MemoryRouter initialEntries={[`/?${query}`]}><Routes>
    <Route element={<Shell role={role} />}><Route path="/" element={<EquipmentPage />} /></Route>
  </Routes></MemoryRouter>);
}

describe('equipment assets', () => {
  it('shows a technician the asset list without Add Equipment or Edit', async () => {
    mountPage('tab=assets', 'technician');
    await screen.findByText(ASSET.name);
    expect(screen.queryByRole('button', { name: /Add Equipment/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('shows an admin Add Equipment and Edit', async () => {
    mountPage('tab=assets', 'admin');
    await screen.findByText(ASSET.name);
    expect(screen.getByRole('button', { name: /Add Equipment/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });
});

describe('equipment tank mixes', () => {
  it('hides Recalc from a technician and offers it to an admin', async () => {
    mountPage('tab=tank-mixes', 'technician');
    await screen.findByText(MIX.name);
    expect(screen.queryByRole('button', { name: 'Recalc' })).not.toBeInTheDocument();
    cleanup();
    mountPage('tab=tank-mixes', 'admin');
    await screen.findByText(MIX.name);
    expect(screen.getByRole('button', { name: 'Recalc' })).toBeInTheDocument();
  });
});

describe('equipment maintenance', () => {
  it('shows a read-only fleet: no Dismiss, Record Maintenance or Log Mileage', async () => {
    render(<MemoryRouter><EquipmentMaintenancePage readOnly /></MemoryRouter>);
    await screen.findByText(/1 Active Alert/);
    expect(screen.getByText('Synthetic alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByText(VEHICLE.name));
    // Wait for the expanded card's detail read so its action row would be on screen.
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => /\/equipment-maintenance\/v1$/.test(String(url)))).toBe(true));
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Record Maintenance' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log Mileage' })).not.toBeInTheDocument();
  });

  it('keeps Dismiss, Record Maintenance and Log Mileage for an admin', async () => {
    render(<MemoryRouter><EquipmentMaintenancePage /></MemoryRouter>);
    await screen.findByText(/1 Active Alert/);
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    fireEvent.click(await screen.findByText(VEHICLE.name));
    expect(await screen.findByRole('button', { name: 'Record Maintenance' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log Mileage' })).toBeInTheDocument();
  });

  it('passes readOnly down from the page for a technician', async () => {
    mountPage('tab=maintenance', 'technician');
    await screen.findByText(/1 Active Alert/);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    cleanup();
    mountPage('tab=maintenance', 'admin');
    await screen.findByText(/1 Active Alert/);
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });
});

describe('equipment calibrations', () => {
  // Owner 2026-10-03: calibration entry and verification stay open to a
  // technician (both routes are on the technician allow-list).
  it.each(['technician', 'admin'])('keeps the new-calibration form for a %s', async (role) => {
    mountPage('tab=calibrations', role);
    await screen.findByText('Equipment Calibration');
    expect(screen.getByText('New calibration test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save Calibration/ })).toBeInTheDocument();
  });
});

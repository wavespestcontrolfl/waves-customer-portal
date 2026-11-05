// @vitest-environment jsdom
// Technician visibility audit 2026-11-04 (C2, C10, A6): the equipment pages
// carry no money for a technician. The server strips the fields; each page
// must render cleanly without them: no "$0", no "undefined", no empty money
// cards, no mileage log, no reconciliation panel, and no request for the two
// reads the server now refuses a technician. An admin still sees every figure.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EquipmentPage from './EquipmentPage';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));

const ok = (body) => ({ ok: true, json: async () => body });
const VEHICLE = { id: 'v1', name: 'Synthetic truck', category: 'vehicle', status: 'active', current_hours: 40, condition_rating: 8 };
const MONEY_VEHICLE = {
  ...VEHICLE, purchase_price: 31000, book_value: 21000, depreciation_method: 'section_179', avg_maintenance_cost: 55,
};
const RECORD = { id: 'r1', task_name: 'Oil change', maintenance_type: 'scheduled', performed_at: '2026-01-15T15:00:00Z', performed_by: 'Pat Example' };
const SCHEDULE = { id: 's1', task_name: 'Oil change', priority: 'normal', interval_days: 90 };
const SYSTEM = { id: 'sys-1', name: 'Synthetic system' };
const TECH_MIX = {
  id: 'mix-1', name: 'Synthetic mix', service_type: 'lawn', tank_size_gal: 100, coverage_sqft: 10000,
  products: [{ product_name: 'Synthetic A', rate_per_1000sf: 1, rate_unit: 'oz', oz_per_tank: 8 }],
};
const ADMIN_MIX = {
  ...TECH_MIX, cost_per_tank: 6.67, cost_per_1000sf: 0.667,
  products: [{ ...TECH_MIX.products[0], cost: 6.67 }],
};

let payload;
function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/equipment-maintenance/alerts')) return ok({ alerts: [] });
    if (u.includes('/equipment-maintenance/analytics/overview')) return ok(payload.overview);
    if (/\/equipment-maintenance\/v1$/.test(u)) {
      return ok({ equipment: payload.vehicle, schedules: [SCHEDULE], recentRecords: [payload.record], costOfOwnership: payload.cost });
    }
    if (u.includes('/equipment-maintenance/v1/mileage')) return ok({
      logs: [{ id: 1, log_date: '2026-01-14', total_miles: 20, fuel_cost: 30, irs_deduction_amount: 14 }],
      summary: { total_miles: 20, business_miles: 20, total_fuel_cost: 30, total_irs_deduction: 14 },
    });
    if (u.endsWith('/admin/equipment-maintenance')) return ok({ equipment: [payload.vehicle] });
    if (u.includes('/equipment-systems/reconciliation')) return ok({ systems: [], equipment: [], tax_register: [], summary: {} });
    if (/\/equipment-systems\/sys-1/.test(u)) return ok({ system: SYSTEM, active_calibration: null });
    if (u.endsWith('/admin/equipment-systems')) return ok({ systems: [SYSTEM] });
    if (u.includes('/tank-mixes')) return ok({ tank_mixes: [payload.mix] });
    if (u.includes('/equipment/equipment')) return ok({ equipment: [payload.vehicle] });
    return ok({});
  }));
}

const TECH = {
  vehicle: VEHICLE, record: RECORD, cost: null, mix: TECH_MIX,
  overview: { total_assets: 1, overdue_maintenance: 0, ytd_total_miles: 900, open_alerts: 0 },
};
const ADMIN = {
  vehicle: MONEY_VEHICLE,
  record: { ...RECORD, total_cost: 35 },
  cost: { purchase_price: 31000, total_maintenance: 35, total_fuel: 30, total_cost: 31065, monthly_cost: 500, age_months: 62 },
  mix: ADMIN_MIX,
  overview: { total_assets: 1, overdue_maintenance: 0, ytd_maintenance_spend: 500, ytd_total_miles: 900, ytd_fuel_cost: 120, ytd_irs_deduction: 560, open_alerts: 0 },
};

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
function mountPage(query, role, override = {}) {
  payload = { ...(role === 'admin' ? ADMIN : TECH), ...override };
  render(<MemoryRouter initialEntries={[`/?${query}`]}><Routes>
    <Route element={<Shell role={role} />}><Route path="/" element={<EquipmentPage />} /></Route>
  </Routes></MemoryRouter>);
}
const urls = () => fetch.mock.calls.map(([url]) => String(url));
const cleanText = () => expect(document.body.textContent).not.toMatch(/\$|undefined|NaN|null/);

describe('Assets tab', () => {
  it('shows a technician the asset with no cost, book value or "$"', async () => {
    mountPage('tab=assets', 'technician');
    await screen.findAllByText(VEHICLE.name);
    expect(screen.getByText('Hours:')).toBeInTheDocument();
    cleanText();
  });

  it('shows a technician no money even if a payload still carried it', async () => {
    mountPage('tab=assets', 'technician', { vehicle: MONEY_VEHICLE });
    await screen.findAllByText(VEHICLE.name);
    expect(screen.getByText('Hours:')).toBeInTheDocument();
    expect(screen.queryByText('Cost:')).not.toBeInTheDocument();
    expect(screen.queryByText('Book:')).not.toBeInTheDocument();
  });

  it('still shows an admin the cost and book value', async () => {
    mountPage('tab=assets', 'admin');
    await screen.findAllByText(VEHICLE.name);
    expect(screen.getByText('Cost:')).toBeInTheDocument();
    expect(screen.getByText('Book:')).toBeInTheDocument();
  });
});

describe('Maintenance tab', () => {
  async function openCard() {
    fireEvent.click(await screen.findByText(VEHICLE.name));
    await screen.findByText('Maintenance History');
  }

  it('shows a technician the fleet with no spend cards, cost columns, cost of ownership or mileage log', async () => {
    mountPage('tab=maintenance', 'technician');
    await screen.findByText('Total Assets');
    expect(screen.getByText('YTD Mileage')).toBeInTheDocument();
    for (const label of ['YTD Maintenance', 'YTD Fuel', 'YTD IRS Deduction']) expect(screen.queryByText(label)).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Sort: Cost' })).not.toBeInTheDocument();
    await openCard();
    expect(screen.queryByText('Cost of Ownership')).not.toBeInTheDocument();
    expect(screen.queryByText(/Mileage Log/)).not.toBeInTheDocument();
    for (const heading of ['Est Cost', 'Cost']) expect(screen.queryByRole('columnheader', { name: heading })).not.toBeInTheDocument();
    expect(screen.getAllByText('Oil change').length).toBeGreaterThan(0);
    cleanText();
  });

  it('never asks the server for the mileage log on behalf of a technician', async () => {
    mountPage('tab=maintenance', 'technician');
    await openCard();
    expect(urls().some((u) => u.includes('/mileage'))).toBe(false);
  });

  it('still shows an admin the spend cards, the cost of ownership and the mileage log', async () => {
    mountPage('tab=maintenance', 'admin');
    await screen.findByText('YTD Maintenance');
    expect(screen.getByText('YTD Fuel')).toBeInTheDocument();
    expect(screen.getByText('YTD IRS Deduction')).toBeInTheDocument();
    fireEvent.click(await screen.findByText(VEHICLE.name));
    await screen.findByText('Maintenance History');
    expect(await screen.findByText('Cost of Ownership')).toBeInTheDocument();
    expect(await screen.findByText(/Mileage Log/)).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Est Cost' })).toBeInTheDocument();
  });
});

describe('Mixes tab', () => {
  it('shows a technician the recipe and rates with no cost per tank, per 1,000 sq ft or Cost column', async () => {
    mountPage('tab=tank-mixes', 'technician');
    await screen.findByText('Synthetic mix');
    expect(screen.getByText('Synthetic A')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Oz/Tank' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Cost' })).not.toBeInTheDocument();
    expect(screen.queryByText(/\$.*\/tank/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$.*\/1000sf/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\/tank$/)).not.toBeInTheDocument();
    cleanText();
  });

  it('still shows an admin the cost per tank and per 1,000 sq ft', async () => {
    mountPage('tab=tank-mixes', 'admin');
    await screen.findByText('Synthetic mix');
    expect(screen.getByText('$6.67/tank')).toBeInTheDocument();
    expect(screen.getByText('$0.67/1000sf')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Cost' })).toBeInTheDocument();
  });
});

describe('Calibrations tab', () => {
  it('does not ask a technician for the reconciliation report and shows no panel', async () => {
    mountPage('tab=calibrations', 'technician');
    await waitFor(() => expect(urls().some((u) => u.endsWith('/admin/equipment-systems'))).toBe(true));
    await screen.findByText('Synthetic system', { exact: false });
    expect(urls().some((u) => u.includes('/equipment-systems/reconciliation'))).toBe(false);
    expect(screen.queryByText('Equipment reconciliation')).not.toBeInTheDocument();
  });

  it('still loads and shows the reconciliation report for an admin', async () => {
    mountPage('tab=calibrations', 'admin');
    await waitFor(() => expect(urls().some((u) => u.includes('/equipment-systems/reconciliation'))).toBe(true));
    expect(await screen.findByText('Equipment reconciliation')).toBeInTheDocument();
  });
});

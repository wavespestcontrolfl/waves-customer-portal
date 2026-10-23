// @vitest-environment jsdom
// Truck-check alerts (tool_missing / tool_damaged, server/services/truck-kit.js)
// resolve with an outcome from the Fleet alert banner; every other alert keeps
// its Dismiss.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EquipmentMaintenancePage from './EquipmentMaintenancePage';

const ok = (body) => ({ ok: true, json: async () => body });
const ALERTS = [
  { id: 'a-missing', severity: 'high', alert_type: 'tool_missing', title: 'Missing: Moisture meter T-002 (truck check by Synthetic Tech)' },
  { id: 'a-damaged', severity: 'high', alert_type: 'tool_damaged', title: 'Damaged: B&G sprayer T-001 (truck check by Synthetic Tech)' },
  { id: 'a-due', severity: 'medium', alert_type: 'maintenance_due', title: 'Oil change due' },
];
let puts;

beforeEach(() => {
  puts = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/equipment-maintenance/alerts/') && options.method === 'PUT') { puts.push([u, JSON.parse(options.body)]); return ok({ alert: {} }); }
    if (u.includes('/equipment-maintenance/alerts')) return ok({ alerts: ALERTS });
    if (u.includes('/equipment-maintenance/analytics/overview')) return ok({ total_assets: 1 });
    if (u.endsWith('/admin/equipment-maintenance')) return ok({ equipment: [] });
    return ok({});
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const rowOf = (title) => within(screen.getByText(title).parentElement);

describe('truck-check alert outcomes', () => {
  it('offers Found / Lost on a missing tool, Repaired / Retired on a damaged one, Dismiss elsewhere', async () => {
    render(<MemoryRouter><EquipmentMaintenancePage /></MemoryRouter>);
    await screen.findByText(/3 Active Alerts/);
    expect(rowOf(ALERTS[0].title).getByRole('button', { name: 'Found' })).toBeInTheDocument();
    expect(rowOf(ALERTS[0].title).getByRole('button', { name: 'Lost' })).toBeInTheDocument();
    expect(rowOf(ALERTS[1].title).getByRole('button', { name: 'Repaired' })).toBeInTheDocument();
    expect(rowOf(ALERTS[1].title).getByRole('button', { name: 'Retired' })).toBeInTheDocument();
    expect(rowOf(ALERTS[2].title).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(rowOf(ALERTS[2].title).queryByRole('button', { name: 'Lost' })).not.toBeInTheDocument();
  });

  it('Lost resolves the alert with its outcome and drops it from the banner; Dismiss sends no outcome', async () => {
    render(<MemoryRouter><EquipmentMaintenancePage /></MemoryRouter>);
    await screen.findByText(/3 Active Alerts/);
    fireEvent.click(rowOf(ALERTS[0].title).getByRole('button', { name: 'Lost' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0][0]).toMatch(/\/alerts\/a-missing$/);
    expect(puts[0][1]).toEqual({ status: 'resolved', resolved_by: 'admin', outcome: 'lost' });
    await waitFor(() => expect(screen.queryByText(ALERTS[0].title)).not.toBeInTheDocument());
    fireEvent.click(rowOf(ALERTS[2].title).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1][1]).toEqual({ status: 'resolved', resolved_by: 'admin' });
  });

  it('a technician sees the truck-check alerts without any outcome button', async () => {
    render(<MemoryRouter><EquipmentMaintenancePage readOnly /></MemoryRouter>);
    await screen.findByText(/3 Active Alerts/);
    expect(screen.queryByRole('button', { name: /Found|Lost|Repaired|Retired|Dismiss/ })).not.toBeInTheDocument();
  });
});

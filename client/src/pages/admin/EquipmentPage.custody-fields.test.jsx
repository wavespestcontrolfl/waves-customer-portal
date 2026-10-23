// @vitest-environment jsdom
// Truck kit plumbing (docs/tool-inventory-tracker-scope.md, PR 0): the Assets
// tab shows which truck an item rides on and who holds it, filters one
// truck's roster, and the dialog writes asset_tag, location,
// assigned_vehicle_id and condition_rating through pickers instead of a bare
// uuid text input.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EquipmentPage from './EquipmentPage';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));

const ok = (body) => ({ ok: true, json: async () => body });
const TRUCK = { id: 'v1', name: 'Synthetic truck', asset_tag: 'VEH-001', category: 'vehicle', status: 'active', assigned_tech_name: 'Unassigned' };
const TOOL = {
  id: 'e1', name: 'Synthetic moisture meter', category: 'tool', status: 'active', asset_tag: 'T-001', location: 'van',
  condition_rating: 7, assigned_vehicle_id: 'v1', assigned_vehicle_name: 'Synthetic truck', assigned_vehicle_tag: 'VEH-001',
  assigned_to: 't1', assigned_tech_name: 'Synthetic tech',
};
const LOOSE = { id: 'e2', name: 'Synthetic duster', category: 'tool', status: 'active', assigned_vehicle_id: null, assigned_tech_name: 'Unassigned' };
const DEAD_TRUCK = { id: 'v9', name: 'Synthetic old van', asset_tag: 'VEH-009', category: 'vehicle', status: 'retired', assigned_tech_name: 'Unassigned' };
const TECHS = [
  { id: 't1', name: 'Synthetic tech', employment_status: 'active' },
  { id: 't9', name: 'Prospective placeholder', employment_status: 'prospective' },
];
let puts;

function installFetch() {
  puts = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/admin/timetracking/technicians')) return ok({ technicians: TECHS });
    if (u.includes('/equipment/equipment/e1') && options.method === 'PUT') { puts.push(JSON.parse(options.body)); return ok({ equipment: TOOL }); }
    if (u.includes('/equipment/equipment')) return ok({ equipment: [TRUCK, TOOL, LOOSE, DEAD_TRUCK] });
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
function mountAssets(role = 'admin') {
  render(<MemoryRouter initialEntries={['/?tab=assets']}><Routes>
    <Route element={<Shell role={role} />}><Route path="/" element={<EquipmentPage />} /></Route>
  </Routes></MemoryRouter>);
}
const cardOf = (name) => screen.getByText(name).closest('[class*="p-4"]');

describe('assets custody', () => {
  it('shows the tag, the truck and the holder on the card', async () => {
    mountAssets();
    const card = within(cardOf(await screen.findByText(TOOL.name) && TOOL.name));
    expect(card.getByText('T-001 · Truck: Synthetic truck · Holder: Synthetic tech')).toBeInTheDocument();
    expect(card.getByText('7/10')).toBeInTheDocument();
    expect(card.getByText('van')).toBeInTheDocument();
    // A row on no truck with no holder carries no custody line.
    expect(within(cardOf(LOOSE.name)).queryByText(/Truck:|Holder:/)).not.toBeInTheDocument();
  });

  it('filters one truck or the rows on no truck', async () => {
    mountAssets();
    await screen.findByText(TOOL.name);
    const filter = screen.getByLabelText('Truck');
    expect(within(filter).getByRole('option', { name: 'VEH-001 · Synthetic truck' })).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: 'none' } });
    expect(screen.getByText(LOOSE.name)).toBeInTheDocument();
    expect(screen.queryByText(TOOL.name)).not.toBeInTheDocument();
    expect(screen.queryByText(TRUCK.name)).not.toBeInTheDocument();
    fireEvent.change(filter, { target: { value: 'v1' } });
    expect(screen.getByText(TOOL.name)).toBeInTheDocument();
    expect(screen.queryByText(LOOSE.name)).not.toBeInTheDocument();
  });

  it('the dialog offers trucks and active holders and saves the custody fields', async () => {
    mountAssets();
    await screen.findByText(TOOL.name);
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('/admin/timetracking/technicians'))).toBe(true));
    fireEvent.click(within(cardOf(TOOL.name)).getByRole('button', { name: 'Edit' }));
    const dialog = within(await screen.findByRole('dialog'));
    const truck = dialog.getByLabelText('Truck');
    expect(truck).toHaveValue('v1');
    expect(within(truck).getByRole('option', { name: 'Not on a truck' })).toBeInTheDocument();
    // A retired truck is never offered as a target.
    expect(within(truck).queryByRole('option', { name: /Synthetic old van/ })).not.toBeInTheDocument();
    const holder = dialog.getByLabelText('Assigned To');
    expect(holder).toHaveValue('t1');
    expect(within(holder).getByRole('option', { name: 'Synthetic tech' })).toBeInTheDocument();
    expect(within(holder).queryByRole('option', { name: 'Prospective placeholder' })).not.toBeInTheDocument();
    expect(dialog.getByLabelText('Asset tag')).toHaveValue('T-001');

    fireEvent.change(dialog.getByLabelText('Condition (1 to 10)'), { target: { value: '6' } });
    fireEvent.change(dialog.getByLabelText('Kept'), { target: { value: 'storage' } });
    fireEvent.change(truck, { target: { value: '' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual(expect.objectContaining({
      asset_tag: 'T-001', location: 'storage', assigned_vehicle_id: null, assigned_to: 't1', condition_rating: 6,
      // The status the form loaded rides along, so a stale form cannot resurrect a lost item.
      expected_status: 'active',
    }));
  });

  it('recategorizing a tool as a vehicle clears the truck it rode on', async () => {
    mountAssets();
    await screen.findByText(TOOL.name);
    fireEvent.click(within(cardOf(TOOL.name)).getByRole('button', { name: 'Edit' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByLabelText('Truck')).toHaveValue('v1');
    fireEvent.change(dialog.getByLabelText('Category'), { target: { value: 'vehicle' } });
    expect(dialog.queryByLabelText('Truck')).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual(expect.objectContaining({ category: 'vehicle', assigned_vehicle_id: null }));
  });

  it('a vehicle row is never offered a truck and tool is a category', async () => {
    mountAssets();
    await screen.findByText(TRUCK.name);
    fireEvent.click(within(cardOf(TRUCK.name)).getByRole('button', { name: 'Edit' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.queryByLabelText('Truck')).not.toBeInTheDocument();
    expect(within(dialog.getByLabelText('Category')).getByRole('option', { name: 'tool' })).toBeInTheDocument();
    expect(within(dialog.getByLabelText('Category')).getByRole('option', { name: 'safety' })).toBeInTheDocument();
  });

  it('a technician sees the custody line but never loads the holder list', async () => {
    mountAssets('technician');
    expect(await screen.findByText('T-001 · Truck: Synthetic truck · Holder: Synthetic tech')).toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/admin/timetracking/technicians'))).toBe(false);
  });
});

// PR 2: the kit key names what a tool is; the dialog suggests the keys the
// checklists use and saves the typed key with the other custody fields.
describe('kit key', () => {
  it('offers the checklist keys as suggestions and saves the typed key', async () => {
    const stub = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, options = {}) => {
      if (String(url).includes('/admin/equipment/kit-keys')) return ok({ enabled: true, keys: [{ kit_key: 'moisture_meter', label: 'Moisture meter' }] });
      return stub(url, options);
    });
    mountAssets();
    await screen.findByText(TOOL.name);
    fireEvent.click(within(cardOf(TOOL.name)).getByRole('button', { name: 'Edit' }));
    const dialog = within(await screen.findByRole('dialog'));
    const key = dialog.getByLabelText('Kit key');
    expect(key).toHaveAttribute('list', 'equipment-kit-keys');
    await waitFor(() => expect(document.querySelector('#equipment-kit-keys option[value="moisture_meter"]')).not.toBeNull());
    fireEvent.change(key, { target: { value: 'moisture_meter' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual(expect.objectContaining({ kit_key: 'moisture_meter' }));
  });

  it('with GATE_TRUCK_KIT off the dialog has no Kit key field and sends no kit_key', async () => {
    const stub = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, options = {}) => {
      if (String(url).includes('/admin/equipment/kit-keys')) return { ok: false, status: 404, json: async () => ({ enabled: false }) };
      return stub(url, options);
    });
    mountAssets();
    await screen.findByText(TOOL.name);
    fireEvent.click(within(cardOf(TOOL.name)).getByRole('button', { name: 'Edit' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByLabelText('Asset tag')).toBeInTheDocument();
    expect(dialog.queryByLabelText('Kit key')).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).not.toHaveProperty('kit_key');
  });

  it('a vehicle row has no kit key', async () => {
    const stub = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, options = {}) => {
      if (String(url).includes('/admin/equipment/kit-keys')) return ok({ enabled: true, keys: [] });
      return stub(url, options);
    });
    mountAssets();
    await screen.findByText(TRUCK.name);
    fireEvent.click(within(cardOf(TRUCK.name)).getByRole('button', { name: 'Edit' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.queryByLabelText('Kit key')).not.toBeInTheDocument();
  });
});

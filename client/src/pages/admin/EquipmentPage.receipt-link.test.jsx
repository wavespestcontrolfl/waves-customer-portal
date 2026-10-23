// @vitest-environment jsdom
// Receipt → equipment link (docs/tool-inventory-tracker-scope.md, PR 3): the
// inventory agent's bell links to /admin/equipment?tab=assets with
// receipt_line=<id> and either new=1&name=… (a new-row dialog with the name
// filled in) or edit=<row id> (that row's dialog); the save carries
// receipt_line_id and the link leaves the URL once the save lands.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EquipmentPage from './EquipmentPage';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));

const ok = (body) => ({ ok: true, json: async () => body });
const LINE = '44444444-2222-4333-8444-555555555555';
const TOOL = { id: 'e1', name: 'Synthetic moisture meter', category: 'tool', status: 'active', assigned_vehicle_id: null, assigned_tech_name: 'Unassigned', updated_at: '2026-10-23T12:00:00.000Z' };
let writes;

function installFetch() {
  writes = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/admin/timetracking/technicians')) return ok({ technicians: [] });
    if (u.includes('/admin/equipment/kit-keys')) return ok({ enabled: true, keys: [] });
    if (u.includes('/equipment/equipment') && (options.method === 'PUT' || options.method === 'POST')) { writes.push({ method: options.method, body: JSON.parse(options.body) }); return ok({ equipment: TOOL }); }
    if (u.includes('/equipment/equipment')) return ok({ equipment: [TOOL] });
    return ok({});
  }));
}

let lastSearch = '';
function Shell() {
  const location = useLocation();
  lastSearch = location.search;
  return <Outlet context={{ user: { role: 'admin' } }} />;
}
function mount(entry) {
  render(<MemoryRouter initialEntries={[entry]}><Routes>
    <Route element={<Shell />}><Route path="/" element={<EquipmentPage />} /></Route>
  </Routes></MemoryRouter>);
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); installFetch(); lastSearch = ''; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('receipt link on the Assets tab', () => {
  it('new=1&name opens a new tool row with the name filled in; the save carries receipt_line_id and clears the link', async () => {
    mount(`/?tab=assets&new=1&name=${encodeURIComponent('Extech MO55 Moisture Meter')}&receipt_line=${LINE}`);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Add Equipment');
    expect(dialog).toHaveTextContent('files a purchase receipt line');
    expect(screen.getByLabelText('Name *')).toHaveValue('Extech MO55 Moisture Meter');
    expect(screen.getByLabelText('Category')).toHaveValue('tool');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].method).toBe('POST');
    expect(writes[0].body).toMatchObject({ name: 'Extech MO55 Moisture Meter', receipt_line_id: LINE });
    await waitFor(() => expect(lastSearch).not.toContain('receipt_line'));
    expect(lastSearch).not.toContain('name=');
  });

  it('edit=<row> opens that row with the link; a save without the link sends no receipt_line_id', async () => {
    mount(`/?tab=assets&edit=e1&receipt_line=${LINE}`);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Edit Equipment');
    expect(screen.getByLabelText('Name *')).toHaveValue('Synthetic moisture meter');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ method: 'PUT', body: { receipt_line_id: LINE } });
    await waitFor(() => expect(lastSearch).not.toContain('edit='));
    // The ordinary edit path (no link) never sends the field.
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].body).not.toHaveProperty('receipt_line_id');
  });

  it('a technician never opens the dialog from the link', async () => {
    render(<MemoryRouter initialEntries={[`/?tab=assets&new=1&name=x&receipt_line=${LINE}`]}><Routes>
      <Route element={<Outlet context={{ user: { role: 'technician' } }} />}><Route path="/" element={<EquipmentPage />} /></Route>
    </Routes></MemoryRouter>);
    await screen.findByText('Synthetic moisture meter');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// @vitest-environment jsdom
// products_catalog.service_lines in Inventory: an admin tags which service lines
// apply a product (the tech lawn sheet lists lawn-tagged products only) and
// saves it on its own PUT; a technician's read-only view has no such control.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import InventoryPage from './InventoryPage';
import { IntelligenceBarPageDataProvider } from '../../hooks/useIntelligenceBarPageData';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));

const productId = '10000000-0000-4000-8000-000000000002';
const reply = (data) => ({ ok: true, json: async () => data });
const PRODUCT = {
  id: productId,
  name: 'Arena 50 WDG',
  category: 'insecticide',
  inventoryOnHand: 4,
  inventoryUnit: 'oz',
  serviceLines: null,
  vendorPricing: [],
};

function installFetch(product = PRODUCT) {
  vi.stubGlobal('fetch', vi.fn((url) => {
    const path = String(url);
    if (path.includes('/movements')) return Promise.resolve(reply({ movements: [] }));
    if (path.includes('/inventory/vendors')) return Promise.resolve(reply({ vendors: [] }));
    if (path.includes('/inventory?')) return Promise.resolve(reply({ products: [product], categories: [], total: 1 }));
    return Promise.resolve(reply({}));
  }));
}

function Host({ role }) {
  return <IntelligenceBarPageDataProvider><Outlet context={{ user: { role } }} /></IntelligenceBarPageDataProvider>;
}
function mount(role) {
  render(<MemoryRouter initialEntries={[`/admin/inventory?tab=products&search=Arena&productId=${productId}`]}><Routes>
    <Route element={<Host role={role} />}><Route path="/admin/inventory" element={<InventoryPage />} /></Route>
  </Routes></MemoryRouter>);
}
const editor = () => screen.getByText('Service lines').parentElement;

beforeEach(() => { vi.stubGlobal('localStorage', { getItem: () => 'synthetic-test' }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('inventory service lines', () => {
  it('an untagged product reads Not tagged with the line boxes off; ticking Lawn and Pest saves exactly those lines', async () => {
    installFetch();
    mount('admin');
    await screen.findByText('Service lines');
    const box = within(editor());
    expect(box.getByLabelText('Not tagged')).toBeChecked();
    expect(box.getByLabelText('Lawn')).toBeDisabled();
    fireEvent.click(box.getByLabelText('Not tagged'));
    expect(box.getByLabelText('Lawn')).toBeEnabled();
    fireEvent.click(box.getByLabelText('Lawn'));
    fireEvent.click(box.getByLabelText('Pest'));
    fireEvent.click(box.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const [url, init] = fetch.mock.calls.find(([, i]) => i?.method === 'PUT');
    expect(String(url)).toContain(`/admin/inventory/${productId}`);
    expect(JSON.parse(init.body)).toEqual({ serviceLines: ['lawn', 'pest'] });
  });

  it('a tagged product starts on its lines, and Not tagged clears them to null', async () => {
    installFetch({ ...PRODUCT, serviceLines: ['lawn'] });
    mount('admin');
    await screen.findByText('Service lines');
    const box = within(editor());
    expect(box.getByLabelText('Not tagged')).not.toBeChecked();
    expect(box.getByLabelText('Lawn')).toBeChecked();
    expect(box.getByLabelText('Pest')).not.toBeChecked();
    fireEvent.click(box.getByLabelText('Not tagged'));
    fireEvent.click(box.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const [, init] = fetch.mock.calls.find(([, i]) => i?.method === 'PUT');
    expect(JSON.parse(init.body)).toEqual({ serviceLines: null });
  });

  it('a technician sees no Service lines control', async () => {
    installFetch();
    mount('technician');
    await screen.findByText(/Stock:/);
    expect(screen.queryByText('Service lines')).not.toBeInTheDocument();
  });
});

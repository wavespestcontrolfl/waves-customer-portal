// @vitest-environment jsdom
// products_catalog.bid_list in Inventory: an admin ticks "Show on the Bid kit product list (bid work)" and saves it on the
// product PUT (bidList true or false); a technician's read-only view has no such control.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import InventoryPage from './InventoryPage';
import { IntelligenceBarPageDataProvider } from '../../hooks/useIntelligenceBarPageData';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));

const productId = '10000000-0000-4000-8000-000000000003';
const reply = (data) => ({ ok: true, json: async () => data });
const PRODUCT = {
  id: productId,
  name: 'Termidor SC',
  category: 'termiticide',
  inventoryOnHand: 4,
  inventoryUnit: 'oz',
  bidList: false,
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
  render(<MemoryRouter initialEntries={[`/admin/inventory?tab=products&search=Termidor&productId=${productId}`]}><Routes>
    <Route element={<Host role={role} />}><Route path="/admin/inventory" element={<InventoryPage />} /></Route>
  </Routes></MemoryRouter>);
}
const editor = () => screen.getByText('Bid kit product list').parentElement;

beforeEach(() => { vi.stubGlobal('localStorage', { getItem: () => 'synthetic-test' }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('inventory bid kit product list setting', () => {
  it('an unticked product starts unchecked; ticking and saving sends bidList true on the product PUT, with the helper line shown', async () => {
    installFetch();
    mount('admin');
    await screen.findByText('Bid kit product list');
    const box = within(editor());
    expect(box.getByLabelText('Show on the Bid kit product list (bid work)')).not.toBeChecked();
    expect(box.getByText(/Adds this product under 'Products proposed for bid work'\. You sign off the list again after a change\./)).toBeInTheDocument();
    fireEvent.click(box.getByLabelText('Show on the Bid kit product list (bid work)'));
    fireEvent.click(box.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const [url, init] = fetch.mock.calls.find(([, i]) => i?.method === 'PUT');
    expect(String(url)).toContain(`/admin/inventory/${productId}`);
    expect(JSON.parse(init.body)).toEqual({ bidList: true });
  });

  it('a ticked product starts checked; unticking saves bidList false', async () => {
    installFetch({ ...PRODUCT, bidList: true });
    mount('admin');
    await screen.findByText('Bid kit product list');
    const box = within(editor());
    expect(box.getByLabelText('Show on the Bid kit product list (bid work)')).toBeChecked();
    fireEvent.click(box.getByLabelText('Show on the Bid kit product list (bid work)'));
    fireEvent.click(box.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const [, init] = fetch.mock.calls.find(([, i]) => i?.method === 'PUT');
    expect(JSON.parse(init.body)).toEqual({ bidList: false });
  });

  it('a technician sees no Bid kit product list control', async () => {
    installFetch();
    mount('technician');
    await screen.findByText(/Stock:/);
    expect(screen.queryByText('Bid kit product list')).not.toBeInTheDocument();
  });
});

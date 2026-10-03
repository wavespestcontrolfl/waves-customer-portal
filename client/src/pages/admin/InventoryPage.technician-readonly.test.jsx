// @vitest-environment jsdom
// Technician allow-list (owner 2026-10-02): inventory is READ-ONLY for a
// technician login. Every write control the client offers must be hidden for a
// technician (the routes 403 at the staff default-deny flip) and still shown
// to an admin.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import InventoryPage from './InventoryPage';
import { IntelligenceBarPageDataProvider } from '../../hooks/useIntelligenceBarPageData';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));

const productId = '10000000-0000-4000-8000-000000000001';
const requestId = '20000000-0000-4000-8000-000000000001';
const reply = (data) => ({ ok: true, json: async () => data });
const PRODUCT = {
  id: productId,
  name: 'Synthetic stock product',
  inventoryOnHand: 4,
  inventoryUnit: 'lb',
  vendorPricing: [{ vendorId: 'v1', vendorName: 'Synthetic Vendor', price: 12.5, quantity: '1 gal' }],
};
const FORECAST_ROW = {
  productId,
  productName: 'Synthetic stock product',
  status: 'short',
  committedDemand: 5,
  demandUnit: 'lb',
  inventoryUnit: 'lb',
  recommendedOrderQuantity: 3,
  appointments: [],
};
const OPEN_REQUEST = {
  id: requestId,
  productId,
  productName: 'Synthetic stock product',
  status: 'open',
  priority: 'normal',
  requestedQuantity: 2,
  unit: 'lb',
  inventoryUnit: 'lb',
};

function installFetch() {
  vi.stubGlobal('fetch', vi.fn((url) => {
    const path = String(url);
    if (path.includes('/waveguard-forecast?')) return Promise.resolve(reply({ forecast: { products: [FORECAST_ROW], days: 14 } }));
    if (path.includes('/restock-requests?')) return Promise.resolve(reply({ requests: [OPEN_REQUEST] }));
    if (path.includes('/movements')) return Promise.resolve(reply({ movements: [] }));
    if (path.includes('/inventory/vendors')) return Promise.resolve(reply({ vendors: [{ id: 'v1', name: 'Synthetic Vendor', active: true }] }));
    if (path.includes('/inventory?')) return Promise.resolve(reply({ products: [PRODUCT], categories: [], total: 1 }));
    return Promise.resolve(reply({}));
  }));
}

function Host({ role }) {
  return <IntelligenceBarPageDataProvider><Outlet context={{ user: { role } }} /></IntelligenceBarPageDataProvider>;
}
function mount(query, role) {
  render(<MemoryRouter initialEntries={[`/admin/inventory?${query}`]}><Routes>
    <Route element={<Host role={role} />}><Route path="/admin/inventory" element={<InventoryPage />} /></Route>
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => 'synthetic-test' });
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('inventory product detail', () => {
  it('hides price, refresh and stock-adjustment writes from a technician but keeps the read-only data', async () => {
    mount(`tab=products&search=Synthetic&productId=${productId}`, 'technician');
    await screen.findByText('Movement History');
    expect(screen.getByText('Synthetic Vendor')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Price' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply Adjustment' })).not.toBeInTheDocument();
  });

  it('still offers those writes to an admin', async () => {
    mount(`tab=products&search=Synthetic&productId=${productId}`, 'admin');
    await screen.findByText('Movement History');
    expect(screen.getByRole('button', { name: 'Add Price' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply Adjustment' })).toBeInTheDocument();
  });
});

describe('inventory forecast and restock queue', () => {
  it('shows a technician the forecast without the restock-request button', async () => {
    mount('tab=forecast', 'technician');
    await screen.findByText('Synthetic stock product');
    expect(screen.queryByRole('button', { name: /^Request / })).not.toBeInTheDocument();
    expect(screen.getByText('Owner places requests')).toBeInTheDocument();
  });

  it('offers an admin the restock-request button', async () => {
    mount('tab=forecast', 'admin');
    expect(await screen.findByRole('button', { name: /^Request / })).toBeInTheDocument();
  });

  it('shows a technician the restock queue without Mark Ordered, Receive or Cancel', async () => {
    mount(`tab=restock&requestId=${requestId}`, 'technician');
    await screen.findByText('Synthetic stock product');
    expect(screen.queryByRole('button', { name: 'Mark Ordered' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Receive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('offers an admin Mark Ordered, Receive and Cancel', async () => {
    mount(`tab=restock&requestId=${requestId}`, 'admin');
    expect(await screen.findByRole('button', { name: 'Mark Ordered' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
});

describe('inventory unit review tab', () => {
  it('is owner-only: a technician deep link falls back to Products and the tab is not listed', async () => {
    mount('tab=unit-review', 'technician');
    await screen.findByText('Synthetic stock product');
    expect(screen.queryByText('Inventory unit review')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Units' })).not.toBeInTheDocument();
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('/unit-review'))).toBe(false));
  });
});

// @vitest-environment jsdom
// Technician visibility audit 2026-11-04 (C1, C27, A17): a technician's
// Inventory tabs carry no prices, vendors, pricing flag or other customers'
// names. The server strips the fields; the screen must also render cleanly
// without them: no empty Best Price / Unit Cost / Vendor / Status columns, no
// priced / needs-price filters, and no "undefined" beside a visit date.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import InventoryPage from './InventoryPage';
import { IntelligenceBarPageDataProvider } from '../../hooks/useIntelligenceBarPageData';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));

const productId = '10000000-0000-4000-8000-000000000001';
const reply = (data) => ({ ok: true, json: async () => data });
// A technician's product row: the server sent no price, vendor or pricing flag.
const TECH_PRODUCT = { id: productId, name: 'Synthetic stock product', category: 'Herbicide', inventoryOnHand: 4, inventoryUnit: 'lb', vendorPricing: [] };
const ADMIN_PRODUCT = { ...TECH_PRODUCT, bestPrice: 12.5, bestVendor: 'Synthetic Vendor', needsPricing: false, vendorPricing: [] };
const FORECAST_ROW = {
  productId,
  productName: 'Synthetic stock product',
  status: 'short',
  committedDemand: 5,
  demandUnit: 'lb',
  inventoryUnit: 'lb',
  recommendedOrderQuantity: 3,
  appointments: [
    { serviceId: 'own-visit', scheduledDate: '2030-01-09', customerName: 'Pat Example', amount: 2, unit: 'lb', serviceType: 'Lawn Care' },
    { serviceId: 'other-visit', scheduledDate: '2030-01-10', amount: 3, unit: 'lb', serviceType: 'Lawn Care' },
  ],
};
const FORECAST = {
  products: [FORECAST_ROW],
  days: 7,
  errors: [{ serviceId: 'bad-visit', scheduledDate: '2030-01-11', message: 'Plan unavailable' }],
};

let product;
function installFetch() {
  vi.stubGlobal('fetch', vi.fn((url) => {
    const path = String(url);
    if (path.includes('/waveguard-forecast?')) return Promise.resolve(reply({ forecast: FORECAST }));
    if (path.includes('/inventory/vendors')) return Promise.resolve(reply({ vendors: [] }));
    if (path.includes('/inventory/stats')) return Promise.resolve(reply({ products: { total: 1, priced: null, needsPrice: null, lowStock: 0 }, restockRequests: { open: 0 } }));
    if (path.includes('/inventory?')) return Promise.resolve(reply({ products: [product], categories: [], total: 1 }));
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
  product = TECH_PRODUCT;
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Inventory Products tab', () => {
  it('shows a technician no Best Price, Unit Cost, Vendor or Status column and no priced filters', async () => {
    mount('tab=products', 'technician');
    await screen.findByText('Synthetic stock product');
    for (const heading of ['Best Price', 'Unit Cost', 'Vendor', 'Status']) {
      expect(screen.queryByRole('columnheader', { name: heading })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Priced' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Needs Price' })).not.toBeInTheDocument();
    expect(screen.queryByText('Needs Price')).not.toBeInTheDocument();
    expect(screen.queryByText('Priced')).not.toBeInTheDocument();
    // The stock columns stay.
    expect(screen.getByRole('columnheader', { name: 'Stock' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Low Stock' })).toBeInTheDocument();
  });

  it('still shows an admin the price columns and the priced filters', async () => {
    product = ADMIN_PRODUCT;
    mount('tab=products', 'admin');
    await screen.findByText('Synthetic stock product');
    for (const heading of ['Best Price', 'Unit Cost', 'Vendor', 'Status']) {
      expect(screen.getByRole('columnheader', { name: heading })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Priced' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Needs Price' })).toBeInTheDocument();
  });
});

describe('Inventory Forecast tab', () => {
  it('names a customer only where the server sent a name, and never prints "undefined"', async () => {
    mount('tab=forecast', 'technician');
    await screen.findByText('Synthetic stock product');
    expect(screen.getByText(/Pat Example/)).toBeInTheDocument();
    expect(screen.getByText('2030-01-10')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/undefined|null/);
  });

  it('shows a plan error without a customer name', async () => {
    mount('tab=forecast', 'technician');
    await screen.findByText('Plan errors');
    expect(screen.getByText(/2030-01-11/)).toHaveTextContent('2030-01-11: Plan unavailable');
  });
});

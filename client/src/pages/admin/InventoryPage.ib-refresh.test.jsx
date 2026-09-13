// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import InventoryPage from './InventoryPage';
import { IntelligenceBarPageDataProvider, useIntelligenceBarActions } from '../../hooks/useIntelligenceBarPageData';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));
const productId = '10000000-0000-4000-8000-000000000001';
const requestId = '20000000-0000-4000-8000-000000000001';
const reply = data => ({ ok: true, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const product = quantity => ({ id: productId, name: 'Synthetic stock product', inventoryOnHand: quantity, inventoryUnit: 'lb', vendorPricing: [] });
function RefreshButton() {
  const { notifyMutation } = useIntelligenceBarActions();
  const navigate = useNavigate();
  return <><button onClick={() => notifyMutation({ id: crypto.randomUUID(), product_id: productId, domain: 'inventory' })}>Receive verified result</button>
    <button onClick={() => navigate(-1)}>Browser Back</button></>;
}
function Host({ role = 'admin' }) {
  return <IntelligenceBarPageDataProvider><RefreshButton /><Outlet context={{ user: { role } }} /></IntelligenceBarPageDataProvider>;
}
function LocationState() {
  const location = useLocation();
  return <output data-testid="location">{location.search}{location.hash}</output>;
}
function mount(query, { role = 'admin', hash = '' } = {}) {
  render(<MemoryRouter initialEntries={[`/admin/inventory?${query}${hash}`]}><LocationState /><Routes>
    <Route element={<Host role={role} />}><Route path="/admin/inventory" element={<InventoryPage />} /></Route>
  </Routes></MemoryRouter>);
}
beforeEach(() => { vi.stubGlobal('localStorage', { getItem: () => 'synthetic-test' }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('a verified inventory result refreshes the queue and an older response cannot restore stale stock', async () => {
  const old = deferred(); let queueCalls = 0;
  vi.stubGlobal('fetch', vi.fn(url => {
    if (url.includes('/restock-requests?')) {
      queueCalls += 1;
      return queueCalls === 1 ? old.promise : Promise.resolve(reply({ requests: [{ id: requestId, productId, productName: 'Synthetic stock product',
        status: 'received', priority: 'normal', requestedQuantity: 2, unit: 'lb', liveStock: 12, inventoryUnit: 'lb' }] }));
    }
    return Promise.resolve(reply({}));
  }));
  mount(`tab=restock&requestId=${requestId}`);
  await waitFor(() => expect(queueCalls).toBe(1));
  fireEvent.click(screen.getByText('Receive verified result'));
  await screen.findByText(/live stock 12 lb/);
  await act(async () => old.resolve(reply({ requests: [{ id: requestId, productName: 'Stale stock row', status: 'open' }] })));
  expect(screen.queryByText('Stale stock row')).toBeNull();
  fireEvent.click(screen.getByText('Show all requests'));
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith('/restock-requests?status=active'))).toBe(true));
});

test('product and movement refresh preserve the product filter and ignore an earlier movement response', async () => {
  const oldMovements = deferred(); let stock = 10, movementCalls = 0;
  vi.stubGlobal('fetch', vi.fn(url => {
    if (url.includes('/movements')) {
      movementCalls += 1;
      return movementCalls === 1 ? oldMovements.promise : Promise.resolve(reply({ movements: [{ id: 'fresh', movementType: 'correction',
        quantity: 5, stockBefore: 10, stockAfter: 15, unit: 'lb', reason: 'Verified physical count' }] }));
    }
    if (url.includes('/inventory?')) return Promise.resolve(reply({ products: [product(stock)], total: 1 }));
    return Promise.resolve(reply({}));
  }));
  mount(`tab=products&search=Synthetic&productId=${productId}`);
  await screen.findByText('Movement History');
  await waitFor(() => expect(movementCalls).toBe(1));
  stock = 15;
  fireEvent.click(screen.getByText('Receive verified result'));
  await screen.findAllByText('15 lb');
  await waitFor(() => expect(movementCalls).toBeGreaterThan(1));
  await act(async () => oldMovements.resolve(reply({ movements: [{ id: 'stale', movementType: 'stale movement', quantity: 1, unit: 'lb' }] })));
  expect(screen.queryByText('stale movement')).toBeNull();
  const productCalls = fetch.mock.calls.filter(([url]) => url.includes('/inventory?'));
  expect(productCalls.length).toBeGreaterThan(1);
  expect(productCalls.every(([url]) => url.includes('search=Synthetic'))).toBe(true);
});

test.each([false, true])('browser Back restores a closed pinned request after Show all requests (rapid=%s)', async rapid => {
  const row = { id: requestId, productId, productName: 'Synthetic closed request', status: 'received', priority: 'normal', requestedQuantity: 2, unit: 'lb' };
  vi.stubGlobal('fetch', vi.fn(url => Promise.resolve(reply(url.includes('/restock-requests?')
    ? { requests: new URL(url, 'http://localhost').searchParams.get('status') === 'all' ? [row] : [] }
    : {}))));
  mount(`tab=restock&requestId=${requestId}`);
  await screen.findByText('Synthetic closed request');
  if (rapid) {
    await act(async () => {
      fireEvent.click(screen.getByText('Show all requests'));
      fireEvent.click(screen.getByText('Browser Back'));
    });
  } else {
    fireEvent.click(screen.getByText('Show all requests'));
    await waitFor(() => expect(screen.queryByText('Synthetic closed request')).toBeNull());
    fireEvent.click(screen.getByText('Browser Back'));
  }
  await screen.findByText('Synthetic closed request');
  expect(fetch.mock.calls.filter(([url]) => url.includes('/restock-requests?')).at(-1)[0])
    .toContain(`status=all&requestId=${requestId}`);
});

test('inventory group and leaf changes are URL-backed and preserve unrelated URL state', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(reply({}))));
  mount('source=audit', { hash: '#evidence' });
  await screen.findByText('Products');

  fireEvent.click(screen.getByRole('button', { name: 'Vendors & Pricing' }));
  expect(screen.getByTestId('location')).toHaveTextContent('?source=audit&tab=price-sync#evidence');
  fireEvent.click(screen.getByRole('button', { name: 'Vendors', exact: true }));
  expect(screen.getByTestId('location')).toHaveTextContent('?source=audit&tab=vendors#evidence');
  fireEvent.click(screen.getByText('Browser Back'));
  await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('?source=audit&tab=price-sync#evidence'));
});

test('inventory rejects owner-only and unknown deep links for technicians', async () => {
  vi.stubGlobal('fetch', vi.fn(url => Promise.resolve(reply(
    url.includes('/inventory?') ? { products: [], categories: [], total: 0 } : {},
  ))));
  mount('tab=vendors&source=audit', { role: 'tech' });
  await screen.findByText('No products found');
  expect(screen.queryByRole('button', { name: 'Vendors & Pricing' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Planning' }));
  expect(screen.getByTestId('location')).toHaveTextContent('?tab=forecast&source=audit');
});

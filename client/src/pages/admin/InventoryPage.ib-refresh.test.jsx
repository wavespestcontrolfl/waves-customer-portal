// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
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
function Host() {
  return <IntelligenceBarPageDataProvider><RefreshButton /><Outlet context={{ user: { role: 'admin' } }} /></IntelligenceBarPageDataProvider>;
}
function mount(query) {
  render(<MemoryRouter initialEntries={[`/admin/inventory?${query}`]}><Routes>
    <Route element={<Host />}><Route path="/admin/inventory" element={<InventoryPage />} /></Route>
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

test('browser Back restores a closed pinned request after Show all requests', async () => {
  const row = { id: requestId, productId, productName: 'Synthetic closed request', status: 'received', priority: 'normal', requestedQuantity: 2, unit: 'lb' };
  vi.stubGlobal('fetch', vi.fn(url => Promise.resolve(reply(url.includes('/restock-requests?')
    ? { requests: new URL(url, 'http://localhost').searchParams.get('status') === 'all' ? [row] : [] }
    : {}))));
  mount(`tab=restock&requestId=${requestId}`);
  await screen.findByText('Synthetic closed request');
  fireEvent.click(screen.getByText('Show all requests'));
  await waitFor(() => expect(screen.queryByText('Synthetic closed request')).toBeNull());
  fireEvent.click(screen.getByText('Browser Back'));
  await screen.findByText('Synthetic closed request');
  expect(fetch.mock.calls.filter(([url]) => url.includes('/restock-requests?')).at(-1)[0])
    .toContain(`status=all&requestId=${requestId}`);
});

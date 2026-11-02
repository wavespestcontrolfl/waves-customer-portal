// @vitest-environment jsdom
// Inventory metrics audit (2026-11-01): a failed stats refresh must not leave the
// old header counts on screen as current; a count the server could not read shows
// as unknown, not 0; and the pending-approvals list pages past its first 100.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import InventoryPage from './InventoryPage';
import { IntelligenceBarPageDataProvider, useIntelligenceBarActions } from '../../hooks/useIntelligenceBarPageData';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));

const reply = (data) => ({ ok: true, json: async () => data });
const refused = (status) => ({ ok: false, status, json: async () => ({}) });
const STATS = {
  products: { total: 17, priced: 11, needsPrice: 6, lowStock: 2 },
  vendors: { total: 3 },
  approvals: { pending: 1 },
  scrapeJobs: { completed: 0 },
  restockRequests: { open: 2 },
};

function RefreshButton() {
  const { notifyMutation } = useIntelligenceBarActions();
  return <button onClick={() => notifyMutation({ id: crypto.randomUUID(), domain: 'inventory' })}>Refresh inventory</button>;
}
function Host() {
  return <IntelligenceBarPageDataProvider><RefreshButton /><Outlet context={{ user: { role: 'admin' } }} /></IntelligenceBarPageDataProvider>;
}
function mount(query) {
  render(<MemoryRouter initialEntries={[`/admin/inventory?${query}`]}><Routes>
    <Route element={<Host />}><Route path="/admin/inventory" element={<InventoryPage />} /></Route>
  </Routes></MemoryRouter>);
}
function stubFetch(route) {
  vi.stubGlobal('fetch', vi.fn((url, options) => Promise.resolve(route(String(url), options) || reply({}))));
}
const productsList = (path) => (path.includes('/inventory?') ? reply({ products: [], categories: [], total: 0 }) : null);

beforeEach(() => { vi.stubGlobal('localStorage', { getItem: () => 'synthetic-test' }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('a failed stats refresh drops the old counts and says the stats failed', async () => {
  let statsCalls = 0;
  stubFetch((path) => {
    if (path.includes('/inventory/stats')) {
      statsCalls += 1;
      return statsCalls === 1 ? reply(STATS) : refused(503);
    }
    return productsList(path);
  });
  mount('tab=products');
  await screen.findByRole('button', { name: /17 Products/ });

  fireEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }));
  await waitFor(() => expect(statsCalls).toBe(2));
  expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load inventory stats: HTTP 503');
  expect(screen.queryByRole('button', { name: /17 Products/ })).not.toBeInTheDocument();

  statsCalls = 0;
  stubFetch((path) => (path.includes('/inventory/stats') ? reply(STATS) : productsList(path)));
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('button', { name: /17 Products/ });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a count the server could not read shows as unknown, never 0', async () => {
  stubFetch((path) => (path.includes('/inventory/stats')
    ? reply({ ...STATS, approvals: null, restockRequests: { open: null } })
    : productsList(path)));
  mount('tab=products');
  expect(await screen.findByRole('button', { name: /— Pending Approvals/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /— Restock/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^0 Pending Approvals/ })).not.toBeInTheDocument();
});

test('pending approvals page past the first 100, and a selection covers only the page on screen', async () => {
  const row = (n) => ({ id: `a${n}`, product_name: `Synthetic product ${n}`, vendor_name: 'Synthetic Vendor', category: 'test', new_price: '10.00' });
  stubFetch((path) => {
    if (path.includes('/inventory/approvals?')) {
      const page = Number(new URL(path, 'http://x').searchParams.get('page'));
      const start = (page - 1) * 100;
      return reply({ approvals: Array.from({ length: Math.min(100, 250 - start) }, (_, i) => row(start + i + 1)), total: 250, page });
    }
    return productsList(path);
  });
  mount('tab=approvals');
  expect(await screen.findByText('Synthetic product 1')).toBeInTheDocument();
  expect(screen.getByText(/Showing 1–\s*100 of 250\s*pending/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Synthetic product 1 from Synthetic Vendor' }));
  expect(screen.getByText('1 selected')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
  expect(await screen.findByText('Synthetic product 101')).toBeInTheDocument();
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/inventory/approvals?status=pending&limit=100&page=2'))).toBe(true);
  expect(screen.queryByText('1 selected')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
  expect(await screen.findByText('Synthetic product 250')).toBeInTheDocument();
  expect(screen.getByText(/Showing 201–\s*250 of 250\s*pending/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
});

test('an older approvals reply never overwrites a newer page, and old rows hide while a page loads', async () => {
  const row = (n) => ({ id: `a${n}`, product_name: `Synthetic product ${n}`, vendor_name: 'Synthetic Vendor', category: 'test', new_price: '10.00' });
  const pageOf = (page) => reply({ approvals: Array.from({ length: 100 }, (_, i) => row((page - 1) * 100 + i + 1)), total: 250, page });
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
  let held = null;
  stubFetch((path, options) => {
    if (path.includes('/approvals/a1/approve') && options?.method === 'POST') return reply({ success: true });
    if (path.includes('/inventory/approvals?')) {
      const page = Number(new URL(path, 'http://x').searchParams.get('page'));
      if (held) { const gate = held.shift(); if (gate) return gate.promise.then(() => pageOf(page)); }
      return pageOf(page);
    }
    return productsList(path);
  });
  mount('tab=approvals');
  expect(await screen.findByText('Synthetic product 1')).toBeInTheDocument();

  const staleReload = deferred();
  const nextPage = deferred();
  held = [staleReload, nextPage];
  fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).includes('page=1')).length).toBe(2));
  fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
  expect(await screen.findByText('Loading approvals...')).toBeInTheDocument();
  expect(screen.queryByText('Synthetic product 1')).not.toBeInTheDocument();

  nextPage.resolve();
  expect(await screen.findByText('Synthetic product 101')).toBeInTheDocument();
  staleReload.resolve();
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.getByText('Synthetic product 101')).toBeInTheDocument();
  expect(screen.queryByText('Synthetic product 2')).not.toBeInTheDocument();
});

test('a decision that finishes after a page change refreshes the page on screen and keeps its selection off it', async () => {
  const row = (n) => ({ id: `a${n}`, product_name: `Synthetic product ${n}`, vendor_name: 'Synthetic Vendor', category: 'test', new_price: '10.00' });
  const pageOf = (page) => reply({ approvals: Array.from({ length: 100 }, (_, i) => row((page - 1) * 100 + i + 1)), total: 250, page });
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
  const approve = deferred();
  const bulk = deferred();
  stubFetch((path, options) => {
    if (path.includes('/approvals/a1/approve') && options?.method === 'POST') return approve.promise.then(() => reply({ success: true }));
    if (path.includes('/approvals/bulk') && options?.method === 'POST') return bulk.promise.then(() => reply({ processed: 0, failed: ['a2'], skipped: [] }));
    if (path.includes('/inventory/approvals?')) return pageOf(Number(new URL(path, 'http://x').searchParams.get('page')));
    return productsList(path);
  });
  const approvalPages = () => fetch.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/inventory/approvals?'));
  mount('tab=approvals');
  expect(await screen.findByText('Synthetic product 1')).toBeInTheDocument();

  // Approve on page 1, move to page 2, then the POST finishes: the refresh reads page 2.
  fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
  expect(await screen.findByText('Synthetic product 101')).toBeInTheDocument();
  const before = approvalPages().length;
  approve.resolve();
  await waitFor(() => expect(approvalPages().length).toBe(before + 1));
  expect(approvalPages().at(-1)).toContain('page=2');
  expect(await screen.findByText('Synthetic product 101')).toBeInTheDocument();

  // Bulk on page 2, move to page 3, then the POST fails one id: no page-2 id is selected on page 3.
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Synthetic product 102 from Synthetic Vendor' }));
  fireEvent.click(screen.getByRole('button', { name: 'Approve All' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
  expect(await screen.findByText('Synthetic product 250')).toBeInTheDocument();
  bulk.resolve();
  await waitFor(() => expect(approvalPages().at(-1)).toContain('page=3'));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
  expect(screen.getByText('Synthetic product 250')).toBeInTheDocument();
});

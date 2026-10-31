// @vitest-environment jsdom
// Operations audit OP-10: Vendors, Protocols and Scraping left "Loading..."
// up forever after a failed read. A failure now shows the error and a Retry
// that re-issues the read.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import InventoryPage from './InventoryPage';
import { IntelligenceBarPageDataProvider } from '../../hooks/useIntelligenceBarPageData';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));

const reply = (data) => ({ ok: true, json: async () => data });
const VENDOR = { id: 'v1', name: 'Synthetic Vendor', active: true, scrapingEnabled: true };
let failing;

function installFetch() {
  vi.stubGlobal('fetch', vi.fn((url) => {
    const path = String(url);
    if (failing.some((part) => path.includes(part))) return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
    if (path.includes('/inventory/vendors')) return Promise.resolve(reply({ vendors: [VENDOR] }));
    if (path.includes('/inventory/scrape-jobs')) return Promise.resolve(reply({ jobs: [] }));
    if (path.includes('/inventory/service-usage')) return Promise.resolve(reply({ services: [] }));
    if (path.includes('/inventory?')) return Promise.resolve(reply({ products: [], categories: [], total: 0 }));
    return Promise.resolve(reply({}));
  }));
}

function Host() {
  return <IntelligenceBarPageDataProvider><Outlet context={{ user: { role: 'admin' } }} /></IntelligenceBarPageDataProvider>;
}
function mount(query) {
  render(<MemoryRouter initialEntries={[`/admin/inventory?${query}`]}><Routes>
    <Route element={<Host />}><Route path="/admin/inventory" element={<InventoryPage />} /></Route>
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

it.each([
  ['tab=vendors', '/inventory/vendors', 'vendors', 'Loading vendors...'],
  ['tab=protocols', '/inventory/service-usage', 'protocols', 'Loading protocols...'],
  ['tab=scrape', '/inventory/scrape-jobs', 'scrape data', 'Loading scrape data...'],
])('%s: a failed read shows the error and Retry, not an endless spinner', async (query, endpoint, what, spinner) => {
  failing = [endpoint];
  mount(query);
  expect(await screen.findByRole('alert')).toHaveTextContent(`Failed to load ${what}: HTTP 503`);
  expect(screen.queryByText(spinner)).not.toBeInTheDocument();

  failing = [];
  const before = fetch.mock.calls.filter(([url]) => String(url).includes(endpoint)).length;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(fetch.mock.calls.filter(([url]) => String(url).includes(endpoint)).length).toBe(before + 1);
  await waitFor(() => expect(screen.queryByText(spinner)).not.toBeInTheDocument());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('a failed protocols read does not open the deep-linked add form over an empty list', async () => {
  failing = ['/inventory/service-usage'];
  mount('tab=protocols&serviceLine=pest&add=1');
  expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load protocols: HTTP 503');
  expect(screen.queryByText(/Add a COGS product/)).not.toBeInTheDocument();
});

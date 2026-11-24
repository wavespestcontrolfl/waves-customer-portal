// @vitest-environment jsdom
// Limits tab (owner 2026-11-24 "yes"): suggested reorder limits from
// GET /admin/inventory/reorder-suggestions; Use saves the suggested
// threshold + reorder amount through PUT /admin/inventory/:id and nothing else.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import InventoryPage from './InventoryPage';
import { IntelligenceBarPageDataProvider } from '../../hooks/useIntelligenceBarPageData';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));

const productId = '10000000-0000-4000-8000-000000000001';
const reply = (data) => ({ ok: true, json: async () => data });
const ROW = {
  productId,
  name: 'Synthetic jug product',
  unit: 'gal',
  onHand: 0.5,
  currentThreshold: 1.5,
  currentReorder: 2,
  suggestedThreshold: 0.75,
  suggestedReorder: 3,
  packs: 3,
  packSize: 1,
  dailyUse: 0.1,
  basis: '4-week use',
  vendor: 'Synthetic Vendor',
  autoReorder: true,
  status: 'ok',
  note: null,
  usageRecords: 12,
};
const IDLE = { ...ROW, productId: 'idle-1', name: 'Synthetic unused product', status: 'no_usage', suggestedThreshold: null, suggestedReorder: null, usageRecords: 0 };
const HOLD = { ...ROW, productId: 'hold-1', name: 'Synthetic 24-0-11', status: 'blackout_hold', suggestedThreshold: null, suggestedReorder: null };

let fetchMock;
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => 'synthetic-test' });
  fetchMock = vi.fn((url, init = {}) => {
    const path = String(url);
    if (path.includes('/reorder-suggestions')) {
      return Promise.resolve(reply({ today: '2026-11-24', options: { leadDays: 3, bufferDays: 7, reorderDays: 21 }, forecastError: null, products: [ROW, IDLE, HOLD] }));
    }
    if (init.method === 'PUT') return Promise.resolve(reply({ product: { id: productId } }));
    return Promise.resolve(reply({}));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Host() {
  return <IntelligenceBarPageDataProvider><Outlet context={{ user: { role: 'admin' } }} /></IntelligenceBarPageDataProvider>;
}
function mount() {
  render(<MemoryRouter initialEntries={['/admin/inventory?tab=limits']}><Routes>
    <Route element={<Host />}><Route path="/admin/inventory" element={<InventoryPage />} /></Route>
  </Routes></MemoryRouter>);
}

describe('Limits tab', () => {
  it('lists products with use and hides idle ones until Show all', async () => {
    mount();
    await screen.findByText('Synthetic jug product');
    expect(screen.queryByText('Synthetic unused product')).not.toBeInTheDocument();
    expect(screen.getByText('Blackout hold')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Show all/));
    expect(screen.getByText('Synthetic unused product')).toBeInTheDocument();
  });

  it('Use saves only the suggested threshold and reorder amount, then reads Saved', async () => {
    mount();
    await screen.findByText('Synthetic jug product');
    const buttons = screen.getAllByRole('button', { name: 'Use' });
    expect(buttons).toHaveLength(1); // the blackout hold row has no Use
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const [url, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'PUT');
    expect(String(url)).toContain(`/admin/inventory/${productId}`);
    expect(JSON.parse(init.body)).toEqual({ lowStockThreshold: 0.75, reorderQuantity: 3 });
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeDisabled();
  });
});

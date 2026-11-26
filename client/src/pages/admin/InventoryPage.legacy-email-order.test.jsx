// @vitest-environment jsdom
// Legacy rows from the removed email path; prod had 0 on 2026-11-26. A Restock request whose order was
// emailed to SiteOne (sent, or sending with the outcome unknown) shows a read-only line with its PO, so
// staff do not order it by hand again, and it prefills Receive with the emailed quantity.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import InventoryPage from './InventoryPage';
import { IntelligenceBarPageDataProvider } from '../../hooks/useIntelligenceBarPageData';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));

const requestId = '20000000-0000-4000-8000-000000000002';
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const OPEN_REQUEST = {
  id: requestId,
  productId: '10000000-0000-4000-8000-000000000002',
  productName: 'Synthetic granular fertilizer',
  status: 'open',
  priority: 'normal',
  requestedQuantity: 301,
  unit: 'lb',
  inventoryUnit: 'lb',
  order: null,
};

function installFetch(request) {
  vi.stubGlobal('fetch', vi.fn((url) => {
    const path = String(url);
    if (path.includes('/restock-requests?')) return Promise.resolve(reply({ requests: [request] }));
    if (path.includes('/inventory/stats')) return Promise.resolve(reply({ restockRequests: { open: 1 } }));
    return Promise.resolve(reply({}));
  }));
}
function Host() {
  return <IntelligenceBarPageDataProvider><Outlet context={{ user: { role: 'admin' } }} /></IntelligenceBarPageDataProvider>;
}
function mount() {
  render(<MemoryRouter initialEntries={[`/admin/inventory?tab=restock&requestId=${requestId}`]}><Routes>
    <Route element={<Host />}><Route path="/admin/inventory" element={<InventoryPage />} /></Route>
  </Routes></MemoryRouter>);
}

beforeEach(() => { vi.stubGlobal('localStorage', { getItem: () => 'synthetic-test' }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('legacy SiteOne order email on the Restock tab', () => {
  it('a sent email shows its PO and prefills Receive with the emailed quantity', async () => {
    installFetch({ ...OPEN_REQUEST, emailOrder: { status: 'sent', po: 'WAVES-R1', orderedQuantity: 350 } });
    mount();
    expect(await screen.findByText('Emailed to SiteOne · PO WAVES-R1')).toBeInTheDocument();
    expect(screen.getByDisplayValue('350')).toBeInTheDocument();
  });

  it('an unconfirmed (sending) email warns not to order it again', async () => {
    installFetch({ ...OPEN_REQUEST, emailOrder: { status: 'sending', po: 'WAVES-R1', orderedQuantity: 350 } });
    mount();
    expect(await screen.findByText(/Email to SiteOne may have gone out · PO WAVES-R1\. Check with SiteOne before ordering it again\./)).toBeInTheDocument();
  });

  it('a request with no email shows no such line', async () => {
    installFetch({ ...OPEN_REQUEST, emailOrder: null });
    mount();
    expect(await screen.findByText('Synthetic granular fertilizer')).toBeInTheDocument();
    expect(screen.queryByText(/SiteOne/)).not.toBeInTheDocument();
  });
});

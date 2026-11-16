// @vitest-environment jsdom
// "Record vendor cancellation" on the Restock tab: an automatic order that is
// out offers it in place of Cancel. Record stays disabled until the admin
// confirms the vendor cancelled the order; it posts the order the tab showed
// once, then closes and reloads the queue. A 409 shows its message in the
// dialog. A late order on a received request keeps the request received.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import InventoryPage from './InventoryPage';
import { IntelligenceBarPageDataProvider } from '../../hooks/useIntelligenceBarPageData';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));

const requestId = '20000000-0000-4000-8000-000000000002';
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const ORDER = {
  id: '30000000-0000-4000-8000-000000000003',
  version: '2026-11-06T15:00:00.000Z',
  status: 'placed',
  adapter: 'siteone',
  externalOrderNumber: 'SO-1001',
  placedAt: '2026-11-05T14:00:00.000Z',
  revokedAt: null,
  orderedQuantity: 4,
  landedAfterReceive: false,
};
const ORDERED_REQUEST = {
  id: requestId,
  productId: '10000000-0000-4000-8000-000000000002',
  productName: 'Synthetic liquid herbicide',
  status: 'ordered',
  priority: 'normal',
  requestedQuantity: 4,
  unit: 'gal',
  inventoryUnit: 'gal',
  order: ORDER,
};
const CONFIRM = 'SiteOne confirmed that order #SO-1001 is cancelled';

let queue;
function installFetch({ requests = [ORDERED_REQUEST], record = () => reply({ success: true, requestStatus: 'cancelled' }) } = {}) {
  queue = vi.fn((url) => {
    const path = String(url);
    if (path.includes('/vendor-cancellation')) return Promise.resolve(record());
    if (path.includes('/restock-requests?')) return Promise.resolve(reply({ requests, siteOneEmailOrder: false }));
    if (path.includes('/inventory/stats')) return Promise.resolve(reply({ restockRequests: { open: 1 } }));
    return Promise.resolve(reply({}));
  });
  vi.stubGlobal('fetch', queue);
}
const recordCalls = () => queue.mock.calls.filter(([url]) => String(url).includes('/vendor-cancellation'));
const queueLoads = () => queue.mock.calls.filter(([url]) => String(url).includes('/restock-requests?')).length;

function Host() {
  return <IntelligenceBarPageDataProvider><Outlet context={{ user: { role: 'admin' } }} /></IntelligenceBarPageDataProvider>;
}
function mount() {
  render(<MemoryRouter initialEntries={[`/admin/inventory?tab=restock&requestId=${requestId}`]}><Routes>
    <Route element={<Host />}><Route path="/admin/inventory" element={<InventoryPage />} /></Route>
  </Routes></MemoryRouter>);
}
async function openDialog() {
  fireEvent.click(await screen.findByRole('button', { name: 'Record vendor cancellation' }));
  return screen.findByRole('dialog');
}

beforeEach(() => { vi.stubGlobal('localStorage', { getItem: () => 'synthetic-test' }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Record vendor cancellation', () => {
  it('an order that is out offers it in place of Cancel', async () => {
    installFetch();
    mount();
    expect(await screen.findByRole('button', { name: 'Record vendor cancellation' })).toBeEnabled();
    expect(screen.getByText('Order out — receive it when it arrives, or record a vendor cancellation.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('Record stays disabled until the vendor cancellation is confirmed, and Keep order sends nothing', async () => {
    installFetch();
    mount();
    const dialog = await openDialog();
    expect(within(dialog).getByText(/Do this only after SiteOne confirms that order #SO-1001 is cancelled\./)).toBeInTheDocument();
    expect(within(dialog).getByText(/The request is cancelled\./)).toBeInTheDocument();
    const record = within(dialog).getByRole('button', { name: 'Record cancellation' });
    expect(record).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: CONFIRM }));
    expect(record).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep order' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(recordCalls()).toHaveLength(0);
  });

  it('Record posts the order the tab showed once, then closes, confirms and reloads the queue', async () => {
    installFetch();
    mount();
    const dialog = await openDialog();
    const loadsBefore = queueLoads();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: CONFIRM }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record cancellation' }));
    expect(await screen.findByText('Vendor cancellation recorded. The request is cancelled.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(recordCalls()).toHaveLength(1);
    const [url, options] = recordCalls()[0];
    expect(String(url)).toContain(`/admin/inventory/restock-requests/${requestId}/vendor-cancellation`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ orderId: ORDER.id, version: ORDER.version, cancelledWithVendor: true });
    await waitFor(() => expect(queueLoads()).toBeGreaterThan(loadsBefore));
  });

  it('a 409 shows its message and keeps the dialog open', async () => {
    installFetch({ record: () => reply({ error: 'This order changed after the Restock tab loaded. Reload it and check the order again.', code: 'order_changed' }, 409) });
    mount();
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: CONFIRM }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record cancellation' }));
    expect(await within(dialog).findByText('This order changed after the Restock tab loaded. Reload it and check the order again.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Record cancellation' })).toBeEnabled();
    expect(recordCalls()).toHaveLength(1);
  });

  it('a late order on a received request keeps the request received', async () => {
    installFetch({
      requests: [{ ...ORDERED_REQUEST, status: 'received', order: { ...ORDER, status: 'needs_review', landedAfterReceive: true } }],
      record: () => reply({ success: true, requestStatus: 'received' }),
    });
    mount();
    expect(await screen.findByText('Late auto-order — receive it, or record a vendor cancellation.')).toBeInTheDocument();
    const dialog = await openDialog();
    expect(within(dialog).getByText(/The request stays received\./)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: CONFIRM }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record cancellation' }));
    expect(await screen.findByText('Vendor cancellation recorded. The request stays received.')).toBeInTheDocument();
  });
});

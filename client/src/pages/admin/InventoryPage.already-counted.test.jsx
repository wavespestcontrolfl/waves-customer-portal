// @vitest-environment jsdom
// Restock tab: "Close, already counted" sits beside Receive. When Receive is refused because an
// invoice already added the stock (409 already_counted_by_receipt), a dialog shows the server's
// sentence with two choices: close without changing stock, or receive anyway (sends confirm).
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import InventoryPage from './InventoryPage';
import { IntelligenceBarPageDataProvider } from '../../hooks/useIntelligenceBarPageData';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));

const requestId = '20000000-0000-4000-8000-000000000002';
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const WARNING = 'An invoice already added 4 gal on November 24. Receive again only if this is a second delivery.';
const REQUEST = {
  id: requestId,
  productId: '10000000-0000-4000-8000-000000000002',
  productName: 'Synthetic liquid herbicide',
  status: 'ordered',
  priority: 'normal',
  requestedQuantity: 4,
  unit: 'gal',
  inventoryUnit: 'gal',
  order: null,
};

let queue;
function installFetch({ action }) {
  queue = vi.fn((url) => {
    const path = String(url);
    if (path.includes('/action')) return Promise.resolve(action(JSON.parse(queue.mock.calls.at(-1)[1].body)));
    if (path.includes('/restock-requests?')) return Promise.resolve(reply({ requests: [REQUEST] }));
    if (path.includes('/inventory/stats')) return Promise.resolve(reply({ restockRequests: { open: 1 } }));
    return Promise.resolve(reply({}));
  });
  vi.stubGlobal('fetch', queue);
}
const actionBodies = () => queue.mock.calls.filter(([url]) => String(url).includes('/action')).map(([, init]) => JSON.parse(init.body));
const refuseThenAccept = (body) => (body.action === 'receive' && !body.confirm
  ? reply({ error: WARNING, code: 'already_counted_by_receipt', alreadyAdded: { quantity: 4, unit: 'gal' } }, 409)
  : reply({ success: true, request: { id: requestId, status: 'received' } }));

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

describe('Close, already counted', () => {
  it('sits beside Receive and posts close_counted with no quantity change', async () => {
    installFetch({ action: () => reply({ success: true, request: { id: requestId, status: 'received' } }) });
    mount();
    expect(await screen.findByRole('button', { name: 'Receive' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Close, already counted' }));
    await waitFor(() => expect(actionBodies()).toHaveLength(1));
    expect(actionBodies()[0]).toMatchObject({ action: 'close_counted' });
    expect(actionBodies()[0].confirm).toBeUndefined();
  });

  it('Receive refused by an invoice shows the warning and nothing is received', async () => {
    installFetch({ action: refuseThenAccept });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Receive' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(WARNING)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close, already counted' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Receive anyway' })).toBeEnabled();
    expect(actionBodies()).toHaveLength(1);
  });

  it('"Close, already counted" in the warning closes the request without confirm', async () => {
    installFetch({ action: refuseThenAccept });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Receive' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close, already counted' }));
    await waitFor(() => expect(actionBodies()).toHaveLength(2));
    expect(actionBodies()[1]).toMatchObject({ action: 'close_counted' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('"Receive anyway" re-sends the receive with confirm', async () => {
    installFetch({ action: refuseThenAccept });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Receive' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Receive anyway' }));
    await waitFor(() => expect(actionBodies()).toHaveLength(2));
    expect(actionBodies()[1]).toMatchObject({ action: 'receive', confirm: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

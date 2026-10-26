// @vitest-environment jsdom
// "Email order to SiteOne" on the Restock tab (GATE_SITEONE_EMAIL_ORDER): the
// button shows for an admin on an open request only while the server says the
// gate is on; it opens a preview fetched lazily; Send email posts once; a 409
// shows its message; a sent email shows on the row.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import InventoryPage from './InventoryPage';
import { IntelligenceBarPageDataProvider } from '../../hooks/useIntelligenceBarPageData';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));

const requestId = '20000000-0000-4000-8000-000000000001';
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const OPEN_REQUEST = {
  id: requestId,
  productId: '10000000-0000-4000-8000-000000000001',
  productName: 'Synthetic granular fertilizer',
  status: 'open',
  priority: 'normal',
  requestedQuantity: 300,
  unit: 'lb',
  inventoryUnit: 'lb',
};
const PREVIEW = {
  version: 'v-abc123',
  requestId,
  to: 'orders@siteone.example',
  cc: null,
  subject: 'Pickup order: Waves Pest Control, account 123456, PO WAVES-20000000',
  text: 'Hello,\n\nPlease prepare this order for pickup at Lakewood Ranch #238, 5115 Lena Rd.\n\n6 x 098604 Synthetic granular fertilizer (50 lb)\n',
  po: 'WAVES-20000000',
  packages: 6,
  estimateCents: 14700,
};

let queue;
function installFetch({ enabled = true, requests = [OPEN_REQUEST], preview = () => reply({ preview: PREVIEW }), send = () => reply({ ok: true, requestMarked: true }) } = {}) {
  queue = vi.fn((url, options = {}) => {
    const path = String(url);
    if (path.includes('/siteone-email')) return Promise.resolve(options.method === 'POST' ? send() : preview());
    if (path.includes('/restock-requests?')) return Promise.resolve(reply({ requests, siteOneEmailOrder: enabled }));
    if (path.includes('/inventory/stats')) return Promise.resolve(reply({ restockRequests: { open: 1 } }));
    return Promise.resolve(reply({}));
  });
  vi.stubGlobal('fetch', queue);
}
const siteOneCalls = (method) => queue.mock.calls.filter(([url, o]) => String(url).includes('/siteone-email') && (o?.method || 'GET') === method);

function Host({ role }) {
  return <IntelligenceBarPageDataProvider><Outlet context={{ user: { role } }} /></IntelligenceBarPageDataProvider>;
}
function mount(role = 'admin') {
  render(<MemoryRouter initialEntries={[`/admin/inventory?tab=restock&requestId=${requestId}`]}><Routes>
    <Route element={<Host role={role} />}><Route path="/admin/inventory" element={<InventoryPage />} /></Route>
  </Routes></MemoryRouter>);
}

beforeEach(() => { vi.stubGlobal('localStorage', { getItem: () => 'synthetic-test' }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Email order to SiteOne', () => {
  it('shows no button while the gate is off', async () => {
    installFetch({ enabled: false });
    mount();
    await screen.findByText('Synthetic granular fertilizer');
    expect(screen.queryByRole('button', { name: 'Email order to SiteOne' })).not.toBeInTheDocument();
  });

  it('shows no button to a technician, even if the server said the gate is on', async () => {
    installFetch({ enabled: true });
    mount('technician');
    await screen.findByText('Synthetic granular fertilizer');
    expect(screen.queryByRole('button', { name: 'Email order to SiteOne' })).not.toBeInTheDocument();
  });

  it('shows no button on a request that is not open', async () => {
    installFetch({ requests: [{ ...OPEN_REQUEST, status: 'ordered' }] });
    mount();
    await screen.findByText('Synthetic granular fertilizer');
    expect(screen.queryByRole('button', { name: 'Email order to SiteOne' })).not.toBeInTheDocument();
  });

  it('fetches the preview only when the button is clicked, then shows To, Subject, body and the estimate', async () => {
    installFetch();
    mount();
    const button = await screen.findByRole('button', { name: 'Email order to SiteOne' });
    expect(siteOneCalls('GET')).toHaveLength(0);
    fireEvent.click(button);
    expect(await screen.findByText(PREVIEW.to)).toBeInTheDocument();
    expect(screen.getByText(PREVIEW.subject)).toBeInTheDocument();
    expect(screen.getByText(/6 x 098604 Synthetic granular fertilizer \(50 lb\)/)).toBeInTheDocument();
    expect(screen.getByText(/Estimate before tax:\s*\$147\.00/)).toBeInTheDocument();
    expect(siteOneCalls('GET')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Send email' })).toBeEnabled();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('Cancel closes the dialog and sends nothing', async () => {
    installFetch();
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Email order to SiteOne' }));
    await screen.findByText(PREVIEW.to);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(siteOneCalls('POST')).toHaveLength(0);
  });

  it('Send email posts once and reloads the queue', async () => {
    installFetch();
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Email order to SiteOne' }));
    await screen.findByText(PREVIEW.to);
    const loadsBefore = queue.mock.calls.filter(([url]) => String(url).includes('/restock-requests?')).length;
    fireEvent.click(screen.getByRole('button', { name: 'Send email' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(siteOneCalls('POST')).toHaveLength(1);
    // Send carries the version of the preview the admin saw.
    expect(JSON.parse(siteOneCalls('POST')[0][1].body)).toEqual({ version: 'v-abc123' });
    expect(queue.mock.calls.filter(([url]) => String(url).includes('/restock-requests?')).length).toBeGreaterThan(loadsBefore);
  });

  it('a 409 on the preview shows its message and offers no send', async () => {
    installFetch({ preview: () => reply({ error: 'SITEONE_ORDER_EMAIL is not set, so there is nowhere to send the order.', code: 'no_recipient' }, 409) });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Email order to SiteOne' }));
    expect(await screen.findByText(/SITEONE_ORDER_EMAIL is not set/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send email' })).toBeDisabled();
  });

  it('a 409 on send shows its message and keeps the dialog open', async () => {
    installFetch({ send: () => reply({ error: 'SendGrid did not confirm the email, so it may have gone out. Do not send again until you check SendGrid or ask SiteOne.', code: 'send_unconfirmed' }, 502) });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Email order to SiteOne' }));
    await screen.findByText(PREVIEW.to);
    fireEvent.click(screen.getByRole('button', { name: 'Send email' }));
    expect(await screen.findByText(/Do not send again/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(siteOneCalls('POST')).toHaveLength(1);
  });

  it('a sent email shows on the row with its date and PO and removes the button', async () => {
    installFetch({
      requests: [{ ...OPEN_REQUEST, status: 'ordered', emailOrder: { status: 'sent', po: 'WAVES-20000000', sentAt: '2026-10-27T15:00:00Z', packages: 6 } }],
    });
    mount();
    expect(await screen.findByText(/Emailed to SiteOne\s+2026-10-27 · PO\s+WAVES-20000000/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Email order to SiteOne' })).not.toBeInTheDocument();
  });

  it('Receive defaults to what the emailed packages hold, not the requested amount', async () => {
    installFetch({
      requests: [{ ...OPEN_REQUEST, status: 'ordered', requestedQuantity: 301, emailOrder: { status: 'sent', po: 'WAVES-20000000', sentAt: '2026-10-27T15:00:00Z', packages: 7, orderedQuantity: 350 } }],
    });
    mount();
    await screen.findByText(/Emailed to SiteOne/);
    expect(screen.getByPlaceholderText('Qty')).toHaveValue('350');
  });

  it('an unconfirmed email warns before anyone sends again', async () => {
    installFetch({ requests: [{ ...OPEN_REQUEST, emailOrder: { status: 'sending', po: 'WAVES-20000000', sentAt: null } }] });
    mount();
    expect(await screen.findByText(/Email to SiteOne may have gone out/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Email order to SiteOne' })).not.toBeInTheDocument();
  });

  it('a stale claim that never started offers the button again (Codex #6866 r1 P2)', async () => {
    installFetch({ requests: [{ ...OPEN_REQUEST, emailOrder: { status: 'sending', po: 'WAVES-20000000', sentAt: null, retryable: true } }] });
    mount();
    expect(await screen.findByText(/An earlier email to SiteOne never started/)).toBeInTheDocument();
    expect(screen.queryByText(/may have gone out/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Email order to SiteOne' })).toBeInTheDocument();
  });
});

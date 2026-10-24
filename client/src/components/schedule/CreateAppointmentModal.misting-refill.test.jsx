// @vitest-environment jsdom
/**
 * Misting refill on the Create Appointment modal (misting PR 2c, GATE_MOSQUITO_MISTING).
 * The refill's price is the server's (the accepted misting estimate's solution at the live table price), so a group with a refill line
 * is previewed like a discounted group: the preview names the solution and per-application price, an unpriceable refill shows the
 * server's reason and blocks Save, and a booking with no refill sends no preview at all (unchanged).
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDiscountStackingState } from '../../hooks/useDiscountStacking';
vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: false, known: true })),
}));
import CreateAppointmentModal from './CreateAppointmentModal.jsx';

afterEach(() => {
  cleanup();
  vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: false, known: true, retry: vi.fn() });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: vi.fn(async () => body) });
const CUSTOMER = { id: 'customer-a', firstName: 'Ada', lastName: 'Lovelace' };
const CATALOG = [
  { id: 'svc-plan', service_key: 'mosquito_misting_service', name: 'Mosquito Misting Service Plan', billing_type: 'one_time', base_price: 59, default_duration_minutes: 30 },
  { id: 'svc-refill', service_key: 'mosquito_misting_refill', name: 'Mosquito Misting System Refill', billing_type: 'one_time', base_price: 129, default_duration_minutes: 20 },
  { id: 'svc-pest', service_key: 'pest_control', name: 'Pest Control Visit', billing_type: 'one_time', base_price: 50, default_duration_minutes: 30 },
];
const REFILL_INFO = { solution: 'natural', solutionLabel: 'Natural (botanical)', unitPrice: 219, estimateId: 'est-1' };

function futureDate(days = 30) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

function installFetch({ previewRow }) {
  const fetcher = vi.fn((input, options = {}) => {
    const url = String(input);
    if (url.includes('/admin/triage?')) return Promise.resolve(json({ items: [] }));
    if (url.includes('/admin/services?')) {
      const q = (new URL(url, 'http://test').searchParams.get('search') || '').toLowerCase();
      return Promise.resolve(json({ services: CATALOG.filter((c) => c.name.toLowerCase().includes(q)) }));
    }
    if (url.endsWith('/admin/schedule') && options.method === 'POST') return Promise.resolve(json({ id: 'appt-1' }));
    if (url.includes('/properties?context=appointment_address')) return Promise.resolve(json({ properties: [], canChangeAppointmentAddress: false }));
    if (url.includes('/schedule-estimates')) return Promise.resolve(json({ estimates: [] }));
    if (url.endsWith('/admin/technicians')) return Promise.resolve(json({ technicians: [] }));
    if (url.endsWith('/admin/discounts')) return Promise.resolve(json([]));
    if (url.endsWith('/annual-prepay-availability')) return Promise.resolve(json({ enabled: false }));
    if (url.endsWith('/card-request-availability')) return Promise.resolve(json({ enabled: false }));
    if (url.endsWith('/admin/dispatch/slot-check')) return Promise.resolve(json({ ok: true, results: [{ conflicts: [] }] }));
    if (url.includes('/admin/schedule/find-time')) return Promise.resolve(json({ gated: true }));
    if (url.endsWith('/admin/schedule/preview') && options.method === 'POST') {
      const groups = JSON.parse(options.body || '{}').groups || [];
      return Promise.resolve(json({ regime: false, results: groups.map((g) => previewRow(g)) }));
    }
    throw new Error(`Unhandled fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

async function addService(query, name) {
  if (!screen.queryByPlaceholderText('Search services')) fireEvent.click(screen.getByRole('button', { name: /\+ Add service/i }));
  const box = screen.queryByPlaceholderText('Search services') || screen.getByPlaceholderText('Search to add service');
  fireEvent.change(box, { target: { value: query } });
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(name, 'i') }));
}

async function mount() {
  render(<CreateAppointmentModal
    defaultCustomer={CUSTOMER}
    defaultDate={futureDate()}
    defaultWindowStart="09:00"
    onClose={vi.fn()}
    onCreated={vi.fn()}
    onChange={vi.fn()}
  />);
}

const previews = (fetcher) => fetcher.mock.calls
  .filter(([u, o]) => String(u).endsWith('/admin/schedule/preview') && o?.method === 'POST')
  .map(([, o]) => JSON.parse(o.body).groups);
const schedulePosts = (fetcher) => fetcher.mock.calls.filter(([u, o]) => String(u).endsWith('/admin/schedule') && o?.method === 'POST').map(([, o]) => JSON.parse(o.body));

describe('a booking with a misting refill', () => {
  it('is previewed, and staff see the solution and per-application price before they book', async () => {
    const fetcher = installFetch({ previewRow: (g) => ({ key: g.key, price: 278, stackGroupConflict: null, addonLines: [{ price: 219, discount: null }], mistingRefills: [REFILL_INFO] }) });
    await mount();
    await addService('Misting Service', 'Misting Service Plan');
    await addService('Misting System Refill', 'Misting System Refill');
    expect(await screen.findByText('Refill, Natural (botanical): $219.00 per application')).toBeTruthy();
    const group = previews(fetcher).at(-1)[0];
    expect(group.serviceId).toBe('svc-plan');
    expect(group.serviceAddons.map((a) => a.serviceId)).toEqual(['svc-refill']);
    // the displayed total is the server's price, not the catalog placeholder
    expect(screen.getByText('Total: $278.00')).toBeTruthy();
  });

  it('shows the server\'s reason as it is and blocks Save when the refill cannot be priced', async () => {
    const reason = 'This misting refill cannot be priced: no accepted misting estimate was found for this customer and property. Accept the misting estimate first, then add the refill.';
    installFetch({ previewRow: (g) => ({ key: g.key, error: reason, code: 'MISTING_REFILL_UNPRICED' }) });
    await mount();
    await addService('Misting Service', 'Misting Service Plan');
    await addService('Misting System Refill', 'Misting System Refill');
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(screen.queryByText(/Couldn't confirm today's price/)).toBeNull();
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    expect(submit.disabled).toBe(true);
  });

  it('a booking with no refill sends no preview at all, as before', async () => {
    const fetcher = installFetch({ previewRow: (g) => ({ key: g.key }) });
    await mount();
    await addService('Pest Control', 'Pest Control Visit');
    await screen.findByRole('button', { name: 'Schedule appointment' });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(previews(fetcher)).toHaveLength(0);
    expect(screen.queryByText(/Refill,/)).toBeNull();
  });

  it('binds the create POST to the previewed price (expected_price)', async () => {
    const fetcher = installFetch({ previewRow: (g) => ({ key: g.key, price: 278, stackGroupConflict: null, addonLines: [{ price: 219, discount: null }], mistingRefills: [REFILL_INFO] }) });
    await mount();
    await addService('Misting Service', 'Misting Service Plan');
    await addService('Misting System Refill', 'Misting System Refill');
    await screen.findByText('Refill, Natural (botanical): $219.00 per application');
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(schedulePosts(fetcher)[0]).toMatchObject({ expected_price: 278 });
  });
});

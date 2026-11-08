// @vitest-environment jsdom
// Equipment card: a failed read shows its error and Retry, never a blank card.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import EquipmentMaintenancePage from './EquipmentMaintenancePage';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));

const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const eq = { id: 'vehicle-1', name: 'Synthetic service truck', category: 'vehicle', status: 'active', condition_rating: 7, current_miles: 1200 };
const detailBody = { equipment: eq, schedules: [], recentRecords: [] };
const mileageBody = {
  logs: [{ id: 'log-1', log_date: '2026-11-01', miles: 12, purpose: 'business' }],
  summary: { total_miles: 4321, business_miles: 4000, total_fuel_cost: 10, total_irs_deduction: 20 },
};

// handlers: { detail: [() => response, ...], mileage: [...] }; the last entry repeats.
function stubFetch(handlers) {
  const counts = { detail: 0, mileage: 0 };
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    if (opts.method === 'POST') return response({ ok: true });
    if (path.includes('/alerts')) return response({ alerts: [] });
    if (path.includes('/analytics/overview')) return response({ total_assets: 1 });
    const kind = path.includes('/vehicle-1/mileage?') ? 'mileage' : path.endsWith('/vehicle-1') ? 'detail' : null;
    if (kind) {
      const list = handlers[kind];
      return list[Math.min(counts[kind]++, list.length - 1)]();
    }
    if (path.endsWith('/equipment-maintenance')) return response({ equipment: [eq] });
    throw new Error('Unexpected synthetic equipment request: ' + path);
  }));
  return counts;
}
const reads = (kind) => fetch.mock.calls.filter(([u]) => (kind === 'mileage' ? String(u).includes('/vehicle-1/mileage?') : String(u).endsWith('/vehicle-1'))).length;

beforeEach(() => { localStorage.setItem('waves_admin_token', 'synthetic-token'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

async function expandCard() {
  render(<MemoryRouter><EquipmentMaintenancePage /></MemoryRouter>);
  const expand = await screen.findByRole('button', { name: /Synthetic service truck/ });
  fireEvent.click(expand);
  return expand;
}

it('keeps the detail and both buttons when only the mileage read fails, and Retry re-reads mileage only', async () => {
  stubFetch({
    detail: [() => response(detailBody)],
    mileage: [() => response({ error: 'Synthetic mileage outage' }, 503), () => response(mileageBody)],
  });
  await expandCard();
  expect(await screen.findByText(/Failed to load mileage: Synthetic mileage outage/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Record Maintenance' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Log Mileage' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByText(/Failed to load mileage/)).not.toBeInTheDocument());
  expect(await screen.findByText(/4,321/)).toBeInTheDocument();
  expect(reads('detail')).toBe(1);
  expect(reads('mileage')).toBe(2);
  expect(screen.getByRole('button', { name: 'Record Maintenance' })).toBeInTheDocument();
});

it('shows a loading line, then the error and Retry when the detail read fails', async () => {
  let finish;
  stubFetch({
    detail: [() => new Promise((resolve) => { finish = resolve; }), () => response(detailBody)],
    mileage: [() => response(mileageBody)],
  });
  await expandCard();
  expect(await screen.findByText(/Loading equipment details/)).toBeInTheDocument();
  await act(async () => { finish(response({ error: 'Synthetic detail outage' }, 500)); });
  expect(await screen.findByText(/Failed to load equipment details: Synthetic detail outage/)).toBeInTheDocument();
  expect(screen.queryByText(/Loading equipment details/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('button', { name: 'Record Maintenance' })).toBeInTheDocument();
  expect(screen.queryByText(/Failed to load equipment details/)).not.toBeInTheDocument();
  expect(reads('detail')).toBe(2);
});

it('shows the error and Retry, not a blank card, when the reload after a save fails', async () => {
  stubFetch({
    detail: [() => response(detailBody), () => response({ error: 'Synthetic reload outage' }, 500), () => response(detailBody)],
    mileage: [() => response(mileageBody)],
  });
  await expandCard();
  fireEvent.click(await screen.findByRole('button', { name: 'Record Maintenance' }));
  fireEvent.change(screen.getByText('Task Name *').parentElement.querySelector('input'), { target: { value: 'Oil change' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Record' }));
  expect(await screen.findByText(/Failed to load equipment details: Synthetic reload outage/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('button', { name: 'Record Maintenance' })).toBeInTheDocument();
});

it('ignores a detail reply that lands after the card collapsed', async () => {
  let finish;
  stubFetch({
    detail: [() => new Promise((resolve) => { finish = resolve; })],
    mileage: [() => response(mileageBody)],
  });
  const expand = await expandCard();
  await screen.findByText(/Loading equipment details/);
  fireEvent.click(expand);
  expect(expand).toHaveAttribute('aria-expanded', 'false');
  await act(async () => { finish(response(detailBody)); });
  expect(screen.queryByRole('button', { name: 'Record Maintenance' })).not.toBeInTheDocument();
  fireEvent.click(expand);
  expect(await screen.findByText(/Loading equipment details/)).toBeInTheDocument();
});

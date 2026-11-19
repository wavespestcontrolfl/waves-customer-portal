// @vitest-environment jsdom
//
// CompletionPanel-level coverage for Taurus SC's yearly label limit (owner
// 2026-11-19): /default-products carries the server's answer (whether another
// 0.03% application fits); when none fits the pest house mix seeds without Taurus, a manual Taurus warns (never
// blocks), and an unknown count (failed request, or no key) leaves Taurus out too and says so.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';

const FULL = { high: 0, low: 4, count: 4, eligible: false, year: 2026 };
const ROOM = { high: 0, low: 3, count: 3, eligible: true, year: 2026 };
const UNKNOWN_LINE = "Taurus left out: this year's count is unavailable. Add it only if this home is still within the label's yearly limit.";

const pestCatalog = [
  { id: 'p1', name: 'Taurus SC', category: 'Insecticide' },
  { id: 'p2', name: 'LESCO Crosscheck Plus', category: 'Insecticide' },
  { id: 'p3', name: 'LESCO 90/10 Nonionic Surfactant', category: 'Adjuvant' },
];

const pestService = () => ({
  id: 'pest-visit-1',
  customerId: 'pest-customer-1',
  customerName: 'Synthetic Pest Customer',
  serviceType: 'General Pest Control (Quarterly)',
  status: 'confirmed',
  scheduledDate: '2099-01-01',
  estimatedPrice: 120,
  completionProfile: { serviceKey: 'pest_general_quarterly', requiresProducts: true },
});

// `defaults`: the /default-products body extras; 'fail': the request rejects.
function stubFetch(defaults) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/default-products')) {
      if (defaults === 'fail') throw new Error('network down');
      return {
        ok: true,
        json: async () => ({
          serviceId: 'pest-visit-1', programKey: 'pest',
          matchedVisit: { visit: 1, reason: 'pest_general', matched: true },
          source: 'none', products: [], unresolved: [], ...defaults,
        }),
      };
    }
    return { ok: true, json: async () => ({ customer: {}, actions: [], available: false }) };
  }));
}

async function openPanel(defaults) {
  stubFetch(defaults);
  await act(async () => {
    render(<CompletionPanel service={pestService()} products={pestCatalog} onClose={() => {}} onSubmit={vi.fn().mockResolvedValue({})} />);
  });
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('alert', vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('no application fits: seeds the mix without Taurus, keeps Crosscheck and the surfactant, and says why', async () => {
  await openPanel({ taurusYearly: FULL });
  await screen.findByText('LESCO Crosscheck Plus');
  expect(screen.getByText('LESCO 90/10 Nonionic Surfactant')).toBeTruthy();
  expect(screen.queryByText('Taurus SC')).toBeNull();
  expect(screen.getByText("Taurus left out: this home reached the label's yearly limit (4 this year).")).toBeTruthy();
});

it('room under the label: seeds the whole mix and says nothing', async () => {
  await openPanel({ taurusYearly: ROOM });
  await screen.findByText('Taurus SC');
  expect(screen.getByText('LESCO Crosscheck Plus')).toBeTruthy();
  expect(screen.queryByText(/yearly (Taurus )?limit/)).toBeNull();
});

it('unknown count (no key, null, or a failed request): seeds the mix without Taurus and says the count is unavailable', async () => {
  for (const defaults of [{}, { taurusYearly: null }, 'fail']) {
    await openPanel(defaults);
    await screen.findByText('LESCO Crosscheck Plus');
    expect(screen.getByText('LESCO 90/10 Nonionic Surfactant')).toBeTruthy();
    expect(screen.queryByText('Taurus SC')).toBeNull();
    expect(screen.getByText(UNKNOWN_LINE)).toBeTruthy();
    cleanup();
  }
});

it('adding Taurus back by hand when none fits warns (the left-out line gives way to the warning)', async () => {
  await openPanel({ taurusYearly: FULL });
  await screen.findByText('LESCO Crosscheck Plus');
  fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: 'Taurus' } });
  fireEvent.click(await screen.findByText('Taurus SC'));
  await waitFor(() => expect(screen.getByText("Over the label's yearly Taurus limit at this home.")).toBeTruthy());
  expect(screen.queryByText(/Taurus left out/)).toBeNull();
});

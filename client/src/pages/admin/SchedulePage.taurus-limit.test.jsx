// @vitest-environment jsdom
//
// CompletionPanel-level coverage for Taurus SC's label limit (4 a year per
// home, owner 2026-11-19): /default-products carries the server's count; at 4
// the pest house mix seeds without Taurus, a manual Taurus warns (never
// blocks), and an unknown count (failed request, or no key) seeds as before.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';

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

it('4 of 4: seeds the mix without Taurus, keeps Crosscheck and the surfactant, and says why', async () => {
  await openPanel({ taurusYearly: { count: 4, limit: 4, year: 2026 } });
  await screen.findByText('LESCO Crosscheck Plus');
  expect(screen.getByText('LESCO 90/10 Nonionic Surfactant')).toBeTruthy();
  expect(screen.queryByText('Taurus SC')).toBeNull();
  expect(screen.getByText('Taurus left out: 4 of 4 this year at this home (label limit).')).toBeTruthy();
});

it('3 of 4: seeds the whole mix and says nothing', async () => {
  await openPanel({ taurusYearly: { count: 3, limit: 4, year: 2026 } });
  await screen.findByText('Taurus SC');
  expect(screen.getByText('LESCO Crosscheck Plus')).toBeTruthy();
  expect(screen.queryByText(/label limit|over the label/)).toBeNull();
});

it('unknown count (no key, null, or a failed request): seeds the whole mix and says nothing', async () => {
  for (const defaults of [{}, { taurusYearly: null }, 'fail']) {
    await openPanel(defaults);
    await screen.findByText('Taurus SC');
    expect(screen.getByText('LESCO Crosscheck Plus')).toBeTruthy();
    expect(screen.queryByText(/label limit|over the label/)).toBeNull();
    cleanup();
  }
});

it('adding Taurus back by hand at 4 warns (the left-out line gives way to the warning)', async () => {
  await openPanel({ taurusYearly: { count: 4, limit: 4, year: 2026 } });
  await screen.findByText('LESCO Crosscheck Plus');
  fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: 'Taurus' } });
  fireEvent.click(await screen.findByText('Taurus SC'));
  await waitFor(() => expect(screen.getByText("5th Taurus this year at this home: over the label's 4.")).toBeTruthy());
  expect(screen.queryByText(/Taurus left out/)).toBeNull();
});

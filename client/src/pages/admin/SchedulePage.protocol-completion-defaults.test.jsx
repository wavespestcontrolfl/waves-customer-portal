// @vitest-environment jsdom
//
// CompletionPanel-level coverage for the protocol-product prefill hook
// (lib/protocol-completion-defaults.js): cockroach_control is a TYPED
// findings visit (findingsType 'cockroach') — the bug this file guards
// against is gating the seed on isTypedFindings, which would silently
// skip the one program the hook is for (owner ruling 2026-09-26/27; see
// the coordinator's correction — the "Products Applied" section renders
// unconditionally, typed or not, so seeding must not be typed-gated).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';

// Minimal typed 'cockroach' schema — same shape lawn-closeout's own typed
// fixture uses (a real findingsSchema needs no more to render).
const cockroachSchema = {
  type: 'cockroach',
  fields: [
    { key: 'species', label: 'Species', type: 'text', placeholder: 'Synthetic species' },
  ],
  nextStepChips: [],
};

const cockroachCatalog = [
  { id: 'c1', name: 'Alpine WSG', category: 'Insecticide', rate_unit: 'oz', default_rate: '0.5-1', default_unit: 'oz' },
  { id: 'c2', name: 'Gentrol IGR', category: 'IGR' },
  { id: 'c3', name: 'Advion Cockroach Gel Bait', category: 'Bait' },
];

function cockroachService(overrides = {}) {
  return {
    id: 'cockroach-visit-1',
    customerId: 'cockroach-customer-1',
    customerName: 'Synthetic Cockroach Customer',
    serviceType: 'Cockroach Control Service',
    status: 'confirmed',
    scheduledDate: '2099-01-01',
    estimatedPrice: 350,
    completionProfile: { serviceKey: 'cockroach_control', findingsType: 'cockroach', requiresProducts: true },
    findingsSchema: cockroachSchema,
    ...overrides,
  };
}

// The server's GET /admin/dispatch/:serviceId/default-products response
// for a cockroach_control visit (server/services/completion-product-
// defaults.js): the owner's three curated defaults, resolved by id.
const cockroachDefaultsResponse = {
  serviceId: 'cockroach-visit-1',
  programKey: 'cockroach',
  matchedVisit: { visit: 1, reason: 'cockroach_control', matched: true },
  source: 'protocol_visit',
  products: [
    { id: 'c1', name: 'Alpine WSG', category: 'Insecticide', formulation: null, defaultRatePer1000: null, rateUnit: 'oz', defaultRate: '0.5-1', defaultUnit: 'oz', applicationMethod: null, epaRegNumber: null, protocolRate: null, protocolRateUnit: null, protocolAmount: null, protocolAmountUnit: null, zone: null, source: { programKey: 'cockroach', visit: 1, origin: 'protocol_visit' } },
    { id: 'c2', name: 'Gentrol IGR', category: 'IGR', formulation: null, defaultRatePer1000: null, rateUnit: null, defaultRate: null, defaultUnit: null, applicationMethod: null, epaRegNumber: null, protocolRate: null, protocolRateUnit: null, protocolAmount: null, protocolAmountUnit: null, zone: null, source: { programKey: 'cockroach', visit: 1, origin: 'protocol_visit' } },
    { id: 'c3', name: 'Advion Cockroach Gel Bait', category: 'Bait', formulation: null, defaultRatePer1000: null, rateUnit: null, defaultRate: null, defaultUnit: null, applicationMethod: null, epaRegNumber: null, protocolRate: null, protocolRateUnit: null, protocolAmount: null, protocolAmountUnit: null, zone: null, source: { programKey: 'cockroach', visit: 1, origin: 'protocol_visit' } },
  ],
  unresolved: [],
};

// A deferred fetch for /default-products so a test can change state (the
// visit outcome) BEFORE the response lands — proving the gate is checked
// at seed time, not just at mount.
function stubFetchWithDeferredDefaults() {
  let resolveDefaults;
  const pending = new Promise((resolve) => { resolveDefaults = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/default-products')) {
      return { ok: true, json: async () => pending };
    }
    return { ok: true, json: async () => ({ customer: {}, actions: [], available: false }) };
  }));
  return { resolveDefaults };
}

function stubFetchWithImmediateDefaults(response = cockroachDefaultsResponse) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/default-products')) {
      return { ok: true, json: async () => response };
    }
    return { ok: true, json: async () => ({ customer: {}, actions: [], available: false }) };
  }));
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

it('seeds Alpine WSG + Gentrol IGR + Advion Cockroach Gel Bait on a completed, typed cockroach visit', async () => {
  stubFetchWithImmediateDefaults();
  await act(async () => {
    render(
      <CompletionPanel
        service={cockroachService()}
        products={cockroachCatalog}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue({})}
      />,
    );
  });

  await screen.findByText('Alpine WSG');
  expect(screen.getByText('Gentrol IGR')).toBeTruthy();
  expect(screen.getByText('Advion Cockroach Gel Bait')).toBeTruthy();
});

it('does NOT seed on a declined outcome, even once the server response lands', async () => {
  const { resolveDefaults } = stubFetchWithDeferredDefaults();
  await act(async () => {
    render(
      <CompletionPanel
        service={cockroachService()}
        products={cockroachCatalog}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue({})}
      />,
    );
  });

  // Switch the visit outcome away from "Completed" BEFORE the defaults
  // response arrives — the seed effect must read the outcome at the time
  // it actually tries to seed, not just at mount.
  const outcomeSelect = screen.getByDisplayValue('Completed');
  fireEvent.change(outcomeSelect, { target: { value: 'customer_declined' } });
  await waitFor(() => expect(outcomeSelect.value).toBe('customer_declined'));

  await act(async () => { resolveDefaults(cockroachDefaultsResponse); });
  // Give any pending effect a tick to (not) run.
  await act(async () => { await Promise.resolve(); });

  expect(screen.queryByText('Alpine WSG')).toBeNull();
  expect(screen.queryByText('Gentrol IGR')).toBeNull();
  expect(screen.queryByText('Advion Cockroach Gel Bait')).toBeNull();
});

it('does NOT seed on an inspection-only outcome', async () => {
  const { resolveDefaults } = stubFetchWithDeferredDefaults();
  await act(async () => {
    render(
      <CompletionPanel
        service={cockroachService()}
        products={cockroachCatalog}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue({})}
      />,
    );
  });

  const outcomeSelect = screen.getByDisplayValue('Completed');
  fireEvent.change(outcomeSelect, { target: { value: 'inspection_only' } });
  await waitFor(() => expect(outcomeSelect.value).toBe('inspection_only'));

  await act(async () => { resolveDefaults(cockroachDefaultsResponse); });
  await act(async () => { await Promise.resolve(); });

  expect(screen.queryByText('Alpine WSG')).toBeNull();
});

it('does NOT seed on top of a restored draft’s own products', async () => {
  const visit = cockroachService();
  localStorage.setItem(`waves_completion_draft_${visit.id}`, JSON.stringify({
    serviceId: visit.id,
    savedAt: Date.now(),
    notes: 'Hand-recorded cockroach visit',
    selectedProducts: [{
      productId: 'c1', name: 'Alpine WSG', rate: 1, rateUnit: 'oz',
      totalAmount: 1, amountUnit: 'oz', applicationMethod: 'bait_placement',
      areaValue: '', areaUnit: '',
    }],
  }));
  stubFetchWithImmediateDefaults();
  await act(async () => {
    render(
      <CompletionPanel
        service={visit}
        products={cockroachCatalog}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue({})}
      />,
    );
  });

  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  await screen.findByText('Alpine WSG');
  // The restored draft's own product list wins — Gentrol IGR and the
  // Advion gel bait (part of the curated default, not the tech's draft)
  // must never get added on top of it.
  expect(screen.queryByText('Gentrol IGR')).toBeNull();
  expect(screen.queryByText('Advion Cockroach Gel Bait')).toBeNull();
});

it('does NOT re-seed when a restored draft deliberately saved an EMPTY product list (pre-push audit P1)', async () => {
  // The tech removed every prefilled default before the drawer closed, and
  // the draft saved that empty list. selectedProducts.length is falsy
  // either way ("never seeded yet" and "restored empty on purpose" look
  // identical to that check alone) — restoreDraft() must mark the ref done
  // itself so the seed effect can never mistake one for the other.
  const visit = cockroachService();
  localStorage.setItem(`waves_completion_draft_${visit.id}`, JSON.stringify({
    serviceId: visit.id,
    savedAt: Date.now(),
    notes: 'Removed every default product on purpose',
    selectedProducts: [],
  }));
  stubFetchWithImmediateDefaults();
  await act(async () => {
    render(
      <CompletionPanel
        service={visit}
        products={cockroachCatalog}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue({})}
      />,
    );
  });

  fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
  await waitFor(() => expect(screen.getByPlaceholderText(/Notes about this service/).value).toBe('Removed every default product on purpose'));
  // Give the seed effect a tick — it must NOT fire now that the draft
  // (empty) has been restored.
  await act(async () => { await Promise.resolve(); });

  expect(screen.queryByText('Alpine WSG')).toBeNull();
  expect(screen.queryByText('Gentrol IGR')).toBeNull();
  expect(screen.queryByText('Advion Cockroach Gel Bait')).toBeNull();
});

// @vitest-environment jsdom
//
// CompletionPanel-level coverage for the pest tank-mix seed's outcome
// handling (lib/pest-default-mix.js): Codex r3 P1 on #5049 — the seed
// (now also live on one-time pest) ignored visitOutcome entirely, so
// picking inspection_only / customer_declined after it fired left Taurus
// SC / Atticus Talak 7.9 F / LESCO 90/10 Nonionic Surfactant selected, and
// submit would record applied products, compliance rows, and inventory
// deductions for a visit declared not performed. This mirrors
// SchedulePage.protocol-completion-defaults.test.jsx's own outcome-gating
// coverage for the cockroach protocol seed exactly.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';

const pestCatalog = [
  { id: 'p1', name: 'Taurus SC', category: 'Insecticide' },
  { id: 'p2', name: 'Atticus Talak 7.9 F', category: 'Insecticide' },
  { id: 'p3', name: 'LESCO 90/10 Nonionic Surfactant', category: 'Adjuvant' },
];

function pestService(overrides = {}) {
  return {
    id: 'pest-visit-1',
    customerId: 'pest-customer-1',
    customerName: 'Synthetic Pest Customer',
    serviceType: 'General Pest Control (Quarterly)',
    status: 'confirmed',
    scheduledDate: '2099-01-01',
    estimatedPrice: 120,
    completionProfile: { serviceKey: 'pest_general_quarterly', requiresProducts: true },
    ...overrides,
  };
}

// This visit carries no protocols.json completionDefaultProducts (pest
// visit 1 is owned entirely by lib/pest-default-mix.js — see
// completion-product-defaults.test.jsx) — the server resolver always
// answers source 'none' here, so the fetch stub just needs to be well
// formed; it plays no role in this file's coverage.
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/default-products')) {
      return {
        ok: true,
        json: async () => ({
          serviceId: 'pest-visit-1', programKey: 'pest',
          matchedVisit: { visit: 1, reason: 'pest_general', matched: true },
          source: 'none', products: [], unresolved: [],
        }),
      };
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

it('seeds Taurus SC + Atticus Talak 7.9 F + LESCO 90/10 Nonionic Surfactant on a completed general-pest visit', async () => {
  stubFetch();
  await act(async () => {
    render(
      <CompletionPanel
        service={pestService()}
        products={pestCatalog}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue({})}
      />,
    );
  });
  await screen.findByText('Taurus SC');
  expect(screen.getByText('Atticus Talak 7.9 F')).toBeTruthy();
  expect(screen.getByText('LESCO 90/10 Nonionic Surfactant')).toBeTruthy();
});

it('clears the seeded pest-mix rows on customer_declined, then reseeds once the outcome returns to completed (Codex r3 P1, PR #5049)', async () => {
  stubFetch();
  await act(async () => {
    render(
      <CompletionPanel
        service={pestService()}
        products={pestCatalog}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue({})}
      />,
    );
  });
  await screen.findByText('Taurus SC');

  const outcomeSelect = screen.getByDisplayValue('Completed');
  fireEvent.change(outcomeSelect, { target: { value: 'customer_declined' } });
  await waitFor(() => expect(screen.queryByText('Taurus SC')).toBeNull());
  expect(screen.queryByText('Atticus Talak 7.9 F')).toBeNull();
  expect(screen.queryByText('LESCO 90/10 Nonionic Surfactant')).toBeNull();

  fireEvent.change(outcomeSelect, { target: { value: 'completed' } });
  await waitFor(() => expect(screen.queryByText('Taurus SC')).not.toBeNull());
  expect(screen.getByText('Atticus Talak 7.9 F')).toBeTruthy();
  expect(screen.getByText('LESCO 90/10 Nonionic Surfactant')).toBeTruthy();
});

it('clears the seeded pest-mix rows on inspection_only too', async () => {
  stubFetch();
  await act(async () => {
    render(
      <CompletionPanel
        service={pestService()}
        products={pestCatalog}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue({})}
      />,
    );
  });
  await screen.findByText('Taurus SC');

  const outcomeSelect = screen.getByDisplayValue('Completed');
  fireEvent.change(outcomeSelect, { target: { value: 'inspection_only' } });
  await waitFor(() => expect(screen.queryByText('Taurus SC')).toBeNull());
  expect(screen.queryByText('Atticus Talak 7.9 F')).toBeNull();
  expect(screen.queryByText('LESCO 90/10 Nonionic Surfactant')).toBeNull();
});

it('a hand-removed pest-mix row stays removed while the outcome stays completed (never re-added by this fix)', async () => {
  stubFetch();
  await act(async () => {
    render(
      <CompletionPanel
        service={pestService()}
        products={pestCatalog}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue({})}
      />,
    );
  });
  await screen.findByText('Taurus SC');
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove product' })[0]);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove product' })).toHaveLength(2));
  // No outcome switch happens here — the removal is the tech's own edit,
  // which the outcome-driven clearing effect must never touch or restore.
  await act(async () => { await Promise.resolve(); });
  expect(screen.getAllByRole('button', { name: 'Remove product' })).toHaveLength(2);
});

it('a hand-removed pest-mix row stays removed across declined → completed (pre-push audit on #5049 r3)', async () => {
  stubFetch();
  await act(async () => {
    render(
      <CompletionPanel
        service={pestService()}
        products={pestCatalog}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue({})}
      />,
    );
  });
  await screen.findByText('Atticus Talak 7.9 F');
  const talakRow = screen.getByText('Atticus Talak 7.9 F').closest('[data-selected-product], li, tr, div');
  const removeButtons = screen.getAllByRole('button', { name: 'Remove product' });
  // Remove Talak specifically (the tech's own edit).
  const talakIndex = removeButtons.findIndex((btn) => talakRow && talakRow.contains(btn));
  fireEvent.click(removeButtons[talakIndex >= 0 ? talakIndex : 1]);
  await waitFor(() => expect(screen.queryByText('Atticus Talak 7.9 F')).toBeNull());

  const outcomeSelect = screen.getByDisplayValue('Completed');
  fireEvent.change(outcomeSelect, { target: { value: 'customer_declined' } });
  await waitFor(() => expect(screen.queryAllByRole('button', { name: 'Remove product' })).toHaveLength(0));
  fireEvent.change(outcomeSelect, { target: { value: 'completed' } });
  await screen.findByText('Taurus SC');
  await screen.findByText('LESCO 90/10 Nonionic Surfactant');
  // The deliberate removal survives the outcome round-trip.
  expect(screen.queryByText('Atticus Talak 7.9 F')).toBeNull();
});

it('applies the same mix and the same outcome gating to a one-time pest visit scheduled under the bare label (Codex r3 P1+P2, PR #5049)', async () => {
  stubFetch();
  const oneTimeService = pestService({
    id: 'pest-onetime-1',
    // The bare scheduler-fallback label (admin-schedule.js
    // EDIT_FALLBACK_SERVICES) — only the catalog key marks this as the
    // one-time pest job (Codex r3 P2).
    serviceType: 'Pest Control Service',
    completionProfile: { serviceKey: 'one_time_pest_control', requiresProducts: true },
  });
  await act(async () => {
    render(
      <CompletionPanel
        service={oneTimeService}
        products={pestCatalog}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue({})}
      />,
    );
  });
  await screen.findByText('Taurus SC');

  const outcomeSelect = screen.getByDisplayValue('Completed');
  fireEvent.change(outcomeSelect, { target: { value: 'inspection_only' } });
  await waitFor(() => expect(screen.queryByText('Taurus SC')).toBeNull());
});

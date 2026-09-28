// @vitest-environment jsdom
//
// CompletionPanel-level coverage for the protocol-product prefill hook
// (lib/protocol-completion-defaults.js): cockroach_control is a TYPED
// findings visit (findingsType 'cockroach') — the bug this file guards
// against is gating the seed on isTypedFindings, which would silently
// skip the one program the hook is for (owner ruling 2026-09-26/27; see
// the coordinator's correction — the "Products Applied" section renders
// unconditionally, typed or not, so seeding must not be typed-gated).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';

// Minimal typed 'cockroach' schema — same shape lawn-closeout's own typed
// fixture uses (a real findingsSchema needs no more to render).
const cockroachSchema = {
  type: 'cockroach',
  fields: [
    { key: 'species', label: 'Species', type: 'text', placeholder: 'Synthetic species' },
  ],
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
// defaults.js): the owner's three curated defaults, resolved by id, each
// carrying its protocol-specified completionApplicationMethod (Codex r2
// P1, PR #5049) — Alpine WSG and Gentrol IGR have no catalog
// application_method, so without this override the client would infer
// 'perimeter_spray' and wrongly demand linear footage for interior work.
const cockroachDefaultsResponse = {
  serviceId: 'cockroach-visit-1',
  programKey: 'cockroach',
  matchedVisit: { visit: 1, reason: 'cockroach_control', matched: true },
  source: 'protocol_visit',
  products: [
    { id: 'c1', name: 'Alpine WSG', category: 'Insecticide', formulation: null, defaultRatePer1000: null, rateUnit: 'oz', defaultRate: '0.5-1', defaultUnit: 'oz', applicationMethod: null, completionApplicationMethod: 'spot_treatment', epaRegNumber: null, source: { programKey: 'cockroach', visit: 1, origin: 'protocol_visit' } },
    { id: 'c2', name: 'Gentrol IGR', category: 'IGR', formulation: null, defaultRatePer1000: null, rateUnit: null, defaultRate: null, defaultUnit: null, applicationMethod: null, completionApplicationMethod: 'spot_treatment', epaRegNumber: null, source: { programKey: 'cockroach', visit: 1, origin: 'protocol_visit' } },
    { id: 'c3', name: 'Advion Cockroach Gel Bait', category: 'Bait', formulation: null, defaultRatePer1000: null, rateUnit: null, defaultRate: null, defaultUnit: null, applicationMethod: 'bait_placement', completionApplicationMethod: 'bait_placement', epaRegNumber: null, source: { programKey: 'cockroach', visit: 1, origin: 'protocol_visit' } },
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

it('a restored pre-retirement draft with Next steps chips drops its stale generated report (Codex r1 #5116)', async () => {
  const visit = cockroachService();
  const report = 'WHAT WE DID:\nPlaced gel bait in the kitchen.\nWHAT WE FOUND:\nRoach activity under the sink.';
  localStorage.setItem(`waves_completion_draft_${visit.id}`, JSON.stringify({
    serviceId: visit.id,
    savedAt: Date.now(),
    notes: report,
    generatedReportText: report,
    aiReportUsed: true,
    // Retired field: copy generated while these were selected fed the old
    // "Next steps selected" prompt line, so the report must not survive.
    typedNextStepChips: ['Monitor activity'],
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
  await waitFor(() => expect(screen.getByText(/the draft\s+was cleared/)).toBeTruthy());
});

it('a chips-only pre-retirement draft restored after its profile went untyped drops its stale generated report (Codex r2 #5116)', async () => {
  const visit = cockroachService({
    id: 'cockroach-visit-untyped',
    completionProfile: { serviceKey: 'cockroach_control', findingsType: null, requiresProducts: true },
    findingsSchema: null,
  });
  const report = 'WHAT WE DID:\nPlaced gel bait in the kitchen.';
  localStorage.setItem(`waves_completion_draft_${visit.id}`, JSON.stringify({
    serviceId: visit.id,
    savedAt: Date.now(),
    notes: report,
    generatedReportText: report,
    aiReportUsed: true,
    typedNextStepChips: ['Monitor activity'],
  }));
  const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  stubFetchWithImmediateDefaults();
  try {
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
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/the draft\s+was cleared/)).toBeTruthy());
  } finally {
    alertSpy.mockRestore();
  }
});

it('a removed companion whose saved draft held only retired chips still drops the stale generated report (pre-push audit #5116)', async () => {
  const visit = cockroachService({ id: 'cockroach-visit-removed-companion' });
  const report = 'WHAT WE DID:\nPlaced gel bait in the kitchen.';
  localStorage.setItem(`waves_completion_draft_${visit.id}`, JSON.stringify({
    serviceId: visit.id,
    savedAt: Date.now(),
    notes: report,
    generatedReportText: report,
    aiReportUsed: true,
    // A companion the profile no longer declares; its only saved input was
    // the retired Next steps chips.
    companionState: { termite_bait_station: { values: {}, chips: ['Continue scheduled monitoring'], score: null } },
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
  await waitFor(() => expect(screen.getByText(/the draft\s+was cleared/)).toBeTruthy());
});

it('clears the seeded rows on customer_declined, then reseeds once the outcome returns to completed (pre-push audit P1, PR #5049 r1)', async () => {
  // cockroach has no specialtyCompletionFor preset, so the submit-time
  // noApplicationOutcomeConflict guard never runs for it — a seeded
  // default left on the form after a customer_declined/inspection_only
  // switch would otherwise still submit service_products rows for a visit
  // declared not performed. The seed must police itself.
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

  const outcomeSelect = screen.getByDisplayValue('Completed');
  fireEvent.change(outcomeSelect, { target: { value: 'customer_declined' } });
  await waitFor(() => expect(screen.queryByText('Alpine WSG')).toBeNull());
  expect(screen.queryByText('Gentrol IGR')).toBeNull();
  expect(screen.queryByText('Advion Cockroach Gel Bait')).toBeNull();

  fireEvent.change(outcomeSelect, { target: { value: 'completed' } });
  await waitFor(() => expect(screen.queryByText('Alpine WSG')).not.toBeNull());
  expect(screen.getByText('Gentrol IGR')).toBeTruthy();
  expect(screen.getByText('Advion Cockroach Gel Bait')).toBeTruthy();
});

it('clears the seeded rows on inspection_only too (the same no-application pair the submit-time guard defines)', async () => {
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

  const outcomeSelect = screen.getByDisplayValue('Completed');
  fireEvent.change(outcomeSelect, { target: { value: 'inspection_only' } });
  await waitFor(() => expect(screen.queryByText('Alpine WSG')).toBeNull());
});

it('does NOT persist a draft merely from an untouched seed; removing one seeded row DOES (pre-push audit P2, PR #5049 r1)', async () => {
  const visit = cockroachService();
  const draftKey = `waves_completion_draft_${visit.id}`;

  stubFetchWithImmediateDefaults();
  let view;
  await act(async () => {
    view = render(
      <CompletionPanel
        service={visit}
        products={cockroachCatalog}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue({})}
      />,
    );
  });
  await screen.findByText('Alpine WSG');
  // Let the autosave effect settle on the untouched-seed snapshot.
  await act(async () => { await Promise.resolve(); });
  view.unmount();
  expect(localStorage.getItem(draftKey)).toBeNull();

  // Fresh mount, seed again, then remove ONE row by hand — that edit is
  // real tech input and must persist a draft.
  await act(async () => {
    view = render(
      <CompletionPanel
        service={visit}
        products={cockroachCatalog}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue({})}
      />,
    );
  });
  await screen.findByText('Alpine WSG');
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove product' })[0]);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove product' })).toHaveLength(2));
  view.unmount();
  expect(localStorage.getItem(draftKey)).not.toBeNull();
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

it('removing ALL three seeded rows persists a draft; restoring it re-seeds nothing (pre-push audit P1, PR #5049 r2)', async () => {
  const visit = cockroachService();
  const draftKey = `waves_completion_draft_${visit.id}`;

  stubFetchWithImmediateDefaults();
  let view;
  await act(async () => {
    view = render(
      <CompletionPanel
        service={visit}
        products={cockroachCatalog}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue({})}
      />,
    );
  });
  await screen.findByText('Alpine WSG');

  // Remove all three, one tap at a time — the OTHER two stay put after
  // each single removal (never all-or-nothing).
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove product' })[0]);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove product' })).toHaveLength(2));
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove product' })[0]);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove product' })).toHaveLength(1));
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove product' })[0]);
  await waitFor(() => expect(screen.queryAllByRole('button', { name: 'Remove product' })).toHaveLength(0));

  view.unmount();
  // A deliberate removal of every seeded row is still draft content — the
  // removal ledger, not selectedProducts.length, is what autosave counts.
  expect(localStorage.getItem(draftKey)).not.toBeNull();

  // Reopen: the draft exists, so a Restore prompt appears — clicking it
  // must re-seed NOTHING, not even the products it once carried.
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
  await act(async () => { await Promise.resolve(); });

  expect(screen.queryByText('Alpine WSG')).toBeNull();
  expect(screen.queryByText('Gentrol IGR')).toBeNull();
  expect(screen.queryByText('Advion Cockroach Gel Bait')).toBeNull();
});

it('removing ONE seeded row and restoring keeps only the other two — the removed one never comes back (pre-push audit P1, PR #5049 r2)', async () => {
  const visit = cockroachService();
  const draftKey = `waves_completion_draft_${visit.id}`;

  stubFetchWithImmediateDefaults();
  let view;
  await act(async () => {
    view = render(
      <CompletionPanel
        service={visit}
        products={cockroachCatalog}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue({})}
      />,
    );
  });
  await screen.findByText('Alpine WSG');

  // Remove Gentrol IGR specifically (identifiable, unlike a bare index).
  const gentrolRow = screen.getByText('Gentrol IGR').closest('div');
  fireEvent.click(within(gentrolRow).getByRole('button', { name: 'Remove product' }));
  await waitFor(() => expect(screen.queryByText('Gentrol IGR')).toBeNull());
  expect(screen.getByText('Alpine WSG')).toBeTruthy();
  expect(screen.getByText('Advion Cockroach Gel Bait')).toBeTruthy();

  view.unmount();
  expect(localStorage.getItem(draftKey)).not.toBeNull();

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
  await waitFor(() => expect(screen.getByText('Alpine WSG')).toBeTruthy());
  expect(screen.getByText('Advion Cockroach Gel Bait')).toBeTruthy();
  // The deliberately removed one never comes back.
  expect(screen.queryByText('Gentrol IGR')).toBeNull();
});

it('seeded Alpine WSG / Gentrol IGR carry the protocol\'s spot_treatment method (not the catalog-inferred perimeter_spray) and never demand linear footage; Advion keeps bait_placement (Codex r2 P1, PR #5049)', async () => {
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

  const alpineRow = screen.getByText('Alpine WSG').closest('div');
  const gentrolRow = screen.getByText('Gentrol IGR').closest('div');
  const advionRow = screen.getByText('Advion Cockroach Gel Bait').closest('div');

  // Alpine WSG and Gentrol IGR have no catalog application_method, so
  // without the protocol's own completionApplicationMethod override the
  // seed would land them on the catalog-inferred 'perimeter_spray'
  // (Codex r2 P1) instead of the German-roach protocol's interior method.
  expect(within(alpineRow).getByDisplayValue('Spot treatment')).toBeTruthy();
  expect(within(gentrolRow).getByDisplayValue('Spot treatment')).toBeTruthy();
  // Advion already resolves to bait_placement via its own catalog category
  // — the lineMeta override matches it rather than disturbing it.
  expect(within(advionRow).getByDisplayValue('Bait')).toBeTruthy();

  // 'perimeter_spray' is the ONLY method that demands linear footage,
  // client-side (requiresLinearFt) and at server submit
  // (requiresLinearFtForReportApplication) — none of these three rows may
  // render that input.
  expect(within(alpineRow).queryByPlaceholderText('Linear ft')).toBeNull();
  expect(within(gentrolRow).queryByPlaceholderText('Linear ft')).toBeNull();
  expect(within(advionRow).queryByPlaceholderText('Linear ft')).toBeNull();
});

it('a saved draft carries the untouched-seed snapshot so a restore keeps treating those rows as the baseline (pre-push audit, PR #5049)', async () => {
  const visit = cockroachService();
  const draftKey = `waves_completion_draft_${visit.id}`;

  stubFetchWithImmediateDefaults();
  let view;
  await act(async () => {
    view = render(
      <CompletionPanel
        service={visit}
        products={cockroachCatalog}
        onClose={() => {}}
        onSubmit={vi.fn().mockResolvedValue({})}
      />,
    );
  });
  await screen.findByText('Alpine WSG');
  // A real edit (removing one row) persists a draft; the seed snapshot must
  // ride along with it, the same way lawnDefaultMixSnapshot does.
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove product' })[0]);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove product' })).toHaveLength(2));
  view.unmount();

  const saved = JSON.parse(localStorage.getItem(draftKey));
  expect(typeof saved.protocolCompletionDefaultsSnapshot).toBe('string');
  const snapshotNames = JSON.parse(saved.protocolCompletionDefaultsSnapshot).map((row) => row.name || row.productName);
  expect(snapshotNames.join(' ')).toContain('Alpine WSG');
  expect(snapshotNames.join(' ')).toContain('Gentrol IGR');
});

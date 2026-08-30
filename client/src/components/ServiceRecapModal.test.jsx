// @vitest-environment jsdom
// Recap rates are technician-confirmed (codex P1, PR #3419 r5): the modal
// shows an EDITABLE rate per selected product — prefilled from the visit's
// recorded rate first, else the catalog default — and submits only what the
// tech confirms. These tests pin the prefill precedence and the payload.
import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ServiceRecapModal from './ServiceRecapModal';

afterEach(cleanup);

const CATALOG = [
  {
    id: 1,
    name: 'Advion Ant Bait Gel',
    category: 'Insecticide',
    active_ingredient: 'Indoxacarb',
    moa_group: '22A',
    default_rate: '0.1-1',
    default_unit: 'g/spot',
    rate_unit: null,
    default_rate_per_1000: null,
  },
  {
    id: 2,
    name: 'Victor Rat Trap',
    category: 'Trap',
    active_ingredient: null,
    moa_group: null,
    default_rate: null,
    default_unit: null,
    rate_unit: null,
    default_rate_per_1000: null,
  },
  {
    id: 3,
    name: 'Adjourn SC',
    category: 'Insecticide',
    active_ingredient: 'Esfenvalerate',
    moa_group: '3A',
    default_rate: '0.33-0.65',
    default_unit: 'fl_oz/gal',
    rate_unit: null,
    default_rate_per_1000: null,
  },
];

function makeRequest({ existingProducts = [], products = CATALOG } = {}) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/context')) {
      return {
        ok: true,
        eligible: true,
        service: { id: 'svc-1', customerName: 'Pat Jones', hasPhone: false },
        timeline: [],
        products,
        existingRecord: existingProducts.length
          ? { id: 'rec-1', technician_notes: 'prior note', status: 'completed', products: existingProducts }
          : null,
      };
    }
    return { ok: true };
  });
  request.calls = calls;
  return request;
}

// Catalog carrying the default pest tank mix (lib/pest-default-mix) plus
// the LESCO lawn surfactant that must never be substituted for it.
const MIX_CATALOG = [
  ...CATALOG,
  {
    id: 4,
    name: 'Taurus SC',
    category: 'Insecticide',
    active_ingredient: 'Fipronil',
    moa_group: null,
    default_rate: '0.8-1.6',
    default_unit: 'fl_oz/gal',
    rate_unit: null,
    default_rate_per_1000: null,
  },
  {
    id: 5,
    name: 'Talstar P',
    category: 'Insecticide',
    active_ingredient: 'Bifenthrin',
    moa_group: '3A',
    default_rate: null,
    default_unit: null,
    rate_unit: null,
    default_rate_per_1000: null,
  },
  {
    id: 6,
    name: 'LESCO 90/10 Nonionic Surfactant',
    category: 'Adjuvant',
    active_ingredient: null,
    moa_group: null,
    default_rate: '0.03-0.64',
    default_unit: 'fl_oz/gal',
    rate_unit: null,
    default_rate_per_1000: null,
  },
  {
    id: 7,
    name: 'Non-ionic Surfactant',
    category: 'adjuvant',
    active_ingredient: 'Non-ionic surfactant blend',
    moa_group: null,
    default_rate: null,
    default_unit: null,
    rate_unit: null,
    default_rate_per_1000: null,
  },
];

describe('ServiceRecapModal application rates', () => {
  test('selecting a product prefills an editable rate from the catalog default', async () => {
    const request = makeRequest();
    render(<ServiceRecapModal service={{ id: 'svc-1' }} request={request} onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Advion Ant Bait Gel' }));

    const input = screen.getByLabelText('Application rate for Advion Ant Bait Gel');
    expect(input.value).toBe('0.1');
    expect(screen.getByText('g/spot')).toBeTruthy();
  });

  test('a product with no resolvable prefill (mechanical trap) gets no rate row', async () => {
    const request = makeRequest();
    render(<ServiceRecapModal service={{ id: 'svc-1' }} request={request} onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Victor Rat Trap' }));

    expect(screen.queryByLabelText('Application rate for Victor Rat Trap')).toBeNull();
  });

  // The pest 4-oz perimeter house default outranks the dilution band's low
  // bound — same precedence as CompletionPanel, via the shared resolver
  // (codex P1 r6): the same visit and product prefill the same rate on
  // either completion path.
  test('a liquid perimeter-spray product prefills the 4 oz pest house default, not the dilution low bound', async () => {
    const request = makeRequest();
    render(<ServiceRecapModal service={{ id: 'svc-1' }} request={request} onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Adjourn SC' }));

    const input = screen.getByLabelText('Application rate for Adjourn SC');
    expect(input.value).toBe('4');
    expect(screen.getByText('oz')).toBeTruthy();
  });

  test('reopening a recap prefills the RECORDED rate, not the catalog default', async () => {
    const request = makeRequest({
      existingProducts: [
        { product_name: 'Advion Ant Bait Gel', application_rate: '0.5', rate_unit: 'g/spot' },
      ],
    });
    render(<ServiceRecapModal service={{ id: 'svc-1' }} request={request} onClose={() => {}} />);

    const input = await screen.findByLabelText('Application rate for Advion Ant Bait Gel');
    expect(input.value).toBe('0.5');
  });

  test('submit sends the edited rate; a cleared rate submits none', async () => {
    const request = makeRequest();
    render(<ServiceRecapModal service={{ id: 'svc-1' }} request={request} onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Advion Ant Bait Gel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Victor Rat Trap' }));
    fireEvent.change(
      screen.getByLabelText('Application rate for Advion Ant Bait Gel'),
      { target: { value: '0.7' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Complete Service' }));

    await waitFor(() => {
      expect(request.calls.some((c) => c.options?.method === 'POST' && !c.path.endsWith('/draft'))).toBe(true);
    });
    const submit = request.calls.find((c) => c.options?.method === 'POST' && !c.path.endsWith('/draft'));
    const body = JSON.parse(submit.options.body);
    const gel = body.products.find((p) => p.product_name === 'Advion Ant Bait Gel');
    const trap = body.products.find((p) => p.product_name === 'Victor Rat Trap');
    expect(gel.application_rate).toBe(0.7);
    expect(gel.rate_unit).toBe('g/spot');
    expect(trap.application_rate).toBeUndefined();
    expect(trap.rate_unit).toBeUndefined();
  });
});

// The default pest tank mix (owner 2026-08-29, lib/pest-default-mix) seeds
// the primary field-tech completion too (codex P1 on #3611): a FRESH
// recurring general-pest or pest re-service recap pre-selects Taurus SC,
// Talstar P, and the non-ionic surfactant, rates prefilled exactly as a
// manual tap would.
describe('ServiceRecapModal default pest tank mix', () => {
  test('a fresh recurring pest recap pre-selects the mix with catalog rate prefills', async () => {
    const request = makeRequest({ products: MIX_CATALOG });
    render(
      <ServiceRecapModal
        service={{ id: 'svc-1', serviceType: 'Quarterly Pest Control Service' }}
        request={request}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByRole('button', { name: '✓ Taurus SC' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '✓ Talstar P' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '✓ Non-ionic Surfactant' })).toBeTruthy();
    // The LESCO lawn surfactant is never substituted into the mix.
    expect(screen.getByRole('button', { name: 'LESCO 90/10 Nonionic Surfactant' })).toBeTruthy();
    // Rates seed from the same catalog prefill a manual tap would use —
    // for Taurus the pest 4-oz house default (it outranks the dilution
    // band's low bound, same precedence the Adjourn SC test pins). The
    // adjuvant gets no fabricated rate: isAdjuvantProduct keeps the
    // insecticide house default off surfactants.
    expect(screen.getByLabelText('Application rate for Taurus SC').value).toBe('4');
    expect(screen.queryByLabelText('Application rate for Non-ionic Surfactant')).toBeNull();
  });

  test('a one-time pest recap seeds nothing', async () => {
    const request = makeRequest({ products: MIX_CATALOG });
    render(
      <ServiceRecapModal
        service={{ id: 'svc-1', serviceType: 'Pest Control Service' }}
        request={request}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Taurus SC' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^✓ / })).toBeNull();
  });

  test('a reopened recap keeps the recorded selection — no mix injection', async () => {
    const request = makeRequest({
      products: MIX_CATALOG,
      existingProducts: [
        { product_name: 'Advion Ant Bait Gel', application_rate: '0.5', rate_unit: 'g/spot' },
      ],
    });
    render(
      <ServiceRecapModal
        service={{ id: 'svc-1', serviceType: 'Quarterly Pest Control Service' }}
        request={request}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByRole('button', { name: '✓ Advion Ant Bait Gel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Taurus SC' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '✓ Taurus SC' })).toBeNull();
  });
});

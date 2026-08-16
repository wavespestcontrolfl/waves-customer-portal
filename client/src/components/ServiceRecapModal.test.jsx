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
    name: 'Termidor Foam',
    category: 'Insecticide',
    active_ingredient: 'Fipronil',
    moa_group: '2B',
    default_rate: null,
    default_unit: null,
    rate_unit: null,
    default_rate_per_1000: null,
  },
];

function makeRequest({ existingProducts = [] } = {}) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/context')) {
      return {
        ok: true,
        eligible: true,
        service: { id: 'svc-1', customerName: 'Pat Jones', hasPhone: false },
        timeline: [],
        products: CATALOG,
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

describe('ServiceRecapModal application rates', () => {
  test('selecting a product prefills an editable rate from the catalog default', async () => {
    const request = makeRequest();
    render(<ServiceRecapModal service={{ id: 'svc-1' }} request={request} onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Advion Ant Bait Gel' }));

    const input = screen.getByLabelText('Application rate for Advion Ant Bait Gel');
    expect(input.value).toBe('0.1');
    expect(screen.getByText('g/spot')).toBeTruthy();
  });

  test('a product with no catalog default gets no rate row', async () => {
    const request = makeRequest();
    render(<ServiceRecapModal service={{ id: 'svc-1' }} request={request} onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Termidor Foam' }));

    expect(screen.queryByLabelText('Application rate for Termidor Foam')).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Termidor Foam' }));
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
    const foam = body.products.find((p) => p.product_name === 'Termidor Foam');
    expect(gel.application_rate).toBe(0.7);
    expect(gel.rate_unit).toBe('g/spot');
    expect(foam.application_rate).toBeUndefined();
    expect(foam.rate_unit).toBeUndefined();
  });
});

// @vitest-environment jsdom
// Nothing a tech sees or enters on a completion is in mL (owner ruling
// 2026-09-27; every service 2026-09-29). The recap's rate editor only ever
// holds a truck unit: a catalog label rate kept in mL, a rate recorded on the
// visit in mL, and a saved draft's mL rate all leave the product without a
// rate row, and the completion sends no mL. Harness mirrors
// ServiceRecapModal.test.jsx.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ServiceRecapModal from './ServiceRecapModal';
import { completionDraftKey } from '../lib/completion-drafts';

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

const GEL = {
  id: 1, name: 'Advion Ant Bait Gel', category: 'Insecticide', active_ingredient: 'Indoxacarb', moa_group: '22A',
  default_rate: '0.1-1', default_unit: 'g/spot', rate_unit: null, default_rate_per_1000: null,
};
// The catalog row (migration 20260816000010): its label dose is in mL.
const IMA_JET = {
  id: 11, name: 'Arborjet Ima-Jet 10', category: 'Insecticide', active_ingredient: 'Imidacloprid', moa_group: '4A',
  default_rate: '1-6', default_unit: 'ml/inch dbh', rate_unit: null, default_rate_per_1000: null, application_method: 'trunk_injection',
};
// A liquid labeled in mL that the recap's pest line calls a perimeter spray.
const ML_SPRAY = {
  id: 12, name: 'Example Insecticide SC', category: 'Insecticide', active_ingredient: 'Example', moa_group: '3A',
  default_rate: '6-24', default_unit: 'ml/gal', rate_unit: null, default_rate_per_1000: null,
};
const CATALOG = [GEL, IMA_JET, ML_SPRAY];

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

async function submittedBody(request) {
  fireEvent.click(screen.getByRole('button', { name: 'Complete Service' }));
  const isSubmit = (c) => c.options?.method === 'POST' && !c.path.endsWith('/draft');
  await waitFor(() => expect(request.calls.some(isSubmit)).toBe(true));
  return JSON.parse(request.calls.find(isSubmit).options.body);
}
const productIn = (body, id) => body.products.find((p) => p.product_id === id);
const ML_TEXT = /\bml\b|millilit/i;

function expectNoRate(product) {
  expect(product).toMatchObject({ rate_confirmed: false });
  expect(product).not.toHaveProperty('application_rate');
  expect(product).not.toHaveProperty('rate_unit');
}

describe('ServiceRecapModal never offers or records mL', () => {
  test('a catalog label rate kept in mL gets no rate row, and the completion sends no mL', async () => {
    const request = makeRequest();
    render(<ServiceRecapModal service={{ id: 'svc-1' }} request={request} onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Arborjet Ima-Jet 10' }));
    expect(screen.getByRole('button', { name: 'Arborjet Ima-Jet 10', pressed: true })).toBeInTheDocument();
    expect(screen.queryByLabelText('Application rate for Arborjet Ima-Jet 10')).toBeNull();
    expect(document.body.textContent).not.toMatch(ML_TEXT);

    const body = await submittedBody(request);
    expectNoRate(productIn(body, 11));
    expect(JSON.stringify(body)).not.toMatch(ML_TEXT);
  });

  test('a perimeter spray labeled in mL starts at the 4 oz house default, never its mL band', async () => {
    const request = makeRequest();
    render(<ServiceRecapModal service={{ id: 'svc-1' }} request={request} onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Example Insecticide SC' }));
    expect(screen.getByLabelText('Application rate for Example Insecticide SC')).toHaveValue(4);
    expect(screen.getByText('oz')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(ML_TEXT);

    const body = await submittedBody(request);
    expect(productIn(body, 12)).toMatchObject({ rate_confirmed: true, application_rate: 4, rate_unit: 'oz' });
    expect(JSON.stringify(body)).not.toMatch(ML_TEXT);
  });

  test('a rate recorded on the visit in mL is not seeded; the server keeps the prior record', async () => {
    const request = makeRequest({
      existingProducts: [
        { product_id: 11, product_name: 'Arborjet Ima-Jet 10', application_rate: '3', rate_unit: 'ml/inch dbh' },
        { product_id: 1, product_name: 'Advion Ant Bait Gel', application_rate: '0.5', rate_unit: 'g/spot' },
      ],
    });
    render(<ServiceRecapModal service={{ id: 'svc-1' }} request={request} onClose={() => {}} />);

    expect(await screen.findByRole('button', { name: 'Arborjet Ima-Jet 10', pressed: true })).toBeInTheDocument();
    expect(screen.queryByLabelText('Application rate for Arborjet Ima-Jet 10')).toBeNull();
    // A rate recorded in a truck unit still seeds as before.
    expect(screen.getByLabelText('Application rate for Advion Ant Bait Gel')).toHaveValue(0.5);
    expect(document.body.textContent).not.toMatch(ML_TEXT);

    const body = await submittedBody(request);
    expect(body.productsConfirmed).toBe(true);
    // Unconfirmed: the server's preserve-prior path keeps what was recorded.
    expectNoRate(productIn(body, 11));
    expect(productIn(body, 1)).toMatchObject({ rate_confirmed: true, application_rate: 0.5, rate_unit: 'g/spot' });
  });

  test('a draft saved with an mL rate restores without it', async () => {
    const request = makeRequest();
    const open = () => render(<ServiceRecapModal service={{ id: 'svc-1' }} request={request} onClose={vi.fn()} />);
    const first = open();
    fireEvent.click(await screen.findByRole('button', { name: 'Arborjet Ima-Jet 10' }));
    fireEvent.click(screen.getByRole('button', { name: 'Advion Ant Bait Gel' }));
    fireEvent.change(screen.getByLabelText('Application rate for Advion Ant Bait Gel'), { target: { value: '0.4' } });
    first.unmount();

    // The draft an earlier build saved while it still seeded the label's mL rate.
    const key = completionDraftKey('svc-1', 'recap_local_local');
    const saved = JSON.parse(localStorage.getItem(key));
    expect(saved.selectedProducts.map((p) => p.id)).toEqual([1, 11]);
    localStorage.setItem(key, JSON.stringify({ ...saved, rates: { ...saved.rates, 11: { rate: '3', unit: 'ml/inch dbh' } } }));

    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore draft', exact: true }));
    expect(screen.getByRole('button', { name: 'Arborjet Ima-Jet 10', pressed: true })).toBeInTheDocument();
    expect(screen.queryByLabelText('Application rate for Arborjet Ima-Jet 10')).toBeNull();
    expect(screen.getByLabelText('Application rate for Advion Ant Bait Gel')).toHaveValue(0.4);
    expect(document.body.textContent).not.toMatch(ML_TEXT);

    const body = await submittedBody(request);
    expectNoRate(productIn(body, 11));
    expect(productIn(body, 1)).toMatchObject({ application_rate: 0.4, rate_unit: 'g/spot' });
    expect(JSON.stringify(body)).not.toMatch(ML_TEXT);
  });
});

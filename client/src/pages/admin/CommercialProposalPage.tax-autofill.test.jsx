// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CommercialProposalPage from './CommercialProposalPage';

// The tax field is a SUGGESTION from GET /proposal (suggestedTaxRate, the
// server's canonical county/exemption resolver). It fills a zero field when
// something taxable exists; operator input and locked proposals always win.
const line = (taxable) => ({ description: 'Monthly service', quantity: 1, unitPrice: 116.3, frequency: 'monthly', taxable });
const makeFixture = ({ taxable = false, taxRate = 0, suggestedTaxRate = 0.07, status = 'draft' } = {}) => ({
  bidToolsEnabled: true,
  suggestedTaxRate,
  estimate: { id: 'synthetic-proposal', status, editVersion: 'loaded-version', customerName: 'Synthetic Office' },
  proposal: { enabled: true, title: 'Synthetic proposal', taxRate, buildings: [{ name: 'Office', lineItems: [line(taxable)] }] },
});
let fixture;
beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'synthetic-token');
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => structuredClone(fixture), clone() { return this; },
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const mount = async (data) => {
  fixture = makeFixture(data);
  render(<MemoryRouter initialEntries={['/estimates/synthetic-proposal/proposal']}><Routes><Route path="/estimates/:estimateId/proposal" element={<CommercialProposalPage />} /></Routes></MemoryRouter>);
  await screen.findByDisplayValue('Synthetic proposal');
  return screen.getByLabelText(/Tax rate/);
};
const HINT = "Filled from the customer's county rate — edit if exempt.";

it('fills the suggested rate on load when a line is taxable and the saved rate is 0', async () => {
  const tax = await mount({ taxable: true });
  await waitFor(() => expect(tax).toHaveValue(7));
  expect(screen.getByText(HINT)).toBeInTheDocument();
});

it('fills the moment a taxable toggle turns on', async () => {
  const tax = await mount({ taxable: false });
  expect(tax).toHaveValue(0);
  expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('switch')[0]);
  await waitFor(() => expect(tax).toHaveValue(7));
  expect(screen.getByText(HINT)).toBeInTheDocument();
});

it('does not fill when no line is taxable', async () => {
  const tax = await mount({ taxable: false });
  expect(tax).toHaveValue(0);
  expect(screen.queryByText(HINT)).not.toBeInTheDocument();
});

it('does not overwrite a saved non-zero rate', async () => {
  const tax = await mount({ taxable: true, taxRate: 0.06 });
  expect(tax).toHaveValue(6);
  expect(screen.queryByText(HINT)).not.toBeInTheDocument();
});

it('does not overwrite what the operator typed, even a deliberate 0', async () => {
  const tax = await mount({ taxable: false });
  fireEvent.change(tax, { target: { value: '3' } });
  fireEvent.change(tax, { target: { value: '0' } });
  fireEvent.click(screen.getAllByRole('switch')[0]);
  await waitFor(() => expect(screen.getAllByRole('switch')[0]).toHaveAttribute('aria-checked', 'true'));
  expect(tax).toHaveValue(0);
  expect(screen.queryByText(HINT)).not.toBeInTheDocument();
});

it('does not fill a locked proposal', async () => {
  const tax = await mount({ taxable: true, status: 'accepted' });
  expect(tax).toBeDisabled();
  expect(tax).toHaveValue(0);
  expect(screen.queryByText(HINT)).not.toBeInTheDocument();
});

it('does not fill when the server has no positive suggestion (exempt customer)', async () => {
  const tax = await mount({ taxable: true, suggestedTaxRate: 0 });
  expect(tax).toHaveValue(0);
  expect(screen.queryByText(HINT)).not.toBeInTheDocument();
});

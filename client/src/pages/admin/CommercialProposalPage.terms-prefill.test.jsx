// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AGREEMENT_TERMS } from '@commercial-agreement-terms';
import CommercialProposalPage from './CommercialProposalPage';

// Owner 2026-10-24: a proposal that never had structured terms opens with the agreement's own texts
// (shared/commercial-agreement-terms.cjs, the constants online signing checks against). Authored terms and
// locked proposals are never touched; Net 30 only goes in on a Bill-by-invoice proposal.
const RENEWAL = 'Renews automatically for 12-month terms unless either party gives written notice at least 30 days before the term ends.';
const PRICE_ADJUSTMENT = "Pricing may be adjusted at renewal or with at least 30 days' written notice.";
const CANCELLATION = "Either party may cancel with 30 days' written notice. Charges for services already performed remain due.";

const makeFixture = ({ commercialTerms, billByInvoice = false, status = 'draft' } = {}) => ({
  bidToolsEnabled: true,
  suggestedTaxRate: 0,
  estimate: { id: 'synthetic-proposal', status, editVersion: 'loaded-version', customerName: 'Synthetic Office', billByInvoice },
  proposal: {
    enabled: true, title: 'Synthetic proposal', taxRate: 0,
    buildings: [{ name: 'Office', lineItems: [{ description: 'Monthly service', quantity: 1, unitPrice: 116.3, frequency: 'monthly', taxable: false }] }],
    ...(commercialTerms !== undefined ? { commercialTerms } : {}),
  },
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
  return {
    payment: screen.getByLabelText(/Payment terms/),
    months: screen.getByLabelText(/Initial term/),
    renewal: screen.getByLabelText('Renewal'),
    priceAdjustment: screen.getByLabelText('Price adjustment'),
    cancellation: screen.getByLabelText('Cancellation'),
  };
};
const UNSAVED = 'Unsaved changes';

it('the prefilled texts are the agreement constants the server checks, word for word', () => {
  expect(AGREEMENT_TERMS.renewal).toBe(RENEWAL);
  expect(AGREEMENT_TERMS.priceAdjustment).toBe(PRICE_ADJUSTMENT);
  expect(AGREEMENT_TERMS.cancellation).toBe(CANCELLATION);
  expect(AGREEMENT_TERMS.initialTermMonths).toBe(12);
  expect(AGREEMENT_TERMS.paymentTerms).toBe('net30');
});

it('fills empty terms on load, marks the proposal unsaved, and leaves payment terms "Not set" without Bill by invoice', async () => {
  for (const commercialTerms of [undefined, null, {}]) {
    cleanup();
    const f = await mount({ commercialTerms });
    await waitFor(() => expect(f.renewal).toHaveValue(RENEWAL));
    expect(f.months).toHaveValue(12);
    expect(f.priceAdjustment).toHaveValue(PRICE_ADJUSTMENT);
    expect(f.cancellation).toHaveValue(CANCELLATION);
    expect(f.payment).toHaveValue('');
    expect(screen.getByText(UNSAVED)).toBeInTheDocument();
  }
});

it('sets Net 30 only when Bill by invoice is on', async () => {
  const f = await mount({ billByInvoice: true });
  await waitFor(() => expect(f.payment).toHaveValue('net30'));
  expect(f.renewal).toHaveValue(RENEWAL);
});

it('stays editable: the operator can change a prefilled term', async () => {
  const f = await mount({});
  await waitFor(() => expect(f.cancellation).toHaveValue(CANCELLATION));
  fireEvent.change(f.cancellation, { target: { value: 'Thirty days notice.' } });
  expect(f.cancellation).toHaveValue('Thirty days notice.');
});

it('never overwrites authored terms, even partly authored ones, and does not mark them unsaved', async () => {
  const f = await mount({ commercialTerms: { paymentTerms: null, initialTermMonths: 24, renewal: 'Month to month after the first term.', priceAdjustment: null, cancellation: null, accessRequirements: null }, billByInvoice: true });
  await waitFor(() => expect(f.renewal).toHaveValue('Month to month after the first term.'));
  expect(f.months).toHaveValue(24);
  expect(f.priceAdjustment).toHaveValue('');
  expect(f.cancellation).toHaveValue('');
  expect(f.payment).toHaveValue('');
  expect(screen.queryByText(UNSAVED)).not.toBeInTheDocument();
});

it('a site-access term alone counts as authored terms', async () => {
  const f = await mount({ commercialTerms: { accessRequirements: 'Keys at the front desk.' } });
  await screen.findByDisplayValue('Keys at the front desk.');
  expect(f.renewal).toHaveValue('');
  expect(screen.queryByText(UNSAVED)).not.toBeInTheDocument();
});

it('does not fill a locked proposal', async () => {
  const f = await mount({ status: 'accepted' });
  expect(f.renewal).toBeDisabled();
  expect(f.renewal).toHaveValue('');
  expect(f.months).toHaveValue(null);
  expect(f.cancellation).toHaveValue('');
  expect(screen.queryByText(UNSAVED)).not.toBeInTheDocument();
});

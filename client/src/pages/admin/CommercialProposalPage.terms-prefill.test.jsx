// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AGREEMENT_TERMS, AUTOPAY_PAYMENT_TERMS, INVOICE_PAYMENT_TERMS } from '@commercial-agreement-terms';
import CommercialProposalPage from './CommercialProposalPage';

// Owner 2026-10-24: a proposal that never had structured terms opens with the agreement's own texts
// (shared/commercial-agreement-terms.cjs, the constants online signing checks against). Authored terms and
// locked proposals are never touched; Net 30 only goes in on a Bill-by-invoice proposal.
// Owner 2026-10-28 builder scope: each fixed term is a Standard / Not stated / Custom pick (Custom shows the wording
// box), and Net-15 / Due on receipt are no longer offered (no signed-agreement wording).
const RENEWAL = 'Renews automatically for 12-month terms unless either party gives written notice at least 30 days before the term ends.';
const PRICE_ADJUSTMENT = "Pricing may be adjusted at renewal or with at least 30 days' written notice.";
const CANCELLATION = "Either party may cancel with 30 days' written notice. Charges for services already performed remain due.";

const makeFixture = ({ commercialTerms, billByInvoice = false, status = 'draft', autopay = false, signGate = false } = {}) => ({
  bidToolsEnabled: true,
  commercialAutopayEnabled: autopay,
  suggestedTaxRate: 0,
  estimate: { id: 'synthetic-proposal', status, editVersion: 'loaded-version', customerName: 'Synthetic Office', billByInvoice },
  proposal: {
    enabled: true, title: 'Synthetic proposal', taxRate: 0,
    buildings: [{ name: 'Office', lineItems: [{ description: 'Monthly service', quantity: 1, unitPrice: 116.3, frequency: 'monthly', taxable: false }] }],
    ...(commercialTerms !== undefined ? { commercialTerms } : {}),
  },
  ...(signGate ? { commercialAgreement: { state: 'none' } } : {}),
});
let fixture; let puts;
beforeEach(() => {
  puts = [];
  localStorage.setItem('waves_admin_token', 'synthetic-token');
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (options.method === 'PUT') puts.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => structuredClone(fixture), clone() { return this; } };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const mount = async (data) => {
  fixture = makeFixture(data);
  render(<MemoryRouter initialEntries={['/estimates/synthetic-proposal/proposal']}><Routes><Route path="/estimates/:estimateId/proposal" element={<CommercialProposalPage />} /></Routes></MemoryRouter>);
  await screen.findByDisplayValue('Synthetic proposal');
  return {
    payment: screen.getByLabelText(/Payment terms/),
    months: screen.getByLabelText('Initial term'),
    renewal: screen.getByLabelText('Renewal'),
    priceAdjustment: screen.getByLabelText('Price adjustment'),
    cancellation: screen.getByLabelText('Cancellation'),
  };
};
const UNSAVED = 'Unsaved changes';
const savedTerms = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  await waitFor(() => expect(puts).toHaveLength(1));
  return puts[0].proposal.commercialTerms;
};

it('the prefilled texts are the agreement constants the server checks, word for word', () => {
  expect(AGREEMENT_TERMS.renewal).toBe(RENEWAL);
  expect(AGREEMENT_TERMS.priceAdjustment).toBe(PRICE_ADJUSTMENT);
  expect(AGREEMENT_TERMS.cancellation).toBe(CANCELLATION);
  expect(AGREEMENT_TERMS.initialTermMonths).toBe(12);
  expect(AUTOPAY_PAYMENT_TERMS).toBe('autopay');
  expect(INVOICE_PAYMENT_TERMS).toBe('net30');
});

it('fills empty terms on load as Standard, shows the standard texts, marks the proposal unsaved, and saves those texts', async () => {
  for (const commercialTerms of [undefined, null, {}]) {
    cleanup();
    puts = [];
    const f = await mount({ commercialTerms });
    await waitFor(() => expect(f.renewal).toHaveValue('standard'));
    expect(f.months).toHaveValue('standard');
    expect(f.priceAdjustment).toHaveValue('standard');
    expect(f.cancellation).toHaveValue('standard');
    expect(f.payment).toHaveValue('');
    for (const text of [RENEWAL, PRICE_ADJUSTMENT, CANCELLATION]) expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByText(UNSAVED)).toBeInTheDocument();
    expect(await savedTerms()).toEqual({
      paymentTerms: null, initialTermMonths: 12, renewal: RENEWAL, priceAdjustment: PRICE_ADJUSTMENT, cancellation: CANCELLATION, accessRequirements: null,
    });
  }
});

it('sets Net 30 only when Bill by invoice is on', async () => {
  const f = await mount({ billByInvoice: true });
  await waitFor(() => expect(f.payment).toHaveValue('net30'));
  expect(f.renewal).toHaveValue('standard');
});

// Owner 2026-10-24 "autopay default" (GATE_COMMERCIAL_AUTOPAY): Auto Pay is the payment term of a proposal that does not
// bill by invoice; Net terms still need Bill by invoice.
it('with Auto Pay on, an empty proposal without Bill by invoice opens on Auto Pay; Net terms stay unavailable', async () => {
  const f = await mount({ autopay: true });
  await waitFor(() => expect(f.payment).toHaveValue('autopay'));
  expect(f.payment).not.toBeDisabled();
  expect(screen.getByRole('option', { name: 'Auto Pay' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Net-30' })).toBeDisabled();
  expect(screen.getByText(/Auto Pay charges the saved card or bank account after each service\. Net terms require Bill by invoice\./)).toBeInTheDocument();
});

it('with Auto Pay on, a Bill-by-invoice proposal still opens on Net 30 and offers no Auto Pay', async () => {
  const f = await mount({ autopay: true, billByInvoice: true });
  await waitFor(() => expect(f.payment).toHaveValue('net30'));
  expect(screen.queryByRole('option', { name: 'Auto Pay' })).not.toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Net-30' })).not.toBeDisabled();
});

it('with Auto Pay off, no Auto Pay choice is offered, but a proposal already on Auto Pay keeps it', async () => {
  await mount({});
  expect(screen.queryByRole('option', { name: 'Auto Pay' })).not.toBeInTheDocument();
  cleanup();
  const f = await mount({ commercialTerms: { paymentTerms: 'autopay' } });
  await waitFor(() => expect(f.payment).toHaveValue('autopay'));
  expect(screen.getByRole('option', { name: 'Auto Pay' })).toBeInTheDocument();
});

it('offers no Net-15 or Due on receipt; a proposal already on one shows it, marked, so it can be changed', async () => {
  await mount({ billByInvoice: true });
  expect(screen.queryByRole('option', { name: /Net-15/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /Due on receipt/ })).not.toBeInTheDocument();
  cleanup();
  const f = await mount({ billByInvoice: true, commercialTerms: { paymentTerms: 'net15' } });
  await waitFor(() => expect(f.payment).toHaveValue('net15'));
  expect(screen.getByRole('option', { name: 'Net-15 (no online signing)' })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /Due on receipt/ })).not.toBeInTheDocument();
  fireEvent.change(f.payment, { target: { value: 'net30' } });
  expect(f.payment).toHaveValue('net30');
});

it('Custom opens a wording box that starts from the standard text and stays editable', async () => {
  const f = await mount({});
  await waitFor(() => expect(f.cancellation).toHaveValue('standard'));
  fireEvent.change(f.cancellation, { target: { value: 'custom' } });
  const wording = screen.getByLabelText('Cancellation wording');
  expect(wording).toHaveValue(CANCELLATION);
  fireEvent.change(wording, { target: { value: 'Thirty days notice.' } });
  expect(wording).toHaveValue('Thirty days notice.');
  expect(f.cancellation).toHaveValue('custom');
});

it('Standard, Not stated and Custom save the standard text, nothing, and the typed wording', async () => {
  const f = await mount({});
  await waitFor(() => expect(f.renewal).toHaveValue('standard'));
  fireEvent.change(f.renewal, { target: { value: 'none' } });
  fireEvent.change(f.cancellation, { target: { value: 'custom' } });
  fireEvent.change(screen.getByLabelText('Cancellation wording'), { target: { value: 'Sixty days written notice.' } });
  fireEvent.change(f.months, { target: { value: 'custom' } });
  fireEvent.change(screen.getByLabelText('Initial term in months'), { target: { value: '24' } });
  expect(await savedTerms()).toMatchObject({
    initialTermMonths: 24, renewal: null, priceAdjustment: PRICE_ADJUSTMENT, cancellation: 'Sixty days written notice.',
  });
});

it('with online signing on, Custom wording says it turns signing off, once it differs from the standard', async () => {
  const f = await mount({ signGate: true });
  await waitFor(() => expect(f.renewal).toHaveValue('standard'));
  fireEvent.change(f.renewal, { target: { value: 'custom' } });
  const WARNING = 'Custom wording turns off online signing for this proposal.';
  expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Renewal wording'), { target: { value: 'Month to month after the first year.' } });
  expect(screen.getByText(WARNING)).toBeInTheDocument();
});

it('a stored text that differs only in apostrophes, case and spacing reads as Standard, the way signing reads it', async () => {
  const f = await mount({ commercialTerms: { cancellation: '  either party may cancel with 30 days\u2019 written notice.  Charges for services already performed remain due.' } });
  await waitFor(() => expect(f.cancellation).toHaveValue('standard'));
  expect(f.renewal).toHaveValue('none');
});

it('never overwrites authored terms, even partly authored ones, and does not mark them unsaved', async () => {
  const f = await mount({ commercialTerms: { paymentTerms: null, initialTermMonths: 24, renewal: 'Month to month after the first term.', priceAdjustment: null, cancellation: null, accessRequirements: null }, billByInvoice: true });
  await waitFor(() => expect(f.renewal).toHaveValue('custom'));
  expect(screen.getByLabelText('Renewal wording')).toHaveValue('Month to month after the first term.');
  expect(f.months).toHaveValue('custom');
  expect(screen.getByLabelText('Initial term in months')).toHaveValue(24);
  expect(f.priceAdjustment).toHaveValue('none');
  expect(f.cancellation).toHaveValue('none');
  expect(f.payment).toHaveValue('');
  expect(screen.queryByText(UNSAVED)).not.toBeInTheDocument();
});

it('a site-access term alone counts as authored terms', async () => {
  const f = await mount({ commercialTerms: { accessRequirements: 'Keys at the front desk.' } });
  await screen.findByDisplayValue('Keys at the front desk.');
  expect(f.renewal).toHaveValue('none');
  expect(screen.queryByText(UNSAVED)).not.toBeInTheDocument();
});

it('does not fill a locked proposal', async () => {
  const f = await mount({ status: 'accepted' });
  expect(f.renewal).toBeDisabled();
  expect(f.renewal).toHaveValue('none');
  expect(f.months).toHaveValue('none');
  expect(f.cancellation).toHaveValue('none');
  expect(screen.queryByText(UNSAVED)).not.toBeInTheDocument();
});

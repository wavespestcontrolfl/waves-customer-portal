// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CommercialProposalPage from './CommercialProposalPage';

// GATE_COMMERCIAL_PROPOSAL_SIGN: GET /admin/estimates/:id/proposal carries `commercialAgreement` only with the gate on;
// the builder shows it as one read-only line beside Sent / Viewed / Won, and shows nothing without it.
const makeFixture = (commercialAgreement) => ({
  bidToolsEnabled: false,
  suggestedTaxRate: 0,
  estimate: { id: 'synthetic-proposal', status: 'sent', editVersion: 'v1', customerName: 'Synthetic Office', sentAt: '2026-10-20T15:00:00.000Z' },
  proposal: { enabled: true, title: 'Synthetic proposal', taxRate: 0, buildings: [{ name: 'Office', lineItems: [{ description: 'Monthly service', quantity: 1, unitPrice: 100, frequency: 'monthly', taxable: false }] }] },
  ...(commercialAgreement ? { commercialAgreement } : {}),
});
let fixture;
beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'synthetic-token');
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => structuredClone(fixture), clone() { return this; },
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const mount = async (commercialAgreement) => {
  fixture = makeFixture(commercialAgreement);
  render(<MemoryRouter initialEntries={['/estimates/synthetic-proposal/proposal']}><Routes><Route path="/estimates/:estimateId/proposal" element={<CommercialProposalPage />} /></Routes></MemoryRouter>);
  await screen.findByDisplayValue('Synthetic proposal');
};

it('none: the line says the agreement has not started', async () => {
  await mount({ state: 'none' });
  expect(screen.getByTestId('proposal-agreement-status')).toHaveTextContent('Agreement not started');
});

it('awaiting: the line names the date it has waited since (ET)', async () => {
  await mount({ state: 'awaiting', contractId: 'c1', since: '2026-10-24T03:30:00.000Z' });
  // 03:30 UTC on Oct 24 is still Oct 23 in Eastern time.
  expect(screen.getByTestId('proposal-agreement-status')).toHaveTextContent('Agreement awaiting signature since Oct 23, 2026');
});

it('signed: the line names the signing date', async () => {
  await mount({ state: 'signed', contractId: 'c1', signedAt: '2026-10-25T15:00:00.000Z' });
  expect(screen.getByTestId('proposal-agreement-status')).toHaveTextContent('Agreement signed Oct 25, 2026');
});

it.each(['none', 'awaiting'])('%s with payment terms other than Net 30: the line says what to change', async (state) => {
  await mount({ state, since: '2026-10-24T15:00:00.000Z', signingBlocked: 'payment_terms', note: 'server note' });
  expect(screen.getByTestId('proposal-agreement-status')).toHaveTextContent('Online signing needs payment terms set to Net 30 (the agreement\u2019s terms).');
  expect(screen.queryByText(/Agreement not started|awaiting signature/)).not.toBeInTheDocument();
});

it('signed: the signed line wins (nothing blocks a signed agreement)', async () => {
  await mount({ state: 'signed', signedAt: '2026-10-25T15:00:00.000Z' });
  expect(screen.getByTestId('proposal-agreement-status')).toHaveTextContent('Agreement signed Oct 25, 2026');
});

it('gate off (no key in the response): no agreement line at all', async () => {
  await mount(null);
  expect(screen.queryByTestId('proposal-agreement-status')).not.toBeInTheDocument();
  expect(screen.queryByText(/Agreement/)).not.toBeInTheDocument();
});

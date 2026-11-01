// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CommercialProposalPage from './CommercialProposalPage';

// Proposal readiness (owner 2026-11-01): GET /admin/estimates/:id/proposal carries `firstVisit` only with
// GATE_COMMERCIAL_FIRST_VISIT on and `commercialAgreement` only with GATE_COMMERCIAL_PROPOSAL_SIGN on. The builder's
// Readiness card says what online signing and the first visit will do for this proposal, and why not; with neither
// key there is no card. Staff copy only: the customer page is unchanged.
const makeFixture = ({ commercialAgreement, firstVisit } = {}) => ({
  bidToolsEnabled: false,
  suggestedTaxRate: 0,
  estimate: { id: 'synthetic-proposal', status: 'sent', editVersion: 'v1', customerName: 'Synthetic Office', sentAt: '2026-10-20T15:00:00.000Z' },
  proposal: { enabled: true, title: 'Synthetic proposal', taxRate: 0, buildings: [{ name: 'Office', lineItems: [{ description: 'Monthly service', quantity: 1, unitPrice: 100, frequency: 'monthly', taxable: false }] }] },
  ...(commercialAgreement ? { commercialAgreement } : {}),
  ...(firstVisit ? { firstVisit } : {}),
});
let fixture;
beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'synthetic-token');
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => structuredClone(fixture), clone() { return this; },
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const mount = async (keys) => {
  fixture = makeFixture(keys);
  render(<MemoryRouter initialEntries={['/estimates/synthetic-proposal/proposal']}><Routes><Route path="/estimates/:estimateId/proposal" element={<CommercialProposalPage />} /></Routes></MemoryRouter>);
  await screen.findByDisplayValue('Synthetic proposal');
};
const firstVisitLine = () => screen.getByTestId('proposal-first-visit');

it('online: the customer books the first visit after signing', async () => {
  await mount({ firstVisit: { state: 'online' } });
  expect(firstVisitLine()).toHaveTextContent('The customer books it online after signing.');
});

it('booked: the line names the visit day from its date-only value (no time-zone shift)', async () => {
  await mount({ firstVisit: { state: 'booked', visit: { date: '2026-11-12', windowStart: '09:00', windowEnd: '10:00' } } });
  expect(firstVisitLine()).toHaveTextContent('Booked for Thu, Nov 12, 2026');
});

it.each([
  ['itemization', 'Online booking needs service programs only, with no building line items or one-time work.'],
  ['address', "The customer's address on file differs from the proposal's address."],
  ['tax', 'The tax on a visit bill would not match the quote, or could not be checked.'],
  ['no_customer', 'Link a customer account first.'],
  ['changed_since_signing', 'The proposal changed after the customer signed.'],
])('office (%s): the line says the office books it, and why', async (reason, why) => {
  await mount({ firstVisit: { state: 'office', reason } });
  expect(firstVisitLine()).toHaveTextContent(`The office books it. ${why}`);
});

it('a reason this page does not know still says the office books it', async () => {
  await mount({ firstVisit: { state: 'office', reason: 'synthetic_new_reason' } });
  expect(firstVisitLine().textContent).toBe('The office books it.');
});

it('a failed read: the line says it could not check', async () => {
  await mount({ firstVisit: { state: 'unknown' } });
  expect(firstVisitLine()).toHaveTextContent('Could not check right now.');
});

it('signing blocked for a reason the server names: the signing line shows the server note', async () => {
  const note = 'Online signing needs a linked customer account. Until then the page asks the customer to call.';
  await mount({ commercialAgreement: { state: 'none', signingBlocked: 'no_account', note }, firstVisit: { state: 'office', reason: 'no_customer' } });
  expect(screen.getByTestId('proposal-readiness')).toBeInTheDocument();
  expect(screen.getByTestId('proposal-agreement-status')).toHaveTextContent(note);
});

it('signing ready and not started: the line says the customer can sign', async () => {
  await mount({ commercialAgreement: { state: 'none' } });
  expect(screen.getByTestId('proposal-agreement-status')).toHaveTextContent('Ready: the customer can sign on the proposal page.');
  expect(screen.queryByTestId('proposal-first-visit')).not.toBeInTheDocument();
});

it('both gates off (neither key): no Readiness card', async () => {
  await mount({});
  expect(screen.queryByTestId('proposal-readiness')).not.toBeInTheDocument();
  expect(screen.queryByText('Readiness')).not.toBeInTheDocument();
});

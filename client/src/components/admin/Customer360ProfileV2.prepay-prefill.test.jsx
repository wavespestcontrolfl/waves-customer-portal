// @vitest-environment jsdom
// AnnualPrepayModal estimate prefill: the server's estimate-derived suggestion
// fills the amount ONLY when nothing agreed with the customer (term / prepaid
// plan / profile rate) suggests first, and the hint always names its source.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AnnualPrepayModal, estimateSuggestionMatchesService } from './Customer360ProfileV2';

afterEach(cleanup);

const BASE_CUSTOMER = {
  id: 'c-1',
  firstName: 'Pat',
  lastName: 'Sample',
  monthlyRate: 0,
  annualValue: 0,
};

const SUGGESTION = {
  estimateId: '5a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
  shortRef: '0B1C2D',
  status: 'viewed',
  amount: 384,
  baseAnnual: 384,
  discount: 0,
  serviceLabel: 'Quarterly Pest Control Service',
  coverageCadence: 'quarterly',
  coverageVisitCount: 4,
};

function renderModal(props = {}) {
  return render(
    <AnnualPrepayModal
      customer={BASE_CUSTOMER}
      activeTerm={null}
      prepaidPlans={[]}
      annualPrepayTerms={[]}
      onClose={() => {}}
      onSaved={() => {}}
      {...props}
    />,
  );
}

describe('estimateSuggestionMatchesService', () => {
  it('requires exact label identity (cadence words kept), cadence, and visit count', () => {
    expect(estimateSuggestionMatchesService(SUGGESTION, 'Quarterly Pest Control', 'quarterly', 4)).toBe(true);
    // Cadence is part of the identity — a monthly label, cadence, or count
    // never receives the quarterly quote.
    expect(estimateSuggestionMatchesService(SUGGESTION, 'Monthly Pest Control Plan', 'quarterly', 4)).toBe(false);
    expect(estimateSuggestionMatchesService(SUGGESTION, 'Quarterly Pest Control', 'monthly', 12)).toBe(false);
    expect(estimateSuggestionMatchesService(SUGGESTION, 'Quarterly Pest Control', 'quarterly', 6)).toBe(false);
    expect(estimateSuggestionMatchesService(SUGGESTION, 'Quarterly Mosquito Service', 'quarterly', 4)).toBe(false);
    // "Pest Control" must NOT match "Commercial Pest Control" on money.
    expect(estimateSuggestionMatchesService(SUGGESTION, 'Commercial Pest Control', 'quarterly', 4)).toBe(false);
    // Unlabeled or cadence-less suggestions fail closed.
    expect(estimateSuggestionMatchesService({ ...SUGGESTION, serviceLabel: '' }, 'Quarterly Pest Control', 'quarterly', 4)).toBe(false);
    expect(estimateSuggestionMatchesService({ ...SUGGESTION, coverageCadence: null }, 'Quarterly Pest Control', 'quarterly', 4)).toBe(false);
  });

  it('never matches blocked or zero-amount suggestions', () => {
    expect(estimateSuggestionMatchesService({ ...SUGGESTION, blocked: true }, 'Quarterly Pest Control', 'quarterly', 4)).toBe(false);
    expect(estimateSuggestionMatchesService({ ...SUGGESTION, amount: 0 }, 'Quarterly Pest Control', 'quarterly', 4)).toBe(false);
    expect(estimateSuggestionMatchesService(null, 'Quarterly Pest Control', 'quarterly', 4)).toBe(false);
  });
});

describe('AnnualPrepayModal estimate prefill', () => {
  it('prefills the amount from the estimate when the profile has no rate', () => {
    renderModal({ estimateSuggestion: SUGGESTION });
    expect(screen.getByText(/From estimate #0B1C2D/)).toBeInTheDocument();
    const amountInput = document.querySelector('input[type="number"][step="0.01"]');
    expect(amountInput).toHaveValue(384);
  });

  it('profile rate wins over the estimate suggestion', () => {
    renderModal({
      customer: { ...BASE_CUSTOMER, monthlyRate: 40 },
      estimateSuggestion: { ...SUGGESTION, amount: 384 },
    });
    const amountInput = document.querySelector('input[type="number"][step="0.01"]');
    expect(amountInput).toHaveValue(480);
  });

  it('blocked suggestion shows the reason and leaves the amount blank', () => {
    renderModal({
      estimateSuggestion: {
        estimateId: SUGGESTION.estimateId,
        shortRef: '0B1C2D',
        status: 'viewed',
        blocked: true,
        blockReason: 'estimate bundles multiple recurring services',
      },
    });
    expect(screen.getByText(/bundles multiple recurring services/)).toBeInTheDocument();
    const amountInput = document.querySelector('input[type="number"][step="0.01"]');
    expect(amountInput).toHaveValue(null);
  });

  it('clears an estimate-derived amount when the service changes away from the estimate', () => {
    renderModal({ estimateSuggestion: SUGGESTION });
    const amountInput = document.querySelector('input[type="number"][step="0.01"]');
    expect(amountInput).toHaveValue(384);
    const serviceInput = screen.getByPlaceholderText('Enter custom service label');
    fireEvent.change(serviceInput, { target: { value: 'Quarterly Mosquito Service' } });
    // Different service, no profile rate: the pest quote must NOT survive as
    // the mosquito amount.
    expect(amountInput).toHaveValue(null);
    expect(screen.queryByText(/From estimate/)).not.toBeInTheDocument();
    // Switching back to the estimate's service restores the prefill.
    fireEvent.change(serviceInput, { target: { value: 'Quarterly Pest Control' } });
    expect(amountInput).toHaveValue(384);
    expect(screen.getByText(/From estimate #0B1C2D/)).toBeInTheDocument();
  });

  it('clears an estimate-derived amount when the visit count changes away from the estimate', () => {
    renderModal({ estimateSuggestion: SUGGESTION });
    const amountInput = document.querySelector('input[type="number"][step="0.01"]');
    expect(amountInput).toHaveValue(384);
    const visitInput = document.querySelector('input[type="number"][step="1"]');
    fireEvent.change(visitInput, { target: { value: '6' } });
    // A 4-visit quote must not persist as a 6-visit term's amount.
    expect(amountInput).toHaveValue(null);
    expect(screen.queryByText(/From estimate/)).not.toBeInTheDocument();
    fireEvent.change(visitInput, { target: { value: '4' } });
    expect(amountInput).toHaveValue(384);
  });

  it('a manually selected cadence is never overridden by the label inference', () => {
    renderModal({ estimateSuggestion: SUGGESTION });
    const amountInput = document.querySelector('input[type="number"][step="0.01"]');
    expect(amountInput).toHaveValue(384);
    // Operator manually selects monthly — the quarterly quote must clear.
    const cadenceSelect = document.querySelectorAll('select')[1];
    fireEvent.change(cadenceSelect, { target: { value: 'monthly' } });
    expect(amountInput).toHaveValue(null);
    // Re-typing a "Quarterly" label must NOT restore the amount: the
    // submitted cadence is still the manually chosen monthly.
    const serviceInput = screen.getByPlaceholderText('Enter custom service label');
    fireEvent.change(serviceInput, { target: { value: 'Quarterly Pest Control' } });
    expect(amountInput).toHaveValue(null);
    expect(screen.queryByText(/From estimate/)).not.toBeInTheDocument();
  });

  it('renders exactly as before with no suggestion', () => {
    renderModal();
    expect(screen.queryByText(/From estimate/)).not.toBeInTheDocument();
    const amountInput = document.querySelector('input[type="number"][step="0.01"]');
    expect(amountInput).toHaveValue(null);
  });
});

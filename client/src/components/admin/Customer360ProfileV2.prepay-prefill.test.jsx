// @vitest-environment jsdom
// AnnualPrepayModal estimate prefill: the server's estimate-derived suggestion
// fills the amount ONLY when nothing agreed with the customer (term / prepaid
// plan / profile rate) suggests first, and the hint always names its source.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnualPrepayModal, AnnualPrepayInvoiceModal, estimateSuggestionMatchesService } from './Customer360ProfileV2';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => new Response(JSON.stringify(
    String(url).endsWith('/services/dropdown') ? [
      { id: 'svc-pest', name: 'Pest Control', base_price: 999 },
      { id: 'svc-lawn', name: 'Lawn Care', base_price: 999 },
      { id: 'svc-commercial', name: 'Commercial Pest Control', base_price: 999 },
    ] : {},
  ), { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
  it('requires cadence-neutral label identity plus cadence and visit-count agreement', () => {
    expect(estimateSuggestionMatchesService(SUGGESTION, 'Quarterly Pest Control', 'quarterly', 4)).toBe(true);
    // Estimate lines often store the plain service name — cadence words are
    // neutral in the LABEL because checks 2-3 enforce the schedule.
    expect(estimateSuggestionMatchesService({ ...SUGGESTION, serviceLabel: 'Pest Control' }, 'Quarterly Pest Control', 'quarterly', 4)).toBe(true);
    expect(estimateSuggestionMatchesService(SUGGESTION, 'Monthly Pest Control Plan', 'quarterly', 4)).toBe(true);
    // The SCHEDULE checks are what stop a cross-cadence money prefill.
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
    const serviceInput = screen.getByPlaceholderText('Search services or enter a custom label');
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
    const serviceInput = screen.getByPlaceholderText('Search services or enter a custom label');
    fireEvent.change(serviceInput, { target: { value: 'Quarterly Pest Control' } });
    expect(amountInput).toHaveValue(null);
    expect(screen.queryByText(/From estimate/)).not.toBeInTheDocument();
  });

  it('a cadence-neutral estimate label still prefills against the cadenced default', () => {
    renderModal({ estimateSuggestion: { ...SUGGESTION, serviceLabel: 'Pest Control' } });
    const amountInput = document.querySelector('input[type="number"][step="0.01"]');
    expect(amountInput).toHaveValue(384);
    expect(screen.getByText(/From estimate #0B1C2D/)).toBeInTheDocument();
  });

  it('seeds service, cadence, and visit count from a non-pest estimate for a brand-new customer', () => {
    renderModal({
      estimateSuggestion: {
        ...SUGGESTION,
        serviceLabel: 'Lawn Care Program',
        coverageCadence: 'every_6_weeks',
        coverageVisitCount: 9,
        amount: 810,
      },
    });
    const serviceInput = screen.getByPlaceholderText('Search services or enter a custom label');
    expect(serviceInput.value).toMatch(/Lawn Care/);
    const visitInput = document.querySelector('input[type="number"][step="1"]');
    expect(visitInput).toHaveValue(9);
    const amountInput = document.querySelector('input[type="number"][step="0.01"]');
    expect(amountInput).toHaveValue(810);
    expect(screen.getByText(/From estimate #0B1C2D/)).toBeInTheDocument();
  });

  it('renders exactly as before with no suggestion', () => {
    renderModal();
    expect(screen.queryByText(/From estimate/)).not.toBeInTheDocument();
    const amountInput = document.querySelector('input[type="number"][step="0.01"]');
    expect(amountInput).toHaveValue(null);
  });
});


describe.each([['Record', AnnualPrepayModal], ['Invoice', AnnualPrepayInvoiceModal]])('%s service selection', (_name, Modal) => {
  it('recognizes a cadence-prefixed saved plan and supports library search without taking catalog prices', async () => {
    render(<Modal customer={{ ...BASE_CUSTOMER, serviceTypes: 'Pest Control' }} activeTerm={null} />);
    const plan = screen.getByRole('combobox', { name: 'Service plan' });
    const covered = screen.getByRole('combobox', { name: 'Service covered' });
    expect(plan).toHaveValue('Pest Control');
    expect(covered).toHaveValue('Quarterly Pest Control');
    await waitFor(() => expect(within(plan).getByRole('option', { name: 'Lawn Care' })).toBeInTheDocument());
    expect([...covered.list.options].map((option) => option.value)).toContain('Lawn Care');
    fireEvent.change(covered, { target: { value: 'Lawn Care' } });
    expect(plan).toHaveValue('Lawn Care');
    expect(document.querySelector('input[type="number"][step="0.01"]')).toHaveValue(null);
    fireEvent.change(covered, { target: { value: 'Quarterly Commercial Pest Control' } });
    expect(plan).toHaveValue('Commercial Pest Control');
    fireEvent.change(plan, { target: { value: '__custom__' } });
    expect(covered).toHaveValue('');
    fireEvent.change(covered, { target: { value: 'Special coverage' } });
    expect(plan).toHaveValue('__custom__');
  });

  it.each([
    ['Every 2 months', 'bimonthly', 6],
    ['Every 4 months', 'triannual', 3],
    ['Every 6 weeks', 'every_6_weeks', 9],
  ])('recognizes %s without dropping service identity or schedule guards', async (prefix, cadence, visits) => {
    render(<Modal customer={{ ...BASE_CUSTOMER, serviceTypes: 'Pest Control' }} activeTerm={null} />);
    const plan = screen.getByRole('combobox', { name: 'Service plan' });
    const covered = screen.getByRole('combobox', { name: 'Service covered' });
    fireEvent.change(covered, { target: { value: `${prefix} Pest Control` } });
    expect(plan).toHaveValue('Pest Control');
    expect(screen.getByRole('combobox', { name: 'Cadence' })).toHaveValue(cadence);
    expect(screen.getByRole('spinbutton', { name: 'Applications covered' })).toHaveValue(visits);
    await waitFor(() => expect(within(plan).getByRole('option', { name: 'Commercial Pest Control' })).toBeInTheDocument());
    fireEvent.change(covered, { target: { value: `${prefix} Commercial Pest Control` } });
    expect(plan).toHaveValue('Commercial Pest Control');
    fireEvent.change(covered, { target: { value: `${prefix} Pest 2 Control` } });
    expect(plan).toHaveValue('__custom__');

    const suggestion = { ...SUGGESTION, serviceLabel: 'Pest Control', coverageCadence: cadence, coverageVisitCount: visits };
    expect(estimateSuggestionMatchesService(suggestion, `${prefix} Pest Control`, cadence, visits)).toBe(true);
    expect(estimateSuggestionMatchesService(suggestion, `${prefix} Pest Control`, 'monthly', visits)).toBe(false);
    expect(estimateSuggestionMatchesService(suggestion, `${prefix} Pest Control`, cadence, visits + 1)).toBe(false);
    expect(estimateSuggestionMatchesService(suggestion, `${prefix} Commercial Pest Control`, cadence, visits)).toBe(false);
  });

  it('keeps manual service entry available when the catalog fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    render(<Modal customer={BASE_CUSTOMER} activeTerm={null} />);
    await screen.findByText(/Service library unavailable/);
    const covered = screen.getByRole('combobox', { name: 'Service covered' });
    fireEvent.change(covered, { target: { value: 'Custom pest coverage' } });
    expect(covered).toHaveValue('Custom pest coverage');
  });
});

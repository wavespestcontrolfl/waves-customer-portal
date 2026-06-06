// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TerminalStateCard from '../components/estimate/TerminalStateCard';
import { EstimateAskBar, OneTimeBreakdownCard, ServiceSection, estimateAddServiceOffer, getServiceLabel } from './EstimateViewPage';

afterEach(() => cleanup());

describe('EstimateAskBar', () => {
  it('uses provided service-aware chips instead of the default prompts', () => {
    render(
      <EstimateAskBar
        token="test-token"
        askToken="ask-token"
        selectedFrequency="quarterly"
        chips={['What products do you use?', 'Are pets and kids safe?']}
      />,
    );

    expect(screen.getByRole('button', { name: 'What products do you use?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Are pets and kids safe?' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'What is included?' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ask Waves' })).toBeInTheDocument();
    expect(screen.getByLabelText('Ask Waves about this estimate')).toBeInTheDocument();
  });
});

describe('ServiceSection', () => {
  const baseFrequency = {
    key: 'standard',
    label: 'Standard',
    monthly: 50,
    annual: 600,
    included: [{ key: 'service', label: 'Recurring service' }],
    addOns: [{ key: 'interior_spray', label: 'Interior spraying', preChecked: true }],
  };

  it('hides the frequency slider when a section has one frequency', () => {
    render(
      <ServiceSection
        section={{
          key: 'pest_control',
          label: 'Pest Control',
          isRecurring: true,
          isPest: true,
          frequencies: [baseFrequency],
          copy: { priceWording: {} },
        }}
        selectedFrequencyKey="standard"
        selectedAddOns={new Set(['interior_spray'])}
        onFrequencyChange={vi.fn()}
        onAddOnToggle={vi.fn()}
        renderFlags={{ showPestRecurringAddOns: true, showWaveGuardTierUi: true }}
        waveGuardTier="Bronze"
      />,
    );

    expect(screen.queryByText('How often?')).not.toBeInTheDocument();
    expect(screen.getByText('Skip parts you don\'t need')).toBeInTheDocument();
  });

  it('does not render pest add-ons for non-pest sections', () => {
    render(
      <ServiceSection
        section={{
          key: 'lawn_care',
          label: 'Lawn Care',
          isRecurring: true,
          isPest: false,
          frequencies: [baseFrequency],
          copy: { priceWording: {} },
        }}
        selectedFrequencyKey="standard"
        selectedAddOns={new Set(['interior_spray'])}
        onFrequencyChange={vi.fn()}
        onAddOnToggle={vi.fn()}
        renderFlags={{ showPestRecurringAddOns: true, showWaveGuardTierUi: false }}
      />,
    );

    expect(screen.queryByText('Skip parts you don\'t need')).not.toBeInTheDocument();
  });

  it('renders pest add-ons for a pest-containing bundle section', () => {
    render(
      <ServiceSection
        section={{
          key: 'bundle',
          label: 'Recurring services',
          isRecurring: true,
          isPest: true,
          frequencies: [baseFrequency],
          copy: { priceWording: {} },
        }}
        selectedFrequencyKey="standard"
        selectedAddOns={new Set(['interior_spray'])}
        onFrequencyChange={vi.fn()}
        onAddOnToggle={vi.fn()}
        renderFlags={{ showPestRecurringAddOns: true, showWaveGuardTierUi: true }}
        waveGuardTier="Bronze"
      />,
    );

    expect(screen.getByText('Skip parts you don\'t need')).toBeInTheDocument();
  });

  it('shows tree and shrub service cadence without changing monthly billing copy', () => {
    render(
      <ServiceSection
        section={{
          key: 'tree_shrub',
          label: 'Tree & Shrub',
          isRecurring: true,
          isPest: false,
          frequencies: [{
            key: 'standard',
            label: 'Bi-monthly',
            serviceCategory: 'tree_shrub',
            monthly: 72,
            annual: 864,
            billingFrequencyKey: 'monthly',
            included: [{ key: 'tree_shrub_standard', label: 'Bi-monthly tree & shrub program' }],
          }],
          copy: { priceWording: {} },
        }}
        selectedFrequencyKey="standard"
        selectedAddOns={new Set()}
        onFrequencyChange={vi.fn()}
        onAddOnToggle={vi.fn()}
        renderFlags={{ showPestRecurringAddOns: true, showWaveGuardTierUi: false }}
      />,
    );

    expect(screen.getByText('$72')).toBeInTheDocument();
    expect(screen.getByText('/mo')).toBeInTheDocument();
    expect(screen.getByText('Service visits: Bi-monthly')).toBeInTheDocument();
    expect(screen.queryByText('/bi-monthly')).not.toBeInTheDocument();
  });

  it('shows the selected quote-required frequency reason', () => {
    render(
      <ServiceSection
        section={{
          key: 'commercial_pest',
          label: 'Commercial Pest Control',
          isRecurring: true,
          isPest: false,
          frequencies: [{
            key: 'manual',
            label: 'Manual quote',
            monthly: null,
            annual: null,
            quoteRequired: true,
            customQuoteReason: 'Commercial pest requires manual quote or commercial pilot pricing.',
            included: [],
          }],
          copy: { priceWording: {} },
        }}
        selectedFrequencyKey="manual"
        selectedAddOns={new Set()}
        onFrequencyChange={vi.fn()}
        onAddOnToggle={vi.fn()}
        renderFlags={{ showPestRecurringAddOns: false, showWaveGuardTierUi: false }}
      />,
    );

    expect(screen.getByText('Quote required')).toBeInTheDocument();
    expect(screen.getByText('Commercial pest requires manual quote or commercial pilot pricing.')).toBeInTheDocument();
  });
});

describe('OneTimeBreakdownCard', () => {
  it('shows quote-required specialty reasons instead of only the blocked price', () => {
    render(
      <OneTimeBreakdownCard
        breakdown={{
          total: 0,
          items: [{
            service: 'flea_package',
            label: 'Flea Treatment Package',
            amount: null,
            kind: 'quote_required',
            quoteRequired: true,
            customQuoteReason: 'Exterior yard area exceeds automatic quote threshold.',
          }],
        }}
      />,
    );

    expect(screen.getByText('Flea Treatment Package')).toBeInTheDocument();
    expect(screen.getAllByText('Quote Required').length).toBeGreaterThan(0);
    expect(screen.getByText('Exterior yard area exceeds automatic quote threshold.')).toBeInTheDocument();
  });
});

describe('estimateAddServiceOffer', () => {
  it('uses member keys from collapsed bundle sections', () => {
    expect(estimateAddServiceOffer([{
      key: 'bundle',
      label: 'Recurring services',
      isRecurring: true,
      memberKeys: ['pest_control', 'lawn_care'],
      frequencies: [],
    }], 'recurring')).toEqual(expect.objectContaining({
      serviceKey: 'mosquito',
      label: 'Mosquito',
    }));
  });
});

describe('TerminalStateCard', () => {
  it('shows the quote-required reason in the blocked React estimate state', () => {
    render(
      <TerminalStateCard
        state="quote_required"
        customerFirstName="Pat"
        address="123 Main St"
        quoteReason="SEVERE_INFESTATION"
      />,
    );

    expect(screen.getByText('This treatment needs an inspection.')).toBeInTheDocument();
    expect(screen.getByText('Severe infestation')).toBeInTheDocument();
  });
});

describe('getServiceLabel', () => {
  it('uses tree and shrub cadence labels instead of pest control copy', () => {
    expect(getServiceLabel(
      { key: 'standard', label: 'Bi-monthly', serviceCategory: 'tree_shrub' },
      {},
      { services: [{ key: 'tree_shrub', label: 'Tree & Shrub', isRecurring: true }] },
    )).toBe('Bi-monthly Tree & Shrub');
  });

  it('keeps pest control cadence copy for pest estimates', () => {
    expect(getServiceLabel(
      { key: 'quarterly', label: 'Quarterly' },
      {},
      { services: [{ key: 'pest_control', label: 'Pest Control', isRecurring: true }] },
    )).toBe('Quarterly Pest Control');
  });

  it('uses the estimate service in one-time choice labels', () => {
    expect(getServiceLabel(
      { key: 'seasonal9', label: 'Seasonal', serviceCategory: 'mosquito' },
      { showOneTimeOption: true },
      {
        anchorOneTimePrice: 275,
        services: [{ key: 'mosquito', label: 'Mosquito Control', isRecurring: true }],
      },
    )).toBe('Seasonal Mosquito Control or One-Time Mosquito Control');
  });
});

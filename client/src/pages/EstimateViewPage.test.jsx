// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TerminalStateCard from '../components/estimate/TerminalStateCard';
import { EstimateAskBar, OneTimeBreakdownCard, ServiceSection, estimateAddServiceOffer, getServiceLabel, oneTimePriceCopy } from './EstimateViewPage';

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

describe('oneTimePriceCopy', () => {
  it('returns Bora-Care wood-treatment copy without the pest callback line', () => {
    const copy = oneTimePriceCopy({ total: 1051, items: [{ service: 'bora_care', label: 'Bora-Care', amount: 1051 }] });
    expect(copy).toMatch(/borate wood treatment/i);
    expect(copy).toMatch(/wood-boring beetles|wood-decay fungi|termites/);
    // The SSR Bora-Care path renders no pest callback/guarantee; the React path
    // must match instead of falling through to the default pest copy.
    expect(copy).not.toMatch(/30-day callback period if pests return/);
  });

  it('detects a Bora-Care row labeled only with the raw service key', () => {
    const copy = oneTimePriceCopy({ total: 900, items: [{ service: 'bora_care', amount: 900 }] });
    expect(copy).toMatch(/borate wood treatment/i);
    expect(copy).not.toMatch(/30-day callback period if pests return/);
  });

  it('keeps the default pest callback copy for a generic one-time pest visit', () => {
    const copy = oneTimePriceCopy({ total: 250, items: [{ service: 'one_time_pest', label: 'One-Time Pest Control', amount: 250 }] });
    expect(copy).toMatch(/30-day callback period if pests return/);
  });

  it('keeps Bora-Care-only copy when the only other row is a non-billable discount', () => {
    const copy = oneTimePriceCopy({
      total: 893.35,
      items: [
        { service: 'bora_care', label: 'Bora-Care', amount: 1051 },
        { service: 'one_time_adjustment', label: 'WaveGuard Member Discount', amount: -157.65 },
      ],
    });
    expect(copy).toMatch(/borate wood treatment/i);
    expect(copy).not.toMatch(/30-day callback period if pests return/);
  });

  it('falls back to the default copy when Bora-Care is mixed with another positive billable row', () => {
    // Mirrors the server hasOnlyBoraCareServiceMix: a positive unknown charge
    // blocks the Bora-Care-only classification, so the callback copy stays.
    const copy = oneTimePriceCopy({
      total: 1251,
      items: [
        { service: 'bora_care', label: 'Bora-Care', amount: 1051 },
        { service: 'one_time_adjustment', label: 'Additional treatment area', amount: 200 },
      ],
    });
    expect(copy).toMatch(/30-day callback period if pests return/);
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

  it('renders formal-proposal copy (PDF emailed) instead of the inspection state', () => {
    render(
      <TerminalStateCard
        state="quote_required"
        customerFirstName="Pat"
        address="123 Main St"
        quoteReason="commercial_proposal"
        isProposal
        proposalPdfEmailed
      />,
    );

    expect(screen.getByText('Your formal proposal is ready.')).toBeInTheDocument();
    expect(screen.queryByText('This treatment needs an inspection.')).not.toBeInTheDocument();
    // proposal copy describes the emailed PDF + account-manager follow-up...
    expect(screen.getByText(/attached as a PDF to the email/i)).toBeInTheDocument();
    // ...and never surfaces the raw "commercial_proposal" token as a reason badge
    expect(screen.queryByText('Commercial proposal')).not.toBeInTheDocument();
  });

  it('does not promise an emailed PDF for an SMS-only proposal send', () => {
    render(
      <TerminalStateCard
        state="quote_required"
        customerFirstName="Pat"
        address="123 Main St"
        quoteReason="commercial_proposal"
        isProposal
        proposalPdfEmailed={false}
      />,
    );

    expect(screen.getByText('Your formal proposal is ready.')).toBeInTheDocument();
    expect(screen.queryByText(/attached as a PDF to the email/i)).not.toBeInTheDocument();
    expect(screen.getByText(/account manager has your formal proposal/i)).toBeInTheDocument();
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

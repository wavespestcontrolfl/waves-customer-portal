// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TerminalStateCard from '../components/estimate/TerminalStateCard';
import { CombinedRecurringPriceCard, EstimateAskBar, OneTimeBreakdownCard, ReviewPhase, ServiceSection, estimateAddServiceOffer, getServiceLabel, oneTimePriceCopy } from './EstimateViewPage';

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
    // The "Service visits: …" cadence line was removed per owner directive.
    expect(screen.queryByText(/Service visits:/)).not.toBeInTheDocument();
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

  it('returns no-visit renewal copy for a guarantee-only estimate (no "One visit" contradiction)', () => {
    // The invoice_only acceptance card says "No appointment needed" — the
    // price copy above it must not promise a service visit.
    const copy = oneTimePriceCopy({ total: 199, items: [{ service: 'rodent_guarantee', label: 'Rodent Guarantee', amount: 199 }] });
    expect(copy).toMatch(/no service visit to schedule/i);
    expect(copy).not.toMatch(/One visit, pay on service day/);
    expect(copy).not.toMatch(/30-day callback period if pests return/);
  });

  it('keeps guarantee renewal copy when the only other row is a discount', () => {
    const copy = oneTimePriceCopy({
      total: 179,
      items: [
        { service: 'rodent_guarantee', label: 'Rodent Guarantee', amount: 199 },
        { service: 'manual_discount', label: 'Manual discount', amount: -20 },
      ],
    });
    expect(copy).toMatch(/no service visit to schedule/i);
  });

  it('falls back to the default visit copy when the guarantee is bundled with real work', () => {
    const copy = oneTimePriceCopy({
      total: 349,
      items: [
        { service: 'rodent_guarantee', label: 'Rodent Guarantee', amount: 199 },
        { service: 'one_time_pest', label: 'One-Time Pest Control', amount: 150 },
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
  it('shows the booked visit date on an accepted estimate instead of follow-up copy', () => {
    render(
      <TerminalStateCard
        state="accepted"
        customerFirstName="William"
        address="10225 Kalamazoo Pl"
        appointmentLabel="Thursday, July 9 · 9:00–10:00 AM"
        appointmentServiceType="Quarterly Pest Control"
      />,
    );

    expect(screen.getByText(/you're booked/)).toBeInTheDocument();
    expect(screen.getByText('Thursday, July 9 · 9:00–10:00 AM')).toBeInTheDocument();
    expect(screen.getByText('Quarterly Pest Control')).toBeInTheDocument();
    expect(screen.queryByText(/Our team will follow up/)).not.toBeInTheDocument();
  });

  it('keeps the follow-up copy on an accepted estimate with no upcoming visit', () => {
    render(
      <TerminalStateCard state="accepted" customerFirstName="William" address="10225 Kalamazoo Pl" />,
    );

    expect(screen.getByText(/Our team will follow up/)).toBeInTheDocument();
  });

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

  it('renders account-manager copy for a commercial risk-type hold, not the inspection state', () => {
    render(
      <TerminalStateCard
        state="quote_required"
        customerFirstName="Pat"
        address="123 Main St"
        quoteReason="commercial_risk_type_review"
      />,
    );

    expect(screen.getByText('Your account manager will finalize this.')).toBeInTheDocument();
    expect(screen.queryByText('This treatment needs an inspection.')).not.toBeInTheDocument();
    expect(screen.getByText(/commercial service plan/i)).toBeInTheDocument();
    // never surfaces the raw internal token as a reason badge
    expect(screen.queryByText('Commercial risk type review')).not.toBeInTheDocument();
  });

  it('renders site-confirmation copy for a commercial low-confidence hold', () => {
    render(
      <TerminalStateCard
        state="quote_required"
        customerFirstName="Pat"
        address="123 Main St"
        quoteReason="commercial_low_confidence_site_confirmation"
      />,
    );

    expect(screen.getByText('Your account manager will finalize this.')).toBeInTheDocument();
    expect(screen.queryByText('This treatment needs an inspection.')).not.toBeInTheDocument();
    expect(screen.getByText(/quick site confirmation/i)).toBeInTheDocument();
    expect(screen.queryByText('Commercial low confidence site confirmation')).not.toBeInTheDocument();
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

  it('excludes fee/review rows from the one-time eyebrow', () => {
    expect(getServiceLabel(null, { isOneTimeOnly: true }, {
      oneTimeBreakdown: {
        items: [
          { label: 'German Roach Cleanout', amount: 350 },
          { label: 'WDO Inspection', amount: 150 },
          { label: 'WaveGuard Setup', amount: 99 },
          { label: 'Prepay credit', amount: 0 },
        ],
      },
    })).toBe('German Roach Cleanout');
  });

  it('falls back to non-billable row labels when nothing billable remains', () => {
    expect(getServiceLabel(null, { isOneTimeOnly: true }, {
      oneTimeBreakdown: {
        items: [{ label: 'WDO Inspection', amount: 150 }],
      },
    })).toBe('WDO Inspection');
  });
});

describe('CombinedRecurringPriceCard — low-confidence range tracks the SELECTED cadence', () => {
  // The uncertain LOW dollars are fixed ($400 × 20% = ±$80) while the exact part
  // moves with the selection — the band must NOT grow with the displayed total.
  const combined = {
    monthlySubtotal: 500,
    annualSubtotal: 6000,
    lowConfidenceRangePct: 0.2,
    lowConfidenceFraction: 0.8, // stale default-subtotal fraction (400/500)
    lowConfidenceMonthly: 400,
  };

  it('bands only the LOW dollars when another cadence changes the displayed total', () => {
    // Selected combined cadence $600/mo: ±$80 → $520–$680 (NOT the stale
    // fraction's 600×0.8×0.2 = ±$96 → $504–$696).
    render(
      <CombinedRecurringPriceCard
        combined={combined}
        selectedFrequency={{ key: 'alt', monthly: 600, annual: 7200 }}
      />,
    );
    expect(screen.getByText(/\$520–\$680/)).toBeInTheDocument();
    expect(screen.queryByText(/\$504–\$696/)).not.toBeInTheDocument();
  });

  it('default selection still bands the LOW share of the subtotal', () => {
    render(<CombinedRecurringPriceCard combined={combined} selectedFrequency={null} />);
    // $500/mo, ±$80 → $420–$580
    expect(screen.getByText(/\$420–\$580/)).toBeInTheDocument();
  });

  it('falls back to the stamped fraction when raw LOW dollars are absent (older payloads)', () => {
    const { lowConfidenceMonthly, ...withoutRaw } = combined;
    render(<CombinedRecurringPriceCard combined={withoutRaw} selectedFrequency={{ key: 'alt', monthly: 600 }} />);
    // stamped 0.8 against $600 → ±$96 → $504–$696
    expect(screen.getByText(/\$504–\$696/)).toBeInTheDocument();
  });
});

describe('ReviewPhase — site-confirmation hold copy', () => {
  const noop = () => {};

  it('held no-slot accept: no invoice-due promise, manual scheduling line, approve CTA', () => {
    render(
      <ReviewPhase
        slotId={null}
        existingAppointment={null}
        paymentPreference="pay_at_visit"
        secondsRemaining={600}
        onConfirm={noop}
        onCancel={noop}
        invoiceMode
        siteConfirmationHold
        manualScheduling
        serviceMode="recurring"
        depositNote={null}
      />,
    );
    expect(screen.getByText('No payment now — price confirmed on site')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve estimate' })).toBeInTheDocument();
    expect(screen.getByText(/a Waves team member will reach out to set up your visit/i)).toBeInTheDocument();
    expect(screen.getByText(/confirms the exact price on a quick site visit, then sends your first invoice/i)).toBeInTheDocument();
    expect(screen.queryByText('Invoice due now')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Slot:/)).not.toBeInTheDocument();
  });

  it('held accept on an existing appointment: approval copy, no "creates your invoice" promise', () => {
    render(
      <ReviewPhase
        slotId={null}
        existingAppointment={{ id: 'ss1', scheduledDate: '2026-07-10', windowDisplay: '8–10 AM' }}
        paymentPreference="pay_at_visit"
        secondsRemaining={600}
        onConfirm={noop}
        onCancel={noop}
        invoiceMode
        siteConfirmationHold
        serviceMode="recurring"
        depositNote={null}
      />,
    );
    expect(screen.getByRole('button', { name: 'Confirm approval' })).toBeInTheDocument();
    expect(screen.getByText(/No payment needed now — we confirm your exact price on a quick site visit/i)).toBeInTheDocument();
    expect(screen.queryByText(/Next step creates your invoice/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Invoice due now')).not.toBeInTheDocument();
  });

  it('non-invoice held estimate with an existing appointment: no "creates your invoice" promise either', () => {
    // The server holds first invoices for narrow low-confidence recurring
    // accepts regardless of bill_by_invoice — the review copy must not be
    // invoice-mode-gated.
    render(
      <ReviewPhase
        slotId={null}
        existingAppointment={{ id: 'ss1', scheduledDate: '2026-07-10', windowDisplay: '8–10 AM' }}
        paymentPreference="pay_at_visit"
        secondsRemaining={600}
        onConfirm={noop}
        onCancel={noop}
        invoiceMode={false}
        siteConfirmationHold
        serviceMode="recurring"
        depositNote={null}
      />,
    );
    expect(screen.getByRole('button', { name: 'Confirm approval' })).toBeInTheDocument();
    expect(screen.getByText('No payment now — price confirmed on site')).toBeInTheDocument();
    expect(screen.queryByText(/Next step creates your invoice/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm invoice' })).not.toBeInTheDocument();
  });

  it('a one-time accept keeps its own copy even when the estimate carries the hold flag', () => {
    render(
      <ReviewPhase
        slotId="slot-1"
        existingAppointment={null}
        paymentPreference="pay_at_visit"
        secondsRemaining={600}
        onConfirm={noop}
        onCancel={noop}
        invoiceMode
        siteConfirmationHold
        serviceMode="one_time"
        depositNote={null}
      />,
    );
    expect(screen.getByText('Invoice due now')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm booking' })).toBeInTheDocument();
  });

  it('non-held invoice-mode copy is unchanged', () => {
    render(
      <ReviewPhase
        slotId="slot-1"
        existingAppointment={null}
        paymentPreference="pay_at_visit"
        secondsRemaining={600}
        onConfirm={noop}
        onCancel={noop}
        invoiceMode
        serviceMode="recurring"
        depositNote={null}
      />,
    );
    expect(screen.getByText('Invoice due now')).toBeInTheDocument();
    expect(screen.getByText(/Slot: slot-1/)).toBeInTheDocument();
  });
});

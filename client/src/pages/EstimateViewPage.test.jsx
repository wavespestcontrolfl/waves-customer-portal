// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TerminalStateCard from '../components/estimate/TerminalStateCard';
import { CombinedRecurringPriceCard, EstimateAskBar, OneTimeBreakdownCard, PlanTotalSummary, ReviewPhase, ServiceSection, SuccessCard, estimateAddServiceOffer, getServiceLabel, oneTimeExtrasForPaymentNote, oneTimePriceCopy, oneTimeRowIdentityKey, reportShowcaseVariantForServices } from './EstimateViewPage';

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

  it('leads with the per-application price on a lawn section (every service bills per application)', () => {
    // Shaped like a server lawn-ladder entry: monthlyBase is the pre-discount
    // anchor, perTreatment/displayPrice the net per-application price.
    render(
      <ServiceSection
        section={{
          key: 'lawn_care',
          label: 'Lawn Care',
          isRecurring: true,
          isPest: false,
          frequencies: [{
            key: 'premium',
            label: 'Monthly',
            serviceCategory: 'lawn_care',
            monthlyBase: 79,
            monthly: 71.1,
            annual: 853.2,
            perTreatment: 71.1,
            visitsPerYear: 12,
            billingFrequencyKey: 'monthly',
            included: [{ key: 'lawn_care_premium', label: 'Monthly lawn care program' }],
            perServiceTreatments: [{
              service: 'lawn_care',
              label: 'Lawn Care',
              perTreatment: 71.1,
              displayPrice: 71.1,
              visitsPerYear: 12,
            }],
          }],
          copy: { priceWording: {} },
        }}
        selectedFrequencyKey="premium"
        selectedAddOns={new Set()}
        onFrequencyChange={vi.fn()}
        onAddOnToggle={vi.fn()}
        renderFlags={{ showPestRecurringAddOns: false, showWaveGuardTierUi: false }}
      />,
    );

    // Net per-application headline with the struck pre-discount anchor —
    // never a /mo rate. (The treatment row restates the price, hence AllBy.)
    expect(screen.getAllByText('$71.10').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('$79 / application')).toBeInTheDocument();
    expect(screen.queryByText('/mo')).not.toBeInTheDocument();
    expect(screen.getByText(/12 applications per year included/)).toBeInTheDocument();
  });

  it('keeps the combined /mo total on a bundle section with a single itemized service (no per-application headline)', () => {
    // Synthetic unsplittable bundle (pest + lawn) whose legacy snapshot
    // itemizes only the pest slice as a treatment row. The card must lead with
    // the combined recurring total ($130/mo), NOT the lone pest per-application
    // price ($94) — accept/billing charges the bundle total.
    render(
      <ServiceSection
        section={{
          key: 'bundle',
          label: 'Recurring services',
          isRecurring: true,
          isPest: true,
          memberKeys: ['pest_control', 'lawn_care'],
          frequencies: [{
            key: 'monthly',
            label: 'Monthly',
            monthly: 130,
            annual: 1560,
            perServiceTreatments: [{
              service: 'pest_control',
              label: 'Pest Control',
              perTreatment: 94,
              displayPrice: 94,
              visitsPerYear: 6,
            }],
            included: [{ key: 'bundle', label: 'Recurring services' }],
          }],
          copy: { priceWording: {} },
        }}
        selectedFrequencyKey="monthly"
        selectedAddOns={new Set()}
        onFrequencyChange={vi.fn()}
        onAddOnToggle={vi.fn()}
        renderFlags={{ showPestRecurringAddOns: false, showWaveGuardTierUi: false }}
      />,
    );

    // Combined cadence total leads with a standalone "/mo" suffix. Were the
    // bundle wrongly treated per-application, the headline would be the lone
    // pest price ("/ application" suffix) plus a "Billed $130/mo, spread across
    // the year" note — so the note's absence is the real discriminator.
    expect(screen.getByText('$130')).toBeInTheDocument();
    expect(screen.getByText('/mo')).toBeInTheDocument();
    expect(screen.queryByText(/spread across the year/)).not.toBeInTheDocument();
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

  it('marks a prepay-waivable WaveGuard setup row with an asterisk and waiver note', () => {
    render(
      <OneTimeBreakdownCard
        breakdown={{
          total: 99,
          items: [{ service: 'waveguard_setup', label: 'WaveGuard setup', detail: 'Membership setup fee', amount: 99, kind: 'charge' }],
        }}
        prepayWaivedServices={['waveguard_setup']}
      />,
    );

    expect(screen.getByText((_, el) => el?.textContent === '$99*' && el?.children.length === 0)).toBeInTheDocument();
    expect(screen.getByText(/waived when you pay the year in full/i)).toBeInTheDocument();
  });

  it('matches legacy label-only setup rows that carry no service key', () => {
    render(
      <OneTimeBreakdownCard
        breakdown={{
          total: 99,
          items: [{ label: 'WaveGuard Membership Setup', amount: 99, kind: 'charge' }],
        }}
        prepayWaivedServices={['waveguard_setup']}
      />,
    );

    expect(screen.getByText(/waived when you pay the year in full/i)).toBeInTheDocument();
  });

  it('shows no waiver note when the fee is not prepay-waivable', () => {
    render(
      <OneTimeBreakdownCard
        breakdown={{
          total: 99,
          items: [{ service: 'waveguard_setup', label: 'WaveGuard setup', detail: 'Membership setup fee', amount: 99, kind: 'charge' }],
        }}
      />,
    );

    expect(screen.queryByText(/waived/i)).not.toBeInTheDocument();
    // Both the row amount and the one-time total render plain $99 — no asterisk.
    expect(screen.getAllByText('$99').length).toBe(2);
    expect(screen.queryByText((_, el) => el?.textContent === '$99*' && el?.children.length === 0)).not.toBeInTheDocument();
  });

  it('excludes serviceless embedded rows by identity key so they never total twice', () => {
    // Older termite install rows carry no `service` — they normalize into the
    // termite section by LABEL and render embedded there. The standalone card
    // must drop them via oneTimeRowIdentityKey, not a truthy `service` match.
    const legacyInstall = { label: 'Advance Installation', amount: 639, detail: '23 stations' };
    const { container } = render(
      <OneTimeBreakdownCard
        breakdown={{ total: 639, items: [legacyInstall] }}
        excludeServices={[oneTimeRowIdentityKey(legacyInstall)]}
      />,
    );
    // Nothing left to show — the card renders null instead of re-totaling.
    expect(container).toBeEmptyDOMElement();
  });

  it('still excludes service-keyed embedded rows passed as identity keys', () => {
    const keyedRow = { service: 'termite_bait_installation', label: 'Advance Installation', amount: 639 };
    const { container } = render(
      <OneTimeBreakdownCard
        breakdown={{ total: 639, items: [keyedRow] }}
        excludeServices={[oneTimeRowIdentityKey(keyedRow)]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps a quote-required sibling that shares a service with an embedded priced row', () => {
    // Same `service` on both rows: the priced one renders embedded (and is
    // excluded here); the quote-required one never embeds and MUST stay in
    // this card with its Quote Required row — a service-only identity would
    // drop both.
    const pricedEmbedded = { service: 'flea_package', label: 'Flea Treatment', amount: 250 };
    const quoteSibling = { service: 'flea_package', label: 'Flea Treatment — Detached Guest House', amount: null, kind: 'quote_required', quoteRequired: true };
    render(
      <OneTimeBreakdownCard
        breakdown={{ total: 250, items: [pricedEmbedded, quoteSibling] }}
        excludeServices={[oneTimeRowIdentityKey(pricedEmbedded)]}
      />,
    );
    expect(screen.getByText('Flea Treatment — Detached Guest House')).toBeInTheDocument();
    expect(screen.getAllByText('Quote Required').length).toBeGreaterThan(0);
    expect(screen.queryByText((_, el) => el?.textContent === '$250' && el?.children.length === 0)).not.toBeInTheDocument();
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

describe('reportShowcaseVariantForServices', () => {
  it('shows the lawn report on a lawn-only estimate', () => {
    expect(reportShowcaseVariantForServices([
      { key: 'lawn_care', label: 'Lawn Care', isRecurring: true },
    ])).toBe('lawn');
  });

  it('ignores "pest" in lawn marketing copy — included lines never flip the variant', () => {
    // Real lawn payloads include "Chinch, sod webworm & turf pest response";
    // only structural identity (key/memberKeys/isPest/serviceCategory) may
    // decide the variant, never copy text.
    expect(reportShowcaseVariantForServices([{
      key: 'lawn_care',
      label: 'Lawn Care',
      isRecurring: true,
      isPest: false,
      frequencies: [{
        key: 'standard',
        serviceCategory: 'lawn_care',
        included: [
          { key: 'fert', label: 'Fertilization + weed control' },
          { key: 'pests', label: 'Chinch, sod webworm & turf pest response' },
        ],
      }],
    }])).toBe('lawn');
  });

  it('keeps the pest report when pest control is in the mix', () => {
    expect(reportShowcaseVariantForServices([{
      key: 'bundle',
      label: 'Recurring services',
      isRecurring: true,
      memberKeys: ['pest_control', 'lawn_care'],
      frequencies: [],
    }])).toBe('pest');
  });

  it('keeps the pest report for lawn + mosquito', () => {
    expect(reportShowcaseVariantForServices([
      { key: 'lawn_care', label: 'Lawn Care', isRecurring: true },
      { key: 'mosquito', label: 'Mosquito', isRecurring: true },
    ])).toBe('pest');
  });

  it('defaults to the pest report with no services', () => {
    expect(reportShowcaseVariantForServices([])).toBe('pest');
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

  it('pins the label to an accepted one-time booking on a mixed estimate', () => {
    expect(getServiceLabel(
      { key: 'quarterly', label: 'Quarterly' },
      { showOneTimeOption: true },
      {
        anchorOneTimePrice: 202,
        services: [{ key: 'pest_control', label: 'Pest Control', isRecurring: true }],
      },
      'one_time',
    )).toBe('One-Time Pest Control');
  });

  it('drops the one-time choice suffix once a recurring plan is accepted', () => {
    expect(getServiceLabel(
      { key: 'quarterly', label: 'Quarterly' },
      { showOneTimeOption: true },
      {
        anchorOneTimePrice: 202,
        services: [{ key: 'pest_control', label: 'Pest Control', isRecurring: true }],
      },
      'recurring',
    )).toBe('Quarterly Pest Control');
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

describe('PlanTotalSummary — plan-level referral credit + net', () => {
  const combined = {
    monthlySubtotal: 82,
    annualSubtotal: 984,
    waveGuardTierLabel: 'Silver',
    manualDiscount: { label: 'Referral Credit', type: 'FIXED', value: 25, amount: 25, recurringAmount: 25, monthlyAmount: 2.08 },
  };

  it('itemizes subtotal → credit → net as the per-service-sum minus the net', () => {
    // Per-service cards sum to $84.08/mo (pre-credit); combined net is $82/mo →
    // the credit shown is the exact difference ($2.08), and subtotal−credit=net.
    const { container } = render(<PlanTotalSummary combined={combined} preCreditMonthly={84.08} />);
    const text = container.textContent;
    expect(text).toContain('Plan subtotal');
    expect(text).toContain('$84.08');
    expect(text).toContain('Referral Credit');
    expect(text).toMatch(/[−-]\$2\.08/); // fmtMoneySigned uses a Unicode minus
    expect(text).toContain('Your price');
    expect(text).toContain('$82');
    expect(text).toContain('$984 / year');
  });

  it('renders nothing when there is no credit to itemize (unchanged no-referral plans)', () => {
    const { container } = render(<PlanTotalSummary combined={{ monthlySubtotal: 82, annualSubtotal: 984, waveGuardTierLabel: 'Silver' }} preCreditMonthly={84.08} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing without a combined payload', () => {
    const { container } = render(<PlanTotalSummary combined={null} preCreditMonthly={84.08} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('tracks the SELECTED cadence — subtotal and net both follow the selection', () => {
    // Switched to a pricier cadence: per-service sum $112.08, net $110/mo. The
    // credit is the difference ($2.08) and everything follows the selection.
    const { container } = render(
      <PlanTotalSummary combined={combined} selectedFrequency={{ key: 'alt', monthly: 110, annual: 1320 }} preCreditMonthly={112.08} />,
    );
    const text = container.textContent;
    expect(text).toContain('$112.08');
    expect(text).toMatch(/[−-]\$2\.08/);
    expect(text).toContain('$110');
    expect(text).toContain('$1,320 / year');
    expect(text).not.toContain('$82');
  });

  it('shows the ACTUAL (capped) credit by construction, not a stale default amount', () => {
    // The selected cadence caps the credit so the net is higher ($83.50, only
    // $0.58 off the $84.08 sum). The difference shows the real $0.58 — never the
    // default $2.08 — so the on-screen math always reconciles.
    const text = render(
      <PlanTotalSummary combined={combined} selectedFrequency={{ key: 'alt', monthly: 83.50, annual: 1002 }} preCreditMonthly={84.08} />,
    ).container.textContent;
    expect(text).toMatch(/[−-]\$0\.58/);
    expect(text).not.toMatch(/[−-]\$2\.08/);
    expect(text).toContain('$83.50');
  });

  it('renders nothing when the per-service sum is missing or does not exceed the net', () => {
    // No reliable pre-credit basis → nothing to itemize (not ranged/quote-required).
    expect(render(<PlanTotalSummary combined={combined} />).container).toBeEmptyDOMElement();
    expect(render(<PlanTotalSummary combined={combined} preCreditMonthly={82} />).container).toBeEmptyDOMElement();
  });

  it('on a ranged low-confidence plan keeps the credit visible but no exact net', () => {
    const ranged = { ...combined, lowConfidenceRangePct: 0.2 };
    const text = render(<PlanTotalSummary combined={ranged} preCreditMonthly={84.08} />).container.textContent;
    expect(text).toContain('Referral Credit'); // credit stays visible…
    expect(text).toMatch(/[−-]\$2\.08/);
    expect(text).not.toContain('Your price'); // …but no exact subtotal/net
    expect(text).not.toContain('Plan subtotal');
    // Same when the range rides on the selected frequency.
    const text2 = render(
      <PlanTotalSummary combined={combined} selectedFrequency={{ key: 'alt', monthly: 110, lowConfidenceRangePct: 0.2 }} preCreditMonthly={112.08} />,
    ).container.textContent;
    expect(text2).toContain('Referral Credit');
    expect(text2).not.toContain('Your price');
  });

  it('suppresses for a quote-required selection (page hides exact dollars)', () => {
    const { container } = render(
      <PlanTotalSummary combined={combined} selectedFrequency={{ key: 'alt', quoteRequired: true }} preCreditMonthly={84.08} />,
    );
    expect(container).toBeEmptyDOMElement();
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

describe('SuccessCard — already-accepted retry', () => {
  it('does not promise a confirmation text when the accept was a retry of an already-accepted estimate', () => {
    // Server returns the full success payload with alreadyAccepted: true; with
    // no nextStep resolving, the generic card must not promise a text that
    // may never re-send.
    render(<SuccessCard acceptResult={{ success: true, alreadyAccepted: true }} />);

    expect(screen.getByText(/already accepted — you're all set/)).toBeInTheDocument();
    expect(screen.queryByText(/Check your phone for the confirmation text/)).not.toBeInTheDocument();
  });

  it('keeps the confirmation-text copy for a fresh accept', () => {
    render(<SuccessCard acceptResult={{ success: true }} />);

    expect(screen.getByText(/Check your phone for the confirmation text/)).toBeInTheDocument();
  });

  it('does not promise a booking-link text for an already-accepted one-time retry, but keeps the booking button', () => {
    // An already-accepted unbooked one-time retry returns book_one_time plus
    // a FRESH booking URL without re-sending the SMS — the on-screen button
    // is the real path, so the copy must not claim a text was sent.
    render(
      <SuccessCard
        acceptResult={{
          success: true,
          alreadyAccepted: true,
          nextStep: 'book_one_time',
          bookingUrl: 'https://book.example/one-time',
        }}
      />,
    );

    expect(screen.queryByText(/Check your phone/)).not.toBeInTheDocument();
    expect(screen.getByText(/already accepted — pick your appointment now/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pick appointment' })).toHaveAttribute('href', 'https://book.example/one-time');
  });

  it('keeps the booking-link text for a fresh one-time accept', () => {
    render(
      <SuccessCard
        acceptResult={{ success: true, nextStep: 'book_one_time', bookingUrl: 'https://book.example/one-time' }}
      />,
    );

    expect(screen.getByText(/Check your phone for the booking link/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pick appointment' })).toHaveAttribute('href', 'https://book.example/one-time');
  });

  it('routes an already-accepted retry to its nextStep card when one resolves', () => {
    render(
      <SuccessCard
        acceptResult={{
          success: true,
          alreadyAccepted: true,
          nextStep: 'pay_invoice',
          invoicePayUrl: 'https://pay.example/inv',
        }}
      />,
    );

    expect(screen.getByText(/Payment is optional right now/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Pay now and save card/ })).toHaveAttribute('href', 'https://pay.example/inv');
  });
});

describe('oneTimeExtrasForPaymentNote', () => {
  const pricing = {
    oneTimeBreakdown: {
      total: 348,
      items: [
        { service: 'flea_treatment', name: 'Flea treatment', price: 249 },
        { service: 'waveguard_setup', name: 'WaveGuard setup', price: 99, detail: 'Membership setup fee' },
      ],
    },
  };

  it('subtracts the WaveGuard setup row — PPB already previews it as its own invoice line', () => {
    expect(oneTimeExtrasForPaymentNote(pricing, {}, 'recurring')).toBe(249);
  });

  it('returns 0 when the setup fee is the only one-time row', () => {
    const setupOnly = {
      oneTimeBreakdown: {
        total: 99,
        items: [{ service: 'waveguard_setup', name: 'WaveGuard setup', price: 99 }],
      },
    };
    expect(oneTimeExtrasForPaymentNote(setupOnly, {}, 'recurring')).toBe(0);
  });

  it('matches setup rows by label when the service key is missing', () => {
    const labeled = {
      oneTimeBreakdown: {
        total: 149,
        items: [
          { name: 'Rodent exclusion', price: 50 },
          { label: 'WaveGuard Setup', price: 99 },
        ],
      },
    };
    expect(oneTimeExtrasForPaymentNote(labeled, {}, 'recurring')).toBe(50);
  });

  it('stays 0 for one-time mode and for either/or one-time alternatives', () => {
    expect(oneTimeExtrasForPaymentNote(pricing, {}, 'one_time')).toBe(0);
    expect(oneTimeExtrasForPaymentNote(pricing, { showOneTimeOption: true }, 'recurring')).toBe(0);
  });

  it('keeps the full total when no setup row is present', () => {
    const noSetup = {
      oneTimeBreakdown: {
        total: 249,
        items: [{ service: 'flea_treatment', name: 'Flea treatment', price: 249 }],
      },
    };
    expect(oneTimeExtrasForPaymentNote(noSetup, {}, 'recurring')).toBe(249);
  });
});

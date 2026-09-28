// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TerminalStateCard from '../components/estimate/TerminalStateCard';
import { setGlassDefault } from '../lib/estimate-glass-copy';
import WavesShell from '../components/brand/WavesShell';
import TrustFooter from '../components/brand/TrustFooter';
import EstimateViewPage, { CombinedRecurringPriceCard, ContactGapFields, EstimateAskBar, OneTimeBreakdownCard, OneTimePriceCard, OneTimeModeToggle, PlanTotalSummary, ReviewPhase, ServiceSection, SuccessCard, estimateAddServiceOffer, estimateHasRegulatedCertificateSurface, getServiceLabel, oneTimeExtrasForPaymentNote, oneTimePriceCopy, oneTimeRowIdentityKey, oneTimeToggleLabels, reportShowcaseVariantForServices } from './EstimateViewPage';
import oneTimeCopyModule from '../../../server/services/estimate-one-time-copy.js';

const { oneTimeOnlyIntelligenceCopy, resolveOneTimeServiceCopy } = oneTimeCopyModule;

const routerState = vi.hoisted(() => ({ token: 'mixed-termite-token' }));
vi.mock('react-router-dom', () => ({ useParams: () => ({ token: routerState.token }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

afterEach(() => {
  cleanup();
  routerState.token = 'mixed-termite-token';
  window.history.replaceState({}, '', '/');
  setGlassDefault(false);
  vi.unstubAllGlobals();
});

describe('regulated certificate estimate surfaces', () => {
  it('detects a pre-slab line inside a mixed pest estimate', () => {
    expect(estimateHasRegulatedCertificateSurface(
      'bundle',
      [{ key: 'pest_control', name: 'Pest Control' }],
      [{ service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment' }],
    )).toBe(true);
  });

  it('honors the server decision when the public breakdown no longer carries the regulated row', () => {
    // show_one_time_option alignment shape: category bundle, synthetic pest
    // choice row only — the WDO row is gone from the rows the client sees.
    const alignedRows = [{ service: 'one_time_pest', label: 'One-Time Pest Control' }];
    const pest = [{ key: 'pest_control', name: 'Pest Control' }];
    expect(estimateHasRegulatedCertificateSurface('bundle', pest, alignedRows)).toBe(false);
    expect(estimateHasRegulatedCertificateSurface('bundle', pest, alignedRows, true)).toBe(true);
  });
});

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

  it('uses guarantee-free approval microcopy when the server marks a mixed estimate noGuaranteeClaims', () => {
    const section = {
      key: 'pest_control',
      label: 'Pest Control',
      isRecurring: true,
      isPest: true,
      frequencies: [baseFrequency],
      copy: { priceWording: {} },
    };
    const props = {
      section,
      selectedFrequencyKey: 'standard',
      selectedAddOns: new Set(),
      onFrequencyChange: vi.fn(),
      onAddOnToggle: vi.fn(),
      renderFlags: { showPestRecurringAddOns: false, showWaveGuardTierUi: false },
      showGetServiceCta: true,
    };
    const { rerender } = render(<ServiceSection {...props} />);
    expect(screen.getByText(/money-back guarantee/i)).toBeInTheDocument();

    rerender(<ServiceSection {...props} noGuarantee />);
    expect(screen.queryByText(/money-back guarantee/i)).not.toBeInTheDocument();
    expect(screen.getByText(/licensed & insured · no pressure/i)).toBeInTheDocument();
  });

  it('a section states its own terms, while its approve line covers the whole estimate', () => {
    // Owner ruling 2026-09-27: the pest service keeps its own plan terms
    // beside rodent work; the approve line covers every service, so it
    // follows the estimate's scope.
    setGlassDefault(true);
    try {
      const section = {
        key: 'pest_control',
        label: 'Pest Control',
        isRecurring: true,
        isPest: true,
        termsScope: 'all',
        frequencies: [{
          ...baseFrequency,
          perServiceTreatments: [{ service: 'pest_control', label: 'Pest Control', displayPrice: 100, visitsPerYear: 4, termsScope: 'all' }],
        }],
        copy: { priceWording: {} },
      };
      const props = {
        selectedFrequencyKey: 'standard',
        selectedAddOns: new Set(),
        onFrequencyChange: vi.fn(),
        onAddOnToggle: vi.fn(),
        renderFlags: { showPestRecurringAddOns: false, showWaveGuardTierUi: false },
        showGetServiceCta: true,
      };
      const { rerender } = render(<ServiceSection {...props} section={section} guaranteeScope="satisfaction" />);
      fireEvent(window, new Event('beforeprint'));
      expect(screen.getByText(/unlimited free callbacks/i)).toBeInTheDocument();
      expect(screen.getByText(/^Licensed & insured · Satisfaction guaranteed · No pressure/)).toBeInTheDocument();

      rerender(<ServiceSection {...props} section={section} guaranteeScope="none" />);
      expect(screen.queryByText(/callbacks|money-back|satisfaction guaranteed/i)).not.toBeInTheDocument();
    } finally {
      setGlassDefault(false);
    }
  });

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

  it('renders a frozen restart quote as fixed — cadence text, no pills, no add-on toggles', () => {
    const quarterly = { ...baseFrequency, key: 'quarterly', label: 'Quarterly', monthly: 40, annual: 480 };
    render(
      <ServiceSection
        section={{
          key: 'pest_control',
          label: 'Pest Control',
          isRecurring: true,
          isPest: true,
          frequencies: [baseFrequency, quarterly],
          copy: { priceWording: {} },
        }}
        selectedFrequencyKey="quarterly"
        selectedAddOns={new Set(['interior_spray'])}
        onFrequencyChange={vi.fn()}
        onAddOnToggle={vi.fn()}
        renderFlags={{ showPestRecurringAddOns: true, showWaveGuardTierUi: true }}
        waveGuardTier="Bronze"
        frozen
      />,
    );

    expect(screen.queryByText('How often?')).not.toBeInTheDocument();
    expect(screen.queryByText('Skip parts you don\'t need')).not.toBeInTheDocument();
    expect(screen.getByTestId('frozen-cadence')).toHaveTextContent('Quarterly');
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

  it('itemizes a server-stamped per-service discount slice inside the section (owner 2026-08-03)', () => {
    // Multi-service split shape after stampPerServiceManualDiscountSlices:
    // pest quarterly $100 anchor → $90 WaveGuard-net → $85.50 after the 5%
    // plan-credit slice, with both discounts itemized in the price block.
    render(
      <ServiceSection
        section={{
          key: 'pest_control',
          label: 'Pest Control',
          isRecurring: true,
          isPest: true,
          frequencies: [{
            key: 'quarterly',
            label: 'Quarterly',
            monthly: 28.5,
            annual: 342,
            perVisit: 100,
            perTreatment: 85.5,
            visitsPerYear: 4,
            billedPerApplication: true,
            manualDiscount: {
              type: 'PERCENT', value: 5, label: 'Custom Percentage Discount',
              amount: 18, recurringAmount: 18, oneTimeAmount: 0, itemizedPerService: true,
            },
            included: [],
            addOns: [],
          }],
          copy: { priceWording: {} },
        }}
        servicesLength={2}
        selectedFrequencyKey="quarterly"
        selectedAddOns={new Set()}
        onFrequencyChange={vi.fn()}
        onAddOnToggle={vi.fn()}
        renderFlags={{ showPestRecurringAddOns: false, showWaveGuardTierUi: true }}
        waveGuardTier="Silver"
        waveGuardDiscountPct={0.1}
      />,
    );

    // Anchor struck, headline net of BOTH discounts, both itemized in-card.
    expect(screen.getByText(/\$100\.00 \/ application/)).toBeInTheDocument();
    expect(screen.getByText('$85.50')).toBeInTheDocument();
    expect(screen.getByText('WaveGuard Silver Discount')).toBeInTheDocument();
    expect(screen.getByText(/[−-]\$10\.00/)).toBeInTheDocument();
    expect(screen.getByText('Custom Percentage Discount')).toBeInTheDocument();
    expect(screen.getByText(/[−-]\$4\.50/)).toBeInTheDocument();
  });

  it('labels a margin-capped member discount from the membership snapshot saving (owner 2026-08-04)', () => {
    // Current-member estimate: Gold priced the section, but the margin guard
    // capped the applied rate at 12.7% — the 15% tier pct can't reconcile the
    // $12.70 gap; the snapshot's applied per-application saving can.
    render(
      <ServiceSection
        section={{
          key: 'pest_control',
          label: 'Pest Control',
          isRecurring: true,
          isPest: true,
          frequencies: [{
            key: 'quarterly',
            label: 'Quarterly',
            monthly: 29.1,
            annual: 349.2,
            perVisit: 100,
            perTreatment: 87.3,
            visitsPerYear: 4,
            billedPerApplication: true,
            included: [],
            addOns: [],
          }],
          copy: { priceWording: {} },
        }}
        servicesLength={2}
        selectedFrequencyKey="quarterly"
        selectedAddOns={new Set()}
        onFrequencyChange={vi.fn()}
        onAddOnToggle={vi.fn()}
        renderFlags={{ showPestRecurringAddOns: false, showWaveGuardTierUi: true }}
        waveGuardTier="Gold"
        waveGuardDiscountPct={0.15}
        memberPerApplicationSavings={12.7}
      />,
    );

    expect(screen.getByText(/\$100\.00 \/ application/)).toBeInTheDocument();
    expect(screen.getByText('$87.30')).toBeInTheDocument();
    expect(screen.getByText('WaveGuard Gold Discount')).toBeInTheDocument();
    expect(screen.getByText(/[−-]\$12\.70/)).toBeInTheDocument();
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

    expect(screen.getByText('$72.00')).toBeInTheDocument();
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
    expect(screen.getByText('$79.00 / application')).toBeInTheDocument();
    expect(screen.queryByText('/mo')).not.toBeInTheDocument();
    expect(screen.queryByText(/applications per year included/)).not.toBeInTheDocument();
  });

  it('shows no combined /mo total and no per-application headline on a bundle section with a single itemized service', () => {
    // Synthetic unsplittable bundle (pest + lawn) whose legacy snapshot
    // itemizes only the pest slice as a treatment row. Two wrong headlines
    // exist here: the lone pest per-application price ($94.00) understates
    // the plan, and the combined "$130.00/mo" is a plan total the estimate
    // surface must not carry ("per month" audit 2026-08-01). The card leads
    // with the billing unit; the itemized rows carry the real prices.
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

    // Headline names the billing unit; neither wrong headline appears. The
    // itemized pest row still shows its own per-application price.
    expect(screen.getByText('Priced per application')).toBeInTheDocument();
    expect(screen.queryByText('$130.00')).not.toBeInTheDocument();
    expect(screen.queryByText('/mo')).not.toBeInTheDocument();
    expect(screen.getByText('$94.00')).toBeInTheDocument();
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

describe('mixed-estimate approval microcopy', () => {
  const documentPayload = (proposalNoGuaranteeClaims, estimateNoGuaranteeClaims) => ({
    glassDefault: false,
    documentRender: true,
    publicOrigin: 'https://portal.wavespestcontrol.com',
    estimate: {
      token: 'mixed-termite-token', slug: 'EST-2099-4982', customerName: 'Casey Example',
      customerPhone: '+19415551234', customerEmail: 'casey@example.com',
      address: '1 Document Policy Way', createdAt: '2026-09-27T12:00:00.000Z',
      expiresAt: '2026-10-27T12:00:00.000Z', licenseNumber: 'JB351547',
      category: 'RESIDENTIAL', noGuaranteeClaims: estimateNoGuaranteeClaims,
      isOneTimeOnly: false, intelligence: null, satelliteUrl: null,
    },
    proposal: {
      enabled: false, synthesized: false, noGuaranteeClaims: proposalNoGuaranteeClaims,
      pestRecurringOnly: proposalNoGuaranteeClaims === false, title: 'Service Proposal',
      preparedFor: 'Casey Example', propertyAddress: '1 Document Policy Way', terms: null,
      buildings: [{
        name: '1 Document Policy Way', note: null,
        lineItems: proposalNoGuaranteeClaims
          ? [{ description: 'Termite trenching', quantity: 1, unitPrice: 1200, amount: 1200,
            frequency: 'one_time', frequencyLabel: 'One-time', taxable: false }]
          : [{ description: 'Pest Control', quantity: 1, unitPrice: 55, amount: 55,
            frequency: 'monthly', frequencyLabel: 'Monthly', taxable: false }],
      }],
      totals: proposalNoGuaranteeClaims
        ? { annualRecurring: 0, monthlyEquivalent: 0, oneTime: 1200, totalTax: 0,
          firstYearTotal: 1200, hasTax: false, isMultiBuilding: false }
        : { annualRecurring: 660, monthlyEquivalent: 55, oneTime: 0, totalTax: 0,
          firstYearTotal: 660, hasTax: false, isMultiBuilding: false },
    },
    cta: { commercialProposal: false, commercialAutoPriced: false },
  });

  it.each([
    ['retained termite rows override current eligible pest pricing', true, false, /Written estimate scope and terms apply/i],
    ['eligible proposal rows override a stale estimate-level suppression', false, true, /Backed by the Waves Guarantee/i],
  ])('uses the document policy for its visible shell footer: %s', async (
    _name, proposalNoGuaranteeClaims, estimateNoGuaranteeClaims, expectedFooter,
  ) => {
    window.history.replaceState({}, '', '/estimate/mixed-termite-token?mode=pdf');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => documentPayload(proposalNoGuaranteeClaims, estimateNoGuaranteeClaims),
    })));

    render(<WavesShell><EstimateViewPage /></WavesShell>);

    await screen.findByText(proposalNoGuaranteeClaims ? 'Termite trenching' : 'Pest Control');
    const footer = within(screen.getByRole('contentinfo'));
    expect(await footer.findByText(expectedFooter)).toBeInTheDocument();
    if (proposalNoGuaranteeClaims) {
      expect(footer.queryByText(/Backed by the Waves Guarantee/i)).not.toBeInTheDocument();
    } else {
      expect(footer.queryByText(/Written estimate scope and terms apply/i)).not.toBeInTheDocument();
    }
  });

  it('the document footer follows the document scope, which honors the page decision (engine commercial marks)', async () => {
    window.history.replaceState({}, '', '/estimate/mixed-termite-token?mode=pdf');
    const payload = documentPayload(false, false);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ ...payload, estimate: { ...payload.estimate, noEstimateWideGuarantee: true } }),
    })));

    render(<WavesShell><EstimateViewPage /></WavesShell>);

    await screen.findByText('Pest Control');
    const footer = within(screen.getByRole('contentinfo'));
    expect(await footer.findByText(/Written estimate scope and terms apply/i)).toBeInTheDocument();
    expect(footer.queryByText(/Backed by the Waves Guarantee/i)).not.toBeInTheDocument();
  });

  it('scopes the server no-guarantee decision to the estimate shell beside one-time termite work', async () => {
    const frequency = {
      key: 'standard',
      label: 'Standard',
      monthly: 50,
      annual: 600,
      included: [{ key: 'service', label: 'Recurring service' }],
      addOns: [],
    };
    const services = [
      {
        key: 'pest_control', label: 'Pest Control', isRecurring: true, isPest: true,
        frequencies: [frequency], copy: { priceWording: {} },
      },
      {
        key: 'lawn_care', label: 'Lawn Care', isRecurring: true, isPest: false,
        frequencies: [{ ...frequency, monthly: 80, annual: 960 }], copy: { priceWording: {} },
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        glassDefault: false,
        estimate: {
          customerFirstName: 'Casey',
          address: '1 Mixed Service Way',
          serviceCategory: 'bundle',
          acceptance: { mode: 'standard_slot_pick' },
          defaultServiceMode: 'recurring',
          isOneTimeOnly: false,
          showOneTimeOption: false,
          billByInvoice: false,
          membership: null,
          intelligence: null,
          acceptedServiceMode: null,
          acceptedFrequencyKey: null,
          noGuaranteeClaims: true,
        },
        pricing: {
          services,
          askChips: [],
          oneTimeBreakdown: {
            total: 1200,
            items: [
              { service: 'termite_trenching', label: 'Termite Trenching', detail: 'Linear-foot trench treatment', amount: 1200, kind: 'charge' },
              { service: 'mosquito', label: 'Mosquito follow-up', detail: 'Rain re-spray guarantee', amount: 0, kind: 'included' },
            ],
          },
          defaultServiceMode: 'recurring',
          renderFlags: {},
        },
        cta: {
          canAccept: true,
          terminalState: null,
          quoteRequired: false,
          reviewBeforeBooking: false,
        },
      }),
    })));

    render(<>
      <section data-testid="estimate-shell"><WavesShell><EstimateViewPage /></WavesShell></section>
      <section data-testid="other-shell"><WavesShell><div>Unrelated customer route</div></WavesShell></section>
      <section data-testid="standalone-footer"><TrustFooter /></section>
    </>);

    await waitFor(() => {
      expect(screen.getByText('Termite Trenching')).toBeInTheDocument();
    });
    expect(screen.getByText('Licensed & insured · No pressure — approve when you’re ready')).toBeInTheDocument();
    expect(screen.queryByText(/Satisfaction guaranteed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/money-back guarantee/i)).not.toBeInTheDocument();
    expect(screen.getByText('Mosquito follow-up')).toBeInTheDocument();
    expect(screen.queryByText(/Rain re-spray guarantee/i)).not.toBeInTheDocument();
    expect(screen.getByText('Linear-foot trench treatment')).toBeInTheDocument();
    const estimateShell = within(screen.getByTestId('estimate-shell'));
    await waitFor(() => {
      expect(estimateShell.queryByText(/Backed by the Waves Guarantee/i)).not.toBeInTheDocument();
      expect(estimateShell.getByText(/Written estimate scope and terms apply/i)).toBeInTheDocument();
    });
    expect(within(screen.getByTestId('other-shell')).getByText(/Backed by the Waves Guarantee/i)).toBeInTheDocument();
    expect(within(screen.getByTestId('standalone-footer')).getByText(/Backed by the Waves Guarantee/i)).toBeInTheDocument();
  });

  it('retains the standard footer guarantee for an ordinary recurring estimate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        glassDefault: false,
        estimate: {
          customerFirstName: 'Casey',
          address: '1 Recurring Service Way',
          serviceCategory: 'pest_control',
          acceptance: { mode: 'standard_slot_pick' },
          defaultServiceMode: 'recurring',
          isOneTimeOnly: false,
          showOneTimeOption: false,
          billByInvoice: false,
          membership: null,
          intelligence: null,
          noGuaranteeClaims: false,
        },
        pricing: {
          services: [{
            key: 'pest_control',
            label: 'Pest Control',
            isRecurring: true,
            isPest: true,
            frequencies: [{
              key: 'standard', label: 'Standard', monthly: 50, annual: 600,
              included: [{ key: 'service', label: 'Recurring service' }], addOns: [],
            }],
            copy: { priceWording: {} },
          }],
          askChips: [],
          defaultServiceMode: 'recurring',
          renderFlags: {},
        },
        cta: {
          canAccept: true,
          terminalState: null,
          quoteRequired: false,
          reviewBeforeBooking: false,
        },
      }),
    })));

    render(<WavesShell><EstimateViewPage /></WavesShell>);

    await screen.findByText('1 Recurring Service Way');
    expect(await screen.findByText(/Backed by the Waves Guarantee/i)).toBeInTheDocument();
    expect(screen.queryByText(/Written estimate scope and terms apply/i)).not.toBeInTheDocument();
  });

  it('neutralizes the footer when not every service carries the plan terms (a rodent plan)', async () => {
    // noGuaranteeClaims stays false (no termite work), but the server marks
    // the estimate noEstimateWideGuarantee: rodent carries no money-back plan
    // terms, so no guarantee line covers the whole estimate.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        glassDefault: false,
        estimate: {
          customerFirstName: 'Casey',
          address: '1 Rodent Plan Way',
          serviceCategory: 'rodent',
          acceptance: { mode: 'standard_slot_pick' },
          defaultServiceMode: 'recurring',
          isOneTimeOnly: false,
          showOneTimeOption: false,
          billByInvoice: false,
          membership: null,
          intelligence: null,
          noEstimateWideGuarantee: true,
        },
        pricing: {
          services: [{
            key: 'rodent_bait',
            label: 'Rodent Bait Stations',
            isRecurring: true,
            isPest: false,
            frequencies: [{
              key: 'standard', label: 'Standard', monthly: 40, annual: 480,
              included: [{ key: 'service', label: 'Recurring service' }], addOns: [],
            }],
            copy: { priceWording: {} },
          }],
          askChips: [],
          defaultServiceMode: 'recurring',
          renderFlags: {},
        },
        cta: {
          canAccept: true,
          terminalState: null,
          quoteRequired: false,
          reviewBeforeBooking: false,
        },
      }),
    })));

    render(<WavesShell><EstimateViewPage /></WavesShell>);

    await screen.findByText('1 Rodent Plan Way');
    const footer = within(screen.getByRole('contentinfo'));
    expect(await footer.findByText(/Written estimate scope and terms apply/i)).toBeInTheDocument();
    expect(footer.queryByText(/Backed by the Waves Guarantee/i)).not.toBeInTheDocument();
  });

  it('keeps the footer neutral during initial and next-token loads, then restores ordinary shell copy on unmount', async () => {
    const deferred = [];
    vi.stubGlobal('fetch', vi.fn((url) => String(url).includes('/data')
      ? new Promise((resolve) => deferred.push(resolve))
      : Promise.resolve({ ok: true, status: 200, json: async () => ({}) })));
    const payload = (noGuaranteeClaims) => ({
      glassDefault: false,
      estimate: {
        customerFirstName: 'Casey', address: '1 Policy Way', serviceCategory: 'pest_control',
        acceptance: { mode: 'standard_slot_pick' }, defaultServiceMode: 'recurring',
        isOneTimeOnly: false, showOneTimeOption: false, billByInvoice: false,
        membership: null, intelligence: null, noGuaranteeClaims,
      },
      pricing: { services: [], askChips: [], defaultServiceMode: 'recurring', renderFlags: {} },
      cta: { canAccept: true, terminalState: null, quoteRequired: false, reviewBeforeBooking: false },
    });
    const resolveLoad = (index, noGuaranteeClaims) => deferred[index]({
      ok: true, status: 200, json: async () => payload(noGuaranteeClaims),
    });
    const { rerender } = render(<WavesShell><EstimateViewPage /></WavesShell>);
    const footer = () => within(screen.getByRole('contentinfo'));

    expect(footer().queryByText(/Backed by the Waves Guarantee/i)).not.toBeInTheDocument();
    expect(footer().queryByText(/Written estimate scope and terms apply/i)).not.toBeInTheDocument();
    expect(footer().getByText(/Licensed & insured/i)).toBeInTheDocument();

    resolveLoad(0, true);
    expect(await footer().findByText(/Written estimate scope and terms apply/i)).toBeInTheDocument();

    routerState.token = 'ordinary-estimate-token';
    rerender(<WavesShell><EstimateViewPage /></WavesShell>);
    await waitFor(() => expect(deferred).toHaveLength(2));
    expect(footer().queryByText(/Backed by the Waves Guarantee/i)).not.toBeInTheDocument();
    expect(footer().queryByText(/Written estimate scope and terms apply/i)).not.toBeInTheDocument();

    resolveLoad(1, false);
    expect(await footer().findByText(/Backed by the Waves Guarantee/i)).toBeInTheDocument();

    routerState.token = 'second-no-guarantee-token';
    rerender(<WavesShell><EstimateViewPage /></WavesShell>);
    await waitFor(() => expect(deferred).toHaveLength(3));
    resolveLoad(2, true);
    expect(await footer().findByText(/Written estimate scope and terms apply/i)).toBeInTheDocument();

    rerender(<WavesShell><div>Ordinary customer route</div></WavesShell>);
    expect(await footer().findByText(/Backed by the Waves Guarantee/i)).toBeInTheDocument();
  });

  it('strips stale server-resolved German-roach hero and row guarantees while preserving priced scope', async () => {
    const rawRow = {
      service: 'german_roach', label: 'German Roach Cleanout', amount: 350, kind: 'charge', visits: 2,
    };
    const rawCopy = resolveOneTimeServiceCopy(rawRow);
    const rawServiceCopy = oneTimeOnlyIntelligenceCopy([rawRow]);
    expect(rawCopy.outcome).toMatch(/100% guaranteed/i);
    expect(rawCopy.includes.join(' ')).toMatch(/100% guaranteed/i);
    expect(rawServiceCopy.hero.sub).toMatch(/100% guaranteed/i);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        glassDefault: true,
        estimate: {
          customerFirstName: 'Casey',
          address: '1 Mixed Service Way, Sarasota, FL 34236',
          serviceCategory: 'pest_control',
          acceptance: { mode: 'standard_slot_pick' },
          defaultServiceMode: 'one_time',
          isOneTimeOnly: true,
          showOneTimeOption: false,
          billByInvoice: false,
          membership: null,
          intelligence: null,
          noGuaranteeClaims: true,
        },
        pricing: {
          services: [],
          frequencies: [],
          askChips: [],
          oneTimeBreakdown: {
            total: 350,
            items: [{ ...rawRow, copy: rawCopy }],
          },
          oneTimeServiceCopy: rawServiceCopy,
          defaultServiceMode: 'one_time',
          renderFlags: {},
        },
        cta: {
          canAccept: true,
          terminalState: null,
          quoteRequired: false,
          reviewBeforeBooking: false,
        },
      }),
    })));

    render(<EstimateViewPage />);

    expect(await screen.findByRole('heading', { name: /German roach cleanout quote is ready/i })).toBeInTheDocument();
    expect(screen.queryByText(/100% guaranteed/i)).not.toBeInTheDocument();
    expect(screen.getByText(/actual property/i)).toBeInTheDocument();
    expect(screen.getByText('$350.00')).toBeInTheDocument();
    expect(screen.getByText(/Two targeted visits that clear the roaches/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /See everything included/i }));
    expect(screen.getByText(/Gel bait placed where German roaches actually live/i)).toBeInTheDocument();
    expect(screen.queryByText(/100% guaranteed|Waves Guarantee/i)).not.toBeInTheDocument();
  });

  it('a commercial one-time job states its scope but no guarantee or no-contract term (Codex #4982)', async () => {
    // Commercial service carries only its satisfaction clause: the server
    // marks the estimate noEstimateWideGuarantee while noGuaranteeClaims
    // stays false, and the itemized row follows that scope.
    const rawRow = {
      service: 'bed_bug', label: 'Bed Bug Heat Treatment', amount: 650, kind: 'charge', warrantyEligible: true,
    };
    const rawCopy = resolveOneTimeServiceCopy(rawRow);
    expect(rawCopy.assurance).toMatch(/30-day guarantee/i);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        glassDefault: false,
        estimate: {
          customerFirstName: 'Casey',
          address: '1 Commercial Plaza, Sarasota, FL 34236',
          serviceCategory: 'bed_bug',
          acceptance: { mode: 'standard_slot_pick' },
          defaultServiceMode: 'one_time',
          isOneTimeOnly: true,
          showOneTimeOption: false,
          billByInvoice: false,
          membership: null,
          intelligence: null,
          noGuaranteeClaims: false,
          noEstimateWideGuarantee: true,
        },
        pricing: {
          services: [],
          frequencies: [],
          askChips: [],
          oneTimeBreakdown: {
            total: 650,
            items: [{ ...rawRow, copy: rawCopy }],
          },
          defaultServiceMode: 'one_time',
          renderFlags: {},
        },
        cta: {
          canAccept: true,
          terminalState: null,
          quoteRequired: false,
          reviewBeforeBooking: false,
        },
      }),
    })));

    render(<EstimateViewPage />);

    expect(await screen.findByText('Bed Bug Heat Treatment')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /See everything included/i }));
    expect(screen.getByText('Interceptor traps under bed legs for post-treatment monitoring')).toBeInTheDocument();
    expect(screen.getByText('Pay on service day.')).toBeInTheDocument();
    expect(screen.queryByText(/30-day guarantee|No contract/i)).not.toBeInTheDocument();
  });
});

describe('OneTimeBreakdownCard', () => {
  it('renders the actual server-resolved service copy for a normal control', () => {
    const row = {
      service: 'german_roach',
      label: 'German Roach Cleanout Service — 2 Visit Program',
      amount: 350,
      visits: 2,
    };
    render(<OneTimeBreakdownCard breakdown={{ total: 350, items: [{
      ...row,
      copy: resolveOneTimeServiceCopy(row),
    }] }} />);
    expect(screen.getByText(/Your home back.+Two targeted visits/)).toBeInTheDocument();
    // Bullets sit behind the same "See everything included" dropdown the
    // recurring PriceCard rows use — collapsed until tapped.
    expect(screen.queryByText(/Gel bait placed where German roaches actually live/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /See everything included/ }));
    expect(screen.getByText(/Gel bait placed where German roaches actually live/)).toBeInTheDocument();
    expect(screen.getByText('If they come back, so do we — 100% guaranteed with the Waves Guarantee')).toBeInTheDocument();
    expect(screen.getByText('Pay on service day. No recurring schedule, no contract.')).toBeInTheDocument();
    expect(screen.getByText('$350.00')).toBeInTheDocument();
  });

  it('the satisfaction scope drops a row guarantee and no-contract term but keeps the sold scope', () => {
    const row = { service: 'bed_bug', label: 'Bed Bug Heat Treatment', amount: 650, warrantyEligible: true };
    render(<OneTimeBreakdownCard guaranteeScope="satisfaction" breakdown={{ total: 650, items: [{
      ...row,
      copy: resolveOneTimeServiceCopy(row),
    }] }} />);
    fireEvent.click(screen.getByRole('button', { name: /See everything included/i }));
    expect(screen.getByText('Interceptor traps under bed legs for post-treatment monitoring')).toBeInTheDocument();
    expect(screen.getByText('Pay on service day.')).toBeInTheDocument();
    expect(screen.queryByText(/30-day guarantee|No contract/i)).not.toBeInTheDocument();
  });

  it('each one-time row states its own service terms (server termsScope)', () => {
    const bedBug = { service: 'bed_bug', label: 'Bed Bug Heat Treatment', amount: 650, warrantyEligible: true };
    const commercialBedBug = { ...bedBug, label: 'Bed Bug Heat Treatment — Suite 200' };
    render(<OneTimeBreakdownCard guaranteeScope="satisfaction" breakdown={{ total: 1300, items: [
      { ...bedBug, termsScope: 'all', copy: resolveOneTimeServiceCopy(bedBug) },
      { ...commercialBedBug, termsScope: 'satisfaction', copy: resolveOneTimeServiceCopy(commercialBedBug) },
    ] }} />);
    for (const button of screen.getAllByRole('button', { name: /See everything included/i })) fireEvent.click(button);
    expect(screen.getAllByText('Written 30-day guarantee on the treated areas')).toHaveLength(1);
    expect(screen.getByText('Pay on service day. No contract.')).toBeInTheDocument();
    expect(screen.getByText('Pay on service day.')).toBeInTheDocument();
  });

  it('keeps a canonically purchased trenching warranty while filtering generic promises', () => {
    const row = {
      service: 'trenching', label: 'Termite Trenching', amount: 900,
      chemistryType: 'non_repellent', warrantyTier: 'three_year_repair_retreat', warrantyAdder: 117,
    };
    const resolved = resolveOneTimeServiceCopy(row);
    render(<OneTimeBreakdownCard noGuarantee breakdown={{ total: 900, items: [{
      ...row,
      detail: 'Lifetime guarantee with free retreatments',
      copy: {
        ...resolved,
        includes: [...resolved.includes, 'Unlimited free callbacks'],
      },
    }] }} />);

    expect(screen.queryByText(/Lifetime guarantee/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /See everything included/i }));
    expect(screen.getByText('Annual inspection during the warranty period')).toBeInTheDocument();
    expect(screen.queryByText(/Unlimited free callbacks/i)).not.toBeInTheDocument();
  });

  it.each([
    ['missing warranty price metadata', { warrantyTier: 'three_year_repair_retreat', warrantyAdder: null }],
    ['no warranty selected', { warrantyTier: 'none', warrantyAdder: 0 }],
    ['unknown service row', { service: 'one_time_pest', warrantyTier: 'three_year_repair_retreat', warrantyAdder: 117 }],
  ])('does not trust a warranty bullet from %s', (_label, override) => {
    render(<OneTimeBreakdownCard noGuarantee breakdown={{ total: 900, items: [{
      service: 'trenching', label: 'Termite Trenching', amount: 900,
      ...override,
      copy: {
        outcome: 'Treatment follows the written scope.',
        includes: ['Measured trenching scope', 'Annual inspection during the warranty period'],
        assurance: null,
        terms: 'Written service terms apply.',
      },
    }] }} />);

    fireEvent.click(screen.getByRole('button', { name: /See everything included/i }));
    expect(screen.getByText('Measured trenching scope')).toBeInTheDocument();
    expect(screen.queryByText('Annual inspection during the warranty period')).not.toBeInTheDocument();
  });

  it.each([
    ['selected extended', true, 'Extended 5-yr warranty', '1,850 sf | Termidor SC | 12 oz | Extended 5-yr warranty'],
    ['basic', false, 'Basic 1-yr warranty', '1,850 sf | Termidor SC | 12 oz'],
  ])('a pre-slab row keeps its scope under the no-guarantee policy, with a %s warranty', (_label, extended, warranty, expected) => {
    // Owner ruling 2026-09-27: a selected pre-slab warranty is stated; the
    // policy drops plan-terms parts of the detail, never the scope.
    render(<OneTimeBreakdownCard noGuarantee breakdown={{ total: 950, items: [{
      service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment', amount: 950,
      detail: `1,850 sf | Termidor SC | 12 oz | ${warranty}`,
      warrantyExtendedSelected: extended,
      warrantyStatus: extended ? 'Extended 5-year warranty' : 'No extended warranty selected',
    }] }} />);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('a row without a copy pack renders exactly as before (no bullets, no outcome line)', () => {
    const { container } = render(<OneTimeBreakdownCard breakdown={{ total: 257, items: [
      { service: 'one_time_adjustment', label: 'Additional treatment area', amount: 257 },
    ] }} />);
    expect(container.querySelectorAll('li').length).toBe(0);
    expect(screen.getByText('Additional treatment area')).toBeInTheDocument();
  });

  it('presents trap-only recurring monitoring as a monitoring plan', () => {
    render(<OneTimeBreakdownCard breakdown={{ total: 694, items: [
      { service: 'trap_only_retainer', label: 'Standard Trap-Only Monitoring Retainer', amount: 495 },
      { service: 'trap_only_setup', label: 'Trap-Only Setup / Inspection', amount: 199 },
    ] }} />);
    expect(screen.getByText('Trap-only monitoring plan')).toBeInTheDocument();
    expect(screen.queryByText('One-time services')).not.toBeInTheDocument();
  });

  it('uses customer-friendly labels for WDO and termite foam keys', () => {
    render(<OneTimeBreakdownCard breakdown={{ total: 305, items: [
      { service: 'wdo_inspection', label: 'wdo_inspection', amount: 125 },
      { service: 'termite_foam', label: 'Termidor Foam Spot Treatment', amount: 180 },
    ] }} />);
    expect(screen.getByText('WDO Inspection')).toBeInTheDocument();
    expect(screen.getByText('Termite Foam Treatment')).toBeInTheDocument();
    expect(screen.queryByText('wdo_inspection')).not.toBeInTheDocument();
  });

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

    expect(screen.getByText((_, el) => el?.textContent === '$99.00*' && el?.children.length === 0)).toBeInTheDocument();
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
    // The row amount renders plain $99.00 — no asterisk. Single-item
    // breakdowns no longer repeat it as a total row (owner 2026-07-23).
    expect(screen.getAllByText('$99.00').length).toBe(1);
    expect(screen.queryByText('One-time total')).not.toBeInTheDocument();
    expect(screen.queryByText((_, el) => el?.textContent === '$99.00*' && el?.children.length === 0)).not.toBeInTheDocument();
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
    expect(screen.queryByText((_, el) => el?.textContent === '$250.00' && el?.children.length === 0)).not.toBeInTheDocument();
  });
});

describe('oneTimePriceCopy', () => {
  it('drops the callback term on an estimate the server marks noGuaranteeClaims (Codex #4982 r4)', () => {
    // The rowless fallback (OneTimePriceCard) reaches the default copy.
    expect(oneTimePriceCopy({ total: 400, items: [] })).toMatch(/30-day callback period/);
    const neutral = oneTimePriceCopy({ total: 400, items: [] }, { noGuarantee: true });
    expect(neutral).not.toMatch(/callback|guarantee/i);
    expect(neutral).toMatch(/pay on service day/);
  });

  it('a two-visit flea package states no retreat guarantee on a noGuaranteeClaims estimate', () => {
    const breakdown = { total: 350, items: [{ service: 'flea', label: 'Flea Elimination', amount: 350, visits: 2 }] };
    expect(oneTimePriceCopy(breakdown)).toMatch(/Retreat guarantee/);
    const neutral = oneTimePriceCopy(breakdown, { noGuarantee: true });
    expect(neutral).not.toMatch(/guarantee|warranty/i);
    expect(neutral).toMatch(/two interior treatments/);
  });

  it('a rodent guarantee renewal states no warranty terms on a noGuaranteeClaims estimate', () => {
    const breakdown = { total: 199, items: [{ service: 'rodent_guarantee', label: 'Rodent Guarantee', amount: 199 }] };
    expect(oneTimePriceCopy(breakdown)).toMatch(/12-month re-entry warranty/);
    const neutral = oneTimePriceCopy(breakdown, { noGuarantee: true });
    expect(neutral).not.toMatch(/guarantee|warranty/i);
    expect(neutral).toMatch(/No service visit to schedule/);
  });

  it('drops the Waves Guarantee from a German roach cleanout on a noGuaranteeClaims estimate', () => {
    // The one-time card prices every one-time row: a cleanout quoted beside
    // termite trenching must not read as a guarantee on the whole charge.
    const breakdown = { total: 1600, items: [
      { service: 'german_roach', label: 'German Roach Cleanout', amount: 400, visits: 3 },
      { service: 'termite_trenching', label: 'Termite Trenching', amount: 1200 },
    ] };
    expect(oneTimePriceCopy(breakdown)).toMatch(/100% guaranteed/);
    const noGuarantee = oneTimePriceCopy(breakdown, { noGuarantee: true });
    expect(noGuarantee).not.toMatch(/guarantee/i);
    expect(noGuarantee).toMatch(/break the breeding cycle/);
  });

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

  it('lawn-only one-time gets turf copy without the pest callback line', () => {
    const copy = oneTimePriceCopy({ total: 174, items: [{ service: 'one_time_lawn', label: 'One-Time Lawn', amount: 174 }] });
    expect(copy).toMatch(/lawn treatment for the measured turf/i);
    expect(copy).not.toMatch(/if pests return/);
  });

  it('lawn specialty rows (top-dressing / dethatching) classify as lawn', () => {
    const copy = oneTimePriceCopy({ total: 420, items: [{ service: 'top_dressing', label: 'Top Dressing', amount: 420 }] });
    expect(copy).toMatch(/lawn treatment for the measured turf/i);
  });

  it('rodent entry-point plugging is exclusion work, never lawn copy (codex P2)', () => {
    const copy = oneTimePriceCopy({ total: 350, items: [{ service: 'rodent_plugging', label: 'Rodent Entry-Point Plugging', amount: 350 }] });
    expect(copy).not.toMatch(/lawn treatment for the measured turf/i);
  });

  it('turf-curative labels (chinch, fungicide, weed) get lawn copy even without a lawn key (codex r2)', () => {
    expect(oneTimePriceCopy({ total: 174, items: [{ service: 'lawn_pest_curative', label: 'Chinch Bug Curative', amount: 174 }] }))
      .toMatch(/lawn treatment for the measured turf/i);
    expect(oneTimePriceCopy({ total: 210, items: [{ label: 'Fungicide Treatment', amount: 210 }] }))
      .toMatch(/lawn treatment for the measured turf/i);
    expect(oneTimePriceCopy({ total: 160, items: [{ label: 'Weed Control Treatment', amount: 160 }] }))
      .toMatch(/lawn treatment for the measured turf/i);
    // fungus GNATS stay a pest
    expect(oneTimePriceCopy({ total: 120, items: [{ label: 'Fungus Gnat Treatment', amount: 120 }] }))
      .not.toMatch(/lawn treatment for the measured turf/i);
  });

  it('a mixed lawn + pest one-time set keeps the default pest callback copy', () => {
    const copy = oneTimePriceCopy({
      total: 458,
      items: [
        { service: 'one_time_lawn', label: 'One-Time Lawn', amount: 174 },
        { service: 'one_time_pest', label: 'One-Time Pest Control', amount: 284 },
      ],
    });
    expect(copy).toMatch(/30-day callback period if pests return/);
  });
});

describe('OneTimeModeToggle labels', () => {
  it('lawn_care estimates get lawn wording, never pest', () => {
    render(<OneTimeModeToggle mode="recurring" oneTimePrice={174} onChange={() => {}} serviceCategory="lawn_care" />);
    expect(screen.getByRole('button', { name: 'Recurring Lawn Program' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'One-Time Lawn Treatment' })).toBeInTheDocument();
  });

  it('pest / bundle / unknown categories keep the legacy pest wording', () => {
    expect(oneTimeToggleLabels('pest_control')).toEqual({ recurring: 'Recurring Pest Control', oneTime: 'One-Time Pest Control' });
    expect(oneTimeToggleLabels('bundle')).toEqual({ recurring: 'Recurring Pest Control', oneTime: 'One-Time Pest Control' });
    expect(oneTimeToggleLabels(undefined)).toEqual({ recurring: 'Recurring Pest Control', oneTime: 'One-Time Pest Control' });
    render(<OneTimeModeToggle mode="recurring" oneTimePrice={284} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'One-Time Pest Control' })).toBeInTheDocument();
  });

  it('mosquito and tree & shrub map to their own wording', () => {
    expect(oneTimeToggleLabels('mosquito').oneTime).toBe('One-Time Mosquito Treatment');
    expect(oneTimeToggleLabels('tree_shrub').oneTime).toBe('One-Time Tree & Shrub Visit');
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
  it('pest + rodent bait is already Silver — the lawn offer takes the multi-service copy, never "Silver / 10%" (codex #3591 r12 P2)', () => {
    const offer = estimateAddServiceOffer([{
      key: 'bundle',
      label: 'Recurring services',
      isRecurring: true,
      memberKeys: ['pest_control'],
      frequencies: [{ perServiceTreatments: [
        { service: 'pest_control', label: 'Pest Control', perTreatment: 107, visitsPerYear: 4 },
        { service: 'rodent_bait', label: 'Rodent Bait Stations', perTreatment: 89, visitsPerYear: 4 },
      ] }],
    }], 'recurring');
    expect(offer).toEqual(expect.objectContaining({ serviceKey: 'lawn_care' }));
    expect(offer.body).not.toMatch(/Silver|10%/);
    // Rodent trapping is not a plan service and must not move the copy.
    const trapping = estimateAddServiceOffer([{
      key: 'bundle', label: 'Recurring services', isRecurring: true, memberKeys: ['pest_control'],
      frequencies: [{ perServiceTreatments: [{ service: 'pest_control', label: 'Pest Control', perTreatment: 107, visitsPerYear: 4 }] }],
      services: [{ name: 'Rodent Trapping' }],
    }], 'recurring');
    expect(trapping.body).toMatch(/Silver|10%|next/);
    // A rodent row the server flagged non-qualifying (live rodent_waveguard
    // flags) does not count either (codex #3591 r15 P2).
    const flaggedOff = estimateAddServiceOffer([{
      key: 'bundle', label: 'Recurring services', isRecurring: true, memberKeys: ['pest_control'],
      frequencies: [{ perServiceTreatments: [
        { service: 'pest_control', label: 'Pest Control', perTreatment: 107, visitsPerYear: 4 },
        { service: 'rodent_bait', label: 'Rodent Bait Stations', perTreatment: 89, visitsPerYear: 4, countsTowardWaveGuardTier: false },
      ] }],
    }], 'recurring');
    expect(flaggedOff.body).toMatch(/Silver|10%|next/);
    // …even when the section's raw memberKeys still list rodent_bait ahead
    // of the flagged row (codex #3591 r41 P2): the row verdict wins.
    const flaggedOffWithMemberKey = estimateAddServiceOffer([{
      key: 'bundle', label: 'Recurring services', isRecurring: true, memberKeys: ['pest_control', 'rodent_bait'],
      frequencies: [{ perServiceTreatments: [
        { service: 'pest_control', label: 'Pest Control', perTreatment: 107, visitsPerYear: 4 },
        { service: 'rodent_bait', label: 'Rodent Bait Stations', perTreatment: 89, visitsPerYear: 4, countsTowardWaveGuardTier: false },
      ] }],
    }], 'recurring');
    expect(flaggedOffWithMemberKey.body).toMatch(/Silver|10%|next/);
    // Discount eligibility is NOT tier qualification: a tier-counted rodent
    // row that is merely excluded from the % still makes pest + rodent
    // Silver, so the lawn offer takes the multi-service copy (codex #3591 r26 P1).
    const discountOnly = estimateAddServiceOffer([{
      key: 'bundle', label: 'Recurring services', isRecurring: true, memberKeys: ['pest_control'],
      frequencies: [{ perServiceTreatments: [
        { service: 'pest_control', label: 'Pest Control', perTreatment: 107, visitsPerYear: 4 },
        { service: 'rodent_bait', label: 'Rodent Bait Stations', perTreatment: 89, visitsPerYear: 4, waveGuardDiscountEligible: false },
      ] }],
    }], 'recurring');
    expect(discountOnly.body).not.toMatch(/Silver|10%/);
  });

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

    // The card renders under the hero, which already announces the proposal
    // is ready — the card answers what happens next (owner 2026-08-08).
    expect(screen.getByText('What happens next')).toBeInTheDocument();
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

    expect(screen.getByText('What happens next')).toBeInTheDocument();
    expect(screen.queryByText(/attached as a PDF to the email/i)).not.toBeInTheDocument();
    // The account manager is named (owner 2026-08-08).
    expect(screen.getByText(/Adam, your Waves account manager, has your formal proposal/i)).toBeInTheDocument();
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
  // The uncertain LOW dollars are fixed ($400.00 × 20% = ±$80.00) while the exact part
  // moves with the selection — the band must NOT grow with the displayed total.
  const combined = {
    monthlySubtotal: 500,
    annualSubtotal: 6000,
    lowConfidenceRangePct: 0.2,
    lowConfidenceFraction: 0.8, // stale default-subtotal fraction (400/500)
    lowConfidenceMonthly: 400,
  };

  it('bands only the LOW dollars when another cadence changes the displayed total', () => {
    // Selected combined cadence $600.00/mo: ±$80.00 → $520.00–$680.00 (NOT the stale
    // fraction's 600×0.8×0.2 = ±$96.00 → $504.00–$696.00).
    render(
      <CombinedRecurringPriceCard
        combined={combined}
        selectedFrequency={{ key: 'alt', monthly: 600, annual: 7200 }}
      />,
    );
    expect(screen.getByText(/\$520.00–\$680.00/)).toBeInTheDocument();
    expect(screen.queryByText(/\$504.00–\$696.00/)).not.toBeInTheDocument();
  });

  it('default selection still bands the LOW share of the subtotal', () => {
    render(<CombinedRecurringPriceCard combined={combined} selectedFrequency={null} />);
    // $500.00/mo, ±$80.00 → $420.00–$580.00
    expect(screen.getByText(/\$420.00–\$580.00/)).toBeInTheDocument();
  });

  it('falls back to the stamped fraction when raw LOW dollars are absent (older payloads)', () => {
    const { lowConfidenceMonthly, ...withoutRaw } = combined;
    render(<CombinedRecurringPriceCard combined={withoutRaw} selectedFrequency={{ key: 'alt', monthly: 600 }} />);
    // stamped 0.8 against $600.00 → ±$96.00 → $504.00–$696.00
    expect(screen.getByText(/\$504.00–\$696.00/)).toBeInTheDocument();
  });
});

describe('PlanTotalSummary — plan-level referral credit + net', () => {
  const combined = {
    monthlySubtotal: 82,
    annualSubtotal: 984,
    waveGuardTierLabel: 'Silver',
    manualDiscount: { label: 'Referral Credit', type: 'FIXED', value: 25, amount: 25, recurringAmount: 25, monthlyAmount: 2.08 },
  };

  it('renders the credit as the per-service-sum minus the net — and no combined totals', () => {
    // Per-service cards sum to $84.08/mo (pre-credit); combined net is $82.00/mo →
    // the credit shown is the exact difference ($2.08). The combined monthly and
    // annual totals themselves never render (owner directive 2026-07-11).
    const { container } = render(<PlanTotalSummary combined={combined} preCreditMonthly={84.08} />);
    const text = container.textContent;
    expect(text).toContain('Referral Credit');
    // No single cadence on this multi-service selection → the credit cannot be
    // expressed per application, so NO bare figure renders (a unit-less "-$2.08"
    // beside per-application prices reads as a per-application reduction —
    // codex #3128 r1). The label + plan-pricing wording carry the message.
    expect(text).not.toMatch(/[−-]\$2\.08/);
    expect(text).toContain('Applied to your plan pricing');
    expect(text).toContain('Applied to your plan when you book.');
    expect(text).not.toContain('Plan subtotal');
    expect(text).not.toContain('Your price');
    expect(text).not.toContain('$84.08');
    expect(text).not.toContain('/ year');
  });

  it('renders nothing when there is no credit to itemize (owner rule re-affirmed 2026-07-23: no Plan total on customer estimates)', () => {
    const { container } = render(<PlanTotalSummary combined={{ monthlySubtotal: 82, annualSubtotal: 984, waveGuardTierLabel: 'Silver' }} preCreditMonthly={84.08} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing without a combined payload', () => {
    const { container } = render(<PlanTotalSummary combined={null} preCreditMonthly={84.08} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('tracks the SELECTED cadence — the credit prices from the selection, no totals shown', () => {
    // Switched to a pricier cadence: per-service sum $112.08, net $110.00/mo. The
    // credit is the selection's difference ($2.08); the totals themselves stay off.
    const { container } = render(
      <PlanTotalSummary combined={combined} selectedFrequency={{ key: 'alt', monthly: 110, annual: 1320 }} preCreditMonthly={112.08} />,
    );
    const text = container.textContent;
    expect(text).not.toMatch(/[−-]\$2\.08/); // unit-less figure suppressed
    expect(text).toContain('Applied to your plan pricing');
    expect(text).not.toContain('$112.08');
    expect(text).not.toContain('$110.00');
    expect(text).not.toContain('$1,320.00 / year');
  });

  it('shows the ACTUAL (capped) credit by construction, not a stale default amount', () => {
    // The selected cadence caps the credit so the net is higher ($83.50, only
    // $0.58 off the $84.08 sum). The difference shows the real $0.58 — never the
    // default $2.08 — so the on-screen math always reconciles.
    const text = render(
      <PlanTotalSummary combined={combined} selectedFrequency={{ key: 'alt', monthly: 83.50, annual: 1002 }} preCreditMonthly={84.08} />,
    ).container.textContent;
    expect(text).not.toMatch(/[−-]\$0\.58/); // unit-less figure suppressed
    expect(text).not.toMatch(/[−-]\$2\.08/);
    expect(text).toContain('Applied to your plan pricing');
    expect(text).not.toContain('$83.50');
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
    expect(text).toContain('Applied to your plan pricing');
    expect(text).not.toContain('Your price'); // …but no exact subtotal/net
    expect(text).not.toContain('Plan subtotal');
    // Same when the range rides on the selected frequency.
    const text2 = render(
      <PlanTotalSummary combined={combined} selectedFrequency={{ key: 'alt', monthly: 110, lowConfidenceRangePct: 0.2 }} preCreditMonthly={112.08} />,
    ).container.textContent;
    expect(text2).toContain('Referral Credit');
    expect(text2).not.toContain('Your price');
  });

  it('ranged credit uses the selected-cadence difference, not the stale default', () => {
    // Selected cadence caps the credit (net $111.50 vs $112.08 sum → $0.58), so
    // even the ranged credit-only line shows $0.58, never the default $2.08.
    const ranged = { ...combined, lowConfidenceRangePct: 0.2 };
    const text = render(
      <PlanTotalSummary combined={ranged} selectedFrequency={{ key: 'alt', monthly: 111.50, lowConfidenceRangePct: 0.2 }} preCreditMonthly={112.08} />,
    ).container.textContent;
    expect(text).not.toMatch(/[−-]\$0\.58/); // unit-less figure suppressed
    expect(text).not.toMatch(/[−-]\$2\.08/);
    expect(text).toContain('Applied to your plan pricing');
  });

  it('never derives a per-application credit from the primary cadence (codex #3128 r4)', () => {
    // This card renders only for MULTI-service plans, and combinedFrequency
    // inherits the PRIMARY service's billedPerApplication/visitsPerYear —
    // dividing the whole-plan credit by that one cadence would assert a
    // figure that is not the discount applied to any application's charge.
    // Even a flag-carrying selection therefore stays label-only.
    const text = render(
      <PlanTotalSummary
        combined={combined}
        selectedFrequency={{ key: 'alt', monthly: 110, annual: 1320, billedPerApplication: true, visitsPerYear: 6 }}
        preCreditMonthly={112.08}
      />,
    ).container.textContent;
    expect(text).not.toMatch(/[−-]\$4\.16/);
    expect(text).not.toContain('/ application');
    expect(text).toContain('Applied to your plan pricing');
  });

  it('suppresses for a quote-required selection (page hides exact dollars)', () => {
    const { container } = render(
      <PlanTotalSummary combined={combined} selectedFrequency={{ key: 'alt', quoteRequired: true }} preCreditMonthly={84.08} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the credit for a fully-comped plan (net $0,.00 corroborated)', () => {
    // The credit covers the whole plan: net is $0.00 and the credit line still
    // renders — but no subtotal/"Your price $0.00" restatement (owner 2026-07-11).
    const comped = {
      monthlySubtotal: 0,
      annualSubtotal: 0,
      waveGuardTierLabel: 'Silver',
      manualDiscount: { label: 'Referral Credit', type: 'FIXED', value: 1009, amount: 1008.96, recurringAmount: 1008.96, monthlyAmount: 84.08 },
    };
    const text = render(<PlanTotalSummary combined={comped} preCreditMonthly={84.08} />).container.textContent;
    expect(text).toContain('Referral Credit');
    expect(text).toContain('Applied to your plan pricing'); // no unit-less figure
    expect(text).not.toContain('Plan subtotal');
    expect(text).not.toContain('Your price');
  });

  it('does not treat a zeroed/missing subtotal as a full comp when the credit cannot cover it', () => {
    // Legacy payloads can stamp monthlySubtotal 0 when no total resolved; a
    // $2.08 credit obviously doesn't comp an $84.08 plan, so nothing renders.
    const broken = {
      monthlySubtotal: 0,
      annualSubtotal: 0,
      manualDiscount: { label: 'Referral Credit', type: 'FIXED', value: 25, amount: 25, recurringAmount: 25, monthlyAmount: 2.08 },
    };
    expect(render(<PlanTotalSummary combined={broken} preCreditMonthly={84.08} />).container).toBeEmptyDOMElement();
  });

  it('ranged plan: no fallback credit when the sum exists but the selected cadence has no reduction', () => {
    // The selected cadence fully caps/suppresses the credit (net equals the
    // per-service sum). Falling back to the default $2.08 would advertise a
    // credit accept won't apply, so nothing renders.
    const ranged = { ...combined, lowConfidenceRangePct: 0.2 };
    const { container } = render(
      <PlanTotalSummary combined={ranged} selectedFrequency={{ key: 'alt', monthly: 112.08, lowConfidenceRangePct: 0.2 }} preCreditMonthly={112.08} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('ranged plan with no per-service sum still falls back to the plan credit amount', () => {
    const ranged = { ...combined, lowConfidenceRangePct: 0.2 };
    const text = render(<PlanTotalSummary combined={ranged} />).container.textContent;
    expect(text).toContain('Referral Credit');
    expect(text).toContain('Applied to your plan pricing'); // no unit-less figure
    expect(text).not.toContain('Plan subtotal');
  });

  it('ranged plan with no per-service sum: no fallback when the selected row suppresses the credit', () => {
    const ranged = { ...combined, lowConfidenceRangePct: 0.2 };
    const { container } = render(
      <PlanTotalSummary combined={ranged} selectedFrequency={{ key: 'alt', monthly: 110, lowConfidenceRangePct: 0.2, manualDiscountSuppressed: true }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders from the SELECTED row's credit when the default cadence suppresses it", () => {
    // The server nulls combined.manualDiscount when the DEFAULT cadence
    // floor-suppresses the credit — but the selected cadence still carries it,
    // and its reduction is real, so the summary must not vanish.
    const suppressedDefault = { monthlySubtotal: 82, annualSubtotal: 984, waveGuardTierLabel: 'Silver' };
    const text = render(
      <PlanTotalSummary
        combined={suppressedDefault}
        selectedFrequency={{
          key: 'alt',
          monthly: 110,
          annual: 1320,
          manualDiscount: { label: 'Referral Credit', type: 'FIXED', value: 25, amount: 25, recurringAmount: 25, monthlyAmount: 2.08 },
        }}
        preCreditMonthly={112.08}
      />,
    ).container.textContent;
    expect(text).toContain('Referral Credit');
    expect(text).toContain('Applied to your plan pricing'); // no unit-less figure
    expect(text).not.toContain('Plan subtotal');
    expect(text).not.toContain('$110.00');
  });

  it('gates in on the suppressed flag when a combo-selected credit is live (combo rows carry no discount fields)', () => {
    // Default cadence suppresses the credit (combined.manualDiscount nulled) and
    // the base row carries only manualDiscountSuppressed — but the selected
    // COMBO's net still applies the credit. The overlay keeps the base row's
    // flag, which proves the plan has a credit; the diff prices it.
    const suppressedDefault = { monthlySubtotal: 82, annualSubtotal: 984 };
    const text = render(
      <PlanTotalSummary
        combined={suppressedDefault}
        selectedFrequency={{ key: 'alt', monthly: 110, annual: 1320, manualDiscountSuppressed: true }}
        preCreditMonthly={112.08}
      />,
    ).container.textContent;
    expect(text).toContain('Applied to your plan pricing'); // no unit-less figure
    expect(text).toContain('Discount');
    expect(text).not.toContain('Plan subtotal');
    expect(text).not.toContain('$110.00');
  });

  it('uses the payload-level planDiscount for the gate and label when row fields are unavailable', () => {
    const suppressedDefault = { monthlySubtotal: 82, annualSubtotal: 984 };
    const text = render(
      <PlanTotalSummary
        combined={suppressedDefault}
        selectedFrequency={{ key: 'alt', monthly: 110, annual: 1320 }}
        preCreditMonthly={112.08}
        planDiscount={{ label: 'Referral Credit', type: 'FIXED', value: 25, amount: 25, recurringAmount: 25, monthlyAmount: 2.08 }}
      />,
    ).container.textContent;
    expect(text).toContain('Referral Credit');
    expect(text).toContain('Applied to your plan pricing'); // no unit-less figure
    expect(text).not.toContain('$110.00');
  });

  it('never conjures a discount line from reconciliation drift on a creditless plan', () => {
    // Positive subtotal−net difference but NO credit signal anywhere (no live
    // object, no suppressed flag, no planDiscount) → nothing renders.
    const { container } = render(
      <PlanTotalSummary
        combined={{ monthlySubtotal: 82, annualSubtotal: 984 }}
        selectedFrequency={{ key: 'alt', monthly: 82, annual: 984 }}
        preCreditMonthly={84.08}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('ranged plan with no per-service sum prices the fallback from planDiscount when row objects are absent', () => {
    // Gate passes via planDiscount (combo overlay dropped row-level fields);
    // the credit-only line must price from the same evidence, not vanish.
    const ranged = { monthlySubtotal: 82, annualSubtotal: 984, lowConfidenceRangePct: 0.2 };
    const text = render(
      <PlanTotalSummary
        combined={ranged}
        selectedFrequency={{ key: 'alt', monthly: 110, lowConfidenceRangePct: 0.2 }}
        planDiscount={{ label: 'Referral Credit', type: 'FIXED', value: 25, amount: 25, recurringAmount: 25, monthlyAmount: 2.08 }}
      />,
    ).container.textContent;
    expect(text).toContain('Referral Credit');
    expect(text).toContain('Applied to your plan pricing'); // no unit-less figure
    expect(text).not.toContain('Plan subtotal');
  });

  it('ranged no-sum fallback: the suppressed flag still vetoes a planDiscount', () => {
    const ranged = { monthlySubtotal: 82, annualSubtotal: 984, lowConfidenceRangePct: 0.2 };
    const { container } = render(
      <PlanTotalSummary
        combined={ranged}
        selectedFrequency={{ key: 'alt', monthly: 110, lowConfidenceRangePct: 0.2, manualDiscountSuppressed: true }}
        planDiscount={{ label: 'Referral Credit', type: 'FIXED', value: 25, amount: 25, recurringAmount: 25, monthlyAmount: 2.08 }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('a base-row credit capped smaller does not shadow a planDiscount that comps the combo to $0.00', () => {
    // The base row still carries a small capped object, but the selected combo
    // is fully comped by the plan credit — corroboration takes the largest
    // candidate, so "Your price $0.00" renders.
    const text = render(
      <PlanTotalSummary
        combined={{ monthlySubtotal: 82, annualSubtotal: 984 }}
        selectedFrequency={{
          key: 'alt',
          monthly: 0,
          annual: 0,
          manualDiscount: { label: 'Referral Credit', type: 'FIXED', amount: 18, recurringAmount: 18, monthlyAmount: 1.50, capped: true },
        }}
        preCreditMonthly={84.08}
        planDiscount={{ label: 'Referral Credit', type: 'FIXED', value: 1009, amount: 1008.96, recurringAmount: 1008.96, monthlyAmount: 84.08 }}
      />,
    ).container.textContent;
    expect(text).toContain('Referral Credit');
    expect(text).toContain('Applied to your plan pricing'); // no unit-less figure
    expect(text).not.toContain('Your price');
  });

  it('corroborates a $0.00 net against the planDiscount when row-level objects are absent', () => {
    // Comped via a combo selection: no row-level discount object survives the
    // overlay, but the payload-level credit covers the whole subtotal.
    const text = render(
      <PlanTotalSummary
        combined={{ monthlySubtotal: 82, annualSubtotal: 984 }}
        selectedFrequency={{ key: 'alt', monthly: 0, annual: 0, manualDiscountSuppressed: true }}
        preCreditMonthly={84.08}
        planDiscount={{ label: 'Referral Credit', type: 'FIXED', value: 1009, amount: 1008.96, recurringAmount: 1008.96, monthlyAmount: 84.08 }}
      />,
    ).container.textContent;
    expect(text).toContain('Referral Credit');
    expect(text).toContain('Applied to your plan pricing'); // no unit-less figure
    expect(text).not.toContain('Your price');
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

describe('ContactGapFields — missing-contact capture on accept', () => {
  const noop = () => {};

  it('renders nothing when there are no gaps', () => {
    const { container } = render(<ContactGapFields gaps={null} />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing when both gaps are false', () => {
    const { container } = render(<ContactGapFields gaps={{ lastName: false, email: false }} />);
    expect(container.textContent).toBe('');
  });

  it('shows only the last name field when only that gap is present', () => {
    render(<ContactGapFields gaps={{ lastName: true, email: false }} lastName="" onLastNameChange={noop} />);
    expect(screen.getByText('Last name')).toBeInTheDocument();
    expect(screen.queryByText('Email (for your service reports and receipts)')).not.toBeInTheDocument();
  });

  it('shows only the email field when only that gap is present', () => {
    render(<ContactGapFields gaps={{ lastName: false, email: true }} email="" onEmailChange={noop} />);
    expect(screen.getByText('Email (for your service reports and receipts)')).toBeInTheDocument();
    expect(screen.queryByText('Last name')).not.toBeInTheDocument();
  });

  it('shows both fields when both gaps are present', () => {
    render(<ContactGapFields gaps={{ lastName: true, email: true }} lastName="" onLastNameChange={noop} email="" onEmailChange={noop} />);
    expect(screen.getByText('Last name')).toBeInTheDocument();
    expect(screen.getByText('Email (for your service reports and receipts)')).toBeInTheDocument();
  });

  it('shows no inline error for a blank last name before it has been touched', () => {
    render(
      <ContactGapFields
        gaps={{ lastName: true, email: false }}
        lastName=""
        onLastNameChange={noop}
        lastNameTouched={false}
      />,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the inline required error for a blank last name once touched', () => {
    render(
      <ContactGapFields
        gaps={{ lastName: true, email: false }}
        lastName=""
        onLastNameChange={noop}
        lastNameTouched
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Please enter your last name.');
  });

  it('does not show the required error once a last name is typed, even if touched', () => {
    render(
      <ContactGapFields
        gaps={{ lastName: true, email: false }}
        lastName="Sample"
        onLastNameChange={noop}
        lastNameTouched
      />,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('email field is never marked required and carries no inline error state', () => {
    render(<ContactGapFields gaps={{ lastName: false, email: true }} email="" onEmailChange={noop} />);
    const emailInput = screen.getByPlaceholderText('you@example.com (optional)');
    expect(emailInput).not.toHaveAttribute('aria-required');
    expect(emailInput).toHaveAttribute('type', 'email');
    expect(emailInput).toHaveAttribute('autoComplete', 'email');
  });

  it('calls onLastNameChange / onEmailChange as the customer types', () => {
    const onLastNameChange = vi.fn();
    const onEmailChange = vi.fn();
    render(
      <ContactGapFields
        gaps={{ lastName: true, email: true }}
        lastName=""
        onLastNameChange={onLastNameChange}
        email=""
        onEmailChange={onEmailChange}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Sample' } });
    fireEvent.change(screen.getByPlaceholderText('you@example.com (optional)'), { target: { value: 'sample@example.com' } });
    expect(onLastNameChange).toHaveBeenCalledWith('Sample');
    expect(onEmailChange).toHaveBeenCalledWith('sample@example.com');
  });
  it('renders a required first-name field only when the first-name gap is set', () => {
    const { rerender } = render(<ContactGapFields gaps={{ firstName: false, lastName: true, email: false }} lastName="" onLastNameChange={noop} />);
    expect(screen.queryByPlaceholderText('First name')).not.toBeInTheDocument();
    rerender(<ContactGapFields gaps={{ firstName: true, lastName: true, email: false }} firstName="" onFirstNameChange={noop} lastName="" onLastNameChange={noop} />);
    const input = screen.getByPlaceholderText('First name');
    expect(input).toHaveAttribute('aria-required', 'true');
    expect(input).toHaveAttribute('autoComplete', 'given-name');
  });

  it('shows the email format error only when the caller flags it invalid', () => {
    const { rerender } = render(<ContactGapFields gaps={{ lastName: false, email: true }} email="sample@" onEmailChange={noop} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    rerender(<ContactGapFields gaps={{ lastName: false, email: true }} email="sample@" onEmailChange={noop} emailInvalid />);
    expect(screen.getByRole('alert')).toHaveTextContent('Please check your email address, or leave it blank.');
    expect(screen.getByPlaceholderText('you@example.com (optional)')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('ReviewPhase — missing-contact capture wiring', () => {
  const noop = () => {};
  const baseProps = {
    slotId: 'slot-1',
    existingAppointment: null,
    paymentPreference: 'pay_at_visit',
    secondsRemaining: 600,
    onConfirm: noop,
    onCancel: noop,
    serviceMode: 'recurring',
    depositNote: null,
  };

  it('renders contactSlot right above the confirm button when supplied', () => {
    render(
      <ReviewPhase
        {...baseProps}
        contactSlot={<div data-testid="contact-gap-fields">contact fields</div>}
      />,
    );
    expect(screen.getByTestId('contact-gap-fields')).toBeInTheDocument();
  });

  it('renders nothing extra when contactSlot is absent (byte-identical to before this lane)', () => {
    render(<ReviewPhase {...baseProps} />);
    expect(screen.queryByTestId('contact-gap-fields')).not.toBeInTheDocument();
  });

  it('disables Confirm via confirmDisabled the same way an existing disabling condition does', () => {
    render(<ReviewPhase {...baseProps} confirmDisabled />);
    expect(screen.getByRole('button', { name: 'Confirm booking' })).toBeDisabled();
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

  it('fresh accept shows the pared-down booked card (owner 2026-07-12): no check-your-phone copy', () => {
    render(<SuccessCard acceptResult={{ success: true }} appointmentLabel="Tue, Jul 14 · 9:00 AM" recurring />);

    expect(screen.getByText("You're booked!")).toBeInTheDocument();
    // Date/time rendered WITHOUT the "First visit:" prefix (owner ask).
    expect(screen.getByText('Tue, Jul 14 · 9:00 AM')).toBeInTheDocument();
    expect(screen.queryByText(/First visit:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Check your phone/)).not.toBeInTheDocument();
    // Recurring accepts get the app line + both store badges.
    expect(screen.getByText(/Download the Waves app/)).toBeInTheDocument();
    // Anchor + its SVG each carry the label — assert at least the link.
    expect(screen.getAllByLabelText('Download on the App Store').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('Get it on Google Play').length).toBeGreaterThan(0);
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

  it('sign_agreement (termite annual-plan sign-before-pay): plain wording, no dollar amount, no "booked" copy', () => {
    render(
      <SuccessCard
        acceptResult={{
          success: true, nextStep: 'sign_agreement', billingTerm: 'prepay_annual',
        }}
      />,
    );

    expect(screen.getByText('Next step: sign your plan agreement.')).toBeInTheDocument();
    // Channel-neutral (codex round 3): the agreement may go out by email
    // only, or be drafted for the office to send.
    expect(screen.getByText("We'll send you the signing link. Signing starts your plan; your 12-month coverage begins on your installation date.")).toBeInTheDocument();
    expect(screen.queryByText(/text and email/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/approved/i)).not.toBeInTheDocument();
    expect(screen.queryByText("You're booked!")).not.toBeInTheDocument();
    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();
  });

  it('activation_pending (signed, plan still being set up): acknowledges the signature and never asks to sign again', () => {
    render(
      <SuccessCard
        acceptResult={{
          success: true, nextStep: 'activation_pending', billingTerm: 'prepay_annual',
        }}
      />,
    );

    expect(screen.getByText('We received your signature.')).toBeInTheDocument();
    expect(screen.getByText(/setting up your plan/)).toBeInTheDocument();
    expect(screen.queryByText(/sign your plan agreement/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/pay/i)).not.toBeInTheDocument();
  });

  it('offer_closed (slice 3b: never signed within the abandon window): honest closed state, never asks to sign', () => {
    render(
      <SuccessCard
        acceptResult={{
          success: true, nextStep: 'offer_closed', billingTerm: 'prepay_annual',
        }}
      />,
    );

    expect(screen.getByText('This plan offer has closed.')).toBeInTheDocument();
    expect(screen.getByText(/Nothing was charged or booked/)).toBeInTheDocument();
    expect(screen.queryByText(/sign your plan agreement/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/We received your signature/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();
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

  it('subtracts the rodent bait-station setup too — it is invoiced up front, not after completion (codex #3591 r33 P1)', () => {
    const rodent = {
      oneTimeBreakdown: {
        total: 348,
        items: [
          { service: 'flea_treatment', name: 'Flea treatment', price: 249 },
          { service: 'rodent_bait_setup', name: 'Bait Station Setup', price: 99 },
        ],
      },
    };
    expect(oneTimeExtrasForPaymentNote(rodent, {}, 'recurring')).toBe(249);
    const labeled = {
      oneTimeBreakdown: { total: 149, items: [{ name: 'Rodent exclusion', price: 50 }, { name: 'Bait Station Setup', price: 99 }] },
    };
    expect(oneTimeExtrasForPaymentNote(labeled, {}, 'recurring')).toBe(50);
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

describe('ServiceSection — details-packet preview parity', () => {
  const lawnSection = {
    key: 'lawn_care',
    label: 'Lawn Care',
    isRecurring: true,
    isPest: false,
    frequencies: [{
      key: 'standard',
      label: 'Monthly',
      serviceCategory: 'lawn_care',
      monthly: 50,
      annual: 600,
      included: [{ key: 'lawn_care_standard', label: 'Monthly lawn care program' }],
    }],
    copy: { priceWording: {} },
  };

  const renderRow = (preview) => render(
    <ServiceSection
      section={lawnSection}
      selectedFrequencyKey="standard"
      selectedAddOns={new Set()}
      onFrequencyChange={vi.fn()}
      onAddOnToggle={vi.fn()}
      renderFlags={{ showPestRecurringAddOns: false, showWaveGuardTierUi: false }}
      serviceDetailsRequest={{
        token: 'tok-123',
        customerEmail: 'a@b.com',
        customerPhone: '+19415551234',
        disabled: false,
        preview,
      }}
    />,
  );

  it('links View the PDF and shows no preview caption on a live estimate', () => {
    renderRow(false);
    // Icon-only pill (owner 2026-07-11): the action name lives in aria-label.
    const link = screen.getByLabelText('View the PDF').closest('a');
    expect(link.getAttribute('href')).toContain('/estimates/tok-123/service-details/lawn_care/pdf');
    expect(screen.queryByText(/Preview only\./)).not.toBeInTheDocument();
  });

  it('renders the row inert with a preview caption in the staff draft preview', () => {
    renderRow(true);
    // View the PDF renders for customer-view parity but carries no href — a
    // draft has no public PDF, so the link must not be able to navigate to a
    // 404.
    const link = screen.getByLabelText('View the PDF').closest('a');
    expect(link.getAttribute('href')).toBeNull();
    // The send buttons still render (parity) but the caption makes clear they
    // are inert until the estimate is sent.
    expect(screen.getByRole('button', { name: /Email me the PDF/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Text me the link/ })).toBeInTheDocument();
    expect(screen.getByText(/Preview only\./)).toBeInTheDocument();
  });
});

describe('membership card retired (owner 2026-08-04)', () => {
  it('exports no MembershipCard — a member estimate is price → picker → approve, savings in the price block', async () => {
    // The member card is gone entirely; if someone reintroduces the export,
    // this fails and points them at the in-price savings stack instead.
    const page = await import('./EstimateViewPage');
    expect(page.MembershipCard).toBeUndefined();
  });
});

// Termite station rental rider (2026-08-25): server-suppressed from the
// section list and stamped onto the termite card — the row must itemize
// there instead of the pre-fix broken duplicate "Service" card.
describe('ServiceSection termite station rental row', () => {
  const termiteSection = (extra = {}) => ({
    key: 'termite_bait',
    label: 'Termite Bait Monitoring',
    isRecurring: true,
    isPest: false,
    frequencies: [{
      key: 'recurring',
      label: 'Termite Bait',
      monthly: 37.1,
      annual: 445.2,
      perTreatment: 111.3,
      visitsPerYear: 4,
      billedPerApplication: true,
      included: [{ key: 'termite_bait', label: 'Termite Bait' }],
      addOns: [],
    }],
    copy: { priceWording: {} },
    ...extra,
  });

  it('itemizes the stamped rental with its per-application uplift', () => {
    render(
      <ServiceSection
        section={termiteSection({
          stationRental: {
            label: 'Termite Station Rental',
            detail: '16 rented stations · Waves-owned',
            perApplicationAdd: 33,
            monthlyAdd: 11,
            annualAdd: 132,
          },
        })}
        selectedFrequencyKey="recurring"
        selectedAddOns={new Set()}
        onFrequencyChange={vi.fn()}
        onAddOnToggle={vi.fn()}
        renderFlags={{}}
      />,
    );

    const row = screen.getByLabelText('Termite station rental');
    expect(row).toHaveTextContent('Termite Station Rental');
    expect(row).toHaveTextContent('16 rented stations · Waves-owned');
    expect(row).toHaveTextContent('$33.00 / application');
    expect(row).toHaveTextContent('Included in your plan pricing.');
  });

  it('drops the amount on a priceItemized stamp — terms only, never a second price', () => {
    render(
      <ServiceSection
        section={termiteSection({
          stationRental: {
            label: 'Termite Station Rental',
            detail: '16 rented stations · Waves-owned',
            perApplicationAdd: 33,
            monthlyAdd: 11,
            annualAdd: 132,
            priceItemized: true,
          },
        })}
        selectedFrequencyKey="recurring"
        selectedAddOns={new Set()}
        onFrequencyChange={vi.fn()}
        onAddOnToggle={vi.fn()}
        renderFlags={{}}
      />,
    );

    const row = screen.getByLabelText('Termite station rental');
    expect(row).toHaveTextContent('16 rented stations · Waves-owned');
    expect(row).not.toHaveTextContent('$33.00');
  });

  it('renders no rental row when the section carries no stamp', () => {
    render(
      <ServiceSection
        section={termiteSection()}
        selectedFrequencyKey="recurring"
        selectedAddOns={new Set()}
        onFrequencyChange={vi.fn()}
        onAddOnToggle={vi.fn()}
        renderFlags={{}}
      />,
    );

    expect(screen.queryByLabelText('Termite station rental')).not.toBeInTheDocument();
  });
});

describe('OneTimePriceCard fallback (pre-push P0 on #3521)', () => {
  it('shows the stored one-time total when a legacy estimate has no breakdown rows', () => {
    render(<OneTimePriceCard oneTimePrice={257} breakdown={{ total: 257, items: [] }} />);
    expect(screen.getByText('$257.00')).toBeInTheDocument();
    expect(screen.getByText('one-time')).toBeInTheDocument();
  });

  it('OneTimeBreakdownCard renders nothing for an empty breakdown (why the fallback exists)', () => {
    const { container } = render(<OneTimeBreakdownCard breakdown={{ total: 257, items: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

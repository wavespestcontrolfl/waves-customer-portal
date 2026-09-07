/**
 * DEV HARNESS — renders the real customer EstimateViewPage ("universal
 * template") against canned fixtures so the template can be iterated in a
 * browser without a database or estimate token. NOT part of the app build
 * (vite only builds index.html); served by `npx vite` at
 * /preview-estimate.html?scenario=<service-or-edge-case>.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import EstimateViewPage from '../pages/EstimateViewPage';
import WavesShell from '../components/brand/WavesShell';
import { ESTIMATE_SCENARIOS } from './estimate-scenarios';
import { documentRenderAffirmed, synthesizeDocumentProposal } from './estimate-document-proposal';
import { addETDays, etDateString } from '../lib/timezone';
import '../index.css';
// Brand tokens (--surface/--border/...) normally ride in via main.jsx —
// without them the WavesShell top bar computes a transparent background and
// the preview's colors drift from the real page.
import '../styles/brand-tokens.css';

export const SCENARIOS = ESTIMATE_SCENARIOS.map(([key]) => key);
const scenario = (() => {
  const requested = new URLSearchParams(window.location.search).get('scenario');
  return SCENARIOS.includes(requested) ? requested : 'pest';
})();

// ── fixtures ────────────────────────────────────────────────────────────

// Every date a freshness check inspects (estimate expiration, offered slots,
// the linked appointment) is computed from the clock at load time — a date
// literal goes stale the night the ET calendar passes it, and glassSlotIsStale
// would then disable every offered slot, so the harness would stop
// exercising the selectable-slot and post-selection states (AGENTS.md
// "Hardcoded near-today calendar dates"). Issued/expired literals that no
// validator inspects stay relative too so the hero block reads coherently.
const NOW = new Date();
const isoDaysOut = (days) => addETDays(NOW, days).toISOString();
const etDaysOut = (days) => etDateString(addETDays(NOW, days));

const CONTACT = {
  customerFirstName: 'William',
  customerName: 'William Carter',
  customerEmail: 'william.carter@example.com',
  customerPhone: '9415550123',
  address: '10225 Kalamazoo Pl, Parrish, FL 34219',
};

const BASE_ESTIMATE = {
  id: 1,
  token: 'preview-token',
  // Estimate # + issued/expiration render under the hero contact block on
  // every estimate — the harness carries real-shaped values so the block is
  // exercised in preview.
  slug: 'WPC-2026-0512',
  createdAt: isoDaysOut(0),
  expiresAt: isoDaysOut(7),
  ...CONTACT,
  askToken: 'preview-ask-token',
  category: 'RESIDENTIAL',
  status: 'sent',
  satelliteUrl: null,
  intelligence: null,
  notes: null,
  licenseNumber: 'JB351547',
  showOneTimeOption: false,
  isOneTimeOnly: false,
  defaultServiceMode: 'recurring',
  acceptedServiceMode: null,
  acceptedFrequencyKey: null,
  billByInvoice: false,
  siteConfirmationHold: false,
  acceptance: { mode: 'standard_slot_pick' },
  membership: null,
};

const PEST_INTELLIGENCE = {
  eyebrow: 'Waves AI',
  title: 'Waves AI reviewed your property before pricing this estimate',
  body: 'We reviewed your home, lot, and pest-risk factors before pricing this plan.',
  metrics: [
    { label: 'Home size', value: '2,340 sq ft' },
    { label: 'Lot size', value: '0.21 acres' },
    { label: 'Year built', value: '2024' },
  ],
  signals: [],
};

// Pest service-preference toggles (SERVICE_PREFS interior_spray /
// exterior_sweep) — the "Skip parts you don't need" block. Real payloads
// carry these per frequency with renderFlags.showPestRecurringAddOns.
const PEST_ADD_ONS = [
  { key: 'interior_spray', label: 'Interior spraying', preChecked: true, detail: 'Save $10/visit if removed. No interior treatment — tech sprays and inspects the perimeter only.' },
  { key: 'exterior_sweep', label: 'Exterior eave sweep', preChecked: true, detail: 'Save $10/visit if removed. No eave/cobweb sweep on the exterior — tech still performs the perimeter treatment.' },
];

const CADENCE_VISITS = { quarterly: 4, bi_monthly: 6, monthly: 12 };

const pestFrequency = (key, label, monthly, perVisit, annual) => ({
  key,
  label,
  monthly,
  annual,
  perVisit,
  visitsPerYear: CADENCE_VISITS[key],
  included: [{ key: 'pest_control', label: 'Pest Control', detail: null }],
  addOns: PEST_ADD_ONS,
});

function pestScenario() {
  return {
    estimate: { ...BASE_ESTIMATE, serviceCategory: 'pest_control', intelligence: PEST_INTELLIGENCE },
    pricing: {
      services: [{
        key: 'pest_control',
        label: 'Pest Control',
        isRecurring: true,
        isPest: true,
        waveGuardTierEligible: true,
        defaultFrequencyKey: 'quarterly',
        // Real pest ladder (FREQUENCY_LADDER): quarterly / bi-monthly / monthly.
        // Quarterly = the $94/visit Bronze rounding-artifact repro
        // ($31.33/mo → $93.99/quarter vs $94 anchor).
        frequencies: [
          pestFrequency('quarterly', 'Quarterly', 31.33, 94, 375.96),
          pestFrequency('bi_monthly', 'Bi-monthly', 47, 94, 564),
          pestFrequency('monthly', 'Monthly', 55, 55, 660),
        ],
        setupFee: null,
        quoteRequired: false,
        copy: { priceWording: {} },
      }],
      renderFlags: { showRecurringSummary: false, showWaveGuardSetupFee: false, showPestRecurringAddOns: true, showServiceDetailsRequest: true },
      waveGuardTier: 'Bronze',
      askChips: ['How do you handle ants?', 'Can you treat inside?', 'When am I charged?', 'What happens after approval?'],
      anchorOneTimePrice: 0,
      oneTimeBreakdown: { total: 0, items: [] },
      setupFee: null,
      annualPrepayEligible: true,
      defaultServiceMode: 'recurring',
    },
    cta: { canAccept: true, terminalState: null, quoteRequired: false, quoteRequiredReason: null, reviewBeforeBooking: false },
  };
}

function preslabScenario() {
  return {
    estimate: {
      ...BASE_ESTIMATE,
      serviceCategory: 'pre_slab_termiticide',
      // Mirrors the server's regulated-surface decision on the /data payload.
      regulatedCertificateSurface: true,
      isOneTimeOnly: true,
      defaultServiceMode: 'one_time',
    },
    pricing: {
      services: [],
      renderFlags: {},
      waveGuardTier: null,
      askChips: [],
      anchorOneTimePrice: 1850,
      oneTimeBreakdown: {
        total: 1850,
        items: [{
          service: 'pre_slab_termiticide',
          label: 'Pre-Slab Termiticide Treatment',
          amount: 1850,
          kind: 'charge',
          detail: 'Termidor HE soil treatment — measured slab area, documentation included',
        }],
      },
      setupFee: null,
      annualPrepayEligible: false,
      defaultServiceMode: 'one_time',
    },
    cta: { canAccept: true, terminalState: null, quoteRequired: false, quoteRequiredReason: null, reviewBeforeBooking: false },
  };
}

function bundleScenario() {
  return {
    estimate: { ...BASE_ESTIMATE, serviceCategory: 'bundle', intelligence: PEST_INTELLIGENCE },
    pricing: {
      services: [
        {
          key: 'pest_control',
          label: 'Pest Control',
          isRecurring: true,
          isPest: true,
          waveGuardTierEligible: true,
          defaultFrequencyKey: 'quarterly',
          // $147 anchor, Gold 15% → $124.95/visit: a REAL savings line.
          frequencies: [{
            key: 'quarterly',
            label: 'Quarterly',
            monthly: 41.65,
            annual: 499.8,
            perVisit: 147,
            included: [{ key: 'pest_control', label: 'Pest Control', detail: null }],
            addOns: [],
          }],
          copy: { priceWording: {} },
        },
        {
          key: 'lawn_care',
          label: 'Lawn Care',
          isRecurring: true,
          isPest: false,
          waveGuardTierEligible: true,
          defaultFrequencyKey: 'standard',
          // $100/mo base, Gold 15% → $85/mo. Non-pest rows carry monthlyBase
          // (pre-discount monthly), never perVisit — mirrors the real payload.
          frequencies: [{
            key: 'standard',
            label: 'Lawn Program',
            serviceCategory: 'lawn_care',
            visitsPerYear: 9,
            monthly: 85,
            monthlyBase: 100,
            annual: 1020,
            billingFrequencyKey: 'monthly',
            included: [
              { key: 'fert', label: 'Fertilization + weed control', detail: '9 applications/year' },
              { key: 'pests', label: 'Chinch, sod webworm & turf pest response', detail: null },
            ],
            addOns: [],
          }],
          copy: { priceWording: {} },
        },
        {
          key: 'mosquito',
          label: 'Mosquito',
          isRecurring: true,
          isPest: false,
          waveGuardTierEligible: true,
          defaultFrequencyKey: 'monthly',
          // $61.18/mo base, Gold 15% → $52/mo (real payloads never set
          // perVisit on non-pest rows).
          frequencies: [{
            key: 'monthly',
            label: 'Monthly',
            serviceCategory: 'mosquito',
            visitsPerYear: 12,
            monthly: 52,
            monthlyBase: 61.18,
            annual: 624,
            included: [{ key: 'mosquito', label: 'Mosquito', detail: null }],
            addOns: [],
          }],
          copy: { priceWording: {} },
        },
      ],
      renderFlags: { showRecurringSummary: true, showWaveGuardSetupFee: false, showPestRecurringAddOns: false, showServiceDetailsRequest: true },
      waveGuardTier: 'Gold',
      combinedRecurring: { monthlySubtotal: 178.65, annualSubtotal: 2143.8, waveGuardTierLabel: 'Gold' },
      askChips: ['What is included in this plan?', 'How do you handle ants?', 'What precautions should I follow for pets and children?'],
      anchorOneTimePrice: 0,
      oneTimeBreakdown: { total: 0, items: [] },
      setupFee: null,
      annualPrepayEligible: true,
      defaultServiceMode: 'recurring',
    },
    cta: { canAccept: true, terminalState: null, quoteRequired: false, quoteRequiredReason: null, reviewBeforeBooking: false },
  };
}

function acceptedScenario() {
  const base = pestScenario();
  return {
    ...base,
    estimate: {
      ...base.estimate,
      status: 'accepted',
      acceptedServiceMode: 'recurring',
      acceptedFrequencyKey: 'quarterly',
      // Booked upcoming visit — the server resolves this via
      // findLinkedUpcomingAppointment and ships it on the acceptance
      // contract; the accepted card shows the date instead of
      // "we'll follow up".
      acceptance: {
        mode: 'existing_appointment',
        ctaLabel: 'Confirm invoice option',
        reason: null,
        appointment: {
          id: 'appt-preview-1',
          scheduledDate: etDaysOut(1),
          windowStart: '09:00',
          windowEnd: '10:00',
          windowDisplay: '9:00–10:00 AM',
          serviceType: 'Quarterly Pest Control',
          status: 'confirmed',
        },
      },
    },
    cta: { ...base.cta, canAccept: false, terminalState: 'accepted' },
  };
}

// Lawn-only recurring estimate — exercises the lawn variant of the report
// showcase (lawn health score mock instead of the pest recap video).
function lawnScenario() {
  const bundle = bundleScenario();
  const lawnService = bundle.pricing.services.find((s) => s.key === 'lawn_care');
  return {
    ...bundle,
    // Mirrors the real lawn-program + one-time-curative shape (e.g. a chinch
    // knockdown quoted alongside the program): show_one_time_option on with a
    // priced one_time_lawn row, so the harness exercises the recurring/one-time
    // mode toggle on a lawn-only estimate.
    estimate: { ...bundle.estimate, serviceCategory: 'lawn_care', showOneTimeOption: true },
    // Mirrors the GATE_ESTIMATE_SERVICE_ADD /data stamp: the page's mirror
    // offer (Mosquito on this mix) prices in place through the opt-out rail.
    serviceOptOut: { removedKeys: [], removedLabels: [], addable: [{ key: 'mosquito', label: 'Mosquito' }] },
    pricing: {
      ...bundle.pricing,
      services: [lawnService],
      renderFlags: { showRecurringSummary: false, showWaveGuardSetupFee: false, showPestRecurringAddOns: false },
      waveGuardTier: null,
      combinedRecurring: null,
      anchorOneTimePrice: 174,
      oneTimeBreakdown: {
        total: 174,
        items: [{ service: 'one_time_lawn', label: 'One-Time Lawn', amount: 174, detail: 'Single treatment', kind: 'charge' }],
      },
      askChips: ['What is included in the lawn program?', 'How fast will my lawn improve?', 'What precautions should I follow for pets and children?'],
    },
  };
}

// Existing-member tier upgrade (owner decision 2026-08-10): a Bronze
// quarterly-pest member adding lawn — combined Silver. Exercises
// ExistingPlanUpgradeCard: the current pest plan's upcoming visits listed
// with the contracted price struck through and the Silver figure beside it,
// exactly the frozen publicMembershipView shape the server projects.
function lawnMemberUpgradeScenario() {
  const lawn = lawnScenario();
  return {
    ...lawn,
    estimate: {
      ...lawn.estimate,
      customerFirstName: 'Riley',
      customerName: 'Riley H.',
      showOneTimeOption: false,
      membership: {
        isExistingCustomer: true,
        firstName: 'Riley',
        tier: 'silver',
        tierLabel: 'Silver',
        tierDiscountPct: 10,
        discountAppliesTo: 'new_and_existing_services',
        existingServiceKeys: ['pest_control'],
        upgrade: { fromLabel: 'Bronze', toLabel: 'Silver', deltaPct: 10, addedServiceLabels: ['Lawn Care'] },
        existingServices: [{
          key: 'pest_control',
          label: 'Pest Control',
          currentPerVisit: 55,
          newPerVisit: 49.5,
          extraDiscountPct: 10,
          perVisitSavings: 5.5,
          remainingVisits: 2,
          upcomingVisitDates: ['2026-10-28', '2027-01-27'],
          prepaid: false,
        }],
        newServices: [{ key: 'lawn_care', label: 'Lawn Care', discountPct: 10, monthlySavings: 7.75, perApplicationSavings: 10.33 }],
      },
    },
    pricing: { ...lawn.pricing, waveGuardTier: 'Silver' },
  };
}

// Pest + Lawn WITH a Referral Credit — the exact split payload the server now
// produces after the reconciliation fix (a referral no longer collapses the
// plan into the badge-free bundle card). Numbers mirror the real Silver
// pest+lawn draft: per-service cards show WaveGuard-net prices (pre-referral),
// and the referral + net live in the plan-level discount summary.
function bundleReferralScenario() {
  return {
    estimate: { ...BASE_ESTIMATE, serviceCategory: 'bundle', intelligence: PEST_INTELLIGENCE },
    pricing: {
      services: [
        {
          key: 'pest_control',
          label: 'Pest Control',
          isRecurring: true,
          isPest: true,
          waveGuardTierEligible: true,
          defaultFrequencyKey: 'quarterly',
          // Silver 10% off: $107 anchor → $96.30/visit.
          frequencies: [
            {
              key: 'quarterly', label: 'Quarterly', monthly: 32.10, annual: 385.20, perVisit: 107,
              perServiceTreatments: [{ service: 'pest_control', label: 'Pest Control (Quarterly)', displayPrice: 96.30, perTreatment: 107, visitsPerYear: 4 }],
              included: [{ key: 'pest_control', label: 'Pest Control', detail: null }], addOns: [],
            },
            {
              key: 'bi_monthly', label: 'Bi-monthly', monthly: 40.93, annual: 491.16, perVisit: 90.95,
              included: [{ key: 'pest_control', label: 'Pest Control', detail: null }], addOns: [],
            },
            {
              key: 'monthly', label: 'Monthly', monthly: 67.41, annual: 808.92, perVisit: 67.41,
              included: [{ key: 'pest_control', label: 'Pest Control', detail: null }], addOns: [],
            },
          ],
          copy: { priceWording: {} },
        },
        {
          key: 'lawn_care',
          label: 'Lawn Care',
          isRecurring: true,
          isPest: false,
          waveGuardTierEligible: true,
          defaultFrequencyKey: 'enhanced',
          // Silver 10% off: $57.75/mo base → $51.98/mo.
          frequencies: [
            {
              key: 'enhanced', label: 'Lawn Program', serviceCategory: 'lawn_care', visitsPerYear: 9,
              monthly: 51.98, monthlyBase: 57.75, annual: 623.76, billingFrequencyKey: 'monthly',
              included: [
                { key: 'fert', label: 'Fertilization + weed control', detail: '9 applications/year' },
                { key: 'pests', label: 'Chinch, sod webworm & turf pest response', detail: null },
              ],
              addOns: [],
            },
            {
              key: 'premium', label: 'Premium', serviceCategory: 'lawn_care', visitsPerYear: 12,
              monthly: 71.10, monthlyBase: 79, annual: 853.20, billingFrequencyKey: 'monthly',
              included: [
                { key: 'fert', label: 'Fertilization + weed control', detail: '12 applications/year' },
                { key: 'pests', label: 'Chinch, sod webworm & turf pest response', detail: null },
              ],
              addOns: [],
            },
          ],
          copy: { priceWording: {} },
        },
      ],
      renderFlags: { showRecurringSummary: true, showWaveGuardSetupFee: false, showPestRecurringAddOns: false },
      waveGuardTier: 'Silver',
      combinedRecurring: {
        monthlySubtotal: 82,
        annualSubtotal: 984,
        waveGuardTierLabel: 'Silver',
        manualDiscount: {
          label: 'Referral Credit', type: 'FIXED', value: 25,
          amount: 25, recurringAmount: 25, monthlyAmount: 2.08,
        },
      },
      askChips: ['What is included in this plan?', 'How do you handle ants?', 'What precautions should I follow for pets and children?'],
      anchorOneTimePrice: 0,
      oneTimeBreakdown: { total: 0, items: [] },
      setupFee: null,
      annualPrepayEligible: true,
      defaultServiceMode: 'recurring',
    },
    cta: { canAccept: true, terminalState: null, quoteRequired: false, quoteRequiredReason: null, reviewBeforeBooking: false },
  };
}

// Authored commercial proposal (GATE_ESTIMATE_COMMERCIAL_GLASS): quote-required
// by design, no online checkout — the page renders the ProposalDetailCard +
// TerminalStateCard. Fictional numbers shaped like a small-commercial proposal
// ($120/quarter). With ?mode=pdf this same payload renders the
// EstimateProposalDocument print artifact.
function proposalScenario() {
  return {
    estimate: {
      ...BASE_ESTIMATE,
      category: 'COMMERCIAL',
      serviceCategory: 'commercial',
      customerFirstName: 'Morgan',
      customerName: 'Morgan Example',
      address: '600 Sample Plaza Dr, Sarasota, FL 34299',
      intelligence: {
        eyebrow: 'Waves AI',
        title: 'Waves AI reviewed your property before pricing this proposal',
        body: 'We measured your building, lot, and grounds from satellite imagery and county property records before pricing this plan.',
        metrics: [
          { label: 'Building', value: '2,446 sq ft' },
          { label: 'Lot size', value: '5,850 sq ft' },
          { label: 'Stories', value: '2' },
        ],
        signals: [],
      },
    },
    proposal: {
      enabled: true,
      synthesized: false,
      pestRecurringOnly: true,
      title: 'Commercial Service Proposal',
      preparedFor: 'Morgan Example',
      propertyAddress: '600 Sample Plaza Dr, Sarasota, FL 34299',
      taxRate: 0.07,
      taxLabel: 'Sales tax',
      terms: null,
      buildings: [{
        name: '600 Sample Plaza Dr',
        note: null,
        lineItems: [{
          description: 'Quarterly pest control — small multifamily building (interior + exterior)',
          quantity: 1,
          unitPrice: 120,
          amount: 120,
          frequency: 'quarterly',
          frequencyLabel: 'Quarterly',
          taxable: true,
        }],
      }],
      totals: {
        annualRecurring: 480.00,
        monthlyEquivalent: 40.00,
        oneTime: 0,
        totalTax: 33.60,
        firstYearTotal: 513.60,
        hasTax: true,
        isMultiBuilding: false,
      },
    },
    pricing: {
      services: [],
      renderFlags: {},
      askChips: ['What does each visit include?', 'Do you treat inside the units?', 'What if a tenant reports a pest?'],
      oneTimeBreakdown: { total: 0, items: [] },
      defaultServiceMode: 'recurring',
    },
    cta: {
      canAccept: false,
      terminalState: 'quote_required',
      quoteRequired: true,
      quoteRequiredReason: 'commercial_proposal',
      reviewBeforeBooking: false,
      commercialProposal: true,
      commercialAutoPriced: false,
      commercialGlass: true,
      proposalPdfEmailed: false,
    },
  };
}

// Authored proposal WITH operator terms (codex #3281 r3): the terms govern,
// so the page must read the terms-neutral commercial pack — no pest hero
// promises, no canned inclusions beside the authored 12-month commitment.
// Same fictional shape as proposalScenario with a mixed taxable/exempt line
// pair, so ?mode=pdf also proves the taxable '*' marker and rate disclosure.
function proposalTermsScenario() {
  const base = proposalScenario();
  return {
    ...base,
    proposal: {
      ...base.proposal,
      // The rodent monitoring line makes the server's truth-scope classifier
      // return false here — the fixture mirrors what /data would project.
      pestRecurringOnly: false,
      terms: '12-month service agreement. Cancellation requires 30 days’ written notice. Interior service visits beyond the quarterly schedule are billed per visit.',
      buildings: [{
        name: '600 Sample Plaza Dr',
        note: null,
        lineItems: [
          {
            description: 'Quarterly pest control — small multifamily building (interior + exterior)',
            quantity: 1,
            unitPrice: 120,
            amount: 120,
            frequency: 'quarterly',
            frequencyLabel: 'Quarterly',
            taxable: true,
          },
          {
            description: 'Grounds rodent station monitoring',
            quantity: 1,
            unitPrice: 65,
            amount: 65,
            frequency: 'quarterly',
            frequencyLabel: 'Quarterly',
            taxable: false,
          },
        ],
      }],
      totals: {
        annualRecurring: 740.00,
        monthlyEquivalent: 61.67,
        oneTime: 0,
        taxRate: 0.07,
        totalTax: 33.60,
        firstYearTotal: 773.60,
        hasTax: true,
        isMultiBuilding: false,
      },
    },
  };
}

// Structured proposal sections (slice 1A-i): property scope + corrective
// work + responsibilities + structured commercial terms, with free-text terms
// demoted to "Additional terms". Fictional numbers; corrective work folds
// into the one-time/first-year totals exactly like computeProposalTotals.
function proposalStructuredScenario() {
  const base = proposalScenario();
  return {
    ...base,
    proposal: {
      ...base.proposal,
      propertyScope: {
        items: [
          { label: 'Units', value: '4 residential units, tenant-occupied' },
          { label: 'Building', value: '2,446 sq ft · 2 stories' },
          { label: 'Grounds', value: '5,850 sq ft lot with shared courtyard' },
        ],
      },
      correctiveWork: [{
        label: 'Initial German roach cleanout — Units 2 & 4',
        amount: 450,
        taxable: true,
        includes: ['Crack & crevice treatment in both kitchens', 'Follow-up inspection at 2 weeks'],
      }],
      customerResponsibilities: [
        'Provide unit access with 24-hour tenant notice',
        'Report pest activity through the Waves app or office line',
      ],
      commercialTerms: {
        paymentTerms: 'net30',
        initialTermMonths: 0,
        renewal: null,
        priceAdjustment: 'Rates reviewed annually with 30-day notice',
        cancellation: '30-day written notice, no cancellation fee',
        accessRequirements: 'Office provides common-area keys',
      },
      terms: 'Interior service visits beyond the quarterly schedule are billed per visit.',
      totals: {
        annualRecurring: 480.00,
        monthlyEquivalent: 40.00,
        oneTime: 450.00,
        taxRate: 0.07,
        taxableOneTime: 450.00,
        totalTax: 65.10,          // (480 + 450) taxable * 0.07
        firstYearTotal: 995.10,   // 480 + 450 + 65.10
        hasTax: true,
        isMultiBuilding: false,
      },
    },
  };
}

// Programs-mode proposal (slice 1A-ii): generated service programs replace
// building line items as the recurring itemization. Fictional numbers.
function proposalProgramsScenario() {
  const base = proposalScenario();
  return {
    ...base,
    proposal: {
      ...base.proposal,
      buildings: [],
      // Mixed pest+mosquito programs — the server's truth-scope classifier
      // returns false for any non-pest program, so the fixture mirrors it
      // (terms line renders neutral, no pest-plan claims).
      pestRecurringOnly: false,
      propertyScope: {
        items: [
          { label: 'Building', value: '2,446 sq ft · 2 stories' },
          { label: 'Units', value: '4 residential units, tenant-occupied' },
        ],
      },
      programs: [
        {
          service: 'pest',
          label: 'Quarterly pest program',
          frequencyPerYear: 4,
          pricePerApplication: 120,
          annual: 480,
          taxable: true,
          note: null,
          inclusions: [
            '4 scheduled applications per year',
            'Recurring exterior treatment — foundation, entry points, and grounds on your scheduled cadence',
            'Interior treatment available on every visit — priced from your building, no surprise fees',
            'Tenant-reported pests handled between visits — re-service requests are included in the plan',
            'Every visit documented — time on site, areas treated, and products applied',
          ],
          exclusions: [
            'Termite treatment or monitoring — separate program, quoted on inspection',
            'German cockroach cleanouts — quoted separately as one-time corrective work',
          ],
          buildings: [{ name: 'Main building' }, { name: 'Shared courtyard' }],
        },
        {
          service: 'mosquito',
          label: 'Mosquito program',
          frequencyPerYear: 9,
          pricePerApplication: 65,
          annual: 585,
          taxable: true,
          note: null,
          inclusions: [
            '9 scheduled applications per year',
            'Every visit documented — time on site, areas treated, and products applied',
          ],
          exclusions: ['One-time event sprays — quoted separately'],
          buildings: [],
        },
      ],
      customerResponsibilities: [
        'Provide unit or interior access with reasonable notice when interior service is requested',
        'Empty or report standing water (plant saucers, gutters, containers) between visits',
      ],
      totals: {
        annualRecurring: 1065,
        monthlyEquivalent: 88.75,
        oneTime: 0,
        taxRate: 0.07,
        taxableAnnualRecurring: 1065,
        totalTax: 74.55,
        firstYearTotal: 1139.55,
        hasTax: true,
        isMultiBuilding: false,
      },
    },
  };
}

// Auto-priced solo commercial pest with the interior-service option snapshot
// (owner 2026-08-17): one server-shaped monthly frequency (commercial sells a
// single cadence) + section.interiorOption exactly as
// attachCommercialInteriorSelector emits it gate-on. Figures are the real
// engine outputs for a 3,000 sqft building (see
// server/tests/commercial-pest-interior-option.test.js).
function commercialScenario() {
  return {
    estimate: {
      ...BASE_ESTIMATE,
      category: 'COMMERCIAL',
      serviceCategory: 'commercial_pest',
      customerFirstName: 'Cameron',
      customerName: 'Cameron Ellis',
      address: '6220 University Pkwy, Sarasota, FL 34240',
    },
    pricing: {
      services: [{
        key: 'commercial_pest',
        label: 'Commercial Pest Control',
        isRecurring: true,
        isPest: false,
        waveGuardTierEligible: false,
        defaultFrequencyKey: 'monthly',
        frequencies: [{
          key: 'monthly',
          label: 'Monthly',
          serviceCategory: 'commercial_pest',
          serviceTierKey: 'monthly',
          monthlyBase: 121.02,
          monthly: 121.02,
          annual: 1452.22,
          perTreatment: 121.02,
          visitsPerYear: 12,
          billingFrequencyKey: 'monthly',
          billedPerApplication: true,
          manualDiscount: null,
          included: [{
            key: 'commercial_pest_monthly',
            label: 'Monthly commercial pest program',
            detail: '12 visits per year',
            includedAtThisFrequency: true,
          }],
          addOns: [],
          perServiceTreatments: [{
            service: 'commercial_pest',
            label: 'Commercial Pest Control',
            perTreatment: 121.02,
            displayPrice: 121.02,
            visitsPerYear: 12,
            waveGuardDiscountEligible: false,
          }],
        }],
        interiorOption: {
          selected: true,
          label: 'Interior service',
          perApplicationAdd: 41.52,
          monthlyAdd: 41.52,
          annualAdd: 498.18,
          detail: 'Interior treatment on every visit. Remove it and visits treat the exterior barrier only — add it back anytime before you approve, or through our office afterward.',
        },
        setupFee: null,
        quoteRequired: false,
        copy: { priceWording: {} },
      }],
      renderFlags: { showRecurringSummary: false, showWaveGuardSetupFee: false, showPestRecurringAddOns: false },
      waveGuardTier: 'Commercial',
      askChips: ['What does each visit include?', 'Do you treat inside the units?', 'What if a tenant reports a pest?', 'How do I cancel if I need to?'],
      anchorOneTimePrice: 0,
      oneTimeBreakdown: { total: 0, items: [] },
      setupFee: null,
      annualPrepayEligible: true,
      defaultServiceMode: 'recurring',
    },
    cta: { canAccept: true, terminalState: null, quoteRequired: false, quoteRequiredReason: null, reviewBeforeBooking: false, commercialGlass: true, commercialAutoPriced: true },
  };
}

const recurringFixture = ({ key, label, category = key, monthly, visitsPerYear, included = [], intelligence = null }) => ({
  estimate: { ...BASE_ESTIMATE, serviceCategory: category, intelligence },
  pricing: {
    services: [{
      key,
      label,
      isRecurring: true,
      isPest: key === 'pest_control',
      waveGuardTierEligible: !key.startsWith('commercial_'),
      defaultFrequencyKey: visitsPerYear === 12 ? 'monthly' : 'standard',
      frequencies: [{
        key: visitsPerYear === 12 ? 'monthly' : 'standard',
        label: visitsPerYear === 12 ? 'Monthly' : `${visitsPerYear} applications/year`,
        serviceCategory: category,
        visitsPerYear,
        monthly,
        annual: monthly * 12,
        perTreatment: Math.round((monthly * 12 / visitsPerYear) * 100) / 100,
        billingFrequencyKey: 'monthly',
        billedPerApplication: true,
        included: included.length ? included : [{ key, label, detail: `${visitsPerYear} scheduled applications per year` }],
        addOns: [],
      }],
      setupFee: null,
      quoteRequired: false,
      copy: { priceWording: {} },
    }],
    renderFlags: { showRecurringSummary: false, showWaveGuardSetupFee: false, showPestRecurringAddOns: false, showServiceDetailsRequest: true },
    waveGuardTier: 'Bronze',
    askChips: [],
    anchorOneTimePrice: 0,
    oneTimeBreakdown: { total: 0, items: [] },
    setupFee: null,
    annualPrepayEligible: true,
    defaultServiceMode: 'recurring',
  },
  cta: { canAccept: true, terminalState: null, quoteRequired: false, quoteRequiredReason: null, reviewBeforeBooking: false },
});

const oneTimeFixture = ({ category, service, label, amount, detail, intelligence = null, reviewBeforeBooking = false, regulated = false }) => ({
  estimate: { ...BASE_ESTIMATE, serviceCategory: category, intelligence, isOneTimeOnly: true, defaultServiceMode: 'one_time', ...(regulated ? { regulatedCertificateSurface: true } : {}) },
  pricing: {
    services: [],
    renderFlags: {},
    waveGuardTier: null,
    askChips: [],
    anchorOneTimePrice: amount,
    oneTimeBreakdown: { total: amount, items: [{ service, label, amount, detail, kind: 'charge' }] },
    setupFee: null,
    annualPrepayEligible: false,
    defaultServiceMode: 'one_time',
  },
  cta: { canAccept: true, terminalState: null, quoteRequired: false, quoteRequiredReason: null, reviewBeforeBooking },
});

function mosquitoScenario() {
  return recurringFixture({
    key: 'mosquito', label: 'Mosquito Control', category: 'mosquito', monthly: 59, visitsPerYear: 9,
    intelligence: { eyebrow: 'Waves AI', title: 'Waves AI reviewed your lot and mosquito pressure before pricing this estimate', body: 'We reviewed the mapped lot, vegetation, and mosquito resting zones supplied with this estimate.', metrics: [{ label: 'Lot size', value: '0.24 acres' }, { label: 'Season', value: '9 applications' }], signals: [] },
  });
}

function treeShrubScenario() {
  return recurringFixture({
    key: 'tree_shrub', label: 'Tree & Shrub Care', category: 'tree_shrub', monthly: 72, visitsPerYear: 6,
    intelligence: { eyebrow: 'Waves AI', title: 'Waves AI reviewed your beds and trees before pricing this estimate', body: 'We reviewed the recorded bed area and plant inventory used to prepare this estimate.', metrics: [{ label: 'Bed area', value: '2,100 sq ft' }, { label: 'Recorded trees', value: '14' }], signals: [] },
  });
}

function termiteBaitScenario() {
  return recurringFixture({
    key: 'termite_bait', label: 'Termite Bait Monitoring', category: 'termite_bait', monthly: 49, visitsPerYear: 4,
    intelligence: { eyebrow: 'Waves AI', title: 'Waves AI reviewed your termite perimeter before pricing this estimate', body: 'We reviewed the measured perimeter and station count attached to this estimate.', metrics: [{ label: 'Perimeter', value: '248 linear ft' }, { label: 'Stations', value: '24' }], signals: [] },
  });
}

function rodentScenario() {
  return recurringFixture({
    key: 'rodent_bait', label: 'Rodent Bait Station Monitoring', category: 'rodent', monthly: 69, visitsPerYear: 6,
    intelligence: { eyebrow: 'Waves AI', title: 'Property conditions reviewed for this rodent plan', body: 'This plan uses the recorded exterior station count and monitoring cadence; it does not promise exclusion work.', metrics: [{ label: 'Stations', value: '6' }, { label: 'Monitoring', value: 'Every other month' }], signals: [] },
  });
}

function wdoScenario() {
  return oneTimeFixture({ category: 'wdo_inspection', service: 'wdo_inspection', label: 'WDO Inspection', amount: 125, detail: 'Wood-destroying organism inspection with required Florida reporting', regulated: true });
}

function termiteFoamScenario() {
  return oneTimeFixture({ category: 'termite_foam', service: 'termite_foam', label: 'Termite Foam Treatment', amount: 180, detail: 'Localized foam treatment for the identified treatment area' });
}

function boraCareScenario() {
  return oneTimeFixture({ category: 'bora_care', service: 'bora_care', label: 'Bora-Care Wood Treatment Service', amount: 1051, detail: 'Measured bare-wood treatment areas', reviewBeforeBooking: true });
}

function trapOnlyScenario() {
  const base = oneTimeFixture({ category: 'trap_only', service: 'trap_only_retainer', label: 'Standard Trap-Only Monitoring Retainer', amount: 495, detail: '12-month monitoring retainer' });
  return {
    ...base,
    pricing: {
      ...base.pricing,
      anchorOneTimePrice: 694,
      oneTimeBreakdown: { total: 694, items: [
        { service: 'trap_only_retainer', label: 'Standard Trap-Only Monitoring Retainer', amount: 495, detail: '12-month monitoring retainer', kind: 'charge' },
        { service: 'trap_only_setup', label: 'Trap-Only Setup / Inspection', amount: 199, detail: 'Initial setup and property inspection', kind: 'charge' },
      ] },
    },
  };
}

function quoteRequiredScenario() {
  const base = oneTimeFixture({ category: 'pest_control', service: 'bed_bug_heat', label: 'Bed Bug Heat Treatment', amount: 0, detail: 'An inspection is required before final pricing.' });
  return {
    ...base,
    pricing: { ...base.pricing, anchorOneTimePrice: 0, oneTimeBreakdown: { total: 0, items: [{ service: 'bed_bug_heat', label: 'Bed Bug Heat Treatment', amount: null, quoteRequired: true, kind: 'quote_required', customQuoteReason: 'An inspection is required before final pricing.' }] } },
    cta: { canAccept: false, terminalState: 'quote_required', quoteRequired: true, quoteRequiredReason: 'inspection_required', reviewBeforeBooking: true },
  };
}

function expiredScenario() {
  const base = pestScenario();
  return { ...base, estimate: { ...base.estimate, status: 'expired', expiresAt: isoDaysOut(-8) }, cta: { ...base.cta, canAccept: false, terminalState: 'expired' } };
}

function missingContactScenario() {
  const base = mosquitoScenario();
  return { ...base, estimate: { ...base.estimate, customerFirstName: null, customerName: null, customerEmail: null, customerPhone: null, address: null } };
}

function longContentScenario() {
  const base = bundleReferralScenario();
  return {
    ...base,
    estimate: {
      ...base.estimate,
      customerFirstName: 'Alexandria-Catherine',
      customerName: 'Alexandria-Catherine Montgomery-Worthington for Gulf Coast Community Property Holdings, LLC',
      customerEmail: 'alexandria.montgomery-worthington+property-management@example-development-company.com',
      customerPhone: '9415550199',
      address: '18472 West Lakewood Ranch Boulevard, Building 14, Suite 1208, Lakewood Ranch, Florida 34211-8472',
      slug: 'WPC-2026-EXTREMELY-LONG-CUSTOMER-CONTENT-TEST',
    },
  };
}

const PAYLOADS = {
  pest: pestScenario,
  mosquito: mosquitoScenario,
  tree_shrub: treeShrubScenario,
  termite_bait: termiteBaitScenario,
  rodent: rodentScenario,
  wdo: wdoScenario,
  termite_foam: termiteFoamScenario,
  bora_care: boraCareScenario,
  trap_only: trapOnlyScenario,
  quote_required: quoteRequiredScenario,
  preslab: preslabScenario,
  bundle: bundleScenario,
  bundle_referral: bundleReferralScenario,
  lawn: lawnScenario,
  lawn_member_upgrade: lawnMemberUpgradeScenario,
  accepted: acceptedScenario,
  expired: expiredScenario,
  missing_contact: missingContactScenario,
  long_content: longContentScenario,
  proposal: proposalScenario,
  proposal_terms: proposalTermsScenario,
  proposal_structured: proposalStructuredScenario,
  proposal_programs: proposalProgramsScenario,
  commercial: commercialScenario,
};

// ── canned endpoint responses ───────────────────────────────────────────

const SLOTS = {
  nearby: true,
  primary: [
    { slotId: 's1', date: etDaysOut(1), windowStart: '09:00', windowEnd: '10:00', routeOptimal: true, techFirstName: 'Adam' },
    { slotId: 's2', date: etDaysOut(2), windowStart: '11:00', windowEnd: '12:00' },
    { slotId: 's3', date: etDaysOut(4), windowStart: '09:00', windowEnd: '10:00' },
    { slotId: 's4', date: etDaysOut(5), windowStart: '13:00', windowEnd: '14:00' },
    { slotId: 's5', date: etDaysOut(6), windowStart: '09:00', windowEnd: '10:00', routeOptimal: true, techFirstName: 'Adam' },
    { slotId: 's6', date: etDaysOut(7), windowStart: '15:00', windowEnd: '16:00' },
  ],
  expander: [
    { slotId: 's7', date: etDaysOut(8), windowStart: '09:00', windowEnd: '10:00' },
    { slotId: 's8', date: etDaysOut(9), windowStart: '10:00', windowEnd: '11:00' },
  ],
};

const REVIEWS = {
  reviews: [
    { reviewerName: 'Dana R.', starRating: 5, location: 'Parrish', text: 'Waves has been fantastic — always on time, super thorough, and the ants that plagued our lanai are completely gone.' },
    { reviewerName: 'Mike T.', starRating: 5, location: 'Sarasota', text: 'Great communication from booking to service day. The tech walked me through everything he treated around the house.' },
    { reviewerName: 'Karen L.', starRating: 5, location: 'Lakewood Ranch', text: 'We switched from a national chain and the difference is night and day. Family-owned and it shows in the service.' },
    { reviewerName: 'Josh P.', starRating: 5, location: 'Venice', text: 'Booked online in two minutes, tech showed up in the promised window, and the report with photos was a nice touch.' },
    { reviewerName: 'Elaine S.', starRating: 5, location: 'Bradenton', text: 'Our lawn was full of chinch bug damage — six months with Waves and it is the greenest yard on the street.' },
    { reviewerName: 'Robert G.', starRating: 5, location: 'Parrish', text: 'Honest pricing, no upsell pressure, and they actually answer the phone. Could not recommend them more highly.' },
  ],
  aggregate: { averageRating: '5.0', totalCount: 6 },
};

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  const respond = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  if (url.includes('/api/estimates/') && url.includes('/data')) {
    // Prod sends glassDefault per eligible category with the gate unset =
    // ALL categories, so the harness mirrors the live copy pack. The pdf
    // pass mirrors the server's gated /data payload: every estimate carries
    // a proposal block for the print document (the authored one, or the
    // synthesized single-building fallback that IS an ordinary estimate's
    // pricing table), and documentRender is affirmed only when that block
    // built with a priced line — otherwise ?mode=pdf falls through to the
    // normal page exactly like production.
    const pdfPass = new URLSearchParams(window.location.search).get('mode') === 'pdf';
    // returnVisit mirrors the GATE_ESTIMATE_RETURN_VISIT projection on a
    // second visit so the welcome-back strip is exercised in preview
    // (?visit=first suppresses it).
    const firstVisit = new URLSearchParams(window.location.search).get('visit') === 'first';
    const returnVisit = firstVisit ? {} : {
      returnVisit: {
        visitNumber: 3,
        lastVisitAt: '2026-07-10T15:30:00.000Z',
        changes: scenario === 'lawn'
          ? [{ kind: 'extension_granted', label: 'Your expiration date was extended.', at: '2026-07-11T12:00:00.000Z' }]
          : [],
      },
    };
    const payload = PAYLOADS[scenario]();
    const proposal = payload.proposal || (pdfPass ? synthesizeDocumentProposal(payload) : null);
    // lawnCalendar / referral mirror the GATE_ESTIMATE_LAWN_CALENDAR and
    // GATE_ESTIMATE_SUCCESS_REFERRAL /data blocks so both render in preview.
    // The lawn fixture is the catalog's 9-application program.
    const referral = scenario === 'accepted' ? { referral: { headline: 'Know someone who could use Waves?', cta: 'Send My Referral Link' } } : {};
    return respond({
      ...payload,
      ...(pdfPass && proposal ? { proposal } : {}),
      glassDefault: true,
      ...returnVisit,
      lawnCalendar: { programs: { standard: { visitsPerYear: 9 } } },
      ...referral,
      // softExit mirrors the GATE_ESTIMATE_SOFT_EXIT /data flag on a live row so
      // the "Not what you expected?" sheet is exercised in preview.
      softExit: true,
      softExitChange: true,
      ...(pdfPass && documentRenderAffirmed(proposal) ? { documentRender: true } : {}),
    });
  }
  if (url.includes('/referral-link')) {
    return respond({ code: 'WAVES-PREVIEW1', link: 'https://wavespestcontrol.com/r/WAVES-PREVIEW1', smsBody: 'We use Waves Pest Control and they’ll take $25 off your first service with my code WAVES-PREVIEW1. wavespestcontrol.com/r/WAVES-PREVIEW1', emailSubject: '$25 off Waves Pest Control', emailBody: 'We use Waves Pest Control and they’ll take $25 off your first service with my code WAVES-PREVIEW1.\n\nhttps://wavespestcontrol.com/r/WAVES-PREVIEW1' });
  }
  if (url.includes('/change-request') || url.endsWith('/decline')) {
    return respond({ success: true, deduped: false });
  }
  if (url.includes('/available-slots')) {
    const params = new URL(url, window.location.origin).searchParams;
    // Picked-date search: return a small subset so the flow is visible.
    if (params.get('date')) return respond({ nearby: false, primary: SLOTS.primary.slice(1, 3), expander: [] });
    return respond(SLOTS);
  }
  if (url.includes('/find-slots')) {
    return respond({ summary: 'Here’s what’s open around then:', nearby: true, primary: SLOTS.primary.slice(0, 3), expander: [] });
  }
  if (url.includes('/preferences')) {
    return respond({ saved: true });
  }
  if (url.includes('/service-opt-out')) {
    // Priced add / restore dry run: real-shaped disclosures, no combined totals.
    return respond({
      success: true, dryRun: true, mode: 'add', serviceKey: 'mosquito', label: 'Mosquito', included: true,
      previous: { monthlyTotal: 85, annualTotal: 1020, onetimeTotal: 0, waveGuardTier: 'Bronze' },
      next: { monthlyTotal: 125, annualTotal: 1500, onetimeTotal: 99, waveGuardTier: 'Silver' },
      previewBasis: 'preview-basis',
      disclosures: [
        { code: 'waveguard_tier_change', message: 'Adding Mosquito moves your WaveGuard tier from Bronze to Silver, so your services are priced at the Silver rate.' },
        { code: 'added_per_application', message: 'Mosquito is $60.00 per application.' },
        { code: 'recurring_per_application', message: 'Lawn Care changes from $113.33 to $102.00 per application.' },
      ],
    });
  }
  if (url.includes('/reviews/featured')) {
    return respond(REVIEWS);
  }
  if (url.startsWith('/api/')) {
    // Any other portal call is inert in the harness.
    return respond({ error: 'preview-harness: endpoint not mocked' }, 404);
  }
  return originalFetch(input, init);
};

// ── scenario switcher chrome ────────────────────────────────────────────

function ScenarioBar() {
  if (new URLSearchParams(window.location.search).get('chrome') === '0') return null;
  return (
    <div style={{
      position: 'fixed', bottom: 14, left: 14, right: 14, zIndex: 9999,
      background: '#0F172A', color: '#fff', borderRadius: 10,
      padding: '8px 10px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
      fontFamily: "'Inter', system-ui, sans-serif", fontSize: 12,
      boxShadow: '0 8px 24px rgba(15,23,42,.35)',
    }}>
      <a href="/preview-estimate-gallery.html" style={{ color: '#FFD700', fontWeight: 800, marginRight: 4 }}>gallery</a>
      <span style={{ opacity: 0.6, marginRight: 2 }}>preview:</span>
      {SCENARIOS.map((s) => (
        <a
          key={s}
          href={`/preview-estimate.html?scenario=${s}`}
          style={{
            color: s === scenario ? '#0F172A' : '#fff',
            background: s === scenario ? '#FFD700' : 'transparent',
            border: '1px solid rgba(255,255,255,.25)',
            borderRadius: 6, padding: '3px 8px', textDecoration: 'none', fontWeight: 700,
          }}
        >
          {s}
        </a>
      ))}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={['/estimate/preview-token']}>
      <Routes>
        {/* Same shell chrome as the real /estimate/:token route in App.jsx —
            previews must show the universal header/footer (owner 2026-07-09). */}
        <Route path="/estimate/:token" element={<WavesShell><EstimateViewPage /></WavesShell>} />
      </Routes>
    </MemoryRouter>
    <ScenarioBar />
  </React.StrictMode>,
);

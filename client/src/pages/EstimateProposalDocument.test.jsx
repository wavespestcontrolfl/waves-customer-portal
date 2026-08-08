// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import EstimateProposalDocument from './EstimateProposalDocument';
import { GLASS_COPY } from '../lib/estimate-glass-copy';

afterEach(() => {
  delete window.__WAVES_PDF_IMAGE_FAILURES;
});

const BASE_DATA = {
  publicOrigin: 'https://portal.wavespestcontrol.com',
  estimate: {
    token: 'tok-123',
    slug: 'EST-2099-0001',
    customerName: 'Pat Example',
    customerPhone: '+19415551234',
    customerEmail: 'pat@example.com',
    address: '600 Sample Plaza Dr, Sarasota, FL 34299',
    createdAt: '2026-08-06T14:57:32.162Z',
    expiresAt: '2026-09-06T00:00:00.000Z',
    licenseNumber: 'JB351547',
    category: 'COMMERCIAL',
    isOneTimeOnly: false,
    intelligence: {
      title: 'Waves AI reviewed your property',
      body: 'We measured your building and lot before pricing this plan.',
      metrics: [{ label: 'Building', value: '2,446 sq ft' }],
      signals: [],
    },
    satelliteUrl: null,
  },
  proposal: {
    enabled: true,
    synthesized: false,
    pestRecurringOnly: true,
    title: 'Commercial Service Proposal',
    preparedFor: 'Pat Example',
    propertyAddress: '600 Sample Plaza Dr, Sarasota, FL 34299',
    taxLabel: 'Sales tax',
    terms: null,
    buildings: [{
      name: '600 Sample Plaza Dr',
      note: null,
      lineItems: [{
        description: 'Recurring service plan',
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
  cta: { commercialProposal: true, commercialAutoPriced: false },
};

describe('EstimateProposalDocument', () => {
  it('renders the authored commercial proposal as a document', () => {
    const { container } = render(<EstimateProposalDocument data={BASE_DATA} token="tok-123" />);
    expect(container.querySelector('.estimate-document-v1')).toBeTruthy();
    const text = container.textContent;
    expect(text).toContain('Commercial Service Proposal');
    expect(text).toContain('Recurring service plan');
    expect(text).toContain('$513.60');
    expect(text).toContain('What your commercial pest service includes');
    expect(text).toContain('Valid through');
    // Commercial terms only — no residential guarantee claims anywhere.
    expect(text).toContain('No long-term contract · Licensed & insured · Satisfaction guaranteed');
    expect(text).not.toMatch(/Auto Pay|cancel your plan in the app/i);
    expect(text).not.toMatch(/90-day/i);
    expect(text).not.toMatch(/money-back/i);
    // Account-manager next step, not self-checkout.
    expect(text).toContain('account manager');
    // Links point at the canonical public origin, never the render host.
    expect(container.querySelector('a[href^="https://portal.wavespestcontrol.com/estimate/tok-123"]')).toBeTruthy();
    // Image-failure channel reports zero when nothing failed.
    expect(window.__WAVES_PDF_IMAGE_FAILURES).toBe(0);
  });

  it('renders a residential estimate with the recurring terms and approve-online next step', () => {
    const residential = {
      ...BASE_DATA,
      estimate: { ...BASE_DATA.estimate, category: 'RESIDENTIAL' },
      proposal: {
        ...BASE_DATA.proposal,
        enabled: false,
        synthesized: true,
        title: 'Service Proposal',
        buildings: [{
          name: '123 Palm Way',
          note: null,
          lineItems: [{
            description: 'Quarterly Pest Control',
            quantity: 1,
            unitPrice: 150,
            amount: 150,
            frequency: 'quarterly',
            frequencyLabel: 'Quarterly',
            taxable: false,
          }],
        }],
        totals: { annualRecurring: 600, monthlyEquivalent: 50, oneTime: 0, totalTax: 0, firstYearTotal: 600, hasTax: false, isMultiBuilding: false },
      },
      cta: { commercialProposal: false, commercialAutoPriced: false },
    };
    const { container } = render(<EstimateProposalDocument data={residential} token="tok-123" />);
    const text = container.textContent;
    expect(text).toContain('Service Estimate');
    expect(text).toContain('Quarterly Pest Control');
    // Residential recurring terms line (the shipped CTA micro claims).
    expect(text).toContain(GLASS_COPY.ctaMicro);
    // Residential pest inclusions stack rides along.
    expect(text).toContain('Protected 4× a year — full perimeter, entry points, eaves & harborage zones, every visit');
    expect(text).toContain('approve online');
    expect(text).not.toContain('What your commercial pest service includes');
  });

  it('suppresses plan roll-ups for synthesized per-application plans (AGENTS.md price copy)', () => {
    const perApp = {
      ...BASE_DATA,
      estimate: { ...BASE_DATA.estimate, category: 'RESIDENTIAL' },
      proposal: {
        ...BASE_DATA.proposal,
        enabled: false,
        synthesized: true,
        title: 'Service Proposal',
        buildings: [{
          name: '123 Palm Way',
          note: null,
          lineItems: [{
            description: 'Pest Control — per application',
            quantity: 1,
            unitPrice: 94,
            amount: 94,
            frequency: 'per_application',
            frequencyLabel: 'Per application',
            visitsPerYear: 4,
            taxable: false,
          }],
        }],
        totals: { annualRecurring: 376, monthlyEquivalent: 31.33, oneTime: 0, totalTax: 0, firstYearTotal: 376, hasTax: false, isMultiBuilding: false },
      },
      cta: { commercialProposal: false, commercialAutoPriced: false },
    };
    const { container } = render(<EstimateProposalDocument data={perApp} token="tok-123" />);
    const text = container.textContent;
    // The per-application line itself prints; every recurring roll-up
    // (annualized, monthly equivalent, first-year fold-in) stays out —
    // mirrors estimate-pdf.js suppressPlanTotals/totalsBlock exactly.
    expect(text).toContain('Pest Control — per application');
    expect(text).not.toContain('Recurring service (per year)');
    expect(text).not.toContain('First-year total');
    expect(text).not.toContain('/month across the year');
    expect(text).not.toContain('$376.00');
  });

  it('follows the CTA state in next steps — accepted documents never say approve online', () => {
    const accepted = {
      ...BASE_DATA,
      cta: { ...BASE_DATA.cta, terminalState: 'accepted' },
    };
    const { container } = render(<EstimateProposalDocument data={accepted} token="tok-123" />);
    const text = container.textContent;
    expect(text).toContain('has been approved');
    expect(text).not.toContain('approve online');
  });

  it('resolves residential terms from the line services — lawn never claims pest callbacks', () => {
    const lawn = {
      ...BASE_DATA,
      estimate: { ...BASE_DATA.estimate, category: 'RESIDENTIAL' },
      proposal: {
        ...BASE_DATA.proposal,
        enabled: false,
        synthesized: true,
        pestRecurringOnly: false,
        title: 'Service Proposal',
        buildings: [{
          name: '123 Palm Way',
          note: null,
          lineItems: [{
            description: 'Lawn Care Program',
            quantity: 1,
            unitPrice: 85,
            amount: 85,
            frequency: 'monthly',
            frequencyLabel: 'Monthly',
            taxable: false,
          }],
        }],
        totals: { annualRecurring: 1020, monthlyEquivalent: 85, oneTime: 0, totalTax: 0, firstYearTotal: 1020, hasTax: false, isMultiBuilding: false },
      },
      cta: { commercialProposal: false, commercialAutoPriced: false },
    };
    const { container } = render(<EstimateProposalDocument data={lawn} token="tok-123" />);
    const text = container.textContent;
    expect(text).not.toContain('Unlimited free callbacks');
    expect(text).toContain('Free between-visit service calls');
  });

  it('authored terms govern — inclusions and plan-terms claims stay out beside them', () => {
    const authoredTerms = {
      ...BASE_DATA,
      proposal: {
        ...BASE_DATA.proposal,
        terms: '12-month service commitment. Cancellation requires 30 days written notice.',
      },
    };
    const { container } = render(<EstimateProposalDocument data={authoredTerms} token="tok-123" />);
    const text = container.textContent;
    expect(text).toContain('12-month service commitment');
    expect(text).not.toContain('What your commercial pest service includes');
    expect(text).not.toContain('No long-term contract');
  });

  it('keeps non-pest commercial proposals terms-neutral with no pest inclusions', () => {
    const termite = {
      ...BASE_DATA,
      proposal: {
        ...BASE_DATA.proposal,
        pestRecurringOnly: false,
        buildings: [{
          name: '600 Sample Plaza Dr',
          note: null,
          lineItems: [{
            description: 'Termite bait station monitoring',
            quantity: 1,
            unitPrice: 200,
            amount: 200,
            frequency: 'quarterly',
            frequencyLabel: 'Quarterly',
            taxable: false,
          }],
        }],
      },
    };
    const { container } = render(<EstimateProposalDocument data={termite} token="tok-123" />);
    const text = container.textContent;
    expect(text).toContain('Termite bait station monitoring');
    expect(text).not.toContain('What your commercial pest service includes');
    expect(text).not.toContain('No long-term contract');
    expect(text).toContain('Licensed & insured · Satisfaction guaranteed');
  });

  it('keeps a plain Total for one-time-only documents', () => {
    const oneTime = {
      ...BASE_DATA,
      estimate: { ...BASE_DATA.estimate, category: 'RESIDENTIAL', isOneTimeOnly: true },
      proposal: {
        ...BASE_DATA.proposal,
        enabled: false,
        synthesized: true,
        title: 'Service Proposal',
        buildings: [{
          name: '123 Palm Way',
          note: null,
          lineItems: [{
            description: 'Pre-Slab Termiticide Treatment',
            quantity: 1,
            unitPrice: 1850,
            amount: 1850,
            frequency: 'one_time',
            frequencyLabel: 'One-time',
            taxable: false,
          }],
        }],
        totals: { annualRecurring: 0, monthlyEquivalent: 0, oneTime: 1850, totalTax: 0, firstYearTotal: 1850, hasTax: false, isMultiBuilding: false },
      },
      cta: { commercialProposal: false, commercialAutoPriced: false },
    };
    const { container } = render(<EstimateProposalDocument data={oneTime} token="tok-123" />);
    const text = container.textContent;
    expect(text).toContain('One-time services');
    // A single real charge keeps its total — labeled Total, never First-year.
    expect(text).toContain('Total');
    expect(text).not.toContain('First-year total');
  });
});

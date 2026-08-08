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

  it('renders the structured agreement sections when authored (slice 1A-i)', () => {
    const { container } = render(<EstimateProposalDocument data={{
      ...BASE_DATA,
      proposal: {
        ...BASE_DATA.proposal,
        propertyScope: { items: [{ label: 'Units', value: '4 residential units' }] },
        correctiveWork: [{ label: 'German roach cleanout', amount: 450, taxable: true, includes: ['Both kitchens'] }],
        customerResponsibilities: ['Provide unit access with 24-hour tenant notice'],
        commercialTerms: {
          validDays: 30, paymentTerms: 'Net-30', initialTermMonths: 12,
          renewal: null, priceAdjustment: null, cancellation: '30-day written notice', accessRequirements: null,
        },
        accountManager: 'Adam',
      },
    }} token="tok-123" />);
    const text = container.textContent;
    expect(text).toContain('Property scope');
    expect(text).toContain('4 residential units');
    expect(text).toContain('Corrective work (one-time)');
    expect(text).toContain('$450.00 *');
    expect(text).toContain('Both kitchens');
    expect(text).toContain('Customer responsibilities');
    expect(text).toContain('Service terms');
    // validDays never renders — expires_at ("Valid through") is the only
    // validity date any surface may print (codex 1A-i r1).
    expect(text).not.toContain('30 days from issue');
    expect(text).toContain('12 months');
    // Structured terms are authored terms: the canned commercial inclusions
    // stack (with its no-long-term-contract claim beside a 12-month initial
    // term) must not render.
    expect(text).not.toContain('What your commercial pest service includes');
    expect(text).not.toContain('No long-term contract');
    // Neutral terms line still present.
    expect(text).toContain('Licensed & insured · Satisfaction guaranteed');
  });

  it('demotes free-text terms to Additional terms beside structured terms and keeps them inline otherwise', () => {
    const structured = render(<EstimateProposalDocument data={{
      ...BASE_DATA,
      proposal: {
        ...BASE_DATA.proposal,
        terms: 'Interior visits billed per visit.',
        commercialTerms: {
          validDays: null, paymentTerms: null, initialTermMonths: null,
          renewal: null, priceAdjustment: null, cancellation: '30-day written notice', accessRequirements: null,
        },
      },
    }} token="tok-123" />);
    expect(structured.container.textContent).toContain('Additional terms');
    expect(structured.container.textContent).toContain('Interior visits billed per visit.');
    const legacy = render(<EstimateProposalDocument data={{
      ...BASE_DATA,
      proposal: { ...BASE_DATA.proposal, terms: 'Interior visits billed per visit.' },
    }} token="tok-123" />);
    expect(legacy.container.textContent).not.toContain('Additional terms');
    expect(legacy.container.textContent).toContain('Interior visits billed per visit.');
  });

  it('renders a legacy proposal with no structured keys without any new section headings', () => {
    const { container } = render(<EstimateProposalDocument data={BASE_DATA} token="tok-123" />);
    const text = container.textContent;
    expect(text).not.toContain('Property scope');
    expect(text).not.toContain('Corrective work');
    expect(text).not.toContain('Customer responsibilities');
    expect(text).not.toContain('Service terms');
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

  it('identifies taxable lines like the pdfkit document — marker, rate, disclosure (codex #3281 r3)', () => {
    const mixed = {
      ...BASE_DATA,
      proposal: {
        ...BASE_DATA.proposal,
        buildings: [{
          name: '600 Sample Plaza Dr',
          note: null,
          lineItems: [
            {
              description: 'Recurring service plan',
              quantity: 1,
              unitPrice: 120,
              amount: 120,
              frequency: 'quarterly',
              frequencyLabel: 'Quarterly',
              taxable: true,
            },
            {
              description: 'Grounds maintenance',
              quantity: 1,
              unitPrice: 200,
              amount: 200,
              frequency: 'quarterly',
              frequencyLabel: 'Quarterly',
              taxable: false,
            },
          ],
        }],
        totals: {
          annualRecurring: 1280.00,
          monthlyEquivalent: 106.67,
          oneTime: 0,
          taxRate: 0.07,
          totalTax: 33.60,
          firstYearTotal: 1313.60,
          hasTax: true,
          isMultiBuilding: false,
        },
      },
    };
    const { container } = render(<EstimateProposalDocument data={mixed} token="tok-123" />);
    const text = container.textContent;
    // The taxed amount carries the marker; the exempt one doesn't.
    expect(text).toContain('$120.00 *');
    expect(text).toContain('$200.00 quarterly');
    expect(text).not.toContain('$200.00 *');
    // The tax total states its rate, and the marker is explained.
    expect(text).toContain('Sales tax (7.00%)');
    expect(text).toContain('* Taxable line.');
  });

  it('omits estimator pricing intelligence on authored proposals (codex #3281 r4)', () => {
    // BASE_DATA is an authored proposal with estimator intelligence attached —
    // the operator entered these lines/prices, so the satellite-measurement
    // story must not claim to have built them.
    const authored = render(<EstimateProposalDocument data={BASE_DATA} token="tok-123" />);
    expect(authored.container.textContent).not.toContain('How your price was built');
    // A synthesized (engine-priced) document keeps the section — there the
    // methodology claim is true.
    const synthesized = {
      ...BASE_DATA,
      proposal: { ...BASE_DATA.proposal, enabled: false, synthesized: true },
    };
    const engine = render(<EstimateProposalDocument data={synthesized} token="tok-123" />);
    expect(engine.container.textContent).toContain('How your price was built');
  });

  it('explains the taxable marker even when totals omit the rate', () => {
    // BASE_DATA's totals carry hasTax without taxRate — the label stays
    // plain and the disclosure still renders beside the marked line.
    const { container } = render(<EstimateProposalDocument data={BASE_DATA} token="tok-123" />);
    const text = container.textContent;
    expect(text).toContain('$120.00 *');
    expect(text).toContain('* Taxable line.');
    expect(text).not.toContain('(NaN');
  });
});

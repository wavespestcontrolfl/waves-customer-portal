// @vitest-environment jsdom
// The estimate PDF document for the mosquito misting SYSTEM plan (GATE_MOSQUITO_MISTING, owner wording 2026-10-30): its own
// service line, its own "What this service includes" bullets (never the barrier mosquito list), the refill line, the install
// detail, the system facts under "How your price was built", and a misting "Before you book" section only on a misting estimate.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import EstimateProposalDocument from './EstimateProposalDocument';

afterEach(() => {
  cleanup();
  delete window.__WAVES_PDF_IMAGE_FAILURES;
});

const INSTALL_LABEL = 'Standard system (55-gallon) Installation';
const MISTING_SECTION = {
  key: 'mosquito_misting',
  label: 'Mosquito Misting Service Plan',
  refill: { label: 'Standard solution', perFill: 129, refillsPerYear: 4 },
  system: { tierLabel: 'Standard system (55-gallon)', nozzles: 21, risers: 2 },
  oneTimeContribution: { items: [{ label: INSTALL_LABEL, amount: 4345, detail: '21 nozzles · 2 risers' }], subtotal: 4345 },
};

const misting = (over = {}) => ({
  publicOrigin: 'https://portal.wavespestcontrol.com',
  estimate: {
    token: 'tok-mist', slug: 'EST-2099-0002', customerName: 'Pat Example', address: '12 Sample Ln, Bradenton, FL 34203',
    createdAt: '2026-10-30T14:57:32.162Z', expiresAt: '2026-11-30T00:00:00.000Z', licenseNumber: 'JB351547',
    category: 'RESIDENTIAL', isOneTimeOnly: false,
    intelligence: {
      title: 'Priced from your system layout',
      body: 'Your price is set by your system size and your nozzle and riser count.',
      metrics: [
        { label: 'System', value: 'Standard system (55-gallon)' },
        { label: 'Nozzles', value: '21' },
        { label: 'Risers', value: '2' },
      ],
      signals: [],
    },
    satelliteUrl: null,
  },
  pricing: { services: [MISTING_SECTION] },
  proposal: {
    enabled: false, synthesized: true, title: 'Service Proposal', preparedFor: 'Pat Example', propertyAddress: '12 Sample Ln, Bradenton, FL 34203',
    buildings: [{
      name: '12 Sample Ln', note: null,
      lineItems: [
        { description: 'Mosquito Misting Service Plan — 12 applications/yr', quantity: 1, unitPrice: 59, amount: 59, frequency: 'per_application', frequencyLabel: 'Per application', visitsPerYear: 12, taxable: false, termsScope: 'all' },
        { description: INSTALL_LABEL, quantity: 1, unitPrice: 4345, amount: 4345, frequency: 'one_time', frequencyLabel: 'One-time', taxable: false, termsScope: 'all' },
      ],
    }],
    totals: { annualRecurring: 708, monthlyEquivalent: 59, oneTime: 4345, totalTax: 0, firstYearTotal: 5053, hasTax: false, isMultiBuilding: false },
  },
  cta: {},
  beforeYouBook: {
    title: 'Before you book',
    sections: [
      { key: 'scheduling', heading: 'Scheduling and paying', lines: ['There is no deposit.'] },
      { key: 'misting', heading: 'If your estimate includes a misting system', lines: ['The date you pick is your first monthly service visit.', 'We call you to book the install day.', 'The install charge is on your first invoice.'] },
    ],
    closing: null,
  },
  ...over,
});

const text = () => document.body.textContent;

describe('EstimateProposalDocument: misting system plan', () => {
  it('prints the plan as its own line with the refill sentence and the install detail', () => {
    render(<EstimateProposalDocument data={misting()} token="tok-mist" />);
    expect(text()).toContain('Mosquito Misting Service Plan — 12 applications/yr');
    expect(document.querySelector('[data-testid="doc-misting-refill"]').textContent)
      .toBe('Refills, Standard solution: $129.00 each. Billed when we refill the tank. We expect about 4 a year.');
    expect(document.querySelector('[data-testid="doc-misting-install-detail"]').textContent).toBe('21 nozzles · 2 risers');
    expect(text()).not.toMatch(/Sector|Mist Ultra|permethrin/i);
  });

  it('leaves the "We expect about N a year." sentence out when the yearly count is 0 or missing', () => {
    for (const refillsPerYear of [0, undefined, null]) {
      cleanup();
      const data = misting({ pricing: { services: [{ ...MISTING_SECTION, refill: { label: 'Natural solution', perFill: 219, refillsPerYear } }] } });
      render(<EstimateProposalDocument data={data} token="tok-mist" />);
      expect(document.querySelector('[data-testid="doc-misting-refill"]').textContent)
        .toBe('Refills, Natural solution: $219.00 each. Billed when we refill the tank.');
    }
  });

  it('lists the owner-approved misting bullets, then the generic guarantee and cancel lines, and none of the barrier bullets', () => {
    render(<EstimateProposalDocument data={misting()} token="tok-mist" />);
    const body = text();
    expect(body).toContain('What this service includes');
    expect(body).toContain('Every month, we check the tank, the timer, the tubing and the spray from each nozzle.');
    expect(body).toContain('Every third visit, we clean every nozzle and replace the filter.');
    expect(body).toContain('Only Waves technicians refill the tank, and the cabinet stays locked.');
    expect(body).toContain('Money-back guarantee — if we can’t solve a covered problem, we refund your last service payment');
    expect(body).toContain('No contract, no cancellation fee — cancel online anytime');
    expect(body).not.toContain('Barrier treatment');
    expect(body).not.toContain('fog-and-go');
    expect(body).not.toContain('Standing-water and breeding-pressure');
  });

  it('builds "How your price was built" from the system facts, not mosquito pressure', () => {
    render(<EstimateProposalDocument data={misting()} token="tok-mist" />);
    const body = text();
    expect(body).toContain('How your price was built');
    expect(body).toContain('Your price is set by your system size and your nozzle and riser count.');
    expect(body).toContain('System: Standard system (55-gallon)');
    expect(body).toContain('Nozzles: 21');
    expect(body).toContain('Risers: 2');
    expect(body).not.toMatch(/mosquito pressure|resting zones|Near water/i);
  });

  it('prints the misting "Before you book" section from the server page', () => {
    render(<EstimateProposalDocument data={misting()} token="tok-mist" />);
    const byb = document.querySelector('[data-testid="doc-before-you-book"]');
    expect(byb.textContent).toContain('If your estimate includes a misting system');
    expect(byb.textContent).toContain('The date you pick is your first monthly service visit.');
    expect(byb.textContent).toContain('We call you to book the install day.');
    expect(byb.textContent).toContain('The install charge is on your first invoice.');
  });

  it('prints none of the misting extras for an estimate without the misting plan', () => {
    const plain = misting({
      pricing: { services: [{ key: 'pest_control', label: 'Pest Control' }] },
      proposal: {
        enabled: false, synthesized: true, title: 'Service Proposal', preparedFor: 'Pat Example', propertyAddress: '12 Sample Ln',
        buildings: [{ name: '12 Sample Ln', note: null, lineItems: [{ description: 'Pest Control (Quarterly) — 4 applications/yr', quantity: 1, unitPrice: 113, amount: 113, frequency: 'per_application', frequencyLabel: 'Per application', visitsPerYear: 4, taxable: false, termsScope: 'all' }] }],
        totals: { annualRecurring: 452, monthlyEquivalent: 37.67, oneTime: 0, totalTax: 0, firstYearTotal: 452, hasTax: false, isMultiBuilding: false },
      },
      beforeYouBook: { title: 'Before you book', sections: [{ key: 'scheduling', heading: 'Scheduling and paying', lines: ['There is no deposit.'] }], closing: null },
    });
    render(<EstimateProposalDocument data={plain} token="tok-mist" />);
    expect(document.querySelector('[data-testid="doc-misting-refill"]')).toBeNull();
    expect(document.querySelector('[data-testid="doc-misting-install-detail"]')).toBeNull();
    expect(text()).not.toContain('misting');
  });
});

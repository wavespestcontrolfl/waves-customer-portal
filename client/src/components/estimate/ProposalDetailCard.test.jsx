// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProposalDetailCard from './ProposalDetailCard';

const PROPOSAL = {
  enabled: true,
  pestRecurringOnly: true,
  title: 'Commercial Service Proposal',
  taxLabel: 'Sales tax',
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
    recurringTax: 33.60,
    oneTimeTax: 0,
    totalTax: 33.60,
    firstYearTotal: 513.60,
    hasTax: true,
    isMultiBuilding: false,
  },
};

describe('ProposalDetailCard', () => {
  it('itemizes the authored proposal: lines, totals, tax, inclusions', () => {
    render(<ProposalDetailCard proposal={PROPOSAL} />);
    expect(screen.getByText('Commercial Service Proposal')).toBeTruthy();
    expect(screen.getByText(/Recurring service plan/)).toBeTruthy();
    expect(screen.getByText('$480.00')).toBeTruthy();
    expect(screen.getByText('Sales tax')).toBeTruthy();
    expect(screen.getByText('$513.60')).toBeTruthy();
    expect(screen.getByText('What your commercial pest service includes')).toBeTruthy();
    expect(screen.getByText(/Interior treatment included on request/)).toBeTruthy();
  });

  it('makes no residential guarantee claims', () => {
    const { container } = render(<ProposalDetailCard proposal={PROPOSAL} />);
    expect(container.textContent).not.toMatch(/90-day/i);
    expect(container.textContent).not.toMatch(/money-back/i);
    expect(container.textContent).not.toMatch(/\$99/);
  });

  it('renders nothing without an authored proposal payload', () => {
    const empty = render(<ProposalDetailCard proposal={null} />);
    expect(empty.container.firstChild).toBeNull();
    const noBuildings = render(<ProposalDetailCard proposal={{ enabled: true, buildings: [] }} />);
    expect(noBuildings.container.firstChild).toBeNull();
  });

  it('hides the inclusions block when the proposal is not pest-recurring-only', () => {
    const { container } = render(<ProposalDetailCard proposal={{ ...PROPOSAL, pestRecurringOnly: false }} />);
    expect(container.textContent).not.toContain('What your commercial pest service includes');
    expect(container.textContent).not.toContain('Tenant-reported pests');
  });

  it('suppresses the inclusions block beside authored terms', () => {
    const { container } = render(<ProposalDetailCard proposal={{
      ...PROPOSAL,
      terms: '12-month service commitment. Cancellation requires 30 days written notice.',
    }} />);
    expect(container.textContent).toContain('12-month service commitment');
    expect(container.textContent).not.toContain('What your commercial pest service includes');
    expect(container.textContent).not.toContain('No long-term contract');
  });

  it('names buildings only on multi-building proposals', () => {
    const single = render(<ProposalDetailCard proposal={PROPOSAL} />);
    expect(single.queryByText('600 Sample Plaza Dr')).toBeNull();
    const multi = render(<ProposalDetailCard proposal={{
      ...PROPOSAL,
      buildings: [
        PROPOSAL.buildings[0],
        { ...PROPOSAL.buildings[0], name: 'Tower B' },
      ],
      totals: { ...PROPOSAL.totals, isMultiBuilding: true },
    }} />);
    expect(multi.getByText('600 Sample Plaza Dr')).toBeTruthy();
    expect(multi.getByText('Tower B')).toBeTruthy();
  });

  it('identifies taxable lines — marker, rate, disclosure (codex #3281 r4)', () => {
    const mixed = render(<ProposalDetailCard proposal={{
      ...PROPOSAL,
      buildings: [{
        name: '600 Sample Plaza Dr',
        note: null,
        lineItems: [
          { ...PROPOSAL.buildings[0].lineItems[0] },
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
      totals: { ...PROPOSAL.totals, taxRate: 0.07 },
    }} />);
    const text = mixed.container.textContent;
    // Taxed amount carries the marker; the exempt one doesn't.
    expect(text).toContain('$120.00 *');
    expect(text).not.toContain('$200.00 *');
    // Rate beside the tax total, and the marker explained.
    expect(text).toContain('Sales tax (7.00%)');
    expect(text).toContain('* Taxable line.');
  });

  it('renders the structured agreement sections when authored (slice 1A-i)', () => {
    const { container } = render(<ProposalDetailCard proposal={{
      ...PROPOSAL,
      propertyScope: { items: [{ label: 'Units', value: '4 residential units' }] },
      correctiveWork: [{ label: 'German roach cleanout', amount: 450, taxable: true, includes: ['Both kitchens', 'Follow-up at 2 weeks'] }],
      customerResponsibilities: ['Provide unit access with 24-hour tenant notice'],
      commercialTerms: {
        validDays: 30, paymentTerms: 'Net-30', initialTermMonths: 0,
        renewal: null, priceAdjustment: null, cancellation: '30-day written notice', accessRequirements: null,
      },
    }} />);
    const text = container.textContent;
    expect(text).toContain('Property scope');
    expect(text).toContain('4 residential units');
    expect(text).toContain('Corrective work (one-time)');
    expect(text).toContain('$450.00 *');
    expect(text).toContain('Follow-up at 2 weeks');
    expect(text).toContain('Customer responsibilities');
    expect(text).toContain('Service terms');
    // validDays never renders — the enforced expires_at is the only validity
    // date any surface may print (codex 1A-i r1).
    expect(text).not.toContain('30 days from issue');
    expect(text).toContain('None — month-to-month');
    // Structured terms are authored terms — the canned inclusions stack
    // must not sit beside them (same rule as free-text terms).
    expect(text).not.toContain('What your commercial pest service includes');
  });

  it('demotes free-text terms to "Additional terms" only beside structured terms', () => {
    const structured = render(<ProposalDetailCard proposal={{
      ...PROPOSAL,
      terms: 'Interior visits billed per visit.',
      commercialTerms: {
        validDays: null, paymentTerms: null, initialTermMonths: null,
        renewal: null, priceAdjustment: null, cancellation: '30-day written notice', accessRequirements: null,
      },
    }} />);
    expect(structured.container.textContent).toContain('Additional terms');
    const legacy = render(<ProposalDetailCard proposal={{ ...PROPOSAL, terms: 'Interior visits billed per visit.' }} />);
    expect(legacy.container.textContent).not.toContain('Additional terms');
    expect(legacy.container.textContent).toContain('Interior visits billed per visit.');
  });

  it('renders a legacy proposal with no structured keys exactly as before (no new section headings)', () => {
    const { container } = render(<ProposalDetailCard proposal={PROPOSAL} />);
    const text = container.textContent;
    expect(text).not.toContain('Property scope');
    expect(text).not.toContain('Corrective work');
    expect(text).not.toContain('Customer responsibilities');
    expect(text).not.toContain('Service terms');
  });

  it('labels a one-time-only proposal total as Total, never First-year (codex #3281 r4)', () => {
    const oneTime = render(<ProposalDetailCard proposal={{
      ...PROPOSAL,
      buildings: [{
        name: '600 Sample Plaza Dr',
        note: null,
        lineItems: [{
          description: 'Initial corrective service',
          quantity: 1,
          unitPrice: 675,
          amount: 675,
          frequency: 'one_time',
          frequencyLabel: 'One-time',
          taxable: false,
        }],
      }],
      totals: {
        annualRecurring: 0,
        monthlyEquivalent: 0,
        oneTime: 675,
        recurringTax: 0,
        oneTimeTax: 0,
        totalTax: 0,
        firstYearTotal: 675,
        hasTax: false,
        isMultiBuilding: false,
      },
    }} />);
    const text = oneTime.container.textContent;
    expect(text).toContain('Total');
    expect(text).not.toContain('First-year total');
  });
});

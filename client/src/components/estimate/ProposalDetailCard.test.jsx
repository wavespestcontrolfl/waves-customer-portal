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
});

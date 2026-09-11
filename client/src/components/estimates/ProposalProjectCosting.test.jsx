// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import ProposalProjectCosting from './ProposalProjectCosting';

afterEach(cleanup);
const costing = { revenueYears: 1, rows: [{ category: 'labor', phase: '', description: 'Labor', quantity: 10, unit: 'hour', unitCost: 40, occurrences: 1 }] };
const totals = { oneTime: 1000, annualRecurring: 0 };

it('shows profit and margin for a complete cost sheet over saveable revenue', () => {
  render(<ProposalProjectCosting value={costing} onChange={() => {}} totals={totals} />);
  expect(screen.getByText('$600.00')).toBeInTheDocument();
  expect(screen.getByText('60%')).toBeInTheDocument();
});

it('withholds profit and margin while the quoted itemization would be refused by the save (GH codex P2 r8 on #4270)', () => {
  const issue = 'Each program needs a whole-number service frequency between 1 and 52 visits per year.';
  render(<ProposalProjectCosting value={costing} onChange={() => {}} totals={totals} revenueIssue={issue} />);
  expect(screen.queryByText('$600.00')).not.toBeInTheDocument();
  expect(screen.queryByText('60%')).not.toBeInTheDocument();
  expect(screen.getByText(`Fix the quoted itemization before comparing costs: ${issue}`)).toBeInTheDocument();
});

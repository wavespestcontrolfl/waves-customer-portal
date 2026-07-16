// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CustomerAccountPanel } from './AgentEstimatePage';

afterEach(cleanup);

describe('Agent Estimate recognized customer account', () => {
  it('shows the current tier and paid price for each existing service', () => {
    render(<CustomerAccountPanel account={{
      recognized: true,
      active_plan: true,
      current_tier: 'Silver',
      current_discount_pct: 10,
      current_services: [
        {
          key: 'pest_control',
          label: 'Pest Control',
          currentPerVisit: 99,
          spendSource: 'last_paid_invoice',
          lastPaidAt: '2026-07-15',
          qualifiesForWaveGuard: true,
        },
        {
          key: 'lawn_care',
          label: 'Lawn Care',
          currentPerVisit: 67,
          spendSource: 'last_paid_invoice',
          lastPaidAt: '2026-07-10',
          qualifiesForWaveGuard: true,
        },
      ],
    }} />);

    expect(screen.getByText(/Silver · 10% current discount/)).toBeInTheDocument();
    expect(screen.getByText('Pest Control')).toBeInTheDocument();
    expect(screen.getByText('$99')).toBeInTheDocument();
    expect(screen.getByText('Lawn Care')).toBeInTheDocument();
    expect(screen.getByText('$67')).toBeInTheDocument();
    expect(screen.getAllByText(/last paid invoice/)).toHaveLength(2);
    expect(screen.getByText(/Current services and their paid prices stay unchanged/)).toBeInTheDocument();
  });

  it('labels a scheduled price as fallback instead of actual paid spend', () => {
    render(<CustomerAccountPanel account={{
      recognized: true,
      active_plan: true,
      current_tier: 'Bronze',
      current_discount_pct: 0,
      current_services: [{
        key: 'pest_control',
        label: 'Pest Control',
        currentPerVisit: 117,
        spendSource: 'scheduled_estimate',
        qualifiesForWaveGuard: true,
      }],
    }} />);

    expect(screen.getByText('Bronze')).toBeInTheDocument();
    expect(screen.getByText('$117')).toBeInTheDocument();
    expect(screen.getByText('scheduled price fallback')).toBeInTheDocument();
  });
});

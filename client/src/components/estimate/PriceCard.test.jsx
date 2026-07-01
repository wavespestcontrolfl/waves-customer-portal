// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import PriceCard from './PriceCard';

afterEach(() => cleanup());

describe('PriceCard — narrow low-confidence commercial range', () => {
  it('renders a ±20% "confirmed on site" range for a single all-LOW line', () => {
    render(
      <PriceCard
        frequency={{
          key: 'monthly',
          label: 'Commercial Turf Treatment Program',
          monthly: 400,
          annual: 4800,
          lowConfidenceRangePct: 0.2,
          lowConfidenceFraction: 1,
        }}
      />,
    );

    // $400/mo, fraction 1 → $320–$480/mo band (interval = monthly, so 1×).
    expect(screen.getByText('$320–$480')).toBeInTheDocument();
    // Annual is banded too.
    expect(screen.getByText('$3,840 – $5,760 / year')).toBeInTheDocument();
    // Site-confirmation caption present; single exact price is NOT shown.
    expect(screen.getByText(/confirm your exact price/i)).toBeInTheDocument();
    expect(screen.queryByText('$400')).toBeNull();
  });

  it('bands only the LOW share on a mixed-confidence card (no overstated range)', () => {
    // $900/mo total where only a $400 LOW line is uncertain (fraction 0.4444…):
    // band = 900 × 0.4444 × 0.2 = $80 → $820–$980, NOT a blanket ±20% ($720–$1,080).
    render(
      <PriceCard
        frequency={{
          key: 'monthly',
          label: 'Recurring services',
          monthly: 900,
          annual: 10800,
          lowConfidenceRangePct: 0.2,
          lowConfidenceFraction: 400 / 900,
        }}
      />,
    );

    expect(screen.getByText('$820–$980')).toBeInTheDocument();
    expect(screen.queryByText('$720–$1,080')).toBeNull();
  });

  it('renders the exact price (no range) when the marker is absent', () => {
    render(<PriceCard frequency={{ key: 'monthly', monthly: 400, annual: 4800 }} />);

    expect(screen.getByText('$400')).toBeInTheDocument();
    expect(screen.queryByText('$320–$480')).toBeNull();
    expect(screen.queryByText(/confirm your exact price/i)).toBeNull();
  });

  it('ignores the range marker when the line is quote-required', () => {
    render(
      <PriceCard
        frequency={{ key: 'monthly', quoteRequired: true, lowConfidenceRangePct: 0.2 }}
      />,
    );

    expect(screen.getByText('Quote required')).toBeInTheDocument();
    expect(screen.queryByText(/confirm your exact price/i)).toBeNull();
  });
});

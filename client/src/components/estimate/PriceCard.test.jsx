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

  it('suppresses exact per-application treatment rows while ranging', () => {
    render(
      <PriceCard
        frequency={{
          key: 'monthly',
          monthly: 400,
          annual: 4800,
          lowConfidenceRangePct: 0.2,
          lowConfidenceFraction: 1,
          perServiceTreatments: [
            { service: 'commercial_lawn', label: 'Turf application', displayPrice: 1200, visitsPerYear: 4 },
          ],
        }}
      />,
    );

    // Range shows; the exact per-application price must NOT leak.
    expect(screen.getByText('$320–$480')).toBeInTheDocument();
    expect(screen.queryByText('$1,200')).toBeNull();
    expect(screen.queryByText(/per application/i)).toBeNull();
  });

  it('still renders per-application treatment rows when NOT ranging', () => {
    render(
      <PriceCard
        frequency={{
          key: 'monthly',
          monthly: 400,
          perServiceTreatments: [
            { service: 'commercial_lawn', label: 'Turf application', displayPrice: 1200, visitsPerYear: 4 },
          ],
        }}
      />,
    );

    expect(screen.getByText('$1,200')).toBeInTheDocument();
  });

  it('never derives a cadence-key visit count over multiple treatment rows', () => {
    render(
      <PriceCard
        frequency={{
          key: 'monthly',
          monthly: 400,
          perServiceTreatments: [
            { service: 'lawn', label: 'Turf application', displayPrice: 120, visitsPerYear: 8 },
            { service: 'mosquito', label: 'Mosquito treatment', displayPrice: 60, visitsPerYear: 12 },
          ],
        }}
      />,
    );

    // Rows differ (8 vs 12) — no single "N applications per year" line.
    expect(screen.queryByText(/applications per year included/i)).toBeNull();
  });

  it('keeps the cadence-key visit count when there are no treatment rows', () => {
    render(<PriceCard frequency={{ key: 'quarterly', monthly: 50 }} />);

    expect(screen.getByText(/4 applications per year included/i)).toBeInTheDocument();
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

describe('PriceCard — WaveGuard savings display', () => {
  it('suppresses a rounding-noise "savings" on a 0%-discount tier (Bronze quarterly)', () => {
    // $94/visit quarterly stored as $31.33/mo → cadence 93.99 vs anchor 94:
    // the $0.01 delta is monthly-rounding noise, not a member discount.
    render(
      <PriceCard
        frequency={{ key: 'quarterly', monthly: 31.33, annual: 375.96, perVisit: 94 }}
        waveGuardTier="Bronze"
      />,
    );

    expect(screen.queryByText(/You save/)).toBeNull();
    // No strike-through anchor either — just the billed price.
    expect(screen.queryByText('$94/quarter')).toBeNull();
    expect(screen.getByText('$93.99')).toBeInTheDocument();
    expect(screen.getByText('WaveGuard Bronze')).toBeInTheDocument();
    // No annual figure on a standard exact price (owner directive).
    expect(screen.queryByText(/\/ year/)).toBeNull();
  });

  it('shows a real tier discount as the struck-through anchor, with no savings line', () => {
    // Anchor $100/visit, member pays $90/quarter (10% Silver).
    render(
      <PriceCard
        frequency={{ key: 'quarterly', monthly: 30, annual: 360, perVisit: 100 }}
        waveGuardTier="Silver"
      />,
    );

    // The "You save" line was removed globally (anchor-vs-cadence delta
    // misattributed to the tier) — the struck anchor is the discount signal.
    expect(screen.queryByText(/You save/)).toBeNull();
    expect(screen.getByText('$100/quarter')).toBeInTheDocument();
  });

  it('derives the anchor from monthlyBase when perVisit is absent (non-pest bundle rows)', () => {
    // Lawn in a Silver bundle: $83/mo base → $74.70/mo member price. Own-cadence
    // ladder rows never carry perVisit, only monthlyBase.
    render(
      <PriceCard
        frequency={{ key: 'premium', label: 'Monthly', monthly: 74.7, monthlyBase: 83, visitsPerYear: 12 }}
        waveGuardTier="Silver"
      />,
    );

    expect(screen.getByText('$83/mo')).toBeInTheDocument();
    expect(screen.queryByText(/You save/)).toBeNull();
  });

  it('shows no anchor or savings when monthlyBase equals the billed monthly (0% tier)', () => {
    render(
      <PriceCard
        frequency={{ key: 'premium', label: 'Monthly', monthly: 83, monthlyBase: 83, visitsPerYear: 12 }}
        waveGuardTier="Bronze"
      />,
    );

    expect(screen.queryByText(/You save/)).toBeNull();
    expect(screen.queryByText('$83/mo')).toBeNull();
    expect(screen.getByText('$83')).toBeInTheDocument();
  });
});


describe('PriceCard — manual discount is not double-reported in-card', () => {
  it('shows the promo row but no anchor/savings when the gap is the manual discount alone', () => {
    render(
      <PriceCard
        frequency={{
          key: 'premium',
          label: 'Monthly',
          monthly: 73,
          monthlyBase: 83,
          visitsPerYear: 12,
          manualDiscount: { amount: 120, recurringAmount: 120, label: 'Spring promo' },
        }}
        waveGuardTier="Silver"
      />,
    );

    expect(screen.getByText('Spring promo')).toBeInTheDocument();
    expect(screen.queryByText(/You save/)).toBeNull();
    expect(screen.queryByText('$83/mo')).toBeNull();
  });
});

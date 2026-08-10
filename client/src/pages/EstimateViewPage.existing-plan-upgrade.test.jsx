// @vitest-environment jsdom
// ExistingPlanUpgradeCard — the existing-service tier extension display
// (owner decision 2026-08-10). Data is the server's publicMembershipView
// projection; the card renders only for genuine upgrade snapshots and
// mirrors exactly what accept applies.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ExistingPlanUpgradeCard } from './EstimateViewPage';

afterEach(() => cleanup());

const membership = (overrides = {}) => ({
  isExistingCustomer: true,
  tier: 'silver',
  tierLabel: 'Silver',
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
  ...overrides,
});

describe('ExistingPlanUpgradeCard', () => {
  it('lists the existing service with its upcoming visits, struck-through price, and labeled discount row', () => {
    render(<ExistingPlanUpgradeCard membership={membership()} waveGuardTier="Silver" />);

    expect(screen.getByRole('heading', { name: /your current services get the .* rate too/i })).toBeInTheDocument();
    expect(screen.getByText('Pest Control')).toBeInTheDocument();
    // Calendar days render from the stored date string — no timezone shift.
    expect(screen.getByText(/Oct 28, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Jan 27, 2027/)).toBeInTheDocument();
    expect(screen.getByText('$55.00')).toBeInTheDocument();
    expect(screen.getByText('$49.50')).toBeInTheDocument();
    // "/ application" is the estimate surface's one billing unit (owner
    // 2026-07-11) — "visit" is schedule language only (the dates line).
    expect(screen.getByText('/ application')).toBeInTheDocument();
    expect(screen.queryByText('/ visit')).not.toBeInTheDocument();
    expect(screen.getByText(/WaveGuard Silver Discount/)).toBeInTheDocument();
    expect(screen.getByText(/5\.50/)).toBeInTheDocument();
    // Live configurator: the apply-on-approve line shows.
    expect(screen.getByText(/applied automatically when you approve/i)).toBeInTheDocument();
  });

  it('renders nothing without extension rows, for non-members, or with no tier', () => {
    const { container: empty } = render(
      <ExistingPlanUpgradeCard membership={membership({ existingServices: [] })} waveGuardTier="Silver" />,
    );
    expect(empty).toBeEmptyDOMElement();

    const { container: lead } = render(
      <ExistingPlanUpgradeCard membership={{ isExistingCustomer: false }} waveGuardTier="Silver" />,
    );
    expect(lead).toBeEmptyDOMElement();

    const { container: tierless } = render(
      <ExistingPlanUpgradeCard membership={membership()} waveGuardTier={null} />,
    );
    expect(tierless).toBeEmptyDOMElement();
  });

  it('drops rows without a positive discounted price rather than advertising a broken figure', () => {
    const { container } = render(
      <ExistingPlanUpgradeCard
        membership={membership({
          existingServices: [{ key: 'pest_control', label: 'Pest Control', currentPerVisit: 0, newPerVisit: 0 }],
        })}
        waveGuardTier="Silver"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('prepaid families explain the credit instead of implying a repriced visit; recap hides the approve line', () => {
    render(
      <ExistingPlanUpgradeCard
        membership={membership({
          existingServices: [{
            key: 'pest_control',
            label: 'Pest Control',
            currentPerVisit: 55,
            newPerVisit: 49.5,
            perVisitSavings: 5.5,
            upcomingVisitDates: [],
            prepaid: true,
          }],
        })}
        waveGuardTier="Silver"
        readOnly
      />,
    );
    expect(screen.getByText(/prepaid — the difference is credited to your account/i)).toBeInTheDocument();
    expect(screen.queryByText(/applied automatically when you approve/i)).not.toBeInTheDocument();
  });
});

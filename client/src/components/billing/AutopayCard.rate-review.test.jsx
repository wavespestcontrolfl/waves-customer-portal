// @vitest-environment jsdom
// Annual rate review (dark, GATE_RATE_REVIEW): the billing card shows a
// delivered, not-yet-applied rate change as the upcoming rate and the next
// charge at it — and nothing when the server sends no rate_changes.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockGetAutopay = vi.fn();
vi.mock('../../utils/api', () => ({ default: { getAutopay: (...a) => mockGetAutopay(...a) } }));
vi.mock('../../lib/stripeLoader', () => ({ getStripe: vi.fn() }));

import AutopayCard from './AutopayCard';

const base = {
  state: 'active', autopay_enabled: true, billing_mode: 'per_application', non_monthly_billing: true,
  next_charge_date: null, next_charge_amount: null, monthly_rate: null, payment_methods: [], billing_day: 1,
};

afterEach(() => { cleanup(); mockGetAutopay.mockReset(); });

describe('AutopayCard upcoming rate line', () => {
  it('renders the upcoming rate, the next charge at it, and the notice link', async () => {
    mockGetAutopay.mockResolvedValue({
      ...base,
      rate_changes: [{ service: 'Pest control', unit: 'application', current: '$117', next: '$121', effectiveDate: '2026-12-10', noticePath: '/price-change/abc', nextCharge: { total: 124.5, base: 121, surcharge: 3.5 } }],
    });
    render(<AutopayCard customer={{}} />);
    const box = await screen.findByTestId('rate-review-upcoming');
    expect(box).toHaveTextContent('Pest control: $121 per application from Dec 10, 2026');
    expect(box).toHaveTextContent('Now $117 per application. Next charge at the new rate: $124.50 on Dec 10, 2026 ($121.00 + $3.50 credit card surcharge).');
    expect(screen.getByRole('link', { name: 'View notice' })).toHaveAttribute('href', '/price-change/abc');
    expect(box).not.toHaveTextContent(/per visit|monthly/i);
  });

  it('without Auto Pay, states only when the new rate starts', async () => {
    mockGetAutopay.mockResolvedValue({
      ...base, state: 'disabled', autopay_enabled: false,
      rate_changes: [{ service: 'Pest control', unit: 'application', current: '$117', next: '$121', effectiveDate: '2026-12-10', noticePath: '/price-change/abc', nextCharge: null }],
    });
    render(<AutopayCard customer={{}} />);
    const box = await screen.findByTestId('rate-review-upcoming');
    expect(box).toHaveTextContent('The new rate starts Dec 10, 2026.');
    expect(box).not.toHaveTextContent('Next charge');
  });

  it('renders nothing extra without rate_changes', async () => {
    mockGetAutopay.mockResolvedValue(base);
    render(<AutopayCard customer={{}} />);
    await screen.findByText('Auto Pay is on');
    expect(screen.queryByTestId('rate-review-upcoming')).toBeNull();
  });
});

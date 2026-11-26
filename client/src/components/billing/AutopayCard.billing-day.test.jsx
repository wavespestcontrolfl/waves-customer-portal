// @vitest-environment jsdom
// "Change billing day" is a monthly-charge setting: per-application, prepaid and per-visit plans have no
// charge day, so the Manage Auto Pay sheet must not offer it for them.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockGetAutopay = vi.fn();
vi.mock('../../utils/api', () => ({ default: { getAutopay: (...a) => mockGetAutopay(...a) } }));
vi.mock('../../lib/stripeLoader', () => ({ getStripe: vi.fn() }));

import AutopayCard from './AutopayCard';

const base = {
  state: 'active', autopay_enabled: true, next_charge_date: null, next_charge_amount: null,
  monthly_rate: 89, payment_methods: [], billing_day: 1,
};

afterEach(() => { cleanup(); mockGetAutopay.mockReset(); });

async function openManage(overrides) {
  mockGetAutopay.mockResolvedValue({ ...base, ...overrides });
  render(<AutopayCard customer={{}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Manage Auto Pay/ }));
  await screen.findByRole('button', { name: 'Pause payments' });
}

describe('AutopayCard Manage sheet', () => {
  it.each([
    ['per_application', { billing_mode: 'per_application', non_monthly_billing: true }],
    ['annual_prepay', { billing_mode: 'annual_prepay', non_monthly_billing: true }],
    ['per_visit', { billing_mode: 'per_visit', non_monthly_billing: true }],
  ])('hides Change billing day on a %s plan', async (_name, overrides) => {
    await openManage(overrides);
    expect(screen.queryByRole('button', { name: 'Change billing day' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change payment method' })).toBeInTheDocument();
  });

  it('keeps Change billing day on a monthly plan', async () => {
    await openManage({ billing_mode: 'monthly_membership', non_monthly_billing: false });
    expect(screen.getByRole('button', { name: 'Change billing day' })).toBeInTheDocument();
  });
});

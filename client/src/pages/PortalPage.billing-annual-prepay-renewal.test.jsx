// @vitest-environment jsdom
// Codex r2 P1 (termite annual plan slice 6a): billing_mode stays
// 'annual_prepay' after the customer declines renewal online, so the Billing
// tab's Auto Pay card (the healthy 'active' summary lives there; the status
// banner only renders alert states) must read
// /me's annualPrepay.renewalDeclined instead of promising that the saved
// method "is used at renewal". A term still awaiting its station
// installation has a provisional end date that is never quoted.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    getSchedule: vi.fn(),
    getNotificationPrefs: vi.fn(),
    getPropertyNotificationPrefs: vi.fn(),
    getPayments: vi.fn(),
    getBalance: vi.fn(),
    getCards: vi.fn(),
    getAutopay: vi.fn(),
    updateAutopay: vi.fn(),
    removeCard: vi.fn(),
    getNextService: vi.fn(),
    getServices: vi.fn(),
    getStationMap: vi.fn(),
    getTermiteBond: vi.fn(),
    getLawnHealth: vi.fn(),
    getRequests: vi.fn(),
  },
}));
vi.mock('../components/brand/CustomerDialogHost', () => ({
  showCustomerAlert: vi.fn(),
  showCustomerConfirm: vi.fn(async () => true),
}));

import api from '../utils/api';
import { BillingTab } from './PortalPage';

const baseCustomer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null, property: {},
};

const cards = [
  { id: 'pm-live', processor: 'stripe', methodType: 'card', brand: 'VISA', lastFour: '4242', expMonth: '12', expYear: '2032', isDefault: true, autopayEnabled: true },
];

const annualPrepayAutopay = {
  state: 'active',
  autopay_enabled: true,
  autopay_payment_method_id: 'pm-live',
  autopay_selected_method_ids: ['pm-live'],
  removal_guard: true,
  billing_day: 1,
  billing_mode: 'annual_prepay',
  non_monthly_billing: true,
  next_charge_date: null,
  next_charge_amount: null,
  monthly_rate: null,
  payment_methods: cards.map((c) => ({ id: c.id, brand: c.brand, last4: c.lastFour, method_type: 'card', is_default: c.isDefault, autopay_enabled: c.autopayEnabled })),
  recent_events: [],
};

const annualPrepay = (overrides = {}) => ({
  id: 'term-1', status: 'active', planLabel: 'WaveGuard Termite Annual Protection', prepayAmount: 450,
  termStart: '2026-09-25', termEnd: '2027-09-25', renewalDeclined: false, awaitsInstallation: false, ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getPayments.mockResolvedValue({ payments: [] });
  api.getBalance.mockResolvedValue({ currentBalance: 0 });
  api.getCards.mockResolvedValue({ cards });
  api.getNotificationPrefs.mockResolvedValue({});
  api.getLawnHealth.mockResolvedValue({ available: false });
  api.getStationMap.mockResolvedValue({ available: false });
  api.getTermiteBond.mockResolvedValue({ available: false });
  api.getAutopay.mockResolvedValue(annualPrepayAutopay);
});

// BillingTab loads several endpoints before the Auto Pay card settles —
// give the first render headroom on a loaded machine.
const SETTLE = { timeout: 10000 };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Billing tab annual-prepay renewal copy', { timeout: 30000 }, () => {
  it('an undecided annual plan keeps the "saved method is used at renewal" copy', async () => {
    render(<BillingTab customer={{ ...baseCustomer, annualPrepay: annualPrepay() }} />);
    expect(await screen.findByText('Your plan is prepaid; your saved method is used at renewal.', {}, SETTLE)).toBeInTheDocument();
    expect(screen.queryByText(/won’t renew/)).not.toBeInTheDocument();
  });

  it('a declined plan says it won’t renew, with its coverage end', async () => {
    render(<BillingTab customer={{ ...baseCustomer, annualPrepay: annualPrepay({ status: 'cancelled', renewalDeclined: true }) }} />);
    expect(await screen.findByText('Your plan won’t renew; coverage continues through Sep 25, 2027.', {}, SETTLE)).toBeInTheDocument();
    expect(screen.queryByText(/used at renewal/)).not.toBeInTheDocument();
  });

  it('a plan declined before its station installation never quotes the provisional end date', async () => {
    render(<BillingTab customer={{ ...baseCustomer, annualPrepay: annualPrepay({ status: 'cancelled', renewalDeclined: true, awaitsInstallation: true }) }} />);
    expect(await screen.findByText('Your plan won’t renew; coverage runs 12 months from your station installation.', {}, SETTLE)).toBeInTheDocument();
    expect(screen.queryByText(/2027/)).not.toBeInTheDocument();
    expect(screen.queryByText(/used at renewal/)).not.toBeInTheDocument();
  });
});

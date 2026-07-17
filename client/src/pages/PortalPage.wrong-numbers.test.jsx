// @vitest-environment jsdom
// Pins the tranche-2 wrong-number fixes: figures shown to the customer must
// come from server data, not lossy client derivations.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Any api method not explicitly mocked returns a forever-pending promise, so
// untested widgets sit in their loading states instead of crashing the render.
vi.mock('../utils/api', () => {
  const target = {};
  const proxy = new Proxy(target, {
    get: (obj, prop) => {
      if (typeof prop !== 'string') return obj[prop];
      if (!(prop in obj)) obj[prop] = vi.fn(() => new Promise(() => {}));
      return obj[prop];
    },
    set: (obj, prop, value) => { obj[prop] = value; return true; },
  });
  return { default: proxy };
});

import api from '../utils/api';
import { BillingTab, PropertyTab, ServicesTab } from './PortalPage';

const customer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null,
  monthlyRate: 89, property: { propertySqFt: 5000, bedSqFt: 800, lotSqFt: 9000 },
};

const THIS_YEAR = new Date().getFullYear();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getPayments.mockResolvedValue({ payments: [] });
  api.getBalance.mockResolvedValue({ currentBalance: 0 });
  api.getCards.mockResolvedValue({ cards: [] });
  api.getAutopay.mockResolvedValue({ state: 'disabled' });
  api.getNotificationPrefs.mockResolvedValue({});
  api.getPropertyPreferences.mockResolvedValue({ preferences: {} });
  api.getServicePreferences.mockResolvedValue({ preferences: {} });
  api.getServices.mockResolvedValue({ services: [], total: 0 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('YTD totals net of partial refunds', () => {
  it('subtracts refundAmount from paid totals and shows the refund line', async () => {
    api.getPayments.mockResolvedValue({
      payments: [{
        id: 'pay-1', description: 'Quarterly Pest Control',
        date: `${THIS_YEAR}-03-10`, amount: 100, refundAmount: 40,
        status: 'paid', type: 'recurring',
      }],
    });

    render(<BillingTab customer={customer} />);

    expect(await screen.findByText('−$40.00 refunded')).toBeInTheDocument();
    expect(screen.getAllByText('$60.00').length).toBeGreaterThan(0);
  });
});

describe('expired default card', () => {
  it('shows an action-needed state instead of green Auto Pay', async () => {
    api.getCards.mockResolvedValue({
      cards: [{ id: 'card-1', isDefault: true, lastFour: '4242', cardBrand: 'Visa', expMonth: 1, expYear: 2020 }],
    });
    api.getAutopay.mockResolvedValue({ state: 'active', next_charge_amount: 89, next_charge_date: `${THIS_YEAR + 1}-01-15` });

    render(<BillingTab customer={customer} />);

    expect(await screen.findByText(/card ending in 4242 has expired/i)).toBeInTheDocument();
    expect(screen.queryByText(/auto pay is on/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/next charge \$89/i)).not.toBeInTheDocument();
  });
});

describe('treated lawn area', () => {
  it('shows the stored treated-lawn figure without subtracting beds', async () => {
    render(<PropertyTab customer={customer} />);

    expect(await screen.findByText('Treated Lawn')).toBeInTheDocument();
    expect(screen.getByText('5,000 sq ft')).toBeInTheDocument();
    expect(screen.getByText('Beds')).toBeInTheDocument();
    expect(screen.getByText('800 sq ft')).toBeInTheDocument();
    expect(screen.queryByText('4,200 sq ft')).not.toBeInTheDocument();
  });
});

describe('expanded visit hydration and pagination', () => {
  const listRow = {
    id: 'svc-1', date: `${THIS_YEAR}-02-14`, type: 'Lawn Fertilization Round 2', status: 'completed',
    hasPhotos: false, photoCount: 0,
    products: [{ product_name: 'Prodiamine 65 WDG', product_category: 'herbicide', active_ingredient: 'Prodiamine' }],
  };

  it('fetches the full record on expand so Rate and Amount render', async () => {
    api.getServices.mockResolvedValue({ services: [listRow], total: 1 });
    api.getService.mockResolvedValue({
      id: 'svc-1', photos: [],
      products: [{
        product_name: 'Prodiamine 65 WDG', product_category: 'herbicide',
        active_ingredient: 'Prodiamine', application_rate: '0.5', rate_unit: 'oz/1000 sq ft',
        total_amount: '2.5', amount_unit: 'oz',
      }],
    });

    render(<ServicesTab />);
    fireEvent.click(await screen.findByText('Lawn Fertilization Round 2'));

    await waitFor(() => expect(api.getService).toHaveBeenCalledWith('svc-1'));
    expect(await screen.findByText('0.5 oz/1000 sq ft')).toBeInTheDocument();
    expect(screen.getByText('2.5 oz')).toBeInTheDocument();
  });

  it('offers Load More when the server reports more visits than one page', async () => {
    const rows = ['a', 'b', 'c'].map((k, i) => ({
      id: `svc-${k}`, date: `${THIS_YEAR}-0${i + 1}-10`, type: `Pest Control ${k}`,
      status: 'completed', hasPhotos: false, photoCount: 0, products: [],
    }));
    api.getServices
      .mockResolvedValueOnce({ services: rows, total: 5 })
      .mockResolvedValueOnce({
        services: [{ id: 'svc-d', date: `${THIS_YEAR - 1}-05-10`, type: 'Pest Control d', status: 'completed', hasPhotos: false, photoCount: 0, products: [] }],
        total: 5,
      });

    render(<ServicesTab />);

    expect(await screen.findByRole('button', { name: 'Load More Visits' })).toBeInTheDocument();
    expect(screen.getByText('Showing 3 of 5 visits')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load More Visits' }));

    await waitFor(() => expect(api.getServices).toHaveBeenLastCalledWith({ limit: 100, offset: 3 }));
    expect(await screen.findByText('Pest Control d')).toBeInTheDocument();
  });
});

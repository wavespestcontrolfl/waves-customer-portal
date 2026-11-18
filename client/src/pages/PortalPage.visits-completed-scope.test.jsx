// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { VisitsTab } from './PortalPage';

const customer = { id: 'cust-1', firstName: 'Pat', lastName: 'Customer', tier: 'Silver', property: {} };
const savedOnly = [{ id: 'cust-1:pa', key: 'cust-1:pa', customerId: 'cust-1', propertyId: 'pa', isPrimaryProperty: true, isPrimaryProfile: true, address: { line1: '1200 Palm Row Ct', city: 'Parrish', state: 'FL', zip: '34219' } }];
const profileShaped = [{ id: 'cust-1' }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getServices.mockResolvedValue({ services: [] });
  api.getSchedule.mockResolvedValue({ upcoming: [] });
});
afterEach(() => cleanup());

const openCompleted = (props = {}) => render(
  <VisitsTab customer={customer} properties={savedOnly} activePropertyId="cust-1:pa" subTab="completed" onSubTabChange={() => {}} {...props} />
);

describe('Completed visits by property', () => {
  it('opens the selected house, then shows retired and unassigned history in All properties', async () => {
    api.getServices.mockImplementation(async ({ historyProperty }) => ({
      historyProperty, historyCustomerId: customer.id,
      services: [{ id: 'record', status: 'completed', date: '2026-01-10', type: 'Pest', propertyAddress: historyProperty === 'all' ? 'Retired address' : 'Selected address' }],
      total: 1,
    }));
    openCompleted();
    expect(await screen.findByText('Selected address')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'All properties on this profile' })).toHaveValue('all');
    fireEvent.change(screen.getByRole('combobox', { name: /Show completed visits for/ }), { target: { value: 'all' } });
    expect(screen.queryByText('Selected address')).not.toBeInTheDocument();
    expect(await screen.findByText('Retired address')).toBeInTheDocument();
    expect(api.getServices).toHaveBeenCalledWith({ limit: 100, historyProperty: 'pa' });
    expect(api.getServices).toHaveBeenCalledWith({ limit: 100, historyProperty: 'all' });
  });

  it('withholds records served for another property or by an older server', async () => {
    api.getServices.mockResolvedValue({ services: [{ id: 'wrong', type: 'Wrong house' }], historyProperty: 'pb', historyCustomerId: customer.id });
    openCompleted();
    expect(await screen.findByText('Could not load service history')).toBeInTheDocument();
    expect(screen.queryByText('Wrong house')).not.toBeInTheDocument();
  });

  it.each([
    { properties: profileShaped, activePropertyId: 'cust-1' },
    { customer: { ...customer, actor: { kind: 'contact' } } },
    { customer: { ...customer, cancelled: true } },
  ])('keeps the existing read path when property history is unavailable', async (props) => {
    openCompleted(props);
    expect(await screen.findByText('No completed visits yet')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Show completed visits for/ })).not.toBeInTheDocument();
    expect(api.getServices).toHaveBeenCalledWith({ limit: 100 });
  });
});

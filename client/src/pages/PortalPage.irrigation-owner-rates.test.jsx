// @vitest-environment jsdom
// GATE_IRRIGATION_OWNER_RATES: the line under Minutes per Zone shows the number the server would use. The server
// carries the choice as irrigationOwnerRates in GET /api/property/preferences (key absent while the gate is off).
// Off: package table (spray 1.5 in/hr) and the University of Florida attribution. On: owner table (spray 1.0 in/hr),
// "typical head rates" only. A typed Weekly Inches entry still wins over the derived figure.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    getPropertyPreferences: vi.fn(),
    getWateringPlan: vi.fn(),
    updatePropertyPreferences: vi.fn(),
    getServicePreferences: vi.fn(),
    updateServicePreferences: vi.fn(),
  },
}));

import api from '../utils/api';
import { PropertyTab } from './PortalPage';

const lawnCustomer = { id: 'cust-1', firstName: 'Pat', lastName: 'Customer', phone: '9415551234', email: 'pat@example.com', tier: 'Gold', property: {} };
const SPRAY_PREFS = { irrigationRunMinutes: 30, wateringDays: ['Mon', 'Thu'], irrigationSystemType: ['spray'], irrigationInchesPerWeek: null };

beforeEach(() => {
  vi.clearAllMocks();
  api.getWateringPlan.mockResolvedValue({ available: false });
  api.getServicePreferences.mockResolvedValue({ preferences: {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('portal derived irrigation line follows the server rate table', () => {
  it('gate off (no key): 30 min x 2 days on spray = 1.5" a week, with the University of Florida attribution', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: SPRAY_PREFS, hasLawnCare: true });
    render(<PropertyTab customer={lawnCustomer} />);
    const line = await screen.findByText(/a week from 30 minutes per zone, 2 days a week on spray heads/);
    expect(line).toHaveTextContent('About 1.5" a week from 30 minutes per zone, 2 days a week on spray heads — typical head rates from University of Florida turf guidance.');
  });

  it('gate on: the same entries read 1" a week, "typical head rates" only', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: SPRAY_PREFS, hasLawnCare: true, irrigationOwnerRates: true });
    render(<PropertyTab customer={lawnCustomer} />);
    const line = await screen.findByText(/a week from 30 minutes per zone, 2 days a week on spray heads/);
    expect(line).toHaveTextContent('About 1" a week from 30 minutes per zone, 2 days a week on spray heads — typical head rates. If your controller');
    expect(line).not.toHaveTextContent('University of Florida');
  });

  it('gate on: a typed Weekly Inches entry still wins, and the line says so', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: { ...SPRAY_PREFS, irrigationInchesPerWeek: 0.8 }, hasLawnCare: true, irrigationOwnerRates: true });
    render(<PropertyTab customer={lawnCustomer} />);
    const line = await waitFor(() => screen.getByText(/works out to about 1" a week/));
    expect(line).toHaveTextContent('your Weekly Inches entry above is what we\'ll use');
  });
});

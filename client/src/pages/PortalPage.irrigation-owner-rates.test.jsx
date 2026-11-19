// @vitest-environment jsdom
// The line under Minutes per Zone shows the number the server would use: the owner table (spray 1.0 in/hr),
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
  it('the same entries read 1" a week, "typical head rates" only', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: SPRAY_PREFS, hasLawnCare: true });
    render(<PropertyTab customer={lawnCustomer} />);
    const line = await screen.findByText(/a week from 30 minutes per zone, 2 days a week on spray heads/);
    expect(line).toHaveTextContent('About 1" a week from 30 minutes per zone, 2 days a week on spray heads — typical head rates. If your controller');
    expect(line).not.toHaveTextContent('University of Florida');
  });

  it('a typed Weekly Inches entry still wins, and the line says so', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: { ...SPRAY_PREFS, irrigationInchesPerWeek: 0.8 }, hasLawnCare: true });
    render(<PropertyTab customer={lawnCustomer} />);
    const line = await waitFor(() => screen.getByText(/works out to about 1" a week/));
    expect(line).toHaveTextContent('your Weekly Inches entry above is what we\'ll use');
  });
});

describe('water source (phase 2 of "water you saved")', () => {
  it('shows the three answers under Irrigation, the saved one pressed, and the summary names it', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: { ...SPRAY_PREFS, irrigationWaterSource: 'well' }, hasLawnCare: true });
    render(<PropertyTab customer={lawnCustomer} />);
    const well = await screen.findByRole('button', { name: 'Private well' });
    expect(well).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'County water' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Reclaimed' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText(/well water/)).toBeInTheDocument();
  });
});

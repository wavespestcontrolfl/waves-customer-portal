// @vitest-environment jsdom
// Home's misting system card (dark behind GATE_MOSQUITO_MISTING on the server):
// shown when GET /api/misting-system returns a system; hidden for
// { system: null }, for a failed read, and when the propertyScope echo names
// another house than Home shows.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
import { DashboardTab } from './PortalPage';

const customer = { id: 'cust-1', firstName: 'Pat', lastName: 'Customer', phone: '9415551234', email: 'pat@example.com', tier: 'Silver', monthlyRate: 89, property: {} };
const primary = { id: 'cust-1:pa', key: 'cust-1:pa', customerId: 'cust-1', propertyId: 'pa', isPrimaryProperty: true, isPrimaryProfile: true, address: { line1: '1200 Palm Row Ct', city: 'Parrish', state: 'FL', zip: '34219' } };
const secondary = { id: 'cust-1:pb', key: 'cust-1:pb', customerId: 'cust-1', propertyId: 'pb', isPrimaryProperty: false, isPrimaryProfile: false, address: { line1: '418 Oak Ave', city: 'Bradenton', state: 'FL', zip: '34205' } };

const system = {
  installedOn: '2026-05-02',
  lastRefillOn: '2026-10-12',
  nextCheckOn: '2026-11-12',
  nextMistAt: '2099-01-01T23:30:00.000Z',
  mistTimes: ['06:30', '19:30'],
};

const renderHome = (props = {}) => render(
  <DashboardTab customer={customer} properties={[primary, secondary]} activePropertyId="cust-1:pa" onSwitchTab={() => {}} onOpenPlanService={() => {}} {...props} />,
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getNextService.mockResolvedValue({ next: null });
  api.getServices.mockResolvedValue({ services: [] });
  api.getGoogleReviewCard.mockResolvedValue({ card: null });
  api.getTodayTracker.mockResolvedValue({ tracker: null });
  api.getActiveTracker.mockResolvedValue({ tracker: null });
  api.getPropertyPreferences.mockResolvedValue({ preferences: {} });
  api.getWeather.mockResolvedValue(null);
  api.getPropertyAlerts.mockResolvedValue({ available: false });
  api.getPropertyScore.mockResolvedValue({ available: false });
  api.getPropertyRecommendations.mockResolvedValue({ available: false });
});
afterEach(() => cleanup());

describe('Home misting system card', () => {
  it('shows the card when the read returns a system', async () => {
    api.getMistingSystem.mockResolvedValue({ propertyScope: { enabled: true, propertyId: 'pa', closed: false }, system });
    renderHome();
    expect(await screen.findByText('Your misting system')).toBeInTheDocument();
    expect(screen.getByText('Last refill')).toBeInTheDocument();
    expect(screen.getByText('Next check')).toBeInTheDocument();
  });

  it('is hidden when the read returns { system: null } (gate off, no system, contact login)', async () => {
    api.getMistingSystem.mockResolvedValue({ system: null });
    renderHome();
    await waitFor(() => expect(api.getMistingSystem).toHaveBeenCalled());
    await screen.findByText('At a glance');
    expect(screen.queryByText('Your misting system')).not.toBeInTheDocument();
  });

  it('is hidden when the read fails, with no error text', async () => {
    api.getMistingSystem.mockRejectedValue(new Error('boom'));
    renderHome();
    await waitFor(() => expect(api.getMistingSystem).toHaveBeenCalled());
    await screen.findByText('At a glance');
    expect(screen.queryByText('Your misting system')).not.toBeInTheDocument();
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
  });

  it('is hidden, and the property list re-read, when the echo names another house than Home shows', async () => {
    const refresh = vi.fn();
    api.getMistingSystem.mockResolvedValue({ propertyScope: { enabled: true, propertyId: 'pa', closed: false }, system });
    renderHome({ activePropertyId: 'cust-1:pb', onSavedScopeUnavailable: refresh });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByText('Your misting system')).not.toBeInTheDocument();
  });

  it('re-reads the card just after the next mist passes, so an open Home never keeps a past time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const soon = { ...system, nextMistAt: new Date(Date.now() + 2000).toISOString() };
      api.getMistingSystem.mockResolvedValue({ propertyScope: { enabled: true, propertyId: 'pa', closed: false }, system: soon });
      renderHome();
      expect(await screen.findByText('Your misting system')).toBeInTheDocument();
      expect(api.getMistingSystem).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3500);
      await waitFor(() => expect(api.getMistingSystem).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows under a secondary house when the echo matches it', async () => {
    api.getMistingSystem.mockResolvedValue({ propertyScope: { enabled: true, propertyId: 'pb', closed: false }, system });
    renderHome({ activePropertyId: 'cust-1:pb' });
    expect(await screen.findByText('Your misting system')).toBeInTheDocument();
  });
});

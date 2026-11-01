// @vitest-environment jsdom
// Home's pet-name ask (dark behind GATE_PET_NAME_TEXT on the server): shown when GET /api/property/pet-name-ask
// answers { ask: true }; hidden for { ask: false }, for a failed read, under a secondary house (pets are the
// profile's) and after "Not now" on this device. "Add pet names" opens the Pets section of the Property tab.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { PET_NAME_ASK_COPY } from '../components/portal/petNameAskCopy';

const customer = { id: 'cust-1', firstName: 'Pat', lastName: 'Customer', phone: '9415551234', email: 'pat@example.com', tier: 'Silver', monthlyRate: 89, property: {} };
const primary = { id: 'cust-1:pa', key: 'cust-1:pa', customerId: 'cust-1', propertyId: 'pa', isPrimaryProperty: true, isPrimaryProfile: true, address: { line1: '1200 Palm Row Ct', city: 'Parrish', state: 'FL', zip: '34219' } };
const secondary = { id: 'cust-1:pb', key: 'cust-1:pb', customerId: 'cust-1', propertyId: 'pb', isPrimaryProperty: false, isPrimaryProfile: false, address: { line1: '418 Oak Ave', city: 'Bradenton', state: 'FL', zip: '34205' } };

const renderHome = (props = {}) => render(
  <DashboardTab customer={customer} properties={[primary, secondary]} activePropertyId="cust-1:pa" onSwitchTab={() => {}} onOpenPlanService={() => {}} {...props} />,
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try { localStorage.clear(); } catch { /* jsdom storage */ }
  api.getNextService.mockResolvedValue({ next: null });
  api.getServices.mockResolvedValue({ services: [] });
  api.getGoogleReviewCard.mockResolvedValue({ card: null });
  api.getTodayTracker.mockResolvedValue({ tracker: null });
  api.getActiveTracker.mockResolvedValue({ tracker: null });
  api.getPropertyPreferences.mockResolvedValue({ preferences: {} });
  api.getMistingSystem.mockResolvedValue({ system: null });
  api.getYardWrapped.mockResolvedValue({ enabled: false });
  api.getWeather.mockResolvedValue(null);
  api.getPropertyAlerts.mockResolvedValue({ available: false });
  api.getPropertyScore.mockResolvedValue({ available: false });
  api.getPropertyRecommendations.mockResolvedValue({ available: false });
});
afterEach(() => cleanup());

describe('Home pet-name ask', () => {
  it('shows when the server asks, and "Add pet names" opens the Pets section', async () => {
    const onOpenPets = vi.fn();
    api.getPetNameAsk.mockResolvedValue({ ask: true });
    renderHome({ onOpenPets });
    expect(await screen.findByText(PET_NAME_ASK_COPY.title)).toBeInTheDocument();
    expect(screen.getByText(PET_NAME_ASK_COPY.body)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pet-name-ask-add'));
    expect(onOpenPets).toHaveBeenCalledTimes(1);
  });

  it('is hidden for { ask: false } (gate off, a non-member, a name on file) and for a failed read', async () => {
    api.getPetNameAsk.mockResolvedValue({ ask: false });
    renderHome();
    await waitFor(() => expect(api.getPetNameAsk).toHaveBeenCalled());
    await screen.findByText('At a glance');
    expect(screen.queryByTestId('pet-name-ask-card')).not.toBeInTheDocument();
    cleanup();
    api.getPetNameAsk.mockRejectedValue(new Error('boom'));
    renderHome();
    await waitFor(() => expect(api.getPetNameAsk).toHaveBeenCalledTimes(2));
    await screen.findByText('At a glance');
    expect(screen.queryByTestId('pet-name-ask-card')).not.toBeInTheDocument();
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
  });

  it('"Not now" hides it, and it stays hidden on the next visit to Home on this device', async () => {
    api.getPetNameAsk.mockResolvedValue({ ask: true });
    renderHome();
    fireEvent.click(await screen.findByTestId('pet-name-ask-not-now'));
    expect(screen.queryByTestId('pet-name-ask-card')).not.toBeInTheDocument();
    cleanup();
    renderHome();
    await waitFor(() => expect(api.getPetNameAsk).toHaveBeenCalledTimes(2));
    await screen.findByText('At a glance');
    expect(screen.queryByTestId('pet-name-ask-card')).not.toBeInTheDocument();
  });

  it('is hidden under a secondary house: the pets on file belong to the profile', async () => {
    api.getPetNameAsk.mockResolvedValue({ ask: true });
    renderHome({ activePropertyId: 'cust-1:pb' });
    await waitFor(() => expect(api.getPetNameAsk).toHaveBeenCalled());
    await screen.findByText('At a glance');
    expect(screen.queryByTestId('pet-name-ask-card')).not.toBeInTheDocument();
  });
});

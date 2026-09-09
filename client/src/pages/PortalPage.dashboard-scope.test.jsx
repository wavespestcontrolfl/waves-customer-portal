// @vitest-environment jsdom
// Home under the saved-property scope: the protection score and the local
// alerts describe the PRIMARY address (customer-keyed reads, the primary's
// ZIP). Under a NON-primary selection they are withheld behind a notice
// (uncapped codex #4207 r1t P1); under the primary they render as today.
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getNextService.mockResolvedValue({ next: null });
  api.getServices.mockResolvedValue({ services: [] });
  api.getPendingSatisfaction.mockResolvedValue({ pending: [] });
  api.getTodayTracker.mockResolvedValue({ tracker: null });
  api.getActiveTracker.mockResolvedValue({ tracker: null });
  api.getPropertyPreferences.mockResolvedValue({ preferences: {} });
  api.getWeather.mockResolvedValue(null);
  // The hooks adopt a payload only when the server says it is available.
  api.getPropertyAlerts.mockResolvedValue({ available: true, alerts: [{ ruleKey: 'rain', title: 'Heavy rain expected', body: 'Skip watering this week.' }] });
  api.getPropertyScore.mockResolvedValue({ available: false });
  api.getPropertyRecommendations.mockResolvedValue({ available: false });
});
afterEach(() => cleanup());

describe('Home under a saved-property selection', () => {
  // The satisfaction prompt is a per-house read: a prompt served under
  // another house than Home shows (the echo disagrees) is dropped and the
  // selection re-read (GitHub codex #4207 r11 P2).
  it('drops a satisfaction prompt echoed under another house and re-reads the selection', async () => {
    const refresh = vi.fn();
    api.getPendingSatisfaction.mockResolvedValue({ pending: [{ id: 'rec-1', service_type: 'Quarterly Pest Control', service_date: '2026-09-01' }], propertyScope: { enabled: true, propertyId: 'pa', closed: false } });
    render(<DashboardTab customer={customer} properties={[primary, secondary]} activePropertyId="cust-1:pb" onSwitchTab={() => {}} onOpenPlanService={() => {}} onSavedScopeUnavailable={refresh} />);
    await waitFor(() => expect(api.getPendingSatisfaction).toHaveBeenCalled());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByText('Visit Feedback')).not.toBeInTheDocument();
  });
  it('asks the satisfaction prompt when the echo matches the shown house', async () => {
    api.getPendingSatisfaction.mockResolvedValue({ pending: [{ id: 'rec-1', service_type: 'Quarterly Pest Control', service_date: '2026-09-01' }], propertyScope: { enabled: true, propertyId: 'pb', closed: false } });
    render(<DashboardTab customer={customer} properties={[primary, secondary]} activePropertyId="cust-1:pb" onSwitchTab={() => {}} onOpenPlanService={() => {}} />);
    expect(await screen.findByText('Visit Feedback')).toBeInTheDocument();
  });
  it('PRIMARY house: the local alerts card renders and Home asks for the selected house\'s last visit', async () => {
    render(<DashboardTab customer={customer} properties={[primary, secondary]} activePropertyId="cust-1:pa" onSwitchTab={() => {}} onOpenPlanService={() => {}} />);
    expect(await screen.findByText('Property Alerts')).toBeInTheDocument();
    expect(screen.queryByTestId('home-primary-facts-notice')).not.toBeInTheDocument();
    await waitFor(() => expect(api.getServices).toHaveBeenCalledWith({ limit: 1, propertyScoped: 1 }));
  });
  it('SECONDARY house: the score and the alerts are withheld behind the primary-address notice', async () => {
    render(<DashboardTab customer={customer} properties={[primary, secondary]} activePropertyId="cust-1:pb" onSwitchTab={() => {}} onOpenPlanService={() => {}} />);
    expect(await screen.findByTestId('home-primary-facts-notice')).toBeInTheDocument();
    await waitFor(() => expect(api.getPropertyAlerts).toHaveBeenCalled());
    expect(screen.queryByText('Property Alerts')).not.toBeInTheDocument();
    expect(screen.queryByText('What to watch this week')).not.toBeInTheDocument();
  });

  it('Last Visit follows the echo: a read the server scoped to ANOTHER house is withheld and the list is re-read; a matching echo renders the card', async () => {
    const visit = { id: 'svc-9', type: 'Quarterly Pest Control', date: '2026-09-01', status: 'completed' };
    const refresh = vi.fn();
    // The selected secondary was retired: the server fell back to the primary.
    api.getServices.mockResolvedValue({ services: [visit], propertyScope: { enabled: true, propertyId: 'pa', closed: false } });
    const view = render(<DashboardTab customer={customer} properties={[primary, secondary]} activePropertyId="cust-1:pb" onSwitchTab={() => {}} onOpenPlanService={() => {}} onSavedScopeUnavailable={refresh} />);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByText('Last Visit')).not.toBeInTheDocument();
    view.unmount();
    api.getServices.mockResolvedValue({ services: [visit], propertyScope: { enabled: true, propertyId: 'pb', closed: false } });
    render(<DashboardTab customer={customer} properties={[primary, secondary]} activePropertyId="cust-1:pb" onSwitchTab={() => {}} onOpenPlanService={() => {}} />);
    expect(await screen.findByText('Last Visit')).toBeInTheDocument();
  });

  it('a selection with NO listed entry (the list read failed while /auth/me resolved a house) withholds the primary\'s facts until confirmed (uncapped codex r1x P1); profile mode shows them', async () => {
    render(<DashboardTab customer={customer} properties={[]} activePropertyId="cust-1:pb" selectedProperty={{ key: 'cust-1:pb', customerId: 'cust-1', propertyId: 'pb' }} onSwitchTab={() => {}} onOpenPlanService={() => {}} />);
    expect(await screen.findByTestId('home-primary-facts-notice')).toBeInTheDocument();
    expect(screen.queryByText('Property Alerts')).not.toBeInTheDocument();
    cleanup();
    render(<DashboardTab customer={customer} properties={[]} activePropertyId="cust-1" onSwitchTab={() => {}} onOpenPlanService={() => {}} />);
    expect(await screen.findByText('Property Alerts')).toBeInTheDocument();
    expect(screen.queryByTestId('home-primary-facts-notice')).not.toBeInTheDocument();
  });
});

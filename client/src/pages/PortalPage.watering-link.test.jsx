import { etDateString, addETDays } from '../lib/timezone';
// @vitest-environment jsdom
// Watering-plan push targets use the owned-property switch and remain on My Property.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { BrowserRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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

const auth = vi.hoisted(() => ({ customer: null, properties: [], switchProperty: vi.fn(), logout: vi.fn() }));
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => auth,
  tokenCustomerId: () => auth.customer.id,
}));

import api from '../utils/api';
import PortalPage from './PortalPage';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.replaceState({}, '', '/');
  api.getSchedule.mockResolvedValue({ upcoming: [] });
  api.getNotificationPrefs.mockResolvedValue({});
  api.getPropertyNotificationPrefs.mockResolvedValue({ properties: [] });
  api.getAutopay.mockResolvedValue({ state: 'disabled' });
  api.getNextService.mockResolvedValue({ next: null });
  api.getBalance.mockResolvedValue({ currentBalance: 0 });
  api.getCards.mockResolvedValue({ cards: [] });
  api.getPayments.mockResolvedValue({ payments: [] });
  api.getServices.mockResolvedValue({ services: [], total: 0 });
  api.getRequests.mockResolvedValue({ requests: [] });
  api.getPendingSatisfaction.mockResolvedValue({ pending: [] });
  api.getReferrals.mockResolvedValue({ stats: null });
  api.getTodayTracker.mockResolvedValue({ tracker: null });
  api.getDocuments.mockResolvedValue({ documents: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const property = (id) => ({ id, firstName: 'Sample', lastName: 'Account', tier: null, property: {}, address: {} });
beforeEach(() => {
  auth.customer = property('property-1');
  auth.properties = [property('property-1'), property('property-2')];
  auth.switchProperty.mockImplementation(async (id) => { auth.customer = property(id); return true; });
  api.getPropertyPreferences.mockImplementation(async () => ({ preferences: {}, hasLawnCare: auth.customer.id === 'property-2' }));
  api.getServicePreferences.mockResolvedValue({ preferences: {} });
  api.getWateringPlan.mockImplementation(async () => ({ available: true, plan: auth.customer.id === 'property-2'
    ? { validThrough: etDateString(addETDays(new Date(), 6)), title: 'Owned property plan', summary: 'Saved summary', instruction: 'Watering instructions for property two', guides: [] } : null }));
  window.history.replaceState({}, '', '/?tab=property&wateringPlanCustomer=property-2');
});

it('a push opened on a non-lawn property can switch to the owned lawn property and remain in My Property', async () => {
  render(<BrowserRouter><PortalPage /></BrowserRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Open this property' }, { timeout: 5000 }));
  await waitFor(() => expect(auth.switchProperty).toHaveBeenCalledWith('property-2'));
  expect(await screen.findByText('Watering instructions for property two')).toBeInTheDocument();
  expect(window.location.search).toBe('?tab=property&wateringPlanCustomer=property-2');
});

it('an unowned target is never passed to the property switch', async () => {
  window.history.replaceState({}, '', '/?tab=property&wateringPlanCustomer=unowned');
  render(<BrowserRouter><PortalPage /></BrowserRouter>);
  expect(await screen.findByText('Choose the matching property from your account menu.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open this property' })).not.toBeInTheDocument();
  expect(auth.switchProperty).not.toHaveBeenCalled();
});

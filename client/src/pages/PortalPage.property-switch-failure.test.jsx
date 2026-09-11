// @vitest-environment jsdom
// UI audit F0314: a failed property switch tells the customer instead of silently staying put.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { BrowserRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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

const dialog = vi.hoisted(() => ({ alert: vi.fn(async () => {}), confirm: vi.fn(async () => true) }));
vi.mock('../components/brand/CustomerDialogHost', () => ({
  default: () => null,
  showCustomerAlert: dialog.alert,
  showCustomerConfirm: dialog.confirm,
}));

import api from '../utils/api';
import PortalPage from './PortalPage';

const property = (id, street) => ({ id, firstName: 'Sample', lastName: 'Account', tier: null, property: {}, address: { line1: street } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.replaceState({}, '', '/');
  api.getSchedule.mockResolvedValue({ upcoming: [] });
  api.getNotificationPrefs.mockResolvedValue({});
  api.getPropertyNotificationPrefs.mockResolvedValue({ properties: [] });
  api.getPropertyPreferences.mockResolvedValue({ preferences: {} });
  api.getServicePreferences.mockResolvedValue({ preferences: {} });
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
  auth.customer = property('property-1', '1 First St');
  auth.properties = [property('property-1', '1 First St'), property('property-2', '2 Second Ave')];
  auth.switchProperty.mockResolvedValue(false); // useAuth returns false on a rejected /auth/select-property
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('tells the customer when switching to another property fails', async () => {
  render(<BrowserRouter><PortalPage /></BrowserRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Account menu' }, { timeout: 5000 }));
  const other = (await screen.findAllByRole('button')).find((b) => /2 Second Ave/.test(b.textContent) && !b.disabled);
  expect(other).toBeTruthy();
  fireEvent.click(other);
  await waitFor(() => expect(auth.switchProperty).toHaveBeenCalledWith('property-2'));
  await waitFor(() => expect(dialog.alert).toHaveBeenCalledWith('We could not switch to that property just now. Please try again.'));
  expect(screen.queryByText(/Switching/)).not.toBeInTheDocument();
});

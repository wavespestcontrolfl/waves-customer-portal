// @vitest-environment jsdom
// Pins tab <-> browser-history sync: tab clicks write the URL, Back adopts
// the previous tab, refresh restores via the existing ?tab= deep-link parser.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { BrowserRouter } from 'react-router-dom';
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

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    customer: {
      id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
      phone: '9415551234', email: 'pat@example.com', tier: null,
      monthlyRate: 89, property: {},
    },
    logout: vi.fn(),
    properties: [],
    propertiesError: null,
    refreshProperties: vi.fn(),
    switchProperty: vi.fn(),
  }),
  tokenCustomerId: () => 'cust-1',
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('portal tab history sync', () => {
  it('writes the URL on tab clicks and walks back through tab history', async () => {
    render(<BrowserRouter><PortalPage /></BrowserRouter>);

    expect(await screen.findByText(/hello pat/i)).toBeInTheDocument();
    expect(window.location.search).toBe('');

    fireEvent.click(screen.getAllByRole('button', { name: 'Billing' })[0]);
    await waitFor(() => expect(window.location.search).toBe('?tab=billing'));

    fireEvent.click(screen.getAllByRole('button', { name: 'Refer' })[0]);
    await waitFor(() => expect(window.location.search).toBe('?tab=refer'));

    // Browser Back: returns to Billing (not out of the app), state follows.
    window.history.back();
    await waitFor(() => expect(window.location.search).toBe('?tab=billing'));
    expect(await screen.findByText('Billing & Payments')).toBeInTheDocument();

    // Back again: dashboard.
    window.history.back();
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(await screen.findByText(/hello pat/i)).toBeInTheDocument();
  });

  it('re-clicking the active tab does not stack duplicate history entries', async () => {
    render(<BrowserRouter><PortalPage /></BrowserRouter>);
    await screen.findByText(/hello pat/i);

    fireEvent.click(screen.getAllByRole('button', { name: 'Billing' })[0]);
    await waitFor(() => expect(window.location.search).toBe('?tab=billing'));
    const depth = window.history.length;

    fireEvent.click(screen.getAllByRole('button', { name: 'Billing' })[0]);
    await new Promise((r) => setTimeout(r, 50));
    expect(window.history.length).toBe(depth);
  });
});

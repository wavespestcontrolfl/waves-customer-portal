// @vitest-environment jsdom
// Owner pick 1A (UI audit 2026-11-02, UI-07): on phones the More sheet's
// support row read "Text" (the texting app) beside "Chat" (the Waves AI
// assistant). The assistant action now says "Ask Waves AI". #7439 renamed the
// account-menu list only; this pins the sheet the phone actually shows.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { BrowserRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
    sessionEpoch: 0,
    customer: {
      id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
      phone: '9415551234', email: 'pat@example.com', tier: 'Gold',
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

const ORIGINAL_INNER_WIDTH = window.innerWidth;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.replaceState({}, '', '/');
  api.getSchedule.mockResolvedValue({ upcoming: [] });
  api.getNotificationPrefs.mockResolvedValue({});
  api.getAutopay.mockResolvedValue({ state: 'disabled' });
  api.getNextService.mockResolvedValue({ next: null });
  api.getBalance.mockResolvedValue({ currentBalance: 0 });
  api.getServices.mockResolvedValue({ services: [], total: 0 });
  api.getRequests.mockResolvedValue({ requests: [] });
  api.getReferrals.mockResolvedValue({ stats: null });
  api.getTodayTracker.mockResolvedValue({ tracker: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.innerWidth = ORIGINAL_INNER_WIDTH;
});

describe('More sheet support row', () => {
  it('says Ask Waves AI for the assistant, beside Text for the texting app', async () => {
    window.innerWidth = 360; // useIsMobile reads innerWidth on mount
    render(<BrowserRouter><PortalPage /></BrowserRouter>);
    await screen.findByText(/hello pat/i);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const sheet = await screen.findByRole('dialog', { name: 'More navigation' });
    expect(within(sheet).getByRole('button', { name: 'Ask Waves AI' })).toBeInTheDocument();
    expect(within(sheet).getByRole('link', { name: 'Text' })).toHaveAttribute('href', 'sms:+19412975749');
    expect(within(sheet).queryByRole('button', { name: 'Chat' })).toBeNull();
  });
});

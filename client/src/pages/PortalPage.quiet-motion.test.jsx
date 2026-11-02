// @vitest-environment jsdom
// Quiet customer app (motion audit 2026-11-02, owner pick 3A): the lawn ring
// and bars draw their real values on the first render, the Service Today tile
// is static, and the More sheet slides only when a pointer opened it.
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
import PortalPage, { LawnHealthCard, ScheduleTab, ScoreRing } from './PortalPage';

const ORIGINAL_INNER_WIDTH = window.innerWidth;

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
  api.getGoogleReviewCard.mockResolvedValue({ card: null });
  api.getReferrals.mockResolvedValue({ stats: null });
  api.getTodayTracker.mockResolvedValue({ tracker: null });
  api.getDocuments.mockResolvedValue({ documents: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.innerWidth = ORIGINAL_INNER_WIDTH;
});

describe('lawn charts draw at once', () => {
  it('ScoreRing renders the real score on the first render, with no sweep transition', () => {
    const { container } = render(<ScoreRing score={80} size={90} stroke={7} label="OVERALL" />);
    const circles = container.querySelectorAll('circle');
    const arc = circles[1];
    const circumference = ((90 - 7) / 2) * 2 * Math.PI;
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference * 0.2, 5);
    expect(arc.style.transition).toBe('');
    expect(screen.getByText('80')).toBeInTheDocument();
  });

  it('LawnHealthCard bars render at their real width on the first render, with no width transition', () => {
    const scores = { turfDensity: 82, weedSuppression: 64, colorHealth: 71, stressDamage: 93, overallScore: 78 };
    const initialScores = { turfDensity: 40, weedSuppression: 40, colorHealth: 40, stressDamage: 40, overallScore: 40 };
    const { container } = render(<LawnHealthCard customerId="cust-1" scores={scores} initialScores={initialScores} embedded />);
    for (const pct of ['82%', '64%', '71%', '93%']) {
      const bars = [...container.querySelectorAll('div')].filter((el) => el.style.width === pct);
      expect(bars).toHaveLength(1);
      expect(bars[0].style.transition).toBe('');
    }
    const ring = container.querySelectorAll('circle')[1];
    expect(ring.style.transition).toBe('');
  });
});

describe('Service Today tile', () => {
  it('is a static tile: no animation on it and no pulse keyframes on the page', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    api.getSchedule.mockResolvedValue({ upcoming: [{
      id: 'svc-today', date: today, serviceType: 'Quarterly Pest Control',
      windowStart: null, status: 'pending', customerConfirmed: false,
    }] });
    render(<ScheduleTab customer={{ id: 'cust-1', firstName: 'Pat', lastName: 'Customer', property: {} }} />);
    const label = await screen.findByText('Service Today');
    const tile = label.parentElement.parentElement.firstElementChild;
    expect(tile.style.animation).toBe('');
    expect(tile.hasAttribute('data-sched-pulse')).toBe(false);
    expect(document.body.innerHTML).not.toMatch(/schedPulse/);
  });
});

describe('More sheet motion', () => {
  const openMore = async (detail) => {
    window.innerWidth = 360; // useIsMobile reads innerWidth on mount
    render(<BrowserRouter><PortalPage /></BrowserRouter>);
    await screen.findByText(/hello pat/i);
    fireEvent.click(screen.getByRole('button', { name: 'More' }), { detail });
    return screen.findByRole('dialog', { name: 'More navigation' });
  };

  it('appears at once when opened from the keyboard (click detail 0)', async () => {
    const sheet = await openMore(0);
    expect(sheet.style.animation).toBe('none');
  });

  it('keeps the 0.25 s slide when opened by a pointer (click detail 1)', async () => {
    const sheet = await openMore(1);
    expect(sheet.style.animation).toContain('moreSheetUp 0.25s');
  });

  it('keeps instant close', async () => {
    const sheet = await openMore(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close more menu' }));
    await waitFor(() => expect(sheet).not.toBeInTheDocument());
  });
});

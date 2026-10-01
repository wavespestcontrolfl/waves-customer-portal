// @vitest-environment jsdom
// Learn tab Local Conditions slot behind GATE_PORTAL_YARD_CALENDAR: gate off
// (or any failure) renders the existing WeatherPestWidget exactly as it
// renders on its own; gate on swaps in the yard-month card.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ enabled: false }));
vi.mock('../native/platform', async (importOriginal) => ({
  ...await importOriginal(), isNativeApp: () => native.enabled,
}));

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
import { LocalConditionsSlot, WeatherPestWidget } from './PortalPage';

const customer = { id: 'cust-1', firstName: 'Pat', lastName: 'Customer', tier: 'Silver', property: {} };
const WEATHER = {
  location: 'Venice, FL', temp: 88, nightTemp: 74, humidity: 70, wind: '5 mph', forecast: 'Mostly Sunny',
  isDaytime: true, updatedAt: '2026-10-01T18:12:00Z',
  pestPressure: {
    mosquito: { level: 'HIGH', color: '#E53935', advice: 'x' },
    fungus: { level: 'LOW', color: '#4CAF50', advice: 'x' },
    chinch: { level: 'LOW', color: '#4CAF50', advice: 'x' },
  },
  irrigationRecommendation: { inches: '0.50', note: 'Warm day' },
};
const YARD = {
  available: true, month: 10, monthName: 'October', location: { slug: 'venice-fl', label: 'Venice, FL', city: 'Venice' },
  plan: { lawn: true, pest: true, treeShrub: false, mosquito: false, rodent: false, termite: false },
  grass: { key: 'sta', known: true, label: 'St. Augustine' }, reviewedAt: '2026-09-30',
  items: [{ id: 'sod-webworm', category: 'lawn', name: 'Tropical sod webworm', hosts: 'St. Augustine', level: 3, levelLabel: 'Peak season', sign: 's', infoOnly: false }],
  hiddenCount: 0, homePests: [], lastLawnVisit: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  native.enabled = false;
  api.getWeather.mockResolvedValue(WEATHER);
  api.getLawnHealth.mockResolvedValue({ hasLawnCare: false });
});
afterEach(() => cleanup());

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('Local Conditions slot', () => {
  it('gate off: renders the existing widget, identical to the widget on its own', async () => {
    const standalone = render(<WeatherPestWidget customer={customer} nextService={null} />);
    await settle();
    const baseline = standalone.container.innerHTML;
    expect(baseline).toContain('Local Conditions');
    standalone.unmount();

    api.getYardMonth.mockResolvedValue({ available: false });
    const slot = render(<LocalConditionsSlot customer={customer} nextService={null} onOpenPhotoId={vi.fn()} />);
    await settle();
    expect(slot.container.innerHTML).toBe(baseline);
    expect(screen.queryByText('Your yard this month')).not.toBeInTheDocument();
  });

  it('a failed yard read also keeps the existing widget', async () => {
    api.getYardMonth.mockRejectedValue(new Error('500'));
    render(<LocalConditionsSlot customer={customer} nextService={null} onOpenPhotoId={null} />);
    await settle();
    expect(screen.getByText('Local Conditions')).toBeInTheDocument();
    expect(screen.queryByText('Your yard this month')).not.toBeInTheDocument();
  });

  it('gate on: the yard-month card replaces the widget', async () => {
    api.getYardMonth.mockResolvedValue(YARD);
    render(<LocalConditionsSlot customer={customer} nextService={null} onOpenPhotoId={vi.fn()} />);
    await settle();
    expect(screen.getByText('Your yard this month')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'October in Venice' })).toBeInTheDocument();
    expect(screen.queryByText('Mosquito Pressure')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Lawn' })).toBeInTheDocument();
  });

  it('native app: the lawn calendar teaser opens in the in-app overlay, not a new window', async () => {
    native.enabled = true;
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    api.getYardMonth.mockResolvedValue({
      ...YARD, plan: { lawn: false, pest: true, treeShrub: false, mosquito: false, rodent: false, termite: false },
    });
    render(<LocalConditionsSlot customer={customer} nextService={null} onOpenPhotoId={null} />);
    await settle();
    fireEvent.click(screen.getByRole('link', { name: /See what to look for/ }));
    expect(await screen.findByRole('dialog', { name: 'Lawn pest calendar' })).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('shows the widget loading panel while the gate answer is pending', () => {
    render(<LocalConditionsSlot customer={customer} nextService={null} onOpenPhotoId={null} />);
    expect(screen.getByText('Loading local conditions')).toBeInTheDocument();
  });
});

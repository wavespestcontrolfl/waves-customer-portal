// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/api', () => ({ default: { getWeather: vi.fn(), getYardMonth: vi.fn() } }));
import api from '../../utils/api';
import YardMonthCard, { yardTabsFor } from './YardMonthCard';

const item = (id, category, level, over = {}) => ({
  id, category, name: id.replace(/-/g, ' '), hosts: `${id} hosts`, level,
  levelLabel: level === 3 ? 'Peak season' : 'In season', sign: `${id} sign`, infoOnly: false, ...over,
});
const pest = (key, label, score10, level, line, inPlan) => ({ key, label, score10, level, note: `${label} note`, line, inPlan });

const PLAN_PEST_LAWN = { lawn: true, pest: true, treeShrub: false, mosquito: false, rodent: false, termite: false };
const PLAN_PEST_ONLY = { lawn: false, pest: true, treeShrub: false, mosquito: false, rodent: false, termite: false };

const YARD = {
  available: true,
  month: 10,
  monthName: 'October',
  location: { slug: 'venice-fl', label: 'Venice, FL', city: 'Venice' },
  plan: PLAN_PEST_LAWN,
  grass: { key: 'sta', known: true, label: 'St. Augustine' },
  reviewedAt: '2026-09-30',
  items: [
    item('sod-webworm', 'lawn', 3), item('white-grub', 'lawn', 3), item('fall-armyworm', 'lawn', 3), item('take-all-root-rot', 'lawn', 2),
    item('dollarweed', 'weed', 3), item('nutsedge', 'weed', 2),
    item('ficus-whitefly', 'shrub', 3), item('citrus-greening', 'shrub', 2, { infoOnly: true }),
  ],
  hiddenCount: 1,
  homePests: [
    pest('mosquitoes', 'Mosquitoes', 8, 'high', 'mosquito', false),
    pest('ants', 'Ants', 6, 'elevated', 'pest', true),
    pest('german_roach', 'Palmetto bugs', 5, 'moderate', 'pest', true),
    pest('rodents', 'Rodents', 4, 'moderate', 'rodent', false),
  ],
  lastLawnVisit: { date: '2026-09-18', reportUrl: '/report/tok123' },
};

const WEATHER = { temp: 88, nightTemp: 74, humidity: 70, forecast: 'Mostly Sunny', isDaytime: true, updatedAt: '2026-10-01T18:12:00Z' };

beforeEach(() => {
  vi.clearAllMocks();
  api.getWeather.mockResolvedValue(WEATHER);
});
afterEach(() => cleanup());

const renderCard = async (yard = YARD, onOpenPhotoId = vi.fn()) => {
  const view = render(<YardMonthCard yard={yard} onOpenPhotoId={onOpenPhotoId} />);
  await act(async () => {});
  return { ...view, onOpenPhotoId };
};

describe('lawn + pest customer', () => {
  it('shows the eyebrow, the month in the customer city, and the weather box', async () => {
    await renderCard();
    expect(screen.getByText('Your yard this month')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'October in Venice' })).toBeInTheDocument();
    const box = screen.getByTestId('yard-weather');
    expect(box).toHaveTextContent('88°');
    expect(box).toHaveTextContent('Venice weather');
    expect(box).toHaveTextContent('Tonight low 74°');
  });

  it('after dark the box says tonight and shows the low', async () => {
    api.getWeather.mockResolvedValue({ ...WEATHER, isDaytime: false, temp: 71, nightTemp: 71, forecast: 'Mostly Clear' });
    await renderCard();
    const box = screen.getByTestId('yard-weather');
    expect(box).toHaveTextContent('Mostly Clear tonight');
    expect(box).toHaveTextContent('Low 71°');
  });

  it('tabs follow the plan: Lawn, Home pests, Weeds (no Shrubs & trees without that plan line)', async () => {
    await renderCard();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Lawn', 'Home pests', 'Weeds']);
  });

  it('the Lawn tab lists at most three in-season items, the hidden-on-other-grasses note, and a level label per row', async () => {
    await renderCard();
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getAllByRole('listitem')).toHaveLength(3);
    expect(within(panel).getAllByText('Peak season')).toHaveLength(3);
    expect(within(panel).queryByText('take all root rot')).not.toBeInTheDocument();
    expect(within(panel).getByText('1 more in season on other grasses, hidden for your St. Augustine lawn.')).toBeInTheDocument();
  });

  it('with no grass on file the lawn tab says so instead of claiming a hidden count', async () => {
    await renderCard({ ...YARD, grass: { key: 'all', known: false, label: null }, hiddenCount: 0 });
    expect(screen.getByText('Grass type not set. Showing every grass.')).toBeInTheDocument();
    expect(screen.queryByText(/hidden for your/)).not.toBeInTheDocument();
  });

  it('the Weeds tab shows weeds; the Home pests tab splits plan from nearby', async () => {
    await renderCard();
    fireEvent.click(screen.getByRole('tab', { name: 'Weeds' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('dollarweed');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('nutsedge');
    fireEvent.click(screen.getByRole('tab', { name: 'Home pests' }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('In your pest plan · live forecast')).toBeInTheDocument();
    expect(within(panel).getByText('Also active nearby · not in your plan')).toBeInTheDocument();
    expect(within(panel).getByText('Ants')).toBeInTheDocument();
    expect(within(panel).getByText('Elevated 6/10')).toBeInTheDocument();
  });

  it('tabs are accessible: roles, aria-controls resolve to panels, roving tabindex, arrow keys move selection and focus', async () => {
    await renderCard();
    const tablist = screen.getByRole('tablist');
    const tabs = within(tablist).getAllByRole('tab');
    tabs.forEach((tab) => {
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      expect(panel).toHaveAttribute('role', 'tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    });
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveFocus();
    fireEvent.keyDown(tabs[1], { key: 'End' });
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs[2], { key: 'ArrowRight' });
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' });
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  });

  it('shows the last lawn visit with its report link, the Photo ID launcher, and the not-a-finding footer', async () => {
    const { onOpenPhotoId } = await renderCard();
    expect(screen.getByText('Last lawn visit: Sep 18')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View service report/ })).toHaveAttribute('href', '/report/tok123');
    fireEvent.click(screen.getByRole('button', { name: /Photo ID/ }));
    expect(onOpenPhotoId).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Seasonal guide reviewed Sep 30 · not a finding on your property')).toBeInTheDocument();
  });

  it('a visit with no report link shows the date only; no visit shows no row; no handler hides Photo ID', async () => {
    const { rerender } = await renderCard({ ...YARD, lastLawnVisit: { date: '2026-09-18', reportUrl: null } }, null);
    expect(screen.getByText('Last lawn visit: Sep 18')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View service report/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Photo ID/ })).not.toBeInTheDocument();
    rerender(<YardMonthCard yard={{ ...YARD, lastLawnVisit: null }} onOpenPhotoId={null} />);
    expect(screen.queryByText(/Last lawn visit/)).not.toBeInTheDocument();
  });

  it('info-only items carry the Info only label instead of a season level', async () => {
    await renderCard({ ...YARD, plan: { ...PLAN_PEST_LAWN, treeShrub: true } });
    fireEvent.click(screen.getByRole('tab', { name: 'Shrubs & trees' }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('Info only')).toBeInTheDocument();
    expect(within(panel).getByText('ficus whitefly')).toBeInTheDocument();
  });

  it('weather unavailable: the card renders without the weather box', async () => {
    api.getWeather.mockRejectedValue(new Error('down'));
    await renderCard();
    expect(screen.queryByTestId('yard-weather')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'October in Venice' })).toBeInTheDocument();
  });
});

describe('pest-only customer', () => {
  const PEST_ONLY = { ...YARD, plan: PLAN_PEST_ONLY, lastLawnVisit: { date: '2026-09-18', reportUrl: '/report/tok123' } };

  it('has no tablist, splits in-plan from nearby, and shows one lawn teaser', async () => {
    await renderCard(PEST_ONLY);
    expect(screen.getByText('Your home this month')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByText('In your pest plan · live forecast')).toBeInTheDocument();
    expect(screen.getByText('Also active nearby · not in your plan')).toBeInTheDocument();
    expect(screen.getByText('Your lawn in October: sod webworm and white grub are at peak.')).toBeInTheDocument();
  });

  it('does not show a lawn visit row or yard items to a customer without a lawn plan', async () => {
    await renderCard(PEST_ONLY);
    expect(screen.queryByText(/Last lawn visit/)).not.toBeInTheDocument();
    expect(screen.queryByText('Grass type not set. Showing every grass.')).not.toBeInTheDocument();
  });
});

describe('yardTabsFor', () => {
  it('a yard customer with any household line (mosquito, rodent, termite) also gets Home pests', () => {
    const base = { lawn: false, pest: false, treeShrub: false, mosquito: false, rodent: false, termite: false };
    expect(yardTabsFor({ ...base, lawn: true, mosquito: true }).map((t) => t.key)).toEqual(['lawn', 'home', 'weeds']);
    expect(yardTabsFor({ ...base, treeShrub: true, rodent: true }).map((t) => t.key)).toEqual(['home', 'shrubs']);
    expect(yardTabsFor({ ...base, treeShrub: true, termite: true }).map((t) => t.key)).toEqual(['home', 'shrubs']);
    expect(yardTabsFor({ ...base, lawn: true }).map((t) => t.key)).toEqual(['lawn', 'weeds']);
  });
  it('lawn-only: Lawn + Weeds; tree & shrub adds Shrubs & trees; no yard line falls back to the home forecast', () => {
    const base = { lawn: false, pest: false, treeShrub: false };
    expect(yardTabsFor({ ...base, lawn: true }).map((t) => t.key)).toEqual(['lawn', 'weeds']);
    expect(yardTabsFor({ ...base, pest: true, treeShrub: true }).map((t) => t.key)).toEqual(['home', 'shrubs']);
    expect(yardTabsFor(base).map((t) => t.key)).toEqual(['home']);
  });
});

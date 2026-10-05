// @vitest-environment jsdom
// Good / Better / Best plan picker (GATE_ESTIMATE_OFFER_TIERS). Every amount
// comes from the server payload; the picker only formats and selects.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OfferTierPicker from './OfferTierPicker';

afterEach(() => cleanup());

const betterFrequency = {
  key: 'quarterly',
  monthly: 32.1,
  perVisit: 107,
  perServiceTreatments: [{ service: 'pest_control', label: 'Pest Control (Quarterly)', perTreatment: 107, displayPrice: 96.3, visitsPerYear: 4 }],
};
const bestFrequency = {
  key: 'quarterly',
  monthly: 84.08,
  perServiceTreatments: [
    { service: 'pest_control', label: 'Pest Control (Quarterly)', perTreatment: 107, displayPrice: 96.3, visitsPerYear: 4 },
    { service: 'lawn_care', label: 'Lawn Care', perTreatment: 77, displayPrice: 69.3, visitsPerYear: 9 },
  ],
};

const pricing = {
  frequencies: [betterFrequency],
  services: [{ key: 'bundle', defaultFrequencyKey: 'quarterly', frequencies: [betterFrequency] }],
};

const tiers = [
  { key: 'good', label: 'One-time visit', serviceMode: 'one_time', services: ['one_time_pest'], oneTimeTotal: 264 },
  { key: 'better', label: 'Pest control plan', serviceMode: 'recurring', services: ['pest_control'], usesBundleFrequencies: true },
  {
    key: 'best',
    label: 'Pest control + companion plan',
    serviceMode: 'recurring',
    services: ['pest_control', 'lawn_care'],
    sections: [{ key: 'pest_control' }, { key: 'lawn_care' }],
    frequencies: [bestFrequency],
    waveGuardTier: 'Silver',
  },
];

const renderPicker = (props = {}) => render(
  <OfferTierPicker tiers={tiers} selectedKey="better" onSelect={() => {}} pricing={pricing} {...props} />,
);

describe('OfferTierPicker', () => {
  it('renders three radios named for the plans', () => {
    renderPicker();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios[0]).toHaveTextContent('One-time visit');
    expect(radios[1]).toHaveTextContent('Pest control plan');
    expect(radios[2]).toHaveTextContent('Pest + lawn care');
    expect(screen.getByText('Choose your plan')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pick the option that fits' })).toBeInTheDocument();
    expect(screen.getByText('You can change this any time before you approve.')).toBeInTheDocument();
  });

  it('good shows the one-time total from the server', () => {
    renderPicker();
    const good = screen.getAllByRole('radio')[0];
    expect(good).toHaveTextContent('$264.00');
    // Per application is the estimate surface's one price unit; the one-visit
    // nature of the tier is caption copy, never the unit.
    expect(good).toHaveTextContent('/ application');
    expect(good).toHaveTextContent('One application');
    expect(good).not.toHaveTextContent('one visit');
    expect(good).not.toHaveTextContent('Most popular');
  });

  it('better is checked by default, shows the per-application price and "Most popular"', () => {
    renderPicker();
    const [good, better, best] = screen.getAllByRole('radio');
    expect(better).toHaveAttribute('aria-checked', 'true');
    expect(good).toHaveAttribute('aria-checked', 'false');
    expect(best).toHaveAttribute('aria-checked', 'false');
    expect(better).toHaveTextContent('Most popular');
    // The net per-application price the price card leads with, not the pre-discount 107.
    expect(better).toHaveTextContent('$96.30');
    expect(better).toHaveTextContent('/ application');
    expect(better).toHaveTextContent('4 visits a year');
  });

  it('best shows both per-application figures, the cadences and a WaveGuard saving chip for Silver', () => {
    renderPicker({ selectedKey: 'best' });
    const best = screen.getAllByRole('radio')[2];
    expect(best).toHaveAttribute('aria-checked', 'true');
    // Per application is the estimate surface's one billing unit: both programs' net figures, never a monthly spread.
    expect(best).toHaveTextContent('$96.30 + $69.30');
    expect(best).toHaveTextContent('/ application');
    expect(best).not.toHaveTextContent('/ month');
    expect(best).toHaveTextContent('4×/yr pest');
    expect(best).toHaveTextContent('lawn 9×/yr');
    expect(best).toHaveTextContent('Save 10% on both');
    expect(best).toHaveTextContent('WaveGuard Silver');
  });

  it('prefers the discount the server stamped, and shows no saving chip at 0%', () => {
    // Rows reduced by the stamped 15% (the chip is corroborated per row).
    const goldFrequency = { ...bestFrequency, perServiceTreatments: [
      { service: 'pest_control', label: 'Pest Control (Quarterly)', perTreatment: 107, displayPrice: 90.95, visitsPerYear: 4 },
      { service: 'lawn_care', label: 'Lawn Care', perTreatment: 77, displayPrice: 65.45, visitsPerYear: 9 },
    ] };
    const stamped = tiers.map((t) => (t.key === 'best' ? { ...t, frequencies: [goldFrequency], combinedRecurring: { waveGuardDiscountPct: 0.15 }, waveGuardTier: 'Gold' } : t));
    const { unmount } = renderPicker({ tiers: stamped });
    expect(screen.getAllByRole('radio')[2]).toHaveTextContent('Save 15% on both');
    unmount();
    const bronze = tiers.map((t) => (t.key === 'best' ? { ...t, waveGuardTier: 'Bronze' } : t));
    renderPicker({ tiers: bronze });
    expect(screen.getAllByRole('radio')[2]).not.toHaveTextContent(/Save \d+%/);
  });

  it('names every companion on a three-program best tier', () => {
    const three = tiers.map((t) => (t.key === 'best' ? { ...t, services: ['pest_control', 'lawn_care', 'tree_shrub'] } : t));
    renderPicker({ tiers: three });
    expect(screen.getAllByRole('radio')[2]).toHaveTextContent('Pest + lawn care + tree & shrub care');
  });

  it('clicking a tile calls onSelect with its key', () => {
    const onSelect = vi.fn();
    renderPicker({ onSelect });
    fireEvent.click(screen.getAllByRole('radio')[2]);
    expect(onSelect).toHaveBeenCalledWith('best');
    fireEvent.click(screen.getAllByRole('radio')[0]);
    expect(onSelect).toHaveBeenCalledWith('good');
  });

  it('disabled ignores clicks', () => {
    const onSelect = vi.fn();
    renderPicker({ onSelect, disabled: true });
    const radios = screen.getAllByRole('radio');
    radios.forEach((radio) => expect(radio).toBeDisabled());
    fireEvent.click(radios[2]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders nothing without tiers', () => {
    const { container, rerender } = renderPicker({ tiers: [] });
    expect(container).toBeEmptyDOMElement();
    rerender(<OfferTierPicker tiers={undefined} selectedKey="better" onSelect={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('stacks the tiles on a narrow screen', () => {
    const original = window.matchMedia;
    window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    try {
      renderPicker();
      expect(screen.getByRole('radiogroup').style.gridTemplateColumns).toBe('minmax(0, 1fr)');
    } finally {
      window.matchMedia = original;
    }
  });

  it('a no-guarantee estimate drops the callback and Waves Guarantee wording from the tiles', () => {
    renderPicker({ estimate: { noGuaranteeClaims: true } });
    const [good, better] = screen.getAllByRole('radio');
    expect(good).toHaveTextContent('no plan, no commitment');
    expect(good).not.toHaveTextContent('30-day callback');
    expect(better).not.toHaveTextContent('Waves Guarantee');
  });

  it('promises the saving only for programs the server discounted', () => {
    const undiscountedLawn = { ...bestFrequency, perServiceTreatments: [
      { service: 'pest_control', label: 'Pest Control (Quarterly)', perTreatment: 107, displayPrice: 96.3, visitsPerYear: 4 },
      { service: 'lawn_care', label: 'Lawn Care', perTreatment: 77, displayPrice: 77, visitsPerYear: 9, waveGuardDiscountEligible: false },
    ] };
    const partial = tiers.map((t) => (t.key === 'best' ? { ...t, frequencies: [undiscountedLawn] } : t));
    renderPicker({ tiers: partial, selectedKey: 'best' });
    const best = screen.getAllByRole('radio')[2];
    expect(best).not.toHaveTextContent('Save 10% on both');
    expect(best).toHaveTextContent('Save 10% on eligible programs');
    expect(best).toHaveTextContent('WaveGuard Silver');
  });

  it('drops the percentage promise when a program is reduced by less than the tier rate (a floor-clamped row)', () => {
    const clampedLawn = { ...bestFrequency, perServiceTreatments: [
      { service: 'pest_control', label: 'Pest Control (Quarterly)', perTreatment: 107, displayPrice: 96.3, visitsPerYear: 4 },
      // Reduced, but only 4% — not the 10% the tier names.
      { service: 'lawn_care', label: 'Lawn Care', perTreatment: 77, displayPrice: 73.92, visitsPerYear: 9 },
    ] };
    const clamped = tiers.map((t) => (t.key === 'best' ? { ...t, frequencies: [clampedLawn] } : t));
    renderPicker({ tiers: clamped, selectedKey: 'best' });
    const best = screen.getAllByRole('radio')[2];
    expect(best).not.toHaveTextContent('Save 10%');
    expect(best).toHaveTextContent('WaveGuard Silver');
  });

  it('quotes the cadence the customer chose below, and the matched combo rows on an active Best', () => {
    const monthlyBetter = { ...betterFrequency, key: 'monthly', label: 'Monthly', visitsPerYear: 12,
      perServiceTreatments: [{ service: 'pest_control', label: 'Pest Control (Monthly)', perTreatment: 74.9, displayPrice: 67.41, visitsPerYear: 12 }] };
    const monthlyBest = { ...bestFrequency, key: 'monthly', label: 'Monthly', perServiceTreatments: [
      { service: 'pest_control', label: 'Pest Control (Monthly)', perTreatment: 74.9, displayPrice: 67.41, visitsPerYear: 12 },
      { service: 'lawn_care', label: 'Lawn Care', perTreatment: 77, displayPrice: 69.3, visitsPerYear: 9 },
    ] };
    const withMonthly = tiers.map((t) => (t.key === 'best' ? { ...t, frequencies: [bestFrequency, monthlyBest] } : t));
    const monthlyPricing = { ...pricing, frequencies: [betterFrequency, monthlyBetter] };
    const { unmount } = renderPicker({ tiers: withMonthly, pricing: monthlyPricing, selectedFrequencyKey: 'monthly' });
    const [, better, best] = screen.getAllByRole('radio');
    expect(better).toHaveTextContent('$67.41');
    expect(best).toHaveTextContent('$67.41 + $69.30');
    unmount();
    // Active Best with a 12x lawn combo: the tile shows the combo's rows.
    const combo = { perServiceTreatments: [
      { service: 'pest_control', perTreatment: 107, displayPrice: 96.3, visitsPerYear: 4 },
      { service: 'lawn_care', perTreatment: 79, displayPrice: 71.1, visitsPerYear: 12 },
    ] };
    renderPicker({ tiers: withMonthly, pricing: monthlyPricing, selectedKey: 'best', selectedFrequencyKey: 'quarterly', selectedCombo: combo });
    const bestActive = screen.getAllByRole('radio')[2];
    expect(bestActive).toHaveTextContent('$96.30 + $71.10');
    expect(bestActive).toHaveTextContent('lawn 12×/yr');
  });
});

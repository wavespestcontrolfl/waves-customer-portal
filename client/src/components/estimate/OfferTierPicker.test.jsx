// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OfferTierPicker from './OfferTierPicker';

afterEach(() => cleanup());

// Every figure below comes from the (mock) server block — the picker must
// render what the server derived and hold no price of its own.
const tiersFixture = (overrides = {}) => ({
  state: 'best',
  companionKey: 'lawn_care',
  companionLabel: 'Lawn Care',
  good: { oneTimeTotal: 149 },
  better: {
    rows: [{ service: 'pest_control', perApplication: 114, visitsPerYear: 4 }],
    oneTimeTotal: 99,
    waveGuardTier: 'Bronze',
  },
  best: {
    rows: [
      { service: 'pest_control', perApplication: 96.3, visitsPerYear: 4 },
      { service: 'lawn_care', perApplication: 69.3, visitsPerYear: 9 },
    ],
    oneTimeTotal: 0,
    waveGuardTier: 'Silver',
  },
  ...overrides,
});

function renderPicker(props = {}) {
  const onSelect = vi.fn();
  const utils = render(
    <OfferTierPicker
      tiers={tiersFixture()}
      selectedKey="best"
      onSelect={onSelect}
      estimate={{}}
      change={null}
      {...props}
    />,
  );
  return { onSelect, ...utils };
}

describe('OfferTierPicker', () => {
  it('renders nothing without an offerTiers block', () => {
    const { container } = render(<OfferTierPicker tiers={null} selectedKey={null} onSelect={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the card copy and three radios with the right names', () => {
    renderPicker();
    expect(screen.getByText('Choose your plan')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pick the option that fits' })).toBeInTheDocument();
    expect(screen.getByText('You can change this any time before you approve.')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /One-time visit/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Pest control plan/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Pest \+ lawn care/ })).toBeInTheDocument();
  });

  it('marks only the selected tile checked', () => {
    renderPicker({ selectedKey: 'better' });
    expect(screen.getByRole('radio', { name: /Pest control plan/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /One-time visit/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: /Pest \+ lawn care/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('Good shows the one-time total per application, never "one visit"', () => {
    renderPicker();
    const good = screen.getByRole('radio', { name: /One-time visit/ });
    expect(within(good).getByText('$149.00')).toBeInTheDocument();
    expect(within(good).getByText('/ application')).toBeInTheDocument();
    expect(within(good).getByText(/One application · no plan, no commitment · 30-day callback/)).toBeInTheDocument();
    expect(good.textContent).not.toMatch(/one visit/i);
    expect(within(good).queryByText('Most popular')).not.toBeInTheDocument();
  });

  it('Better shows its pest price, the most-popular chip and the first-visit line', () => {
    renderPicker();
    const better = screen.getByRole('radio', { name: /Pest control plan/ });
    expect(within(better).getByText('$114.00')).toBeInTheDocument();
    expect(within(better).getByText('Most popular')).toBeInTheDocument();
    expect(within(better).getByText(/4 applications a year · Waves Guarantee/)).toBeInTheDocument();
    expect(within(better).getByText('+ $99.00 one-time first-visit charges')).toBeInTheDocument();
  });

  it('Better drops the first-visit line when there is no one-time charge', () => {
    const tiers = tiersFixture();
    tiers.better.oneTimeTotal = 0;
    renderPicker({ tiers });
    expect(screen.queryByText(/first-visit charges/)).not.toBeInTheDocument();
  });

  it('Better falls back to year-round wording when the cadence is unknown', () => {
    const tiers = tiersFixture();
    tiers.better.rows = [{ service: 'pest_control', perApplication: 114 }];
    renderPicker({ tiers });
    expect(screen.getByText(/Year-round service · Waves Guarantee/)).toBeInTheDocument();
  });

  it('Best shows each per-application price, the WaveGuard chip and the saving chip', () => {
    renderPicker();
    const best = screen.getByRole('radio', { name: /Pest \+ lawn care/ });
    expect(within(best).getByText('$96.30 + $69.30')).toBeInTheDocument();
    expect(within(best).getByText('WaveGuard Silver')).toBeInTheDocument();
    // 114.00 - 96.30, a difference of two server figures.
    expect(within(best).getByText('Save $17.70 per pest application')).toBeInTheDocument();
    expect(within(best).getByText(/4 pest and 9 lawn applications a year/)).toBeInTheDocument();
  });

  it('Best has no saving chip when its pest figure is not lower than Better', () => {
    const tiers = tiersFixture();
    tiers.best.rows[0].perApplication = 114;
    renderPicker({ tiers });
    expect(screen.queryByText(/^Save /)).not.toBeInTheDocument();
    tiers.best.rows[0].perApplication = 120;
    cleanup();
    renderPicker({ tiers });
    expect(screen.queryByText(/^Save /)).not.toBeInTheDocument();
  });

  it('Best has no saving chip when a pest figure is missing, and falls back on cadence words', () => {
    const tiers = tiersFixture();
    tiers.best.rows = [
      { service: 'pest_control', perApplication: 96.3 },
      { service: 'lawn_care', perApplication: 69.3 },
    ];
    tiers.better.rows = [];
    renderPicker({ tiers });
    // Without a Better tile price there is nothing to save against.
    expect(screen.queryByText(/^Save /)).not.toBeInTheDocument();
    expect(screen.getByText('Both programs on one plan')).toBeInTheDocument();
  });

  it('Best shows the first-visit line when its one-time total is positive', () => {
    const tiers = tiersFixture();
    tiers.best.oneTimeTotal = 49;
    renderPicker({ tiers });
    const best = screen.getByRole('radio', { name: /Pest \+ lawn care/ });
    expect(within(best).getByText('+ $49.00 one-time first-visit charges')).toBeInTheDocument();
  });

  it('omits Good when the block has none', () => {
    renderPicker({ tiers: tiersFixture({ good: null }) });
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.queryByRole('radio', { name: /One-time visit/ })).not.toBeInTheDocument();
  });

  it.each([['noGuaranteeClaims'], ['noEstimateWideGuarantee']])('drops the callback and guarantee words under %s', (flag) => {
    renderPicker({ estimate: { [flag]: true } });
    expect(screen.queryByText(/30-day callback/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Waves Guarantee/)).not.toBeInTheDocument();
    expect(screen.getByText('One application · no plan, no commitment')).toBeInTheDocument();
  });

  it('calls onSelect with the tile key', () => {
    const { onSelect } = renderPicker();
    fireEvent.click(screen.getByRole('radio', { name: /Pest control plan/ }));
    expect(onSelect).toHaveBeenCalledWith('better');
    fireEvent.click(screen.getByRole('radio', { name: /One-time visit/ }));
    expect(onSelect).toHaveBeenCalledWith('good');
  });

  it('disables the tiles and says so while the price is being checked or written', () => {
    const { rerender, onSelect } = renderPicker({ change: { phase: 'previewing', targetKey: 'better' } });
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(screen.getByText('Checking your price…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Pest control plan/ }));
    expect(onSelect).not.toHaveBeenCalled();
    rerender(
      <OfferTierPicker
        tiers={tiersFixture()}
        selectedKey="best"
        onSelect={onSelect}
        change={{ phase: 'committing', targetKey: 'better' }}
      />,
    );
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(screen.getByText('Updating your estimate…')).toBeInTheDocument();
  });

  it('disables the tiles when the page locks them', () => {
    renderPicker({ disabled: true });
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });

  it('shows the server disclosures in the confirm block and wires both buttons', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderPicker({
      change: {
        phase: 'preview',
        targetKey: 'better',
        quote: {
          disclosures: [
            { code: 'waveguard_tier_change', message: 'Dropping Lawn Care moves your WaveGuard tier from Silver to Bronze.' },
            'A single-service plan includes the $99.00 WaveGuard setup fee.',
          ],
        },
        onConfirm,
        onCancel,
      },
    });
    expect(screen.getByText('Switch to Pest control plan?')).toBeInTheDocument();
    expect(screen.getByText(/moves your WaveGuard tier from Silver to Bronze/)).toBeInTheDocument();
    expect(screen.getByText(/includes the \$99\.00 WaveGuard setup fee/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep what I have' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Switch my plan' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('names the move in the confirm heading for each target', () => {
    const quote = { disclosures: [] };
    renderPicker({ change: { phase: 'preview', targetKey: 'good', quote, onConfirm: vi.fn(), onCancel: vi.fn() } });
    expect(screen.getByText('Switch to One-time visit?')).toBeInTheDocument();
    cleanup();
    renderPicker({ change: { phase: 'preview', targetKey: 'best', quote, onConfirm: vi.fn(), onCancel: vi.fn() } });
    expect(screen.getByText('Switch to Pest + lawn care?')).toBeInTheDocument();
  });

  it('shows no confirm block outside the preview phase', () => {
    renderPicker({ change: { phase: 'idle', targetKey: null, quote: null } });
    expect(screen.queryByRole('button', { name: 'Switch my plan' })).not.toBeInTheDocument();
  });

  it('never prints a per-visit, monthly or yearly price unit', () => {
    const { container } = renderPicker({
      change: {
        phase: 'preview',
        targetKey: 'better',
        quote: { disclosures: [{ message: 'Pest Control changes from $96.30 to $114.00 per application.' }] },
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      },
    });
    expect(container.textContent).not.toMatch(/per visit|per month|\/ ?mo\b|\/ ?yr\b/i);
  });

  it('lays out in one column when matchMedia is missing', () => {
    const original = window.matchMedia;
    window.matchMedia = undefined;
    try {
      renderPicker();
      expect(screen.getByRole('radiogroup')).toHaveStyle({ gridTemplateColumns: '1fr' });
    } finally {
      window.matchMedia = original;
    }
  });

  it('lays out three columns at 640px and wider', () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn(() => ({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    try {
      renderPicker();
      expect(screen.getByRole('radiogroup').style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))');
    } finally {
      window.matchMedia = original;
    }
  });

  it('the selected tile follows the cadence chosen below; the saving chip steps aside and a note explains the other tiles', () => {
    const monthlyRows = [
      { service: 'pest_control', perApplication: 67.41, visitsPerYear: 12 },
      { service: 'lawn_care', perApplication: 69.3, visitsPerYear: 9 },
    ];
    const { unmount } = render(
      <OfferTierPicker tiers={tiersFixture()} selectedKey="best" onSelect={() => {}} currentRows={monthlyRows} cadenceIsDefault={false} />,
    );
    const best = screen.getAllByRole('radio').find((el) => /BEST/.test(el.textContent));
    expect(best).toHaveTextContent('$67.41 + $69.30');
    expect(screen.queryByText(/per pest application/)).not.toBeInTheDocument();
    expect(screen.getByText(/other options show the standard schedule/i)).toBeInTheDocument();
    unmount();
    // Better selected: only its pest row is replaced; Best keeps the server's standard figures.
    render(
      <OfferTierPicker tiers={tiersFixture()} selectedKey="better" onSelect={() => {}}
        currentRows={[{ service: 'pest_control', perApplication: 83.46, visitsPerYear: 12 }]} cadenceIsDefault={false} />,
    );
    const better = screen.getAllByRole('radio').find((el) => /BETTER/.test(el.textContent));
    expect(better).toHaveTextContent('$83.46');
  });
});

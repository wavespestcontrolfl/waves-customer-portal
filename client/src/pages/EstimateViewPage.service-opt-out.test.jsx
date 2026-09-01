// @vitest-environment jsdom
// Customer service opt-out — the control, its confirm panel, and the mirror
// add-offer suppression. The control is server-gated: it renders only for a
// section the payload stamped `removable`, from the same resolver the PUT uses,
// so the page can never offer an action the write refuses.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceSection, estimateAddServiceOffer } from './EstimateViewPage';

afterEach(() => cleanup());

const frequency = {
  key: 'standard',
  label: 'Standard',
  monthly: 50,
  annual: 600,
  included: [{ key: 'service', label: 'Recurring service' }],
  addOns: [],
};

const lawnSection = (overrides = {}) => ({
  key: 'lawn_care',
  label: 'Lawn Care',
  isRecurring: true,
  isPest: false,
  frequencies: [frequency],
  copy: { priceWording: {} },
  ...overrides,
});

function renderSection(serviceOptOut, sectionOverrides = {}) {
  return render(
    <ServiceSection
      section={lawnSection(sectionOverrides)}
      selectedFrequencyKey="standard"
      selectedAddOns={new Set()}
      onFrequencyChange={vi.fn()}
      onAddOnToggle={vi.fn()}
      renderFlags={{}}
      waveGuardTier="Silver"
      serviceOptOut={serviceOptOut}
    />,
  );
}

const idleOptOut = (overrides = {}) => ({
  phase: 'idle',
  quote: null,
  onPreview: vi.fn(),
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
  ...overrides,
});

describe('the opt-out control', () => {
  it('is absent when the section carries no opt-out wiring', () => {
    renderSection(null);
    expect(screen.queryByRole('button', { name: /I don't want/i })).not.toBeInTheDocument();
  });

  it('offers the removal in the section it belongs to', () => {
    renderSection(idleOptOut());
    expect(screen.getByRole('button', { name: "I don't want Lawn Care" })).toBeInTheDocument();
  });

  it('asks the server for a price before showing anything to confirm', async () => {
    // The preview is a dryRun: it writes nothing, and it is what turns a
    // price that goes UP into a disclosed number rather than a surprise.
    const onPreview = vi.fn();
    renderSection(idleOptOut({ onPreview }));
    fireEvent.click(screen.getByRole('button', { name: "I don't want Lawn Care" }));
    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it('shows a busy state while the preview is in flight', () => {
    renderSection(idleOptOut({ phase: 'previewing' }));
    expect(screen.getByRole('button', { name: 'Checking your new price…' })).toBeDisabled();
  });
});

describe('the confirm panel', () => {
  const quote = {
    previous: { monthlyTotal: 150, annualTotal: 1800, onetimeTotal: 0, waveGuardTier: 'Gold' },
    next: { monthlyTotal: 106, annualTotal: 1272, onetimeTotal: 99, waveGuardTier: 'Silver' },
    previewBasis: '2026-08-31T12:00:00.000Z',
    disclosures: [
      { code: 'waveguard_tier_change', message: 'Dropping Lawn Care moves your WaveGuard tier from Gold to Silver, so the services you keep are priced at the Silver rate.' },
      { code: 'membership_setup_fee', message: 'A single-service plan includes the $99.00 WaveGuard setup fee, which the combined plan did not.' },
      { code: 'recurring_per_application', message: 'Pest Control changes from $103.00 to $114.00 per application.' },
    ],
  };

  it('never renders a combined plan total — per-application copy only (owner price-copy rule)', () => {
    // "$X/mo"/"$X/yr" are banned on customer estimate surfaces; the panel
    // speaks through the dryRun's per-application disclosures instead.
    renderSection(idleOptOut({ phase: 'preview', quote }));
    expect(screen.getByText('Remove Lawn Care?')).toBeInTheDocument();
    expect(screen.queryByText(/Your plan becomes/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$106\.00\/mo/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$1,?272/)).not.toBeInTheDocument();
    expect(screen.getByText(/changes from \$103\.00 to \$114\.00 per application/)).toBeInTheDocument();
  });

  it('surfaces the first-visit change when the one-time total moves', () => {
    renderSection(idleOptOut({ phase: 'preview', quote }));
    expect(screen.getByText('$99.00')).toBeInTheDocument();
    expect(screen.getByText(/was \$0\.00/)).toBeInTheDocument();
  });

  it('renders every disclosure — the tier drop and the setup fee are the ones that raise the bill', () => {
    renderSection(idleOptOut({ phase: 'preview', quote }));
    expect(screen.getByText(/moves your WaveGuard tier from Gold to Silver/)).toBeInTheDocument();
    expect(screen.getByText(/includes the \$99\.00 WaveGuard setup fee/)).toBeInTheDocument();
  });

  it('commits only on the explicit confirm, and offers a way out', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderSection(idleOptOut({ phase: 'preview', quote, onConfirm, onCancel }));

    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove Lawn Care' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('locks both buttons while the commit is in flight', () => {
    renderSection(idleOptOut({ phase: 'submitting', quote }));
    expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeDisabled();
  });

  it('shows no disclosure list when nothing else moved', () => {
    renderSection(idleOptOut({
      phase: 'preview',
      quote: { ...quote, disclosures: [] },
    }));
    expect(screen.getByText('Remove Lawn Care?')).toBeInTheDocument();
    expect(screen.queryByText(/WaveGuard tier from/)).not.toBeInTheDocument();
  });

  it('falls back to a plain reassurance when nothing else moved at all', () => {
    renderSection(idleOptOut({
      phase: 'preview',
      quote: {
        previous: { monthlyTotal: 150, annualTotal: 1800, onetimeTotal: 0 },
        next: { monthlyTotal: 106, annualTotal: 1272, onetimeTotal: 0 },
        disclosures: [],
      },
    }));
    expect(screen.getByText(/updates right away/)).toBeInTheDocument();
  });
});

describe('the mirror add-service offer', () => {
  const services = [{ key: 'pest_control', label: 'Pest Control', isRecurring: true }];

  it('offers lawn care when the customer simply does not have it', () => {
    expect(estimateAddServiceOffer(services, 'recurring', null)?.serviceKey).toBe('lawn_care');
  });

  it('does NOT offer back the service the customer just removed', () => {
    // Without the suppression the page answers "remove lawn care" with
    // "Add Lawn Care and save more" — in three render sites.
    expect(estimateAddServiceOffer(services, 'recurring', null, ['lawn_care'])?.serviceKey)
      .not.toBe('lawn_care');
  });

  it('moves the ladder on to the next service rather than going silent', () => {
    // Suppressed keys fold into the "already has it" set, so the cross-sell
    // continues instead of disappearing entirely.
    expect(estimateAddServiceOffer(services, 'recurring', null, ['lawn_care'])?.serviceKey)
      .toBe('mosquito');
  });

  it('ignores a malformed suppression list rather than throwing', () => {
    expect(() => estimateAddServiceOffer(services, 'recurring', null, null)).not.toThrow();
    expect(estimateAddServiceOffer(services, 'recurring', null, undefined)?.serviceKey).toBe('lawn_care');
  });
});

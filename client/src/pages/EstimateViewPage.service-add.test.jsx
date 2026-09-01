// @vitest-environment jsdom
// Priced add-a-service (GATE_ESTIMATE_SERVICE_ADD): when the server stamps
// the offer's key addable, the add-service card prices the line in place —
// dryRun preview first, confirm bound to that preview — instead of filing a
// bundle inquiry. Without the stamp the inquiry card is byte-identical.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EstimateAddServiceRequestCard, offerFromAddable } from './EstimateViewPage';

afterEach(() => cleanup());

const offer = { serviceKey: 'mosquito', label: 'Mosquito', title: 'Add Mosquito and save more', body: 'Add mosquito protection and our team will send an updated bundle option.' };

describe('EstimateAddServiceRequestCard', () => {
  it('without a priced stamp it is the office inquiry card', () => {
    const onRequest = vi.fn();
    render(<EstimateAddServiceRequestCard offer={offer} requestState={{ status: 'idle' }} onRequest={onRequest} />);
    expect(screen.getByText(offer.body)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add Mosquito' }));
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it('priced: the tap asks the server for a price, never files an inquiry', () => {
    const onRequest = vi.fn();
    const onPreview = vi.fn();
    render(<EstimateAddServiceRequestCard
      offer={offer}
      requestState={{ status: 'idle' }}
      onRequest={onRequest}
      priced={{ phase: 'idle', quote: null, onPreview, onConfirm: vi.fn(), onCancel: vi.fn() }}
    />);
    expect(screen.queryByText(offer.body)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'See my price with Mosquito' }));
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onRequest).not.toHaveBeenCalled();
  });

  it('priced: shows the busy state while previewing', () => {
    render(<EstimateAddServiceRequestCard
      offer={offer}
      requestState={{ status: 'idle' }}
      onRequest={vi.fn()}
      priced={{ phase: 'previewing', quote: null, onPreview: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn() }}
    />);
    expect(screen.getByRole('button', { name: 'Checking your price…' })).toBeDisabled();
  });

  it('priced: the confirm panel shows the disclosed terms and the commit is a separate tap', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const quote = {
      previous: { monthlyTotal: 40, annualTotal: 480, onetimeTotal: 0, waveGuardTier: 'Bronze' },
      next: { monthlyTotal: 95, annualTotal: 1140, onetimeTotal: 0, waveGuardTier: 'Silver' },
      previewBasis: 'digest',
      disclosures: [
        { code: 'waveguard_tier_change', message: 'Adding Mosquito moves your WaveGuard tier from Bronze to Silver, so your services are priced at the Silver rate.' },
        { code: 'added_per_application', message: 'Mosquito is $60.00 per application.' },
      ],
    };
    render(<EstimateAddServiceRequestCard
      offer={offer}
      requestState={{ status: 'idle' }}
      onRequest={vi.fn()}
      priced={{ phase: 'preview', quote, onPreview: vi.fn(), onConfirm, onCancel }}
    />);
    expect(screen.getByText('Add Mosquito?')).toBeInTheDocument();
    expect(screen.getByText(/Mosquito is \$60\.00 per application/)).toBeInTheDocument();
    expect(screen.getByText(/Bronze to Silver/)).toBeInTheDocument();
    // No combined plan total anywhere on the panel (standing price-copy rule).
    expect(screen.queryByText(/\$95/)).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, add Mosquito' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Never mind' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('priced: submitting disables the confirm', () => {
    const quote = { previous: { onetimeTotal: 0 }, next: { onetimeTotal: 0 }, disclosures: [] };
    render(<EstimateAddServiceRequestCard
      offer={offer}
      requestState={{ status: 'idle' }}
      onRequest={vi.fn()}
      priced={{ phase: 'submitting', quote, onPreview: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn() }}
    />);
    expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();
    expect(screen.getByText(/joins your plan with no change/)).toBeInTheDocument();
  });
});

describe('offerFromAddable', () => {
  it('builds the priced offer from the server stamp when the legacy ladder has no candidate', () => {
    expect(offerFromAddable([{ key: 'pest_control', label: 'Pest Control' }, { key: 'lawn_care', label: 'Lawn Care' }]))
      .toEqual({ serviceKey: 'pest_control', label: 'Pest Control', title: 'Add Pest Control and save more', body: '' });
    expect(offerFromAddable([])).toBeNull();
    expect(offerFromAddable([{ key: '', label: 'x' }, null])).toBeNull();
  });
});

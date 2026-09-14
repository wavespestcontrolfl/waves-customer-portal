// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'annual-restore-token' }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

const payload = {
  estimate: {
    customerFirstName: 'Rita', address: '12 Oak Lane', serviceCategory: 'pest_control',
    acceptance: { mode: 'standard_slot_pick' }, defaultServiceMode: 'recurring',
    isOneTimeOnly: false, showOneTimeOption: false, billByInvoice: false,
  },
  pricing: {
    services: [{ key: 'pest_control', label: 'Pest Control', isRecurring: true, isPest: true,
      frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 50, annual: 600,
        included: [{ key: 'service', label: 'Recurring service' }], addOns: [] }],
      copy: { priceWording: {} } }],
    askChips: [], defaultServiceMode: 'recurring', renderFlags: {},
  },
  cta: { canAccept: true, terminalState: null, quoteRequired: false, reviewBeforeBooking: false },
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('customer restore projection', () => {
  it('hides a baseline-proven annual restore while keeping a removable lawn restore', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({
      ...payload,
      serviceOptOut: {
        removedKeys: ['termite_bait', 'lawn_care'],
        removedLabels: ['Termite Bait Stations', 'Lawn Care'],
        restoreBlockedKeys: ['termite_bait'],
      },
    }) })));
    render(<EstimateViewPage />);
    await waitFor(() => expect(screen.getByText('Lawn Care removed')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Add it back' })).toBeInTheDocument();
    expect(screen.queryByText('Termite Bait Stations removed')).not.toBeInTheDocument();
  });
});

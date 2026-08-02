// @vitest-environment jsdom
// Cockroach Treatment first-visit fee cards (codex #3078 r3):
// 1. An existing-customer recurring-pest estimate carries NO WaveGuard setup
//    fee (prepay-ineligible, membership fee waived outright), so
//    section.setupFee is null — the roach fee card must render on its own
//    evidence, not vanish behind the unrelated WaveGuard gate.
// 2. Multi-service plans embed the roach row inside the pest section's own
//    one-time block — the plan-level SetupFeeCard list must not render the
//    identical charge and treatment count a second time.
// 3. Safety: a multi-service payload whose breakdown never classified the
//    roach row into a section keeps the plan-level card (skipping it would
//    lose the fee from the page entirely).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ token: 'roach-fee-token' }),
}));

vi.mock('../lib/stripeLoader', () => ({
  loadStripeSdk: vi.fn(async () => null),
}));

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

const ROACH_FEE = {
  service: 'pest_initial_roach',
  amount: 225,
  label: 'Cockroach Treatment',
  treatments: 2,
  waivedWithPrepay: false,
};

const WAVEGUARD_FEE = {
  service: 'waveguard_setup',
  amount: 99,
  label: 'WaveGuard setup',
  waivedWithPrepay: true,
};

function pestSection({ oneTimeContribution = null } = {}) {
  return {
    key: 'pest_control',
    label: 'Pest Control',
    isRecurring: true,
    isPest: true,
    setupFee: null,
    oneTimeContribution,
    frequencies: [{
      key: 'quarterly',
      label: 'Quarterly',
      monthly: 50,
      annual: 600,
      included: [{ key: 'service', label: 'Recurring service' }],
      addOns: [],
    }],
    copy: { priceWording: {} },
  };
}

function lawnSection() {
  return {
    key: 'lawn_care',
    label: 'Lawn Care',
    isRecurring: true,
    isPest: false,
    setupFee: null,
    oneTimeContribution: null,
    frequencies: [{
      key: 'enhanced',
      label: 'Enhanced',
      monthly: 80,
      annual: 960,
      included: [{ key: 'service', label: 'Recurring lawn service' }],
      addOns: [],
    }],
    copy: { priceWording: {} },
  };
}

function payload({ services, firstVisitFees, setupFee = null }) {
  return {
    estimate: {
      customerFirstName: 'Rita',
      address: '12 Roach Row',
      serviceCategory: 'pest_control',
      acceptance: { mode: 'standard_slot_pick' },
      membership: null,
      intelligence: null,
      askToken: 'ask-token',
      defaultServiceMode: 'recurring',
      isOneTimeOnly: false,
      showOneTimeOption: true,
      billByInvoice: false,
      licenseNumber: 'JB000000',
      acceptedServiceMode: null,
      acceptedFrequencyKey: null,
    },
    pricing: {
      services,
      askChips: [],
      anchorOneTimePrice: 225,
      firstVisitFees,
      setupFee,
      defaultServiceMode: 'recurring',
      renderFlags: { showWaveGuardSetupFee: true },
    },
    cta: {
      canAccept: true,
      terminalState: null,
      quoteRequired: false,
      quoteRequiredReason: null,
      reviewBeforeBooking: false,
      reviewReason: null,
    },
  };
}

function mockFetch(body) {
  return vi.fn(async (url) => {
    if (String(url).includes('/data')) return jsonResponse(body);
    return jsonResponse({});
  });
}

// jsdom in this runner ships without a usable localStorage (same workaround
// as EstimateViewPage.draft-preview.test.jsx) — stub a functional one.
function stubLocalStorage(store = {}) {
  vi.stubGlobal('localStorage', {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EstimateViewPage roach first-visit fee cards', () => {
  it('renders the roach fee card when the WaveGuard setup fee is suppressed (existing customer)', async () => {
    stubLocalStorage();
    vi.stubGlobal('fetch', mockFetch(payload({
      services: [pestSection()],
      firstVisitFees: [ROACH_FEE],
    })));

    render(<EstimateViewPage />);

    await waitFor(() => {
      expect(screen.getByText(/\+ \$225\.00 one-time Cockroach Treatment/)).toBeInTheDocument();
    });
    expect(screen.getByText('Includes 2 treatment visits')).toBeInTheDocument();
  });

  it('does not render a plan-level roach card when the row is embedded in the pest section', async () => {
    stubLocalStorage();
    vi.stubGlobal('fetch', mockFetch(payload({
      services: [
        pestSection({
          oneTimeContribution: {
            items: [{ service: 'pest_initial_roach', label: 'Cockroach Treatment', amount: 225, kind: 'charge' }],
            subtotal: 225,
          },
        }),
        lawnSection(),
      ],
      firstVisitFees: [WAVEGUARD_FEE, ROACH_FEE],
      setupFee: WAVEGUARD_FEE,
    })));

    render(<EstimateViewPage />);

    await waitFor(() => {
      expect(screen.getByText(/one-time WaveGuard setup/)).toBeInTheDocument();
    });
    // The embedded section row is the ONE rendered occurrence of the charge.
    expect(screen.getAllByText('Cockroach Treatment')).toHaveLength(1);
    expect(screen.queryByText(/one-time Cockroach Treatment/)).not.toBeInTheDocument();
  });

  it('keeps the plan-level roach card when no section embeds the row', async () => {
    stubLocalStorage();
    vi.stubGlobal('fetch', mockFetch(payload({
      services: [pestSection(), lawnSection()],
      firstVisitFees: [WAVEGUARD_FEE, ROACH_FEE],
      setupFee: WAVEGUARD_FEE,
    })));

    render(<EstimateViewPage />);

    await waitFor(() => {
      expect(screen.getByText(/\+ \$225\.00 one-time Cockroach Treatment/)).toBeInTheDocument();
    });
    expect(screen.getByText('Includes 2 treatment visits')).toBeInTheDocument();
  });
});

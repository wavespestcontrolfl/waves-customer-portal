// @vitest-environment jsdom
// Exercise the page and real inline payment component across the accept/quote round trip.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';
vi.mock('react-router-dom', () => ({
  useParams: () => ({
    token: 'synthetic-prepay-token'
  })
}));
vi.mock('../lib/stripeLoader', () => ({
  loadStripeSdk: vi.fn(async () => () => ({
    elements: () => ({
      create: () => ({
        mount: vi.fn(),
        update: vi.fn(),
        on: (event, cb) => {
          if (event === 'ready') queueMicrotask(cb);
        }
      })
    }),
    retrieveSetupIntent: async () => ({
      setupIntent: {
        status: 'requires_payment_method'
      }
    }),
    confirmSetup: async () => ({
      setupIntent: {
        id: 'seti_synthetic',
        status: 'succeeded'
      }
    })
  }))
}));
vi.mock('../components/estimate/SlotPicker', () => ({
  default: ({
    onSelect
  }) => <button onClick={() => onSelect('slot-1')}>Arrival window synthetic</button>
}));
function jsonResponse(body, {
  ok = true,
  status = 200
} = {}) {
  return {
    ok,
    status,
    json: async () => body
  };
}
function recurringPayload({
  renderFlags = {},
  addOns = []
} = {}) {
  return {
    estimate: {
      customerFirstName: 'Rae',
      address: '19 Retry Road',
      serviceCategory: 'pest_control',
      acceptance: {
        mode: 'standard_slot_pick'
      },
      membership: null,
      intelligence: null,
      askToken: 'ask-token',
      defaultServiceMode: 'recurring',
      isOneTimeOnly: false,
      showOneTimeOption: true,
      billByInvoice: false,
      licenseNumber: 'JB000000',
      acceptedServiceMode: null,
      acceptedFrequencyKey: null
    },
    pricing: {
      services: [{
        key: 'pest_control',
        label: 'Pest Control',
        isRecurring: true,
        isPest: true,
        frequencies: [{
          key: 'quarterly',
          label: 'Quarterly',
          monthly: 50,
          annual: 600,
          included: [{
            key: 'service',
            label: 'Recurring service'
          }],
          addOns
        }],
        copy: {
          priceWording: {}
        }
      }],
      askChips: [],
      anchorOneTimePrice: 250,
      defaultServiceMode: 'recurring',
      renderFlags
    },
    cta: {
      canAccept: true,
      terminalState: null,
      quoteRequired: false,
      quoteRequiredReason: null,
      reviewBeforeBooking: false,
      reviewReason: null
    }
  };
}

// jsdom in this runner ships without a usable localStorage (same workaround
// as EstimateViewPage.draft-preview.test.jsx) — stub a functional one.
function stubLocalStorage(store = {}) {
  vi.stubGlobal('localStorage', {
    getItem: k => Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null,
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: k => {
      delete store[k];
    }
  });
}

// jsdom implements neither — the review/success phases scroll the active step
// into view.
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function prepayPayload(prepayInLane = true) {
  const p = recurringPayload();
  p.pricing.annualPrepayEligible = true;
  p.pricing.setupFee = {
    amount: 99,
    waivedWithPrepay: true
  };
  p.recurringCardPolicy = {
    enforced: true,
    required: true,
    prepayInLane
  };
  return p;
}
function prepayFetch(p) {
  return vi.fn(async (url, opts) => {
    const u = String(url);
    if (u.includes('/recurring-card-intent')) return jsonResponse({
      clientSecret: 'seti_synthetic_secret',
      publishableKey: 'pk_test_synthetic'
    });
    if (u.includes('/reserve')) return jsonResponse({
      scheduledServiceId: 'ss-1',
      expiresAt: new Date(Date.now() + 900000).toISOString()
    });
    if (u.endsWith('/accept')) {
      const b = JSON.parse(opts.body);
      if (b.paymentMethodPreference === 'prepay_annual' && !b.prepayChargeConsentAccepted && p.recurringCardPolicy.prepayInLane) return jsonResponse({
        code: 'PREPAY_CHARGE_QUOTE',
        quote: {
          base: 600,
          total: 600,
          totalCents: 60000,
          methodKey: 'synthetic',
          capturedMethod: true,
          methodType: 'card'
        }
      }, {
        ok: false,
        status: 402
      });
      return jsonResponse({
        nextStep: 'confirmed'
      });
    }
    if (u.includes('/data')) return jsonResponse(p);
    return jsonResponse({});
  });
}
async function reachPrepayQuote() {
  stubLocalStorage();
  const fetchMock = prepayFetch(prepayPayload());
  vi.stubGlobal('fetch', fetchMock);
  render(<EstimateViewPage />);
  fireEvent.click((await screen.findAllByRole('button', {
    name: /Arrival window/i
  }))[0]);
  fireEvent.click(await screen.findByRole('button', {
    name: /Switch to annual prepay/
  }));
  const checkbox = await screen.findByRole('checkbox');
  fireEvent.click(checkbox);
  const confirm = await screen.findByRole('button', {
    name: 'Confirm & pay the 12-month plan'
  });
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);
  await screen.findByText('Confirm your annual prepay total');
  return fetchMock;
}
describe('annual prepay confirmation', () => {
  it('preserves captured authorization at the exact-total step and honors a later uncheck', async () => {
    const fetchMock = await reachPrepayQuote();
    const confirm = screen.getByRole('button', {
      name: 'Confirm & pay $600.00'
    });
    const consent = screen.getByRole('checkbox');
    expect(consent).toBeChecked();
    expect(confirm).toBeEnabled();
    fireEvent.click(consent);
    await waitFor(() => expect(confirm).toBeDisabled());
    fireEvent.click(consent);
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/accept'))).toHaveLength(2));
    const payload = JSON.parse(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/accept'))[1][1].body);
    expect(payload).toMatchObject({
      paymentMethodPreference: 'prepay_annual',
      recurringCardSetupIntentId: 'seti_synthetic',
      prepayChargeAcknowledgedTotalCents: 60000,
      prepayChargeAcknowledgedMethodKey: 'synthetic',
      prepayChargeConsentAccepted: true
    });
  });
  it('locks payment choices and consent while the accept request is pending', async () => {
    stubLocalStorage();
    const responses = prepayFetch(prepayPayload());
    let releaseAccept;
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      if (String(url).endsWith('/accept')) {
        return new Promise((resolve) => { releaseAccept = () => resolve(responses(url, options)); });
      }
      return responses(url, options);
    }));
    render(<EstimateViewPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Arrival window/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Switch to annual prepay/ }));
    const consent = await screen.findByRole('checkbox');
    fireEvent.click(consent);
    const confirm = await screen.findByRole('button', { name: 'Confirm & pay the 12-month plan' });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(releaseAccept).toBeTypeOf('function'));
    expect(consent).toBeInTheDocument();
    expect(consent).toBeChecked();
    expect(consent).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Go back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Switch back to pay per application' })).toBeDisabled();
    releaseAccept();
    expect(await screen.findByRole('button', { name: 'Confirm & pay $600.00' })).toBeEnabled();
  });

  it('clears the annual quote when switching back to per application', async () => {
    await reachPrepayQuote();
    fireEvent.click(screen.getByRole('button', {
      name: 'Switch back to pay per application'
    }));
    expect(screen.queryByText('Confirm your annual prepay total')).not.toBeInTheDocument();
  });
  it('selects annual prepay and accepts when prepay card charge is disabled', async () => {
    stubLocalStorage();
    const f = prepayFetch(prepayPayload(false));
    vi.stubGlobal('fetch', f);
    render(<EstimateViewPage />);
    fireEvent.click((await screen.findAllByRole('button', {
      name: /Arrival window/i
    }))[0]);
    fireEvent.click(await screen.findByRole('button', {
      name: /Switch to annual prepay/
    }));
    const confirm = await screen.findByRole('button', {
      name: 'Confirm booking'
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(f.mock.calls.filter(([u]) => String(u).endsWith('/accept'))).toHaveLength(1));
    expect(JSON.parse(f.mock.calls.filter(([u]) => String(u).endsWith('/accept'))[0][1].body).paymentMethodPreference).toBe('prepay_annual');
  });
  it('preserves the appointment and displays an annual coverage conflict', async () => {
    stubLocalStorage();
    const p = prepayPayload(false);
    const base = prepayFetch(p);
    const reason = 'This account already has an active annual prepay plan. Please call or text us to adjust or renew your coverage — accepting a second annual plan would double-bill the year.';
    vi.stubGlobal('fetch', vi.fn(async (u, o) => String(u).endsWith('/accept') ? jsonResponse({
      error: reason,
      code: 'ANNUAL_PREPAY_OVERLAP'
    }, {
      ok: false,
      status: 409
    }) : base(u, o)));
    render(<EstimateViewPage />);
    fireEvent.click((await screen.findAllByRole('button', {
      name: /Arrival window/i
    }))[0]);
    fireEvent.click(await screen.findByRole('button', {
      name: /Switch to annual prepay/
    }));
    fireEvent.click(await screen.findByRole('button', {
      name: 'Confirm booking'
    }));
    await screen.findByText(reason, {
      exact: false
    });
    expect(screen.queryByText(/That slot was just taken/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Confirm booking'
    })).toBeInTheDocument();
    expect(screen.getByText('Prepay 12 months')).toBeInTheDocument();
    expect(screen.getByText('Slot: slot-1')).toBeInTheDocument();
  });
});

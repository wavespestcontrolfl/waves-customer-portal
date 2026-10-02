// @vitest-environment jsdom
// Exercise the page and real inline payment component across the accept/quote round trip.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';
import { AFTER_VISIT_CONSENT_VERSION, AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT, PREPAY_CARD_CONSENT_TEXT } from '../lib/paymentMethodConsentText';
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
function prepayPayload(prepayInLane = true, { afterVisit = false } = {}) {
  const p = recurringPayload();
  p.pricing.annualPrepayEligible = true;
  p.pricing.setupFee = {
    amount: 99,
    waivedWithPrepay: true
  };
  p.recurringCardPolicy = {
    enforced: true,
    required: true,
    prepayInLane,
    ...(afterVisit ? { prepayAfterFirstVisit: true } : {})
  };
  return p;
}
function prepayFetch(p, { quoteExtra = {}, acceptResult = { nextStep: 'confirmed' } } = {}) {
  return vi.fn(async (url, opts) => {
    const u = String(url);
    if (u.includes('/recurring-card-intent')) {
      // A replace mints a FRESH intent (new secret) — the retired one is
      // never handed back.
      const replacing = !!(opts?.body && JSON.parse(opts.body).replaceSetupIntentId);
      return jsonResponse({
        clientSecret: replacing ? 'seti_synthetic_secret_2' : 'seti_synthetic_secret',
        setupIntentId: replacing ? 'seti_synthetic_2' : 'seti_synthetic',
        publishableKey: 'pk_test_synthetic'
      });
    }
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
          methodType: 'card',
          ...quoteExtra
        }
      }, {
        ok: false,
        status: 402
      });
      return jsonResponse(acceptResult);
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
const AFTER_VISIT_QUOTE = { chargedAfterFirstVisit: true, consentVariant: 'after_visit_prepay' };
async function reachAfterVisitPrepayQuote({ quoteExtra = AFTER_VISIT_QUOTE, acceptResult } = {}) {
  stubLocalStorage();
  const fetchMock = prepayFetch(prepayPayload(true, { afterVisit: true }), { quoteExtra, acceptResult });
  vi.stubGlobal('fetch', fetchMock);
  render(<EstimateViewPage />);
  fireEvent.click((await screen.findAllByRole('button', { name: /Arrival window/i }))[0]);
  fireEvent.click(await screen.findByRole('button', { name: /Switch to annual prepay/ }));
  fireEvent.click(await screen.findByRole('checkbox'));
  const confirm = await screen.findByRole('button', { name: 'Confirm the 12-month plan' });
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);
  await screen.findByText('Confirm your annual prepay total');
  return fetchMock;
}
const acceptBodies = (fetchMock) => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/accept')).map(([, o]) => JSON.parse(o.body));
describe('annual prepay charged after the first visit (GATE_PAF_PREPAY)', () => {
  it('inline capture shows the after-visit wording and the after_visit_prepay authorization', async () => {
    stubLocalStorage();
    vi.stubGlobal('fetch', prepayFetch(prepayPayload(true, { afterVisit: true })));
    render(<EstimateViewPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: /Arrival window/i }))[0]);
    fireEvent.click(await screen.findByRole('button', { name: /Switch to annual prepay/ }));
    await screen.findByRole('checkbox');
    expect(screen.getByText(/charge this card after your first visit\./)).toBeInTheDocument();
    expect(screen.getByText(/charge my 12-month annual prepay total after my first visit/)).toBeInTheDocument();
    expect(screen.queryByText(/annual prepay total now/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('View full terms'));
    expect(screen.getByText(AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT)).toBeInTheDocument();
  });

  it('a deferred quote renders the after-visit copy and the resubmit attests prepayChargeConsentVariant', async () => {
    const fetchMock = await reachAfterVisitPrepayQuote();
    expect(screen.getByText('$600.00 after your first visit')).toBeInTheDocument();
    expect(screen.queryByText(/due today/)).not.toBeInTheDocument();
    expect(screen.getByText(/is charged after your first visit — nothing is charged today/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Confirm & pay \$600/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(acceptBodies(fetchMock)).toHaveLength(2));
    expect(acceptBodies(fetchMock)[1]).toMatchObject({
      prepayChargeAcknowledgedTotalCents: 60000,
      prepayChargeConsentAccepted: true,
      prepayChargeConsentVariant: 'after_visit_prepay',
      prepayChargeConsentVersion: AFTER_VISIT_CONSENT_VERSION
    });
    // The first (pre-quote) accept never claims a variant.
    expect(acceptBodies(fetchMock)[0].prepayChargeConsentVariant).toBeUndefined();
  });

  it('the quote-step checkbox (auto-satisfy, no capture) is the AFTER_VISIT_PREPAY text', async () => {
    stubLocalStorage();
    const p = prepayPayload(true, { afterVisit: true });
    const base = prepayFetch(p, { quoteExtra: { ...AFTER_VISIT_QUOTE, capturedMethod: false } });
    vi.stubGlobal('fetch', vi.fn(base));
    render(<EstimateViewPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: /Arrival window/i }))[0]);
    fireEvent.click(await screen.findByRole('button', { name: /Switch to annual prepay/ }));
    fireEvent.click(await screen.findByRole('checkbox'));
    const confirm = await screen.findByRole('button', { name: 'Confirm the 12-month plan' });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await screen.findByText('Confirm your annual prepay total');
    const quoteBox = screen.getAllByText(AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT);
    expect(quoteBox.length).toBeGreaterThan(0);
    expect(screen.queryByText(PREPAY_CARD_CONSENT_TEXT)).not.toBeInTheDocument();
  });

  it('a quote without consentVariant keeps today\'s copy and sends no prepayChargeConsentVariant', async () => {
    const fetchMock = await reachPrepayQuote();
    expect(screen.getByText('$600.00 due today')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & pay $600.00' }));
    await waitFor(() => expect(acceptBodies(fetchMock)).toHaveLength(2));
    expect(acceptBodies(fetchMock)[1]).not.toHaveProperty('prepayChargeConsentVariant');
    expect(acceptBodies(fetchMock)[1]).not.toHaveProperty('prepayChargeConsentVersion');
  });

  it('an after_first_visit success shows nothing-charged-today copy with the acknowledged total', async () => {
    const fetchMock = await reachAfterVisitPrepayQuote({
      acceptResult: { nextStep: 'confirmed', billingTerm: 'prepay_annual', invoiceSettled: true, prepayChargeStatus: 'after_first_visit', prepayChargedTotal: 600 }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(acceptBodies(fetchMock)).toHaveLength(2));
    expect(await screen.findByText(/Nothing was charged today — your annual prepay of up to \$600\.00 is charged to your saved card \(or debited from your saved bank account\) after your first visit\. Any account credit lowers it\./)).toBeInTheDocument();
    expect(screen.queryByText(/went through/)).not.toBeInTheDocument();
  });
});

const quoteCheckbox = (text) => screen.getAllByText(text)
  .map((el) => el.closest('label')?.querySelector('input[type="checkbox"]'))
  .find(Boolean);
describe('a capture only consents to the charge timing it showed (GitHub Codex #5595 r1)', () => {
  it('captured under after-visit wording, quoted for an immediate charge: the quote asks again', async () => {
    const fetchMock = await reachAfterVisitPrepayQuote({ quoteExtra: {} });
    expect(screen.getByText('$600.00 due today')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm & pay $600.00' });
    expect(confirm).toBeDisabled();
    fireEvent.click(quoteCheckbox(PREPAY_CARD_CONSENT_TEXT));
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(acceptBodies(fetchMock)).toHaveLength(2));
    expect(acceptBodies(fetchMock)[1]).not.toHaveProperty('prepayChargeConsentVariant');
    expect(acceptBodies(fetchMock)[1]).not.toHaveProperty('prepayChargeConsentVersion');
  });

  it('captured under charge-now wording, quoted for after the first visit: the quote asks again', async () => {
    stubLocalStorage();
    const fetchMock = prepayFetch(prepayPayload(), { quoteExtra: AFTER_VISIT_QUOTE });
    vi.stubGlobal('fetch', fetchMock);
    render(<EstimateViewPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: /Arrival window/i }))[0]);
    fireEvent.click(await screen.findByRole('button', { name: /Switch to annual prepay/ }));
    fireEvent.click(await screen.findByRole('checkbox'));
    const first = await screen.findByRole('button', { name: 'Confirm & pay the 12-month plan' });
    await waitFor(() => expect(first).toBeEnabled());
    fireEvent.click(first);
    await screen.findByText('Confirm your annual prepay total');
    expect(screen.getByText('$600.00 after your first visit')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    fireEvent.click(quoteCheckbox(AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT));
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(acceptBodies(fetchMock)).toHaveLength(2));
    expect(acceptBodies(fetchMock)[1]).toMatchObject({ prepayChargeConsentVariant: 'after_visit_prepay' });
  });
});

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

  // Customer report 2026-09-08: a credit card saved at capture, the surcharge
  // seen at this step, and no way to switch to the no-surcharge bank rail —
  // the deterministic mint replayed the saved card on every reopen/refresh.
  it('offers "Use a different payment method" at the exact-total step and re-captures on a fresh intent', async () => {
    const fetchMock = await reachPrepayQuote();
    const intentCallsBefore = fetchMock.mock.calls.filter(([u]) => String(u).includes('/recurring-card-intent')).length;
    fireEvent.click(screen.getByRole('button', { name: 'Use a different payment method' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/recurring-card-intent'))).toHaveLength(intentCallsBefore + 1));
    const replaceCall = fetchMock.mock.calls.filter(([u]) => String(u).includes('/recurring-card-intent')).at(-1);
    // The retired capture is named so the server can stamp it; the fresh
    // intent replaces it on the inline surface and the stale quote is gone.
    expect(JSON.parse(replaceCall[1].body)).toMatchObject({ replaceSetupIntentId: 'seti_synthetic', paymentMethodPreference: 'prepay_annual' });
    await waitFor(() => expect(screen.queryByText('Confirm your annual prepay total')).not.toBeInTheDocument());
    expect(await screen.findByRole('checkbox')).not.toBeChecked();
    // The next confirm re-captures (new consent) and re-quotes — the retired
    // card's acknowledged total never rides the accept.
    fireEvent.click(screen.getByRole('checkbox'));
    const confirm = await screen.findByRole('button', { name: 'Confirm & pay the 12-month plan' });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await screen.findByText('Confirm your annual prepay total');
    const acceptBodies = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/accept')).map(([, o]) => JSON.parse(o.body));
    expect(acceptBodies.at(-1).prepayChargeAcknowledgedTotalCents).toBeUndefined();
  });

  it('locks checkout while the replacement is in flight (pre-push Codex P1: a confirm must not race the retirement)', async () => {
    const fetchMock = await reachPrepayQuote();
    let releaseReplace;
    const gate = new Promise((resolve) => { releaseReplace = resolve; });
    const base = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url, opts) => {
      if (String(url).includes('/recurring-card-intent') && opts?.body && JSON.parse(opts.body).replaceSetupIntentId) {
        await gate;
      }
      return base(url, opts);
    });
    const acceptCallsBefore = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/accept')).length;
    fireEvent.click(screen.getByRole('button', { name: 'Use a different payment method' }));
    // The quote (priced for the retired card) is gone at once, and every
    // confirm control is locked until the fresh intent lands.
    await waitFor(() => expect(screen.queryByText('Confirm your annual prepay total')).not.toBeInTheDocument());
    // The review CTA reads as busy and is disabled — a tap does nothing.
    const confirm = await screen.findByRole('button', { name: /Booking your visit|Confirm/ });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/accept'))).toHaveLength(acceptCallsBefore);
    releaseReplace();
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/accept'))).toHaveLength(acceptCallsBefore);
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

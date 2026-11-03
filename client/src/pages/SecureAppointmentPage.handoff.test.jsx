// @vitest-environment jsdom
// /secure/:token in hand-off mode (Book at the Table, owner 2026-11-02): the Waves
// Admin app shows this page to a customer in a separate, isolated web view. The
// page enters the mode only with ?handoff=1 AND the app's wavesCustomer handler.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerState = { search: '?handoff=1' };
vi.mock('react-router-dom', () => ({
  useParams: () => ({ token: 'a'.repeat(22) }),
  useSearchParams: () => [new URLSearchParams(routerState.search), vi.fn()],
}));
const createCalls = [];
vi.mock('../lib/stripeLoader', () => ({
  loadStripeSdk: vi.fn(async () => () => ({
    elements: () => ({
      create: (type, options) => {
        createCalls.push({ type, options });
        return { mount: vi.fn(), update: vi.fn(), on: (event, cb) => { if (event === 'ready') queueMicrotask(cb); } };
      },
    }),
    retrieveSetupIntent: async () => ({ setupIntent: { status: 'requires_payment_method' } }),
    confirmSetup: async () => ({ setupIntent: { id: 'seti_after', status: 'succeeded' } }),
  })),
}));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QR') } }));
import QRCode from 'qrcode';
import SecureAppointmentPage from './SecureAppointmentPage';

const TOKEN = 'a'.repeat(22);
const ORIGIN = 'https://portal.example.test';

const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });

const TERMS = {
  estimateRef: 'EST-2026-0001',
  version: 'v2026-10',
  lines: ['Accepting authorizes these services at the price shown. Cancel anytime.', 'Services — at the price and frequency shown.'],
  consumerNotice: null,
};

const READY = {
  state: 'ready',
  firstName: 'Pat',
  serviceType: 'Quarterly Pest Control Service',
  dateDisplay: 'Tue, Nov 3',
  windowDisplay: '9-11am',
  cancelFeeNote: null,
  clientSecret: 'cs_new',
  setupIntentId: 'seti_new',
  paymentMethodTypes: ['card'],
  capturedMethodType: null,
  publishableKey: 'pk_test_synthetic',
};

const RECURRING = {
  ...READY,
  planContext: {
    mode: 'recurring', perVisit: 60, visitsPerYear: 4, annualBase: 240, planClass: 'discount', selected: null,
    prepay: { total: 228, discount: 12, ratePctLabel: '5%' }, setupFee: null,
  },
};

const posted = [];
let assign;
function installBridge({ termsAnswer = { status: 'ok' } } = {}) {
  window.webkit = {
    messageHandlers: {
      wavesCustomer: {
        postMessage: vi.fn((message) => {
          posted.push(message);
          if (message.type === 'acceptTerms') {
            queueMicrotask(() => window.dispatchEvent(new CustomEvent('waveshandoff:terms', { detail: { requestId: message.requestId, ...termsAnswer } })));
          }
        }),
      },
    },
  };
}

function installFetch(pageBody, extra = {}) {
  const fetchMock = vi.fn(async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/select-plan')) return extra.selectPlan ? extra.selectPlan(JSON.parse(opts.body)) : json({ success: true });
    if (u.endsWith('/complete')) return json({ success: true });
    if (u.includes('/public/secure-card/')) return json(pageBody);
    throw new Error(`unexpected fetch ${u}`);
  });
  global.fetch = fetchMock;
  return fetchMock;
}

// Every anchor that leaves the page. The shell's skip link is an in-page hash.
const outsideLinks = (container) => [...container.querySelectorAll('a[href]')].filter((a) => !a.getAttribute('href').startsWith('#'));

beforeEach(() => {
  routerState.search = '?handoff=1';
  createCalls.length = 0;
  posted.length = 0;
  assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, origin: ORIGIN, href: `${ORIGIN}/secure/${TOKEN}?handoff=1`, assign });
  installBridge();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete window.webkit; vi.restoreAllMocks(); });

describe('SecureAppointmentPage hand-off mode', () => {
  it('asks the server for hand-off data and renders no contact or outside links', async () => {
    const fetchMock = installFetch(READY);
    const { container } = render(<SecureAppointmentPage />);
    await screen.findByRole('button', { name: 'Save card & secure my visit' });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/consentTextVersion=v\d+_\d{4}-\d{2}-\d{2}&handoff=1$/);
    expect(outsideLinks(container)).toHaveLength(0);
    expect(screen.queryByText('Text Waves')).toBeNull();
    expect(screen.queryByText('Call Waves')).toBeNull();
  });

  it('keeps the contact states link-free (closed and not found)', async () => {
    installFetch({ state: 'closed', firstName: 'Pat' });
    const { container } = render(<SecureAppointmentPage />);
    await screen.findByText('Nothing needed here');
    expect(outsideLinks(container)).toHaveLength(0);
  });

  it('never offers Apple Pay or Google Pay', async () => {
    installFetch(READY);
    render(<SecureAppointmentPage />);
    await screen.findByRole('button', { name: 'Save card & secure my visit' });
    await waitFor(() => expect(createCalls.length).toBeGreaterThan(0));
    expect(createCalls[0].type).toBe('payment');
    expect(createCalls[0].options.wallets).toEqual({ applePay: 'never', googlePay: 'never' });
  });

  it('holds Save until the terms box is ticked, then records the terms BEFORE the card save', async () => {
    const fetchMock = installFetch({ ...READY, handoff: { terms: { ...TERMS, consumerNotice: { text: 'Florida law asks you to sign the notice.' } } } });
    render(<SecureAppointmentPage />);
    expect(await screen.findByText('Florida law asks you to sign the notice.')).toBeInTheDocument();
    const terms = screen.getByLabelText('I accept estimate EST-2026-0001 and its terms.');
    const authorization = screen.getByLabelText(/I authorize Waves to charge this card/);
    const save = screen.getByRole('button', { name: 'Save card & secure my visit' });
    fireEvent.click(authorization);
    await waitFor(() => expect(save).toBeDisabled());
    expect(terms).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'View terms' }));
    expect(screen.getByText('Services — at the price and frequency shown.')).toBeInTheDocument();
    fireEvent.click(terms);
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/complete'))).toBe(true));
    expect(posted).toEqual([expect.objectContaining({ type: 'acceptTerms', termsVersion: 'v2026-10', consumerNoticeShown: true })]);
  });

  it('a failed terms record shows a plain error and does not save the card', async () => {
    installBridge({ termsAnswer: { status: 'failed', message: 'Could not record the terms.' } });
    const fetchMock = installFetch({ ...READY, handoff: { terms: TERMS } });
    render(<SecureAppointmentPage />);
    fireEvent.click(await screen.findByLabelText(/I authorize Waves to charge this card/));
    fireEvent.click(screen.getByLabelText('I accept estimate EST-2026-0001 and its terms.'));
    const save = screen.getByRole('button', { name: 'Save card & secure my visit' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(await screen.findByText('Could not record the terms.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/complete'))).toBe(false);
  });

  it('shows no terms box when the server sends none', async () => {
    installFetch(READY);
    render(<SecureAppointmentPage />);
    await screen.findByRole('button', { name: 'Save card & secure my visit' });
    expect(screen.queryByTestId('handoff-terms')).toBeNull();
  });

  it('Prepay the year shows a QR code of the absolute secure link instead of opening a pay page', async () => {
    const fetchMock = installFetch(RECURRING, {
      selectPlan: (body) => json({ success: true, payUrl: body.plan === 'prepay_annual' ? 'https://pay.example.test/p/1' : undefined }),
    });
    const { container } = render(<SecureAppointmentPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Prepay the year/ }));
    expect(await screen.findByText(/Prepay is paid on your own phone\. Scan this code with your phone's camera\./)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    expect(QRCode.toDataURL).toHaveBeenCalledWith(`${ORIGIN}/secure/${TOKEN}`, expect.any(Object));
    expect(outsideLinks(container)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Pay per application' }));
    await waitFor(() => expect(screen.queryByTestId('handoff-prepay-qr')).toBeNull());
    const bodies = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/select-plan')).map(([, o]) => JSON.parse(o.body).plan);
    expect(bodies).toEqual(['prepay_annual', 'per_application']);
  });
});

describe('SecureAppointmentPage without the app bridge', () => {
  it('?handoff=1 alone changes nothing: same request, contact links, wallets allowed', async () => {
    delete window.webkit;
    const fetchMock = installFetch(READY);
    const { container } = render(<SecureAppointmentPage />);
    await screen.findByRole('button', { name: 'Save card & secure my visit' });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/consentTextVersion=v\d+_\d{4}-\d{2}-\d{2}$/);
    expect(fetchMock.mock.calls[0]).toHaveLength(1);
    expect(outsideLinks(container).length).toBeGreaterThan(0);
    await waitFor(() => expect(createCalls.length).toBeGreaterThan(0));
    expect(createCalls[0].options.wallets).toBeUndefined();
    expect(screen.queryByTestId('handoff-terms')).toBeNull();
  });

  it('the bridge without ?handoff=1 is also a normal page', async () => {
    routerState.search = '';
    const fetchMock = installFetch({ ...READY, handoff: { terms: TERMS } });
    render(<SecureAppointmentPage />);
    await screen.findByRole('button', { name: 'Save card & secure my visit' });
    expect(String(fetchMock.mock.calls[0][0])).not.toMatch(/handoff/);
    expect(screen.queryByTestId('handoff-terms')).toBeNull();
  });
});

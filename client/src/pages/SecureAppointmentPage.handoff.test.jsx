// @vitest-environment jsdom
// /secure/:token in Book at the Table (owner 2026-11-02). Hand-off mode: the Waves Admin
// app shows this page to a customer in a separate, isolated web view; the page enters the
// mode only with ?handoff=1 AND the app's wavesCustomer handler. The estimate terms step
// (payload `terms` / `consumerNotice`, POST /accept-terms) works the same on the owner's
// phone and on the customer's own, so it is tested in both.
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
  scope: 'plan',
  lines: ['Accepting authorizes these services at the price shown. Cancel anytime.', 'Services — at the price and frequency shown.'],
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

const accepted = [];
const posted = [];
let assign;
function installBridge() {
  window.webkit = {
    messageHandlers: {
      wavesCustomer: {
        postMessage: vi.fn((message) => { posted.push(message); }),
      },
    },
  };
}

function installFetch(pageBody, extra = {}) {
  const fetchMock = vi.fn(async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/select-plan')) return extra.selectPlan ? extra.selectPlan(JSON.parse(opts.body)) : json({ success: true });
    if (u.endsWith('/complete')) return extra.complete ? extra.complete() : json({ success: true });
    if (u.endsWith('/accept-terms')) { accepted.push(JSON.parse(opts.body)); return extra.acceptTerms ? extra.acceptTerms(JSON.parse(opts.body)) : json({ success: true, recorded: true }); }
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
  accepted.length = 0;
  assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, origin: ORIGIN, href: `${ORIGIN}/secure/${TOKEN}?handoff=1`, assign });
  installBridge();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete window.webkit; vi.restoreAllMocks(); });

describe('SecureAppointmentPage hand-off mode', () => {
  it('renders no contact or outside links, and sends the ordinary page request', async () => {
    const fetchMock = installFetch(READY);
    const { container } = render(<SecureAppointmentPage />);
    await screen.findByRole('button', { name: 'Save card & secure my visit' });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/consentTextVersion=v\d+_\d{4}-\d{2}-\d{2}$/);
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

  it('Prepay the year shows a QR code of the absolute secure link instead of opening a pay page', async () => {
    const fetchMock = installFetch(RECURRING, {
      selectPlan: (b) => json({ success: true, payUrl: b.plan === 'prepay_annual' ? 'https://pay.example.test/p/1' : undefined }),
    });
    const { container } = render(<SecureAppointmentPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Prepay the year/ }));
    expect(await screen.findByText(/Prepay is paid on your own phone\. Scan this code with your phone's camera\./)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    expect(QRCode.toDataURL).toHaveBeenCalledWith(`${ORIGIN}/secure/${TOKEN}`, expect.any(Object));
    expect(outsideLinks(container)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Pay per application' }));
    await waitFor(() => expect(screen.queryByTestId('handoff-prepay-qr')).toBeNull());
    const plans = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/select-plan')).map(([, o]) => JSON.parse(o.body).plan);
    expect(plans).toEqual(['prepay_annual', 'per_application']);
  });

  it('the page sends the app nothing (the terms go to the server directly)', async () => {
    installFetch({ ...READY, terms: TERMS });
    render(<SecureAppointmentPage />);
    fireEvent.click(await screen.findByLabelText(/I authorize Waves to charge this card/));
    fireEvent.click(screen.getByLabelText('I accept estimate EST-2026-0001 and its terms.'));
    const save = screen.getByRole('button', { name: 'Save card & secure my visit' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(accepted).toHaveLength(1));
    expect(posted).toEqual([]);
  });
});

// The estimate terms step is the same on the owner's phone (hand-off) and the customer's own.
describe.each([
  ['hand-off mode', true],
  ['the customer\'s own phone', false],
])('estimate terms on %s', (_name, handoff) => {
  beforeEach(() => {
    if (!handoff) {
      routerState.search = '';
      delete window.webkit;
    }
  });

  it('holds Save until the terms box is ticked, then records the terms BEFORE the card save', async () => {
    const order = [];
    const fetchMock = installFetch({ ...READY, terms: TERMS, consumerNotice: { text: 'Florida law asks you to sign the notice.' } }, {
      acceptTerms: () => { order.push('accept-terms'); return json({ success: true, recorded: true }); },
      complete: () => { order.push('complete'); return json({ success: true }); },
    });
    render(<SecureAppointmentPage />);
    expect(await screen.findByText('Florida law asks you to sign the notice.')).toBeInTheDocument();
    const terms = screen.getByLabelText('I accept estimate EST-2026-0001 and its terms.');
    const save = screen.getByRole('button', { name: 'Save card & secure my visit' });
    fireEvent.click(screen.getByLabelText(/I authorize Waves to charge this card/));
    await waitFor(() => expect(save).toBeDisabled());
    expect(terms).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'View terms' }));
    expect(screen.getByText('Services — at the price and frequency shown.')).toBeInTheDocument();
    fireEvent.click(terms);
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(order).toEqual(['accept-terms', 'complete']));
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/accept-terms'));
    expect(call[0]).toBe(`/api/public/secure-card/${TOKEN}/accept-terms`);
    expect(call[1].method).toBe('POST');
    expect(accepted).toEqual([{ terms_version: 'v2026-10', terms_scope: 'plan', consumer_notice_shown: true }]);
  });

  it('a failed record shows a plain error and does not save the card', async () => {
    const fetchMock = installFetch({ ...READY, terms: TERMS }, {
      acceptTerms: () => json({ error: 'Something went wrong' }, { ok: false, status: 500 }),
    });
    render(<SecureAppointmentPage />);
    fireEvent.click(await screen.findByLabelText(/I authorize Waves to charge this card/));
    fireEvent.click(screen.getByLabelText('I accept estimate EST-2026-0001 and its terms.'));
    const save = screen.getByRole('button', { name: 'Save card & secure my visit' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/complete'))).toBe(false);
  });

  it('Prepay the year without the tick shows no QR or pay page and asks for the tick; select-plan is not called', async () => {
    const fetchMock = installFetch({ ...RECURRING, terms: TERMS });
    render(<SecureAppointmentPage />);
    // The box is outside the card form: it is there before any plan is picked.
    expect(await screen.findByLabelText('I accept estimate EST-2026-0001 and its terms.')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /Prepay the year/ }));
    expect(await screen.findByText(/Please tick .I accept estimate EST-2026-0001 and its terms\..* before you choose to prepay\./)).toBeInTheDocument();
    expect(screen.queryByTestId('handoff-prepay-qr')).toBeNull();
    expect(assign).not.toHaveBeenCalled();
    expect(accepted).toEqual([]);
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/select-plan'))).toBe(false);
  });

  it('Prepay the year with the tick records the terms FIRST, then goes on, and never asks again', async () => {
    const order = [];
    const fetchMock = installFetch({ ...RECURRING, terms: TERMS }, {
      acceptTerms: () => { order.push('accept-terms'); return json({ success: true, recorded: true }); },
      selectPlan: (b) => { order.push(`select-plan:${b.plan}`); return json({ success: true, payUrl: 'https://pay.example.test/p/1' }); },
    });
    render(<SecureAppointmentPage />);
    fireEvent.click(await screen.findByLabelText('I accept estimate EST-2026-0001 and its terms.'));
    fireEvent.click(screen.getByRole('button', { name: /Prepay the year/ }));
    await waitFor(() => expect(order).toEqual(['accept-terms', 'select-plan:prepay_annual']));
    if (handoff) {
      expect(await screen.findByTestId('handoff-prepay-qr')).toBeInTheDocument();
      expect(assign).not.toHaveBeenCalled();
      // Recorded once: the box is gone and a switch back asks nothing.
      expect(screen.queryByTestId('handoff-terms')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Pay per application' }));
      await screen.findByRole('button', { name: 'Save card & confirm my plan' });
      expect(accepted).toHaveLength(1);
      expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/select-plan'))).toHaveLength(2);
    } else {
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://pay.example.test/p/1'));
    }
  });

  it('a failed record before prepay shows the error and no select-plan call', async () => {
    const fetchMock = installFetch({ ...RECURRING, terms: TERMS }, {
      acceptTerms: () => json({ error: 'We could not record that.' }, { ok: false, status: 500 }),
    });
    render(<SecureAppointmentPage />);
    fireEvent.click(await screen.findByLabelText('I accept estimate EST-2026-0001 and its terms.'));
    fireEvent.click(screen.getByRole('button', { name: /Prepay the year/ }));
    expect(await screen.findByText('We could not record that.')).toBeInTheDocument();
    expect(screen.queryByTestId('handoff-prepay-qr')).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/select-plan'))).toBe(false);
  });

  it('a termite estimate: the separate-signature note shows with no terms box, for both plan choices', async () => {
    installFetch({ ...RECURRING, consumerNotice: { text: 'Florida law asks you to sign the notice separately.' } });
    render(<SecureAppointmentPage />);
    expect(await screen.findByText('Florida law asks you to sign the notice separately.')).toBeInTheDocument();
    expect(screen.queryByTestId('handoff-terms')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Pay per application/ }));
    await screen.findByRole('button', { name: 'Save card & confirm my plan' });
    expect(screen.getByText('Florida law asks you to sign the notice separately.')).toBeInTheDocument();
    expect(accepted).toEqual([]);
  });

  it.each([['terms_changed'], ['TERMS_VERSION_STALE']])('a %s answer shows the reload text and a Reload button, and stops Save', async (code) => {
    const fetchMock = installFetch({ ...READY, terms: TERMS }, {
      acceptTerms: () => json({ error: 'The terms changed. Reload this page to see them.', code }, { ok: false, status: 409 }),
    });
    render(<SecureAppointmentPage />);
    fireEvent.click(await screen.findByLabelText(/I authorize Waves to charge this card/));
    fireEvent.click(screen.getByLabelText('I accept estimate EST-2026-0001 and its terms.'));
    const save = screen.getByRole('button', { name: 'Save card & secure my visit' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(await screen.findByText('The terms changed. Reload this page to see them.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    await waitFor(() => expect(save).toBeDisabled());
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/complete'))).toBe(false);
  });

  it('a 409 terms_required from the server (a stale page) shows the box again from fresh data', async () => {
    let loads = 0;
    const fetchMock = vi.fn(async (url, opts) => {
      const u = String(url);
      if (u.endsWith('/accept-terms')) return json({ success: true, recorded: true });
      if (u.endsWith('/complete')) return json({ error: 'Please accept the estimate terms first.', code: 'terms_required' }, { ok: false, status: 409 });
      loads += 1;
      return json({ ...READY, terms: TERMS });
    });
    global.fetch = fetchMock;
    render(<SecureAppointmentPage />);
    fireEvent.click(await screen.findByLabelText(/I authorize Waves to charge this card/));
    fireEvent.click(screen.getByLabelText('I accept estimate EST-2026-0001 and its terms.'));
    const save = screen.getByRole('button', { name: 'Save card & secure my visit' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(await screen.findByText('Please accept the estimate terms first.')).toBeInTheDocument();
    expect(loads).toBe(2);
    expect(screen.getByLabelText('I accept estimate EST-2026-0001 and its terms.')).not.toBeChecked();
  });

  it('shows no terms box when the server sends none', async () => {
    installFetch(READY);
    render(<SecureAppointmentPage />);
    await screen.findByRole('button', { name: 'Save card & secure my visit' });
    expect(screen.queryByTestId('handoff-terms')).toBeNull();
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
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it('the bridge without ?handoff=1 is also a normal page', async () => {
    routerState.search = '';
    installFetch(READY);
    const { container } = render(<SecureAppointmentPage />);
    await screen.findByRole('button', { name: 'Save card & secure my visit' });
    expect(outsideLinks(container).length).toBeGreaterThan(0);
  });
});

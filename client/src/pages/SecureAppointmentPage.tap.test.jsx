// @vitest-environment jsdom
// /secure/:token in hand-off mode: the Tap to Pay option (GATE_TAP_SAVE_CARD, "Book at the
// Table" PR 4). The page offers it only in the Waves Admin app's customer view, when the
// payload says `tapSaveCard` AND the app answers `saveCard` to its capabilities ask. The
// tap rides the typed save's consent: the same ticked checkbox, consent text version, fee
// number and sticky echo; the app answers each ask once with a window event.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerState = { search: '?handoff=1' };
vi.mock('react-router-dom', () => ({
  useParams: () => ({ token: 'a'.repeat(22) }),
  useSearchParams: () => [new URLSearchParams(routerState.search), vi.fn()],
}));
vi.mock('../lib/stripeLoader', () => ({
  loadStripeSdk: vi.fn(async () => () => ({
    elements: () => ({
      create: () => ({ mount: vi.fn(), update: vi.fn(), on: (event, cb) => { if (event === 'ready') queueMicrotask(cb); } }),
    }),
    retrieveSetupIntent: async () => ({ setupIntent: { status: 'requires_payment_method' } }),
    confirmSetup: async () => ({ setupIntent: { id: 'seti_after', status: 'succeeded' } }),
  })),
}));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QR') } }));
import SecureAppointmentPage from './SecureAppointmentPage';
import { CONSENT_VERSION } from '../lib/paymentMethodConsentText';

const TOKEN = 'a'.repeat(22);
const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });

const TERMS = {
  estimateRef: 'EST-2026-0001',
  version: 'v2026-10',
  scope: 'plan',
  lines: ['Accepting authorizes these services at the price shown. Cancel anytime.'],
};

const READY = {
  state: 'ready',
  firstName: 'Pat',
  serviceType: 'General Pest Control',
  dateDisplay: 'Tue, Nov 3',
  windowDisplay: '9-11am',
  cancelFeeNote: 'A $25 fee applies only to no-shows or cancellations less than 24 hours before your visit.',
  stickyDisclosureVersion: 'sticky_v1',
  cancelFeeAmount: 25,
  tapSaveCard: true,
  clientSecret: 'cs_new',
  setupIntentId: 'seti_new',
  paymentMethodTypes: ['card'],
  capturedMethodType: null,
  publishableKey: 'pk_test_synthetic',
};
const SECURED = { state: 'secured', firstName: 'Pat', serviceType: 'General Pest Control', cancelFeeNote: null };

const posted = [];
const order = [];
// How the app answers: capabilities list, and the saveCard answer (null = never answers).
let appCapabilities;
let saveAnswer;

function installBridge() {
  window.webkit = {
    messageHandlers: {
      wavesCustomer: {
        postMessage: vi.fn((message) => {
          posted.push(message);
          if (message.type === 'capabilities' && appCapabilities) {
            queueMicrotask(() => window.dispatchEvent(new CustomEvent('waveshandoff:capabilities', { detail: { requestId: message.requestId, capabilities: appCapabilities } })));
          }
          if (message.type === 'saveCard' && saveAnswer) {
            order.push('saveCard');
            const answer = typeof saveAnswer === 'function' ? saveAnswer() : saveAnswer;
            queueMicrotask(() => window.dispatchEvent(new CustomEvent('waveshandoff:savecard', { detail: { requestId: message.requestId, ...answer } })));
          }
        }),
      },
    },
  };
}

let pages;
function installFetch(pageBody) {
  pages = [pageBody];
  const fetchMock = vi.fn(async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/accept-terms')) { order.push('accept-terms'); return json({ success: true, recorded: true }); }
    if (u.includes('/public/secure-card/')) return json(pages.length > 1 ? pages.shift() : pages[0]);
    throw new Error(`unexpected fetch ${u}`);
  });
  global.fetch = fetchMock;
  return fetchMock;
}

const tapButton = () => screen.queryByRole('button', { name: 'Tap your card on this phone' });
const tick = () => fireEvent.click(screen.getByLabelText(/I authorize Waves to charge this card/));
const saveMessages = () => posted.filter((m) => m.type === 'saveCard');

beforeEach(() => {
  routerState.search = '?handoff=1';
  posted.length = 0;
  order.length = 0;
  appCapabilities = ['saveCard'];
  saveAnswer = { status: 'succeeded', card: { brand: 'visa', last4: '4242' } };
  vi.stubGlobal('location', { ...window.location, origin: 'https://portal.example.test', href: `https://portal.example.test/secure/${TOKEN}?handoff=1`, assign: vi.fn() });
  installBridge();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete window.webkit; vi.restoreAllMocks(); });

describe('Tap to Pay option on the secure card page', () => {
  it('appears in hand-off mode when the server flag and the app both say yes, disabled until the consent is ticked', async () => {
    installFetch(READY);
    render(<SecureAppointmentPage />);
    const tap = await screen.findByRole('button', { name: 'Tap your card on this phone' });
    expect(tap).toBeDisabled();
    expect(screen.getByText('The next screen shows where to hold your card.')).toBeInTheDocument();
    expect(posted.filter((m) => m.type === 'capabilities')).toHaveLength(1);
    tick();
    await waitFor(() => expect(tap).toBeEnabled());
    expect(saveMessages()).toHaveLength(0);
  });

  it('is hidden when the server flag is off, and the app is not even asked', async () => {
    installFetch({ ...READY, tapSaveCard: undefined });
    render(<SecureAppointmentPage />);
    await screen.findByRole('button', { name: 'Save card & secure my visit' });
    expect(tapButton()).toBeNull();
    expect(posted).toEqual([]);
  });

  it('is hidden when the app does not list saveCard', async () => {
    appCapabilities = [];
    installFetch(READY);
    render(<SecureAppointmentPage />);
    await screen.findByRole('button', { name: 'Save card & secure my visit' });
    await waitFor(() => expect(posted.filter((m) => m.type === 'capabilities')).toHaveLength(1));
    await Promise.resolve();
    expect(tapButton()).toBeNull();
  });

  it('is hidden outside hand-off mode (a browser never offers it or asks)', async () => {
    routerState.search = '';
    delete window.webkit;
    installFetch(READY);
    render(<SecureAppointmentPage />);
    await screen.findByRole('button', { name: 'Save card & secure my visit' });
    expect(tapButton()).toBeNull();
  });

  it('posts the typed save\'s consent: this bundle\'s text version, the fee shown and the sticky echo, after recording the terms', async () => {
    installFetch({ ...READY, terms: TERMS });
    render(<SecureAppointmentPage />);
    const tap = await screen.findByRole('button', { name: 'Tap your card on this phone' });
    tick();
    // The estimate terms are still unticked: no tap yet.
    expect(tap).toBeDisabled();
    fireEvent.click(screen.getByLabelText('I accept estimate EST-2026-0001 and its terms.'));
    await waitFor(() => expect(tap).toBeEnabled());
    fireEvent.click(tap);
    await waitFor(() => expect(saveMessages()).toHaveLength(1));
    expect(saveMessages()[0]).toMatchObject({
      type: 'saveCard',
      consentTextVersion: CONSENT_VERSION,
      agreed: true,
      feeDisclosedAmount: 25,
      disclosureVersion: 'sticky_v1',
    });
    expect(order).toEqual(['accept-terms', 'saveCard']);
  });

  it('sends null for a fee and an echo the page did not show', async () => {
    installFetch({ ...READY, cancelFeeNote: null, stickyDisclosureVersion: undefined, cancelFeeAmount: undefined });
    render(<SecureAppointmentPage />);
    const tap = await screen.findByRole('button', { name: 'Tap your card on this phone' });
    tick();
    await waitFor(() => expect(tap).toBeEnabled());
    fireEvent.click(tap);
    await waitFor(() => expect(saveMessages()).toHaveLength(1));
    expect(saveMessages()[0].feeDisclosedAmount).toBeNull();
    expect(saveMessages()[0].disclosureVersion).toBeNull();
  });

  it('on succeeded, re-pulls the page so the saved-card view shows', async () => {
    const fetchMock = installFetch(READY);
    pages = [READY, SECURED];
    render(<SecureAppointmentPage />);
    const tap = await screen.findByRole('button', { name: 'Tap your card on this phone' });
    tick();
    await waitFor(() => expect(tap).toBeEnabled());
    fireEvent.click(tap);
    expect(await screen.findByText('You\'re all set, Pat!')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/public/secure-card/') && !String(u).endsWith('/accept-terms'))).toHaveLength(2);
  });

  it('on failed, shows the app\'s message and leaves the choices', async () => {
    saveAnswer = { status: 'failed', message: 'This card cannot be saved for later charges. Try another card.' };
    installFetch(READY);
    render(<SecureAppointmentPage />);
    const tap = await screen.findByRole('button', { name: 'Tap your card on this phone' });
    tick();
    await waitFor(() => expect(tap).toBeEnabled());
    fireEvent.click(tap);
    expect(await screen.findByRole('alert')).toHaveTextContent('This card cannot be saved for later charges. Try another card.');
    await waitFor(() => expect(tap).toBeEnabled());
  });

  it('on canceled, returns to the choices with no error', async () => {
    saveAnswer = { status: 'canceled' };
    installFetch(READY);
    render(<SecureAppointmentPage />);
    const tap = await screen.findByRole('button', { name: 'Tap your card on this phone' });
    tick();
    await waitFor(() => expect(tap).toBeEnabled());
    fireEvent.click(tap);
    await waitFor(() => expect(saveMessages()).toHaveLength(1));
    await waitFor(() => expect(tap).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save card & secure my visit' })).toBeInTheDocument();
  });

  it('allows one tap request at a time', async () => {
    saveAnswer = null; // the app is still taking the card
    installFetch(READY);
    render(<SecureAppointmentPage />);
    const tap = await screen.findByRole('button', { name: 'Tap your card on this phone' });
    tick();
    await waitFor(() => expect(tap).toBeEnabled());
    fireEvent.click(tap);
    await waitFor(() => expect(saveMessages()).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Waiting for your card…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Waiting for your card…' }));
    expect(saveMessages()).toHaveLength(1);
  });

  it('is not offered on a standalone Auto Pay link (the server refuses those)', async () => {
    installFetch({ ...READY, kind: 'customer', cancelFeeNote: null });
    render(<SecureAppointmentPage />);
    await screen.findByRole('button', { name: /Save card & turn on Auto Pay/ });
    expect(tapButton()).toBeNull();
  });
});

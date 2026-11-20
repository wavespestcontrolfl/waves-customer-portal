// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MyPlanTab } from './PortalPage';
import api from '../utils/api';

vi.mock('../utils/api', async (importOriginal) => {
  // The card's session check runs the API client's own helpers; every API call is a stub.
  const { sameRequestSession, tokenSessionIdentity } = await importOriginal();
  const methods = {};
  return { sameRequestSession, tokenSessionIdentity, default: new Proxy(methods, {
    get(target, key) {
      if (typeof key !== 'string') return target[key];
      return target[key] ||= vi.fn(() => new Promise(() => {}));
    },
  }) };
});

const OPTION = {
  id: 'pest-quarterly', serviceKey: 'pest_control', label: 'Quarterly pest control', cadence: '4 visits/year',
  monthly: 31.67, perVisit: 95, dueAtStart: null, oneTime: null, setupFee: null, confidence: 'high', manualReview: false, notes: [],
  requestSubject: 'Add Pest Control to my plan', requestDescription: 'Customer priced Quarterly pest control in the portal.',
};
const BIMONTHLY = { ...OPTION, id: 'pest-bimonthly', label: 'Bi-monthly pest control', cadence: '6 visits/year', monthly: 44, perVisit: 88 };
const priced = (extra = {}, option = {}) => ({ ok: true, message: 'Priced.', currentServices: [], options: [{ ...OPTION, ...option }], ...extra });
// The server lists the options it can book (planStart.optionIds); the card offers the button only for those.
const OFFER = { planStart: { optionIds: ['pest-quarterly'] } };
const pricedTwo = () => ({ ok: true, message: 'Priced.', currentServices: [], options: [OPTION, BIMONTHLY], ...OFFER });
const optionSelect = () => screen.getAllByRole('combobox').find((el) => el.querySelector('option[value="pest-bimonthly"]'));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  api.getNextService.mockResolvedValue({ next: null });
  api.getSchedule.mockResolvedValue({ upcoming: [] });
  api.getServices.mockResolvedValue({ services: [] });
  api.getAutopay.mockResolvedValue({ state: 'disabled' });
  api.getStationMap.mockResolvedValue({ available: false });
  api.getLawnHealth.mockResolvedValue({ available: false });
  api.createRequest.mockResolvedValue({ success: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function priceIt(result) {
  api.queryCustomerPricing.mockResolvedValue(result);
  render(<MyPlanTab customer={{ id: 'fixture-account', firstName: 'Fixture', tier: 'Bronze', property: {} }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Get Pricing' }));
}

it('swaps the primary button for "See my price and book" when the server offers a plan start', async () => {
  await priceIt(priced(OFFER));
  expect(await screen.findByRole('button', { name: 'See my price and book' })).toBeInTheDocument();
  expect(screen.getByText('Your estimate shows the full price and open times. Pick a time to book.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Request This' })).toBeNull();
});

// One render per case: the portal page is large, and three renders in one test outran the 5 s limit under load.
it.each([
  ['no plan-start hint', priced({}, { setupFee: 99 })],
  ['a hint that lists other options only', priced({ planStart: { optionIds: ['pest-bimonthly'] } }, { setupFee: 99 })],
])('keeps today\'s button and tiles when there is %s', async (_label, result) => {
  await priceIt(result);
  expect(await screen.findByRole('button', { name: 'Request This' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'See my price and book' })).toBeNull();
  // The setup-fee tile comes only with the plan-start button.
  expect(screen.queryByText('WaveGuard setup')).toBeNull();
});

it('posts the selected option and every amount it shows, then hands off to the estimate URL', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const assign = vi.fn();
  const original = window.location;
  Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign } });
  try {
    api.startPlan.mockResolvedValue({ ok: true, url: '/estimate/tok123', estimateId: 'e1', reused: false });
    await priceIt(priced(OFFER));
    fireEvent.click(await screen.findByRole('button', { name: 'See my price and book' }));
    await waitFor(() => expect(api.startPlan).toHaveBeenCalledWith({
      serviceKey: 'pest_control', optionId: 'pest-quarterly', shown: { monthly: 31.67, perVisit: 95, dueAtStart: null, oneTime: null, setupFee: null },
    }));
    await screen.findByRole('button', { name: 'Open it now' });
    // A button: the page never holds the estimate link itself (codex pre-push P0).
    expect(screen.queryByRole('link', { name: 'Open it now' })).toBeNull();
    expect(api.createRequest).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1600);
    expect(assign).toHaveBeenCalledWith('/estimate/tok123');
  } finally {
    Object.defineProperty(window, 'location', { configurable: true, value: original });
    vi.useRealTimers();
  }
});

it.each([
  ['a 404 with no code (the gate went off before the mint ran)', 404, undefined],
  ['a 409 pricing_unavailable', 409, 'pricing_unavailable'],
  ['a 409 not_eligible', 409, 'not_eligible'],
  ['a 409 offer_changed', 409, 'offer_changed'],
])('falls back to today\'s request on %s, so the customer never hits a dead end', async (_label, status, code) => {
  api.startPlan.mockRejectedValue(Object.assign(new Error('The price changed.'), { status, code }));
  await priceIt(priced(OFFER));
  fireEvent.click(await screen.findByRole('button', { name: 'See my price and book' }));
  await waitFor(() => expect(api.createRequest).toHaveBeenCalledOnce());
  expect(api.createRequest).toHaveBeenCalledWith({
    category: 'add_service', subject: 'Add Pest Control to my plan', description: 'Customer priced Quarterly pest control in the portal.',
  });
  expect(await screen.findByText('Request sent')).toBeInTheDocument();
  expect(api.startPlan).toHaveBeenCalledOnce();
});

it('a quote staff are sending right now (409 delivery_in_flight) shows the server\'s message and files no request (codex pre-push P1)', async () => {
  const message = 'This quote is on its way to you right now — give it a moment, then try again.';
  api.startPlan.mockRejectedValue(Object.assign(new Error(message), { status: 409, code: 'delivery_in_flight' }));
  const alerts = [];
  const onDialog = (event) => alerts.push(event.detail.message);
  window.addEventListener('waves:customer-dialog', onDialog);
  try {
    await priceIt(priced(OFFER));
    fireEvent.click(await screen.findByRole('button', { name: 'See my price and book' }));
    await waitFor(() => expect(alerts).toEqual([message]));
    expect(api.startPlan).toHaveBeenCalledOnce();
    expect(api.createRequest).not.toHaveBeenCalled();
    expect(screen.queryByText('Request sent')).toBeNull();
  } finally {
    window.removeEventListener('waves:customer-dialog', onDialog);
  }
});

it('a start whose answer was lost asks once more and opens the quote; it never files a request (codex pre-push P1)', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const assign = vi.fn();
  const original = window.location;
  Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign } });
  try {
    // The first mint committed, but its answer never arrived; the second tap hands back the same quote.
    api.startPlan
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true, url: '/estimate/tok123', estimateId: 'e1', reused: true });
    await priceIt(priced(OFFER));
    fireEvent.click(await screen.findByRole('button', { name: 'See my price and book' }));
    await screen.findByRole('button', { name: 'Open it now' });
    expect(api.startPlan).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1600);
    expect(assign).toHaveBeenCalledWith('/estimate/tok123');
    expect(api.createRequest).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(window, 'location', { configurable: true, value: original });
    vi.useRealTimers();
  }
});

const lostAnswer = () => new TypeError('Failed to fetch');
const gatewayError = () => Object.assign(new Error('Request failed (502)'), { status: 502 });
it.each([
  ['no answer twice', lostAnswer, lostAnswer],
  ['a gateway error twice', gatewayError, gatewayError],
  // The first call may have made a quote, so the repeat's refusal must not file a request either.
  ['no answer, then a refusal of the repeat', lostAnswer, () => Object.assign(new Error('The price changed since you last looked. Please check the new price.'), { status: 409, code: 'offer_changed' })],
])('a start that gets %s tells the customer to tap again and files no request (codex pre-push P1)', async (_label, first, second) => {
  api.startPlan.mockRejectedValueOnce(first()).mockRejectedValueOnce(second());
  const alerts = [];
  const onDialog = (event) => alerts.push(event.detail.message);
  window.addEventListener('waves:customer-dialog', onDialog);
  try {
    await priceIt(priced(OFFER));
    fireEvent.click(await screen.findByRole('button', { name: 'See my price and book' }));
    await waitFor(() => expect(alerts).toHaveLength(1));
    expect(alerts[0]).toMatch(/could not confirm your estimate/);
    expect(api.startPlan).toHaveBeenCalledTimes(2);
    expect(api.createRequest).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('waves:customer-dialog', onDialog);
  }
});

// Customer access tokens as the API client reads them (header.claims.signature).
const tokenFor = (claims) => `e30.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.sig`;
const TAP_TOKEN = tokenFor({ customerId: 'cust-a', sessionId: 'family-a' });
const OTHER_ACCOUNT = tokenFor({ customerId: 'cust-b', sessionId: 'family-b' });
const REFRESHED_TAP = tokenFor({ customerId: 'cust-a', sessionId: 'family-a', iat: 2 });
function watchAlerts() {
  const alerts = [];
  const onDialog = (event) => alerts.push(event.detail.message);
  window.addEventListener('waves:customer-dialog', onDialog);
  return { alerts, stop: () => window.removeEventListener('waves:customer-dialog', onDialog) };
}
// Runs `body` with window.location.assign recorded and fake timers, then puts both back.
async function withNavigation(body) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const assign = vi.fn();
  const original = window.location;
  Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign } });
  try {
    await body(assign);
  } finally {
    Object.defineProperty(window, 'location', { configurable: true, value: original });
    vi.useRealTimers();
    api.token = undefined;
  }
}

it.each([
  ['the API client cancels it (requestSuperseded)', () => Object.assign(new Error('Request canceled because the active account changed.'), { requestSuperseded: true })],
  ['its answer is lost', lostAnswer],
])('a start whose session changed while it waited, where %s, is never repeated and ends with nothing filed or shown (codex pre-push P0/P1)', async (_label, failure) => {
  api.token = TAP_TOKEN;
  // Any repeat would fail too, so a wrong repeat shows up as a second call, never as a hang.
  api.startPlan.mockRejectedValue(lostAnswer()).mockImplementationOnce(() => {
    api.token = OTHER_ACCOUNT; // another account became active while the start waited
    return Promise.reject(failure());
  });
  const { alerts, stop } = watchAlerts();
  try {
    await priceIt(priced(OFFER));
    fireEvent.click(await screen.findByRole('button', { name: 'See my price and book' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'See my price and book' })).toBeEnabled());
    expect(api.startPlan).toHaveBeenCalledOnce();
    expect(api.createRequest).not.toHaveBeenCalled();
    expect(alerts).toEqual([]);
  } finally {
    stop();
    api.token = undefined;
  }
});

it.each([
  ['an estimate link', () => Promise.resolve({ ok: true, url: '/estimate/tok-a', estimateId: 'e1', reused: false })],
  ['a refusal that files a request', () => Promise.reject(Object.assign(new Error('The price changed.'), { status: 409, code: 'offer_changed' }))],
])('a reply that lands after another account became active is dropped: %s never reaches that account (codex pre-push P0)', async (_label, reply) => {
  await withNavigation(async (assign) => {
    api.token = TAP_TOKEN;
    api.startPlan.mockImplementationOnce(() => {
      api.token = OTHER_ACCOUNT; // the API client still answers a request whose session changed
      return reply();
    });
    const { alerts, stop } = watchAlerts();
    try {
      await priceIt(priced(OFFER));
      fireEvent.click(await screen.findByRole('button', { name: 'See my price and book' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'See my price and book' })).toBeEnabled());
      vi.advanceTimersByTime(1600);
      expect(screen.queryByRole('button', { name: 'Open it now' })).toBeNull();
      expect(assign).not.toHaveBeenCalled();
      expect(api.createRequest).not.toHaveBeenCalled();
      expect(alerts).toEqual([]);
    } finally {
      stop();
    }
  });
});

it('the hand-off checks the session again before it opens the estimate (codex pre-push P0)', async () => {
  await withNavigation(async (assign) => {
    api.token = TAP_TOKEN;
    api.startPlan.mockResolvedValue({ ok: true, url: '/estimate/tok-a', estimateId: 'e1', reused: false });
    await priceIt(priced(OFFER));
    fireEvent.click(await screen.findByRole('button', { name: 'See my price and book' }));
    await screen.findByRole('button', { name: 'Open it now' });
    api.token = OTHER_ACCOUNT; // another account became active during the beat on screen
    vi.advanceTimersByTime(1600);
    expect(assign).not.toHaveBeenCalled();
    // The hand-off is dropped, so nothing on screen can open it later.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open it now' })).toBeNull());
  });
});

it('"Open it now" checks the tap\'s session when tapped: under another account it opens nothing and drops the hand-off (codex pre-push P0)', async () => {
  await withNavigation(async (assign) => {
    api.token = TAP_TOKEN;
    api.startPlan.mockResolvedValue({ ok: true, url: '/estimate/tok-a', estimateId: 'e1', reused: false });
    await priceIt(priced(OFFER));
    fireEvent.click(await screen.findByRole('button', { name: 'See my price and book' }));
    const open = await screen.findByRole('button', { name: 'Open it now' });
    api.token = OTHER_ACCOUNT; // another account became active while the card stayed on screen
    fireEvent.click(open);
    expect(assign).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open it now' })).toBeNull());
    vi.advanceTimersByTime(1600);
    expect(assign).not.toHaveBeenCalled();
  });
});

it('"Open it now" in the tap\'s session opens the estimate at once', async () => {
  await withNavigation(async (assign) => {
    api.token = TAP_TOKEN;
    api.startPlan.mockResolvedValue({ ok: true, url: '/estimate/tok-a', estimateId: 'e1', reused: false });
    await priceIt(priced(OFFER));
    fireEvent.click(await screen.findByRole('button', { name: 'See my price and book' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open it now' }));
    expect(assign).toHaveBeenCalledWith('/estimate/tok-a');
  });
});

it('a token refreshed within the same session keeps the reply: the hand-off goes ahead (codex pre-push P0)', async () => {
  await withNavigation(async (assign) => {
    api.token = TAP_TOKEN;
    api.startPlan.mockImplementationOnce(() => {
      api.token = REFRESHED_TAP; // same customer, same session: only the access token is new
      return Promise.resolve({ ok: true, url: '/estimate/tok-a', estimateId: 'e1', reused: false });
    });
    await priceIt(priced(OFFER));
    fireEvent.click(await screen.findByRole('button', { name: 'See my price and book' }));
    await screen.findByRole('button', { name: 'Open it now' });
    vi.advanceTimersByTime(1600);
    expect(assign).toHaveBeenCalledWith('/estimate/tok-a');
  });
});

it('turns the button off while a new answer loads: the option on screen is the old answer\'s', async () => {
  await priceIt(priced(OFFER));
  const start = await screen.findByRole('button', { name: 'See my price and book' });
  api.queryCustomerPricing.mockReturnValue(new Promise(() => {}));
  fireEvent.click(screen.getByRole('button', { name: 'Get Pricing' }));
  expect(await screen.findByRole('button', { name: 'Pricing...' })).toBeDisabled();
  expect(start).toBeDisabled();
  fireEvent.click(start);
  expect(api.startPlan).not.toHaveBeenCalled();
  expect(api.createRequest).not.toHaveBeenCalled();
});

// One render per case (see above).
it.each([
  ['"Request This"', priced(), 'Request This'],
  ['"Request Manual Review" (an answer with no option)', { ok: true, message: 'We need a closer look.', currentServices: [], options: [] }, 'Request Manual Review'],
])('turns %s off while a new answer loads: a request for the old answer never marks the new one as sent (codex pre-push P1)', async (_label, first, name) => {
  await priceIt(first);
  const request = await screen.findByRole('button', { name });
  const next = {};
  api.queryCustomerPricing.mockReturnValue(new Promise((resolve) => Object.assign(next, { resolve })));
  fireEvent.click(screen.getByRole('button', { name: 'Get Pricing' }));
  expect(await screen.findByRole('button', { name: 'Pricing...' })).toBeDisabled();
  expect(request).toBeDisabled();
  fireEvent.click(request);
  expect(api.createRequest).not.toHaveBeenCalled();
  // The new answer lists the same option: booking shows, never "Request sent".
  await act(async () => { next.resolve(priced(OFFER)); });
  expect(await screen.findByRole('button', { name: 'See my price and book' })).toBeEnabled();
  expect(screen.queryByText('Request sent')).toBeNull();
});

it('offers the button per option: another option the server did not list keeps today\'s request', async () => {
  await priceIt(pricedTwo());
  expect(await screen.findByRole('button', { name: 'See my price and book' })).toBeInTheDocument();
  fireEvent.change(optionSelect(), { target: { value: 'pest-bimonthly' } });
  expect(await screen.findByRole('button', { name: 'Request This' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'See my price and book' })).toBeNull();
});

it.each([
  ['answers with an estimate', (settle) => settle.resolve({ ok: true, url: '/estimate/old-option', estimateId: 'e0', reused: false })],
  ['fails', (settle) => settle.reject(Object.assign(new Error('The price changed.'), { status: 409 }))],
])('a start for an option the customer left, which then %s, is dropped: no hand-off, no request', async (_label, finish) => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const assign = vi.fn();
  const original = window.location;
  Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign } });
  try {
    const settle = {};
    api.startPlan.mockReturnValue(new Promise((resolve, reject) => Object.assign(settle, { resolve, reject })));
    await priceIt(pricedTwo());
    fireEvent.click(await screen.findByRole('button', { name: 'See my price and book' }));
    await waitFor(() => expect(api.startPlan).toHaveBeenCalledOnce());
    fireEvent.change(optionSelect(), { target: { value: 'pest-bimonthly' } });
    await act(async () => { finish(settle); });
    vi.advanceTimersByTime(1600);
    expect(screen.queryByRole('button', { name: 'Open it now' })).toBeNull();
    expect(assign).not.toHaveBeenCalled();
    expect(api.createRequest).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Request This' })).toBeEnabled();
  } finally {
    Object.defineProperty(window, 'location', { configurable: true, value: original });
    vi.useRealTimers();
  }
});

it('a second start waits until the first settles: the mint archives the account\'s other live quote (codex pre-push P1)', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const assign = vi.fn();
  const original = window.location;
  Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign } });
  try {
    const LAWN = { ...OPTION, id: 'lawn-enhanced', serviceKey: 'lawn_care', label: 'Enhanced lawn care', cadence: '9 visits/year', monthly: 52, perVisit: 69.33 };
    const settle = {};
    api.startPlan
      .mockReturnValueOnce(new Promise((resolve) => Object.assign(settle, { resolve })))
      .mockResolvedValueOnce({ ok: true, url: '/estimate/lawn', estimateId: 'e2', reused: false });
    await priceIt({ ok: true, message: 'Priced.', currentServices: [], options: [OPTION, LAWN], planStart: { optionIds: ['pest-quarterly', 'lawn-enhanced'] } });
    fireEvent.click(await screen.findByRole('button', { name: 'See my price and book' }));
    await waitFor(() => expect(api.startPlan).toHaveBeenCalledOnce());
    const select = screen.getAllByRole('combobox').find((el) => el.querySelector('option[value="lawn-enhanced"]'));
    fireEvent.change(select, { target: { value: 'lawn-enhanced' } });
    // The pest start is still minting: the lawn button stays off, and a tap starts nothing.
    const lawnStart = await screen.findByRole('button', { name: 'See my price and book' });
    expect(lawnStart).toBeDisabled();
    fireEvent.click(lawnStart);
    expect(api.startPlan).toHaveBeenCalledOnce();
    // The pest reply lands: dropped (the customer left that option), and the lawn button comes back.
    await act(async () => { settle.resolve({ ok: true, url: '/estimate/pest', estimateId: 'e1', reused: false }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'See my price and book' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'See my price and book' }));
    await waitFor(() => expect(api.startPlan).toHaveBeenCalledTimes(2));
    expect(api.startPlan).toHaveBeenLastCalledWith(expect.objectContaining({ serviceKey: 'lawn_care', optionId: 'lawn-enhanced' }));
    await screen.findByRole('button', { name: 'Open it now' });
    vi.advanceTimersByTime(1600);
    expect(assign).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith('/estimate/lawn');
  } finally {
    Object.defineProperty(window, 'location', { configurable: true, value: original });
    vi.useRealTimers();
  }
});

it('a fallback request that lands after the customer picked another option never marks that option as sent', async () => {
  api.startPlan.mockRejectedValue(Object.assign(new Error('The price changed.'), { status: 409 }));
  const settle = {};
  api.createRequest.mockReturnValue(new Promise((resolve) => Object.assign(settle, { resolve })));
  await priceIt(pricedTwo());
  fireEvent.click(await screen.findByRole('button', { name: 'See my price and book' }));
  await waitFor(() => expect(api.createRequest).toHaveBeenCalledOnce());
  fireEvent.change(optionSelect(), { target: { value: 'pest-bimonthly' } });
  await act(async () => { settle.resolve({ success: true }); });
  expect(screen.queryByText('Request sent')).toBeNull();
  expect(await screen.findByRole('button', { name: 'Request This' })).toBeEnabled();
});

it('shows the WaveGuard setup fee a bookable option\'s estimate charges, and posts it with the other amounts', async () => {
  api.startPlan.mockReturnValue(new Promise(() => {}));
  await priceIt(priced(OFFER, { setupFee: 99 }));
  fireEvent.click(await screen.findByRole('button', { name: 'See my price and book' }));
  expect(screen.getByText('WaveGuard setup')).toBeInTheDocument();
  expect(screen.getByText('$99.00')).toBeInTheDocument();
  await waitFor(() => expect(api.startPlan).toHaveBeenCalledWith(expect.objectContaining({
    shown: { monthly: 31.67, perVisit: 95, dueAtStart: null, oneTime: null, setupFee: 99 },
  })));
});

it('an older pricing answer that lands after the customer asked again is dropped: it never turns booking on', async () => {
  const first = {};
  const second = {};
  api.queryCustomerPricing
    .mockReturnValueOnce(new Promise((resolve) => Object.assign(first, { resolve })))
    .mockReturnValueOnce(new Promise((resolve) => Object.assign(second, { resolve })));
  render(<MyPlanTab customer={{ id: 'fixture-account', firstName: 'Fixture', tier: 'Bronze', property: {} }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Get Pricing' }));
  // A quick prompt asks again while the first answer is still out.
  fireEvent.click(screen.getByRole('button', { name: 'Mosquito' }));
  await waitFor(() => expect(api.queryCustomerPricing).toHaveBeenCalledTimes(2));
  await act(async () => { first.resolve(priced(OFFER)); });
  expect(screen.queryByRole('button', { name: 'See my price and book' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Pricing...' })).toBeDisabled();
  await act(async () => { second.resolve(priced()); });
  expect(await screen.findByRole('button', { name: 'Request This' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'See my price and book' })).toBeNull();
});

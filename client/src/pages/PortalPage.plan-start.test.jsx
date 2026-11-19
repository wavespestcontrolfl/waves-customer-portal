// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MyPlanTab } from './PortalPage';
import api from '../utils/api';

vi.mock('../utils/api', () => {
  const methods = {};
  return { default: new Proxy(methods, {
    get(target, key) {
      if (typeof key !== 'string') return target[key];
      return target[key] ||= vi.fn(() => new Promise(() => {}));
    },
  }) };
});

const OPTION = {
  id: 'pest-quarterly', serviceKey: 'pest_control', label: 'Quarterly pest control', cadence: '4 visits/year',
  monthly: 31.67, perVisit: 95, dueAtStart: null, oneTime: null, confidence: 'high', manualReview: false, notes: [],
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
  ['no plan-start hint', priced()],
  ['a hint that lists other options only', priced({ planStart: { optionIds: ['pest-bimonthly'] } })],
])('keeps today\'s button when there is %s', async (_label, result) => {
  await priceIt(result);
  expect(await screen.findByRole('button', { name: 'Request This' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'See my price and book' })).toBeNull();
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
      serviceKey: 'pest_control', optionId: 'pest-quarterly', shown: { monthly: 31.67, perVisit: 95, dueAtStart: null, oneTime: null },
    }));
    expect(await screen.findByRole('link', { name: 'Open it now' })).toHaveAttribute('href', '/estimate/tok123');
    expect(api.createRequest).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1600);
    expect(assign).toHaveBeenCalledWith('/estimate/tok123');
  } finally {
    Object.defineProperty(window, 'location', { configurable: true, value: original });
    vi.useRealTimers();
  }
});

it('falls back to today\'s request on a 409 (or any error), so the customer never hits a dead end', async () => {
  const err = Object.assign(new Error('The price changed.'), { status: 409 });
  api.startPlan.mockRejectedValue(err);
  await priceIt(priced(OFFER));
  fireEvent.click(await screen.findByRole('button', { name: 'See my price and book' }));
  await waitFor(() => expect(api.createRequest).toHaveBeenCalledOnce());
  expect(api.createRequest).toHaveBeenCalledWith({
    category: 'add_service', subject: 'Add Pest Control to my plan', description: 'Customer priced Quarterly pest control in the portal.',
  });
  expect(await screen.findByText('Request sent')).toBeInTheDocument();
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
    expect(screen.queryByRole('link', { name: 'Open it now' })).toBeNull();
    expect(assign).not.toHaveBeenCalled();
    expect(api.createRequest).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Request This' })).toBeEnabled();
  } finally {
    Object.defineProperty(window, 'location', { configurable: true, value: original });
    vi.useRealTimers();
  }
});

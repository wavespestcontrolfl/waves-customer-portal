// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  monthly: 31.67, perVisit: 95, confidence: 'high', manualReview: false, notes: [],
  requestSubject: 'Add Pest Control to my plan', requestDescription: 'Customer priced Quarterly pest control in the portal.',
};
const priced = (extra = {}, option = {}) => ({ ok: true, message: 'Priced.', currentServices: [], options: [{ ...OPTION, ...option }], ...extra });

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
  await priceIt(priced({ planStart: { available: true } }));
  expect(await screen.findByRole('button', { name: 'See my price and book' })).toBeInTheDocument();
  expect(screen.getByText('Your estimate shows the full price and open times. Pick a time to book.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Request This' })).toBeNull();
});

it('keeps today\'s button when there is no hint, when there is no monthly price, or when the option needs review', async () => {
  for (const [result, label] of [
    [priced(), 'no hint'],
    [priced({ planStart: { available: true } }, { monthly: null }), 'no monthly'],
    [priced({ planStart: { available: true } }, { manualReview: true }), 'manual review'],
  ]) {
    cleanup();
    vi.clearAllMocks();
    api.getNextService.mockResolvedValue({ next: null });
    api.getSchedule.mockResolvedValue({ upcoming: [] });
    api.getServices.mockResolvedValue({ services: [] });
    api.getAutopay.mockResolvedValue({ state: 'disabled' });
    api.getStationMap.mockResolvedValue({ available: false });
    api.getLawnHealth.mockResolvedValue({ available: false });
     
    await priceIt(result);
     
    expect(await screen.findByRole('button', { name: 'Request This' }), label).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'See my price and book' })).toBeNull();
  }
});

it('posts the selected option and the shown monthly, then hands off to the estimate URL', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const assign = vi.fn();
  const original = window.location;
  Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign } });
  try {
    api.startPlan.mockResolvedValue({ ok: true, url: '/estimate/tok123', estimateId: 'e1', reused: false });
    await priceIt(priced({ planStart: { available: true } }));
    fireEvent.click(await screen.findByRole('button', { name: 'See my price and book' }));
    await waitFor(() => expect(api.startPlan).toHaveBeenCalledWith({ serviceKey: 'pest_control', optionId: 'pest-quarterly', shownMonthly: 31.67 }));
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
  await priceIt(priced({ planStart: { available: true } }));
  fireEvent.click(await screen.findByRole('button', { name: 'See my price and book' }));
  await waitFor(() => expect(api.createRequest).toHaveBeenCalledOnce());
  expect(api.createRequest).toHaveBeenCalledWith({
    category: 'add_service', subject: 'Add Pest Control to my plan', description: 'Customer priced Quarterly pest control in the portal.',
  });
  expect(await screen.findByText('Request sent')).toBeInTheDocument();
});

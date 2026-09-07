// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WebsiteEstimateFlow, { WebsiteEstimateFrame } from './WebsiteEstimateFlow';
import WebsiteCallbackButton from './WebsiteCallbackButton';

beforeEach(() => vi.stubGlobal('scrollTo', vi.fn()));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const base = {
  services: [], selected: {}, onFrequencyChange: vi.fn(), lockedSection: () => false,
  oneTime: true, fees: [], bookingContent: <div>Available times</div>,
  phone: '(941) 297-5749', phoneHref: 'tel:+19412975749', canBook: true,
};

it('shows recurring prices and additional one-time work without repeating a setup fee', () => {
  render(<WebsiteEstimateFlow {...base} oneTime={false}
    services={[{ key: 'pest_control', label: 'Pest Control', isRecurring: true,
      frequencies: [{ key: 'quarterly', visitsPerYear: 4, perTreatment: 99 }] }]}
    fees={[{ service: 'waveguard_setup', label: 'Membership fee', amount: 99, waivedWithPrepay: true }]}
    oneTimeBreakdown={{ items: [
      { service: 'wasp', label: 'Wasp Nest Removal', amount: 150 },
      { service: 'waveguard_setup', label: 'Membership fee', amount: 99 },
    ] }} />);
  expect(screen.getByText('Quarterly Pest Control Service')).toBeInTheDocument();
  expect(screen.getByText('One-Time Wasp Nest Removal')).toBeInTheDocument();
  expect(screen.getAllByText('$99.00')).toHaveLength(1);
  expect(screen.getByText('$99.00 one-time WaveGuard membership fee')).toBeInTheDocument();
  expect(screen.getByText('$150.00')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /book my service/i }));
  expect(screen.getByText('Available times')).toBeInTheDocument();
});

it('keeps booking unavailable when a line has no quoted amount', () => {
  render(<WebsiteEstimateFlow {...base} oneTimeBreakdown={{ items: [{ label: 'Inspection', amount: null }] }} />);
  expect(screen.getByText('We’ll confirm your price')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /book my service/i })).not.toBeInTheDocument();
});

it('preserves a server-supplied one-time label without doubling its prefix', () => {
  render(<WebsiteEstimateFlow {...base} oneTimeBreakdown={{ items: [{ service: 'one_time_pest', label: 'One-Time Pest Treatment', amount: 199 }] }} />);
  expect(screen.getByText('One-Time Pest Control Service')).toBeInTheDocument();
  expect(screen.queryByText(/One-Time One-Time/)).not.toBeInTheDocument();
});

it('preserves an included line and a discount rather than hiding them as unknown prices', () => {
  render(<WebsiteEstimateFlow {...base} oneTimeBreakdown={{ items: [
    { label: 'Pest Control', amount: 199 }, { label: 'Follow-up', amount: 0, kind: 'included' },
    { label: 'Service credit', amount: -25, kind: 'discount' },
  ] }} />);
  expect(screen.getByText('$0.00')).toBeInTheDocument();
  expect(screen.getByText('-$25.00')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /book my service/i })).toBeEnabled();
});

it('does not submit a callback twice while its request is pending or after success', async () => {
  let finish;
  const fetchMock = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetchMock);
  render(<WebsiteCallbackButton token="synthetic-quote-token" />);
  const button = screen.getByRole('button', { name: 'Call Me' });
  fireEvent.click(button); fireEvent.click(button);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ kind: 'callback' });
  finish({ ok: true, json: async () => ({ success: true }) });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Call Requested' })).toBeDisabled());
});

it('lets the customer retry a failed callback without claiming success', async () => {
  const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
  vi.stubGlobal('fetch', fetchMock);
  render(<WebsiteCallbackButton token="synthetic-quote-token" />);
  fireEvent.click(screen.getByRole('button', { name: 'Call Me' }));
  await screen.findByText(/request didn’t go through/i);
  fireEvent.click(screen.getByRole('button', { name: 'Call Me' }));
  await screen.findByText('We received your callback request.');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('tells the host page which stage the frame is at — booked on the success card, null otherwise', () => {
  const postMessage = vi.fn();
  vi.stubGlobal('parent', { postMessage });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(document, 'referrer', { value: 'https://www.wavespestcontrol.com/estimate/pest-control/', configurable: true });
  render(<WebsiteEstimateFrame title="Your Quote"><div>quote</div></WebsiteEstimateFrame>);
  expect(postMessage).toHaveBeenCalledWith({ type: 'waves:estimate-step', stage: null }, 'https://www.wavespestcontrol.com');
  cleanup();
  postMessage.mockClear();
  render(<WebsiteEstimateFrame stage="booked"><div>booked</div></WebsiteEstimateFrame>);
  expect(postMessage).toHaveBeenCalledWith({ type: 'waves:estimate-step', stage: 'booked' }, 'https://www.wavespestcontrol.com');
});

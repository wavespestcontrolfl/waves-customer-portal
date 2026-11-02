// @vitest-environment jsdom
// Customer 360 Moving card (GATE_MOVING_FLOW): hidden while the server says
// enabled:false, one plain status line for the newest move, and each button
// posts its own route on the staff click. Nothing sends on load.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = { list: { enabled: true, moves: [], text: { phone: '+19415550100', hasTexts: true } }, email: { ok: true, sent: true, reason: null } };
vi.mock('../../lib/adminFetch', () => ({
  adminFetch: vi.fn(async (url) => {
    if (url.endsWith('/moving-email')) return { ok: true, json: async () => state.email };
    if (url.endsWith('/moving-link')) return { ok: true, json: async () => ({ url: 'https://wvs.example/m/abc', moveId: 'move-1', status: 'open' }) };
    return { ok: true, json: async () => state.list };
  }),
}));

import { adminFetch } from '../../lib/adminFetch';
import CustomerMovingCardV2, { moveStatusText, textHref } from './CustomerMovingCardV2';

const CUSTOMER = '3f2b8c4e-9d1a-4f6b-8e2c-5a7d9b1c3e5f';

afterEach(() => cleanup());
beforeEach(() => {
  state.list = { enabled: true, moves: [], text: { phone: '+19415550100', hasTexts: true } };
  state.email = { ok: true, sent: true, reason: null };
  adminFetch.mockClear();
});

describe('moveStatusText', () => {
  it('says where the newest move stands in plain words', () => {
    expect(moveStatusText(undefined)).toBe('No move yet');
    expect(moveStatusText({ status: 'open', link_sent_at: null })).toBe('Link made');
    expect(moveStatusText({ status: 'open', link_sent_at: '2026-11-02T15:00:00Z', link_channel: 'email' })).toBe('Link sent Nov 2 by email');
    expect(moveStatusText({
      status: 'submitted',
      submitted_at: '2026-11-03T15:00:00Z',
      typed_address: '12 Example Way',
      normalized_address: JSON.stringify({ city: 'Parrish' }),
      address_verdict: 'in_area',
      move_out_date: '2026-11-15',
      move_in_date: null,
    })).toBe('Submitted Nov 3: new home in Parrish, in our area, move-out Nov 15, move-in not known yet');
    expect(moveStatusText({ status: 'submitted', submitted_at: '2026-11-03T15:00:00Z', typed_address: null, move_out_date: '2026-11-15' }))
      .toBe('Submitted Nov 3: new address not known yet, move-out Nov 15, move-in not known yet');
  });
});

describe('textHref', () => {
  it('opens the SMS thread when the customer has texts, else a new text to the phone', () => {
    expect(textHref(CUSTOMER, { hasTexts: true, phone: '+19415550100' })).toBe(`/admin/communications?thread=${CUSTOMER}#tab=sms`);
    expect(textHref(CUSTOMER, { hasTexts: false, phone: '+19415550100' })).toBe('/admin/communications?phone=%2B19415550100&action=sms#tab=sms');
    expect(textHref(CUSTOMER, { hasTexts: false, phone: null })).toBeNull();
    expect(textHref(CUSTOMER, null)).toBeNull();
  });
});

describe('CustomerMovingCardV2', () => {
  it('renders nothing while the server says enabled:false', async () => {
    state.list = { enabled: false, moves: [] };
    const { container } = render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });

  it('loads with one read and sends nothing until a click', async () => {
    render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    expect(await screen.findByTestId('moving-status')).toHaveTextContent('No move yet');
    expect(adminFetch).toHaveBeenCalledTimes(1);
    expect(adminFetch.mock.calls[0][0]).toBe(`/admin/customers/${CUSTOMER}/moves`);
    expect(screen.getByRole('link', { name: 'Text moving link' })).toHaveAttribute('href', `/admin/communications?thread=${CUSTOMER}#tab=sms`);
  });

  it('a customer with no texts gets a new text to their phone; no phone disables the button', async () => {
    state.list = { enabled: true, moves: [], text: { phone: '+19415550100', hasTexts: false } };
    const { unmount } = render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    expect(await screen.findByRole('link', { name: 'Text moving link' })).toHaveAttribute('href', '/admin/communications?phone=%2B19415550100&action=sms#tab=sms');
    unmount();
    state.list = { enabled: true, moves: [], text: { phone: null, hasTexts: false } };
    render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    expect(await screen.findByRole('button', { name: 'Text moving link' })).toBeDisabled();
  });

  it('Email moving link posts the email route and reports the outcome', async () => {
    render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Email moving link' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Moving link emailed.');
    expect(adminFetch).toHaveBeenCalledWith(`/admin/customers/${CUSTOMER}/moving-email`, { method: 'POST', body: '{}' });
  });

  it('a skipped email says why in plain words', async () => {
    state.email = { ok: false, sent: false, reason: 'email_opted_out' };
    render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Email moving link' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Email not sent. This customer turned email off.');
  });

  it('Copy moving link falls back to a selectable box when the clipboard is blocked', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => { throw new Error('blocked'); }) } });
    render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy moving link' }));
    expect(await screen.findByLabelText('Moving link')).toHaveValue('https://wvs.example/m/abc');
    expect(adminFetch).toHaveBeenCalledWith(`/admin/customers/${CUSTOMER}/moving-link`, { method: 'POST', body: '{}' });
  });
});

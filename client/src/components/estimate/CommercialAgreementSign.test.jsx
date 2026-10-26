// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CommercialAgreementSign, { SIGN_BUTTON_LABEL } from './CommercialAgreementSign';

let assign;
beforeEach(() => {
  assign = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('CommercialAgreementSign', () => {
  it('renders nothing without the server block', () => {
    const { container } = render(<CommercialAgreementSign token="tok-1" commercialAgreement={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('terms that conflict with the agreement (canSign false, reason): a call-us card with no button and no account wording', () => {
    render(<CommercialAgreementSign token="tok-1" commercialAgreement={{ canSign: false, state: 'none', reason: 'terms_conflict', field: 'initialTermMonths' }} />);
    expect(screen.queryByRole('button', { name: SIGN_BUTTON_LABEL })).not.toBeInTheDocument();
    const card = screen.getByTestId('commercial-agreement-call');
    expect(card).toHaveTextContent('Call us at (941) 297-5749 and we will finish your agreement with you.');
    expect(card).not.toHaveTextContent('set up your account');
  });

  it('no account (canSign false, no reason): the account wording', () => {
    render(<CommercialAgreementSign token="tok-1" commercialAgreement={{ canSign: false, state: 'none' }} />);
    expect(screen.getByTestId('commercial-agreement-call')).toHaveTextContent('set up your account');
  });

  it('awaiting: offers to pick up where the customer left off', () => {
    render(<CommercialAgreementSign token="tok-1" commercialAgreement={{ canSign: true, state: 'awaiting' }} />);
    expect(screen.getByText(/Pick up where you left off/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: SIGN_BUTTON_LABEL })).toBeInTheDocument();
  });

  it('a refused tap shows the server message and does not navigate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'This agreement has already been signed.' }) })));
    render(<CommercialAgreementSign token="tok-1" commercialAgreement={{ canSign: true, state: 'none' }} />);
    fireEvent.click(screen.getByRole('button', { name: SIGN_BUTTON_LABEL }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This agreement has already been signed.');
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: SIGN_BUTTON_LABEL })).toBeEnabled();
  });

  it('a failed request shows a call-us fallback and does not navigate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    render(<CommercialAgreementSign token="tok-1" commercialAgreement={{ canSign: true, state: 'none' }} />);
    fireEvent.click(screen.getByRole('button', { name: SIGN_BUTTON_LABEL }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/call us at \(941\) 297-5749/));
    expect(assign).not.toHaveBeenCalled();
  });

  it('a double tap sends one request', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ signingUrl: 'https://portal.example.test/contract/x' }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<CommercialAgreementSign token="tok-1" commercialAgreement={{ canSign: true, state: 'none' }} />);
    const button = screen.getByRole('button', { name: SIGN_BUTTON_LABEL });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// GATE_COMMERCIAL_FIRST_VISIT: /data's cta.commercialFirstVisit turns the signed state into the first-visit picker.
describe('CommercialAgreementSign with the first-visit picker', () => {
  it('signed + pick: the picker replaces "we will follow up", and it loads the open times', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, days: [], slots: [] }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<CommercialAgreementSign token="tok-1" commercialAgreement={{ canSign: false, state: 'signed' }} firstVisit={{ state: 'pick', durationMinutes: 30 }} />);
    expect(screen.getByTestId('commercial-first-visit-picker')).toHaveTextContent('Each visit takes about 30 minutes.');
    expect(screen.queryByText(/Our team will follow up/)).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/estimates/tok-1/first-visit/availability', { method: 'POST' }));
  });

  it('signed + booked: the booked date instead of "we will follow up"', () => {
    render(<CommercialAgreementSign token="tok-1" commercialAgreement={{ canSign: false, state: 'signed' }} firstVisit={{ state: 'booked', visit: { date: '2026-11-03', windowStart: '09:00', windowEnd: '10:00' } }} />);
    expect(screen.getByTestId('commercial-agreement-signed')).toHaveTextContent('Your first visit is booked for Tuesday, November 3 at 9 AM.');
  });

  it('signed with no first-visit block (gate off or not eligible): the copy is unchanged', () => {
    render(<CommercialAgreementSign token="tok-1" commercialAgreement={{ canSign: false, state: 'signed' }} />);
    expect(screen.getByTestId('commercial-agreement-signed')).toHaveTextContent('Our team will follow up to schedule your first visit.');
  });

  it('before signing, an eligible proposal says the customer picks the visit next', () => {
    render(<CommercialAgreementSign token="tok-1" commercialAgreement={{ canSign: true, state: 'none' }} firstVisit={{ state: 'after_signing' }} />);
    expect(screen.getByTestId('commercial-agreement-sign')).toHaveTextContent('Then you pick the day and time of your first visit.');
    expect(screen.getByTestId('commercial-agreement-sign')).not.toHaveTextContent('our team will follow up');
  });
});

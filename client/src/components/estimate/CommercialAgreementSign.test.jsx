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

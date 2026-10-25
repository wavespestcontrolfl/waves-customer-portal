// @vitest-environment jsdom
// The Florida consumer notice card (GATE_ESTIMATE_CONSUMER_NOTICE): one render per state, the tap that opens the
// signing page in the same tab, and the server's own 409 wording shown as is.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConsumerNoticeSign, { ConsumerNoticeHint, CONSUMER_NOTICE_HINT } from './ConsumerNoticeSign';

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

let assign;
beforeEach(() => {
  assign = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ConsumerNoticeSign', () => {
  it('renders nothing without a block (gate off, or nothing to sign)', () => {
    const { container } = render(<ConsumerNoticeSign token="t1" consumerNotice={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('state none: the heading, the reason and the button', () => {
    render(<ConsumerNoticeSign token="t1" consumerNotice={{ state: 'none', canSign: true }} />);
    expect(screen.getByText('Florida consumer notice')).toBeInTheDocument();
    expect(screen.getByText('Florida law asks you to read and sign the state’s Consumer Notice Form (FDACS-13692) before you accept a termite treatment. It takes about a minute.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read and sign the notice' })).toBeEnabled();
  });

  it('back from the signing page without signing (a cache restore), the button works again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ signingUrl: 'https://portal.example.test/contract/abc' }, 201)));
    render(<ConsumerNoticeSign token="t1" consumerNotice={{ state: 'awaiting', canSign: true }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read and sign the notice' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://portal.example.test/contract/abc'));
    expect(screen.getByRole('button', { name: 'Opening the notice…' })).toBeDisabled();
    // A normal load is not a restore: nothing changes.
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    expect(screen.getByRole('button', { name: 'Opening the notice…' })).toBeDisabled();
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    const again = await screen.findByRole('button', { name: 'Read and sign the notice' });
    expect(again).toBeEnabled();
    fireEvent.click(again);
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
  });

  it('state awaiting: pick up where you left off', () => {
    render(<ConsumerNoticeSign token="t1" consumerNotice={{ state: 'awaiting', canSign: true }} />);
    expect(screen.getByText('Florida consumer notice')).toBeInTheDocument();
    expect(screen.getByText('Your consumer notice is ready for your signature. Pick up where you left off.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read and sign the notice' })).toBeInTheDocument();
  });

  it('state signed: the thank-you and no button', () => {
    render(<ConsumerNoticeSign token="t1" consumerNotice={{ state: 'signed', canSign: false }} />);
    expect(screen.getByText('Consumer notice signed')).toBeInTheDocument();
    expect(screen.getByText('Thank you. You can accept your estimate below.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('canSign false: call us, with the phone link and no button', () => {
    render(<ConsumerNoticeSign token="t1" consumerNotice={{ state: 'none', canSign: false, reason: 'no_account' }} />);
    const card = screen.getByTestId('consumer-notice-call');
    expect(within(card).getByText('Florida consumer notice')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: '(941) 297-5749' })).toHaveAttribute('href', 'tel:+19412975749');
    expect(card).toHaveTextContent('and we will finish the notice with you.');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('the tap posts to the route, shows the busy label, and goes to the signing page in the same tab', async () => {
    let release;
    const fetchMock = vi.fn(() => new Promise((resolve) => { release = () => resolve(json({ signingUrl: 'https://portal.example.test/contract/abc123' }, 201)); }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ConsumerNoticeSign token="notice-token" consumerNotice={{ state: 'none', canSign: true }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read and sign the notice' }));
    expect(await screen.findByRole('button', { name: 'Opening the notice…' })).toBeDisabled();
    release();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://portal.example.test/contract/abc123'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/estimates\/notice-token\/consumer-notice$/);
    expect(fetchMock.mock.calls[0][1]).toEqual({ method: 'POST' });
  });

  it('a failure shows the try-again line with the phone number, and the button works again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'boom' }, 500)));
    render(<ConsumerNoticeSign token="t1" consumerNotice={{ state: 'none', canSign: true }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read and sign the notice' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t open the notice. Please try again, or call us at (941) 297-5749.');
    expect(screen.getByRole('button', { name: 'Read and sign the notice' })).toBeEnabled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('a server 409 shows its own wording as is', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'We couldn’t prepare the notice online. Please call us and we will finish it with you.', code: 'no_representative' }, 409)));
    render(<ConsumerNoticeSign token="t1" consumerNotice={{ state: 'none', canSign: true }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read and sign the notice' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t prepare the notice online. Please call us and we will finish it with you.');
  });
});

describe('ConsumerNoticeHint', () => {
  it('shows the hint only while blocked', () => {
    const { rerender } = render(<ConsumerNoticeHint blocked />);
    expect(screen.getByText(CONSUMER_NOTICE_HINT)).toBeInTheDocument();
    expect(CONSUMER_NOTICE_HINT).toBe('Sign the Florida consumer notice above to accept.');
    rerender(<ConsumerNoticeHint blocked={false} />);
    expect(screen.queryByText(CONSUMER_NOTICE_HINT)).not.toBeInTheDocument();
  });
});

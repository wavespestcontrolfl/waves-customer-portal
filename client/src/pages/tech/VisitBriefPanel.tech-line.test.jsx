// @vitest-environment jsdom
// Own-line mode: when the tech holds a Twilio line, Call bridges through it
// and Text composes from it; without a line the personal-phone links stay.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VisitBriefPanel from './VisitBriefPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const SERVICE = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'confirmed',
  customerName: 'Pat Sample',
  customerPhone: '(941) 555-0100',
  address: '123 Palm Ave, Bradenton, FL 34205',
  serviceType: 'Quarterly Pest Control',
};
const stop = { key: 'row:1', isVisit: false, services: [SERVICE], primary: SERVICE, liveCount: 1 };
const detail = { status: 'ready', byService: {} };
const LINE = { line: { number: '+19413529161', formatted: '(941) 352-9161', label: 'Tech line 1' }, canCall: true };

describe('VisitBriefPanel — own tech line', () => {
  it('without a line: Call and Text are tel:/sms: links to the personal phone', () => {
    render(<VisitBriefPanel stop={stop} detail={detail} />);
    expect(screen.getByRole('link', { name: /Call/ })).toHaveAttribute('href', expect.stringMatching(/^tel:/));
    expect(screen.getByRole('link', { name: /Text/ })).toHaveAttribute('href', expect.stringMatching(/^sms:/));
  });

  it('with a line: Text opens a compose that sends from the line for THIS visit', async () => {
    const request = vi.fn(async () => ({ success: true }));
    render(<VisitBriefPanel stop={stop} detail={detail} techLine={LINE} request={request} />);
    expect(screen.queryByRole('link', { name: /Text/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Text/ }));
    expect(screen.getByTestId('line-text-compose')).toHaveTextContent('Text from your line (941) 352-9161');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'On my way — 15 minutes.' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(request).toHaveBeenCalledWith('/tech/line/sms', {
      method: 'POST',
      body: JSON.stringify({ scheduledServiceId: SERVICE.id, body: 'On my way — 15 minutes.' }),
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Sent.');
  });

  it('with a line: Call confirms, then asks the server to bridge; a refusal shows inline', async () => {
    const request = vi.fn(async () => { throw new Error('Voice calling is disabled'); });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<VisitBriefPanel stop={stop} detail={detail} techLine={LINE} request={request} />);
    expect(screen.queryByRole('link', { name: /Call/ })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Call/ })); });
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Pat Sample'));
    expect(request).toHaveBeenCalledWith('/tech/line/call', { method: 'POST', body: JSON.stringify({ scheduledServiceId: SERVICE.id }) });
    expect(await screen.findByRole('alert')).toHaveTextContent('Voice calling is disabled');
  });

  it('with a line but no usable cell: no Call button, Text still works', () => {
    render(<VisitBriefPanel stop={stop} detail={detail} techLine={{ ...LINE, canCall: false }} request={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Call/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Call/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Text/ })).toBeInTheDocument();
  });

  it('line lookup not yet succeeded: no personal links, no line buttons, a notice — never the personal phone on a lookup error', () => {
    render(<VisitBriefPanel stop={stop} detail={detail} techLine={{ unknown: true }} request={vi.fn()} />);
    expect(screen.queryByRole('link', { name: /Call|Text/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(📞 )?Call$|Text/ })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("Your line couldn't be checked");
    expect(screen.getByRole('button', { name: /Navigate/ })).toBeInTheDocument();
  });

  it('while a text is sending, Close and the Text toggle are disabled so the pending send cannot be unmounted and resent', async () => {
    let resolveSend;
    const request = vi.fn(() => new Promise((resolve) => { resolveSend = resolve; }));
    render(<VisitBriefPanel stop={stop} detail={detail} techLine={LINE} request={request} />);
    fireEvent.click(screen.getByRole('button', { name: /Text/ }));
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hi' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Text/ })).toBeDisabled();
    await act(async () => { resolveSend({ success: true }); });
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Text/ })).toBeEnabled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('Call stays locked after the bridge is accepted (phone still ringing) and the parent is told the panel is busy', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ success: true }));
    const onBusyChange = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<VisitBriefPanel stop={stop} detail={detail} techLine={LINE} request={request} onBusyChange={onBusyChange} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Call/ })); });
    expect(screen.getByRole('button', { name: /Calling…/ })).toBeDisabled();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Calling…/ })); });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(45000); });
    expect(screen.getByRole('button', { name: /Call$/ })).toBeEnabled();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    vi.useRealTimers();
  });

  it('a declined confirm never calls the server', () => {
    const request = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<VisitBriefPanel stop={stop} detail={detail} techLine={LINE} request={request} />);
    fireEvent.click(screen.getByRole('button', { name: /Call/ }));
    expect(request).not.toHaveBeenCalled();
  });
});

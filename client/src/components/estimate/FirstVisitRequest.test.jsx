// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FirstVisitRequest, { firstVisitRequestSummary } from './FirstVisitRequest';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const okFetch = (status = 201, body = { success: true, requestPending: true, days: ['mon', 'wed'], window: 'afternoon' }) => vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));

describe('FirstVisitRequest (GATE_ESTIMATE_APPROVE_PREFERRED_TIME)', () => {
  it('starts as one quiet link under the time picker', () => {
    render(<FirstVisitRequest token="t1" />);
    expect(screen.getByRole('button', { name: 'None of these times work? Tell us when suits you.' })).toBeInTheDocument();
    expect(screen.queryByTestId('first-visit-request-form')).toBeNull();
  });

  it('says it is a request and offers only Mon to Sat', () => {
    render(<FirstVisitRequest token="t1" />);
    fireEvent.click(screen.getByRole('button', { name: /None of these times work/ }));
    expect(screen.getByTestId('first-visit-request-form')).toHaveTextContent('This is a request. Nothing is booked or charged until our office confirms with you.');
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((d) => expect(screen.getByRole('button', { name: d })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Sun' })).toBeNull();
  });

  it('needs a day and a part of the day, then posts them (with the note) to the request route', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const onSent = vi.fn();
    render(<FirstVisitRequest token="tok/en" onSent={onSent} />);
    fireEvent.click(screen.getByRole('button', { name: /None of these times work/ }));
    const send = screen.getByRole('button', { name: 'Send my request' });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Wed' }));
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Afternoon' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mon' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Dogs out until 9  ' } });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    await waitFor(() => expect(onSent).toHaveBeenCalledWith({ days: ['mon', 'wed'], window: 'afternoon' }));
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/estimates\/tok%2Fen\/first-visit-request$/);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ days: ['wed', 'mon'], window: 'afternoon', note: 'Dogs out until 9' });
  });

  it('a refused request shows a plain message and keeps the form', async () => {
    vi.stubGlobal('fetch', okFetch(409, { error: 'x', code: 'REQUEST_UNAVAILABLE' }));
    const onSent = vi.fn();
    render(<FirstVisitRequest token="t1" onSent={onSent} />);
    fireEvent.click(screen.getByRole('button', { name: /None of these times work/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Mon' }));
    fireEvent.click(screen.getByRole('button', { name: 'Either works' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send my request' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This estimate was just updated. Please reload the page.');
    expect(onSent).not.toHaveBeenCalled();
    expect(screen.getByTestId('first-visit-request-form')).toBeInTheDocument();
  });

  it('the pending state says the office will call or text, never booked or approved', () => {
    render(<FirstVisitRequest token="t1" pending={{ days: ['mon', 'wed'], window: 'morning' }} />);
    const card = screen.getByTestId('first-visit-request-pending');
    expect(card).toHaveTextContent('We have your request.');
    expect(card).toHaveTextContent('Mon, Wed, mornings');
    expect(card).toHaveTextContent('Our office will call or text you to set your first visit and finish your approval.');
    expect(card.textContent).not.toMatch(/booked|you're approved|is approved/i);
    expect(screen.queryByRole('button', { name: /None of these times work/ })).toBeNull();
  });

  it('Back to times closes the form without sending', () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<FirstVisitRequest token="t1" />);
    fireEvent.click(screen.getByRole('button', { name: /None of these times work/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to times' }));
    expect(screen.queryByTestId('first-visit-request-form')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('summary helper', () => {
    expect(firstVisitRequestSummary({ days: ['sat'], window: 'either' })).toBe('Sat, mornings or afternoons');
    expect(firstVisitRequestSummary({ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], window: 'morning' })).toBe('any day Mon to Sat, mornings');
    expect(firstVisitRequestSummary(null)).toBe('');
  });
});

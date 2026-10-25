// @vitest-environment jsdom
// GATE_NEW_CALLER_BOOKING: a visit booked by address (no customer yet) offers Link customer on the
// visit sheet. Staff search Customers, pick the caller and link; the confirmation text goes out
// unless they untick it. Gate off, a technician login, or a visit that has a customer: no panel.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MobileAppointmentDetailSheet from './MobileAppointmentDetailSheet';

vi.mock('./MobileCustomerDetailSheet', () => ({ default: () => null }));
vi.mock('./RainOutSheet', () => ({ default: () => null }));
vi.mock('./EstimateProvenanceCard', () => ({ default: () => null }));
vi.mock('../../lib/cardHoldCancel', () => ({ confirmCardHoldFeeChoice: vi.fn() }));
vi.mock('../../hooks/useCustomerCards', () => ({ useCustomerCards: () => ({ cards: null }) }));
vi.mock('./ScheduleSaveNotice', () => ({ showScheduleSaveNotice: vi.fn() }));
import { showScheduleSaveNotice } from './ScheduleSaveNotice';

const VISIT = {
  id: 'svc-nc', status: 'pending', serviceType: 'Waves Assessment', serviceTypeDisplay: 'Waves Assessment',
  estimatedPrice: 0, scheduledDate: '2031-03-07', windowStart: '13:00:00', windowEnd: '13:30:00', estimatedDuration: 30,
  customerId: null, customerName: 'New caller', awaitingCustomerLink: true,
};
const PAT = { id: 'cust-pat', firstName: 'Pat', lastName: 'Example', phone: '(941) 555-0199', address: '100 Example Way' };
const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });

let linkResponse;
beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
  linkResponse = json({ ok: true, id: 'svc-nc', customerId: 'cust-pat', addedProperty: true, confirmationSent: true, warning: null });
  global.fetch = vi.fn(async (input, options = {}) => {
    const url = String(input);
    if (url.includes('/admin/customers?search=')) return json({ customers: [PAT] });
    if (url.endsWith('/admin/schedule/new-caller/svc-nc/link') && options.method === 'PUT') return linkResponse;
    return json({});
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const linkCalls = () => global.fetch.mock.calls.filter(([u, o]) => String(u).endsWith('/new-caller/svc-nc/link') && o?.method === 'PUT');

async function pickPat() {
  fireEvent.click(screen.getByRole('button', { name: 'Link customer' }));
  fireEvent.change(screen.getByLabelText('Search customers'), { target: { value: 'Pat' } });
  fireEvent.click(await screen.findByRole('button', { name: /Pat Example/ }));
}

describe('Link customer on a visit booked by address', () => {
  it('finds the caller, links the visit with the confirmation text, and hands the result back', async () => {
    const onCustomerLinked = vi.fn();
    render(<MobileAppointmentDetailSheet service={VISIT} onClose={() => {}} newCallerBooking onCustomerLinked={onCustomerLinked} />);
    await pickPat();
    expect(screen.getByLabelText('Send the confirmation text')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Link to Pat Example' }));
    await waitFor(() => expect(onCustomerLinked).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-pat' })));
    expect(JSON.parse(linkCalls()[0][1].body)).toEqual({ customerId: 'cust-pat', sendConfirmation: true });
    expect(global.fetch.mock.calls.some(([u]) => String(u).includes('/admin/customers?search=Pat&limit=10'))).toBe(true);
    expect(showScheduleSaveNotice).not.toHaveBeenCalled();
  });

  it('an unticked confirmation links without the text; a warning from the server is shown', async () => {
    linkResponse = json({ ok: true, id: 'svc-nc', customerId: 'cust-pat', confirmationSent: false, warning: 'The visit is linked, but its reminders or confirmation did not go out. Check the visit.' });
    render(<MobileAppointmentDetailSheet service={VISIT} onClose={() => {}} newCallerBooking onCustomerLinked={vi.fn()} />);
    await pickPat();
    fireEvent.click(screen.getByLabelText('Send the confirmation text'));
    fireEvent.click(screen.getByRole('button', { name: 'Link to Pat Example' }));
    await waitFor(() => expect(linkCalls()).toHaveLength(1));
    expect(JSON.parse(linkCalls()[0][1].body).sendConfirmation).toBe(false);
    await waitFor(() => expect(showScheduleSaveNotice).toHaveBeenCalledWith(expect.stringMatching(/did not go out/)));
  });

  it('a refused link shows the server message and keeps the sheet open', async () => {
    linkResponse = json({ error: 'This visit already has a customer, or it was cancelled.' }, { ok: false, status: 409 });
    const onCustomerLinked = vi.fn();
    render(<MobileAppointmentDetailSheet service={VISIT} onClose={() => {}} newCallerBooking onCustomerLinked={onCustomerLinked} />);
    await pickPat();
    fireEvent.click(screen.getByRole('button', { name: 'Link to Pat Example' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This visit already has a customer, or it was cancelled.');
    expect(onCustomerLinked).not.toHaveBeenCalled();
  });

  it('no panel with the gate off, for a technician login, or once the visit has a customer', () => {
    const { rerender } = render(<MobileAppointmentDetailSheet service={VISIT} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Link customer' })).toBeNull();
    rerender(<MobileAppointmentDetailSheet service={VISIT} onClose={() => {}} newCallerBooking adminActions={false} />);
    expect(screen.queryByRole('button', { name: 'Link customer' })).toBeNull();
    rerender(<MobileAppointmentDetailSheet service={{ ...VISIT, customerId: 'cust-pat', customerName: 'Pat Example', awaitingCustomerLink: false }} onClose={() => {}} newCallerBooking />);
    expect(screen.queryByRole('button', { name: 'Link customer' })).toBeNull();
  });
});

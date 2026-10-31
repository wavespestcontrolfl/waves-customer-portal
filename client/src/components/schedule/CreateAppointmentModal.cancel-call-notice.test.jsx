// @vitest-environment jsdom
/**
 * "Canceled on a call" on New Appointment (GATE_CALL_CANCEL_GUARD). 2026-10-30: a caller canceled at 7:08 AM while
 * nothing was booked, and the office booked her at 11:22 from this form, which showed nothing about it. The notice
 * renders under the chosen customer only when the route answers {enabled:true, call}; a dark gate or a failed probe
 * renders nothing; and it never stops the save.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDiscountStackingState } from '../../hooks/useDiscountStacking';
vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: true, known: true })),
}));
import CreateAppointmentModal from './CreateAppointmentModal.jsx';

afterEach(() => {
  cleanup();
  vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: false, known: true, retry: vi.fn() });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: vi.fn(async () => body) });
const CUSTOMER = { id: 'customer-a', firstName: 'Pat', lastName: 'Sampleton' };
const CANCEL = { callId: 'call-cancel-1', at: '2026-10-30T11:08:00.000Z', summary: 'Pat called to cancel the visit for this afternoon.' };

function futureDate(days = 30) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

function installFetch({ probe = { enabled: true, call: CANCEL }, probeFails = false } = {}) {
  const fetcher = vi.fn((input, options = {}) => {
    const url = String(input);
    if (url.includes('/cancel-call-notice')) return probeFails ? Promise.reject(new Error('boom')) : Promise.resolve(json(probe));
    if (url.includes('/admin/triage?')) return Promise.resolve(json({ items: [] }));
    if (url.includes('/admin/services?')) {
      return Promise.resolve(json({ services: [{ id: 'svc-1', service_key: 'one_time_pest_control', name: 'One-Time Pest Control Service', billing_type: 'one_time', base_price: 250, default_duration_minutes: 60 }] }));
    }
    if (url.endsWith('/admin/schedule') && options.method === 'POST') return Promise.resolve(json({ id: 'appt-1' }));
    if (url.includes('/properties?context=appointment_address')) return Promise.resolve(json({ properties: [], canChangeAppointmentAddress: false }));
    if (url.includes('/schedule-estimates')) return Promise.resolve(json({ estimates: [] }));
    if (url.endsWith('/admin/technicians')) return Promise.resolve(json({ technicians: [] }));
    if (url.endsWith('/admin/discounts')) return Promise.resolve(json([]));
    if (url.endsWith('/annual-prepay-availability')) return Promise.resolve(json({ enabled: false }));
    if (url.endsWith('/card-request-availability')) return Promise.resolve(json({ enabled: false }));
    if (url.endsWith('/admin/dispatch/slot-check')) return Promise.resolve(json({ ok: true, results: [{ conflicts: [] }] }));
    if (url.includes('/admin/schedule/find-time')) return Promise.resolve(json({ gated: true }));
    if (url.endsWith('/admin/schedule/preview') && options.method === 'POST') {
      const groups = JSON.parse(options.body || '{}').groups || [];
      return Promise.resolve(json({ regime: true, results: groups.map((g) => ({ key: g.key })) }));
    }
    throw new Error(`Unhandled fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function mount() {
  render(<CreateAppointmentModal
    defaultCustomer={CUSTOMER}
    defaultDate={futureDate()}
    defaultWindowStart="09:00"
    onClose={vi.fn()}
    onCreated={vi.fn()}
    onChange={vi.fn()}
  />);
}

const probeCalls = (fetcher) => fetcher.mock.calls.filter(([u]) => String(u).includes('/cancel-call-notice'));
const schedulePosts = (fetcher) => fetcher.mock.calls.filter(([u, o]) => String(u).endsWith('/admin/schedule') && o?.method === 'POST');

describe('Canceled on a call notice', () => {
  it('shows the cancel call time, its summary and a link to the call under the chosen customer', async () => {
    const fetcher = installFetch();
    mount();
    const notice = await screen.findByTestId('cancel-call-notice');
    expect(notice.textContent).toContain('Canceled on a call · Fri, Oct 30, 7:08 AM');
    expect(notice.textContent).toContain('Pat called to cancel the visit for this afternoon.');
    expect(notice.textContent).toContain('You can still book. Check with the customer first.');
    expect(screen.getByRole('link', { name: 'Open the call' }).getAttribute('href')).toBe('/admin/communications#tab=calls&call=call-cancel-1');
    expect(probeCalls(fetcher)[0][0]).toContain('customerId=customer-a');
  });

  it('is absent when the gate is dark ({enabled:false})', async () => {
    const fetcher = installFetch({ probe: { enabled: false, call: null } });
    mount();
    await waitFor(() => expect(probeCalls(fetcher)).toHaveLength(1));
    await screen.findByRole('button', { name: 'Schedule appointment' });
    expect(screen.queryByTestId('cancel-call-notice')).toBeNull();
  });

  it('is absent when the probe fails', async () => {
    const fetcher = installFetch({ probeFails: true });
    mount();
    await waitFor(() => expect(probeCalls(fetcher)).toHaveLength(1));
    await screen.findByRole('button', { name: 'Schedule appointment' });
    expect(screen.queryByTestId('cancel-call-notice')).toBeNull();
  });

  it('never stops the save: the booking posts with the notice on screen', async () => {
    const fetcher = installFetch();
    mount();
    await screen.findByTestId('cancel-call-notice');
    fireEvent.change(screen.getByPlaceholderText('Search services'), { target: { value: 'One-Time' } });
    fireEvent.click(await screen.findByRole('button', { name: /One-Time Pest Control/i }));
    const submit = screen.getByRole('button', { name: 'Schedule appointment' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body)).not.toHaveProperty('cancelCall');
  });
});

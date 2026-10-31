// @vitest-environment jsdom
// New Appointment: the date, time, notes and technician controls carry their
// visible labels as accessible names, and the desktop close button is named
// "Close" (schedule audit S7).
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: true, known: true })),
}));
import CreateAppointmentModal from './CreateAppointmentModal.jsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: vi.fn(async () => body) });
const CUSTOMER = { id: 'customer-a', firstName: 'Ada', lastName: 'Lovelace' };

function futureDate(days = 30) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

function installFetch() {
  const fetcher = vi.fn((input) => {
    const url = String(input);
    if (url.includes('/admin/triage?')) return Promise.resolve(json({ items: [] }));
    if (url.includes('/admin/services?')) {
      return Promise.resolve(json({ services: [{ id: 'svc-1', service_key: 'pest_control_quarterly', name: 'Quarterly Pest Control', billing_type: 'one_time', base_price: 0, default_duration_minutes: 30 }] }));
    }
    if (url.includes('/properties?context=appointment_address')) return Promise.resolve(json({ properties: [], canChangeAppointmentAddress: false }));
    if (url.includes('/schedule-estimates')) return Promise.resolve(json({ estimates: [] }));
    if (url.endsWith('/admin/technicians')) return Promise.resolve(json({ technicians: [] }));
    if (url.endsWith('/admin/discounts')) return Promise.resolve(json([]));
    if (url.endsWith('/annual-prepay-availability')) return Promise.resolve(json({ enabled: false }));
    if (url.endsWith('/card-request-availability')) return Promise.resolve(json({ enabled: false }));
    if (url.endsWith('/admin/dispatch/slot-check')) return Promise.resolve(json({ ok: true, results: [{ conflicts: [] }] }));
    if (url.includes('/admin/schedule/find-time')) return Promise.resolve(json({ gated: true }));
    if (url.endsWith('/admin/schedule/preview')) return Promise.resolve(json({ regime: true, results: [] }));
    if (url.includes('/reservice-request-suggestion')) return Promise.resolve(json({ enabled: false, suggestion: null }));
    throw new Error(`Unhandled fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('New Appointment modal: accessible names', () => {
  it('names the date, time, notes, technician and close controls', async () => {
    installFetch();
    render(<CreateAppointmentModal
      defaultCustomer={CUSTOMER}
      defaultDate={futureDate()}
      defaultWindowStart="09:00"
      onClose={vi.fn()}
      onCreated={vi.fn()}
      onChange={vi.fn()}
    />);
    fireEvent.change(screen.getByPlaceholderText('Search services'), { target: { value: 'Quarterly' } });
    fireEvent.click(await screen.findByRole('button', { name: /Quarterly Pest Control/i }));
    await screen.findByRole('button', { name: 'Schedule appointment' });
    expect(screen.getByLabelText('Date')).toHaveProperty('type', 'date');
    expect(screen.getByLabelText('Time').tagName).toBe('SELECT');
    expect(screen.getByLabelText('Customer Notes').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('Internal Notes (Admin only)').tagName).toBe('TEXTAREA');
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Choose' }));
    expect(screen.getByRole('combobox', { name: 'Technician' })).toBeTruthy();
  });
});

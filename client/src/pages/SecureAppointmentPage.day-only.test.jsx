// @vitest-environment jsdom
// /secure/:token visit line. GATE_DAY_ONLY_PROMISE: a visit the customer was told only the day for shows the date and
// "Arrival window texted the day before" (the server sends no hour). Otherwise the hour the server built from
// window_start shows as before.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ token: 'a'.repeat(22) }),
  useSearchParams: () => [new URLSearchParams(''), vi.fn()],
}));
vi.mock('../lib/stripeLoader', () => ({
  loadStripeSdk: vi.fn(async () => () => ({
    elements: () => ({
      create: () => ({ mount: vi.fn(), update: vi.fn(), on: (event, cb) => { if (event === 'ready') queueMicrotask(cb); } }),
    }),
    retrieveSetupIntent: async () => ({ setupIntent: { status: 'requires_payment_method' } }),
    confirmSetup: async () => ({ setupIntent: { id: 'seti_after', status: 'succeeded' } }),
  })),
}));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QR') } }));
import SecureAppointmentPage from './SecureAppointmentPage';

const json = (body) => ({ ok: true, status: 200, json: async () => body });
const SECURED = { state: 'secured', firstName: 'Pat', serviceType: 'General Pest Control', dateDisplay: 'Tue, Nov 3', cancelFeeNote: null };

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('SecureAppointmentPage visit line', () => {
  it('day-only: the date and the arrival note, no hour', async () => {
    global.fetch.mockResolvedValue(json({ ...SECURED, windowDisplay: null, day_only: true, arrival_note: 'Arrival window texted the day before' }));
    render(<SecureAppointmentPage />);
    expect(await screen.findByText('General Pest Control · Tue, Nov 3 · Arrival window texted the day before')).toBeInTheDocument();
  });

  it('an hour the server sent still shows, and nothing is added without day_only', async () => {
    global.fetch.mockResolvedValue(json({ ...SECURED, windowDisplay: '9:00 AM - 11:00 AM' }));
    render(<SecureAppointmentPage />);
    expect(await screen.findByText('General Pest Control · Tue, Nov 3 · 9:00 AM - 11:00 AM')).toBeInTheDocument();
    expect(screen.queryByText(/texted the day before/)).not.toBeInTheDocument();
  });
});

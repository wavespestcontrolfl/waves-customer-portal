// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDiscountStackingState } from '../../hooks/useDiscountStacking';

vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: false, known: true })),
}));

import CreateAppointmentModal from './CreateAppointmentModal.jsx';

afterEach(() => {
  cleanup();
  vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: false, known: true, retry: vi.fn() });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (value, { ok = true, status = 200 } = {}) => ({ ok, status, json: vi.fn(async () => value) });
const setupFeeReview = {
  invoiceId: 'invoice-source-55',
  visitKey: 'opaque-visit-property-time-token',
  prepaidAmountCents: 5500,
  visitFeeCents: 7300,
};

function futureDate(days = 30) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function mount() {
  const posts = [];
  const fetcher = vi.fn(async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/admin/schedule') && options.method === 'POST') {
      posts.push(JSON.parse(options.body));
      if (posts.length === 1) {
        return json({
          code: 'COMMERCIAL_SETUP_VISIT_REVIEW',
          error: 'Choose which setup this prepayment covers.',
          setupFeeReview,
        }, { ok: false, status: 409 });
      }
      return json({ id: 'appointment-1' });
    }
    if (url.includes('/admin/services?')) {
      return json({ services: [{
        id: 'svc-rodent',
        service_key: 'commercial_rodent_bait',
        name: 'Commercial Rodent Bait Stations',
        billing_type: 'one_time',
        base_price: 73,
        default_duration_minutes: 60,
      }] });
    }
    if (url.includes('/admin/triage?')) return json({ items: [] });
    if (url.includes('/cancel-call-notice')) return json({ enabled: false, call: null });
    if (url.includes('/properties?context=appointment_address')) return json({ properties: [], canChangeAppointmentAddress: false });
    if (url.includes('/schedule-estimates')) return json({ estimates: [] });
    if (url.endsWith('/admin/technicians')) return json({ technicians: [] });
    if (url.endsWith('/admin/discounts')) return json([]);
    if (url.endsWith('/annual-prepay-availability')) return json({ enabled: false });
    if (url.endsWith('/card-request-availability')) return json({ enabled: false });
    if (url.endsWith('/admin/dispatch/slot-check')) return json({ ok: true, results: [{ conflicts: [] }] });
    if (url.includes('/admin/schedule/find-time')) return json({ gated: true });
    if (url.endsWith('/admin/schedule/preview') && options.method === 'POST') {
      const groups = JSON.parse(options.body || '{}').groups || [];
      return json({ regime: false, results: groups.map((group) => ({ key: group.key, price: group.expected_price })) });
    }
    throw new Error(`Unhandled fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const onCreated = vi.fn();
  render(<CreateAppointmentModal
    defaultCustomer={{ id: 'customer-a', firstName: 'Pat', lastName: 'Sampleton' }}
    defaultDate={futureDate()}
    defaultWindowStart="09:00"
    onClose={vi.fn()}
    onCreated={onCreated}
    onChange={vi.fn()}
  />);
  return { posts, onCreated };
}

it('requires an explicit choice and retries the exact new-booking payload with the opaque visit token', async () => {
  const { posts, onCreated } = mount();
  fireEvent.change(screen.getByPlaceholderText('Search services'), { target: { value: 'Commercial Rodent' } });
  fireEvent.click(await screen.findByRole('button', { name: /Commercial Rodent Bait Stations/i }));
  const submit = screen.getByRole('button', { name: 'Schedule appointment' });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);

  const reviewDialog = await screen.findByRole('dialog', { name: 'Choose how to handle this setup fee' });
  expect(reviewDialog).toHaveTextContent('$55.00');
  expect(reviewDialog).toHaveTextContent('$73.00');
  expect(posts).toHaveLength(1);
  expect(onCreated).not.toHaveBeenCalled();
  expect(posts[0]).not.toHaveProperty('commercialSetupDecision');
  fireEvent.click(screen.getByRole('button', { name: 'Apply $55.00 prepayment to this booking' }));

  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[1]).toEqual({
    ...posts[0],
    commercialSetupDecision: { ...setupFeeReview, resolution: 'covered' },
  });
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'appointment-1' })), { timeout: 3000 });
});

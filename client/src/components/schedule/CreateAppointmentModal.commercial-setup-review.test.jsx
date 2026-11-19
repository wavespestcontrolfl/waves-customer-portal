// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const freshSetupFeeReview = {
  invoiceId: 'invoice-source-89',
  visitKey: 'fresh-opaque-visit-property-time-token',
  prepaidAmountCents: 8900,
  visitFeeCents: 9700,
};
const defaultCatalog = [{
  id: 'svc-rodent',
  service_key: 'commercial_rodent_bait',
  name: 'Commercial Rodent Bait Stations',
  billing_type: 'one_time',
  base_price: 73,
  default_duration_minutes: 60,
}];
const quarterlyCatalog = [{
  id: 'svc-quarterly',
  service_key: 'pest_control_quarterly',
  name: 'Quarterly Pest Control',
  billing_type: 'recurring',
  frequency: 'quarterly',
  base_price: 100,
  default_duration_minutes: 30,
}];
const phoneVisit = {
  id: 'phone-visit-1',
  serviceType: 'Commercial Rodent Bait Stations',
  scheduledDate: futureDate(),
  windowStart: '09:00',
  status: 'confirmed',
};

function futureDate(days = 30) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function mount({ scheduleReply, catalog = defaultCatalog } = {}) {
  const posts = [];
  const fetcher = vi.fn(async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/admin/schedule') && options.method === 'POST') {
      posts.push(JSON.parse(options.body));
      if (scheduleReply) return scheduleReply({ body: posts.at(-1), count: posts.length });
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
      const query = (new URL(url, 'http://test').searchParams.get('search') || '').toLowerCase();
      return json({ services: catalog.filter((service) => service.name.toLowerCase().includes(query)) });
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

it('stops a stale choice without writing, then obtains fresh review after staff save the changed form', async () => {
  let resolveFirst;
  const firstReply = new Promise((resolve) => { resolveFirst = resolve; });
  const { posts, onCreated } = mount({
    scheduleReply: ({ count }) => {
      if (count === 1) return firstReply;
      if (count === 2) {
        return json({
          code: 'COMMERCIAL_SETUP_VISIT_REVIEW',
          error: 'Choose which setup this prepayment covers.',
          setupFeeReview: freshSetupFeeReview,
        }, { ok: false, status: 409 });
      }
      return json({ id: 'appointment-fresh' });
    },
  });
  fireEvent.change(screen.getByPlaceholderText('Search services'), { target: { value: 'Commercial Rodent' } });
  fireEvent.click(await screen.findByRole('button', { name: /Commercial Rodent Bait Stations/i }));
  const submit = screen.getByRole('button', { name: 'Schedule appointment' });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);
  await waitFor(() => expect(posts).toHaveLength(1));

  const changedDate = futureDate(45);
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: changedDate } });
  await act(async () => {
    resolveFirst(json({
      code: 'COMMERCIAL_SETUP_VISIT_REVIEW',
      error: 'Choose which setup this prepayment covers.',
      setupFeeReview,
    }, { ok: false, status: 409 }));
  });
  await screen.findByRole('dialog', { name: 'Choose how to handle this setup fee' });
  fireEvent.click(screen.getByRole('button', { name: 'Apply $55.00 prepayment to this booking' }));

  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose how to handle this setup fee' })).not.toBeInTheDocument());
  expect(posts).toHaveLength(1);
  expect(screen.getByText('The appointment changed. Review the updated booking and save again.')).toBeInTheDocument();
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);

  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[1].scheduledDate).toBe(changedDate);
  expect(posts[1]).not.toHaveProperty('commercialSetupDecision');
  await screen.findByRole('dialog', { name: 'Choose how to handle this setup fee' });
  expect(screen.getByRole('button', { name: 'Apply $89.00 prepayment to this booking' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Apply $89.00 prepayment to this booking' }));

  await waitFor(() => expect(posts).toHaveLength(3));
  expect(posts[2]).toEqual({
    ...posts[1],
    commercialSetupDecision: { ...freshSetupFeeReview, resolution: 'covered' },
  });
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'appointment-fresh' })), { timeout: 3000 });
});

it('stops before any retry POST when a pending review group changed cadence and no longer has the reviewed key', async () => {
  let resolveFirst;
  const firstReply = new Promise((resolve) => { resolveFirst = resolve; });
  const { posts } = mount({
    catalog: quarterlyCatalog,
    scheduleReply: ({ count }) => count === 1 ? firstReply : json({ id: 'must-not-post' }),
  });
  fireEvent.change(screen.getByPlaceholderText('Search services'), { target: { value: 'Quarterly' } });
  fireEvent.click(await screen.findByRole('button', { name: /Quarterly Pest Control/ }));
  const submit = screen.getByRole('button', { name: 'Schedule appointment' });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);
  await waitFor(() => expect(posts).toHaveLength(1));

  const cadence = screen.getByLabelText('Repeats for Quarterly Pest Control');
  expect(cadence).toHaveValue('quarterly');
  fireEvent.change(cadence, { target: { value: 'monthly' } });
  await act(async () => {
    resolveFirst(json({
      code: 'COMMERCIAL_SETUP_VISIT_REVIEW',
      error: 'Choose which setup this prepayment covers.',
      setupFeeReview,
    }, { ok: false, status: 409 }));
  });
  await screen.findByRole('dialog', { name: 'Choose how to handle this setup fee' });
  fireEvent.click(screen.getByRole('button', { name: 'Apply $55.00 prepayment to this booking' }));

  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose how to handle this setup fee' })).not.toBeInTheDocument());
  expect(posts).toHaveLength(1);
  expect(screen.getByText('The appointment changed. Review the updated booking and save again.')).toBeInTheDocument();
});

it('preserves the exact approved phone-booking ids through setup review for the same group', async () => {
  const { posts } = mount({
    scheduleReply: ({ count }) => {
      if (count === 1) {
        return json({
          code: 'duplicate_call_booking',
          error: 'The phone agent already booked this visit for this customer.',
          existingVisits: [phoneVisit],
        }, { ok: false, status: 409 });
      }
      if (count === 2) {
        return json({
          code: 'COMMERCIAL_SETUP_VISIT_REVIEW',
          error: 'Choose which setup this prepayment covers.',
          setupFeeReview,
        }, { ok: false, status: 409 });
      }
      return json({ id: 'appointment-with-both-approvals' });
    },
  });
  fireEvent.change(screen.getByPlaceholderText('Search services'), { target: { value: 'Commercial Rodent' } });
  fireEvent.click(await screen.findByRole('button', { name: /Commercial Rodent Bait Stations/i }));
  const submit = screen.getByRole('button', { name: 'Schedule appointment' });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);
  fireEvent.click(await screen.findByRole('button', { name: 'Book another anyway' }));

  await screen.findByRole('dialog', { name: 'Choose how to handle this setup fee' });
  expect(posts).toHaveLength(2);
  expect(posts[1]).toMatchObject({
    allowCallBookingDuplicate: true,
    callBookingReviewedIds: ['phone-visit-1'],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Apply $55.00 prepayment to this booking' }));

  await waitFor(() => expect(posts).toHaveLength(3));
  expect(posts[2]).toEqual({
    ...posts[1],
    commercialSetupDecision: { ...setupFeeReview, resolution: 'covered' },
  });
  expect(screen.queryByText('The appointment changed. Review the updated booking and save again.')).not.toBeInTheDocument();
});

it('keeps only the reviewed phone ids on setup retry so a newly found conflict prompts again', async () => {
  const newPhoneVisit = {
    id: 'phone-visit-2',
    serviceType: 'New Mosquito Visit',
    scheduledDate: futureDate(31),
    windowStart: '10:00',
    status: 'confirmed',
  };
  const { posts } = mount({
    scheduleReply: ({ count }) => {
      if (count === 1) {
        return json({
          code: 'duplicate_call_booking',
          error: 'The phone agent already booked this visit for this customer.',
          existingVisits: [phoneVisit],
        }, { ok: false, status: 409 });
      }
      if (count === 2) {
        return json({
          code: 'COMMERCIAL_SETUP_VISIT_REVIEW',
          error: 'Choose which setup this prepayment covers.',
          setupFeeReview,
        }, { ok: false, status: 409 });
      }
      return json({
        code: 'duplicate_call_booking',
        error: 'A new phone-agent booking appeared.',
        existingVisits: [phoneVisit, newPhoneVisit],
      }, { ok: false, status: 409 });
    },
  });
  fireEvent.change(screen.getByPlaceholderText('Search services'), { target: { value: 'Commercial Rodent' } });
  fireEvent.click(await screen.findByRole('button', { name: /Commercial Rodent Bait Stations/i }));
  const submit = screen.getByRole('button', { name: 'Schedule appointment' });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);
  fireEvent.click(await screen.findByRole('button', { name: 'Book another anyway' }));
  await screen.findByRole('dialog', { name: 'Choose how to handle this setup fee' });
  fireEvent.click(screen.getByRole('button', { name: 'Apply $55.00 prepayment to this booking' }));

  await waitFor(() => expect(posts).toHaveLength(3));
  expect(posts[2].callBookingReviewedIds).toEqual(['phone-visit-1']);
  expect(posts[2].commercialSetupDecision).toEqual({ ...setupFeeReview, resolution: 'covered' });
  expect(await screen.findByText(/New Mosquito Visit/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Book another anyway' })).toBeInTheDocument();
});

it('names groups already booked and scopes stopping to the remaining split booking', async () => {
  const catalog = [
    {
      id: 'svc-quarterly', service_key: 'pest_control_quarterly', name: 'Quarterly Pest Control',
      billing_type: 'recurring', frequency: 'quarterly', base_price: 100, default_duration_minutes: 30,
    },
    {
      id: 'svc-seasonal', service_key: 'mosquito_seasonal', name: 'Seasonal Mosquito Control',
      billing_type: 'recurring', frequency: 'seasonal_feb_oct', visits_per_year: 9, base_price: 80, default_duration_minutes: 30,
    },
  ];
  const { posts, onCreated } = mount({
    catalog,
    scheduleReply: ({ count }) => count === 1
      ? json({ id: 'appointment-quarterly' })
      : json({
        code: 'COMMERCIAL_SETUP_VISIT_REVIEW',
        error: 'Choose which setup this prepayment covers.',
        setupFeeReview,
      }, { ok: false, status: 409 }),
  });
  fireEvent.change(screen.getByPlaceholderText('Search services'), { target: { value: 'Quarterly' } });
  fireEvent.click(await screen.findByRole('button', { name: /Quarterly Pest Control/ }));
  fireEvent.click(screen.getByRole('button', { name: /Add service/ }));
  fireEvent.change(screen.getByPlaceholderText('Search to add service'), { target: { value: 'Seasonal' } });
  fireEvent.click(await screen.findByRole('button', { name: /Seasonal Mosquito Control/ }));
  const submit = screen.getByRole('button', { name: 'Schedule appointment' });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);

  const reviewDialog = await screen.findByRole('dialog', { name: 'Choose how to handle this setup fee' });
  expect(posts).toHaveLength(2);
  expect(reviewDialog).toHaveTextContent('These appointments are already booked: Quarterly: Quarterly Pest Control');
  expect(reviewDialog).toHaveTextContent('Remaining booking: Seasonal (Feb–Oct, monthly): Seasonal Mosquito Control');
  expect(reviewDialog).toHaveTextContent('Stopping here leaves the remaining booking unsaved');
  expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'appointment-quarterly' }), { background: true });
  fireEvent.click(screen.getByRole('button', { name: 'Stop — leave remaining booking unsaved' }));
  expect(screen.queryByRole('dialog', { name: 'Choose how to handle this setup fee' })).not.toBeInTheDocument();
  expect(posts).toHaveLength(2);
});

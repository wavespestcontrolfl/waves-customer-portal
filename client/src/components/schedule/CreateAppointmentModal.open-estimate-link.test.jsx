/**
 * Booking-win tracking (owner 2026-11-23): booking a visit for a customer who has an open estimate sent in the last
 * 60 days links that estimate by default, so the existing accept-on-book path records the win. Staff can press Clear.
 * No acceptance side effect lives here: the modal only sets sourceEstimateId, the server path is unchanged.
 */
// @vitest-environment jsdom
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { etDateString } from '../../lib/timezone';

vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: true, known: true })),
}));
import CreateAppointmentModal, { pickAutoScheduleEstimate } from './CreateAppointmentModal.jsx';
import { isRecentOpenEstimate, openEstimateLinkNotice, recentOpenEstimates } from './openEstimateLink.js';

const NOW = new Date('2026-11-23T15:00:00Z').getTime();
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();
const est = (over = {}) => ({ id: 'est-1', customerId: 'cust-1', status: 'sent', sentAt: daysAgo(10), linkedAppointment: null, ...over });

describe('isRecentOpenEstimate', () => {
  it('accepts a sent or viewed estimate this customer was sent in the last 60 days', () => {
    expect(isRecentOpenEstimate(est(), 'cust-1', NOW)).toBe(true);
    expect(isRecentOpenEstimate(est({ status: 'viewed', sentAt: daysAgo(60) }), 'cust-1', NOW)).toBe(true);
  });

  it('falls back to the created date when no sent date came back', () => {
    expect(isRecentOpenEstimate(est({ sentAt: null, createdAt: daysAgo(5) }), 'cust-1', NOW)).toBe(true);
  });

  it('rejects an estimate older than 60 days', () => {
    expect(isRecentOpenEstimate(est({ sentAt: daysAgo(61) }), 'cust-1', NOW)).toBe(false);
  });

  it('rejects an already accepted, expired or declined estimate', () => {
    for (const status of ['accepted', 'expired', 'declined', 'draft']) {
      expect(isRecentOpenEstimate(est({ status }), 'cust-1', NOW)).toBe(false);
    }
  });

  it('rejects an estimate already tied to a visit, one owned by someone else, one with no owner and one with no date', () => {
    expect(isRecentOpenEstimate(est({ linkedAppointment: { id: 's1' } }), 'cust-1', NOW)).toBe(false);
    expect(isRecentOpenEstimate(est({ customerId: 'cust-2' }), 'cust-1', NOW)).toBe(false);
    expect(isRecentOpenEstimate(est({ customerId: null }), 'cust-1', NOW)).toBe(false);
    expect(isRecentOpenEstimate(est({ sentAt: null }), 'cust-1', NOW)).toBe(false);
    expect(isRecentOpenEstimate(est(), null, NOW)).toBe(false);
  });
});

describe('pickAutoScheduleEstimate with an open estimate', () => {
  const base = { customerId: 'cust-1', nowMs: NOW };

  it('links exactly one recent open estimate by default', () => {
    const e = est();
    expect(pickAutoScheduleEstimate({ ...base, estimates: [e] })).toEqual({ estimate: e, key: 'cust-1:est-1' });
  });

  it('does not link when there is none, when it is too old, or when two are open', () => {
    expect(pickAutoScheduleEstimate({ ...base, estimates: [] })).toBeNull();
    expect(pickAutoScheduleEstimate({ ...base, estimates: [est({ sentAt: daysAgo(90) })] })).toBeNull();
    expect(pickAutoScheduleEstimate({ ...base, estimates: [est(), est({ id: 'est-2' })] })).toBeNull();
  });

  it('does not link once staff already added services, or after the same estimate was applied once', () => {
    expect(pickAutoScheduleEstimate({ ...base, estimates: [est()], serviceCount: 1 })).toBeNull();
    expect(pickAutoScheduleEstimate({ ...base, estimates: [est()], appliedKey: 'cust-1:est-1' })).toBeNull();
  });

  it('an accepted estimate keeps priority over an open one', () => {
    const accepted = est({ id: 'est-9', status: 'accepted', sentAt: daysAgo(100) });
    expect(pickAutoScheduleEstimate({ ...base, estimates: [est(), accepted] }).estimate.id).toBe('est-9');
  });
});

describe('openEstimateLinkNotice', () => {
  it('says the estimate is linked and counts as won, with how to undo it', () => {
    const e = est({ sentAt: '2026-11-13T15:00:00Z' });
    expect(openEstimateLinkNotice({ estimates: [e], linkedEstimate: e, customerId: 'cust-1', nowMs: NOW }))
      .toBe('This customer has an open estimate from Nov 13. It is linked so this booking counts as won. Press Clear to book without it.');
  });

  it('after Clear it asks staff to pick the estimate from the list', () => {
    const e = est({ sentAt: '2026-11-13T15:00:00Z' });
    expect(openEstimateLinkNotice({ estimates: [e], linkedEstimate: null, customerId: 'cust-1', nowMs: NOW }))
      .toBe('This customer has an open estimate from Nov 13. Pick it above so this booking counts as won.');
  });

  it('with two open estimates it asks staff to pick the one the customer said yes to', () => {
    const list = [est({ sentAt: '2026-11-13T15:00:00Z' }), est({ id: 'est-2', sentAt: '2026-11-01T15:00:00Z' })];
    expect(openEstimateLinkNotice({ estimates: list, customerId: 'cust-1', nowMs: NOW }))
      .toBe('This customer has 2 open estimates (newest from Nov 13). Pick the one they said yes to so this booking counts as won.');
    expect(recentOpenEstimates(list, 'cust-1', NOW)[0].id).toBe('est-1');
  });

  it('is silent for no estimate, an accepted one or an old one', () => {
    expect(openEstimateLinkNotice({ estimates: [], customerId: 'cust-1', nowMs: NOW })).toBeNull();
    expect(openEstimateLinkNotice({ estimates: [est({ status: 'accepted' })], customerId: 'cust-1', nowMs: NOW })).toBeNull();
    const old = est({ sentAt: daysAgo(80) });
    expect(openEstimateLinkNotice({ estimates: [old], linkedEstimate: old, customerId: 'cust-1', nowMs: NOW })).toBeNull();
  });
});

describe('the New Appointment form for a customer with an open estimate', () => {
  const CUSTOMER = { id: 'cust-1', firstName: 'Pat', lastName: 'Sampleton', phone: '9415550100', address: '12 Test Lane', city: 'Bradenton', zip: '34205' };
  const quote = (over = {}) => ({
    id: 'est-1', customerId: 'cust-1', status: 'sent', sentAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    annualTotal: 472, monthlyTotal: 39.33, prepay: { eligible: false },
    lines: [{ name: 'Quarterly Pest Control', serviceKey: null, serviceId: null, price: 118, cadence: 'quarterly', duration: 30 }],
    ...over,
  });
  let estimates;
  beforeEach(() => {
    estimates = [quote()];
    vi.stubGlobal('fetch', vi.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes('/schedule-estimates') ? { estimates } : {}),
    })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const openForm = () => render(
    <MemoryRouter>
      <CreateAppointmentModal defaultCustomer={CUSTOMER} defaultDate={etDateString()} defaultWindowStart="09:00" onClose={vi.fn()} onCreated={vi.fn()} />
    </MemoryRouter>,
  );

  it('links the open estimate by default and tells staff it counts as won', async () => {
    openForm();
    expect(await screen.findByText(/It is linked so this booking counts as won/)).toBeTruthy();
    expect(await screen.findByText(/saving marks it accepted and links it/)).toBeTruthy();
    expect(document.querySelector('option[value="est-1"]').closest('select').value).toBe('est-1');
  });

  it('Clear unlinks it and the notice asks staff to pick it instead', async () => {
    openForm();
    await screen.findByText(/It is linked so this booking counts as won/);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(await screen.findByText(/Pick it above so this booking counts as won/)).toBeTruthy();
    await waitFor(() => expect(document.querySelector('option[value="est-1"]').closest('select').value).toBe(''));
  });

  it('links nothing and shows no notice when the open estimate is older than 60 days', async () => {
    estimates = [quote({ sentAt: new Date(Date.now() - 90 * 86400000).toISOString() })];
    openForm();
    await waitFor(() => expect(document.querySelector('option[value="est-1"]')).not.toBeNull());
    expect(document.querySelector('option[value="est-1"]').closest('select').value).toBe('');
    expect(screen.queryByTestId('open-estimate-link-notice')).toBeNull();
  });
});

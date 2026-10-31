/**
 * GATE_CALL_PREPAY_CHOICE (owner 2026-10-29): Book it on a held call where the caller chose annual prepay opens the New
 * appointment form with "Annual prepay" preselected, but only for an open quote the SERVER marks prepay-eligible. The save
 * still goes through decideAnnualPrepayAttachment, and the server enforces eligibility and pricing again.
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
import CreateAppointmentModal, { preselectAnnualPrepay, decideAnnualPrepayAttachment } from './CreateAppointmentModal.jsx';

const open = { id: 'est-1', status: 'sent', prepay: { eligible: true, invoiceTotal: 472 } };

describe('preselectAnnualPrepay', () => {
  it('preselects annual prepay for an open, prepay-eligible quote when the caller chose it', () => {
    expect(preselectAnnualPrepay({ preferAnnualPrepay: true, linkedEstimate: open })).toBe(true);
    expect(preselectAnnualPrepay({ preferAnnualPrepay: true, linkedEstimate: { ...open, status: 'viewed' } })).toBe(true);
  });

  it('stays Standard when nobody asked for it, whatever the quote', () => {
    expect(preselectAnnualPrepay({ preferAnnualPrepay: false, linkedEstimate: open })).toBe(false);
    expect(preselectAnnualPrepay({ linkedEstimate: open })).toBe(false);
  });

  it('stays Standard with no quote, an accepted quote, or a quote the server says is not eligible', () => {
    expect(preselectAnnualPrepay({ preferAnnualPrepay: true, linkedEstimate: null })).toBe(false);
    expect(preselectAnnualPrepay({ preferAnnualPrepay: true, linkedEstimate: { ...open, status: 'accepted' } })).toBe(false);
    expect(preselectAnnualPrepay({ preferAnnualPrepay: true, linkedEstimate: { ...open, prepay: { eligible: false } } })).toBe(false);
    expect(preselectAnnualPrepay({ preferAnnualPrepay: true, linkedEstimate: { ...open, prepay: undefined } })).toBe(false);
  });

  it('a preselected choice still rides the unchanged attach rule: only a recurring, add-on-free group on the quoted cadence books prepay_annual', () => {
    const group = { cadence: 'quarterly', intervalDays: null };
    const base = { billAsAnnualPrepay: preselectAnnualPrepay({ preferAnnualPrepay: true, linkedEstimate: open }), prepayAttachedThisSubmit: false, noExtras: true, groupHasBoosters: false, group, linkedEstimate: open };
    expect(decideAnnualPrepayAttachment({ ...base, isRecurring: true })).toEqual({ attach: true, billingTerm: 'prepay_annual' });
    expect(decideAnnualPrepayAttachment({ ...base, isRecurring: false })).toEqual({ attach: false, billingTerm: undefined });
    expect(decideAnnualPrepayAttachment({ ...base, isRecurring: true, noExtras: false })).toEqual({ attach: false, billingTerm: undefined });
  });
});

// The form itself: Book it on a held call opens it on the customer (no quote pinned: an open quote is picked on purpose,
// because saving marks it accepted). Once the quote is picked, Annual prepay is already selected when the caller chose it.
describe('the form opened from Book it on a call where the caller chose annual prepay', () => {
  const CUSTOMER = { id: 'cust-1', firstName: 'Pat', lastName: 'Sampleton', phone: '9415550100', address: '12 Test Lane', city: 'Bradenton', zip: '34205' };
  const quote = (over = {}) => ({
    id: 'est-1', customerId: 'cust-1', status: 'sent', annualTotal: 472, monthlyTotal: 39.33,
    prepay: { eligible: true, invoiceTotal: 472 },
    lines: [{ name: 'Quarterly Pest Control', serviceKey: null, serviceId: null, price: 118, cadence: 'quarterly', duration: 30 }],
    ...over,
  });
  const PREPAY_NOTE = /Creates a pending annual prepay invoice/;
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

  const open = (props = {}) => render(
    <MemoryRouter>
      <CreateAppointmentModal defaultCustomer={CUSTOMER} defaultDate={etDateString()} defaultWindowStart="09:00" onClose={vi.fn()} onCreated={vi.fn()} {...props} />
    </MemoryRouter>,
  );
  async function pickQuote(id = 'est-1') {
    await waitFor(() => expect(document.querySelector(`option[value="${id}"]`)).not.toBeNull());
    fireEvent.change(document.querySelector(`option[value="${id}"]`).closest('select'), { target: { value: id } });
  }

  it('annual prepay is already selected once the eligible open quote is picked', async () => {
    open({ defaultAnnualPrepay: true });
    await pickQuote();
    expect(await screen.findByText(PREPAY_NOTE)).toBeTruthy();
  });

  it('without the choice, the same quote opens on Standard (byte-identical to before)', async () => {
    open();
    await pickQuote();
    expect(await screen.findByRole('button', { name: /Annual prepay/ })).toBeTruthy();
    expect(screen.queryByText(PREPAY_NOTE)).toBeNull();
  });

  it('a quote the server says is not prepay-eligible stays Standard and offers no annual prepay', async () => {
    estimates = [quote({ prepay: { eligible: false } })];
    open({ defaultAnnualPrepay: true });
    await pickQuote();
    await screen.findByText(/Prices filled from the quote/);
    expect(screen.queryByText(PREPAY_NOTE)).toBeNull();
    expect(screen.queryByRole('button', { name: /Annual prepay/ })).toBeNull();
  });

  it('the office can still switch to Standard', async () => {
    open({ defaultAnnualPrepay: true });
    await pickQuote();
    await screen.findByText(PREPAY_NOTE);
    fireEvent.click(screen.getByRole('button', { name: 'Standard' }));
    await waitFor(() => expect(screen.queryByText(PREPAY_NOTE)).toBeNull());
  });
});

// @vitest-environment jsdom
// Pins the C1 cancel flow: three screens, equal-size cancel/alternative
// buttons on every screen, facts only from the server `impact`, the card
// path, the hard-stop skip, the accept path (no cancel performed), and the
// gate-off fallback to the H0 form.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/api', () => {
  const target = {};
  const proxy = new Proxy(target, {
    get: (obj, prop) => {
      if (typeof prop !== 'string') return obj[prop];
      if (!(prop in obj)) obj[prop] = vi.fn(() => new Promise(() => {}));
      return obj[prop];
    },
    set: (obj, prop, value) => { obj[prop] = value; return true; },
  });
  return { default: proxy };
});
vi.mock('../brand/CustomerDialogHost', () => ({ showCustomerAlert: vi.fn(), showCustomerConfirm: vi.fn() }));

import api from '../../utils/api';
import CancelFlow from './CancelFlow';

const styles = {
  muted: '#475569',
  subtle: '#FAF8F3',
  primaryButton: { background: '#04395E', color: '#fff', minHeight: 40, fontSize: 14 },
  secondaryButton: { background: '#fff', color: '#04395E', minHeight: 40, fontSize: 14 },
  smallLinkButton: { background: 'transparent', fontSize: 12 },
};

const TWO_FAMILIES = [
  { key: 'pest_control', label: 'Pest Control', monthlyRate: 49, perAppRate: 147, upcomingVisits: 1, nextVisitDate: '2026-09-05', prepay: null },
  { key: 'lawn_care', label: 'Lawn Care', monthlyRate: 89, perAppRate: 129, upcomingVisits: 2, nextVisitDate: '2026-09-12', prepay: null },
];

const impact = (over = {}) => ({
  families: TWO_FAMILIES,
  tierBefore: 'Silver', tierAfter: null, tierDiscountBefore: 10, tierDiscountAfter: 0,
  accountMonthlyBefore: 138, accountMonthlyAfter: 0,
  remaining: [],
  visitsCancelled: 3, nextVisitCancelled: '2026-09-05',
  lateCancelFee: 0, openBalance: 0, payUrl: null, prepay: null,
  autopayOn: true, termiteRental: false, effectiveDate: '2026-08-31', billingMode: 'monthly',
  ...over,
});

const renderFlow = (props = {}) => render(<CancelFlow tierName="Silver" styles={styles} compact={false} onOpenRequest={() => {}} {...props} />);

// Both buttons of a pair must share the same box — neither is the "small" one.
const expectEqualPair = (a, b) => {
  expect(a.style.minHeight).toBe('44px');
  expect(b.style.minHeight).toBe(a.style.minHeight);
  expect(b.style.fontSize).toBe(a.style.fontSize);
  expect(b.style.flex).toBe(a.style.flex);
};

const openReview = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  return screen.findByRole('heading', { name: /review cancelling my plan/i });
};

beforeEach(() => {
  vi.clearAllMocks();
  api.cancelResolutionPreview.mockResolvedValue({ kind: 'none', reasonCode: null, scope: [], impact: impact() });
  api.createRequest.mockResolvedValue({ success: true, cancellation: { processed: true, confirmation: 'sms', confirmationChannels: ['sms', 'email'], effectiveDate: '2026-08-31' } });
});
afterEach(cleanup);

describe('Screen 1 — review', () => {
  it('renders only server-supplied facts and equal-size Keep / Continue buttons', async () => {
    renderFlow();
    await openReview();

    expect(api.cancelResolutionPreview).toHaveBeenCalledWith({});
    expect(screen.getByText('Pest Control and Lawn Care → None')).toBeInTheDocument();
    expect(screen.getByText('WaveGuard Silver (10% off) → No plan')).toBeInTheDocument();
    expect(screen.getByText('$138.00 → $0.00')).toBeInTheDocument();
    expect(screen.getByText('3 (next: Sep 5, 2026)')).toBeInTheDocument();
    expect(screen.getByText('Turns off')).toBeInTheDocument();
    expect(screen.getByText('Aug 31, 2026')).toBeInTheDocument();
    // Fields the server left empty never render a row.
    expect(screen.queryByText(/outstanding balance/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/scheduled-visit fee/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/prepaid/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/termite/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/pause/i)).not.toBeInTheDocument();

    expectEqualPair(screen.getByRole('button', { name: 'Keep my plan' }), screen.getByRole('button', { name: 'Continue' }));
  });

  it('shows per-service checkboxes only with more than one family, and re-previews partial scope', async () => {
    renderFlow();
    await openReview();
    const lawn = screen.getByRole('checkbox', { name: /lawn care/i });
    expect(screen.getByRole('checkbox', { name: /pest control/i })).toBeChecked();

    api.cancelResolutionPreview.mockResolvedValue({
      kind: 'none', reasonCode: null, scope: ['pest_control'],
      impact: impact({ tierAfter: 'Bronze', tierDiscountAfter: 5, accountMonthlyAfter: 93.45, remaining: [{ key: 'lawn_care', label: 'Lawn Care', monthlyBefore: 89, monthlyAfter: 93.45 }], visitsCancelled: 1 }),
    });
    fireEvent.click(lawn);
    await waitFor(() => expect(api.cancelResolutionPreview).toHaveBeenLastCalledWith({ families: ['pest_control'] }));
    expect(await screen.findByRole('heading', { name: 'Review cancelling Pest Control' })).toBeInTheDocument();
    expect(screen.getByText('Lawn Care rate/mo')).toBeInTheDocument();
    expect(screen.getByText('$89.00 → $93.45')).toBeInTheDocument();
    expect(screen.getByText('Remains active for Lawn Care')).toBeInTheDocument();
  });

  it('scopedSupported:false blocks Continue for a partial selection only', async () => {
    renderFlow();
    await openReview();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();

    api.cancelResolutionPreview.mockResolvedValue({
      kind: 'none', reasonCode: null, scope: ['pest_control'],
      impact: impact({ scopedSupported: false }),
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /lawn care/i }));
    expect(await screen.findByText(/we can't price a partial cancellation for this plan online/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    // Back to whole account: the line clears and Continue re-enables.
    api.cancelResolutionPreview.mockResolvedValue({ kind: 'none', reasonCode: null, scope: [], impact: impact({ scopedSupported: false }) });
    fireEvent.click(screen.getByRole('checkbox', { name: /lawn care/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    expect(screen.queryByText(/partial cancellation for this plan online/i)).not.toBeInTheDocument();
  });

  it('hides the scope picker for a single-family account', async () => {
    api.cancelResolutionPreview.mockResolvedValue({ kind: 'none', reasonCode: null, scope: [], impact: impact({ families: [TWO_FAMILIES[0]] }) });
    renderFlow();
    await openReview();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('routes the "instead" link to the existing request flow', async () => {
    const onOpenRequest = vi.fn();
    renderFlow({ onOpenRequest });
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: /report a problem instead/i }));
    expect(onOpenRequest).toHaveBeenCalledTimes(1);
  });
});

describe('Screen 2 — reason and resolution', () => {
  it('skips the preview call and the card when no reason is picked', async () => {
    renderFlow();
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: /what's driving this change/i });
    expectEqualPair(screen.getByRole('button', { name: 'Keep my plan' }), screen.getByRole('button', { name: 'Continue' }));

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Confirm cancelling my plan' });
    expect(api.cancelResolutionPreview).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/one option may fit better/i)).not.toBeInTheDocument();
  });

  it('hard_stop skips the card and shows one neutral line on the confirm screen', async () => {
    renderFlow();
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'More reasons' }));
    fireEvent.click(screen.getByRole('button', { name: 'Billing problem' }));
    api.cancelResolutionPreview.mockResolvedValue({ kind: 'hard_stop', reasonCode: 'billing_issue', reviewType: 'billing', scope: [], impact: impact() });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByRole('heading', { name: 'Confirm cancelling my plan' });
    expect(api.cancelResolutionPreview).toHaveBeenLastCalledWith({ reason: 'billing_issue' });
    expect(screen.getByText("We'll review this on our side; your cancellation still completes.")).toBeInTheDocument();
    expect(screen.queryByText(/one option may fit better/i)).not.toBeInTheDocument();
    expectEqualPair(screen.getByRole('button', { name: 'Keep my plan' }), screen.getByRole('button', { name: 'Cancel my plan' }));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel my plan' }));
    await screen.findByText(/your plan is cancelled as of Aug 31, 2026/i);
    expect(api.createRequest).toHaveBeenCalledWith(expect.objectContaining({
      category: 'cancellation', subject: 'Cancel WaveGuard Silver plan', reasonCode: 'billing_issue',
    }));
    expect(api.createRequest.mock.calls[0][0]).not.toHaveProperty('resolutionOutcome');
    expect(screen.getByText(/a confirmation text and email are on the way/i)).toBeInTheDocument();
  });

  it('card: Show me expands, Accept shows the receipt and never calls createRequest', async () => {
    renderFlow();
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Price' }));
    api.cancelResolutionPreview.mockResolvedValue({
      kind: 'card', reasonCode: 'price', scope: [], impact: impact(),
      card: { templateId: 'price_offer', headline: 'One offer, no strings', body: 'Stay and take 15% off your next two charges for Lawn Care.', action: { type: 'retention_offer', percentOff: 15, charges: 2, capAmount: 75, family: 'Lawn Care' } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByRole('heading', { name: /one option may fit better/i });
    expectEqualPair(screen.getByRole('button', { name: 'Show me' }), screen.getByRole('button', { name: 'Continue with cancellation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show me' }));

    expect(await screen.findByRole('heading', { name: 'One offer, no strings' })).toBeInTheDocument();
    const accept = screen.getByRole('button', { name: 'Keep Lawn Care with 15% off my next 2 charges' });
    expectEqualPair(accept, screen.getByRole('button', { name: 'Complete my cancellation' }));

    api.cancelResolutionAccept.mockResolvedValue({ ok: true, receipt: { reference: 'CR-1', actionType: 'retention_offer', summary: '15% off your next two Lawn Care charges is applied.', effects: ['Nothing else changes.'], confirmationChannels: ['email'] } });
    fireEvent.click(accept);

    await screen.findByRole('heading', { name: 'All set' });
    expect(api.cancelResolutionAccept).toHaveBeenCalledWith({ reasonCode: 'price', families: [], templateId: 'price_offer' });
    expect(screen.getByText('15% off your next two Lawn Care charges is applied.')).toBeInTheDocument();
    expect(screen.getByText('Nothing else changes.')).toBeInTheDocument();
    expect(screen.getByText(/reference CR-1\. a confirmation email is on its way/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to my plan' })).toBeInTheDocument();
    expect(api.createRequest).not.toHaveBeenCalled();
  });

  it('card: declining records resolutionOutcome=declined on the cancel request', async () => {
    renderFlow();
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Price' }));
    api.cancelResolutionPreview.mockResolvedValue({
      kind: 'card', reasonCode: 'price', scope: [], impact: impact(),
      card: { templateId: 'price_offer', headline: 'One offer, no strings', body: 'Offer body.', action: { type: 'retention_offer', percentOff: 15, charges: 2, capAmount: 75 } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with cancellation' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel my plan' }));
    await screen.findByText(/your plan is cancelled/i);
    expect(api.createRequest).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'price', resolutionTemplateId: 'price_offer', resolutionOutcome: 'declined' }));
  });

  it('set_preferences card sends preferredDay/preferredTime as params', async () => {
    renderFlow();
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Scheduling or communication' }));
    api.cancelResolutionPreview.mockResolvedValue({
      kind: 'card', reasonCode: 'scheduling_access_communication', scope: [], impact: impact(),
      card: { templateId: 'sched_prefs', headline: 'Pick days that work', body: 'Tell us what works.', action: { type: 'set_preferences' } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show me' }));
    // Selects carry the scheduler's canonical values, never free text.
    const daySelect = await screen.findByLabelText('Preferred day');
    expect(daySelect.tagName).toBe('SELECT');
    expect(Array.from(daySelect.options).map((o) => o.value)).toEqual(['', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
    const timeSelect = screen.getByLabelText('Preferred time');
    expect(timeSelect.tagName).toBe('SELECT');
    expect(Array.from(timeSelect.options).map((o) => o.value)).toEqual(['', 'early_morning', 'morning', 'midday', 'afternoon']);
    expect(screen.getByRole('option', { name: '1:00–5:00 PM' })).toBeInTheDocument();
    fireEvent.change(daySelect, { target: { value: 'friday' } });
    fireEvent.change(timeSelect, { target: { value: 'afternoon' } });
    api.cancelResolutionAccept.mockResolvedValue({ ok: true, receipt: { reference: 'CR-3', actionType: 'set_preferences', summary: 'Preferences updated.', effects: [], confirmationChannels: [] } });
    fireEvent.click(screen.getByRole('button', { name: 'Update my service days' }));
    await screen.findByRole('heading', { name: 'All set' });
    expect(api.cancelResolutionAccept).toHaveBeenCalledWith({
      reasonCode: 'scheduling_access_communication', families: [], templateId: 'sched_prefs',
      params: { preferredDay: 'friday', preferredTime: 'afternoon' },
    });
  });

  it('renders the re-service link when the receipt carries reserviceUrl', async () => {
    renderFlow();
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Results (pest)' }));
    api.cancelResolutionPreview.mockResolvedValue({
      kind: 'card', reasonCode: 'results_pest', scope: [], impact: impact(),
      card: { templateId: 'results_pest_fix_finding', headline: 'Let us fix it at no charge', body: 'Body.', action: { type: 'book_reservice', lane: 'pest' } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show me' }));
    api.cancelResolutionAccept.mockResolvedValue({ ok: true, receipt: { reference: 'CR-4', actionType: 'book_reservice', summary: 'Re-service booked.', effects: [], reserviceUrl: '/reschedule/tok-1', confirmationChannels: [] } });
    fireEvent.click(screen.getByRole('button', { name: 'Book the free re-service' }));
    await screen.findByRole('heading', { name: 'All set' });
    const link = screen.getByRole('link', { name: 'Pick your re-service time' });
    expect(link).toHaveAttribute('href', '/reschedule/tok-1');
    expect(api.createRequest).not.toHaveBeenCalled();
  });

  it('partial cancel outcome uses the server-scoped copy', async () => {
    renderFlow();
    await openReview();
    api.cancelResolutionPreview.mockResolvedValue({
      kind: 'none', reasonCode: null, scope: ['pest_control'],
      impact: impact({ tierAfter: 'Bronze', remaining: [{ key: 'lawn_care', label: 'Lawn Care', monthlyBefore: 89, monthlyAfter: 89 }] }),
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /lawn care/i }));
    await screen.findByRole('heading', { name: 'Review cancelling Pest Control' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: /what's driving this change/i });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    api.createRequest.mockResolvedValue({ success: true, cancellation: { processed: true, confirmation: null, confirmationChannels: [], effectiveDate: '2026-08-31', scope: ['pest_control'], remaining: ['lawn_care'], tierBefore: 'Silver', tierAfter: 'Bronze' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Pest Control' }));
    await screen.findByText(/pest control cancelled; lawn care continue under waveguard bronze/i);
    expect(api.createRequest).toHaveBeenCalledWith(expect.objectContaining({ families: ['pest_control'], subject: 'Cancel Pest Control (WaveGuard Silver)' }));
  });

  it('hold card asks for a resume date and sends it as params.resumeDate', async () => {
    renderFlow();
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Away part of the year' }));
    api.cancelResolutionPreview.mockResolvedValue({
      kind: 'card', reasonCode: 'away', scope: [], impact: impact(),
      card: { templateId: 'away_hold', headline: 'Hold your plan', body: 'Pick a date.', action: { type: 'hold', holdMaxDays: 180 } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show me' }));
    const date = await screen.findByLabelText(/resume service on/i);
    fireEvent.change(date, { target: { value: '2026-11-15' } });
    api.cancelResolutionAccept.mockResolvedValue({ ok: true, receipt: { reference: 'CR-2', actionType: 'hold', summary: 'On hold.', effects: [], confirmationChannels: [] } });
    fireEvent.click(screen.getByRole('button', { name: "Hold my plan until I'm back" }));
    await screen.findByRole('heading', { name: 'All set' });
    expect(api.cancelResolutionAccept).toHaveBeenCalledWith({ reasonCode: 'away', families: [], templateId: 'away_hold', params: { resumeDate: '2026-11-15' } });
  });
});

describe('gate off', () => {
  it('falls back to the H0 single-step form when the preview answers 404', async () => {
    api.cancelResolutionPreview.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('heading', { name: 'Cancel My Plan' });
    expect(screen.getByRole('button', { name: 'Switching providers' })).toBeInTheDocument();
    expectEqualPair(screen.getByRole('button', { name: 'Keep My Plan' }), screen.getByRole('button', { name: 'Cancel My Plan' }));

    fireEvent.click(screen.getByRole('button', { name: 'Cost' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel My Plan' }));
    await screen.findByText(/your plan is cancelled/i);
    expect(api.createRequest).toHaveBeenCalledWith({
      category: 'cancellation',
      subject: 'Cancel WaveGuard Silver plan',
      description: 'Customer requested cancellation. Reason: Cost. Details: None',
    });
  });
});

// @vitest-environment jsdom
// Customer 360 Moving card (GATE_MOVING_FLOW): hidden while the server says
// enabled:false, one plain status line for the newest move, and each button
// posts its own route on the staff click. Nothing sends on load.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  list: { enabled: true, moves: [], text: { phone: '+19415550100', hasTexts: true } },
  email: { ok: true, sent: true, reason: null },
  preview: null,
  apply: { ok: true, body: {} },
};
vi.mock('../../lib/adminFetch', () => ({
  adminFetch: vi.fn(async (url) => {
    if (url.endsWith('/moving-email')) return { ok: true, json: async () => state.email };
    if (url.endsWith('/moving-link')) return { ok: true, json: async () => ({ url: 'https://wvs.example/m/abc', moveId: 'move-1', status: 'open' }) };
    if (url.endsWith('/apply-preview')) return { ok: true, json: async () => state.preview };
    if (url.endsWith('/apply')) return { ok: state.apply.ok, status: state.apply.ok ? 200 : 409, json: async () => state.apply.body };
    return { ok: true, json: async () => state.list };
  }),
}));

import { adminFetch } from '../../lib/adminFetch';
import CustomerMovingCardV2, { applyPreviewLines, movePauseText, moveStatusText, textHref } from './CustomerMovingCardV2';

const CUSTOMER = '3f2b8c4e-9d1a-4f6b-8e2c-5a7d9b1c3e5f';

afterEach(() => cleanup());
beforeEach(() => {
  state.list = { enabled: true, moves: [], text: { phone: '+19415550100', hasTexts: true } };
  state.email = { ok: true, sent: true, reason: null };
  state.preview = null;
  state.apply = { ok: true, body: {} };
  adminFetch.mockClear();
});

describe('moveStatusText', () => {
  it('says where the newest move stands in plain words', () => {
    expect(moveStatusText(undefined)).toBe('No move yet');
    expect(moveStatusText({ status: 'open', link_sent_at: null })).toBe('Link made');
    expect(moveStatusText({ status: 'open', link_sent_at: '2026-11-02T15:00:00Z', link_channel: 'email' })).toBe('Link sent Nov 2 by email');
    expect(moveStatusText({
      status: 'submitted',
      submitted_at: '2026-11-03T15:00:00Z',
      typed_address: '12 Example Way',
      normalized_address: JSON.stringify({ city: 'Parrish' }),
      address_verdict: 'in_area',
      move_out_date: '2026-11-15',
      move_in_date: null,
    })).toBe('Submitted Nov 3: new home in Parrish, in our area, move-out Nov 15, move-in not known yet');
    expect(moveStatusText({ status: 'submitted', submitted_at: '2026-11-03T15:00:00Z', typed_address: null, move_out_date: '2026-11-15' }))
      .toBe('Submitted Nov 3: new address not known yet, move-out Nov 15, move-in not known yet');
    expect(moveStatusText({ status: 'closed', closed_reason: 'applied', applied_at: '2026-11-21T15:00:00Z' })).toBe('Move applied Nov 21');
    expect(moveStatusText({ status: 'closed', closed_reason: 'pause_expired', closed_at: '2027-01-15T15:20:00Z' }))
      .toBe('Pause ended Jan 15: no new address in 60 days');
  });
});

// Moving PR 2b (GATE_MOVING_PAUSE): the reminder text and the pause, under the status line.
describe('movePauseText', () => {
  const submitted = { status: 'submitted', move_out_date: '2026-11-15' };
  it('names the reminder outcome and the pause in plain words', () => {
    expect(movePauseText(undefined)).toBeNull();
    expect(movePauseText(submitted)).toBeNull();
    expect(movePauseText({ ...submitted, pause_reminder_at: '2026-11-08T15:20:00Z', pause_reminder_sent: true })).toBe('Reminder text sent Nov 8');
    expect(movePauseText({ ...submitted, pause_reminder_at: '2026-11-08T15:20:00Z', pause_reminder_sent: false })).toBe('Reminder text not sent (Nov 8)');
    expect(movePauseText({ ...submitted, pause_reminder_at: '2026-11-08T15:20:00Z', pause_reminder_sent: null })).toBe('Reminder text tried Nov 8, result unknown');
    expect(movePauseText({
      ...submitted, pause_reminder_at: '2026-11-08T15:20:00Z', pause_reminder_sent: true, pause_state: 'paused', pause_ends_on: '2027-01-14',
    })).toBe('Reminder text sent Nov 8. Visits paused after Nov 15, held until Jan 14');
    expect(movePauseText({ ...submitted, pause_state: 'office', pause_note: 'They prepay for the year, so the automatic pause skipped them. Pause their visits by hand.' }))
      .toBe('Pause left to the office: They prepay for the year, so the automatic pause skipped them. Pause their visits by hand.');
    expect(movePauseText({ ...submitted, paused_at: '2026-11-15T15:20:00Z' })).toBe('Pause started Nov 15, not finished yet');
    // A closed move has its own status line.
    expect(movePauseText({ status: 'closed', closed_reason: 'pause_expired', pause_state: 'paused' })).toBeNull();
  });
});

const PREVIEW = {
  moveId: 'move-apply',
  fromAddress: '1 Old Street, Bradenton, FL 34205',
  toAddress: '40 Sample Road, Venice, FL 34285',
  moveOutDate: '2026-11-20',
  moveInDate: '2026-11-25',
  primaryChange: true,
  newPlan: [{ name: 'Quarterly Pest Control Service', frequency: 'quarterly' }],
  stops: [
    { name: 'Quarterly Pest Control Service', frequency: 'quarterly', cancelCount: 2, firstCancelDate: '2026-12-01', keepCount: 1 },
    { name: 'Lawn Care', frequency: 'monthly', cancelCount: 0, firstCancelDate: null, keepCount: 0 },
  ],
  others: [],
  oneOffs: [{ id: 'v9', date: '2026-12-05', name: 'WDO Inspection' }],
  pastOpen: [{ id: 'v7', date: '2026-11-21', name: 'Lawn Care' }],
  stations: { count: 3, flagged: false },
  version: 'v-1',
};

describe('applyPreviewLines', () => {
  it('says what Apply move changes and what it leaves, in plain words', () => {
    expect(applyPreviewLines(PREVIEW)).toEqual([
      'The new home becomes the primary address: 40 Sample Road, Venice, FL 34285.',
      'New-home plan: Quarterly Pest Control Service (quarterly).',
      'Quarterly Pest Control Service (quarterly) at the old house stops after Nov 20: 2 visits from Dec 1 cancelled. 1 before move-out stay.',
      'Lawn Care (monthly) at the old house stops after Nov 20. No visit after move-out is booked.',
      'One-time visits at the old house after move-out stay booked: WDO Inspection Dec 5. Cancel them by hand if needed.',
      'Open visits at the old house dated after move-out but before today stay as they are: Lawn Care Nov 21. Complete or cancel them by hand.',
      'A task opens to pick up 3 rented termite stations after move-out.',
      'No text or email goes to the customer. No late-cancel fee.',
    ]);
    expect(applyPreviewLines({ ...PREVIEW, primaryChange: false, stops: [], oneOffs: [], pastOpen: [], stations: { count: 0, flagged: true } })).toEqual([
      'The new home is already the primary address: 40 Sample Road, Venice, FL 34285.',
      'New-home plan: Quarterly Pest Control Service (quarterly).',
      'A task opens to confirm and pick up the rented termite stations after move-out.',
      'No text or email goes to the customer. No late-cancel fee.',
    ]);
  });
});

describe('textHref', () => {
  it('opens the SMS thread when the customer has texts, else a new text to the phone', () => {
    expect(textHref(CUSTOMER, { hasTexts: true, phone: '+19415550100' })).toBe(`/admin/communications?thread=${CUSTOMER}#tab=sms`);
    expect(textHref(CUSTOMER, { hasTexts: false, phone: '+19415550100' })).toBe('/admin/communications?phone=%2B19415550100&action=sms#tab=sms');
    expect(textHref(CUSTOMER, { hasTexts: false, phone: null })).toBeNull();
    expect(textHref(CUSTOMER, null)).toBeNull();
  });
});

describe('CustomerMovingCardV2', () => {
  it('renders nothing while the server says enabled:false', async () => {
    state.list = { enabled: false, moves: [] };
    const { container } = render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the pause line under the status only when there is one', async () => {
    state.list = {
      enabled: true,
      moves: [{ id: 'm1', status: 'submitted', submitted_at: '2026-11-03T15:00:00Z', typed_address: null, move_out_date: '2026-11-15', pause_state: 'paused', pause_ends_on: '2027-01-14' }],
    };
    render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    expect(await screen.findByTestId('moving-pause')).toHaveTextContent('Visits paused after Nov 15, held until Jan 14');
    cleanup();
    state.list = { enabled: true, moves: [{ id: 'm1', status: 'submitted', submitted_at: '2026-11-03T15:00:00Z', typed_address: null, move_out_date: '2026-11-15' }] };
    render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    await screen.findByTestId('moving-status');
    expect(screen.queryByTestId('moving-pause')).toBeNull();
  });

  it('loads with one read and sends nothing until a click', async () => {
    render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    expect(await screen.findByTestId('moving-status')).toHaveTextContent('No move yet');
    expect(adminFetch).toHaveBeenCalledTimes(1);
    expect(adminFetch.mock.calls[0][0]).toBe(`/admin/customers/${CUSTOMER}/moves`);
    expect(screen.getByRole('link', { name: 'Text moving link' })).toHaveAttribute('href', `/admin/communications?thread=${CUSTOMER}#tab=sms`);
  });

  it('a customer with no texts gets a new text to their phone; no phone disables the button', async () => {
    state.list = { enabled: true, moves: [], text: { phone: '+19415550100', hasTexts: false } };
    const { unmount } = render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    expect(await screen.findByRole('link', { name: 'Text moving link' })).toHaveAttribute('href', '/admin/communications?phone=%2B19415550100&action=sms#tab=sms');
    unmount();
    state.list = { enabled: true, moves: [], text: { phone: null, hasTexts: false } };
    render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    expect(await screen.findByRole('button', { name: 'Text moving link' })).toBeDisabled();
  });

  it('new-home estimate: start, open and blocked each show their own control', async () => {
    const submitted = { status: 'submitted', typed_address: '12 Example Way', move_out_date: '2026-11-15', move_in_date: '2026-11-20', submitted_at: '2026-11-03T15:00:00Z' };
    state.list = {
      enabled: true,
      estimateEnabled: true,
      text: null,
      moves: [
        { ...submitted, id: 'move-start', new_home: { action: 'start', estimateId: null, reason: null } },
        { ...submitted, id: 'move-open', new_home: { action: 'open', estimateId: 'est-9', reason: null } },
        { ...submitted, id: 'move-blocked', new_home: { action: 'blocked', estimateId: null, reason: 'This customer prepaid for the year. Ask the owner.' } },
      ],
    };
    render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    expect(await screen.findByRole('link', { name: 'Estimate for new home' }))
      .toHaveAttribute('href', `/admin/estimates?tab=new&moveId=move-start&customerId=${CUSTOMER}`);
    expect(screen.getByRole('link', { name: 'Open new-home estimate' })).toHaveAttribute('href', '/admin/estimates?editEstimateId=est-9');
    expect(screen.getByText('This customer prepaid for the year. Ask the owner.')).toBeInTheDocument();
    expect(screen.getAllByTestId('new-home-action')).toHaveLength(3);
    // The blocked move has no button or link of its own.
    expect(screen.getAllByRole('link', { name: /new home|new-home/i })).toHaveLength(2);
  });

  it('shows nothing new when estimateEnabled is false', async () => {
    state.list = {
      enabled: true,
      estimateEnabled: false,
      text: null,
      moves: [{ id: 'move-start', status: 'submitted', new_home: { action: 'start', estimateId: null, reason: null } }],
    };
    render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    expect(await screen.findByTestId('moving-status')).toBeInTheDocument();
    expect(screen.queryByTestId('new-home-action')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Estimate for new home' })).toBeNull();
  });

  it('Email moving link posts the email route and reports the outcome', async () => {
    render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Email moving link' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Moving link emailed.');
    expect(adminFetch).toHaveBeenCalledWith(`/admin/customers/${CUSTOMER}/moving-email`, { method: 'POST', body: '{}' });
  });

  it('a skipped email says why in plain words', async () => {
    state.email = { ok: false, sent: false, reason: 'email_opted_out' };
    render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Email moving link' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Email not sent. This customer turned email off.');
  });

  it('Copy moving link falls back to a selectable box when the clipboard is blocked', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => { throw new Error('blocked'); }) } });
    render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy moving link' }));
    expect(await screen.findByLabelText('Moving link')).toHaveValue('https://wvs.example/m/abc');
    expect(adminFetch).toHaveBeenCalledWith(`/admin/customers/${CUSTOMER}/moving-link`, { method: 'POST', body: '{}' });
  });

  const applyMove = { id: 'move-apply', status: 'submitted', typed_address: '40 Sample Road', move_out_date: '2026-11-20', submitted_at: '2026-11-03T15:00:00Z' };

  it('Apply move: the preview comes first, and only the confirm posts the preview version', async () => {
    state.list = { enabled: true, applyEnabled: true, text: null, moves: [{ ...applyMove, apply: { action: 'review', reason: null } }] };
    state.preview = PREVIEW;
    state.apply = { ok: true, body: { applied: true, summary: 'New home is primary: 40 Sample Road, Venice, FL 34285.' } };
    render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply move' }));
    const preview = await screen.findByTestId('apply-move-preview');
    expect(preview).toHaveTextContent('The new home becomes the primary address: 40 Sample Road, Venice, FL 34285.');
    expect(preview).toHaveTextContent('No text or email goes to the customer. No late-cancel fee.');
    expect(adminFetch).toHaveBeenCalledWith(`/admin/customers/${CUSTOMER}/moves/move-apply/apply-preview`);
    expect(adminFetch.mock.calls.some(([url]) => url.endsWith('/apply'))).toBe(false);
    // After the apply the server lists the move as applied: the control goes away, the message stays on the card.
    state.list = { enabled: true, applyEnabled: true, text: null, moves: [{ ...applyMove, status: 'closed', closed_reason: 'applied', applied_at: '2026-11-21T15:00:00Z', apply: { action: 'applied', reason: null } }] };
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Apply move' }));
    expect(await screen.findByText(/^Move applied\. New home is primary/)).toBeInTheDocument();
    expect(adminFetch).toHaveBeenCalledWith(`/admin/customers/${CUSTOMER}/moves/move-apply/apply`, { method: 'POST', body: JSON.stringify({ version: 'v-1' }) });
    // The card reads the moves again after the apply.
    await waitFor(() => expect(adminFetch.mock.calls.filter(([url]) => url === `/admin/customers/${CUSTOMER}/moves`)).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('moving-status')).toHaveTextContent('Move applied Nov 21'));
    expect(screen.queryByTestId('apply-move-action')).toBeNull();
    expect(screen.getByText(/^Move applied\. New home is primary/)).toBeInTheDocument();
  });

  it('Apply move: Cancel closes the preview without posting; a refusal says why and reloads after partial progress', async () => {
    state.list = { enabled: true, applyEnabled: true, text: null, moves: [{ ...applyMove, apply: { action: 'review', reason: null } }] };
    state.preview = PREVIEW;
    render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply move' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('apply-move-preview')).toBeNull();
    expect(adminFetch.mock.calls.some(([url]) => url.endsWith('/apply'))).toBe(false);

    state.apply = { ok: false, body: { error: 'The 2026-12-01 visit is already prepaid.', code: 'paid_visits', progress: { primaryChanged: true } } };
    fireEvent.click(screen.getByRole('button', { name: 'Apply move' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Apply move' }));
    expect(await screen.findByText('The 2026-12-01 visit is already prepaid.')).toBeInTheDocument();
    await waitFor(() => expect(adminFetch.mock.calls.filter(([url]) => url === `/admin/customers/${CUSTOMER}/moves`)).toHaveLength(2));
  });

  it('Apply move: a blocked move shows its reason; nothing shows while applyEnabled is false', async () => {
    state.list = { enabled: true, applyEnabled: true, text: null, moves: [{ ...applyMove, apply: { action: 'blocked', reason: 'The customer has not given a move-out date.' } }] };
    const { unmount } = render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    expect(await screen.findByTestId('apply-move-action')).toHaveTextContent('The customer has not given a move-out date.');
    expect(screen.queryByRole('button', { name: 'Apply move' })).toBeNull();
    unmount();
    state.list = { enabled: true, applyEnabled: false, text: null, moves: [{ ...applyMove, apply: { action: 'review', reason: null } }] };
    render(<CustomerMovingCardV2 customerId={CUSTOMER} />);
    expect(await screen.findByTestId('moving-status')).toBeInTheDocument();
    expect(screen.queryByTestId('apply-move-action')).toBeNull();
  });
});

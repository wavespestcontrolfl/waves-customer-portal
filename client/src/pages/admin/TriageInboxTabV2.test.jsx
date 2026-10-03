// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminFetch } from '../../utils/admin-fetch';
import TriageInboxTabV2, { ConfirmEvidence } from './TriageInboxTabV2';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn(), isRateLimitError: () => false }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const ordinary = { id: 'ordinary', call_log_id: 'call-1', first_name: 'Ordinary', last_name: 'Card',
  reason_code: 'ambiguous_scheduling', status: 'open', updated_at: '2026-09-13T04:00:00.000Z',
  feedback_verdict: 'accept', payload: {}, created_at: '2026-09-13T03:00:00.000Z' };
const proposal = { ...ordinary, id: 'proposal', first_name: 'Proposal', last_name: 'Card',
  payload: JSON.stringify({ reschedule_proposal: { proposed_start_at: '2026-09-20T14:00:00.000Z' } }) };

beforeEach(() => {
  let verdictRecorded = false;
  adminFetch.mockImplementation(async (url) => {
    if (url.includes('/verdict')) verdictRecorded = true;
    return url.startsWith('/admin/triage?')
      ? { items: verdictRecorded ? [proposal] : [ordinary, proposal], counts: { open: verdictRecorded ? 1 : 2, resolved: verdictRecorded ? 1 : 0, dismissed: 0 } }
      : { success: true };
  });
});

describe('reschedule proposal controls', () => {
  it('hides inherited verdict controls and uses the versioned proposal dismissal', async () => {
    render(<TriageInboxTabV2 />);
    const proposalCard = (await screen.findByText('Proposal Card')).closest('.py-4');
    expect(within(proposalCard).queryByText('Accepted')).not.toBeInTheDocument();
    expect(within(proposalCard).queryByRole('button', { name: /accept/i })).not.toBeInTheDocument();
    expect(within(proposalCard).queryByRole('button', { name: /deny/i })).not.toBeInTheDocument();

    fireEvent.click(within(proposalCard).getByRole('button', { name: /dismiss/i }));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith(
      '/admin/call-recordings/proposals/proposal/dismiss',
      { method: 'POST', body: JSON.stringify({ expected_at: proposal.updated_at }) },
    ));
    expect(screen.queryByText('Proposal Card')).not.toBeInTheDocument();
    expect(screen.queryByText(/add a note/i)).not.toBeInTheDocument();
  });

  it('preserves proposal siblings after accepting another card on the call', async () => {
    render(<TriageInboxTabV2 />);
    const ordinaryCard = (await screen.findByText('Ordinary Card')).closest('.py-4');
    fireEvent.click(within(ordinaryCard).getByRole('button', { name: /accept/i }));
    await waitFor(() => expect(screen.queryByText('Ordinary Card')).not.toBeInTheDocument());
    expect(adminFetch.mock.calls.filter(([url]) => url.startsWith('/admin/triage?'))).toHaveLength(2);
    expect(screen.getByText('Proposal Card')).toBeInTheDocument();
  });
});

describe('promised reschedule link review', () => {
  it('reloads a changed card after a stale Mark handled action and retries with the refreshed version', async () => {
    const stale = { ...ordinary, id: 'promise', first_name: 'Promise', last_name: 'Card',
      reason_code: 'reschedule_link_promise', feedback_verdict: null };
    const refreshed = { ...stale, first_name: 'Updated', updated_at: '2026-09-13T04:01:00.000Z' };
    let listLoads = 0;
    let resolveAttempts = 0;
    adminFetch.mockImplementation(async (url) => {
      if (url.startsWith('/admin/triage?')) {
        listLoads += 1;
        return { items: [listLoads === 1 ? stale : refreshed], counts: { open: 1, resolved: 0, dismissed: 0 } };
      }
      if (url === '/admin/triage/promise/resolve') {
        resolveAttempts += 1;
        if (resolveAttempts === 1) throw Object.assign(new Error('Stale version'), { status: 409 });
        return { ok: true };
      }
      return { ok: true };
    });

    render(<TriageInboxTabV2 />);
    const staleCard = (await screen.findByText('Promise Card')).closest('.py-4');
    fireEvent.click(within(staleCard).getByRole('button', { name: /mark handled/i }));
    await waitFor(() => expect(listLoads).toBe(2));
    expect(screen.getByText('Updated Card')).toBeInTheDocument();
    expect(screen.getByText(/review the refreshed card before marking it handled/i)).toBeInTheDocument();
    expect(screen.queryByText('Promise Card')).not.toBeInTheDocument();
    expect(adminFetch).toHaveBeenCalledWith('/admin/triage/promise/resolve', {
      method: 'PUT', body: JSON.stringify({ expected_updated_at: stale.updated_at }),
    });

    const updatedCard = screen.getByText('Updated Card').closest('.py-4');
    fireEvent.click(within(updatedCard).getByRole('button', { name: /mark handled/i }));
    await waitFor(() => expect(resolveAttempts).toBe(2));
    expect(adminFetch).toHaveBeenCalledWith('/admin/triage/promise/resolve', {
      method: 'PUT', body: JSON.stringify({ expected_updated_at: refreshed.updated_at }),
    });
  });
});

describe('verdict version binding', () => {
  it('reloads a card whose evidence changed since it rendered when Accept answers 409 (codex #4666 r25 P2)', async () => {
    const stale = { ...ordinary, id: 'conflict', first_name: 'Conflict', last_name: 'Card', feedback_verdict: null,
      reason_code: 'address_mismatch', payload: JSON.stringify({ flag: 'on_file_house_number_conflict' }) };
    const refreshed = { ...stale, first_name: 'Refreshed', updated_at: '2026-09-13T04:01:00.000Z' };
    let listLoads = 0;
    let verdictAttempts = 0;
    adminFetch.mockImplementation(async (url) => {
      if (url.startsWith('/admin/triage?')) {
        listLoads += 1;
        return { items: [listLoads === 1 ? stale : refreshed], counts: { open: 1, resolved: 0, dismissed: 0 } };
      }
      if (url === '/admin/triage/conflict/verdict') {
        verdictAttempts += 1;
        if (verdictAttempts === 1) throw Object.assign(new Error('Stale version'), { status: 409, code: 'STALE_CARD_VERSION' });
        return { ok: true };
      }
      return { ok: true };
    });

    render(<TriageInboxTabV2 />);
    const staleCard = (await screen.findByText('Conflict Card')).closest('.py-4');
    fireEvent.click(within(staleCard).getByRole('button', { name: /accept/i }));
    await waitFor(() => expect(listLoads).toBe(2));
    expect(screen.getByText('Refreshed Card')).toBeInTheDocument();
    expect(screen.queryByText('Conflict Card')).not.toBeInTheDocument();
    expect(screen.getByText(/review the refreshed card before answering/i)).toBeInTheDocument();
    expect(adminFetch).toHaveBeenCalledWith('/admin/triage/conflict/verdict', expect.objectContaining({
      body: JSON.stringify({ verdict: 'accept', wrong_fields: [], note: null, expected_updated_at: stale.updated_at }),
    }));

    const refreshedCard = screen.getByText('Refreshed Card').closest('.py-4');
    fireEvent.click(within(refreshedCard).getByRole('button', { name: /accept/i }));
    await waitFor(() => expect(verdictAttempts).toBe(2));
    expect(adminFetch).toHaveBeenCalledWith('/admin/triage/conflict/verdict', expect.objectContaining({
      body: JSON.stringify({ verdict: 'accept', wrong_fields: [], note: null, expected_updated_at: refreshed.updated_at }),
    }));
  });
});

describe('email-disagreement confirm form', () => {
  const disagreementCard = { ...ordinary, id: 'email-1', first_name: 'Email', last_name: 'Disagree',
    feedback_verdict: null, reason_code: 'email_unverified',
    payload: JSON.stringify({
      flag: 'email_unverified',
      email_candidates: [{ value: 'janedoee@example.com' }, { value: 'janedoe@example.com' }],
      email_disagreement: { v1: 'janedoee@example.com', v2: 'janedoe@example.com' },
    }) };

  it('renders candidates as radio choices and no Accept/Deny controls are needed to confirm', async () => {
    adminFetch.mockImplementation(async (url) => (url.startsWith('/admin/triage?')
      ? { items: [disagreementCard], counts: { open: 1, resolved: 0, dismissed: 0 } }
      : { ok: true }));
    render(<TriageInboxTabV2 isAdmin />);
    const card = (await screen.findByText('Email Disagree')).closest('.py-4');
    expect(within(card).getByText('janedoee@example.com')).toBeInTheDocument();
    expect(within(card).getByText('janedoe@example.com')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /confirm email/i })).toBeDisabled();
  });

  it('selecting a candidate and confirming posts confirm-email and reloads on success', async () => {
    let listLoads = 0;
    adminFetch.mockImplementation(async (url, opts) => {
      if (url.startsWith('/admin/triage?')) {
        listLoads += 1;
        return { items: listLoads === 1 ? [disagreementCard] : [], counts: { open: listLoads === 1 ? 1 : 0, resolved: listLoads === 1 ? 0 : 1, dismissed: 0 } };
      }
      if (url === '/admin/triage/email-1/confirm-email') {
        expect(JSON.parse(opts.body)).toEqual({ email: 'janedoe@example.com', expected_updated_at: disagreementCard.updated_at });
        return { ok: true, id: 'email-1', status: 'resolved', confirmed_email: 'janedoe@example.com' };
      }
      return { ok: true };
    });
    render(<TriageInboxTabV2 isAdmin />);
    const card = (await screen.findByText('Email Disagree')).closest('.py-4');
    fireEvent.click(within(card).getByLabelText('janedoe@example.com'));
    fireEvent.click(within(card).getByRole('button', { name: /confirm email/i }));
    await waitFor(() => expect(listLoads).toBe(2));
    expect(screen.queryByText('Email Disagree')).not.toBeInTheDocument();
  });

  it('typing an "other" address enables Confirm and sends the typed value', async () => {
    adminFetch.mockImplementation(async (url, opts) => {
      if (url.startsWith('/admin/triage?')) {
        return { items: [disagreementCard], counts: { open: 1, resolved: 0, dismissed: 0 } };
      }
      if (url === '/admin/triage/email-1/confirm-email') {
        expect(JSON.parse(opts.body).email).toBe('correct@example.com');
        return { ok: true };
      }
      return { ok: true };
    });
    render(<TriageInboxTabV2 isAdmin />);
    const card = (await screen.findByText('Email Disagree')).closest('.py-4');
    const confirmButton = within(card).getByRole('button', { name: /confirm email/i });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(within(card).getByPlaceholderText(/type the correct address/i), { target: { value: 'correct@example.com' } });
    expect(confirmButton).not.toBeDisabled();
    fireEvent.click(confirmButton);
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/triage/email-1/confirm-email', expect.anything()));
  });

  it('reloads and shows an error on a stale version', async () => {
    let listLoads = 0;
    adminFetch.mockImplementation(async (url) => {
      if (url.startsWith('/admin/triage?')) {
        listLoads += 1;
        return { items: [disagreementCard], counts: { open: 1, resolved: 0, dismissed: 0 } };
      }
      if (url === '/admin/triage/email-1/confirm-email') {
        throw Object.assign(new Error('Card changed'), { status: 409, code: 'STALE_CARD_VERSION' });
      }
      return { ok: true };
    });
    render(<TriageInboxTabV2 isAdmin />);
    const card = (await screen.findByText('Email Disagree')).closest('.py-4');
    fireEvent.click(within(card).getByLabelText('janedoe@example.com'));
    fireEvent.click(within(card).getByRole('button', { name: /confirm email/i }));
    await waitFor(() => expect(listLoads).toBe(2));
    expect(screen.getByText(/review the refreshed evidence before confirming/i)).toBeInTheDocument();
  });
  it('any other 409 shows the server message and does NOT reload (LEAD_NOT_RESOLVED is not a stale card)', async () => {
    let listLoads = 0;
    adminFetch.mockImplementation(async (url) => {
      if (url.startsWith('/admin/triage?')) {
        listLoads += 1;
        return { items: [disagreementCard], counts: { open: 1, resolved: 0, dismissed: 0 } };
      }
      if (url === '/admin/triage/email-1/confirm-email') {
        throw Object.assign(new Error('Could not identify a single lead for this call — reprocess the call or link it to a customer, then confirm again.'), { status: 409, code: 'LEAD_NOT_RESOLVED' });
      }
      return { ok: true };
    });
    render(<TriageInboxTabV2 isAdmin />);
    const card = (await screen.findByText('Email Disagree')).closest('.py-4');
    fireEvent.click(within(card).getByLabelText('janedoe@example.com'));
    fireEvent.click(within(card).getByRole('button', { name: /confirm email/i }));
    expect(await screen.findByText(/could not identify a single lead for this call/i)).toBeInTheDocument();
    expect(listLoads).toBe(1);
    expect(screen.queryByText(/review the refreshed evidence before confirming/i)).not.toBeInTheDocument();
  });

  it('non-admin staff see an "admin required" note instead of the confirm control (the endpoint 403s them)', async () => {
    adminFetch.mockImplementation(async (url) => (url.startsWith('/admin/triage?')
      ? { items: [disagreementCard], counts: { open: 1, resolved: 0, dismissed: 0 } }
      : { ok: true }));
    render(<TriageInboxTabV2 />);
    const card = (await screen.findByText('Email Disagree')).closest('.py-4');
    expect(within(card).queryByRole('button', { name: /confirm email/i })).not.toBeInTheDocument();
    expect(within(card).getByText(/needs an admin/i)).toBeInTheDocument();
  });
});

describe('follow-up card Resolve path', () => {
  it('"Follow-up booked" sends the card version and reloads on STALE_CARD_VERSION', async () => {
    const stale = { ...ordinary, id: 'fu', first_name: 'Follow', last_name: 'Up', feedback_verdict: null,
      reason_code: 'attached_booking_followup_unbooked', payload: JSON.stringify({ follow_up_plan: { scheduled_date: '2026-10-09', window_start: '10:00:00' } }) };
    const refreshed = { ...stale, first_name: 'Fresh', updated_at: '2026-09-13T04:01:00.000Z' };
    let listLoads = 0;
    let resolveAttempts = 0;
    adminFetch.mockImplementation(async (url) => {
      if (url.startsWith('/admin/triage?')) {
        listLoads += 1;
        return { items: [listLoads === 1 ? stale : refreshed], counts: { open: 1, resolved: 0, dismissed: 0 } };
      }
      if (url === '/admin/triage/fu/resolve') {
        resolveAttempts += 1;
        if (resolveAttempts === 1) throw Object.assign(new Error('Card changed since it was displayed — reload and review the latest'), { status: 409, code: 'STALE_CARD_VERSION' });
        return { ok: true };
      }
      return { ok: true };
    });
    render(<TriageInboxTabV2 />);
    const card = (await screen.findByText('Follow Up')).closest('.py-4');
    fireEvent.click(within(card).getByRole('button', { name: /follow-up booked/i }));
    await waitFor(() => expect(listLoads).toBe(2));
    expect(adminFetch).toHaveBeenCalledWith('/admin/triage/fu/resolve', {
      method: 'PUT', body: JSON.stringify({ expected_updated_at: stale.updated_at }),
    });
    const fresh = (await screen.findByText('Fresh Up')).closest('.py-4');
    fireEvent.click(within(fresh).getByRole('button', { name: /follow-up booked/i }));
    await waitFor(() => expect(resolveAttempts).toBe(2));
    expect(adminFetch).toHaveBeenCalledWith('/admin/triage/fu/resolve', {
      method: 'PUT', body: JSON.stringify({ expected_updated_at: refreshed.updated_at }),
    });
  });
});

describe('missing first-name card', () => {
  const card = { ...ordinary, id: 'fn', first_name: '', last_name: 'Murphy', feedback_verdict: null,
    reason_code: 'missing_first_name', payload: JSON.stringify({ flag: 'missing_first_name', heard_name_v1: { first_name: null, last_name: 'Murphy' } }) };
  const load = () => adminFetch.mockImplementation(async (url) => (url.startsWith('/admin/triage?')
    ? { items: [card], counts: { open: 1, resolved: 0, dismissed: 0 } } : { ok: true }));

  it('is an operational card: Resolve and Dismiss, no Accept/Deny', async () => {
    load();
    render(<TriageInboxTabV2 isAdmin />);
    const el = (await screen.findByText('Murphy')).closest('.py-4');
    expect(within(el).queryByRole('button', { name: /accept/i })).toBeNull();
    expect(within(el).queryByRole('button', { name: /deny/i })).toBeNull();
    expect(within(el).getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
    expect(within(el).getByRole('button', { name: /^resolve$/i })).toBeInTheDocument();
  });

  it('Resolve is admin-only: a non-admin sees Dismiss but no Resolve', async () => {
    load();
    render(<TriageInboxTabV2 isAdmin={false} />);
    const el = (await screen.findByText('Murphy')).closest('.py-4');
    expect(within(el).getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
    expect(within(el).queryByRole('button', { name: /^resolve$/i })).toBeNull();
  });

  it('Resolve closes the card only: PUT /resolve with its version, never a /verdict', async () => {
    load();
    render(<TriageInboxTabV2 isAdmin />);
    const el = (await screen.findByText('Murphy')).closest('.py-4');
    fireEvent.click(within(el).getByRole('button', { name: /^resolve$/i }));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/triage/fn/resolve', {
      method: 'PUT', body: JSON.stringify({ expected_updated_at: card.updated_at }),
    }));
    expect(adminFetch.mock.calls.some(([url]) => String(url).includes('/verdict'))).toBe(false);
  });
});

describe('household hold card (GATE_CALL_HOUSEHOLD_HOLD)', () => {
  const SUGGESTED = '11111111-1111-4111-8111-111111111111';
  const SURVIVOR = '22222222-2222-4222-8222-222222222222';
  const payload = { flag: 'household_address_match', suggested_customer_id: SUGGESTED,
    heard_name_v1: { first_name: 'Sample', last_name: 'Caller' }, caller_phone: '+19415550123',
    address: '100 Example Loop, Sarasota, 34240', preferred_date_time: 'Tuesday at 10 AM', service: 'Pest Control' };
  const card = { ...ordinary, id: 'hh', first_name: null, last_name: null, from_phone: '+19415550123', feedback_verdict: null,
    reason_code: 'household_address_match', severity: 'blocking', call_summary: 'Wants pest control Tuesday.',
    payload: JSON.stringify(payload) };
  const load = (item = card) => adminFetch.mockImplementation(async (url) => (url.startsWith('/admin/triage?')
    ? { items: [item], counts: { open: 1, resolved: 0, dismissed: 0 } } : { ok: true }));
  const cardEl = async () => (await screen.findAllByText('+19415550123', { exact: false }))[0].closest('.py-4');

  it('shows the heard name, caller number, address and request, ONE Open customer link, and no Accept/Deny', async () => {
    load();
    render(<TriageInboxTabV2 isAdmin />);
    const el = await cardEl();
    expect(within(el).getByText('Heard name:').parentElement).toHaveTextContent('Sample Caller');
    expect(within(el).getByText('Caller dialed from:').parentElement).toHaveTextContent('+19415550123');
    expect(within(el).getByText('Stated address:').parentElement).toHaveTextContent('100 Example Loop, Sarasota, 34240');
    expect(within(el).getByText('Requested:').parentElement).toHaveTextContent('Pest Control · Tuesday at 10 AM');
    const links = within(el).getAllByRole('link', { name: 'Open customer' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', `/admin/customers?customerId=${SUGGESTED}`);
    expect(within(el).queryByRole('button', { name: /accept/i })).toBeNull();
    expect(within(el).queryByRole('button', { name: /deny/i })).toBeNull();
    expect(within(el).getByRole('button', { name: /^resolve$/i })).toBeInTheDocument();
    expect(within(el).getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('opens the merge survivor the server resolved, not the merged-away id', async () => {
    load({ ...card, suggested_customer_open_id: SURVIVOR });
    render(<TriageInboxTabV2 isAdmin />);
    const el = await cardEl();
    expect(within(el).getByRole('link', { name: 'Open customer' })).toHaveAttribute('href', `/admin/customers?customerId=${SURVIVOR}`);
  });

  it('a non-admin gets neither Resolve nor Dismiss (the server 403s both)', async () => {
    load();
    render(<TriageInboxTabV2 isAdmin={false} />);
    const el = await cardEl();
    expect(within(el).queryByRole('button', { name: /^resolve$/i })).toBeNull();
    expect(within(el).queryByRole('button', { name: /dismiss/i })).toBeNull();
    expect(within(el).queryByRole('button', { name: /accept|deny/i })).toBeNull();
    expect(within(el).getByText(/needs an admin/i)).toBeInTheDocument();
  });

  it('Resolve closes the card only: PUT /resolve with its version, never a /verdict', async () => {
    load();
    render(<TriageInboxTabV2 isAdmin />);
    const el = await cardEl();
    fireEvent.click(within(el).getByRole('button', { name: /^resolve$/i }));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/triage/hh/resolve', {
      method: 'PUT', body: JSON.stringify({ expected_updated_at: card.updated_at }),
    }));
    expect(adminFetch.mock.calls.some(([url]) => String(url).includes('/verdict'))).toBe(false);
  });

  it('a malformed suggested id never becomes a link', () => {
    render(<ConfirmEvidence reasonCode="household_address_match" payload={{ ...payload, suggested_customer_id: 'not-a-uuid' }} suggestedOpenId="also-bad" />);
    expect(screen.queryByRole('link', { name: 'Open customer' })).toBeNull();
  });
});

describe('verdict 409 with its own instruction', () => {
  it('shows the server message for a relinked call instead of reloading and looping', async () => {
    const card = { ...ordinary, id: 'relinked', first_name: 'Relinked', last_name: 'Card', feedback_verdict: null };
    let listLoads = 0;
    adminFetch.mockImplementation(async (url) => {
      if (url.startsWith('/admin/triage?')) { listLoads += 1; return { items: [card], counts: { open: 1, resolved: 0, dismissed: 0 } }; }
      if (url === '/admin/triage/relinked/verdict') {
        throw Object.assign(new Error('This call was relinked to another customer since the card was filed — reprocess the call to refresh the card, then review it.'), { status: 409, code: 'CONFLICT_CUSTOMER_RELINKED' });
      }
      return { ok: true };
    });
    render(<TriageInboxTabV2 />);
    const el = (await screen.findByText('Relinked Card')).closest('.py-4');
    fireEvent.click(within(el).getByRole('button', { name: /accept/i }));
    expect(await screen.findByText(/reprocess the call to refresh the card/i)).toBeInTheDocument();
    expect(listLoads).toBe(1);
  });
});

// secondary_contact_captured review items carry the second person named on
// the call (a realtor's buyer, a landlord's tenant) — the card must show the
// operator WHO to confirm, in both payload shapes the server produces.
describe('ConfirmEvidence — missing first name', () => {
  const A = '11111111-2222-4333-8444-555555555555';
  const B = '66666666-7777-4888-8999-000000000000';
  it('links the customer listed on the task with neutral wording', () => {
    render(<ConfirmEvidence reasonCode="missing_first_name" payload={{ flag: 'missing_first_name', customer_ids: [A] }} />);
    expect(screen.getByRole('link', { name: 'Open customer' })).toHaveAttribute('href', `/admin/customers?customerId=${A}`);
    expect(screen.getByText(/the customer linked to this task/)).toBeInTheDocument();
  });

  it('links the record the server resolved (a merged-away customer opens its survivor) — codex #5559 r18', () => {
    render(<ConfirmEvidence reasonCode="missing_first_name" payload={{ flag: 'missing_first_name', customer_ids: [A] }} openCustomerIds={[B]} />);
    expect(screen.getByRole('link', { name: 'Open customer' })).toHaveAttribute('href', `/admin/customers?customerId=${B}`);
  });

  it('a pre-list card (scalar customer_id) reads as one listed customer', () => {
    render(<ConfirmEvidence reasonCode="missing_first_name" payload={{ flag: 'missing_first_name', customer_id: A }} />);
    expect(screen.getByRole('link', { name: 'Open customer' })).toHaveAttribute('href', `/admin/customers?customerId=${A}`);
  });

  it('several listed customers: plural wording and ONE link each, invalid ids dropped', () => {
    render(<ConfirmEvidence reasonCode="missing_first_name" payload={{ flag: 'missing_first_name', customer_ids: [A, B, A, 'not-a-uuid'] }} />);
    expect(screen.getByText(/the customers linked to this task/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open customer 1' })).toHaveAttribute('href', `/admin/customers?customerId=${A}`);
    expect(screen.getByRole('link', { name: 'Open customer 2' })).toHaveAttribute('href', `/admin/customers?customerId=${B}`);
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('shows no customer link without a valid listed id, or on another reason', () => {
    const { unmount } = render(<ConfirmEvidence reasonCode="missing_first_name" payload={{ flag: 'missing_first_name', customer_ids: ['not-a-uuid'] }} />);
    expect(screen.queryByRole('link')).toBeNull();
    unmount();
    render(<ConfirmEvidence reasonCode="email_unverified" payload={{ flag: 'email_unverified', customer_ids: [A], customer_id: A }} />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('ConfirmEvidence — dispute recovery task', () => {
  it('names the promised follow-up the hold kept from booking', () => {
    render(<ConfirmEvidence payload={{
      flag: 'auto_booking_skipped_after_approval',
      follow_up_plan: { scheduled_date: '2026-10-09', window_start: '10:00:00' },
    }} />);
    expect(screen.getByText('Promised follow-up:')).toBeInTheDocument();
    expect(screen.getByText(/Visit 2 was promised for 2026-10-09 at 10:00/)).toBeInTheDocument();
  });
});

describe('ConfirmEvidence — retained visit', () => {
  it('names the retained appointment as address-correction work, not a second booking', () => {
    render(<ConfirmEvidence payload={{ flag: 'auto_booking_skipped_after_approval', retained_service_id: 'svc-9', retained_scheduled_date: '2026-10-02' }} />);
    expect(screen.getByText('Retained visit:')).toBeInTheDocument();
    expect(screen.getByText(/Visit svc-9 on 2026-10-02 was kept on the caller-stated number/)).toBeInTheDocument();
  });
});

describe('ConfirmEvidence — house-number conflict', () => {
  it('shows both whole doors: the stated unit and the on-file unit', () => {
    render(<ConfirmEvidence payload={{
      flag: 'on_file_house_number_conflict',
      stated_street: '1250 Example Street', stated_unit: 'Apt 2',
      on_file_address: { address_line1: '1260 Example Street', address_line2: 'Apt 3' },
    }} />);
    expect(screen.getByText('1250 Example Street, Apt 2')).toBeInTheDocument();
    expect(screen.getByText('1260 Example Street, Apt 3')).toBeInTheDocument();
  });
  it('shows the caller\'s own words when Address Validation corrected the number', () => {
    render(<ConfirmEvidence payload={{
      flag: 'on_file_house_number_conflict',
      stated_street: '1250 Example Street', spoken_street: '1240 Example Street',
      on_file_address: { address_line1: '1260 Example Street' },
    }} />);
    expect(screen.getByText('Caller said:')).toBeInTheDocument();
    expect(screen.getByText('1240 Example Street — validated as 1250 Example Street')).toBeInTheDocument();
  });
});

describe('ConfirmEvidence — secondary contact', () => {
  it('renders the V2 nested shape (name_full / phone_e164) from the deterministic-flags insert', () => {
    render(<ConfirmEvidence payload={{
      flag: 'secondary_contact_captured',
      secondary_contact: {
        name_full: 'Joseph Haught', first_name: null, last_name: null,
        phone_e164: '+19542901693', email: 'joseph.haught89431@gmail.com',
        role: 'home_buyer', wants_notifications: true,
      },
    }} />);
    expect(screen.getByText('Second contact:')).toBeInTheDocument();
    const row = screen.getByText('Second contact:').parentElement;
    expect(row).toHaveTextContent('Joseph Haught');
    expect(row).toHaveTextContent('(home buyer)');
    expect(row).toHaveTextContent('+19542901693');
    expect(row).toHaveTextContent('joseph.haught89431@gmail.com');
    expect(row).toHaveTextContent('caller asked they get notifications');
  });

  it('renders the flat shape (first/last + phone) from the processor insert', () => {
    render(<ConfirmEvidence payload={JSON.stringify({
      flag: 'secondary_contact_captured',
      secondary_contact: {
        first_name: 'Joseph', last_name: 'Haught', phone: '+19542901693',
        email: null, role: 'home_buyer', wants_notifications: false,
      },
    })} />);
    const row = screen.getByText('Second contact:').parentElement;
    expect(row).toHaveTextContent('Joseph Haught');
    expect(row).toHaveTextContent('+19542901693');
    expect(row).not.toHaveTextContent('caller asked they get notifications');
  });

  it('renders nothing for payloads with no evidence (unchanged behavior)', () => {
    const { container } = render(<ConfirmEvidence payload={{ flag: 'missing_last_name' }} />);
    expect(container.firstChild).toBeNull();
  });
});

// missing_unit_number asks the office to collect a condo/townhome unit
// number. Without the building it is about, the card is unactionable — the
// server stamps it at filing time (buildTriageItem), so the card must show it.
describe('ConfirmEvidence — unit-number ask', () => {
  it('names the building the unit is needed for', () => {
    render(<ConfirmEvidence payload={{
      flag: 'missing_unit_number',
      unit_ask_building: { street_line_1: '100 Example Condo Ct', city: 'Bradenton', postal_code: '34212' },
    }} />);
    const row = screen.getByText('Unit needed for:').parentElement;
    expect(row).toHaveTextContent('100 Example Condo Ct, Bradenton, 34212');
  });

  it('omits absent place parts rather than rendering empty separators', () => {
    render(<ConfirmEvidence payload={JSON.stringify({
      flag: 'missing_unit_number',
      unit_ask_building: { street_line_1: '100 Example Condo Ct', city: null, postal_code: null },
    })} />);
    const row = screen.getByText('Unit needed for:').parentElement;
    expect(row).toHaveTextContent('100 Example Condo Ct');
    expect(row).not.toHaveTextContent(',');
  });

  it('shows the unit the customer texted back, beside the ask', () => {
    render(<ConfirmEvidence payload={{
      flag: 'missing_unit_number',
      unit_ask_building: { street_line_1: '100 Example Condo Ct', city: 'Bradenton', postal_code: '34212' },
      customer_reply_unit: 'Apt 204',
      customer_reply_at: '2026-09-03T14:05:00.000Z',
    }} />);
    const row = screen.getByText('Customer replied:').parentElement;
    expect(row).toHaveTextContent('Apt 204');
    expect(row).toHaveTextContent('by text');
    expect(row).toHaveTextContent('ET');
    expect(screen.getByText('Unit needed for:').parentElement).toHaveTextContent('100 Example Condo Ct');
  });

  it('renders nothing when the stamp carries no street', () => {
    const { container } = render(<ConfirmEvidence payload={{
      flag: 'missing_unit_number',
      unit_ask_building: { street_line_1: null, city: 'Bradenton', postal_code: '34212' },
    }} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('street-level address hold card', () => {
  const holdPayload = {
    origin: 'voice_agent', street_level_address: true, scheduled_service_id: 'visit-1',
    address_on_file: '1234 Sample Newbuild Trl, Parrish, FL, 34219', visit_when: '2026-10-05 13:00',
    visit_link: '/admin/dispatch?tab=schedule&date=2026-10-05&appointment=visit-1',
  };

  it('ConfirmEvidence shows the form address, the visit, the instruction and an Open visit link', () => {
    render(<ConfirmEvidence payload={holdPayload} />);
    expect(screen.getByText('Form address:').parentElement).toHaveTextContent('1234 Sample Newbuild Trl, Parrish, FL, 34219');
    expect(screen.getByText('Visit:').parentElement).toHaveTextContent('2026-10-05 13:00');
    expect(screen.getByText(/Confirm, correct, or cancel the visit to close this\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open visit' })).toHaveAttribute('href', holdPayload.visit_link);
  });

  it('does not render a link that leaves the admin app', () => {
    render(<ConfirmEvidence payload={{ ...holdPayload, visit_link: 'https://example.com/x' }} />);
    expect(screen.queryByRole('link', { name: 'Open visit' })).not.toBeInTheDocument();
  });

  it('hides Accept and Deny; Dismiss stays so the card can close once the visit is cancelled (the server refuses it while the visit is unconfirmed)', async () => {
    const hold = { ...ordinary, id: 'hold', first_name: 'Hold', last_name: 'Card', reason_code: 'outbound_booking_review',
      feedback_verdict: null, payload: JSON.stringify(holdPayload) };
    adminFetch.mockImplementation(async (url) => (url.startsWith('/admin/triage?')
      ? { items: [hold], counts: { open: 1, resolved: 0, dismissed: 0 } }
      : { success: true }));
    render(<TriageInboxTabV2 />);
    const card = (await screen.findByText('Hold Card')).closest('.py-4');
    expect(within(card).queryByRole('button', { name: /accept/i })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /deny/i })).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Open visit' })).toBeInTheDocument();
  });

  it('a Dismiss refused while the visit is unconfirmed shows the server instruction, not the stale-card message', async () => {
    const hold = { ...ordinary, id: 'hold', first_name: 'Hold', last_name: 'Card', reason_code: 'outbound_booking_review',
      feedback_verdict: null, payload: JSON.stringify(holdPayload) };
    adminFetch.mockImplementation(async (url) => {
      if (url.startsWith('/admin/triage?')) return { items: [hold], counts: { open: 1, resolved: 0, dismissed: 0 } };
      throw Object.assign(new Error('Confirm, correct, or cancel the visit itself.'), { status: 409, code: 'STREET_LEVEL_HOLD_PENDING' });
    });
    render(<TriageInboxTabV2 />);
    const card = (await screen.findByText('Hold Card')).closest('.py-4');
    fireEvent.click(within(card).getByRole('button', { name: /dismiss/i }));
    const dialogButtons = await screen.findAllByRole('button', { name: /dismiss/i });
    fireEvent.click(dialogButtons[dialogButtons.length - 1]);
    await waitFor(() => expect(screen.getByText('Confirm, correct, or cancel the visit itself.')).toBeInTheDocument());
  });
});

describe('street-level address hold: office confirm', () => {
  const holdPayload = {
    origin: 'voice_agent', street_level_address: true, scheduled_service_id: 'visit-1',
    address_on_file: '1234 Sample Newbuild Trl, Parrish, FL, 34219', visit_when: 'Mon Oct 5, 1 PM',
    visit_link: '/admin/dispatch?tab=schedule&date=2026-10-05&appointment=visit-1',
  };
  const hold = { ...ordinary, id: 'hold', first_name: 'Hold', last_name: 'Card', reason_code: 'outbound_booking_review',
    feedback_verdict: null, payload: JSON.stringify(holdPayload), visit_address: '1234 Sample Newbuild Trl, Parrish, FL, 34219' };
  const mockList = (confirmImpl) => adminFetch.mockImplementation(async (url, opts) => {
    if (url.startsWith('/admin/triage?')) return { items: [hold], counts: { open: 1, resolved: 0, dismissed: 0 } };
    if (confirmImpl && url.includes('/status')) return confirmImpl(url, opts);
    return { success: true };
  });

  it('an admin sees "Confirm address & book"; the dialog shows the form address and keeps the button off until the read-back box is ticked', async () => {
    mockList();
    render(<TriageInboxTabV2 isAdmin />);
    const card = (await screen.findByText('Hold Card')).closest('.py-4');
    fireEvent.click(within(card).getByRole('button', { name: /confirm address/i }));
    expect(await screen.findByText('1234 Sample Newbuild Trl, Parrish, FL, 34219', { selector: 'div' })).toBeInTheDocument();
    const go = screen.getByRole('button', { name: /^confirm & book$/i });
    expect(go).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/read this address back to the customer/i));
    expect(go).not.toBeDisabled();
  });

  it('confirming calls the EXISTING admin status route with status confirmed for the linked visit, then reloads the inbox', async () => {
    mockList(async () => ({ success: true }));
    render(<TriageInboxTabV2 isAdmin />);
    const card = (await screen.findByText('Hold Card')).closest('.py-4');
    fireEvent.click(within(card).getByRole('button', { name: /confirm address/i }));
    fireEvent.click(await screen.findByLabelText(/read this address back to the customer/i));
    fireEvent.click(screen.getByRole('button', { name: /^confirm & book$/i }));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/dispatch/visit-1/status', { method: 'PUT', body: JSON.stringify({ status: 'confirmed', expected_service_address: '1234 Sample Newbuild Trl, Parrish, FL, 34219' }) }));
    await waitFor(() => expect(adminFetch.mock.calls.filter(([u]) => u.startsWith('/admin/triage?')).length).toBeGreaterThanOrEqual(2));
  });

  it('a refused confirm shows the server message and does not reload', async () => {
    mockList(async () => { throw Object.assign(new Error('Office must confirm the address first.'), { status: 409 }); });
    render(<TriageInboxTabV2 isAdmin />);
    const card = (await screen.findByText('Hold Card')).closest('.py-4');
    fireEvent.click(within(card).getByRole('button', { name: /confirm address/i }));
    fireEvent.click(await screen.findByLabelText(/read this address back to the customer/i));
    fireEvent.click(screen.getByRole('button', { name: /^confirm & book$/i }));
    await waitFor(() => expect(screen.getByText('Office must confirm the address first.')).toBeInTheDocument());
  });

  it('a non-admin sees no confirm button, only the note', async () => {
    mockList();
    render(<TriageInboxTabV2 isAdmin={false} />);
    const card = (await screen.findByText('Hold Card')).closest('.py-4');
    expect(within(card).queryByRole('button', { name: /confirm address/i })).not.toBeInTheDocument();
    expect(within(card).getByText(/needs an admin/i)).toBeInTheDocument();
  });

  it('the dialog shows the visit\'s LIVE address, labelled "Current visit address", when a correction made it differ', async () => {
    const corrected = { ...hold, visit_address: '1240 Sample Newbuild Trl, Parrish, FL, 34219' };
    adminFetch.mockImplementation(async (url) => (url.startsWith('/admin/triage?')
      ? { items: [corrected], counts: { open: 1, resolved: 0, dismissed: 0 } } : { success: true }));
    render(<TriageInboxTabV2 isAdmin />);
    const card = (await screen.findByText('Hold Card')).closest('.py-4');
    fireEvent.click(within(card).getByRole('button', { name: /confirm address/i }));
    expect(await screen.findByText('Current visit address')).toBeInTheDocument();
    expect(screen.getByText('1240 Sample Newbuild Trl, Parrish, FL, 34219')).toBeInTheDocument();
    expect(screen.queryByText('1234 Sample Newbuild Trl, Parrish, FL, 34219')).not.toBeInTheDocument();
  });

  it('an unchanged live address (formatting aside) shows once, with no "Current visit address" label', async () => {
    const same = { ...hold, visit_address: '1234 sample newbuild trl, parrish, fl 34219' };
    adminFetch.mockImplementation(async (url) => (url.startsWith('/admin/triage?')
      ? { items: [same], counts: { open: 1, resolved: 0, dismissed: 0 } } : { success: true }));
    render(<TriageInboxTabV2 isAdmin />);
    const card = (await screen.findByText('Hold Card')).closest('.py-4');
    fireEvent.click(within(card).getByRole('button', { name: /confirm address/i }));
    expect(await screen.findByText('1234 sample newbuild trl, parrish, fl 34219', { selector: 'div' })).toBeInTheDocument();
    expect(screen.queryByText('Current visit address')).not.toBeInTheDocument();
  });

  it('sends the address the dialog SHOWED (the live one), and a server address_changed refusal is shown, not swallowed', async () => {
    const corrected = { ...hold, visit_address: '1240 Sample Newbuild Trl, Parrish, FL, 34219' };
    adminFetch.mockImplementation(async (url, opts) => {
      if (url.startsWith('/admin/triage?')) return { items: [corrected], counts: { open: 1, resolved: 0, dismissed: 0 } };
      throw Object.assign(new Error('The visit address changed since you opened this.'), { status: 409, code: 'address_changed', body: opts });
    });
    render(<TriageInboxTabV2 isAdmin />);
    const card = (await screen.findByText('Hold Card')).closest('.py-4');
    fireEvent.click(within(card).getByRole('button', { name: /confirm address/i }));
    fireEvent.click(await screen.findByLabelText(/read this address back to the customer/i));
    fireEvent.click(screen.getByRole('button', { name: /^confirm & book$/i }));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/dispatch/visit-1/status', { method: 'PUT', body: JSON.stringify({ status: 'confirmed', expected_service_address: '1240 Sample Newbuild Trl, Parrish, FL, 34219' }) }));
    await waitFor(() => expect(screen.getByText('The visit address changed since you opened this.')).toBeInTheDocument());
  });

  it('the dialog shows the visit\'s LIVE slot (a moved hold), not the booking-time one the card captured', async () => {
    // The list endpoint refreshes payload.visit_when from the visit when SmartRebooker / an admin moved it.
    const moved = { ...hold, payload: JSON.stringify({ ...holdPayload, visit_when: '2026-10-12 14:00' }) };
    adminFetch.mockImplementation(async (url) => (url.startsWith('/admin/triage?')
      ? { items: [moved], counts: { open: 1, resolved: 0, dismissed: 0 } } : { success: true }));
    render(<TriageInboxTabV2 isAdmin />);
    const card = (await screen.findByText('Hold Card')).closest('.py-4');
    fireEvent.click(within(card).getByRole('button', { name: /confirm address/i }));
    expect(await screen.findByText('Visit: 2026-10-12 14:00')).toBeInTheDocument();
    expect(screen.queryByText(/Mon Oct 5, 1 PM/)).not.toBeInTheDocument();
  });

  it('with no live slot on the row, the dialog falls back to the slot the card captured', async () => {
    mockList();
    render(<TriageInboxTabV2 isAdmin />);
    const card = (await screen.findByText('Hold Card')).closest('.py-4');
    fireEvent.click(within(card).getByRole('button', { name: /confirm address/i }));
    expect(await screen.findByText('Visit: Mon Oct 5, 1 PM')).toBeInTheDocument();
  });

  it('keeps Confirm disabled when the live visit address did not load', async () => {
    const noLive = { ...hold, visit_address: undefined };
    adminFetch.mockImplementation(async (url) => (url.startsWith('/admin/triage?')
      ? { items: [noLive], counts: { open: 1, resolved: 0, dismissed: 0 } } : { success: true }));
    render(<TriageInboxTabV2 isAdmin />);
    const card = (await screen.findByText('Hold Card')).closest('.py-4');
    fireEvent.click(within(card).getByRole('button', { name: /confirm address/i }));
    fireEvent.click(await screen.findByLabelText(/read this address back to the customer/i));
    expect(screen.getByText(/current address did not load/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^confirm & book$/i })).toBeDisabled();
  });

  it('addresses that differ only by where the spaces fall are different (1 23rd Ave is not 12 3rd Ave) and the LIVE one is shown', async () => {
    const tricky = { ...hold, payload: JSON.stringify({ ...holdPayload, address_on_file: '1 23rd Ave, Parrish, FL, 34219' }), visit_address: '12 3rd Ave, Parrish, FL, 34219' };
    adminFetch.mockImplementation(async (url) => (url.startsWith('/admin/triage?')
      ? { items: [tricky], counts: { open: 1, resolved: 0, dismissed: 0 } } : { success: true }));
    render(<TriageInboxTabV2 isAdmin />);
    const card = (await screen.findByText('Hold Card')).closest('.py-4');
    fireEvent.click(within(card).getByRole('button', { name: /confirm address/i }));
    expect(await screen.findByText('Current visit address')).toBeInTheDocument();
    expect(screen.getByText('12 3rd Ave, Parrish, FL, 34219')).toBeInTheDocument();
    expect(screen.queryByText('1 23rd Ave, Parrish, FL, 34219')).not.toBeInTheDocument();
  });
});

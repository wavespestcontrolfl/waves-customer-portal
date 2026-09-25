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

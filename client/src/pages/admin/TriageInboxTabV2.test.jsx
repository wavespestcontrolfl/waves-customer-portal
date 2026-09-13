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

// secondary_contact_captured review items carry the second person named on
// the call (a realtor's buyer, a landlord's tenant) — the card must show the
// operator WHO to confirm, in both payload shapes the server produces.
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

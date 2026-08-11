// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfirmEvidence } from './TriageInboxTabV2';

afterEach(cleanup);

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

  it('renders nothing when the stamp carries no street', () => {
    const { container } = render(<ConfirmEvidence payload={{
      flag: 'missing_unit_number',
      unit_ask_building: { street_line_1: null, city: 'Bradenton', postal_code: '34212' },
    }} />);
    expect(container.firstChild).toBeNull();
  });
});

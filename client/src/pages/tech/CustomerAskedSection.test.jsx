// @vitest-environment jsdom
// "Customer asked" on the tech Visit Brief (facts.customer_asked): labels, ET date, pest names, text; nothing when
// the key is absent or empty; the first member that has it carries a grouped stop.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import CustomerAskedSection from './CustomerAskedSection';
import VisitBriefPanel from './VisitBriefPanel';

afterEach(cleanup);

const ITEMS = [
  { kind: 'portal_request', at: '2026-11-23T10:00:00.000Z', text: 'Lawn Care: Brown patch by the gate', source: 'portal' },
  { kind: 'reservice_reason', at: '2026-11-20T15:00:00.000Z', text: 'Ants in the kitchen.', pests: ['Ants', 'Spiders'], source: 'picker' },
  { kind: 'reservice_words', at: '2026-11-22T14:00:00.000Z', text: 'They are worse today.', source: 'text' },
  { kind: 'booking_note', at: '2026-11-20T15:00:00.000Z', text: 'Please text before you arrive' },
];

const bits = (...customerAsked) => customerAsked.map((c) => ({ facts: c === undefined ? null : { customer_asked: c } }));

describe('CustomerAskedSection', () => {
  it('renders each item with its label, ET date, pest names and text', () => {
    render(<CustomerAskedSection memberBits={bits({ items: ITEMS })} />);
    expect(screen.getByText('Customer asked')).toBeInTheDocument();
    expect(screen.getByText('Portal request · Nov 23')).toBeInTheDocument();
    expect(screen.getByText('Return visit reason · Nov 20 · Ants, Spiders')).toBeInTheDocument();
    expect(screen.getByText("Customer's words · Nov 22")).toBeInTheDocument();
    expect(screen.getByText('Booking note · Nov 20')).toBeInTheDocument();
    expect(screen.getByText('Ants in the kitchen.')).toBeInTheDocument();
    expect(screen.getByText('Please text before you arrive')).toBeInTheDocument();
  });

  it('renders nothing when the key is absent or the list is empty', () => {
    const { container, rerender } = render(<CustomerAskedSection memberBits={bits(undefined)} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CustomerAskedSection memberBits={bits({ items: [] })} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CustomerAskedSection memberBits={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('uses the first member that has items on a grouped stop', () => {
    render(<CustomerAskedSection memberBits={bits({ items: [] }, { items: [ITEMS[3]] }, { items: [ITEMS[0]] })} />);
    expect(screen.getByText('Please text before you arrive')).toBeInTheDocument();
    expect(screen.queryByText('Lawn Care: Brown patch by the gate')).not.toBeInTheDocument();
  });

  it('shows in the Visit Brief panel from the served facts', () => {
    const service = { id: 'svc-1', status: 'confirmed', customerName: 'Pat Sample', address: '123 Palm Ave, Bradenton, FL 34205', serviceType: 'Quarterly Pest Control' };
    const stop = { key: 'row:svc-1', isVisit: false, services: [service], primary: service, liveCount: 1 };
    const detail = { status: 'ready', byService: { 'svc-1': { estimate: null, brief: { brief: null, facts: { access: null, last_visit: null, customer_asked: { items: [ITEMS[3]] } } } } } };
    render(<VisitBriefPanel stop={stop} detail={detail} request={async () => ({})} onRetry={() => {}} />);
    expect(screen.getByTestId('visit-brief-customer-asked')).toHaveTextContent('Please text before you arrive');
  });
});

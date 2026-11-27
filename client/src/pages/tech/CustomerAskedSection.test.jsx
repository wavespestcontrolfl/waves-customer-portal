// @vitest-environment jsdom
// "Customer asked" on the tech Visit Brief (facts.customer_asked): labels, ET date, pest names, text; nothing when
// the key is absent or empty; a grouped stop merges every member's list.
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
  { kind: 'portal_message', at: '2026-11-21T15:00:00.000Z', text: 'Dog is in the yard', source: 'portal', accountWide: true },
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
    expect(screen.getByText('Portal message · Nov 21 · may be about another home')).toBeInTheDocument();
    expect(screen.getByText('Dog is in the yard')).toBeInTheDocument();
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

  it('merges every member of a grouped stop: shared items once, each reason and note kept with its service', () => {
    const shared = ITEMS[0];
    const memberBits = [
      { service: { id: 'a', serviceType: 'Pest Control' }, facts: { customer_asked: { items: [shared, ITEMS[1], ITEMS[3]] } } },
      { service: { id: 'b', serviceType: 'Lawn Care' }, facts: { customer_asked: { items: [shared, { ...ITEMS[3], text: 'Mow after noon' }] } } },
      { service: { id: 'c', serviceType: 'Mosquito' }, facts: null },
    ];
    render(<CustomerAskedSection memberBits={memberBits} />);
    expect(screen.getAllByText('Lawn Care: Brown patch by the gate')).toHaveLength(1);
    expect(screen.getByText('Booking note · Pest Control · Nov 20')).toBeInTheDocument();
    expect(screen.getByText('Booking note · Lawn Care · Nov 20')).toBeInTheDocument();
    expect(screen.getByText('Return visit reason · Pest Control · Nov 20 · Ants, Spiders')).toBeInTheDocument();
    expect(screen.getByText('Please text before you arrive')).toBeInTheDocument();
    expect(screen.getByText('Mow after noon')).toBeInTheDocument();
  });

  it('keeps a reschedule note with its service on a grouped stop, and labels an account-wide message', () => {
    const note = { kind: 'portal_request', at: '2026-11-24T10:00:00.000Z', text: 'Please move this to Friday', source: 'portal', appointment: true };
    const words = { kind: 'reservice_words', at: '2026-11-22T14:00:00.000Z', text: 'Roaches at the rental', source: 'text', accountWide: true };
    const memberBits = [
      { service: { id: 'a', serviceType: 'Pest Control' }, facts: { customer_asked: { items: [note, words] } } },
      { service: { id: 'b', serviceType: 'Lawn Care' }, facts: { customer_asked: { items: [{ ...note, text: 'Skip the edging' }, words] } } },
    ];
    render(<CustomerAskedSection memberBits={memberBits} />);
    expect(screen.getAllByText('Portal request · Pest Control · Nov 24')).toHaveLength(1);
    expect(screen.getAllByText('Portal request · Lawn Care · Nov 24')).toHaveLength(1);
    expect(screen.getAllByText("Customer's words · Nov 22 · may be about another home")).toHaveLength(1);
  });

  it('names no service on a single-service stop', () => {
    render(<CustomerAskedSection memberBits={[{ service: { id: 'a', serviceType: 'Pest Control' }, facts: { customer_asked: { items: [ITEMS[3]] } } }]} />);
    expect(screen.getByText('Booking note · Nov 20')).toBeInTheDocument();
  });

  it('shows in the Visit Brief panel from the served facts', () => {
    const service = { id: 'svc-1', status: 'confirmed', customerName: 'Pat Sample', address: '123 Palm Ave, Bradenton, FL 34205', serviceType: 'Quarterly Pest Control' };
    const stop = { key: 'row:svc-1', isVisit: false, services: [service], primary: service, liveCount: 1 };
    const detail = { status: 'ready', byService: { 'svc-1': { estimate: null, brief: { brief: null, facts: { access: null, last_visit: null, customer_asked: { items: [ITEMS[3]] } } } } } };
    render(<VisitBriefPanel stop={stop} detail={detail} request={async () => ({})} onRetry={() => {}} />);
    expect(screen.getByTestId('visit-brief-customer-asked')).toHaveTextContent('Please text before you arrive');
  });
});

// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EstimateViewPage, { PropertyGroupSwitcher } from './EstimateViewPage';

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'anchortoken' }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function estimatePayload(terminalState) {
  return {
    estimate: {
      customerFirstName: 'Sam', address: '1 Group Lane', serviceCategory: 'pest_control',
      acceptance: { mode: 'standard_slot_pick' }, defaultServiceMode: 'one_time',
      isOneTimeOnly: true, showOneTimeOption: false, billByInvoice: false,
      membership: null, intelligence: null, acceptedServiceMode: null, acceptedFrequencyKey: null,
    },
    pricing: { services: [], askChips: [], anchorOneTimePrice: 125,
      oneTimeBreakdown: { total: 125, items: [] }, defaultServiceMode: 'one_time', renderFlags: {} },
    cta: { canAccept: false, terminalState, quoteRequired: terminalState === 'quote_required', reviewBeforeBooking: false },
    propertyGroup: [
      { token: 'anchortoken', address: '1 Group Lane', status: terminalState, isCurrent: true },
      { token: 'livesiblingtoken', address: '2 Group Lane', status: 'sent', isCurrent: false },
    ],
  };
}

describe('property group navigation', () => {
  const group = [
    { token: 'anchortoken', address: '1 Group Lane', status: 'expired', isCurrent: true },
    { token: 'livesiblingtoken', address: '2 Group Lane', status: 'sent', isCurrent: false },
    { address: '3 Group Lane', status: 'expired', isCurrent: false },
  ];

  it('keeps active siblings navigable and expired siblings as labeled summaries', () => {
    render(<PropertyGroupSwitcher group={group} />);
    expect(screen.getByText('This estimate covers 3 properties')).toBeInTheDocument();
    expect(screen.getAllByText('Expired', { exact: false })).toHaveLength(2);
    expect(screen.getByRole('link', { name: /2 Group Lane/ })).toHaveAttribute('href', '/estimate/livesiblingtoken');
    expect(screen.queryByRole('link', { name: /3 Group Lane/ })).not.toBeInTheDocument();
    expect(within(screen.getByText('3 Group Lane').closest('div')).queryByText('View')).not.toBeInTheDocument();
  });

  it('keeps preview navigation on reachable siblings', () => {
    render(<PropertyGroupSwitcher group={group} preview />);
    expect(screen.getByRole('link', { name: /2 Group Lane/ })).toHaveAttribute('href', '/estimate/livesiblingtoken?adminPreview=1');
  });

  it('hides the unavailable PDF action on a navigation-only expired anchor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => estimatePayload('expired') })));
    render(<EstimateViewPage />);
    await screen.findByText('This estimate has expired.');
    expect(screen.queryByRole('link', { name: 'Download PDF' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download PDF' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Portal Login' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /2 Group Lane/ })).toBeInTheDocument();
  });

  it('keeps the PDF download for a viewable offer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => estimatePayload('quote_required') })));
    render(<EstimateViewPage />);
    expect(await screen.findByRole('link', { name: 'Download PDF' })).toHaveAttribute('href', expect.stringContaining('/estimates/anchortoken/pdf'));
  });
});

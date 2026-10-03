// @vitest-environment jsdom
//
// Job card "Why they booked" box (GATE_JOB_CARD_CUSTOMER_CONTEXT, owner
// "ok go" 2026-10-03). Typed and texted words are quoted; a call's AI
// summary and the office's wording are not; nothing recorded renders nothing.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobCardCustomerRequest } from './SchedulePage';

vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

const D = { text: '#111', muted: '#666', border: '#ccc' };
afterEach(cleanup);

describe('JobCardCustomerRequest', () => {
  it('quotes words the customer typed and lists the pests picked', () => {
    render(<JobCardCustomerRequest D={D} request={{ text: 'Roaches under the sink', source: 'picker', pests: ['german roach', 'ant'] }} />);
    expect(screen.getByText('Why they booked')).toBeTruthy();
    expect(screen.getByText('“Roaches under the sink”')).toBeTruthy();
    expect(screen.getByText('Customer wrote (re-service page):', { exact: false })).toBeTruthy();
    expect(screen.getByText('german roach, ant')).toBeTruthy();
  });

  it('never quotes a call summary', () => {
    render(<JobCardCustomerRequest D={D} request={{ text: 'Ants are back by the pool', source: 'call', pests: [] }} />);
    expect(screen.getByText('From the call (AI summary):', { exact: false })).toBeTruthy();
    expect(screen.getByText('Ants are back by the pool')).toBeTruthy();
    expect(screen.queryByText(/“/)).toBeNull();
  });

  it('renders nothing when nothing was recorded', () => {
    const { container } = render(<JobCardCustomerRequest D={D} request={null} />);
    expect(container.textContent).toBe('');
    const empty = render(<JobCardCustomerRequest D={D} request={{ text: null, source: 'office', pests: [] }} />);
    expect(empty.container.textContent).toBe('');
  });
});

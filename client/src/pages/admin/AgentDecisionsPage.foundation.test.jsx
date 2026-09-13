// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import AgentDecisionsPage from './AgentDecisionsPage';
import { adminFetch } from '../../utils/admin-fetch';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });

it('preserves the decision correction payload from the shared review fields', async () => {
  let resolveReview;
  const reviewResponse = new Promise((resolve) => { resolveReview = resolve; });
  adminFetch.mockImplementation(async (url, options) => {
    if (options?.method) return reviewResponse;
    if (url.endsWith('/context')) return { context: {} };
    return { decisions: [{ id: 'fixture-decision', status: 'pending', customerName: 'Fixture customer', recommendedActions: ['call_customer'] }] };
  });
  render(<MemoryRouter><AgentDecisionsPage /></MemoryRouter>);
  const actions = await screen.findByLabelText('Corrected actions');
  fireEvent.change(actions, { target: { value: 'call_customer, schedule_visit\n send_estimate' } });
  fireEvent.change(screen.getByLabelText('Review reason'), { target: { value: 'Fixture correction' } });
  const correctButton = screen.getByRole('button', { name: 'Correct', exact: true });
  fireEvent.click(correctButton);
  await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/agent-decisions/fixture-decision/review', {
    method: 'POST', body: JSON.stringify({ verdict: 'corrected', correctedActions: ['call_customer', 'schedule_visit', 'send_estimate'], correctionNote: 'Fixture correction' }),
  }));
  expect(correctButton).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('button', { name: 'Accept', exact: true })).not.toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('button', { name: 'Dismiss', exact: true })).not.toHaveAttribute('aria-busy', 'true');
  resolveReview({});
  await waitFor(() => expect(correctButton).not.toHaveAttribute('aria-busy', 'true'));
});

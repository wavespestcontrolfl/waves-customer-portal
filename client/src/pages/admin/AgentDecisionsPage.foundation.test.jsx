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
  adminFetch.mockImplementation(async (url, options) => {
    if (options?.method) return {};
    if (url.endsWith('/context')) return { context: {} };
    return { decisions: [{ id: 'fixture-decision', status: 'pending', customerName: 'Fixture customer', recommendedActions: ['call_customer'] }] };
  });
  render(<MemoryRouter><AgentDecisionsPage /></MemoryRouter>);
  const actions = await screen.findByLabelText('Corrected actions');
  fireEvent.change(actions, { target: { value: 'call_customer, schedule_visit\n send_estimate' } });
  fireEvent.change(screen.getByLabelText('Review reason'), { target: { value: 'Fixture correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Correct', exact: true }));
  await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/agent-decisions/fixture-decision/review', {
    method: 'POST', body: JSON.stringify({ verdict: 'corrected', correctedActions: ['call_customer', 'schedule_visit', 'send_estimate'], correctionNote: 'Fixture correction' }),
  }));
});

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
  await waitFor(() => expect(actions).toHaveValue('call_customer'));
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

it('keeps in-progress review text when a pending background read resolves', async () => {
  let resolveBackground;
  let listReads = 0;
  adminFetch.mockImplementation((url) => {
    if (url.endsWith('/context')) return Promise.resolve({ context: {} });
    listReads += 1;
    if (listReads === 1) {
      return Promise.resolve({ decisions: [{ id: 'fixture-decision', status: 'pending', customerName: 'Fixture customer', recommendedActions: ['call_customer'] }] });
    }
    return new Promise((resolve) => { resolveBackground = resolve; });
  });
  render(<MemoryRouter><AgentDecisionsPage /></MemoryRouter>);
  const reason = await screen.findByLabelText('Review reason');
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(listReads).toBe(2));
  fireEvent.change(reason, { target: { value: 'Keep this correction' } });
  resolveBackground({ decisions: [{ id: 'replacement', status: 'pending', customerName: 'Replacement', recommendedActions: [] }] });
  await waitFor(() => expect(reason).toHaveValue('Keep this correction'));
    expect(screen.getAllByText('Fixture customer').length).toBeGreaterThan(0);
  expect(screen.queryByText('Replacement')).not.toBeInTheDocument();
});

it('initializes reply fields when switching away from an edited decision whose context uses no IDs', async () => {
  adminFetch.mockImplementation(async (url) => {
    if (url.endsWith('/context')) return { context: {} };
    return {
      decisions: [
        { id: 'decision-a', status: 'pending', customerName: 'Customer A', recommendedActions: [], suggestedMessage: 'Suggested A' },
        { id: 'decision-b', status: 'pending', customerName: 'Customer B', recommendedActions: [], suggestedMessage: 'Suggested B' },
      ],
    };
  });
  render(<MemoryRouter><AgentDecisionsPage /></MemoryRouter>);

  const reply = await screen.findByLabelText('Final / rewrite reply');
  await waitFor(() => expect(reply).toHaveValue('Suggested A'));
  fireEvent.change(reply, { target: { value: 'Edited A' } });

  fireEvent.click(screen.getByText('Customer B'));
  await waitFor(() => expect(reply).toHaveValue('Suggested B'));
});

it('clears and disables reply training when the next decision context fails', async () => {
  let rejectContext;
  adminFetch.mockImplementation(async (url) => {
    if (url === '/admin/agent-decisions/decision-b/context') {
      return new Promise((resolve, reject) => { rejectContext = reject; });
    }
    if (url.endsWith('/context')) return { context: { actualHumanReply: { body: 'Human reply A' } } };
    return { decisions: [
      { id: 'decision-a', status: 'pending', customerName: 'Customer A', suggestedMessage: 'Suggested A' },
      { id: 'decision-b', status: 'pending', customerName: 'Customer B', suggestedMessage: 'Suggested B' },
    ] };
  });
  render(<MemoryRouter><AgentDecisionsPage /></MemoryRouter>);
  const reply = await screen.findByLabelText('Final / rewrite reply');
  await waitFor(() => expect(reply).toHaveValue('Suggested A'));
  fireEvent.change(reply, { target: { value: 'Edited A' } });
  fireEvent.click(screen.getByText('Customer B'));
  await waitFor(() => expect(rejectContext).toBeTypeOf('function'));
  expect(reply).toHaveValue('');
  expect(reply).toBeDisabled();
  rejectContext(new Error('Context unavailable'));
  await screen.findByText('Context unavailable');
  expect(screen.getByLabelText('Actual human reply')).toHaveValue('');
  for (const name of ['Accept draft', 'Edit & save', 'Reject & rewrite', 'No reply needed']) {
    const button = screen.getByRole('button', { name });
    expect(button).toBeDisabled();
    fireEvent.click(button);
  }
  expect(adminFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
});

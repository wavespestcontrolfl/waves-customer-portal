// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AgentDecisionsPage from './AgentDecisionsPage';
import { adminFetch } from '../../utils/admin-fetch';

const { refresh } = vi.hoisted(() => ({ refresh: { callback: null } }));

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
vi.mock('../../hooks/useVisiblePageRefresh', () => ({
  default: (callback) => {
    refresh.callback = callback;
  },
}));
beforeEach(() => { refresh.callback = null; });
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
  act(() => { void refresh.callback(); });
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

it('clears a decision refresh error after a successful automatic poll', async () => {
  adminFetch.mockImplementation(async (url) => url.endsWith('/context')
    ? { context: {} }
    : { decisions: [{ id: 'decision-a', customerName: 'Customer A', recommendedActions: [] }] });
  render(<MemoryRouter><AgentDecisionsPage /></MemoryRouter>);
  await screen.findByLabelText('Final / rewrite reply');
  await waitFor(() => expect(screen.getByLabelText('Final / rewrite reply')).toBeEnabled());
  adminFetch.mockRejectedValueOnce(new Error('Decision refresh failed'));
  await act(async () => refresh.callback());
  await screen.findByText('Decision refresh failed');
  await act(async () => refresh.callback());
  await waitFor(() => expect(screen.queryByText('Decision refresh failed')).not.toBeInTheDocument());
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
});

it('clears foreground loading when a newer background poll wins', async () => {
  let resolveRetry;
  let listReads = 0;
  adminFetch.mockImplementation((url) => {
    if (url.endsWith('/context')) return Promise.resolve({ context: {} });
    listReads += 1;
    if (listReads === 1) return Promise.resolve({ decisions: [] });
    if (listReads === 2) return Promise.reject(new Error('Decision refresh failed'));
    if (listReads === 3) return new Promise((resolve) => { resolveRetry = resolve; });
    return Promise.resolve({ decisions: [] });
  });

  render(<MemoryRouter><AgentDecisionsPage /></MemoryRouter>);
  await screen.findByText('No decisions found.');

  await act(async () => refresh.callback());
  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(listReads).toBe(3));
  expect(screen.getByText('Loading decisions...')).toBeInTheDocument();

  await act(async () => refresh.callback());
  expect(await screen.findByText('No decisions found.')).toBeInTheDocument();
  expect(screen.queryByText('Loading decisions...')).not.toBeInTheDocument();

  await act(async () => resolveRetry({ decisions: [{ id: 'stale' }] }));
  expect(screen.queryByText('Unknown customer')).not.toBeInTheDocument();
});

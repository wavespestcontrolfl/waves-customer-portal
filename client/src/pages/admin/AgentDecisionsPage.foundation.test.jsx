// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AgentDecisionsPage from './AgentDecisionsPage';
import { adminFetch } from '../../utils/admin-fetch';

const { refresh } = vi.hoisted(() => ({ refresh: { callback: null, enabled: false } }));

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
vi.mock('../../hooks/useVisiblePageRefresh', () => ({
  default: (callback, options) => {
    refresh.callback = callback;
    refresh.enabled = options?.enabled ?? true;
  },
}));
beforeEach(() => { refresh.callback = null; refresh.enabled = false; });
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

it('initializes reply fields when a correction is edited while context is loading', async () => {
  let resolveContext;
  adminFetch.mockImplementation((url) => {
    if (url.endsWith('/context')) {
      return new Promise((resolve) => { resolveContext = resolve; });
    }
    return Promise.resolve({
      decisions: [{
        id: 'decision-a',
        customerName: 'Customer A',
        recommendedActions: ['call_customer'],
        suggestedMessage: 'Suggested reply',
      }],
    });
  });

  render(<MemoryRouter><AgentDecisionsPage /></MemoryRouter>);
  const reason = await screen.findByLabelText('Review reason');
  await waitFor(() => expect(resolveContext).toBeTypeOf('function'));
  fireEvent.change(reason, { target: { value: 'Keep this correction' } });

  await act(async () => resolveContext({
    context: { actualHumanReply: { body: 'Human reply' } },
    replyTraining: {
      actualHumanReply: 'Recorded human reply',
      outboundBody: 'Recorded final reply',
      reviewNote: 'Recorded review note',
      scenarioLabel: 'scheduling',
    },
  }));

  expect(reason).toHaveValue('Keep this correction');
  expect(screen.getByLabelText('Actual human reply')).toHaveValue('Recorded human reply');
  expect(screen.getByLabelText('Final / rewrite reply')).toHaveValue('Recorded final reply');
  expect(screen.getByLabelText('Review note')).toHaveValue('Recorded review note');
  expect(screen.getByLabelText('Scenario label')).toHaveValue('scheduling');
  expect(screen.getByRole('button', { name: 'Edit & save' })).toBeEnabled();
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

it('preserves a failed decision action while automatic polls clear only read errors', async () => {
  let failNextRead = false;
  adminFetch.mockImplementation((url, options) => {
    if (options?.method === 'POST') return Promise.reject(new Error('Decision action failed'));
    if (url.endsWith('/context')) return Promise.resolve({ context: {} });
    if (failNextRead) {
      failNextRead = false;
      return Promise.reject(new Error('Decision read failed'));
    }
    return Promise.resolve({
      decisions: [{ id: 'decision-a', customerName: 'Customer A', recommendedActions: [] }],
    });
  });

  render(<MemoryRouter><AgentDecisionsPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Accept', exact: true }));
  await screen.findByText('Decision action failed');

  failNextRead = true;
  await act(async () => refresh.callback());
  expect(screen.getByText('Decision action failed')).toBeInTheDocument();
  expect(screen.getByText('Decision read failed')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1);

  await act(async () => refresh.callback());
  expect(screen.getByText('Decision action failed')).toBeInTheDocument();
  expect(screen.queryByText('Decision read failed')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
});

it('invalidates a pending list poll when reply training starts', async () => {
  let resolvePoll;
  let resolveAction;
  let listReads = 0;
  const decisions = [
    { id: 'decision-a', customerName: 'Customer A', recommendedActions: [], suggestedMessage: 'Suggested A' },
    { id: 'decision-b', customerName: 'Customer B', recommendedActions: [], suggestedMessage: 'Suggested B' },
  ];
  adminFetch.mockImplementation((url, options) => {
    if (url.endsWith('/reply-training') && options?.method === 'POST') {
      return new Promise((resolve) => { resolveAction = resolve; });
    }
    if (url.endsWith('/context')) return Promise.resolve({ context: {} });
    listReads += 1;
    if (listReads === 1) return Promise.resolve({ decisions });
    return new Promise((resolve) => { resolvePoll = resolve; });
  });

  render(<MemoryRouter><AgentDecisionsPage /></MemoryRouter>);
  const reply = await screen.findByLabelText('Final / rewrite reply');
  await waitFor(() => expect(reply).toHaveValue('Suggested A'));

  let pollPromise;
  act(() => { pollPromise = refresh.callback(); });
  await waitFor(() => expect(resolvePoll).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: 'Accept draft' }));
  await waitFor(() => expect(resolveAction).toBeTypeOf('function'));

  await act(async () => {
    resolvePoll({ decisions: [decisions[1]] });
    await pollPromise;
  });
  expect(screen.getAllByText('Customer A').length).toBeGreaterThan(0);
  expect(screen.queryByText('Customer B')).toBeInTheDocument();

  await act(async () => resolveAction({
    replyTraining: { outboundBody: 'Saved reply A', verdict: 'accepted' },
  }));
  await waitFor(() => expect(reply).toHaveValue('Saved reply A'));
});

it('does not apply an older reply-training response or baseline to a newer selection', async () => {
  let resolveAction;
  const decisions = [
    { id: 'decision-a', customerName: 'Customer A', recommendedActions: [], suggestedMessage: 'Suggested A' },
    { id: 'decision-b', customerName: 'Customer B', recommendedActions: [], suggestedMessage: 'Suggested B' },
  ];
  adminFetch.mockImplementation((url, options) => {
    if (url.endsWith('/reply-training') && options?.method === 'POST') {
      return new Promise((resolve) => { resolveAction = resolve; });
    }
    if (url.endsWith('/context')) return Promise.resolve({ context: {} });
    return Promise.resolve({ decisions });
  });

  render(<MemoryRouter><AgentDecisionsPage /></MemoryRouter>);
  const reply = await screen.findByLabelText('Final / rewrite reply');
  await waitFor(() => expect(reply).toHaveValue('Suggested A'));
  fireEvent.click(screen.getByRole('button', { name: 'Accept draft' }));
  await waitFor(() => expect(resolveAction).toBeTypeOf('function'));

  fireEvent.click(screen.getByText('Customer B'));
  await waitFor(() => expect(reply).toHaveValue('Suggested B'));
  fireEvent.change(reply, { target: { value: 'Suggested A' } });

  await act(async () => resolveAction({
    replyTraining: {
      outboundBody: 'Action response for A',
      reviewedBy: 'A reviewer',
      verdict: 'accepted',
    },
  }));
  expect(reply).toHaveValue('Suggested A');
  expect(screen.queryByText('Reviewed by A reviewer')).not.toBeInTheDocument();
  await waitFor(() => expect(refresh.enabled).toBe(false));
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

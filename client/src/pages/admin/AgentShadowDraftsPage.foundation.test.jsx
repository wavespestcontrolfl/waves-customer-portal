// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import AgentShadowDraftsPage from './AgentShadowDraftsPage';
import { adminFetch } from '../../utils/admin-fetch';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });

const fixtures = {
  profiles: {
    pending: { id: 'pending-profile', version: 2, profile_text: 'Pending voice guidance.' },
    approved: { id: 'live-profile', version: 1, profile_text: 'Live voice guidance.' },
  },
  exam: {
    gateEnabled: true,
    currentVersion: 'draft-v4',
    examRequiredForGraduation: false,
    items: { active: 3, total: 3 },
    runs: [],
    legs: {},
  },
  pathology: {
    gateEnabled: true,
    currentVersion: 'draft-v4',
    cells: [],
    proposals: [{
      id: 'proposal-1',
      status: 'pending',
      surface: 'scheduling',
      failure_mode: 'invented_fact',
      evidence_count: 4,
      proposal: 'Keep scheduling claims tied to verified facts.',
    }],
  },
  modes: {
    gateEnabled: true,
    autoSendGateEnabled: false,
    intents: [{
      intent: 'general_question',
      mode: 'suggest',
      suggest: {},
      graduation: { eligibleFor: 'auto_send', nextRung: 'auto_send', judge: {} },
    }],
  },
};

function mockShadowData(onMutation = async () => ({}), onRead) {
  adminFetch.mockImplementation(async (url, options) => {
    if (options?.method) return onMutation(url, options);
    if (onRead) {
      const override = await onRead(url);
      if (override !== undefined) return override;
    }
    if (url.endsWith('/voice-profiles')) return fixtures.profiles;
    if (url.endsWith('/shadow-drafts')) return { drafts: [] };
    if (url.endsWith('/shadow-scores')) return { intents: [] };
    if (url.endsWith('/intent-modes')) return fixtures.modes;
    if (url.endsWith('/sealed-eval')) return fixtures.exam;
    if (url.endsWith('/pathology')) return fixtures.pathology;
    return {};
  });
}

function mutationCalls() {
  return adminFetch.mock.calls.filter(([, options]) => options?.method);
}

async function openAndConfirm(triggerName, heading, confirmLabel) {
  fireEvent.click(await screen.findByRole('button', { name: triggerName }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('heading', { name: heading })).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: confirmLabel }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

it('cancels the live voice approval without a write and restores the original trigger', async () => {
  mockShadowData();
  const nativeConfirm = vi.spyOn(window, 'confirm');
  render(<AgentShadowDraftsPage />);

  const approve = await screen.findByRole('button', { name: 'Approve — make this the live voice' });
  fireEvent.click(approve);
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('It becomes the live voice guidance for the phone agent (and any future consumer). The previous approved version is superseded.')).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(mutationCalls()).toHaveLength(0);
  expect(nativeConfirm).not.toHaveBeenCalled();
  expect(approve).toHaveFocus();
});

it('preserves every confirmed endpoint and payload behind the shared dialog', async () => {
  mockShadowData();
  render(<AgentShadowDraftsPage />);

  await openAndConfirm(
    'Approve — make this the live voice',
    'Approve voice profile v2?',
    'Approve — make this the live voice',
  );
  await openAndConfirm(
    'Revoke — back to base voice',
    'Revoke voice profile v1?',
    'Revoke — back to base voice',
  );
  await openAndConfirm(
    'Top up sealed items',
    'Top up the sealed exam set?',
    'Top up sealed items',
  );
  await openAndConfirm(
    'Run exam — Claude leg',
    'Run the sealed exam on the Claude leg?',
    'Run exam — Claude leg',
  );
  await openAndConfirm(
    'Accept — worth building (ships as a new prompt version)',
    'Accept this patch proposal (scheduling · invented fact)?',
    'Accept — worth building',
  );
  await openAndConfirm(
    'Enable auto-send',
    'Enable AUTONOMOUS auto-send for "general question"?',
    'Enable auto-send',
  );

  expect(mutationCalls()).toEqual([
    ['/admin/agents/voice-profiles/pending-profile/review', { method: 'POST', body: JSON.stringify({ action: 'approve' }) }],
    ['/admin/agents/voice-profiles/live-profile/review', { method: 'POST', body: JSON.stringify({ action: 'revoke' }) }],
    ['/admin/agents/sealed-eval/seal', { method: 'POST' }],
    ['/admin/agents/sealed-eval/runs', { method: 'POST', body: JSON.stringify({ providerLeg: 'anthropic' }) }],
    ['/admin/agents/pathology/proposals/proposal-1/review', { method: 'POST', body: JSON.stringify({ action: 'accept' }) }],
    ['/admin/agents/intent-modes/general_question', {
      method: 'PUT',
      body: JSON.stringify({ mode: 'auto_send', reason: 'Promoted to auto-send from the readiness chip.' }),
    }],
  ]);
});

it('guards a pending confirmation from duplicate writes and keeps a failed action retryable', async () => {
  let rejectFirstAttempt;
  let attempts = 0;
  mockShadowData(async (url) => {
    if (!url.endsWith('/voice-profiles/pending-profile/review')) return {};
    attempts += 1;
    if (attempts === 1) {
      return new Promise((resolve, reject) => { rejectFirstAttempt = reject; });
    }
    return {};
  });
  render(<AgentShadowDraftsPage />);

  fireEvent.click(await screen.findByRole('button', { name: 'Approve — make this the live voice' }));
  const dialog = screen.getByRole('dialog');
  const confirm = within(dialog).getByRole('button', { name: 'Approve — make this the live voice' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(mutationCalls()).toHaveLength(1);
  expect(confirm).toBeDisabled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(dialog).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();

  await act(async () => rejectFirstAttempt(new Error('Voice review is temporarily unavailable.')));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Voice review is temporarily unavailable.');
  expect(confirm).toBeEnabled();

  fireEvent.click(confirm);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(mutationCalls()).toHaveLength(2);
});

it.each([
  ['Approve — make this the live voice', 'Approve — make this the live voice', '/voice-profiles', 'Voice profile updated'],
  ['Revoke — back to base voice', 'Revoke — back to base voice', '/voice-profiles', 'Voice profile updated'],
  ['Top up sealed items', 'Top up sealed items', '/sealed-eval', 'Sealed items were updated'],
  ['Run exam — Claude leg', 'Run exam — Claude leg', '/sealed-eval', 'The exam run started'],
  ['Accept — worth building (ships as a new prompt version)', 'Accept — worth building', '/pathology', 'Patch proposal updated'],
  ['Enable auto-send', 'Enable auto-send', '/intent-modes', 'Auto-send mode was enabled'],
])('retries only the read after %s succeeds but its refresh fails', async (triggerName, confirmName, readPath, message) => {
  let writeCompleted = false;
  let failedRefresh = false;
  mockShadowData(
    async () => {
      writeCompleted = true;
      return {};
    },
    async (url) => {
      if (url.endsWith(readPath) && writeCompleted && !failedRefresh) {
        failedRefresh = true;
        throw new Error('Synthetic refresh failure.');
      }
      return undefined;
    },
  );
  render(<AgentShadowDraftsPage />);

  fireEvent.click(await screen.findByRole('button', { name: triggerName }));
  const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: confirmName });
  fireEvent.click(confirm);

  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const alert = (await screen.findByText(new RegExp(message))).closest('[role="alert"]');
  expect(alert).toHaveTextContent(message);
  expect(mutationCalls()).toHaveLength(1);

  fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(alert).not.toBeInTheDocument());
  expect(mutationCalls()).toHaveLength(1);
});

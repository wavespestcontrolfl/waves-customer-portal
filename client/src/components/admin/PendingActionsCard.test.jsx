// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import PendingActionsCard from './PendingActionsCard';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const action = { id: 'fixture-card', tool: 'update_customer', summary: 'Update test field', expiresInMs: 600000, receivedAt: 1000000 };

test('remounting after clarification keeps the original expiration deadline', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  const first = render(<PendingActionsCard actions={[action]} variant="light" />);
  expect(screen.getByText('Expires in 10:00')).toBeTruthy();
  first.unmount();
  vi.setSystemTime(1600001);
  render(<PendingActionsCard actions={[action]} variant="light" />);
  expect(screen.queryByRole('button', { name: 'Confirm' })?.disabled ?? true).toBe(true);
  expect(screen.queryByText('Expires in 10:00')).toBeNull();
});

test('resolved cards do not offer another confirmation after a follow-up', () => {
  render(<PendingActionsCard actions={[{ ...action, resolvedStatus: 'confirmed' }]} variant="light" />);
  expect(screen.getByText('✓ Done')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
});

test('an unknown confirm outcome is neither done nor failed and never re-offers confirmation', async () => {
  localStorage.setItem('waves_admin_token', 'fixture-token');
  const body = { success: false, outcome: 'outcome_unknown', tool: 'send_email_reply', result: { outcome_unknown: true, warning: 'Gmail did not confirm the send outcome. Check the sent thread before creating another send.' } };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
  const onResolved = vi.fn();
  render(<PendingActionsCard actions={[{ ...action, tool: 'send_email_reply', receivedAt: Date.now() }]} variant="light" onResolved={onResolved} />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByText('Outcome unknown — check before retrying')).toBeTruthy();
  expect(screen.getByText(body.result.warning)).toBeTruthy();
  expect(screen.queryByText('✓ Done')).toBeNull();
  expect(screen.queryByText('Failed — see error above')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 'fixture-card' }), 'confirm', body);
  vi.unstubAllGlobals();
});

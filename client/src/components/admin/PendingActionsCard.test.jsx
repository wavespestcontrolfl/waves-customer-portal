// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

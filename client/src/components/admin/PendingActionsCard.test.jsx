// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PendingActionsCard from './PendingActionsCard';

const action = { id: '11111111-1111-4111-8111-111111111111', tool: 'create_restock_request', summary: 'Save synthetic restock request', expiresInMs: 600000 };
const response = (body) => ({ ok: true, json: async () => body });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('renders a blocked domain result as failed, never Done', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ success: false, outcome: 'blocked', result: { blocked: true, message: 'Duplicate request' } })));
  render(<PendingActionsCard actions={[action]} variant="light" />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByText('Duplicate request')).toBeInTheDocument();
  expect(screen.queryByText('✓ Done')).not.toBeInTheDocument();
});

it('reconciles a dropped confirm response by reading the saved outcome without a second write', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Network lost'))
    .mockResolvedValueOnce(response({ success: true, outcome: 'completed', result: { request_id: 'synthetic-request' } }));
  vi.stubGlobal('fetch', fetch);
  render(<PendingActionsCard actions={[action]} variant="light" />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByText('✓ Done')).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][1].method).toBe('POST');
  expect(fetch.mock.calls[1][0]).toContain('/actions/');
  expect(fetch.mock.calls[1][1].method).toBeUndefined();
});

it('shows unknown after a consumed approval loses its receipt and offers only a status check', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Network lost'))
    .mockResolvedValue(response({ success: false, outcome: 'outcome_unknown', result: null })));
  render(<PendingActionsCard actions={[action]} variant="light" />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByText('Outcome unknown')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check status' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
});

it('preserves a settled card when a clarification adds another proposal', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ success: true, outcome: 'provider_accepted' })));
  const view = render(<PendingActionsCard actions={[action]} variant="light" />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByText('Accepted by provider')).toBeInTheDocument();
  view.rerender(<PendingActionsCard actions={[action, { ...action, id: '22222222-2222-4222-8222-222222222222' }]} variant="light" />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Confirm' })).toHaveLength(1));
  expect(screen.getByText('Accepted by provider')).toBeInTheDocument();
});

it('restores failed receipt details and accepted-provider warnings after reload', () => {
  render(<PendingActionsCard actions={[
    { ...action, receipt: { outcome: 'failed', result: { error: 'Saved validation failure' } } },
    { ...action, id: 'another', receipt: { outcome: 'provider_accepted', result: { warning: 'Accepted; delivery has not been established' } } },
  ]} variant="light" />);
  expect(screen.getByText('Saved validation failure')).toBeInTheDocument();
  expect(screen.getByText('Accepted; delivery has not been established')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
});

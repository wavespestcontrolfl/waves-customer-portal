// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PendingActionsCard from './PendingActionsCard';

const action = { id: '11111111-1111-4111-8111-111111111111', tool: 'create_restock_request', summary: 'Save synthetic restock request', expiresInMs: 600000 };
const response = (body) => ({ ok: true, json: async () => body });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('renders a blocked domain result as failed, never Done', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ success: false, outcome: 'blocked', result: { blocked: true, message: 'Duplicate request' } })));
  render(<PendingActionsCard actions={[action]} variant="light" />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByText('Duplicate request')).toBeInTheDocument();
  expect(screen.queryByText('✓ Done')).not.toBeInTheDocument();
});

it('Codex #4715 r4 P2: a blocked receipt whose result carries only `message` (no warning/error) keeps alert styling, not the neutral success token', async () => {
  // schedule-tools.js and others return exactly this shape on a refusal:
  // `{ blocked: true, message: '...' }` — no `warning`/`error` string. The
  // neutral-styling predicate used to treat ANY message-only result as a
  // plain success note; it must require receiptState's own verdict
  // ('confirmed') first, so a failed/blocked outcome always stays alert-red.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ success: false, outcome: 'blocked', result: { blocked: true, message: 'Duplicate request' } })));
  render(<PendingActionsCard actions={[action]} variant="light" />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  const detail = await screen.findByText('Duplicate request');
  expect(detail.className).toContain('text-alert-fg');
  expect(detail.className).not.toContain('text-zinc-700');
});

it('Codex #4715 r4 P2: a completed receipt whose result carries only `message` still gets the neutral success token', async () => {
  // The churn billing wind-down receipt (tools.js) is the real-world shape
  // this predicate exists for: `success: true` / outcome 'completed', a
  // plain `message`, no warning/error — must render neutral, not alert-red.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
    success: true, outcome: 'completed',
    result: { message: 'Billing wound down: Auto Pay off (customer + saved methods), next charge date and armed retries cleared.' },
  })));
  render(<PendingActionsCard actions={[action]} variant="light" />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  const detail = await screen.findByText(/Billing wound down/);
  expect(detail.className).toContain('text-zinc-700');
  expect(detail.className).not.toContain('text-alert-fg');
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

it('a dropped confirm response reports the receipt to the host as a confirm decision', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Network lost'))
    .mockResolvedValueOnce(response({ success: true, outcome: 'completed', result: { request_id: 'synthetic-request' } }));
  vi.stubGlobal('fetch', fetch);
  const onResolved = vi.fn();
  render(<PendingActionsCard actions={[action]} variant="light" onResolved={onResolved} />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByText('✓ Done')).toBeInTheDocument();
  // Hosts refresh only on a confirm decision; the reconciled receipt must not arrive as a bare status check.
  expect(onResolved).toHaveBeenCalledTimes(1);
  expect(onResolved.mock.calls[0][1]).toBe('confirm');
  expect(onResolved.mock.calls[0][2]).toMatchObject({ success: true, outcome: 'completed' });
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

test('remounting after clarification keeps the original expiration deadline', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  const first = render(<PendingActionsCard actions={[{ ...action, receivedAt: 1000000 }]} variant="light" />);
  expect(screen.getByText('Expires in 10:00')).toBeTruthy();
  first.unmount();
  vi.setSystemTime(1600001);
  render(<PendingActionsCard actions={[{ ...action, receivedAt: 1000000 }]} variant="light" />);
  expect(screen.queryByRole('button', { name: 'Confirm' })?.disabled ?? true).toBe(true);
  expect(screen.queryByText('Expires in 10:00')).toBeNull();
});

test('resolved cards do not offer another confirmation after a follow-up', () => {
  render(<PendingActionsCard actions={[{ ...action, resolvedStatus: 'confirmed' }]} variant="light" />);
  expect(screen.getByText('✓ Done')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
});

test('renders the saved request lifecycle and link from a verified receipt, including after recovery', async () => {
  const receipt = { success: true, outcome: 'completed', result: {
    verification: { persisted: true, request_id: 'request-1' },
    receipt: { label: 'Restock request saved', summary: 'Synthetic product: 2 lb; request open. No vendor order was submitted.', href: '/admin/inventory?tab=restock' },
  } };
  vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Response lost')).mockResolvedValue(response(receipt)));
  const view = render(<PendingActionsCard actions={[action]} variant="light" />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByText('Restock request saved')).toBeVisible();
  expect(screen.getByText(/No vendor order was submitted/)).toBeVisible();
  expect(screen.getByRole('link', { name: 'Open saved record' })).toHaveAttribute('href', '/admin/inventory?tab=restock');
  expect(screen.queryByText('✓ Done')).not.toBeInTheDocument();
  view.unmount();
  render(<PendingActionsCard actions={[{ ...action, receipt }]} variant="light" />);
  expect(screen.getByText('Restock request saved')).toBeVisible();
});

test('a recovered expired receipt asks for a fresh proposal without implying execution failed', () => {
  render(<PendingActionsCard actions={[{ ...action, contract: { action_label: 'Save request', approval: { required: true, reason: 'Confirm to run' } }, receipt: { outcome: 'expired', result: null } }]} variant="light" />);
  expect(screen.getByText('Expired proposal: Save request')).toBeTruthy();
  expect(screen.getByText(/no longer confirmable/)).toBeTruthy();
  expect(screen.queryByText(/Awaiting your confirmation/)).toBeNull();
  expect(screen.queryByText('Confirm to run')).toBeNull();
  expect(screen.queryByText('Failed')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
});

test('an unknown confirm outcome is neither done nor failed and never re-offers confirmation', async () => {
  localStorage.setItem('waves_admin_token', 'fixture-token');
  const body = { success: false, outcome: 'outcome_unknown', tool: 'send_email_reply', result: { outcome_unknown: true, warning: 'Gmail did not confirm the send outcome. Check the sent thread before creating another send.' } };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
  render(<PendingActionsCard actions={[{ ...action, tool: 'send_email_reply', receivedAt: Date.now() }]} variant="light" />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByText('Outcome unknown')).toBeTruthy();
  expect(screen.getByText(body.result.warning)).toBeTruthy();
  expect(screen.queryByText('✓ Done')).toBeNull();
  expect(screen.queryByText('Failed — see error above')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  vi.unstubAllGlobals();
});

it('Codex #5514 r5: a card stored as preview-only (minted before the commit path) offers no Confirm', () => {
  const stored = {
    id: '22222222-2222-4222-8222-222222222222',
    tool: 'set_railway_gate',
    expiresInMs: 600000,
    contract: {
      tier: 'yellow', action_label: 'Change a Railway feature gate', preview_only: true,
      effects: [{ kind: 'operational', label: 'Change: false → true' }],
    },
  };
  render(<PendingActionsCard actions={[stored]} variant="light" />);
  expect(screen.getByText(/Preview only: /)).toBeInTheDocument();
  expect(screen.queryByText(/Awaiting your confirmation/)).not.toBeInTheDocument();
  expect(screen.getByText(/made as a preview only and can't be applied/)).toBeInTheDocument();
  expect(screen.getByText(/Change: false → true/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
});

// Product picker + Show again (owner 2026-10-07).
const PICKER = {
  id: '33333333-3333-4333-8333-333333333333', tool: 'adjust_stock', expiresInMs: 600000, contract_hash: 'hash-choice',
  contract: {
    tier: 'yellow', action_label: 'Choose the product',
    effects: [{ kind: 'operational', label: 'Pick the product for this stock change (restock 78 fl_oz). Nothing changes until you pick a product and confirm the next card.' }],
    product_choices: [
      { product_id: 'aaaaaaaa-0000-4000-8000-00000000000a', name: 'Zentrovex 10% SC', container_size: '78 fl oz', unit: 'fl_oz', on_hand: 20, stock_after: 98, selectable: true },
      { product_id: 'aaaaaaaa-0000-4000-8000-00000000000b', name: 'Zentrovex 20% SC', container_size: '1 gal', unit: 'fl_oz', on_hand: null, stock_after: 78, selectable: true },
      { product_id: 'aaaaaaaa-0000-4000-8000-00000000000c', name: 'Zentrovex Granule', container_size: null, unit: 'lb', on_hand: 4, stock_after: null, selectable: false, reason: 'Cannot convert fl_oz to lb' },
    ],
  },
};
const NEXT_CARD = {
  id: '44444444-4444-4444-8444-444444444444', tool: 'adjust_stock', expiresInMs: 600000, contract_hash: 'hash-next',
  contract: { tier: 'yellow', action_label: 'Adjust inventory stock', effects: [{ kind: 'operational', label: 'Zentrovex 20% SC: restock 78 fl_oz; on hand 0 → 78 fl_oz' }] },
};

test.each(['light', 'dark'])('a picker card lists the shortlist and sends only the picked product id (%s)', async (variant) => {
  const fetch = vi.fn().mockResolvedValue(response({ success: true, outcome: 'completed', pendingAction: NEXT_CARD }));
  vi.stubGlobal('fetch', fetch);
  render(<PendingActionsCard actions={[PICKER]} variant={variant} />);
  expect(screen.getByText(/Awaiting your confirmation: Choose the product/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  const use = screen.getByRole('button', { name: 'Use this product' });
  expect(use).toBeDisabled();
  const radios = screen.getAllByRole('radio');
  expect(radios).toHaveLength(3);
  expect(radios[2]).toBeDisabled();
  expect(screen.getByText(/Cannot convert fl_oz to lb/)).toBeInTheDocument();
  expect(screen.getByText(/on hand not counted yet → 78 fl_oz/)).toBeInTheDocument();
  fireEvent.click(radios[1]);
  expect(use).toBeEnabled();
  fireEvent.click(use);
  expect(await screen.findByText('Product chosen. Confirm the new card below.')).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toContain('/admin/intelligence-bar/choose-product');
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
    pending_action_id: PICKER.id, product_id: 'aaaaaaaa-0000-4000-8000-00000000000b', contract_hash: 'hash-choice',
  });
  // The new card shows the exact before and after and is confirmed normally.
  expect(screen.getByText(/on hand 0 → 78 fl_oz/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
});

test('a refused pick keeps the card and shows why', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'That product was not on this card. Nothing was written.' }) }));
  render(<PendingActionsCard actions={[PICKER]} variant="light" />);
  fireEvent.click(screen.getAllByRole('radio')[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Use this product' }));
  expect(await screen.findByText('That product was not on this card. Nothing was written.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Use this product' })).toBeEnabled();
});

test.each(['light', 'dark'])('an expired card offers Show again and puts the fresh card below it (%s)', async (variant) => {
  const fetch = vi.fn().mockResolvedValue(response({ success: true, pendingAction: NEXT_CARD }));
  vi.stubGlobal('fetch', fetch);
  render(<PendingActionsCard actions={[{ ...action, receipt: { outcome: 'expired', result: null } }]} variant={variant} />);
  expect(screen.getByText(/Expired — this proposal is no longer confirmable/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show again' }));
  expect(await screen.findByText('Shown again below.')).toBeInTheDocument();
  expect(fetch.mock.calls[0][0]).toContain('/admin/intelligence-bar/show-again');
  expect(fetch.mock.calls[0][1].method).toBe('POST');
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ pending_action_id: action.id });
  expect(screen.queryByRole('button', { name: 'Show again' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  expect(screen.getByText('Expires in 10:00')).toBeInTheDocument();
});

test('a card that runs out of time while open offers Show again; a refusal stays on the expired card', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(2000000);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'Product not found' }) }));
  render(<PendingActionsCard actions={[{ ...action, receivedAt: 2000000 }]} variant="light" />);
  expect(screen.queryByRole('button', { name: 'Show again' })).toBeNull();
  vi.setSystemTime(2600001);
  act(() => { vi.advanceTimersByTime(1500); });
  expect(await screen.findByRole('button', { name: 'Show again' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show again' }));
  expect(await screen.findByText('Product not found')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Show again' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
});

test('a lost choose response replays the same request and shows the card the server already made', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Network lost'))
    .mockResolvedValueOnce(response({ success: true, replayed: true, pendingAction: NEXT_CARD }));
  vi.stubGlobal('fetch', fetch);
  render(<PendingActionsCard actions={[PICKER]} variant="light" />);
  fireEvent.click(screen.getAllByRole('radio')[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Use this product' }));
  expect(await screen.findByText('Product chosen. Confirm the new card below.')).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1][0]).toContain('/admin/intelligence-bar/choose-product');
  expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body);
  expect(screen.getByText(/on hand 0 → 78 fl_oz/)).toBeInTheDocument();
});

test('a follow-up card that the host list also carries after a refresh renders once', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ success: true, outcome: 'completed', pendingAction: NEXT_CARD })));
  const view = render(<PendingActionsCard actions={[PICKER]} variant="light" />);
  fireEvent.click(screen.getAllByRole('radio')[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Use this product' }));
  expect(await screen.findByText('Product chosen. Confirm the new card below.')).toBeInTheDocument();
  view.rerender(<PendingActionsCard actions={[PICKER, NEXT_CARD]} variant="light" />);
  expect(screen.getAllByRole('button', { name: 'Confirm' })).toHaveLength(1);
});

test('a refreshed host entry for a follow-up card wins: its settled receipt replaces the cached pending card', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ success: true, outcome: 'completed', pendingAction: NEXT_CARD })));
  const view = render(<PendingActionsCard actions={[PICKER]} variant="light" />);
  fireEvent.click(screen.getAllByRole('radio')[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Use this product' }));
  expect(await screen.findByText('Product chosen. Confirm the new card below.')).toBeInTheDocument();
  view.rerender(<PendingActionsCard actions={[PICKER, { ...NEXT_CARD, receipt: { outcome: 'canceled', result: null } }]} variant="light" />);
  expect(screen.getByText('Cancelled')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
});

test('Show again cannot be sent twice while its request is in flight', async () => {
  let release;
  const fetch = vi.fn(() => new Promise((resolve) => { release = () => resolve(response({ success: true, pendingAction: NEXT_CARD })); }));
  vi.stubGlobal('fetch', fetch);
  render(<PendingActionsCard actions={[{ ...action, receipt: { outcome: 'expired', result: null } }]} variant="light" />);
  fireEvent.click(screen.getByRole('button', { name: 'Show again' }));
  const busy = await screen.findByRole('button', { name: 'Showing again…' });
  expect(busy).toBeDisabled();
  fireEvent.click(busy);
  expect(fetch).toHaveBeenCalledTimes(1);
  release();
  expect(await screen.findByText('Shown again below.')).toBeInTheDocument();
});

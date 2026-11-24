// @vitest-environment jsdom
// Connect a bank opens Plaid's own screens, which can take minutes with no
// request open. The session holds an out-of-date tab's reload until it ends
// and its last request settles (lib/reloadHolds.js).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PlaidFeedsPanel } from './TaxPage.jsx';
import { reloadHoldNames } from '../../lib/reloadHolds';

let link;
let posts;

beforeEach(() => {
  link = null;
  posts = [];
  window.Plaid = { create: (config) => { link = config; return { open: () => {}, destroy: () => {} }; } };
  vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (options.method === 'POST') posts.push(path);
    let body = { itemId: 'item-1' };
    if (path.endsWith('/plaid/status')) body = { configured: true, tokenKey: true, env: 'sandbox', items: [] };
    if (path.endsWith('/plaid/link-token')) body = { linkToken: 'link-sandbox-1' };
    return { ok: true, status: 200, json: async () => body };
  }));
});

afterEach(() => {
  cleanup();
  delete window.Plaid;
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

async function openPlaid() {
  render(<PlaidFeedsPanel feedOn onSynced={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a bank' }));
  await waitFor(() => expect(link).not.toBeNull());
}

it('holds an out-of-date tab reload while Plaid is open, until the connection is saved', async () => {
  await openPlaid();
  expect(reloadHoldNames()).toContain('bank-link');
  await act(async () => link.onSuccess('public-sandbox-1', { institution: { name: 'Test Bank' } }));
  await waitFor(() => expect(posts).toContain('/api/admin/tax/bank-import/plaid/connect'));
  await waitFor(() => expect(reloadHoldNames()).not.toContain('bank-link'));
});

it('closing the Plaid window ends the hold, with no connection saved', async () => {
  await openPlaid();
  expect(reloadHoldNames()).toContain('bank-link');
  await act(async () => link.onExit(null));
  await waitFor(() => expect(reloadHoldNames()).not.toContain('bank-link'));
  expect(posts).not.toContain('/api/admin/tax/bank-import/plaid/connect');
});

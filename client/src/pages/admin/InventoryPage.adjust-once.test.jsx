// @vitest-environment jsdom
// Daily-work audit 11-06: "Apply Adjustment" stayed live while a save ran, so a
// double tap posted the same adjustment twice (+5 became +10). The button now
// locks while it saves, and each draft carries one key the server applies once.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductsTab } from './InventoryPage';
import { IntelligenceBarPageDataProvider } from '../../hooks/useIntelligenceBarPageData';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));

const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const product = { id: 'product-1', name: 'Synthetic product', inventoryOnHand: 10, inventoryUnit: 'lb', vendorPricing: [] };

let adjustReplies;
let movementReads;
beforeEach(() => {
  adjustReplies = [];
  movementReads = 0;
  localStorage.setItem('waves_admin_token', 'synthetic-token');
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    if (path.endsWith('/adjust') && opts.method === 'POST') return adjustReplies.shift() ?? response({ success: true });
    if (path.includes('/inventory?')) return response({ products: [product], total: 1 });
    if (path.endsWith('/vendors')) return response({ vendors: [] });
    if (path.endsWith('/label-pipeline')) return response({ enabled: false });
    if (path.endsWith('/movements')) { movementReads += 1; return response({ movements: [] }); }
    throw new Error(`Unexpected request: ${path}`);
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

const adjustBodies = () => fetch.mock.calls
  .filter(([url, opts]) => String(url).endsWith('/adjust') && opts?.method === 'POST')
  .map(([, opts]) => JSON.parse(opts.body));
const enterAmount = (value) => fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value } });
const apply = () => fireEvent.click(screen.getByRole('button', { name: 'Apply Adjustment' }));

async function openAdjustment(showToast = vi.fn()) {
  render(<MemoryRouter><IntelligenceBarPageDataProvider>
    <ProductsTab initialProductId="product-1" canAuthor showToast={showToast} />
  </IntelligenceBarPageDataProvider></MemoryRouter>);
  await screen.findByRole('button', { name: 'Apply Adjustment' });
  return showToast;
}

describe('Manual Adjustment applies a draft once', () => {
  it('a double tap posts one adjustment, and the button locks while it saves', async () => {
    const pending = deferred();
    adjustReplies.push(pending.promise);
    await openAdjustment();
    enterAmount('5');
    const button = screen.getByRole('button', { name: 'Apply Adjustment' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(adjustBodies()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Applying…' })).toBeDisabled();
    await act(async () => pending.resolve(response({ success: true })));
    expect(await screen.findByRole('button', { name: 'Apply Adjustment' })).toBeEnabled();
    expect(adjustBodies()).toHaveLength(1);
    expect(adjustBodies()[0]).toMatchObject({ movementType: 'restock', quantity: 5, unit: 'lb' });
    expect(adjustBodies()[0].idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  });

  it('a retry after a failed send reuses the draft key; the next adjustment gets a new key', async () => {
    adjustReplies.push(response({ error: 'Bad gateway' }, 502));
    const showToast = await openAdjustment();
    enterAmount('5');
    apply();
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Failed: HTTP 502'));
    expect(screen.getByPlaceholderText('Amount')).toHaveValue(5);
    apply();
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Inventory adjusted'));
    enterAmount('3');
    apply();
    await waitFor(() => expect(adjustBodies()).toHaveLength(3));
    const [first, retry, next] = adjustBodies();
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(next.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(next.quantity).toBe(3);
  });

  it('a 409 ends the draft: amount cleared, history re-read, and the next send has a new key', async () => {
    adjustReplies.push(response({ error: 'already saved' }, 409));
    const showToast = await openAdjustment();
    await waitFor(() => expect(movementReads).toBe(1));
    enterAmount('6');
    apply();
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/^Not applied\. Check Movement History/)));
    expect(screen.getByPlaceholderText('Amount')).toHaveValue(null);
    await waitFor(() => expect(movementReads).toBe(2));
    enterAmount('6');
    apply();
    await waitFor(() => expect(adjustBodies()).toHaveLength(2));
    expect(adjustBodies()[1].idempotencyKey).not.toBe(adjustBodies()[0].idempotencyKey);
  });
});

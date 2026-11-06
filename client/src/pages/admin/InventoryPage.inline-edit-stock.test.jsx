// @vitest-environment jsdom
// Daily-work audit 11-05: the Products row editor is filled from the list as it
// loaded, and a visit closeout since then may have used stock. A save must send
// only what the operator changed, and a changed count must name its start count.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductsTab } from './InventoryPage';

const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

let productsCalls;
let putStatus;
beforeEach(() => {
  productsCalls = 0;
  putStatus = 200;
  localStorage.setItem('waves_admin_token', 'test-token');
  const product = { id: 'product-1', name: 'Synthetic product', inventoryOnHand: 10, inventoryUnit: 'lb', lowStockThreshold: 2 };
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    if (opts.method === 'PUT') return response({ success: putStatus < 400 }, putStatus);
    if (String(url).includes('/admin/inventory?')) {
      productsCalls += 1;
      return response({ products: [product], categories: [], total: 1 });
    }
    if (String(url).endsWith('/vendors')) return response({ vendors: [] });
    if (String(url).endsWith('/label-pipeline')) return response({ enabled: false });
    throw new Error(`Unexpected request: ${url}`);
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const putBodies = () => fetch.mock.calls
  .filter(([, opts]) => opts?.method === 'PUT')
  .map(([, opts]) => JSON.parse(opts.body));

async function openEditor(showToast = vi.fn()) {
  render(<ProductsTab canAuthor showToast={showToast} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit', exact: true }));
  return showToast;
}

describe('ProductsTab inline edit and the stock count', () => {
  it('a name-only edit sends just the name, never the count the row opened with', async () => {
    await openEditor();
    fireEvent.change(screen.getByDisplayValue('Synthetic product'), { target: { value: 'Renamed product' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]).toEqual({ name: 'Renamed product' });
  });

  it('a changed count names the count it started from', async () => {
    await openEditor();
    fireEvent.change(screen.getByPlaceholderText('Stock'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]).toEqual({ inventoryOnHand: '12', inventoryOnHandBefore: 10 });
  });

  it('a refused count (409) closes the row, says the stock moved, and reloads the list', async () => {
    putStatus = 409;
    const showToast = await openEditor();
    fireEvent.change(screen.getByPlaceholderText('Stock'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'Stock changed after you opened this product. Edit it again to see the current count.',
    ));
    await waitFor(() => expect(productsCalls).toBe(2));
    expect(screen.queryByRole('button', { name: 'Save', exact: true })).not.toBeInTheDocument();
  });

  it('Save with nothing changed sends no request and closes the row', async () => {
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(screen.queryByRole('button', { name: 'Save', exact: true })).not.toBeInTheDocument();
    expect(putBodies()).toHaveLength(0);
  });
});

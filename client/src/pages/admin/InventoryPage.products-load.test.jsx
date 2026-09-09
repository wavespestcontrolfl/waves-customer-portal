// @vitest-environment jsdom
// UI audit F0474: a failed products load is an error with Retry, not "Loading products..." forever.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductsTab } from './InventoryPage';

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('InventoryPage ProductsTab load failure', () => {
  it('shows the error and a Retry that re-issues the products request', async () => {
    let productsCalls = 0;
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/admin/inventory?')) {
        productsCalls += 1;
        if (productsCalls === 1) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
        return { ok: true, json: async () => ({ products: [], categories: [], total: 0 }) };
      }
      return { ok: true, json: async () => ({ vendors: [] }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ProductsTab showToast={vi.fn()} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Failed to load products: HTTP 500/);
    expect(screen.queryByText('Loading products...')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(productsCalls).toBe(2));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});

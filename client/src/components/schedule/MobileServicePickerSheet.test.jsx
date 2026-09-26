// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MobileServicePickerSheet from './MobileServicePickerSheet';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// The mobile picker is a booking surface: it reads the same sellable,
// customer-scoped catalog the desktop pickers do, so a retired-for-sale row
// (quarterly T&S) is offered only to the customer already on that plan
// (codex r28 on #4786).
describe('MobileServicePickerSheet catalog load', () => {
  it('asks for sellable rows scoped to the checkout customer', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ services: [] }) }));
    vi.stubGlobal('fetch', fetcher);
    render(<MobileServicePickerSheet customerId="cust-1" onClose={() => {}} onSelect={() => {}} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    const url = String(fetcher.mock.calls[0][0]);
    expect(url).toContain('/admin/services?');
    expect(url).toContain('is_active=true');
    expect(url).toContain('sellable=true');
    expect(url).toContain('sellable_customer_id=cust-1');
  });

  it('still asks for sellable rows when no customer is known', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ services: [] }) }));
    vi.stubGlobal('fetch', fetcher);
    render(<MobileServicePickerSheet onClose={() => {}} onSelect={() => {}} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    const url = String(fetcher.mock.calls[0][0]);
    expect(url).toContain('sellable=true');
    expect(url).not.toContain('sellable_customer_id');
  });
});

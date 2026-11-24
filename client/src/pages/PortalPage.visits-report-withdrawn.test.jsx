// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeState = vi.hoisted(() => ({ enabled: true, platform: 'ios' }));
vi.mock('../native/platform', () => ({
  isNativeApp: () => nativeState.enabled,
  nativePlatform: () => nativeState.platform,
}));

vi.mock('../utils/api', () => {
  const target = { fetchRaw: vi.fn(), getServiceReportUrl: vi.fn((id) => `/api/documents/service-report/${id}`) };
  const proxy = new Proxy(target, {
    get: (obj, prop) => {
      if (typeof prop !== 'string') return obj[prop];
      if (!(prop in obj)) obj[prop] = vi.fn(() => new Promise(() => {}));
      return obj[prop];
    },
    set: (obj, prop, value) => { obj[prop] = value; return true; },
  });
  return { default: proxy };
});

import api from '../utils/api';
import { VisitsTab } from './PortalPage';
import { PortalReadProvider, usePortalRefresh } from '../hooks/usePortalRead';

const BrowserURL = globalThis.URL;
const customer = { id: 'cust-1', firstName: 'Pat', lastName: 'Customer', tier: 'Silver', property: {} };
const savedOnly = [{ id: 'cust-1:pa', key: 'cust-1:pa', customerId: 'cust-1', propertyId: 'pa', isPrimaryProperty: true, isPrimaryProfile: true, address: { line1: '1200 Palm Row Ct', city: 'Parrish', state: 'FL', zip: '34219' } }];

function RefreshButton() {
  const portal = usePortalRefresh();
  return <button type="button" onClick={() => portal.refresh({ preserveVerified: false })}>Refresh portal reads</button>;
}

const visit = (overrides = {}) => ({
  id: 'record-1', status: 'completed', date: '2026-11-10', type: 'Quarterly Pest Control',
  reportAvailable: true, reportUrl: null, reportPdfUrl: null, isProjectCompletion: false, ...overrides,
});

beforeEach(() => {
  nativeState.enabled = true;
  nativeState.platform = 'ios';
  vi.stubGlobal('URL', class extends BrowserURL {
    static createObjectURL = vi.fn(() => 'blob:completed-report');
    static revokeObjectURL = vi.fn();
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  api.fetchRaw.mockReset();
  api.fetchRaw.mockResolvedValue({
    ok: true,
    headers: { get: () => 'application/pdf' },
    blob: async () => new Blob(['report'], { type: 'application/pdf' }),
  });
  api.getSchedule.mockResolvedValue({ upcoming: [] });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Completed visits report preview', () => {
  it.each([
    ['the report access is withdrawn', [visit({ reportAvailable: false })]],
    ['the visit leaves the list', []],
  ])('closes an open PDF preview and revokes its blob when %s', async (_name, refreshed) => {
    api.getServices
      .mockResolvedValueOnce({ historyProperty: 'pa', historyCustomerId: customer.id, services: [visit()], total: 1 })
      .mockResolvedValue({ historyProperty: 'pa', historyCustomerId: customer.id, services: refreshed, total: refreshed.length });
    render(
      <PortalReadProvider enabled>
        <RefreshButton />
        <VisitsTab customer={customer} properties={savedOnly} activePropertyId="cust-1:pa" subTab="completed" onSubTabChange={() => {}} />
      </PortalReadProvider>
    );
    fireEvent.click(await screen.findByText('Quarterly Pest Control'));
    fireEvent.click(await screen.findByRole('button', { name: /Download/ }));
    expect(await screen.findByRole('dialog', { name: /Visit Report/ })).toBeInTheDocument();
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh portal reads' })); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Visit Report/ })).not.toBeInTheDocument());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:completed-report');
  });

  it('revokes the blob when the visits tab unmounts with a preview open', async () => {
    api.getServices.mockResolvedValue({ historyProperty: 'pa', historyCustomerId: customer.id, services: [visit()], total: 1 });
    const view = render(
      <PortalReadProvider enabled>
        <VisitsTab customer={customer} properties={savedOnly} activePropertyId="cust-1:pa" subTab="completed" onSubTabChange={() => {}} />
      </PortalReadProvider>
    );
    fireEvent.click(await screen.findByText('Quarterly Pest Control'));
    fireEvent.click(await screen.findByRole('button', { name: /Download/ }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:completed-report');
  });

  it('creates no blob URL for a PDF that finishes loading after the tab unmounts', async () => {
    api.getServices.mockResolvedValue({ historyProperty: 'pa', historyCustomerId: customer.id, services: [visit()], total: 1 });
    let finish;
    api.fetchRaw.mockReset();
    api.fetchRaw.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(
      <PortalReadProvider enabled>
        <VisitsTab customer={customer} properties={savedOnly} activePropertyId="cust-1:pa" subTab="completed" onSubTabChange={() => {}} />
      </PortalReadProvider>
    );
    fireEvent.click(await screen.findByText('Quarterly Pest Control'));
    fireEvent.click(await screen.findByRole('button', { name: /Download/ }));
    await waitFor(() => expect(api.fetchRaw).toHaveBeenCalled());
    view.unmount();
    await act(async () => {
      finish({ ok: true, headers: { get: () => 'application/pdf' }, blob: async () => new Blob(['late'], { type: 'application/pdf' }) });
    });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
// Invoice attachments on the pay page: in the Capacitor app a _blank link
// strands the webview, so the app saves through the share sheet instead.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PayPageV2 from './PayPageV2';

const native = vi.hoisted(() => ({ canSave: false, saveUrlNative: vi.fn(async () => true) }));
vi.mock('../native/nativeFile', () => ({
  isNativeApp: () => native.canSave,
  canSaveNative: () => native.canSave,
  canShareNative: () => native.canSave,
  saveUrlNative: (...args) => native.saveUrlNative(...args),
  shareUrlNative: vi.fn(async () => true),
}));

vi.mock('../glass/glass-engine', () => ({ useGlassSurface: vi.fn() }));
// PublicStateCard and BrandCard come through for real: they are leaf
// presentational components, and these suites assert on the terminal-state
// markup they produce. Everything heavier stays stubbed.
vi.mock('../components/brand', async (importOriginal) => ({
  ...(await importOriginal()),
  WavesShell: ({ children }) => <div>{children}</div>,
  CustomerColumn: ({ children, ...props }) => <div {...props}>{children}</div>,
  BrandCard: ({ children }) => <section>{children}</section>,
  BrandButton: ({ children, ...props }) => <button type="button" {...props}>{children}</button>,
  SerifHeading: ({ children }) => <h1>{children}</h1>,
  HelpPhoneLink: () => <span>call Waves</span>,
}));
vi.mock('../components/BrandFooter', () => ({ default: () => null }));
vi.mock('../components/DocumentActionBar', () => ({ default: () => null }));

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function payload(extra = {}) {
  return {
    invoice: {
      id: 'inv-1',
      invoiceNumber: 'WPC-2026-0123',
      title: 'Lawn care',
      status: 'sent',
      version: 1,
      saveRequired: false,
      captureNeeded: false,
      lineItems: [],
      subtotal: 150,
      discountAmount: 0,
      discountLabel: null,
      taxRate: 0,
      taxAmount: 0,
      total: 150,
      amountDue: 150,
      creditApplied: 0,
      dueDate: '2026-09-15',
      paidAt: null,
      notes: null,
      annualPrepay: null,
      attachments: [],
    },
    service: { type: 'Lawn care', date: '2026-08-20', productsApplied: [], photos: [] },
    customer: { firstName: 'Pat', lastName: 'Doe', email: 'pat@example.com', city: 'Parrish', state: 'FL', zip: '34219' },
    payer: null,
    processor: 'stripe',
    stripe: { available: false, publishableKey: null },
    ...extra,
  };
}

function stubFetch(body) {
  const fetchMock = vi.fn(async (url, init) => {
    if (!init || !init.method || init.method === 'GET') return response(200, body);
    return response(204, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/pay/deadbeefdeadbeefdeadbeef']}>
      <Routes>
        <Route path="/pay/:token" element={<PayPageV2 />} />
        <Route path="/receipt/:token" element={<div>receipt page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  native.canSave = false;
  native.saveUrlNative.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const withAttachment = () => {
  const body = payload();
  body.invoice.attachments = [{ id: 'att-1', fileName: 'Treatment map.pdf', fileSizeBytes: 2048 }];
  return body;
};

describe('pay page — invoice attachments', () => {
  it('saves through the native share sheet inside the app instead of opening a new window', async () => {
    native.canSave = true;
    stubFetch(withAttachment());
    renderPage();
    const link = await screen.findByRole('link', { name: /Treatment map\.pdf/ });
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false); // default navigation cancelled
    expect(native.saveUrlNative).toHaveBeenCalledTimes(1);
    expect(native.saveUrlNative.mock.calls[0][0]).toMatch(/\/pay\/deadbeefdeadbeefdeadbeef\/attachments\/att-1$/);
    expect(native.saveUrlNative.mock.calls[0][1]).toBe('Treatment map.pdf');
  });

  it('keeps the plain link on the web', async () => {
    stubFetch(withAttachment());
    renderPage();
    const link = await screen.findByRole('link', { name: /Treatment map\.pdf/ });
    expect(link).toHaveAttribute('target', '_blank');
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(true);
    expect(native.saveUrlNative).not.toHaveBeenCalled();
  });
});

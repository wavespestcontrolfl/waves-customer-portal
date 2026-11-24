// @vitest-environment jsdom
// The Map and AI Advisor views load their V1 code with their own import().
// When a deploy removed that code and the staff tab did not reload
// (lib/staleChunkReload.js), the view shows the Reload prompt of every other
// part of a staff page, not the raw import error.
import React from 'react';
import { IDBFactory } from 'fake-indexeddb';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import CustomersPageV2 from './CustomersPageV2';
import { handleVitePreloadError, notePageInView, resetStaleChunkReloadForTests } from '../../lib/staleChunkReload';

// Stands for V1 code the live build no longer serves: each import() of it
// rejects with the browser's error. Vitest wraps an error that a mock factory
// throws, so the module loads once first and then becomes a thenable that
// rejects: a later import() adopts that rejection as is.
const legacy = vi.hoisted(() => ({ module: {}, error: null }));
vi.mock('./CustomersPage', () => legacy.module);
beforeAll(async () => {
  await import('./CustomersPage');
  legacy.module.then = (resolve, reject) => reject(legacy.error);
});
vi.mock('../../components/admin/Customer360ProfileV2', () => ({ default: () => null }));
vi.mock('../../components/admin/MobileNewCustomerSheet', () => ({ default: () => null }));
vi.mock('../../components/admin/CustomerGeocodeReviewPanel', () => ({
  default: () => null,
  confirmDiscardDraft: () => true,
}));

function openMap() {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
    JSON.stringify({ customers: [], total: 0, totalPages: 1 }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ))));
  return render(<MemoryRouter initialEntries={['/admin/customers?view=map']}><CustomersPageV2 /></MemoryRouter>);
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
  localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('a Map view whose code a deploy removed shows the Reload prompt, not the import error', async () => {
  legacy.error = new TypeError('Failed to fetch dynamically imported module: /assets/CustomersPage-old.js');
  openMap();
  expect(await screen.findByText(/^This part of the page did not load/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  expect(screen.queryByText(/Could not load this panel/)).not.toBeInTheDocument();
});

test('any other load error still shows the error', async () => {
  legacy.error = new Error('map bug');
  openMap();
  expect(await screen.findByText('Could not load this panel: map bug')).toBeInTheDocument();
  expect(screen.queryByText(/This part of the page did not load/)).not.toBeInTheDocument();
});

// Back can open a customer page while the view's code is on its way: the
// stale-chunk handler then leaves every import to fail, and the view decides
// (lib/staleChunkReload.js).
test('while the view\'s code is on its way, a preload error at a customer page reloads nothing', async () => {
  let rejectLegacy;
  legacy.module.then = (resolve, reject) => { rejectLegacy = reject; };
  const reload = vi.fn();
  try {
    openMap();
    await waitFor(() => expect(rejectLegacy).toBeTypeOf('function'));
    vi.stubGlobal('location', { ...window.location, pathname: '/', reload });
    notePageInView('/admin/customers', '/');
    const stale = new Event('vite:preloadError', { cancelable: true });
    handleVitePreloadError(stale, reload);
    expect(stale.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  } finally {
    // Settle the import: one left on its way holds every later import() of
    // the view, in this file's other tests too.
    rejectLegacy?.(new TypeError('Failed to fetch dynamically imported module: /assets/CustomersPage-old.js'));
    legacy.module.then = (resolve, reject) => reject(legacy.error);
    resetStaleChunkReloadForTests();
  }
  // The view, which asked for the code, decides: its Reload prompt.
  expect(await screen.findByText(/^This part of the page did not load/)).toBeInTheDocument();
});

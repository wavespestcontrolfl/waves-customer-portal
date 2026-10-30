// @vitest-environment jsdom
import React from 'react';
import { IDBFactory } from 'fake-indexeddb';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CustomersPageV2 from './CustomersPageV2';

// The Map view hands its rows to the V1 CustomerMap; this stand-in shows what
// it was given so the loader's paging can be checked without Google Maps.
vi.mock('./CustomersPage', () => ({
  CustomerMap: ({ customers, total, loading }) => (
    <div data-testid="map-input">
      rows:{customers.length} unique:{new Set(customers.map((c) => c.id)).size} total:{total} loading:{String(loading)}
    </div>
  ),
}));
vi.mock('../../components/admin/Customer360ProfileV2', () => ({ default: () => null }));
vi.mock('../../components/admin/MobileNewCustomerSheet', () => ({ default: () => null }));
vi.mock('../../components/admin/CustomerGeocodeReviewPanel', () => ({
  default: () => null,
  confirmDiscardDraft: () => true,
}));

function json(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function pageRows(pageNumber, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `c-${pageNumber}-${index}`,
    firstName: `P${pageNumber}`,
    lastName: `R${index}`,
    address: '1 Test St, Sample FL',
    lat: 27.5,
    lng: -82.5,
  }));
}

// A server of `total` matching rows served 500 at a time.
function serverOf(total, { onRequest, failPage } = {}) {
  return vi.fn((url, options = {}) => {
    const parsed = new URL(String(url), 'http://fixture.invalid');
    if (parsed.pathname !== '/api/admin/customers') return json({});
    onRequest?.(parsed.searchParams, options);
    const limit = Number(parsed.searchParams.get('limit'));
    const pageNumber = Number(parsed.searchParams.get('page'));
    if (failPage === pageNumber) return json({ error: 'Map page unavailable' }, 503);
    const count = Math.max(0, Math.min(limit, total - (pageNumber - 1) * limit));
    return json({ customers: pageRows(pageNumber, count), total, totalPages: Math.max(1, Math.ceil(total / limit)) });
  });
}

function openMap(search = '') {
  return render(<MemoryRouter initialEntries={[`/admin/customers?view=map${search}`]}><CustomersPageV2 /></MemoryRouter>);
}

describe('CustomersPageV2 Map loading', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    localStorage.setItem('waves_admin_token', 'test-token');
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('reads every 500-row page of the current result set and passes all rows to the map', async () => {
    const requests = [];
    vi.stubGlobal('fetch', serverOf(1200, { onRequest: (params) => requests.push(params) }));
    openMap();
    expect(await screen.findByTestId('map-input')).toHaveTextContent('rows:1200 unique:1200 total:1200 loading:false');
    const mapRequests = requests.filter((params) => params.get('limit') === '500');
    expect(mapRequests.map((params) => params.get('page'))).toEqual(['1', '2', '3']);
    for (const params of mapRequests) {
      expect(params.get('limit')).toBe('500');
      expect(params.has('suggest')).toBe(false);
    }
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('limit=5000'))).toBe(true);
  });

  it('stops at 10 pages (5,000 rows) and reports the full match count', async () => {
    const requests = [];
    vi.stubGlobal('fetch', serverOf(6200, { onRequest: (params) => requests.push(params) }));
    openMap();
    expect(await screen.findByTestId('map-input')).toHaveTextContent('rows:5000 unique:5000 total:6200 loading:false');
    expect(requests.map((params) => params.get('page'))).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  });

  it('keeps the Directory search and filters on every Map page', async () => {
    const requests = [];
    vi.stubGlobal('fetch', serverOf(700, { onRequest: (params) => requests.push(params) }));
    openMap('&healthRisk=high');
    await screen.findByTestId('map-input');
    await waitFor(() => expect(requests.length).toBe(2));
    expect(requests.map((params) => params.get('healthRisk'))).toEqual(['high', 'high']);
  });

  it('shows the Retry card when the first page fails, then loads the full set on Retry', async () => {
    let failPage = 1;
    const requests = [];
    vi.stubGlobal('fetch', vi.fn((url, options) => serverOf(900, { onRequest: (params) => requests.push(params), failPage })(url, options)));
    openMap();
    expect(await screen.findByText('Failed to load customers')).toBeInTheDocument();
    expect(screen.getByText('Map page unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('map-input')).not.toBeInTheDocument();
    failPage = null;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('map-input')).toHaveTextContent('rows:900 unique:900 total:900');
    expect(requests.map((params) => params.get('page'))).toEqual(['1', '1', '2']);
  });

  it('keeps the pages already read when a later page fails, says so, and offers Retry', async () => {
    let failPage = 2;
    const requests = [];
    vi.stubGlobal('fetch', vi.fn((url, options) => serverOf(1200, { onRequest: (params) => requests.push(params), failPage })(url, options)));
    openMap();
    expect(await screen.findByTestId('map-input')).toHaveTextContent('rows:500 unique:500 total:1200 loading:false');
    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent('Some customers did not load: Map page unavailable');
    expect(notice).toHaveTextContent('Showing 500 of 1200.');
    // Pages load one after another: the failed page 2 ended the loop.
    expect(requests.map((params) => params.get('page'))).toEqual(['1', '2']);
    failPage = null;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('map-input')).toHaveTextContent('rows:1200 unique:1200 total:1200'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('aborts the in-flight page when the view changes and ignores its late answer', async () => {
    const signals = [];
    let releasePageTwo;
    vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
      const parsed = new URL(String(url), 'http://fixture.invalid');
      if (parsed.pathname !== '/api/admin/customers') return json({});
      const pageNumber = Number(parsed.searchParams.get('page'));
      const limit = Number(parsed.searchParams.get('limit'));
      if (limit === 500 && pageNumber === 2) {
        signals.push(options.signal);
        return new Promise((resolve, reject) => {
          releasePageTwo = () => resolve(new Response(JSON.stringify({ customers: pageRows(2, 3), total: 900, totalPages: 2 }), { status: 200 }));
          options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }
      return json({ customers: pageRows(pageNumber, 3), total: 900, totalPages: 2 });
    }));
    render(<MemoryRouter initialEntries={['/admin/customers?tableControls=0']}><CustomersPageV2 /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Map', exact: true }));
    await waitFor(() => expect(signals.length).toBe(1));
    expect(signals[0].aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Directory', exact: true }));
    await waitFor(() => expect(signals[0].aborted).toBe(true));
    releasePageTwo();
    await screen.findByText('Page 1 of 2 (900 total)');
    expect(screen.queryByTestId('map-input')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open P1 R0 customer profile' })).toBeInTheDocument();
  });
});

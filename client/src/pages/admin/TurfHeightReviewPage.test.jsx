// @vitest-environment jsdom
// UI audit F0558: a failed "Confirm reading" says why and keeps the row.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TurfHeightReviewPage from './TurfHeightReviewPage';

const ITEM = { id: 7, customerName: 'Pat Customer', grassType: 'st_augustine', band: { min: 3, max: 4 }, manualHeightIn: 3.5, ocrHeightIn: 2, ocrConfidence: 0.9, measuredAt: '2026-09-01T16:00:00Z', verificationStatus: 'discrepancy', gaugePhotoUrl: null };
const ITEM2 = { ...ITEM, id: 8, customerName: 'Sam Customer', verificationStatus: 'ocr_failed', ocrHeightIn: null };

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

function stub(patchImpl) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    if (opts.method === 'PATCH') return patchImpl();
    return { ok: true, json: async () => ({ items: [ITEM] }) };
  }));
}

describe('TurfHeightReviewPage confirm reading', () => {
  it('a 500 surfaces the server reason and the row stays', async () => {
    stub(async () => ({ ok: false, status: 500, json: async () => ({ error: 'Reading is locked' }) }));
    render(<MemoryRouter><TurfHeightReviewPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm reading' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reading is locked');
    expect(screen.getByRole('button', { name: 'Confirm reading' })).toBeInTheDocument();
  });

  it('a rejected PATCH is caught and reported, not an unhandled rejection', async () => {
    stub(async () => { throw new Error('Failed to fetch'); });
    render(<MemoryRouter><TurfHeightReviewPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm reading' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/check your connection/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm reading' })).not.toBeDisabled());
  });

  it('a failed row keeps its error when another row confirms successfully afterwards', async () => {
    let patches = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      if (opts.method === 'PATCH') {
        patches += 1;
        if (String(url).includes('/7/')) return { ok: false, status: 500, json: async () => ({ error: 'Row 7 locked' }) };
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ items: [ITEM, ITEM2] }) };
    }));
    render(<MemoryRouter><TurfHeightReviewPage /></MemoryRouter>);
    const buttons = await screen.findAllByRole('button', { name: 'Confirm reading' });
    fireEvent.click(buttons[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent('Row 7 locked');
    fireEvent.click(within(screen.getByRole('heading', { name: 'Sam Customer' }).closest('.bg-white')).getByRole('button', { name: 'Confirm reading' }));
    await waitFor(() => expect(patches).toBe(2));
    await waitFor(() => expect(screen.queryByText('Sam Customer')).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('Row 7 locked');
  });
});


describe('Turf height shared controls', () => {
  it('keeps concurrent pending rows disabled and sends one unchanged request per reading', async () => {
    const pending = {};
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      if (options.method === 'PATCH') return new Promise((resolve) => { pending[url] = resolve; });
      return { ok: true, json: async () => ({ items: [ITEM, ITEM2] }) };
    }));
    render(<MemoryRouter><TurfHeightReviewPage /></MemoryRouter>);
    const [first, second] = await screen.findAllByRole('button', { name: 'Confirm reading' });
    fireEvent.click(first);
    fireEvent.click(second);
    fireEvent.click(first);
    expect(first).toBeDisabled();
    expect(second).toBeDisabled();
    expect(first).toHaveAccessibleName('Confirm reading');
    const patches = fetch.mock.calls.filter(([, options]) => options.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[0]).toEqual(['/api/admin/turf-height/7/resolve', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ status: 'verified' }),
      headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
    })]);
    pending['/api/admin/turf-height/8/resolve']({ ok: true });
    await waitFor(() => expect(screen.queryByText('Sam Customer')).not.toBeInTheDocument());
    expect(first).toBeDisabled();
    pending['/api/admin/turf-height/7/resolve']({ ok: false, status: 409, json: async () => ({ error: 'Reading is locked' }) });
    expect(await screen.findByRole('alert')).toHaveTextContent('Reading is locked');
    expect(first).not.toBeDisabled();
  });

  it('keeps missing readings distinct from zero and refreshes a failed queue read', async () => {
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      reads += 1;
      if (reads === 1) return { ok: false, status: 500 };
      return { ok: true, json: async () => ({ items: [{ ...ITEM, manualHeightIn: 0, ocrHeightIn: null }] }) };
    }));
    render(<MemoryRouter><TurfHeightReviewPage /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load');
    expect(screen.queryByText(/Nothing to review/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('0″')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

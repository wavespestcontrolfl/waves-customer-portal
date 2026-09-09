// @vitest-environment jsdom
// UI audit F0558: a failed "Confirm reading" says why and keeps the row.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TurfHeightReviewPage from './TurfHeightReviewPage';

const ITEM = { id: 7, customer: 'Pat Customer', grass: 'St. Augustine', band: 'ok', gauge: 3.5, measured: '2026-09-01', manual: false, verification: 'pending' };

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
});

// @vitest-environment jsdom
// UI audit F0502: payers, statements and AR dialogs must not present a failed
// request as "no payers" / "no statements" / "no outstanding balance".
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PayersPage from './PayersPage';
import PayerDetailSheet from './PayerDetailSheet';
import PayerArAgingDialog from './PayerArAgingDialog';

const failing = () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });

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

describe('payer surfaces on a failed load', () => {
  it('PayersPage renders the server error and retries instead of "No payers yet"', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/admin/payers?')) {
        calls += 1;
        return calls === 1 ? failing() : { ok: true, json: async () => ({ payers: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }));
    render(<MemoryRouter><PayersPage /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.queryByText(/No payers yet/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls).toBe(2));
    expect(await screen.findByText(/No payers yet/)).toBeInTheDocument();
  });

  it('PayerDetailSheet renders the error instead of "No statements yet"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));
    render(<PayerDetailSheet payer={{ id: 'p1', name: 'Acme HOA' }} onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Failed to fetch/);
    expect(screen.queryByText(/No statements yet/)).not.toBeInTheDocument();
  });

  it('PayerDetailSheet keeps loaded statements when only the AR request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/ar')) return failing();
      return { ok: true, json: async () => ({ statements: [{ id: 's1', status: 'sent', total: 10, period_label: 'Aug' }] }) };
    }));
    render(<PayerDetailSheet payer={{ id: 'p1', name: 'Acme HOA' }} onClose={() => {}} />);
    await waitFor(() => expect(screen.queryByText('Loading statements…')).not.toBeInTheDocument());
    // Statements tab shows its rows, not an error and not the empty copy.
    expect(screen.queryByText(/No statements yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /balance|ar/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.queryByText(/No outstanding balance/)).not.toBeInTheDocument();
  });

  it('PayerArAgingDialog renders the error and retries instead of "No outstanding payer statements"', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      return calls === 1 ? failing() : { ok: true, json: async () => ({ statement_count: 0, payers: [] }) };
    }));
    render(<PayerArAgingDialog onClose={() => {}} onSelectPayer={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.queryByText(/No outstanding payer statements/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/No outstanding payer statements/)).toBeInTheDocument();
  });
});

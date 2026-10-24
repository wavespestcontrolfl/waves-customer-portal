// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CommercialProposalModal from './CommercialProposalModal';

// Synthetic data only.
const estimate = { id: 'abcd1234-5678-synthetic', customerName: 'Synthetic Office', address: '1 Sample St' };
let proposalEstimate; let pdfStatus; let fetchCalls; let adminCalls;
const adminFetch = vi.fn(async (url, options = {}) => {
  adminCalls.push({ url, ...options });
  if (options.method === 'PUT') return { editVersion: 'v2' };
  return {
    proposal: { enabled: true, title: 'Synthetic proposal', buildings: [{ name: 'Office', lineItems: [{ description: 'Quarterly service', quantity: 1, unitPrice: 100, frequency: 'quarterly' }] }] },
    estimate: proposalEstimate,
  };
});

beforeEach(() => {
  proposalEstimate = { id: estimate.id, estimateSlug: 'EST-2026-0001' };
  pdfStatus = 200; fetchCalls = []; adminCalls = [];
  localStorage.setItem('waves_admin_token', 'synthetic-token');
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    fetchCalls.push({ url: String(url), ...options });
    return { ok: pdfStatus < 400, status: pdfStatus, blob: async () => new Blob(['%PDF-']) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

const mount = async () => {
  render(<CommercialProposalModal estimate={estimate} adminFetch={adminFetch} onClose={() => {}} />);
  await screen.findByDisplayValue('Synthetic proposal');
};

it('Download PDF saves a named file from an anchor click and opens no window', async () => {
  await mount();
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  const revoke = vi.fn();
  vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:synthetic-proposal', revokeObjectURL: revoke });
  const clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() { clicked.push({ download: this.download, href: this.href }); });
  fireEvent.click(screen.getByRole('button', { name: /Download PDF/ }));
  await waitFor(() => expect(clicked).toHaveLength(1));
  expect(clicked[0]).toEqual({ download: 'Waves-Proposal-EST-2026-0001.pdf', href: 'blob:synthetic-proposal' });
  expect(open).not.toHaveBeenCalled();
  // saved first, then the PDF fetched with the staff token
  expect(adminCalls.some((call) => call.method === 'PUT')).toBe(true);
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].url).toMatch(/\/admin\/estimates\/abcd1234-5678-synthetic\/proposal\.pdf$/);
  expect(fetchCalls[0].headers.Authorization).toBe('Bearer synthetic-token');
  expect(document.querySelector('a[download]')).toBeNull();
});

it('Download PDF falls back to a short id when the estimate has no number', async () => {
  proposalEstimate = { id: estimate.id, estimateSlug: null };
  await mount();
  vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:synthetic', revokeObjectURL: () => {} });
  const clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() { clicked.push(this.download); });
  fireEvent.click(screen.getByRole('button', { name: /Download PDF/ }));
  await waitFor(() => expect(clicked).toEqual(['Waves-Proposal-abcd1234.pdf']));
});

it('Download PDF shows the error and saves nothing when the PDF request fails', async () => {
  pdfStatus = 503;
  await mount();
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: /Download PDF/ }));
  expect(await screen.findByText('Could not generate PDF (503)')).toBeInTheDocument();
  expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CommercialProposalPage from './CommercialProposalPage';

const fixture = {
  bidToolsEnabled: true,
  estimate: { id: 'synthetic-proposal', status: 'draft', editVersion: 'loaded-version', customerName: 'Synthetic Office', customerEmail: 'office@example.invalid', customerPhone: '+19415550100' },
  proposal: { enabled: true, title: 'Synthetic proposal', buildings: [{ name: 'Office', lineItems: [{ description: 'Quarterly service', quantity: 1, unitPrice: 100, frequency: 'quarterly', taxable: false }] }] },
};
let saved; let previewVersion; let failSave; let calls;
beforeEach(() => {
  saved = structuredClone(fixture); previewVersion = 'loaded-version'; failSave = false; calls = [];
  localStorage.setItem('waves_admin_token', 'synthetic-token');
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    calls.push({ url: String(url), ...options });
    let data; let status = 200;
    if (String(url).endsWith('/send-preview')) data = {
      ...saved.estimate, editVersion: previewVersion, updatedAt: '2026-01-01T12:00:00Z',
      previewPath: '/estimate/synthetic?adminPreview=1', messageVersion: 'message-version',
      messages: { sms: 'Synthetic proposal link', email: { subject: 'Synthetic proposal', text: 'Review the proposal PDF.' } },
    };
    else if (String(url).endsWith('/send')) data = { channels: { email: { ok: true, real: true } } };
    else if (options.method === 'PUT') {
      if (failSave) { status = 409; data = { error: 'Proposal changed; reload.' }; }
      else { saved.proposal = JSON.parse(options.body).proposal; saved.estimate.editVersion = 'saved-version'; previewVersion = 'saved-version'; data = {}; }
    } else data = saved;
    return { ok: status < 400, status, json: async () => structuredClone(data), clone() { return this; } };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
const mount = () => render(<MemoryRouter initialEntries={['/estimates/synthetic-proposal/proposal']}><Routes><Route path="/estimates/:estimateId/proposal" element={<CommercialProposalPage />} /></Routes></MemoryRouter>);

it('hides bid controls while disabled and omits fields that an older editor cannot edit', async () => {
  saved.bidToolsEnabled = false;
  mount(); await screen.findByDisplayValue('Synthetic proposal');
  expect(screen.queryByLabelText('Quantity unit')).toBeNull();
  fireEvent.change(screen.getByDisplayValue('Synthetic proposal'), { target: { value: 'Ordinary edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  await screen.findByRole('button', { name: 'Saved' });
  const payload = JSON.parse(calls.find((call) => call.method === 'PUT').body);
});

it('preserves decimal quantities, units and unit rates through save/reload', async () => {
  mount();
  await screen.findByDisplayValue('Synthetic proposal');
  fireEvent.change(screen.getByLabelText('Quantity', { exact: true }), { target: { value: '25.8' } });
  fireEvent.change(screen.getByLabelText('Quantity unit'), { target: { value: 'acre' } });
  fireEvent.change(screen.getByLabelText('Unit price', { exact: true }), { target: { value: '0.0755' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  await screen.findByRole('button', { name: 'Saved' });
  const payload = JSON.parse(calls.find((call) => call.method === 'PUT').body);
  expect(payload.proposal.buildings[0].lineItems[0]).toMatchObject({ quantity: '25.8', unit: 'acre', unitPrice: '0.0755' });
  expect(screen.getByLabelText('Quantity', { exact: true })).toHaveValue(25.8);
});

it('keeps saved bid details visible but read-only after the gate is disabled', async () => {
  saved.bidToolsEnabled = false;
  Object.assign(saved.proposal.buildings[0].lineItems[0], { id: 'saved-line', unit: 'acre', quantity: 25.8, unitPrice: 0.0755 });
  mount(); await screen.findByDisplayValue('Synthetic proposal');
  expect(screen.getByLabelText('Quantity unit')).toBeDisabled();
  expect(screen.getByLabelText('Quantity unit')).toHaveValue('acre');
  fireEvent.change(screen.getByDisplayValue('Synthetic proposal'), { target: { value: 'Ordinary bid title edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  await screen.findByRole('button', { name: 'Saved' });
  const payload = JSON.parse(calls.find((call) => call.method === 'PUT').body);
  expect(payload.proposal.buildings[0].lineItems[0]).toMatchObject({ unit: 'acre', quantity: 25.8, unitPrice: 0.0755 });
});

it('saves edits before review and sends only the explicitly reviewed channel/version', async () => {
  mount();
  fireEvent.change(await screen.findByDisplayValue('Synthetic proposal'), { target: { value: 'Revised proposal' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review and send' }));
  await screen.findByRole('dialog');
  fireEvent.click(await screen.findByLabelText('Email'));
  expect(calls.filter((call) => call.url.endsWith('/send'))).toHaveLength(0);
  expect(calls.findIndex((call) => call.method === 'PUT')).toBeLessThan(calls.findIndex((call) => call.url.endsWith('/send-preview')));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm send' }));
  await screen.findByText(/provider accepted; delivery not confirmed/);
  const sends = calls.filter((call) => call.url.endsWith('/send'));
  expect(sends).toHaveLength(1);
  expect(JSON.parse(sends[0].body)).toMatchObject({ sendMethod: 'email', expectedEditVersion: 'saved-version', messageVersion: 'message-version' });
});

it('keeps a changed saved offer blocked and cancel sends nothing', async () => {
  mount(); await screen.findByDisplayValue('Synthetic proposal'); previewVersion = 'concurrent-version';
  fireEvent.click(screen.getByRole('button', { name: 'Review and send' }));
  fireEvent.click(await screen.findByLabelText('Email'));
  expect(screen.getByRole('button', { name: 'Confirm send' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(calls.filter((call) => call.url.endsWith('/send'))).toHaveLength(0);
});

it('retains edits and never opens delivery review after a failed save', async () => {
  mount(); failSave = true;
  fireEvent.change(await screen.findByDisplayValue('Synthetic proposal'), { target: { value: 'Unsaved proposal' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review and send' }));
  await screen.findByText('Proposal changed; reload.');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Review and send' })).toBeEnabled());
  expect(screen.getByDisplayValue('Unsaved proposal')).toBeInTheDocument();
  expect(calls.some((call) => /\/send(?:-preview)?$/.test(call.url))).toBe(false);
});

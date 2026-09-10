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
let saved; let previewVersion; let failSave; let calls; let interloperAfterSave; let duringSave;
beforeEach(() => {
  saved = structuredClone(fixture); previewVersion = 'loaded-version'; failSave = false; calls = []; interloperAfterSave = false; duringSave = null;
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
    else if (String(url).endsWith('/bid-form.pdf')) data = {};
    else if (options.method === 'PUT') {
      if (duringSave) { const fn = duringSave; duringSave = null; fn(); }
      if (failSave) { status = 409; data = { error: 'Proposal changed; reload.' }; }
      else { saved.proposal = JSON.parse(options.body).proposal; saved.projectCosting = JSON.parse(options.body).projectCosting; saved.estimate.editVersion = 'saved-version'; previewVersion = 'saved-version'; data = { editVersion: 'saved-version' }; if (interloperAfterSave) { saved.proposal = { ...saved.proposal, title: 'Interloper edit' }; saved.estimate.editVersion = 'interloper-version'; previewVersion = 'interloper-version'; } }
    } else data = saved;
    return { ok: status < 400, status, json: async () => structuredClone(data), blob: async () => new Blob(['%PDF-']), clone() { return this; } };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
const mount = () => render(<MemoryRouter initialEntries={['/estimates/synthetic-proposal/proposal']}><Routes><Route path="/estimates/:estimateId/proposal" element={<CommercialProposalPage />} /></Routes></MemoryRouter>);

it('hides bid controls while disabled and omits fields that an older editor cannot edit', async () => {
  saved.bidToolsEnabled = false;
  mount(); await screen.findByDisplayValue('Synthetic proposal');
  expect(screen.queryByLabelText('Quantity unit')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add project cost' })).toBeNull();
  expect(screen.queryByLabelText(/Valid through \(Eastern time\)/)).toBeNull();
  fireEvent.change(screen.getByDisplayValue('Synthetic proposal'), { target: { value: 'Ordinary edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  await screen.findByRole('button', { name: 'Saved' });
  const payload = JSON.parse(calls.find((call) => call.method === 'PUT').body);
  expect(payload).not.toHaveProperty('projectCosting');
  expect(payload.proposal).not.toHaveProperty('validThrough');
});

it('preserves decimal quantities, units, unit rates, validity and private cost inputs through save/reload', async () => {
  mount();
  await screen.findByDisplayValue('Synthetic proposal');
  fireEvent.change(screen.getByLabelText('Quantity', { exact: true }), { target: { value: '25.8' } });
  fireEvent.change(screen.getByLabelText('Quantity unit'), { target: { value: 'acre' } });
  fireEvent.change(screen.getByLabelText('Unit price', { exact: true }), { target: { value: '0.0755' } });
  fireEvent.change(screen.getByLabelText(/Valid through \(Eastern time\)/), { target: { value: '2026-12-21' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add project cost' }));
  fireEvent.change(screen.getByLabelText('Cost description'), { target: { value: 'Private crew hours' } });
  fireEvent.change(screen.getByLabelText('Cost quantity', { exact: true }), { target: { value: '40' } });
  fireEvent.change(screen.getByLabelText('Cost per unit'), { target: { value: '35' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  await screen.findByRole('button', { name: 'Saved' });
  const payload = JSON.parse(calls.find((call) => call.method === 'PUT').body);
  expect(payload.proposal.buildings[0].lineItems[0]).toMatchObject({ quantity: '25.8', unit: 'acre', unitPrice: '0.0755' });
  expect(payload.proposal.validThrough).toBe('2026-12-21');
  expect(payload.projectCosting.rows[0]).toMatchObject({ quantity: '40', unitCost: '35', description: 'Private crew hours' });
  expect(JSON.stringify(payload.proposal)).not.toContain('Private crew hours');
  expect(screen.getByLabelText('Quantity', { exact: true })).toHaveValue(25.8);
  expect(screen.getByLabelText('Cost description')).toHaveValue('Private crew hours');
});

it('keeps saved bid details visible but read-only after the gate is disabled', async () => {
  saved.bidToolsEnabled = false;
  saved.proposal.validThrough = '2099-12-21';
  Object.assign(saved.proposal.buildings[0].lineItems[0], { id: 'saved-line', unit: 'acre', quantity: 25.8, unitPrice: 0.0755 });
  saved.projectCosting = { revenueYears: 1, rows: [{ category: 'labor', phase: 'Phase A', description: 'Private crew hours', quantity: 40, unit: 'hour', unitCost: 35, occurrences: 1 }] };
  mount(); await screen.findByDisplayValue('Synthetic proposal');
  expect(screen.getByLabelText('Quantity unit')).toBeDisabled();
  expect(screen.getByLabelText('Quantity unit')).toHaveValue('acre');
  expect(screen.getByLabelText(/Valid through \(Eastern time\)/)).toBeDisabled();
  expect(screen.getByLabelText('Cost description')).toBeDisabled();
  expect(screen.queryByRole('heading', { name: 'Required bid form' })).toBeNull();
  fireEvent.change(screen.getByDisplayValue('Synthetic proposal'), { target: { value: 'Ordinary bid title edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  await screen.findByRole('button', { name: 'Saved' });
  const payload = JSON.parse(calls.find((call) => call.method === 'PUT').body);
  expect(payload.proposal.buildings[0].lineItems[0]).toMatchObject({ unit: 'acre', quantity: 25.8, unitPrice: 0.0755 });
  expect(payload).not.toHaveProperty('projectCosting');
  expect(payload.proposal).not.toHaveProperty('validThrough');
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

it('keys the next save on the version its PUT committed and refuses to adopt a concurrent save from the reload', async () => {
  interloperAfterSave = true;
  mount(); await screen.findByDisplayValue('Synthetic proposal');
  fireEvent.change(screen.getByDisplayValue('Synthetic proposal'), { target: { value: 'My edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  await screen.findByText(/changed by another editor right after your save/);
  expect(screen.queryByRole('button', { name: 'Saved' })).toBeNull();
  // The form keeps the operator's text; the interloper's content was not silently swapped in.
  expect(screen.getByDisplayValue('My edit')).toBeInTheDocument();
  // A retry carries the version THIS editor committed, so the server's stale check sees the interloper.
  interloperAfterSave = false; failSave = true;
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  await screen.findByText('Proposal changed; reload.');
  const puts = calls.filter((call) => call.method === 'PUT').map((call) => JSON.parse(call.body).expectedEditVersion);
  expect(puts).toEqual(['loaded-version', 'saved-version']);
});

it('duplicates a unit-bearing building as a unit-less copy while the gate is off, so the copy can be saved', async () => {
  saved.bidToolsEnabled = false;
  saved.proposal.buildings[0].lineItems[0] = { ...saved.proposal.buildings[0].lineItems[0], id: 'saved-line', unit: 'acre' };
  mount(); await screen.findByDisplayValue('Synthetic proposal');
  fireEvent.click(screen.getByTitle('Duplicate building'));
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  await screen.findByRole('button', { name: 'Saved' });
  const payload = JSON.parse(calls.find((call) => call.method === 'PUT').body);
  expect(payload.proposal.buildings).toHaveLength(2);
  expect(payload.proposal.buildings[0].lineItems[0]).toMatchObject({ id: 'saved-line', unit: 'acre' });
  expect(payload.proposal.buildings[1].lineItems[0].unit).toBeFalsy();
  expect(payload.proposal.buildings[1].lineItems[0].id).not.toBe('saved-line');
});

const bidFormExport = async () => {
  mount();
  await screen.findByDisplayValue('Synthetic proposal');
  fireEvent.change(screen.getByLabelText('Original PDF'), { target: { files: [new File(['%PDF-'], 'original.pdf', { type: 'application/pdf' })] } });
  fireEvent.change(screen.getByLabelText('Form row for Quarterly service'), { target: { value: 'application' } });
  vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:synthetic', revokeObjectURL: () => {} });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: 'Download filled bid form' }));
};

it('exports the bid form with the row mapping captured at the click after a clean save', async () => {
  await bidFormExport();
  await waitFor(() => expect(calls.some((call) => call.url.endsWith('/bid-form.pdf'))).toBe(true));
  const options = JSON.parse(calls.find((call) => call.url.endsWith('/bid-form.pdf')).body.get('options'));
  expect(options.template).toBe('north_port_pr27_02');
  expect(options.expectedEditVersion).toBe('saved-version');
  expect(Object.values(options.mapping)).toEqual(['application']);
});

it('refuses the export when a proposal edit lands while the pre-export save is in flight (GH codex P2 r6 on #4270)', async () => {
  duringSave = () => fireEvent.change(screen.getByDisplayValue('Synthetic proposal'), { target: { value: 'Edited mid-save' } });
  await bidFormExport();
  await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent('The proposal changed while the form was being prepared');
  expect(calls.some((call) => call.url.endsWith('/bid-form.pdf'))).toBe(false);
  expect(calls.filter((call) => call.method === 'PUT').length).toBeGreaterThanOrEqual(2);
});

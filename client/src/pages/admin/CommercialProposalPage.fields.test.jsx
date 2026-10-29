// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CommercialProposalPage from './CommercialProposalPage';

// Owner 2026-10-28 builder scope ("easier for techs to fill out"): every program and line box carries a visible
// label (a phone shows no hover tooltips), program frequency is a Monthly / Every 2 months / Quarterly / Custom
// pick, programs stay one button until the first one, and optional sections fold to a one-line summary.
const program = (frequencyPerYear) => ({
  id: 'synthetic-program', service: 'pest', label: 'Synthetic pest program', frequencyPerYear, pricePerApplication: 100, taxable: true,
  inclusions: [`${frequencyPerYear} scheduled applications per year`],
});
const makeFixture = ({ programs } = {}) => ({
  bidToolsEnabled: false,
  suggestedTaxRate: 0.07,
  suggestedTaxSource: 'Manatee County',
  estimate: { id: 'synthetic-proposal', status: 'draft', editVersion: 'loaded-version', customerName: 'Synthetic Office' },
  proposal: {
    enabled: true, title: 'Synthetic proposal', taxRate: 0.07,
    buildings: programs ? [] : [{ name: 'Office', lineItems: [{ description: 'Monthly service', quantity: 1, unitPrice: 100, frequency: 'monthly', taxable: false }] }],
    ...(programs ? { programs } : {}),
  },
});
let fixture; let puts;
beforeEach(() => {
  puts = [];
  localStorage.setItem('waves_admin_token', 'synthetic-token');
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (options.method === 'PUT') puts.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => structuredClone(fixture), clone() { return this; } };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const mount = async (data) => {
  fixture = makeFixture(data);
  render(<MemoryRouter initialEntries={['/estimates/synthetic-proposal/proposal']}><Routes><Route path="/estimates/:estimateId/proposal" element={<CommercialProposalPage />} /></Routes></MemoryRouter>);
  await screen.findByDisplayValue('Synthetic proposal');
};
const saveProposal = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  await waitFor(() => expect(puts).toHaveLength(1));
  return puts[0].proposal;
};
// Every box in a row sits inside a <label> with text: the name shows on screen, not only in a tooltip.
const expectEveryBoxLabelled = (row) => {
  const boxes = [...row.querySelectorAll('input, select, textarea')];
  expect(boxes.length).toBeGreaterThan(3);
  for (const box of boxes) expect(box.closest('label')?.textContent.trim()).toBeTruthy();
};

it('program frequency is a preset pick; Custom shows the visits-per-year box, and the cadence line stays in step', async () => {
  await mount({ programs: [program(4)] });
  const frequency = screen.getByLabelText('Program frequency');
  expect(frequency).toHaveValue('4');
  expect(screen.queryByLabelText('Visits per year')).toBeNull();
  fireEvent.change(frequency, { target: { value: '12' } });
  fireEvent.change(frequency, { target: { value: 'custom' } });
  const visits = screen.getByLabelText('Visits per year');
  expect(visits).toHaveValue(12);
  fireEvent.change(visits, { target: { value: '24' } });
  const saved = await saveProposal();
  expect(saved.programs[0]).toMatchObject({ frequencyPerYear: 24, inclusions: ['24 scheduled applications per year'] });
  expect(saved.programs[0]).not.toHaveProperty('freqCustom');
});

it('a saved program off the presets opens on Custom with its count', async () => {
  await mount({ programs: [program(26)] });
  expect(screen.getByLabelText('Program frequency')).toHaveValue('custom');
  expect(screen.getByLabelText('Visits per year')).toHaveValue(26);
});

it('every program box and every line-item box has a visible label', async () => {
  await mount({ programs: [program(4)] });
  expectEveryBoxLabelled(screen.getByLabelText('Program frequency').closest('.space-y-2'));
  cleanup();
  await mount({});
  expectEveryBoxLabelled(screen.getByLabelText('Unit price').closest('.grid'));
});

it('programs stay one Add program button until the first program', async () => {
  await mount({});
  expect(screen.queryByText('Service programs')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Add program' }));
  expect(screen.getByText('Service programs')).toBeInTheDocument();
  expect(screen.getByLabelText('Program frequency')).toHaveValue('4');
});

it('optional sections fold to a one-line summary and open on tap', async () => {
  await mount({});
  const terms = screen.getByRole('button', { name: /^Commercial terms/ });
  expect(terms).toHaveAttribute('aria-expanded', 'false');
  expect(terms).toHaveTextContent('Payment not set · Standard terms');
  expect(screen.getByRole('button', { name: /^Corrective work/ })).toHaveTextContent('None');
  fireEvent.click(terms);
  expect(terms).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('combobox', { name: 'Renewal' })).toHaveValue('standard');
});

// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CommercialProposalPage from './CommercialProposalPage';

// Audit fix 4 (owner 2026-11-01 "fix all", pick "warn"): visit bills follow the customer's building use, never a row's
// Taxable box (a proposal win makes no invoice since #7115). A row whose box differs from the rule the builder itself
// applies for the chosen use shows a staff warning, and one summary line sits by the building use pick. The saved
// payload is unchanged: the warning is display only.
const WITH_TAX = 'Visit bills follow the building use: this row will be billed with tax.';
const WITHOUT_TAX = 'Visit bills follow the building use: this row will be billed without tax.';
const family = (taxable) => ({ taxable, inclusions: [], exclusions: [], responsibilities: [] });
const line = (taxable, extra = {}) => ({ description: 'Monthly service', quantity: 1, unitPrice: 100, frequency: 'monthly', taxable, ...extra });
const program = (taxable, extra = {}) => ({ service: 'pest', label: 'Pest control', frequencyPerYear: 4, pricePerApplication: 100, taxable, ...extra });
const makeFixture = ({ buildingUse = 'nonresidential', buildingUseTaxLive = true, taxExemptVerified = false, billToTaxBasis = 'self', status = 'draft', buildings, programs, correctiveWork, businessTaxRules } = {}) => ({
  bidToolsEnabled: true,
  buildingUseTaxLive,
  taxExemptVerified,
  billToTaxBasis,
  suggestedTaxRate: 0.07,
  suggestedTaxSource: 'Manatee County',
  familyRegistry: { pest: family(true), lawn: family(false), tree_shrub: family(false), other: family(true) },
  ...(businessTaxRules ? { businessTaxRules } : {}),
  estimate: { id: 'synthetic-proposal', status, editVersion: 'loaded-version', customerName: 'Synthetic Office' },
  proposal: {
    enabled: true, title: 'Synthetic proposal', taxRate: 0.07,
    ...(buildingUse ? { buildingUse } : {}),
    buildings: buildings || (programs ? [] : [{ name: 'Office', lineItems: [line(false)] }]),
    ...(programs ? { programs } : {}),
    ...(correctiveWork ? { correctiveWork } : {}),
  },
});
let fixture; let puts;
beforeEach(() => {
  puts = [];
  localStorage.setItem('waves_admin_token', 'synthetic-token');
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (options.method === 'PUT') puts.push(JSON.parse(options.body));
    const data = String(url).endsWith('/proposal/generated') ? { draft: null } : fixture;
    return { ok: true, status: 200, json: async () => structuredClone(data), clone() { return this; } };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const mount = async (data) => {
  fixture = makeFixture(data);
  render(<MemoryRouter initialEntries={['/estimates/synthetic-proposal/proposal']}><Routes><Route path="/estimates/:estimateId/proposal" element={<CommercialProposalPage />} /></Routes></MemoryRouter>);
  await screen.findByDisplayValue('Synthetic proposal');
};
const warnings = () => screen.queryAllByTestId('row-tax-warning').map((el) => el.textContent);
const summary = () => screen.queryByTestId('row-tax-summary');

it('residential: a taxable row is warned (billed without tax); a not-taxable row is not', async () => {
  await mount({ buildingUse: 'residential', buildings: [{ name: 'Office', lineItems: [line(true), line(false, { description: 'Second' })] }] });
  expect(warnings()).toEqual([WITHOUT_TAX]);
  expect(summary()).toHaveTextContent('Taxable differs from the building use on 1 row.');
});

it('residential with GATE_BUILDING_USE_TAX off: bills are taxed by property type, so no warning and no summary line', async () => {
  await mount({ buildingUse: 'residential', buildingUseTaxLive: false, buildings: [{ name: 'Office', lineItems: [line(true)] }] });
  expect(warnings()).toEqual([]);
  expect(summary()).toBeNull();
});

it('business building with the gate off still warns (that rule does not depend on the gate)', async () => {
  await mount({ buildingUseTaxLive: false, buildings: [{ name: 'Office', lineItems: [line(false)] }] });
  expect(warnings()).toEqual([WITH_TAX]);
  expect(summary()).toBeInTheDocument();
});

it('a verified tax exemption is answered first: a ticked business row is warned (billed without tax), an unticked one is not', async () => {
  await mount({ taxExemptVerified: true, buildings: [{ name: 'Office', lineItems: [line(true), line(false, { description: 'Second' })] }] });
  expect(warnings()).toEqual([WITHOUT_TAX]);
  expect(summary()).toHaveTextContent('on 1 row.');
});

it('a verified exemption beats the building-use gate: residential with the gate off still warns a ticked row', async () => {
  await mount({ taxExemptVerified: true, buildingUse: 'residential', buildingUseTaxLive: false, buildings: [{ name: 'Office', lineItems: [line(true)] }] });
  expect(warnings()).toEqual([WITHOUT_TAX]);
});

it('an exemption that could not be read (null) gives no basis: no warnings and no summary line', async () => {
  await mount({ taxExemptVerified: null, buildings: [{ name: 'Office', lineItems: [line(false), line(true, { description: 'Second' })] }], programs: undefined });
  expect(warnings()).toEqual([]);
  expect(summary()).toBeNull();
  cleanup();
  await mount({ taxExemptVerified: null, buildingUse: 'residential', buildings: [{ name: 'Office', lineItems: [line(true)] }] });
  expect(warnings()).toEqual([]);
  expect(summary()).toBeNull();
});

it('a tax-exempt Bill-To payer is answered first: a ticked business row is warned (billed without tax), an unticked one is not', async () => {
  await mount({ billToTaxBasis: 'payer_exempt', buildings: [{ name: 'Office', lineItems: [line(true), line(false, { description: 'Second' })] }] });
  expect(warnings()).toEqual([WITHOUT_TAX]);
  expect(summary()).toHaveTextContent('on 1 row.');
});

it('a taxed Bill-To payer skips the customer\'s own exemption: an unticked business pest row is warned (billed with tax)', async () => {
  await mount({ billToTaxBasis: 'payer_taxed', taxExemptVerified: true, buildings: [{ name: 'Office', lineItems: [line(false), line(true, { description: 'Second' })] }] });
  expect(warnings()).toEqual([WITH_TAX]);
  cleanup();
  // The customer's exemption read does not matter then: a failed one (null) still leaves the payer's basis.
  await mount({ billToTaxBasis: 'payer_taxed', taxExemptVerified: null, buildings: [{ name: 'Office', lineItems: [line(false)] }] });
  expect(warnings()).toEqual([WITH_TAX]);
});

it('a Bill-To payer that could not be read (null) gives no basis: no warnings and no summary line', async () => {
  await mount({ billToTaxBasis: null, buildings: [{ name: 'Office', lineItems: [line(false), line(true, { description: 'Second' })] }] });
  expect(warnings()).toEqual([]);
  expect(summary()).toBeNull();
});

it('residential with no taxable rows: no warning and no summary line', async () => {
  await mount({ buildingUse: 'residential' });
  expect(warnings()).toEqual([]);
  expect(summary()).toBeNull();
});

it('business building: a not-taxable row is warned (billed with tax) by the family default; a taxable one is not', async () => {
  await mount({ buildings: [{ name: 'Office', lineItems: [line(false), line(true, { description: 'Second' })] }] });
  expect(warnings()).toEqual([WITH_TAX]);
  expect(summary()).toHaveTextContent('on 1 row.');
});

it('business building: a lawn program left taxable is warned (lawn is not taxable); a pest program left taxable is not', async () => {
  await mount({ programs: [program(true, { service: 'lawn', label: 'Lawn care' }), program(true)] });
  expect(warnings()).toEqual([WITHOUT_TAX]);
});

it('business building: the served per-row rule beats the family default, only while the row keeps its service', async () => {
  // Pest is taxable by family, but this saved row's served rule is not taxable: a not-taxable box matches it.
  await mount({ programs: [program(false, { id: 'row-1' })], businessTaxRules: { 'row-1': false } });
  expect(warnings()).toEqual([]);
  // A family switch drops the served rule for that row: the new family's registry rule applies (Other: taxable).
  fireEvent.change(screen.getByLabelText('Service family'), { target: { value: 'other' } });
  expect(warnings()).toEqual([WITH_TAX]);
});

it('corrective work follows the same rule', async () => {
  await mount({ buildings: [{ name: 'Office', lineItems: [line(true)] }], correctiveWork: [{ label: 'Crack and crevice', amount: 250, taxable: false, includes: [] }] });
  expect(warnings()).toEqual([WITH_TAX]);
});

it('no building use picked yet: nothing to compare with, so no warning', async () => {
  await mount({ buildingUse: null, buildings: [{ name: 'Office', lineItems: [line(true)] }] });
  expect(warnings()).toEqual([]);
  expect(summary()).toBeNull();
});

it('a locked (accepted) proposal shows no warning', async () => {
  await mount({ buildingUse: 'residential', status: 'accepted', buildings: [{ name: 'Office', lineItems: [line(true)] }] });
  expect(warnings()).toEqual([]);
  expect(summary()).toBeNull();
});

it('changing the Taxable box or the building use updates the warning; the saved payload carries only the boxes', async () => {
  await mount({ buildingUse: 'residential', buildings: [{ name: 'Office', lineItems: [line(true)] }] });
  expect(warnings()).toEqual([WITHOUT_TAX]);
  fireEvent.click(screen.getByRole('switch', { name: 'Taxable line' }));
  expect(warnings()).toEqual([]);
  expect(summary()).toBeNull();
  // Business building restores the kept rule (taxable), which matches the rule: still no warning.
  fireEvent.change(screen.getByLabelText('Building use'), { target: { value: 'nonresidential' } });
  expect(warnings()).toEqual([]);
  fireEvent.click(screen.getByRole('switch', { name: 'Taxable line' }));
  expect(warnings()).toEqual([WITH_TAX]);
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  await waitFor(() => expect(puts).toHaveLength(1));
  const saved = puts[0].proposal;
  expect(saved.buildingUse).toBe('nonresidential');
  expect(saved.buildings[0].lineItems[0].taxable).toBe(false);
  expect(JSON.stringify(saved)).not.toMatch(/Visit bills follow|bizTaxable|warning/i);
});

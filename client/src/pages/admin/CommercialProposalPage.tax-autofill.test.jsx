// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CommercialProposalPage from './CommercialProposalPage';

// The tax rate is a SUGGESTION from GET /proposal (suggestedTaxRate + suggestedTaxSource, the server's canonical
// county/exemption resolver). It shows as a read-only chip with its source and fills a zero rate when something
// taxable exists. Override, a saved rate that differs, or a failed lookup opens the box; operator input and locked
// proposals always win. Rows the operator adds follow the building use: a business building starts each on its
// service's rule (the served family registry); a residential community, or no pick yet, starts them not taxable.
const line = (taxable) => ({ description: 'Monthly service', quantity: 1, unitPrice: 116.3, frequency: 'monthly', taxable });
const family = (taxable) => ({ taxable, inclusions: [], exclusions: [], responsibilities: [] });
const makeFixture = ({ taxable = false, taxRate = 0, suggestedTaxRate = 0.07, suggestedTaxSource = 'Manatee County', status = 'draft', programs, buildings, buildingUse = 'nonresidential' } = {}) => ({
  bidToolsEnabled: true,
  suggestedTaxRate,
  suggestedTaxSource,
  familyRegistry: { pest: family(true), lawn: family(false), tree_shrub: family(false), other: family(true) },
  estimate: { id: 'synthetic-proposal', status, editVersion: 'loaded-version', customerName: 'Synthetic Office' },
  proposal: {
    enabled: true, title: 'Synthetic proposal', taxRate,
    ...(buildingUse ? { buildingUse } : {}),
    buildings: buildings || (programs ? [] : [{ name: 'Office', lineItems: [line(taxable)] }]),
    ...(programs ? { programs } : {}),
  },
});
let fixture; let puts; let generatedDraft;
beforeEach(() => {
  puts = []; generatedDraft = null;
  localStorage.setItem('waves_admin_token', 'synthetic-token');
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (options.method === 'PUT') puts.push(JSON.parse(options.body));
    const data = String(url).endsWith('/proposal/generated') ? { draft: generatedDraft } : fixture;
    return { ok: true, status: 200, json: async () => structuredClone(data), clone() { return this; } };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const mount = async (data) => {
  fixture = makeFixture(data);
  render(<MemoryRouter initialEntries={['/estimates/synthetic-proposal/proposal']}><Routes><Route path="/estimates/:estimateId/proposal" element={<CommercialProposalPage />} /></Routes></MemoryRouter>);
  await screen.findByDisplayValue('Synthetic proposal');
};
const chip = () => screen.queryByTestId('tax-rate-chip');
const taxBox = () => screen.queryByLabelText(/Tax rate \(%\)/);
const TAX_ROW = 'Tax (taxable lines)';
// $116.30 a month, 12 months, 7%.
const TAX_AT_7 = '$97.69';
const savedTaxRate = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  await waitFor(() => expect(puts).toHaveLength(1));
  return puts[0].proposal.taxRate;
};

it('shows the county rate as a chip with its source, and fills it on load when a line is taxable', async () => {
  await mount({ taxable: true });
  // From the load's first render: the box never flashes before the fill.
  expect(taxBox()).toBeNull();
  expect(await screen.findByTestId('tax-rate-chip')).toHaveTextContent('7% · Manatee County');
  await waitFor(() => expect(screen.getByText(TAX_AT_7)).toBeInTheDocument());
  expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
});

it('fills the moment a taxable toggle turns on', async () => {
  await mount({ taxable: false });
  expect(chip()).toHaveTextContent('7% · Manatee County');
  expect(screen.queryByText(TAX_ROW)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('switch', { name: 'Taxable line' }));
  await waitFor(() => expect(screen.getByText(TAX_AT_7)).toBeInTheDocument());
  expect(chip()).toHaveTextContent('7% · Manatee County');
});

it('does not fill when no line is taxable: the chip shows the county rate, the proposal keeps 0', async () => {
  await mount({ taxable: false });
  expect(chip()).toHaveTextContent('7% · Manatee County');
  expect(screen.queryByText(TAX_ROW)).not.toBeInTheDocument();
  expect(await savedTaxRate()).toBe(0);
});

it('keeps a saved rate that differs from the county rate in the box, with one tap back to the county rate', async () => {
  await mount({ taxable: true, taxRate: 0.06 });
  expect(chip()).toBeNull();
  expect(taxBox()).toHaveValue(6);
  fireEvent.click(screen.getByRole('button', { name: 'Use 7% · Manatee County' }));
  expect(chip()).toHaveTextContent('7% · Manatee County');
  await waitFor(() => expect(screen.getByText(TAX_AT_7)).toBeInTheDocument());
});

it('Override opens the box on the rate the chip showed, and what the operator types wins, even a deliberate 0', async () => {
  await mount({ taxable: false });
  fireEvent.click(screen.getByRole('button', { name: 'Override' }));
  expect(taxBox()).toHaveValue(7);
  fireEvent.change(taxBox(), { target: { value: '3' } });
  fireEvent.change(taxBox(), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('switch', { name: 'Taxable line' }));
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Taxable line' })).toHaveAttribute('aria-checked', 'true'));
  expect(taxBox()).toHaveValue(0);
  expect(screen.queryByText(TAX_ROW)).not.toBeInTheDocument();
});

it('does not fill a locked proposal and offers no Override', async () => {
  await mount({ taxable: true, status: 'accepted' });
  expect(chip()).toHaveTextContent('0%');
  expect(screen.queryByRole('button', { name: 'Override' })).toBeNull();
  expect(screen.queryByText(TAX_ROW)).not.toBeInTheDocument();
});

it('an exempt customer shows 0% with the exemption, and nothing fills', async () => {
  await mount({ taxable: true, suggestedTaxRate: 0, suggestedTaxSource: 'Tax exempt — synthetic certificate' });
  expect(chip()).toHaveTextContent('0% · Tax exempt — synthetic certificate');
  expect(screen.queryByText(TAX_ROW)).not.toBeInTheDocument();
});

it('with no county lookup, the box shows and says the rate must be entered', async () => {
  await mount({ taxable: true, suggestedTaxRate: null, suggestedTaxSource: null });
  expect(chip()).toBeNull();
  expect(taxBox()).toHaveValue(0);
  expect(screen.getByText('The county rate could not be looked up. Enter the rate.')).toBeInTheDocument();
});

// A business building (the fixture's pick): a row the operator adds starts on its service's rule; saved rows keep theirs.
it('a line the operator adds starts Taxable by the rule, and the rate fills; the saved line keeps its switch', async () => {
  await mount({ taxable: false });
  fireEvent.click(screen.getByRole('button', { name: 'Add line item' }));
  const [savedLine, addedLine] = screen.getAllByRole('switch', { name: 'Taxable line' });
  expect(savedLine).toHaveAttribute('aria-checked', 'false');
  expect(addedLine).toHaveAttribute('aria-checked', 'true');
  fireEvent.change(screen.getAllByPlaceholderText('Service description')[1], { target: { value: 'Added service' } });
  // $50 a month, 12 months, 7%.
  fireEvent.change(screen.getAllByLabelText('Unit price')[1], { target: { value: '50' } });
  await waitFor(() => expect(screen.getByText('$42.00')).toBeInTheDocument());
  expect(await savedTaxRate()).toBe(0.07);
});

it('a program the operator adds follows its service until its switch is touched; a saved program keeps its switch', async () => {
  await mount({ programs: [{ id: 'saved-program', service: 'pest', label: 'Saved program', frequencyPerYear: 4, pricePerApplication: 100, taxable: false }] });
  fireEvent.click(screen.getByRole('button', { name: 'Add program' }));
  const added = () => screen.getAllByRole('switch', { name: 'Taxable program' })[1];
  const addedService = () => screen.getAllByLabelText('Service family')[1];
  expect(added()).toHaveAttribute('aria-checked', 'true');
  fireEvent.change(addedService(), { target: { value: 'lawn' } });
  expect(added()).toHaveAttribute('aria-checked', 'false');
  fireEvent.change(addedService(), { target: { value: 'pest' } });
  expect(added()).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(added());
  fireEvent.change(addedService(), { target: { value: 'other' } });
  expect(added()).toHaveAttribute('aria-checked', 'false');
  fireEvent.change(screen.getAllByLabelText('Service family')[0], { target: { value: 'other' } });
  expect(screen.getAllByRole('switch', { name: 'Taxable program' })[0]).toHaveAttribute('aria-checked', 'false');
});

// Owner 2026-10-28 proposal defaults check: Florida does not tax pest work at homes and their common areas (Rule
// 12A-1.009), so the building use is picked before saving and sets each row's Taxable switch.
const useSelect = () => screen.getByLabelText('Building use');
const lineSwitches = () => screen.getAllByRole('switch', { name: 'Taxable line' }).map((s) => s.getAttribute('aria-checked'));

it('with no building use picked, a row the operator adds starts not taxable and Save asks for the pick', async () => {
  await mount({ buildingUse: null });
  expect(useSelect()).toHaveValue('');
  expect(screen.getByText('Pick before saving. It sets which rows carry sales tax.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add line item' }));
  expect(lineSwitches()).toEqual(['false', 'false']);
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  expect(await screen.findByText(/Pick the building use before saving/)).toBeInTheDocument();
  expect(puts).toHaveLength(0);
  // Picking answers the message.
  fireEvent.change(useSelect(), { target: { value: 'residential' } });
  expect(screen.queryByText(/Pick the building use before saving/)).not.toBeInTheDocument();
});

it('Residential turns every row off and Business puts each back; the pick saves with the proposal', async () => {
  await mount({ buildingUse: null, taxable: true });
  fireEvent.click(screen.getByRole('button', { name: 'Add line item' }));
  // Not picked yet: the saved line keeps its switch, the added one starts off.
  expect(lineSwitches()).toEqual(['true', 'false']);
  fireEvent.change(useSelect(), { target: { value: 'residential' } });
  expect(lineSwitches()).toEqual(['false', 'false']);
  expect(screen.getByText('Homes, apartments, condos and HOA common areas. Florida does not tax pest work here.')).toBeInTheDocument();
  expect(screen.queryByText(TAX_ROW)).not.toBeInTheDocument();
  fireEvent.change(useSelect(), { target: { value: 'nonresidential' } });
  expect(lineSwitches()).toEqual(['true', 'true']);
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0].proposal.buildingUse).toBe('nonresidential');
  // The added line has no description, so only the saved line saves; the kept flag never does.
  expect(puts[0].proposal.buildings[0].lineItems).toHaveLength(1);
  expect(puts[0].proposal.buildings[0].lineItems[0]).toMatchObject({ taxable: true });
  expect(puts[0].proposal.buildings[0].lineItems[0]).not.toHaveProperty('bizTaxable');
});

it('a proposal saved as residential puts each program on its service rule when switched to Business', async () => {
  await mount({ buildingUse: 'residential', programs: [
    { id: 'pest-program', service: 'pest', label: 'Pest program', frequencyPerYear: 4, pricePerApplication: 100, taxable: false },
    { id: 'lawn-program', service: 'lawn', label: 'Lawn program', frequencyPerYear: 12, pricePerApplication: 50, taxable: false },
  ] });
  const programSwitches = () => screen.getAllByRole('switch', { name: 'Taxable program' }).map((s) => s.getAttribute('aria-checked'));
  expect(useSelect()).toHaveValue('residential');
  expect(programSwitches()).toEqual(['false', 'false']);
  fireEvent.change(useSelect(), { target: { value: 'nonresidential' } });
  expect(programSwitches()).toEqual(['true', 'false']);
});

it('rows that Generate from estimate installs follow the pick, and Business restores the server rule', async () => {
  generatedDraft = { programs: [{ service: 'pest', label: 'Quarterly pest program', frequencyPerYear: 4, pricePerApplication: 100, taxable: true, inclusions: [], exclusions: [] }] };
  await mount({ buildingUse: 'residential', buildings: [] });
  fireEvent.click(screen.getByRole('button', { name: /Generate from estimate/ }));
  const program = async () => (await screen.findAllByRole('switch', { name: 'Taxable program' }))[0];
  expect(await program()).toHaveAttribute('aria-checked', 'false');
  fireEvent.change(useSelect(), { target: { value: 'nonresidential' } });
  expect(await program()).toHaveAttribute('aria-checked', 'true');
});

// Codex #6945 r1: the kept business rule follows a family change, even where the visible switch stays as it was.
it('a program switched to Lawn while residential stays off when Business is picked', async () => {
  await mount({ buildingUse: 'residential', programs: [
    { id: 'pest-program', service: 'pest', label: 'Pest program', frequencyPerYear: 4, pricePerApplication: 100, taxable: false },
  ] });
  fireEvent.change(screen.getByLabelText('Service family'), { target: { value: 'lawn' } });
  fireEvent.change(useSelect(), { target: { value: 'nonresidential' } });
  expect(screen.getByRole('switch', { name: 'Taxable program' })).toHaveAttribute('aria-checked', 'false');
});

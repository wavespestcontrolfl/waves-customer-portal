// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CommercialProposalPage from './CommercialProposalPage';

// Owner 2026-10-29 "yes do phase 2": "Add program" opens a chooser of six templates (service, name, standard visit
// count) plus a blank row. A template installs the served family stack the way a family change does, with the same
// provenance, and leaves the price box empty (the pricing system has no commercial program prices).
const CADENCE_RE = /^\d+ scheduled applications? per year$/m;
const registry = {
  pest: {
    taxable: true,
    inclusions: ['Exterior perimeter treatment', 'Interior treatment on request'],
    exclusions: ['Termite treatment', 'Wildlife removal'],
    responsibilities: ['Provide access to all treated areas', 'Report pest activity to the office'],
  },
  rodent: {
    taxable: true,
    inclusions: ['Bait station checks'],
    exclusions: ['Structural exclusion repairs'],
    responsibilities: ['Provide access to all treated areas', 'Keep stored goods off the floor along walls'],
  },
  mosquito: { taxable: true, inclusions: ['Barrier treatment of foliage'], exclusions: ['Standing water removal'], responsibilities: [] },
  termite: { taxable: true, inclusions: ['Monitoring station inspection'], exclusions: ['Wood repair'], responsibilities: [] },
  lawn: { taxable: false, inclusions: ['Fertilizer applications'], exclusions: ['Irrigation repair'], responsibilities: ['Keep irrigation running on schedule'] },
  tree_shrub: { taxable: false, inclusions: ['Ornamental treatments'], exclusions: ['Tree removal'], responsibilities: [] },
  other: { taxable: true, inclusions: [], exclusions: [], responsibilities: [] },
};
const makeFixture = ({ buildingUse = 'nonresidential', familyRegistry = registry, responsibilities, generatedResponsibilities, programs } = {}) => ({
  bidToolsEnabled: true,
  suggestedTaxRate: 0.07,
  suggestedTaxSource: 'Manatee County',
  ...(familyRegistry ? { familyRegistry } : {}),
  estimate: { id: 'synthetic-proposal', status: 'draft', editVersion: 'loaded-version', customerName: 'Synthetic Office' },
  proposal: {
    enabled: true, title: 'Synthetic proposal', taxRate: 0,
    ...(buildingUse ? { buildingUse } : {}),
    buildings: programs ? [] : [{ name: 'Office', lineItems: [{ description: 'Monthly service', quantity: 1, unitPrice: 100, frequency: 'monthly', taxable: false }] }],
    ...(programs ? { programs } : {}),
    ...(responsibilities ? { customerResponsibilities: responsibilities } : {}),
    ...(generatedResponsibilities ? { generatedResponsibilities } : {}),
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
const openChooser = () => fireEvent.click(screen.getByRole('button', { name: 'Add program' }));
const addTemplate = (name) => { openChooser(); fireEvent.click(screen.getByRole('button', { name })); };
const respBox = () => screen.getByLabelText('Customer responsibilities');
const lines = (el) => el.value.split('\n');
const save = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  await waitFor(() => expect(puts).toHaveLength(1));
  return puts[0].proposal;
};
const taxSwitch = () => screen.getByRole('switch', { name: 'Taxable program' });

it('Add program opens a chooser with the six templates and a blank choice; nothing is added until one is tapped', async () => {
  await mount();
  openChooser();
  for (const name of [
    'Pest control · Monthly', 'Rodent control · Quarterly', 'Termite monitoring · Quarterly',
    'Mosquito control · 9 visits a year', 'Lawn care · 8 visits a year', 'Tree & shrub care · Every 2 months', 'Blank program',
  ]) expect(screen.getByRole('button', { name })).toBeInTheDocument();
  expect(screen.queryByLabelText('Service family')).toBeNull();
});

it('Cancel closes the chooser and adds nothing', async () => {
  await mount();
  openChooser();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('button', { name: 'Blank program' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Add program' })).toBeInTheDocument();
  expect(screen.queryByLabelText('Service family')).toBeNull();
});

it('the pest template fills the service, name, cadence, served stack and Taxable; the price box starts empty', async () => {
  await mount();
  addTemplate('Pest control · Monthly');
  expect(screen.getByLabelText('Service family')).toHaveValue('pest');
  expect(screen.getByDisplayValue('Pest control')).toBeInTheDocument();
  expect(screen.getByLabelText('Program frequency')).toHaveValue('12');
  expect(lines(screen.getByLabelText('Includes'))).toEqual([
    '12 scheduled applications per year', 'Exterior perimeter treatment', 'Interior treatment on request',
  ]);
  expect(lines(screen.getByLabelText('Not included'))).toEqual(['Termite treatment', 'Wildlife removal']);
  expect(screen.getByLabelText('Price per application')).toHaveValue(null);
  expect(taxSwitch()).toHaveAttribute('aria-checked', 'true');
  // The chooser closes after the pick; the programs section is open with the row.
  expect(screen.queryByRole('button', { name: 'Blank program' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Add program' })).toBeInTheDocument();
});

// Audit fix 6 (owner 2026-11-01): the counts are the commercial engine's (COMMERCIAL_*.programVisits), not the residential
// cadences. Nine and eight visits are not frequency presets, so those rows open on Custom with the count in the box.
it('each template uses the commercial engine cadence', async () => {
  await mount();
  addTemplate('Mosquito control · 9 visits a year');
  expect(screen.getByLabelText('Program frequency')).toHaveValue('custom');
  expect(screen.getByLabelText('Visits per year')).toHaveValue(9);
  expect(lines(screen.getByLabelText('Includes'))[0]).toBe('9 scheduled applications per year');
  addTemplate('Lawn care · 8 visits a year');
  expect(screen.getAllByLabelText('Visits per year')[1]).toHaveValue(8);
  expect(screen.getAllByLabelText('Service family')[1]).toHaveValue('lawn');
  expect(lines(screen.getAllByLabelText('Includes')[1])[0]).toBe('8 scheduled applications per year');
});

it('a residential building use, or no pick yet, starts the template row not taxable', async () => {
  await mount({ buildingUse: 'residential' });
  addTemplate('Pest control · Monthly');
  expect(taxSwitch()).toHaveAttribute('aria-checked', 'false');
  cleanup();
  await mount({ buildingUse: null });
  addTemplate('Pest control · Monthly');
  expect(taxSwitch()).toHaveAttribute('aria-checked', 'false');
});

it('a lawn template at a business building follows the lawn rule (not taxable)', async () => {
  await mount();
  addTemplate('Lawn care · 8 visits a year');
  expect(taxSwitch()).toHaveAttribute('aria-checked', 'false');
});

it('responsibilities append once: a line already in the box is not duplicated and is not provenance; appended lines are', async () => {
  await mount({ programs: [], responsibilities: ['Provide access to all treated areas'] });
  addTemplate('Pest control · Monthly');
  expect(lines(respBox())).toEqual([
    'Provide access to all treated areas', 'Report pest activity to the office',
  ]);
  // A second template with an overlapping line adds only the new one.
  addTemplate('Rodent control · Quarterly');
  expect(lines(respBox())).toEqual([
    'Provide access to all treated areas', 'Report pest activity to the office', 'Keep stored goods off the floor along walls',
  ]);
  for (const box of screen.getAllByLabelText('Price per application')) fireEvent.change(box, { target: { value: '100' } });
  const proposal = await save();
  expect(proposal.customerResponsibilities).toHaveLength(3);
  // The pre-existing line (maybe hand-authored) is never prunable; only appended lines are recorded.
  expect(proposal.generatedResponsibilities).toEqual({
    pest: ['Report pest activity to the office'],
    rodent: ['Keep stored goods off the floor along walls'],
  });
});

it('an empty responsibilities box gets the lines with no blank first line', async () => {
  await mount();
  addTemplate('Pest control · Monthly');
  expect(respBox().value).toBe('Provide access to all treated areas\nReport pest activity to the office');
});

it('switching the template row to another service prunes its lines and installs the new stack', async () => {
  await mount();
  addTemplate('Pest control · Monthly');
  fireEvent.change(screen.getByLabelText('Service family'), { target: { value: 'lawn' } });
  expect(lines(screen.getByLabelText('Includes'))).toEqual(['12 scheduled applications per year', 'Fertilizer applications']);
  expect(lines(screen.getByLabelText('Not included'))).toEqual(['Irrigation repair']);
  expect(lines(respBox())).toEqual(['Keep irrigation running on schedule']);
  expect(taxSwitch()).toHaveAttribute('aria-checked', 'false');
});

it('removing a template row prunes its responsibilities and leaves hand-typed ones', async () => {
  await mount({ responsibilities: ['Notify the office of renovations'] });
  addTemplate('Pest control · Monthly');
  expect(lines(respBox())).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'Remove program' }));
  expect(lines(respBox())).toEqual(['Notify the office of renovations']);
});

it('changing the frequency after a template updates the cadence bullet', async () => {
  await mount();
  addTemplate('Pest control · Monthly');
  fireEvent.change(screen.getByLabelText('Program frequency'), { target: { value: '4' } });
  const text = screen.getByLabelText('Includes').value;
  expect(text).toMatch(CADENCE_RE);
  expect(lines(screen.getByLabelText('Includes'))[0]).toBe('4 scheduled applications per year');
  expect(text).not.toContain('12 scheduled');
});

it('Blank program adds the same blank row as before', async () => {
  await mount();
  addTemplate('Blank program');
  expect(screen.getByLabelText('Service family')).toHaveValue('pest');
  expect(screen.getByLabelText('Program name')).toHaveValue('');
  expect(screen.getByLabelText('Program frequency')).toHaveValue('4');
  expect(screen.getByLabelText('Price per application')).toHaveValue(0);
  expect(screen.getByLabelText('Includes')).toHaveValue('');
  expect(screen.getByLabelText('Not included')).toHaveValue('');
  expect(respBox()).toHaveValue('');
  expect(taxSwitch()).toHaveAttribute('aria-checked', 'true');
  expect(screen.queryByRole('button', { name: 'Blank program' })).toBeNull();
});

it('with no served registry a template fills only the service, name, cadence and Taxable', async () => {
  await mount({ familyRegistry: null });
  addTemplate('Pest control · Monthly');
  expect(screen.getByLabelText('Service family')).toHaveValue('pest');
  expect(screen.getByDisplayValue('Pest control')).toBeInTheDocument();
  expect(screen.getByLabelText('Includes')).toHaveValue('');
  expect(screen.getByLabelText('Not included')).toHaveValue('');
  expect(respBox()).toHaveValue('');
  expect(taxSwitch()).toHaveAttribute('aria-checked', 'false');
});

it('the chooser also opens from the button under an existing program list', async () => {
  await mount({ programs: [{ id: 'saved-program', service: 'pest', label: 'Saved program', frequencyPerYear: 4, pricePerApplication: 100, taxable: false }] });
  addTemplate('Termite monitoring · Quarterly');
  expect(screen.getAllByLabelText('Service family')[1]).toHaveValue('termite');
  expect(screen.getByDisplayValue('Termite monitoring')).toBeInTheDocument();
});

it('an unpriced template row stays out of the totals and Save asks for the price; typing a price saves the whole row', async () => {
  await mount({ programs: [] });
  addTemplate('Pest control · Monthly');
  // Unpriced: the row adds nothing to the totals, and Save refuses with the minimum-price message (like a blank row).
  expect(screen.getByText('Annual recurring').nextSibling).toHaveTextContent('$0.00');
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  expect(await screen.findByText(/Program “Pest control” needs a name, a per-application price of at least \$0\.01/)).toBeInTheDocument();
  expect(puts).toHaveLength(0);

  fireEvent.change(screen.getByLabelText('Price per application'), { target: { value: '125' } });
  // $125 x 12 visits.
  await waitFor(() => expect(screen.getByText('Annual recurring').nextSibling).toHaveTextContent('$1,500.00'));
  const proposal = await save();
  expect(proposal.programs).toHaveLength(1);
  expect(proposal.programs[0]).toMatchObject({
    service: 'pest',
    label: 'Pest control',
    frequencyPerYear: 12,
    pricePerApplication: 125,
    taxable: true,
    inclusions: ['12 scheduled applications per year', 'Exterior perimeter treatment', 'Interior treatment on request'],
    exclusions: ['Termite treatment', 'Wildlife removal'],
    generatedInclusions: ['Exterior perimeter treatment', 'Interior treatment on request'],
    generatedExclusions: ['Termite treatment', 'Wildlife removal'],
  });
  expect(proposal.programs[0]).not.toHaveProperty('visitMinutes');
  expect(proposal.programs[0]).not.toHaveProperty('isNew');
});

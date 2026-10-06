// @vitest-environment jsdom
//
// A plan that carries a bermuda backpack mix order shows it as its own block beside the
// base mixing order, and only then.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TreatmentPlanPanel from './TreatmentPlanPanel';

const bermudaMixingOrder = [
  { step: 1, productId: null, productName: 'Water', instruction: 'Fill the backpack sprayer about half full with clean water.' },
  { step: 2, productId: 'rec', productName: 'Fixture Recognition', instruction: 'Add the Recognition.' },
  { step: 3, productId: 'fus', productName: 'Fixture Fusilade', instruction: 'Add the Fusilade.' },
  { step: 4, productId: 'nis', productName: 'Fixture surfactant', instruction: 'Add the surfactant last.' },
];
const base = {
  status: 'approved',
  propertyGate: { trackName: 'Fixture track', month: 'Jun', visit: 6 },
  protocol: { objective: 'Fixture objective', base: [], conditional: [] },
  mixCalculator: { items: [] },
  mixingOrder: [{ step: 1, productId: 'pot', productName: 'Fixture potassium', instruction: 'Add the potassium.' }],
};
let plan;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ plan }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mount = async () => {
  await act(async () => {
    render(<TreatmentPlanPanel service={{ id: 'plan-visit', serviceType: 'Lawn Care', customerName: 'Fixture account' }} onClose={() => {}} />);
  });
};

it('shows the bermuda backpack mix order as its own block, apart from the base order', async () => {
  plan = { ...base, bermudaMixingOrder };
  await mount();
  expect(screen.getByText('Bermuda backpack mix')).toBeTruthy();
  for (const { productName } of bermudaMixingOrder) expect(screen.getByText(productName)).toBeTruthy();
  expect(screen.getByText('Mixing Order')).toBeTruthy();
  expect(screen.getByText('Fixture potassium')).toBeTruthy();
});

it('shows no such block when the plan carries none', async () => {
  plan = base;
  await mount();
  expect(screen.getByText('Fixture potassium')).toBeTruthy();
  expect(screen.queryByText('Bermuda backpack mix')).toBeNull();
});

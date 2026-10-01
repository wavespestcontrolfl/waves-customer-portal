// @vitest-environment jsdom
//
// Owner ruling (2026-09-27, every service 2026-09-29): nothing a tech sees is
// in mL. A lawn protocol product can carry an mL unit (the protocol editor
// accepts any rate unit), so the plan's mix amounts read an mL quantity the
// way the truck measures it (tsp under 1 fl oz, else fl oz). Every other unit
// prints exactly as the plan serves it.
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TreatmentPlanPanel from './TreatmentPlanPanel';

const ML_WORD = /\b(ml|millilit(er|re)s?)\b/i;
const kelp = { id: 'plan-kelp', name: 'Fixture kelp', category: 'biostimulant' };
const potassium = { id: 'plan-potassium', name: 'Fixture potassium', category: 'fertilizer' };
const plan = {
  status: 'approved',
  propertyGate: { trackName: 'Fixture track', month: 'Jul', visit: 7 },
  protocol: {
    objective: 'Fixture objective',
    base: [
      { raw: 'Kelp in the tank', matched: true, selected: true, product: kelp, mix: { amount: 30, amountUnit: 'ml' } },
      { raw: 'Kelp by the spoon', matched: true, selected: true, product: { ...kelp, id: 'plan-kelp-small', name: 'Fixture kelp small' }, mix: { amount: 5, amountUnit: 'ml' } },
      { raw: 'Potassium in the tank', matched: true, selected: true, product: potassium, mix: { amount: 12, amountUnit: 'fl_oz' } },
    ],
    conditional: [],
  },
  mixCalculator: { items: [] },
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ plan }) })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('reads an mL mix amount in fl oz or tsp and leaves a fl oz amount as served', async () => {
  await act(async () => {
    render(<TreatmentPlanPanel service={{ id: 'plan-visit', serviceType: 'Lawn Care', customerName: 'Fixture account' }} onClose={() => {}} />);
  });
  const line = (text) => within(screen.getByText(text).closest('.rounded-sm'));
  // 30 mL is 1.01 fl oz; 5 mL is 1 tsp.
  expect(line('Kelp in the tank').getByText('1.01 fl oz')).toBeTruthy();
  expect(line('Kelp by the spoon').getByText('1 tsp')).toBeTruthy();
  expect(line('Potassium in the tank').getByText('12')).toBeTruthy();
  expect(line('Potassium in the tank').getByText('fl_oz')).toBeTruthy();
  expect(document.body.textContent).not.toMatch(ML_WORD);
});

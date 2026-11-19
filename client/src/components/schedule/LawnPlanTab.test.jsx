// @vitest-environment jsdom
//
// The Plan tab of the Protocol panel (lawn visits): facts, nitrogen budget, blocks, protocol
// lines and closeout, with no product amount anywhere (amounts live on the Job tab, under its
// withhold rules).
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import LawnPlanTab from './LawnPlanTab';
import protocols from '../../../../server/config/protocols.json';

afterEach(cleanup);

const kelp = { id: 'plan-kelp', name: 'Fixture kelp', category: 'biostimulant', groups: { moa: '5' } };
const plan = {
  status: 'approved',
  propertyGate: {
    trackName: 'Fixture track', month: 'Jul', visit: 7, lawnSqft: 8000, municipality: 'Fixture County', ordinanceStatus: 'Summer ban',
    annualN: { used: 1.5, limit: 4, projected: 2, status: 'ok', remainingAfterVisit: 2, ledgerEntries: 3 },
    latestAssessment: { overallScore: 82 },
    blocks: [{ code: 'nitrogen_blackout', message: 'Fixture blackout.' }],
    warnings: [{ code: 'rotation_repeat', message: 'Fixture repeat.' }],
  },
  protocol: {
    objective: 'Fixture objective',
    base: [{ raw: 'Fixture kelp line', description: 'Fixture kelp line', matched: true, selected: true, product: kelp, mix: { amount: 30, amountUnit: 'fl oz' } }],
    conditional: [
      { raw: 'Fixture optional line', description: 'Fixture optional line', conditional: true, matched: true, selected: false, product: { id: 'opt', name: 'Fixture optional' }, mix: { amount: 7.25, amountUnit: 'fl oz' } },
      { raw: 'Fixture chosen line', description: 'Fixture chosen line', conditional: true, matched: true, selected: true, product: { id: 'chosen', name: 'Fixture chosen' } },
      { raw: 'Fixture orphan line', description: 'Fixture orphan line', conditional: false, matched: false, selected: true },
    ],
  },
  mixCalculator: { carrierGalPer1000: 2, nutrientProjection: { nPer1000: 0.5, pPer1000: 0, kPer1000: 1 }, items: [{ mix: { amount: 99 } }] },
  closeout: { requiredPhotos: ['Before', 'After'], captureActualProductAmounts: true, customerRecapPreview: 'Fixture recap' },
};

describe('LawnPlanTab', () => {
  it('shows the lawn facts, nitrogen budget, blocks, warnings, protocol lines and closeout', () => {
    render(<LawnPlanTab plan={plan} loading={false} error="" onRefresh={() => {}} />);
    for (const text of ['Fixture track', 'Jul / 7', '8,000 sq ft', 'Fixture County', 'Summer ban', '2 gal/1K', '82/100', '1.5 used / 4 limit', '2 (ok)', '3 entries', 'Before, After', 'Required', 'Fixture recap']) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(screen.getByText('Blocks')).toBeTruthy();
    expect(screen.getByText('Fixture blackout.')).toBeTruthy();
    expect(screen.getByText('Fixture repeat.')).toBeTruthy();
  });

  it('labels conditional lines Optional or Selected, flags an unmatched line, and shows no amount or tick', () => {
    const { container } = render(<LawnPlanTab plan={plan} loading={false} error="" onRefresh={() => {}} />);
    expect(screen.getByText('Optional')).toBeTruthy();
    expect(screen.getByText('Selected')).toBeTruthy();
    expect(screen.getByText('Unmatched')).toBeTruthy();
    expect(screen.getByText('MOA 5')).toBeTruthy();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    // The plan carries mix amounts (30, 7.25, 99); the tab shows none of them.
    expect(container.textContent).not.toMatch(/\b(30|7\.25|99)\b/);
  });

  it('shows each line\'s description, never the raw protocol text with its rate and price, matched or not', () => {
    const rated = {
      ...plan,
      mixCalculator: { carrierGalPer1000: 2, nutrientProjection: { nPer1000: 1, pPer1000: 0, kPer1000: 1 } },
      protocol: {
        objective: 'Fixture objective',
        base: [{ raw: 'Stonewall 4FL 0.5 fl oz per 1,000 ($3.51)', description: 'Stonewall 4FL', matched: true, selected: true, product: { id: 's', name: 'Stonewall 4FL' } }],
        conditional: [{ raw: 'Orphan Herbicide 2 oz/1000 sq ft ($15.00)', description: 'Orphan Herbicide', conditional: true, matched: false, selected: false }],
      },
    };
    const { container } = render(<LawnPlanTab plan={rated} loading={false} error="" onRefresh={() => {}} />);
    expect(screen.getAllByText('Stonewall 4FL').length).toBeGreaterThan(0);
    // The unmatched line has no product: its description is the name.
    expect(screen.getAllByText('Orphan Herbicide').length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/0\.5|3\.51|per 1,000|\$|2 oz|15\.00/);
  });

  it('shows a notice by its description when the server gives one: a stock block with no planned quantity', () => {
    const stock = { code: 'inventory_insufficient_stock', message: 'Fixture kelp requires 12.5 gal, but only 4 gal is on hand.', description: 'Fixture kelp: not enough on hand for this visit.' };
    render(<LawnPlanTab plan={{ ...plan, propertyGate: { ...plan.propertyGate, blocks: [stock] } }} loading={false} error="" onRefresh={() => {}} />);
    expect(screen.getByText('Fixture kelp: not enough on hand for this visit.')).toBeTruthy();
    expect(screen.queryByText(/12\.5 gal/)).toBeNull();
    expect(screen.getByText('Fixture repeat.')).toBeTruthy();
  });

  it('shows the plan objective by its description: the real June lawn note, with its Advion rate, shows no dose', () => {
    const note = JSON.stringify(protocols).match(/"notes":"([^"]*Advion Insect Granule bait, 3 lb per 1,000 sq ft[^"]*)"/)?.[1];
    expect(note).toBeTruthy();
    // What GET /admin/treatment-plans sends as `objectiveDescription` for that note (the server's describeLine output).
    const objectiveDescription = 'BLACKOUT. K-Flow (soil-test gated). N rate: ★ Chinch IPM threshold defined. Mole cricket nymph spots (UF/IFAS and Clemson: treat small nymphs from mid-June through July): Advion Insect Granule bait, of treated area by hand shaker, on the tunnel areas, once per spot per year. Fall adults: Dylox.';
    const { container } = render(<LawnPlanTab plan={{ ...plan, protocol: { ...plan.protocol, objective: note, objectiveDescription } }} loading={false} error="" onRefresh={() => {}} />);
    expect(container.textContent).toContain('Advion Insect Granule bait');
    expect(container.textContent).not.toMatch(/3 lb|per 1,000 sq ft|\$/);
  });

  it('names the tab that carries the mix amounts, by whether the panel has a Job tab', () => {
    const { rerender } = render(<LawnPlanTab plan={plan} loading={false} error="" onRefresh={() => {}} jobTab />);
    expect(screen.getByText('Amounts show on the Job tab.')).toBeTruthy();
    rerender(<LawnPlanTab plan={plan} loading={false} error="" onRefresh={() => {}} jobTab={false} />);
    expect(screen.getByText('The Job tab is off. Mix amounts show on the Lawn tab.')).toBeTruthy();
    rerender(<LawnPlanTab plan={plan} loading={false} error="" onRefresh={() => {}} />);
    expect(screen.queryByText(/Job tab/)).toBeNull();
  });

  it('says so while loading, and when the plan cannot be read', () => {
    const { rerender } = render(<LawnPlanTab plan={null} loading error="" onRefresh={() => {}} />);
    expect(screen.getByText('Loading plan…')).toBeTruthy();
    rerender(<LawnPlanTab plan={null} loading={false} error="Boom" onRefresh={() => {}} />);
    expect(screen.getByText('Plan unavailable')).toBeTruthy();
    expect(screen.getByText('Boom')).toBeTruthy();
  });
});

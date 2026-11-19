// @vitest-environment jsdom
//
// The Plan tab of the Protocol panel (lawn visits): facts, nitrogen budget, blocks, protocol
// lines and closeout, with no product amount anywhere (amounts live on the Job tab, under its
// withhold rules).
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import LawnPlanTab from './LawnPlanTab';

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
    base: [{ raw: 'Fixture kelp line', matched: true, selected: true, product: kelp, mix: { amount: 30, amountUnit: 'fl oz' } }],
    conditional: [
      { raw: 'Fixture optional line', conditional: true, matched: true, selected: false, product: { id: 'opt', name: 'Fixture optional' }, mix: { amount: 7.25, amountUnit: 'fl oz' } },
      { raw: 'Fixture chosen line', conditional: true, matched: true, selected: true, product: { id: 'chosen', name: 'Fixture chosen' } },
      { raw: 'Fixture orphan line', conditional: false, matched: false, selected: true },
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

  it('says so while loading, and when the plan cannot be read', () => {
    const { rerender } = render(<LawnPlanTab plan={null} loading error="" onRefresh={() => {}} />);
    expect(screen.getByText('Loading plan…')).toBeTruthy();
    rerender(<LawnPlanTab plan={null} loading={false} error="Boom" onRefresh={() => {}} />);
    expect(screen.getByText('Plan unavailable')).toBeTruthy();
    expect(screen.getByText('Boom')).toBeTruthy();
  });
});

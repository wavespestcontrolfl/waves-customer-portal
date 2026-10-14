// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LawnTrends, VisualDiagnosisCards, WaterIntakeBar } from './LawnReportV2';

afterEach(cleanup);

// GATE_LAWN_REPORT_COPY_FIXES (fixes 3, 5, 6): the client prints what the payload carries.
describe('the water target source line', () => {
  const water = { rainInches: 0.9, irrigationInches: 0.7, totalInches: 1.6, targetInches: 0.75, status: 'balanced' };

  it('prints the server sentence directly under the Target range row', () => {
    render(<WaterIntakeBar water={{ ...water, targetNote: 'Based on the weather in your area for the week ending on this visit, your grass type and the time of year.' }} />);
    const note = screen.getByTestId('lawn-water-target-note');
    expect(note).toHaveTextContent('Based on the weather in your area for the week ending on this visit, your grass type and the time of year.');
    expect(screen.getByText('Target range').parentElement).toContainElement(note);
    expect(screen.getByText('Target range').compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('prints nothing without the key (gate off) and nothing without a target', () => {
    const { rerender } = render(<WaterIntakeBar water={water} />);
    expect(screen.queryByTestId('lawn-water-target-note')).toBeNull();
    rerender(<WaterIntakeBar water={{ ...water, targetInches: null, targetNote: 'Based on x.' }} />);
    expect(screen.queryByTestId('lawn-water-target-note')).toBeNull();
  });
});

describe('the weed score card', () => {
  it('prints the label the server sends, with the same status word', () => {
    render(<VisualDiagnosisCards categories={[{ key: 'weed_pressure', label: 'Weed Cleanliness', score: 90, status: 'strong', explanation: 'Very little weed activity visible today.' }]} />);
    expect(screen.getByText('Weed Cleanliness')).toBeInTheDocument();
    expect(screen.queryByText('Weed Pressure')).toBeNull();
    expect(screen.getByText('Strong')).toBeInTheDocument();
  });
});

describe('stale charts', () => {
  it('a payload without the stale charts draws no Water Gap or Mowing Height heading', () => {
    render(<LawnTrends trends={{ overall: [{ label: 'Jul', value: 56 }, { label: 'Oct', value: 80 }] }} baselineScore={80} />);
    expect(screen.queryByText('Water Gap')).toBeNull();
    expect(screen.queryByText('Mowing Height')).toBeNull();
    expect(screen.getByText('Lawn Health Trend')).toBeInTheDocument();
  });
});

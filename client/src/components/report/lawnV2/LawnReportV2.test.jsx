// @vitest-environment jsdom
// Pins for the 2026-07-16 audit fixes in the V2 report primitives:
// inchLabel integer handling, unknown mowing band honesty, TrendChip
// unknown-trend behavior, MeterSvg empty-string guard.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LawnTrends, WaterIntakeBar } from './LawnReportV2';
import { MeterSvg, TrendChip } from '../GaugePrimitives';

afterEach(cleanup);

describe('WaterIntakeBar inch labels', () => {
  it('renders 0 as 0" (the old regex ate integer zeros: 0 → \'"\', 10 → \'1"\')', () => {
    render(<WaterIntakeBar water={{ rainInches: 0, irrigationInches: 1.5, totalInches: 1.5, targetInches: 1.25, status: 'balanced' }} />);
    expect(screen.getByText('0"')).toBeInTheDocument();
    // irrigation + total both read 1.5" here — the point is they render as
    // numbers, not the old bare-quote artifact
    expect(screen.getAllByText('1.5"').length).toBeGreaterThan(0);
  });
});

describe('LawnTrends mowing band honesty', () => {
  const mowing = [
    { date: '2026-05-26', value: 3.2 },
    { date: '2026-07-06', value: 3.4 },
  ];

  it('unknown band ([null, null] from the server) shows readings without a false off-target accent', () => {
    render(<LawnTrends trends={{ mowing, mowingBand: [null, null] }} />);
    expect(screen.getByText('Mowing Height')).toBeInTheDocument();
    expect(screen.getByText('recent readings')).toBeInTheDocument();
    expect(screen.queryByText('vs. ideal band')).not.toBeInTheDocument();
  });

  it('a real band keeps the vs. ideal band framing', () => {
    render(<LawnTrends trends={{ mowing, mowingBand: [3.5, 4.0] }} />);
    expect(screen.getByText('vs. ideal band')).toBeInTheDocument();
  });
});

describe('GaugePrimitives honesty guards', () => {
  it('TrendChip renders nothing for an unknown trend instead of asserting "Stable"', () => {
    const { container } = render(<TrendChip trend="mystery_state" delta={null} />);
    expect(container).toBeEmptyDOMElement();
    render(<TrendChip trend="stable" delta={0} />);
    expect(screen.getByText(/Stable/)).toBeInTheDocument();
  });

  it('MeterSvg treats an empty-string score as not-yet-available, not a real 0', () => {
    render(<MeterSvg score="" label={null} />);
    expect(screen.getByRole('img', { name: /score not yet available/i })).toBeInTheDocument();
  });
});

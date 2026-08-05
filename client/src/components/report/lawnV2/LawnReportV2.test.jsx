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

describe('WaterIntakeBar irrigation honesty (owner 2026-08-04)', () => {
  it('no schedule on file: shows "Not on file" instead of a false 0" reading', () => {
    render(<WaterIntakeBar water={{ rainInches: 2.96, irrigationInches: 0, totalInches: 2.96, targetInches: 0.75, status: 'high', confidence: 'low', scheduleOnFile: false }} />);
    expect(screen.getByText('Not on file')).toBeInTheDocument();
    expect(screen.queryByText('0"')).not.toBeInTheDocument();
    // The confidence tag names the actual gap instead of blaming the rain data.
    expect(screen.getByText('Irrigation not on file')).toBeInTheDocument();
    expect(screen.queryByText('Limited data this week')).not.toBeInTheDocument();
  });

  it('a real schedule keeps the numeric row and the standard confidence tag', () => {
    render(<WaterIntakeBar water={{ rainInches: 1.2, irrigationInches: 0.5, totalInches: 1.7, targetInches: 0.75, status: 'high', confidence: 'high', scheduleOnFile: true }} />);
    expect(screen.getByText('0.5"')).toBeInTheDocument();
    expect(screen.queryByText('Not on file')).not.toBeInTheDocument();
    expect(screen.getByText('Verified data')).toBeInTheDocument();
  });

  it('rain-unknown + no schedule keeps the low-confidence label (codex P2 r2)', () => {
    // Number(null) coerces to a finite 0 — the override must verify the rain
    // reading actually exists before claiming irrigation is the only gap.
    render(<WaterIntakeBar water={{ rainInches: null, irrigationInches: 0, totalInches: 0, targetInches: 0.75, status: 'unknown', confidence: 'low', scheduleOnFile: false }} />);
    expect(screen.getByText('Limited data this week')).toBeInTheDocument();
    expect(screen.queryByText('Irrigation not on file')).not.toBeInTheDocument();
  });

  it('older payloads without scheduleOnFile keep the numeric row (no false "Not on file")', () => {
    render(<WaterIntakeBar water={{ rainInches: 1.2, irrigationInches: 0, totalInches: 1.2, targetInches: 0.75, status: 'high', confidence: 'low' }} />);
    expect(screen.getByText('0"')).toBeInTheDocument();
    expect(screen.queryByText('Not on file')).not.toBeInTheDocument();
    expect(screen.getByText('Limited data this week')).toBeInTheDocument();
  });
});

describe('LawnTrends first-visit baseline (owner 2026-08-04)', () => {
  it('no chartable series + a real score → baseline card, not silence', () => {
    render(<LawnTrends trends={{}} baselineScore={74} />);
    expect(screen.getByText('Progress Tracking')).toBeInTheDocument();
    expect(screen.getByText(/baseline at 74\/100/)).toBeInTheDocument();
    expect(screen.getByText(/next visit/i)).toBeInTheDocument();
  });

  it('no score → still renders nothing (an unscored visit makes no baseline claim)', () => {
    const { container } = render(<LawnTrends trends={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('real trends render charts, never the baseline card', () => {
    const overall = [
      { date: '2026-06-01', label: 'Jun 1', value: 62 },
      { date: '2026-07-01', label: 'Jul 1', value: 70 },
    ];
    render(<LawnTrends trends={{ overall }} baselineScore={70} />);
    expect(screen.getByText('Lawn Health Trend')).toBeInTheDocument();
    expect(screen.queryByText('Progress Tracking')).not.toBeInTheDocument();
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

// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MeterSvg, PressureHistoryChart, TrendChip } from './GaugePrimitives';

afterEach(() => cleanup());

describe('TrendChip', () => {
  // 'rescaled' = earlier scores exist but on the pre-2026-09-24 scale: the
  // gauge must claim nothing (no "First marker", no up/down, no delta).
  it('renders nothing for a rescaled trend, even with a stray delta', () => {
    const { container } = render(<TrendChip trend="rescaled" delta={2.1} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('still renders a real trend with its delta', () => {
    const { container } = render(<TrendChip trend="increasing" delta={0.7} />);
    expect(container).toHaveTextContent('Increasing');
    expect(container).toHaveTextContent('+0.7 vs. last visit');
  });
});

describe('PressureHistoryChart', () => {
  it('renders nothing when fewer than 2 valid scored points exist', () => {
    const { container } = render(
      <PressureHistoryChart
        history={[
          { serviceDate: '2026-08-01', score: 2.0 },
          { serviceDate: '2026-09-01', score: null },
        ]}
        cadence="quarterly"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders an accessible SVG line chart sorted chronologically with cadence note and 14px HTML axis labels', () => {
    render(
      <PressureHistoryChart
        history={[
          { serviceDate: '2026-10-01', score: 1.2 },
          { serviceDate: '2026-07-01', score: 2.8 },
          { serviceDate: '2026-08-15', score: null },
        ]}
        cadence="quarterly"
      />,
    );
    const chart = screen.getByRole('img', { name: /Score history across 2 visits from 2\.8 to 1\.2 out of 5\./i });
    expect(chart).toBeInTheDocument();
    expect(screen.getAllByTestId('history-point')).toHaveLength(2);
    expect(screen.getByText("Jul '26")).toHaveStyle({ fontSize: '14px' });
    expect(screen.getByText('Last 2 quarterly visits')).toBeInTheDocument();
    expect(screen.getByText(/service cadence — quarterly\./i)).toBeInTheDocument();
  });

  it('handles identical timestamps without NaN coordinates', () => {
    const { container } = render(
      <PressureHistoryChart
        history={[
          { serviceDate: '2026-10-01', score: 3.0 },
          { serviceDate: '2026-10-01', score: 2.0 },
        ]}
      />,
    );
    const points = screen.getAllByTestId('history-point');
    expect(points).toHaveLength(2);
    points.forEach((pt) => {
      expect(Number.isFinite(Number(pt.dataset.x))).toBe(true);
      expect(Number.isFinite(Number(pt.dataset.y))).toBe(true);
    });
    container.querySelectorAll('path').forEach((p) => {
      expect(p.getAttribute('d')).not.toContain('NaN');
    });
  });
});

describe('MeterSvg', () => {
  it('announces numeric and missing scores clearly', () => {
    render(<MeterSvg score={1.5} label={{ name: 'Low' }} />);
    expect(screen.getByRole('img', { name: 'Pest Pressure 1.5 out of 5, labelled Low.' })).toBeInTheDocument();
    cleanup();
    render(<MeterSvg score={null} label={{ name: 'None' }} noun="Activity" />);
    expect(screen.getByRole('img', { name: 'Activity score not yet available.' })).toBeInTheDocument();
  });
});

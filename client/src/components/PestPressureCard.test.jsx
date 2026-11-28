// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import PestPressureCard from './PestPressureCard';

afterEach(() => cleanup());

describe('PestPressureCard', () => {
  it('renders score, history SVG, and enforces >= 14px inline text floor', () => {
    const { container } = render(
      <PestPressureCard
        token="a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
        data={{
          enabled: true,
          showOnCustomerReport: true,
          dataCompleteness: 'complete',
          score: 1.4,
          label: 'Low',
          date: '2026-11-15',
          trend: 'improving',
          trendDelta: -0.6,
          cadence: 'quarterly',
          summary: 'Pest activity remains low around the exterior.',
          canCaptureClientRating: true,
          showComponentBreakdown: true,
          components: {
            technicianRating: { present: true, value: 1.4, weight: 60 },
          },
          history: [
            { serviceDate: '2026-08-15', score: 2.0 },
            { serviceDate: '2026-11-15', score: 1.4 },
          ],
        }}
      />,
    );

    expect(screen.getByText('Low — 1.4 / 5')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Score history across 2 visits/i })).toBeInTheDocument();

    const smallFonts = Array.from(container.querySelectorAll('[style]'))
      .map((el) => el.style.fontSize)
      .filter(Boolean)
      .map((sz) => Number.parseFloat(sz))
      .filter((px) => Number.isFinite(px) && px < 14);
    expect(smallFonts).toEqual([]);
  });
});

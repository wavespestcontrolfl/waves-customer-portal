// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { TreeShrubTrends } from './TreeShrubReportV2';

afterEach(cleanup);

/**
 * T&S audit 2026-07-18 P2: the T&S TrendChart shipped with role="img"
 * (flattens every descendant to presentational) and mouse-only point
 * targets — the exact gap the lawn TrendChart fixed in #2824 r2. Pins the
 * ported keyboard/AT contract so it can't regress independently again.
 */

const trends = {
  overall: [
    { label: 'May 12', value: 62 },
    { label: 'Jun 23', value: 71 },
    { label: 'Jul 18', value: 78 },
  ],
};

describe('TreeShrubTrends — keyboard/AT contract', () => {
  it('chart svg is a group (not img) so point buttons stay in the a11y tree', () => {
    const { container } = render(<TreeShrubTrends trends={trends} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('role')).toBe('group');
  });

  it('every data point is a focusable labelled button', () => {
    const { container } = render(<TreeShrubTrends trends={trends} />);
    const points = container.querySelectorAll('circle[role="button"]');
    expect(points.length).toBe(trends.overall.length);
    for (const point of points) {
      expect(point.getAttribute('tabindex')).toBe('0');
      expect(point.getAttribute('aria-label')).toBeTruthy();
    }
    expect(points[1].getAttribute('aria-label')).toBe('Jun 23: 71');
  });

  it('Enter and Space toggle a point like a click does', () => {
    const { container } = render(<TreeShrubTrends trends={trends} />);
    const point = container.querySelectorAll('circle[role="button"]')[0];
    // Activating a point renders its value label above the point.
    fireEvent.keyDown(point, { key: 'Enter' });
    expect(container.textContent).toContain('62');
    fireEvent.keyDown(point, { key: ' ' });
    // Toggled off — the default (latest) value label renders instead.
    expect(container.textContent).toContain('78');
  });
});

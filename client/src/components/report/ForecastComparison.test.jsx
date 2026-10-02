// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import ForecastComparison from './ForecastComparison';

afterEach(cleanup);

test('legacy up means above seasonal baseline, not increasing pest activity', () => {
  render(<ForecastComparison forecast={{ trend: 'up' }} />);
  expect(screen.getByText('Above seasonal baseline')).toBeTruthy();
  expect(screen.queryByText(/higher than|increasing|rising|similar than/i)).toBeNull();
});

test('a lower historical outlook can coexist with an above-baseline score', () => {
  render(<ForecastComparison forecast={{ baselineComparison: 'above', weekOverWeek: { direction: 'down', previous_date: '2026-09-25' } }} />);
  expect(screen.getByText('Above seasonal baseline')).toBeTruthy();
  expect(screen.getByText('Modeled outlook lower than 2026-09-25')).toBeTruthy();
});

test('missing history and unknown directions never become a flat comparison', () => {
  const { container } = render(<ForecastComparison forecast={{ weekOverWeek: { direction: 'unknown', previous_date: '2026-09-25' } }} />);
  expect(container.textContent).toBe('');
});

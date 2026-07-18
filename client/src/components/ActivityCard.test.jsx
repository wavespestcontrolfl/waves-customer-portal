// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ActivityCard from './ActivityCard';

// The cumulative knockdown-progress chip renders only when the server payload
// carries `progress` (TYPED_PROGRESS_SUMMARY, knockdown indicators, improved
// vs baseline) — the client never derives it. Factual numbers only.

const BASE = {
  indicatorKey: 'bed_bug_activity',
  label: 'Bed Bug Activity',
  score: 1,
  maxScore: 5,
  levelWord: 'Very low activity',
  trend: 'improving',
  trendWord: 'decreased since the last visit',
  isBaseline: false,
  history: [
    { serviceRecordId: 'v1', serviceDate: '2026-06-12', score: 4, levelWord: 'High activity', isCurrent: false },
    { serviceRecordId: 'v3', serviceDate: '2026-07-10', score: 1, levelWord: 'Very low activity', isCurrent: true },
  ],
};

afterEach(cleanup);

describe('ActivityCard — knockdown progress chip', () => {
  it('renders the baseline comparison when the payload carries progress', () => {
    render(<ActivityCard data={{
      ...BASE,
      progress: {
        baselineScore: 4,
        baselineLevelWord: 'High activity',
        baselineDate: '2026-06-12',
        currentScore: 1,
        visits: 3,
      },
    }} />);
    expect(screen.getByText(/Down from 4\/5 at your first visit \(Jun 12\)/)).toBeInTheDocument();
  });

  it('renders no chip when progress is absent (gate off / not improved / not knockdown)', () => {
    render(<ActivityCard data={{ ...BASE, progress: null }} />);
    expect(screen.queryByText(/Down from/)).toBeNull();
  });
});

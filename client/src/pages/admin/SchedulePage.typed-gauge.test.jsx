// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/adminApi', () => ({ adminFetch: vi.fn(() => Promise.resolve({})) }));

import { TypedFindingsSection, restoredActivityScoreState } from './SchedulePage.jsx';

afterEach(() => cleanup());

// Owner ruling 2026-09-26: the redundant activity gauge is hidden whenever
// the indicator can be derived from a typed findings field (e.g. cockroach's
// "Activity level") — one activity question per typed flow instead of two.
// Only a tech-set-only indicator (no derive mapping, e.g. rodent trapping's
// gauge) keeps its picker.
const DERIVED_SCHEMA = {
  type: 'cockroach',
  label: 'Cockroach Treatment',
  fields: [
    { key: 'species', label: 'Species', type: 'select', options: ['German', 'American'] },
    { key: 'activity_level', label: 'Activity level', type: 'select', required: true, options: ['None observed', 'Low', 'Moderate', 'Heavy', 'Severe'] },
  ],
  activity: {
    indicatorKey: 'roach_activity',
    label: 'Roach Activity',
    deriveField: 'activity_level',
    deriveScores: { 'None observed': 0, Low: 1, Moderate: 3, Heavy: 4, Severe: 5 },
    techScoreLabels: {},
  },
};

const TECH_SET_SCHEMA = {
  type: 'rodent_trapping',
  label: 'Rodent Trapping',
  fields: [
    { key: 'species', label: 'Species', type: 'select', options: ['Roof rat', 'Norway rat'] },
  ],
  activity: {
    indicatorKey: 'rodent_activity',
    label: 'Rodent Activity',
    deriveField: null,
    deriveScores: null,
    techScoreLabels: {},
  },
};

function renderSection(schema, values, extra = {}) {
  return render(
    <TypedFindingsSection
      variant="mobile"
      schema={schema}
      values={values}
      onFieldChange={() => {}}
      activityScore={null}
      activityScoreTouched={false}
      onActivityTap={() => {}}
      recommendations=""
      onRecommendationsChange={() => {}}
      {...extra}
    />,
  );
}

describe('TypedFindingsSection — gauge/findings merge (owner ruling 2026-09-26)', () => {
  it('hides the separate gauge for a derive-mapped indicator — the findings field is the only activity input', () => {
    const { container } = renderSection(DERIVED_SCHEMA, { species: 'German', activity_level: 'Low' });
    expect(container.textContent).not.toContain('Roach Activity');
    expect(container.textContent).not.toContain('Prefills from findings');
    // The findings field itself still renders — it's the sole activity input now.
    expect(container.textContent).toContain('Activity level');
  });

  it('keeps the gauge for a tech-set-only indicator (no derive mapping)', () => {
    const { container } = renderSection(TECH_SET_SCHEMA, { species: 'Roof rat' });
    expect(container.textContent).toContain('Rodent Activity');
    expect(container.textContent).toContain('Prefills from findings until you choose');
  });
});

// Owner ruling 2026-09-27: the "Next steps (up to 4)" chip picker was
// retired for every typed schema — Recommendations is the single
// tech-advice field now.
describe('TypedFindingsSection — next-step chip picker retired (owner ruling 2026-09-27)', () => {
  it('renders no "Next steps" picker for a derive-mapped schema', () => {
    const { container } = renderSection(DERIVED_SCHEMA, { species: 'German', activity_level: 'Low' });
    expect(container.textContent).not.toContain('Next steps');
  });

  it('renders no "Next steps" picker for a tech-set-only schema', () => {
    const { container } = renderSection(TECH_SET_SCHEMA, { species: 'Roof rat' });
    expect(container.textContent).not.toContain('Next steps');
  });
});

describe('restoredActivityScoreState — draft restore after the gauge was hidden', () => {
  const derive = {
    label: 'Roach Activity',
    deriveField: 'activity_level',
    deriveScores: { 'None observed': 0, Low: 1, Moderate: 3, Heavy: 4, Severe: 5 },
  };

  it('drops a pin saved by an older draft and derives from the restored findings', () => {
    // An older draft pinned 5 while the findings now say Low: the tech can no
    // longer see or change that pin, so it must not survive the restore.
    expect(restoredActivityScoreState(derive, { activity_level: 'Low' }, 5, true))
      .toEqual({ score: 1, touched: false });
  });

  it('derives "None observed" to 0, not a falsy null', () => {
    expect(restoredActivityScoreState(derive, { activity_level: 'None observed' }, 3, true))
      .toEqual({ score: 0, touched: false });
  });

  it('leaves the score empty when the findings field is empty', () => {
    expect(restoredActivityScoreState(derive, {}, 4, true)).toEqual({ score: null, touched: false });
  });

  it('keeps a tech-set-only indicator pin exactly as saved', () => {
    const techSet = { label: 'Rodent Activity' };
    expect(restoredActivityScoreState(techSet, {}, 2, true)).toEqual({ score: 2, touched: true });
    expect(restoredActivityScoreState(techSet, {}, 'x', false)).toEqual({ score: null, touched: false });
  });
});

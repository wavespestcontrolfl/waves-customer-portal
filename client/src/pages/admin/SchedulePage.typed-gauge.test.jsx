// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/adminApi', () => ({ adminFetch: vi.fn(() => Promise.resolve({})) }));

import { TypedFindingsSection } from './SchedulePage.jsx';

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
  nextStepChips: ['Follow-up recommended'],
  nextStepRequired: true,
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
  nextStepChips: ['Continue trapping'],
  nextStepRequired: true,
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
      nextStepChips={[]}
      onToggleChip={() => {}}
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

// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/adminApi', () => ({ adminFetch: vi.fn(() => Promise.resolve({})) }));

import { TypedFindingsSection } from './SchedulePage.jsx';

afterEach(() => cleanup());

// A detail field that is REQUIRED for the current values (requiredUnless)
// must render on the primary form, never inside the "More detail (optional)"
// drawer — the tech would otherwise fail validation on a field they could
// not see (codex P1 on #3536).
const SCHEMA = {
  type: 'flea',
  label: 'Flea Service',
  fields: [
    { key: 'evidence_level', label: 'Evidence / activity level', type: 'select', required: true, options: ['None observed', 'Light', 'Heavy'] },
    { key: 'activity_areas', label: 'Activity areas', type: 'chips', detail: true, requiredUnless: { field: 'evidence_level', value: 'None observed' }, options: ['Bedroom', 'Living room'] },
    { key: 'contributing_conditions', label: 'Contributing conditions', type: 'chips', detail: true, options: ['Pets', 'Carpet'] },
  ],
  nextStepChips: ['Follow-up recommended'],
  nextStepRequired: true,
  activity: null,
};

function renderSection(values) {
  return render(
    <TypedFindingsSection
      variant="mobile"
      schema={SCHEMA}
      values={values}
      onFieldChange={() => {}}
      activityScore={null}
      activityScoreTouched={false}
      onActivityTap={() => {}}
      nextStepChips={[]}
      onToggleChip={() => {}}
      recommendations=""
      onRecommendationsChange={() => {}}
    />,
  );
}

function isInsideDrawer(container, labelText) {
  const label = [...container.querySelectorAll('div')].find((d) => d.textContent.trim().startsWith(labelText) && d.childElementCount <= 1);
  return !!label && !!label.closest('details');
}

describe('TypedFindingsSection detail promotion', () => {
  it('keeps a conditionally required field out of the optional drawer once its driver makes it required', () => {
    const { container } = renderSection({ evidence_level: 'Heavy' });
    expect(isInsideDrawer(container, 'Activity areas')).toBe(false);
    // An ordinary optional detail field still lives in the drawer.
    expect(isInsideDrawer(container, 'Contributing conditions')).toBe(true);
  });

  it('leaves the field in the drawer while it is genuinely optional', () => {
    const { container } = renderSection({ evidence_level: 'None observed' });
    expect(isInsideDrawer(container, 'Activity areas')).toBe(true);
  });
});

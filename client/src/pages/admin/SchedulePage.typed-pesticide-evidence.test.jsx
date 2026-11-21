// @vitest-environment jsdom
import React, { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/adminApi', () => ({ adminFetch: vi.fn(() => Promise.resolve({})) }));

import {
  TypedFindingsSection,
  treeShrubTypedPesticideScopeClient,
} from './SchedulePage.jsx';

afterEach(() => cleanup());

const SCHEMA = {
  type: 'tree_shrub',
  label: 'Tree & Shrub Service',
  fields: [
    { key: 'pollinator_status', label: 'Flowering / pollinator status', type: 'select', pesticideOnly: true, pesticideComplianceWhen: 'insect', options: ['No blooms or no bees'] },
    { key: 'irac_frac_logged', label: 'IRAC / FRAC rotation checked & logged', type: 'select', pesticideOnly: true, pesticideComplianceWhen: 'rotation', options: ['Yes', 'No'] },
    { key: 'insect_target', label: 'Current live insect target', type: 'select', pesticideOnly: true, pesticideComplianceWhen: 'insect_live', options: ['Whitefly', 'Mites'] },
    { key: 'insect_life_stage', label: 'Current live insect stage', type: 'select', pesticideOnly: true, pesticideComplianceWhen: 'insect_live', options: ['Adults', 'Crawlers / nymphs'] },
    { key: 'insect_preventive_reason', label: 'Documented label-supported preventive reason', type: 'text', pesticideOnly: true, pesticideComplianceWhen: 'insect_preventive' },
  ],
  activity: null,
};

function Harness({ scope, companion = false }) {
  const [values, setValues] = useState({});
  const [path, setPath] = useState(null);
  return (
    <TypedFindingsSection
      variant="desktop"
      schema={SCHEMA}
      values={values}
      onFieldChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
      activityScore={null}
      activityScoreTouched={false}
      onActivityTap={() => {}}
      recommendations=""
      onRecommendationsChange={companion ? null : () => {}}
      pesticideProductPresent={scope.pesticideProductPresent}
      pesticideComplianceScope={scope}
      insectEvidencePath={path}
      onInsectEvidencePathChange={setPath}
    />
  );
}

describe('typed Tree & Shrub pesticide evidence fields', () => {
  it.each([false, true])('fungicide-only shows rotation but no insect questions: companion=%s', (companion) => {
    const scope = treeShrubTypedPesticideScopeClient([{ name: 'Headway G Fungicide', category: 'Fungicide' }]);
    render(<Harness scope={scope} companion={companion} />);
    expect(screen.getByText(/IRAC \/ FRAC rotation checked/)).toBeInTheDocument();
    expect(screen.queryByText(/Flowering \/ pollinator status/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Insect treatment evidence path')).not.toBeInTheDocument();
    expect(screen.queryByText('Current live insect target')).not.toBeInTheDocument();
    expect(screen.queryByText('Documented label-supported preventive reason')).not.toBeInTheDocument();
  });

  it('a known insect product makes the technician choose current evidence or documented preventive use', () => {
    const scope = treeShrubTypedPesticideScopeClient([{ name: 'Mainspring GNL Insecticide', category: '' }]);
    render(<Harness scope={scope} />);
    const choice = screen.getByLabelText('Insect treatment evidence path');
    expect(screen.getByText(/Flowering \/ pollinator status/)).toBeInTheDocument();
    expect(screen.queryByText('Current live insect target')).not.toBeInTheDocument();

    fireEvent.change(choice, { target: { value: 'live' } });
    expect(screen.getByText('Current live insect target')).toBeInTheDocument();
    expect(screen.getByText('Current live insect stage')).toBeInTheDocument();
    expect(screen.queryByText('Documented label-supported preventive reason')).not.toBeInTheDocument();

    fireEvent.change(choice, { target: { value: 'preventive' } });
    expect(screen.getByText('Documented label-supported preventive reason')).toBeInTheDocument();
    expect(screen.queryByText('Current live insect target')).not.toBeInTheDocument();
  });

  it('a no-category unknown keeps rotation available without presuming insect treatment', () => {
    const scope = treeShrubTypedPesticideScopeClient([{ name: 'Synthetic Product 42', category: '' }]);
    expect(scope).toMatchObject({ pesticideProductPresent: true, insectProductPresent: false, insectProductUnknown: true });
    render(<Harness scope={scope} />);
    expect(screen.getByText(/IRAC \/ FRAC rotation checked/)).toBeInTheDocument();
    expect(screen.getByLabelText('Insect treatment evidence path')).toHaveValue('');
    expect(screen.getByRole('option', { name: 'No insect treatment recorded' })).toBeInTheDocument();
    expect(screen.queryByText(/Flowering \/ pollinator status/)).not.toBeInTheDocument();
    expect(screen.queryByText('Current live insect target')).not.toBeInTheDocument();
  });
});

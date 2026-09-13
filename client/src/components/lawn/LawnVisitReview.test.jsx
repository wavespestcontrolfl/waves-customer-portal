// @vitest-environment jsdom
import React, { useState } from 'react';
import { createRequire } from 'node:module';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import LawnVisitReview, { createVisitReview, visitReviewPayload } from './LawnVisitReview';

const require = createRequire(import.meta.url);
const { CONDITION_LABEL_VALUES } = require('../../../../server/services/lawn-diagnostic-report');

const visitAssessment = {
  status: 'complete',
  observations: 'Model observation',
  photoQuality: [
    { photo: 1, quality: 'adequate', issue: '' },
    { photo: 2, quality: 'limited', issue: 'The patch edge is distant.' },
  ],
  findings: [
    {
      finding_id: 'F1',
      name: 'Irregular browning along the driveway',
      label: 'thinning turf',
      confidence: 'moderate',
      observed_evidence: ['Brown blades are concentrated at the advancing edge.'],
      negative_evidence: ['No live insects are visible.'],
      inferred_context: ['The edge is beside pavement.'],
      confirmation_step: 'Inspect the patch edge and perform a float test.',
      photo_refs: [1, 2],
    },
    {
      finding_id: 'F2',
      name: 'Scattered broadleaf growth',
      label: 'weed pressure',
      confidence: 'high',
      observed_evidence: ['Broadleaf plants interrupt the turf canopy.'],
      photo_refs: [2],
    },
  ],
  reviewedFindings: [
    {
      finding_id: 'F1',
      name: 'grub activity',
      label: 'grub activity',
      keep: true,
      renamed: true,
      tech_note: 'Lift test found loose turf.',
    },
    {
      finding_id: 'F2',
      name: 'Scattered broadleaf growth',
      label: 'weed pressure',
      keep: false,
      renamed: false,
      tech_note: null,
    },
  ],
  addedDetails: [
    { finding_id: 'T7', name: 'Nutsedge confirmed beside the walk.', zone: 'back' },
    { finding_id: 'T8', name: 'Dog wear is visible.', zone: 'unknown' },
  ],
};

afterEach(cleanup);

describe('visit review state helpers', () => {
  it('hydrates saved decisions without treating stored labels as new rename intent', () => {
    const draft = createVisitReview(visitAssessment, 'Saved technician observation');
    expect(draft).toEqual({
      reviewedFindings: [
        { finding_id: 'F1', keep: true, renamed: true, name: 'grub activity', tech_note: 'Lift test found loose turf.' },
        { finding_id: 'F2', keep: false, renamed: false, name: null, tech_note: '' },
      ],
      addedDetails: [
        { finding_id: 'T7', text: 'Nutsedge confirmed beside the walk.', zone: 'back' },
        { finding_id: 'T8', text: 'Dog wear is visible.', zone: '' },
      ],
      observationText: 'Saved technician observation',
      observationDirty: false,
    });
    expect(visitReviewPayload(draft)).toEqual({
      reviewedFindings: [
        { finding_id: 'F1', keep: true, name: 'grub activity', tech_note: 'Lift test found loose turf.' },
        { finding_id: 'F2', keep: false, name: null, tech_note: null },
      ],
      addedDetails: [
        { text: 'Nutsedge confirmed beside the walk.', zone: 'back' },
        { text: 'Dog wear is visible.', zone: null },
      ],
    });
  });

  it('keeps legacy requests unchanged and owns observations only after an explicit edit', () => {
    expect(createVisitReview(null, 'Legacy observation')).toBeNull();
    expect(visitReviewPayload(null)).toEqual({});
    const draft = createVisitReview(visitAssessment, 'Same observation');
    expect(visitReviewPayload(draft)).not.toHaveProperty('observationEdit');
    expect(createVisitReview(visitAssessment, null).observationText).toBe('');
    expect(createVisitReview(visitAssessment).observationText).toBe('Model observation');
    expect(visitReviewPayload({ ...draft, observationText: '', observationDirty: true }))
      .toMatchObject({ observationEdit: '' });
  });

  it('omits blank detail rows and bounds technician text and detail count', () => {
    const draft = createVisitReview({ ...visitAssessment, reviewedFindings: null, addedDetails: null });
    const payload = visitReviewPayload({
      ...draft,
      reviewedFindings: [{ ...draft.reviewedFindings[0], tech_note: ` ${'n'.repeat(600)} ` }],
      addedDetails: [
        { text: '   ', zone: 'front' },
        ...Array.from({ length: 12 }, (_, index) => ({ text: ` ${'x'.repeat(510)}${index} `, zone: index === 0 ? 'side' : 'invalid' })),
      ],
    });
    expect(payload.reviewedFindings[0].tech_note).toHaveLength(500);
    expect(payload.addedDetails).toHaveLength(9);
    expect(payload.addedDetails[0]).toEqual({ text: 'x'.repeat(500), zone: 'side' });
    expect(payload.addedDetails[1].zone).toBeNull();
  });
});

describe('LawnVisitReview', () => {
  it('shows original evidence and saved technician decisions with the server rename allowlist', () => {
    const draft = createVisitReview(visitAssessment, 'Saved technician observation');
    render(<LawnVisitReview visitAssessment={visitAssessment} value={draft} onChange={() => {}} />);

    expect(screen.getByText('Brown blades are concentrated at the advancing edge.')).toBeInTheDocument();
    expect(screen.getByText('No live insects are visible.')).toBeInTheDocument();
    expect(screen.getByText('The edge is beside pavement.')).toBeInTheDocument();
    expect(screen.getByText(/Inspect the patch edge and perform a float test/)).toBeInTheDocument();
    expect(screen.getByText('Photo 1, Photo 2')).toBeInTheDocument();
    expect(screen.getByText('Moderate confidence')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Keep Irregular browning along the driveway' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Keep Scattered broadleaf growth' })).not.toBeChecked();

    const rename = screen.getByLabelText('Finding label for Irregular browning along the driveway');
    expect(rename).toHaveValue('grub activity');
    expect(Array.from(rename.options).slice(1).map((option) => option.value)).toEqual(CONDITION_LABEL_VALUES);
    expect(screen.getByLabelText('Technician note for Irregular browning along the driveway'))
      .toHaveValue('Lift test found loose turf.');
    expect(screen.getByLabelText('Zone for technician detail 1')).toHaveValue('back');
    expect(screen.getByLabelText('Zone for technician detail 2')).toHaveValue('');
  });

  it('emits keep, rename, note, observation, add, edit, and remove changes', () => {
    let latest;
    function Harness() {
      const [draft, setDraft] = useState(() => createVisitReview({ ...visitAssessment, addedDetails: [] }, 'Starting observation'));
      latest = draft;
      return <LawnVisitReview visitAssessment={visitAssessment} value={draft} onChange={setDraft} />;
    }
    render(<Harness />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep Irregular browning along the driveway' }));
    fireEvent.change(screen.getByLabelText('Finding label for Irregular browning along the driveway'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Technician note for Irregular browning along the driveway'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Observation'), { target: { value: 'Technician wording' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add detail' }));
    fireEvent.change(screen.getByLabelText('Technician detail 1'), { target: { value: 'Chinch bugs ruled out by float test.' } });
    fireEvent.change(screen.getByLabelText('Zone for technician detail 1'), { target: { value: 'front' } });

    expect(visitReviewPayload(latest)).toEqual({
      reviewedFindings: [
        { finding_id: 'F1', keep: false, name: null, tech_note: null },
        { finding_id: 'F2', keep: false, name: null, tech_note: null },
      ],
      addedDetails: [{ text: 'Chinch bugs ruled out by float test.', zone: 'front' }],
      observationEdit: 'Technician wording',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove technician detail 1' }));
    expect(visitReviewPayload(latest).addedDetails).toEqual([]);
  });

  it('renders null and unavailable runs safely with informative photo state', () => {
    const empty = render(<LawnVisitReview visitAssessment={null} value={null} onChange={() => {}} />);
    expect(empty.container).toBeEmptyDOMElement();
    empty.unmount();

    render(<LawnVisitReview
      visitAssessment={{ status: 'unavailable', unavailableReason: 'all_providers_failed', photoQuality: [] }}
      value={createVisitReview({ status: 'unavailable' })}
      onChange={() => {}}
    />);
    expect(screen.getByText('Visit evidence review unavailable')).toBeInTheDocument();
    expect(screen.getByText('Reason: All providers failed')).toBeInTheDocument();
    expect(screen.getByText('Photo quality details are unavailable for this analysis.')).toBeInTheDocument();
    expect(screen.getByLabelText('Observation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add detail' })).toBeEnabled();
  });
});

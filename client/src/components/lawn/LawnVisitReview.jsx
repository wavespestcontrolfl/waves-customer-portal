import React, { useId } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  Field,
  Select,
  Textarea,
  UiSurface,
} from '../ui';

const TECH_TEXT_MAX = 500;
const DETAIL_MAX = 10;
const PHOTO_ZONES = ['front', 'back', 'side'];

// Keep this list in parity with CONDITION_LABEL_VALUES in
// server/services/lawn-diagnostic-report.js. The larger shared lawn finding
// catalog supplies structured completion observations and is not accepted by
// the visit-review endpoint as a rename allowlist.
const CONDITION_LABEL_VALUES = Object.freeze([
  'chinch bug activity',
  'caterpillar activity',
  'grub activity',
  'large patch (fungal) activity',
  'gray leaf spot',
  'dollar spot',
  'fungal activity',
  'weed pressure',
  'overwatering signal',
  'drought stress',
  'thinning turf',
  'color and nutrient stress',
  'no major visible stress',
  'color stress',
  'general lawn stress',
  'a lawn condition we are monitoring',
]);

const text = (value) => typeof value === 'string' ? value : '';
const list = (value) => Array.isArray(value) ? value : [];
const technicianText = (value) => text(value).trim().slice(0, TECH_TEXT_MAX);
const displayText = (value) => String(value || '')
  .replace(/_/g, ' ')
  .replace(/^./, (letter) => letter.toUpperCase());

function savedFindingById(visitAssessment) {
  return new Map(list(visitAssessment?.reviewedFindings)
    .filter((finding) => typeof finding?.finding_id === 'string')
    .map((finding) => [finding.finding_id, finding]));
}

/** Build the caller-owned editable state from a run response. */
export function createVisitReview(visitAssessment, assessmentObservations) {
  if (!visitAssessment) return null;
  const saved = savedFindingById(visitAssessment);
  return {
    reviewedFindings: list(visitAssessment.findings).map((finding) => {
      const prior = saved.get(finding?.finding_id);
      const renamed = prior?.renamed === true;
      return {
        finding_id: finding?.finding_id ?? null,
        keep: prior?.keep !== false,
        renamed,
        name: renamed ? text(prior?.label || prior?.name) : null,
        tech_note: text(prior?.tech_note),
      };
    }),
    addedDetails: list(visitAssessment.addedDetails).slice(0, DETAIL_MAX).map((detail) => ({
      finding_id: typeof detail?.finding_id === 'string' ? detail.finding_id : null,
      text: text(detail?.name || detail?.text),
      zone: PHOTO_ZONES.includes(detail?.zone) ? detail.zone : '',
    })),
    observationText: text(assessmentObservations === undefined
      ? visitAssessment.observations
      : assessmentObservations),
    observationDirty: false,
  };
}

/** Convert editable state to the exact partial-review API contract. */
export function visitReviewPayload(draft) {
  if (!draft) return {};
  const reviewedFindings = list(draft.reviewedFindings)
    .filter((finding) => typeof finding?.finding_id === 'string' && finding.finding_id)
    .map((finding) => {
      const rename = finding.renamed === true && CONDITION_LABEL_VALUES.includes(finding.name);
      const note = technicianText(finding.tech_note);
      return {
        finding_id: finding.finding_id,
        keep: finding.keep !== false,
        name: rename ? finding.name : null,
        tech_note: note || null,
      };
    });
  const addedDetails = list(draft.addedDetails).slice(0, DETAIL_MAX)
    .map((detail) => ({
      text: technicianText(detail?.text),
      zone: PHOTO_ZONES.includes(detail?.zone) ? detail.zone : null,
    }))
    .filter((detail) => detail.text);
  return {
    reviewedFindings,
    addedDetails,
    ...(draft.observationDirty === true ? { observationEdit: text(draft.observationText) } : {}),
  };
}

function EvidenceList({ label, values }) {
  const entries = list(values).filter((value) => typeof value === 'string' && value.trim());
  if (!entries.length) return null;
  return <div>
    <div className="font-medium text-zinc-700">{label}</div>
    <ul className="m-0 mt-1 space-y-1 pl-5 text-zinc-600">
      {entries.map((entry, index) => <li key={`${entry}-${index}`}>{entry}</li>)}
    </ul>
  </div>;
}

function PhotoQuality({ visitAssessment }) {
  const rows = list(visitAssessment?.photoQuality);
  if (!rows.length) {
    return <p className="m-0 text-14 leading-relaxed text-zinc-600">
      Photo quality details are unavailable for this analysis.
    </p>;
  }
  return <div className="grid gap-2 sm:grid-cols-2">
    {rows.map((row, index) => (
      <div key={`${row?.photo ?? 'photo'}-${index}`} className="rounded-sm border-hairline border-zinc-200 bg-zinc-50 px-3 py-2 text-14 leading-relaxed text-zinc-700">
        <span className="font-medium text-zinc-900">Photo {row?.photo ?? index + 1}</span>
        {' · '}{displayText(row?.quality || 'not rated')}
        {row?.issue ? <div className="text-zinc-600">{row.issue}</div> : null}
      </div>
    ))}
  </div>;
}

export default function LawnVisitReview({ visitAssessment, value, onChange, disabled = false }) {
  const surfaceId = useId();
  if (!visitAssessment) return null;
  const draft = value || createVisitReview(visitAssessment);
  const originals = list(visitAssessment.findings);
  const reviewById = new Map(list(draft?.reviewedFindings).map((finding) => [finding.finding_id, finding]));
  const update = (next) => onChange?.(next);
  const updateFinding = (findingId, changes) => update({
    ...draft,
    reviewedFindings: list(draft.reviewedFindings).map((finding) => (
      finding.finding_id === findingId ? { ...finding, ...changes } : finding
    )),
  });
  const updateDetail = (index, changes) => update({
    ...draft,
    addedDetails: list(draft.addedDetails).map((detail, detailIndex) => (
      detailIndex === index ? { ...detail, ...changes } : detail
    )),
  });

  return <UiSurface density="comfortable" className="mt-3 text-zinc-900">
    <Card>
      <CardBody className="space-y-5">
        {visitAssessment.status === 'unavailable' ? <div>
          <h3 className="m-0 text-14 font-medium text-zinc-900">Visit evidence review unavailable</h3>
          <p className="mb-0 mt-1 text-14 leading-relaxed text-zinc-600">
            The lawn analysis could not produce reviewable findings. Use the photos and field observations to complete the visit.
          </p>
          {visitAssessment.unavailableReason ? (
            <p className="mb-0 mt-1 text-14 leading-relaxed text-zinc-600">
              Reason: {displayText(visitAssessment.unavailableReason)}
            </p>
          ) : null}
        </div> : <div>
          <h3 className="m-0 text-14 font-medium text-zinc-900">Visit evidence review</h3>
          <p className="mb-0 mt-1 text-14 leading-relaxed text-zinc-600">
            Confirm what the photos support, correct the finding label when needed, and add details verified in the field.
          </p>
        </div>}

        <section aria-labelledby={`${surfaceId}-photo-quality-heading`} className="space-y-2">
          <h4 id={`${surfaceId}-photo-quality-heading`} className="m-0 text-14 font-medium text-zinc-900">Photo quality</h4>
          <PhotoQuality visitAssessment={visitAssessment} />
        </section>

        <Field label="Observation" help="Edit this only when the saved visit observation needs technician wording.">
          <Textarea
            rows={3}
            value={draft.observationText}
            disabled={disabled}
            onChange={(event) => update({ ...draft, observationText: event.target.value, observationDirty: true })}
          />
        </Field>

        <section aria-labelledby={`${surfaceId}-findings-heading`} className="space-y-3">
          <div>
            <h4 id={`${surfaceId}-findings-heading`} className="m-0 text-14 font-medium text-zinc-900">Photo findings</h4>
            {!originals.length ? <p className="mb-0 mt-1 text-14 leading-relaxed text-zinc-600">No photo finding was available to review.</p> : null}
          </div>
          {originals.map((finding) => {
            const findingId = finding.finding_id;
            const decision = reviewById.get(findingId);
            const title = finding.name;
            const photoRefs = finding.photo_refs;
            return <div key={findingId} className="space-y-4 rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-14 font-medium leading-relaxed text-zinc-900">{title}</div>
                  {photoRefs.length ? <div className="mt-1 text-14 text-zinc-600">
                    {photoRefs.map((ref) => `Photo ${ref}`).join(', ')}
                  </div> : <div className="mt-1 text-14 text-zinc-600">No photo reference supplied</div>}
                </div>
                <Badge>{displayText(finding.confidence)} confidence</Badge>
              </div>

              <div className="space-y-3 text-14 leading-relaxed">
                <EvidenceList label="Observed evidence" values={finding.observed_evidence} />
                <EvidenceList label="What was not seen" values={finding.negative_evidence} />
                <EvidenceList label="Context considered" values={finding.inferred_context} />
                {finding.can_determine === false && finding.cannot_determine_reason ? (
                  <div><span className="font-medium text-zinc-700">Limitation:</span>{' '}<span className="text-zinc-600">{finding.cannot_determine_reason}</span></div>
                ) : null}
                {finding.confirmation_step ? (
                  <div><span className="font-medium text-zinc-700">Confirmation step:</span>{' '}<span className="text-zinc-600">{finding.confirmation_step}</span></div>
                ) : null}
              </div>

              <Checkbox
                id={`${surfaceId}-finding-${findingId}-keep`}
                label={`Keep ${title}`}
                checked={decision.keep !== false}
                disabled={disabled}
                onChange={(event) => updateFinding(findingId, { keep: event.target.checked })}
              />

              <Field label={`Finding label for ${title}`}>
                <Select
                  value={decision.renamed ? decision.name || '' : ''}
                  disabled={disabled}
                  onChange={(event) => updateFinding(findingId, {
                    renamed: Boolean(event.target.value),
                    name: event.target.value || null,
                  })}
                >
                  <option value="">Original — {finding.label || title}</option>
                  {CONDITION_LABEL_VALUES.map((label) => <option key={label} value={label}>{label}</option>)}
                </Select>
              </Field>

              <Field label={`Technician note for ${title}`} help={`${TECH_TEXT_MAX} characters maximum.`}>
                <Textarea
                  rows={2}
                  maxLength={TECH_TEXT_MAX}
                  value={decision.tech_note}
                  disabled={disabled}
                  onChange={(event) => updateFinding(findingId, { tech_note: event.target.value })}
                />
              </Field>
            </div>;
          })}
        </section>

        <section aria-labelledby={`${surfaceId}-technician-details-heading`} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 id={`${surfaceId}-technician-details-heading`} className="m-0 text-14 font-medium text-zinc-900">Technician details</h4>
              <p className="mb-0 mt-1 text-14 leading-relaxed text-zinc-600">Add only details verified during this visit.</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled || list(draft.addedDetails).length >= DETAIL_MAX}
              onClick={() => update({
                ...draft,
                addedDetails: [...list(draft.addedDetails), { finding_id: null, text: '', zone: '' }],
              })}
            >
              Add detail
            </Button>
          </div>

          {list(draft.addedDetails).map((detail, index) => (
            <div key={detail.finding_id || `detail-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3">
              <Field className="col-span-2" label={`Technician detail ${index + 1}`} help={`${TECH_TEXT_MAX} characters maximum.`}>
                <Textarea
                  rows={2}
                  maxLength={TECH_TEXT_MAX}
                  value={detail.text}
                  disabled={disabled}
                  onChange={(event) => updateDetail(index, { text: event.target.value })}
                />
              </Field>
              <Field label={`Zone for technician detail ${index + 1}`}>
                <Select
                  value={detail.zone || ''}
                  disabled={disabled}
                  onChange={(event) => updateDetail(index, { zone: event.target.value })}
                >
                  <option value="">Not specified</option>
                  {PHOTO_ZONES.map((zone) => <option key={zone} value={zone}>{displayText(zone)}</option>)}
                </Select>
              </Field>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                aria-label={`Remove technician detail ${index + 1}`}
                onClick={() => update({
                  ...draft,
                  addedDetails: list(draft.addedDetails).filter((_, detailIndex) => detailIndex !== index),
                })}
              >
                Remove
              </Button>
            </div>
          ))}
        </section>
      </CardBody>
    </Card>
  </UiSurface>;
}

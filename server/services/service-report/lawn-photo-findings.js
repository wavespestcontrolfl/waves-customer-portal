'use strict';

/**
 * "What the photos showed" (lawn report rebuild P23b, GATE_LAWN_REPORT_PHOTO_SET).
 *
 * The technician-reviewed findings of the visit's confirmed assessment run, each
 * with the thumbnail(s) it natively links to. Built ONLY from
 * lawn_assessment_runs.reviewed_findings: a finding the technician kept, whose
 * stored `label` is on the customer allowlist (CONDITION_LABEL_VALUES). Stored
 * free text (observed_evidence, cannot_determine_reason, confirmation_step,
 * customer_wording, name) is never read here. The only sentence is the fixed
 * "photo can confirm" line below, chosen by code.
 *
 * Pure: no I/O and no gate read. report-data.js reads the run and decides
 * whether the visit is eligible; resolveCanonicalLawnRender stamps the PDF key
 * from the same selection (photoFindingsSignatureState), so the key and the
 * block can never disagree about which findings count.
 *
 * Which labels may print (PHOTO_FINDING_LABELS, an explicit allowlist):
 * SYMPTOM labels only. A label that names a cause (chinch bug, caterpillar,
 * grub, large patch, gray leaf spot, dollar spot, fungal activity) is left out,
 * because the damage card on the same page says the cause is not confirmed yet;
 * so are the water labels ('drought stress', 'overwatering signal', owned by the
 * watering banner and the Water This Week card, which the report reconciles
 * against measured rain) and the clean label ('no major visible stress'). A new
 * label added to CONDITION_LABELS prints nothing here until it is added to the
 * allowlist on purpose.
 *
 * The block never contradicts a card on the same page: each allowlisted label
 * maps to the report's own category card for that topic (CARD_FOR_LABEL), and a
 * finding prints only while that card reads 'watch' or 'needs_attention'
 * (filterByCardStatus). A healthy, strong, still-tracking or missing card leaves
 * the finding out.
 */
const crypto = require('crypto');
const { CONDITION_LABEL_VALUES } = require('../lawn-diagnostic-report');
const { keptRunRows } = require('./tip-library');
const shotList = require('../lawn-photo-shots');

// The only labels that may print: symptoms, never a named cause. Pinned by test.
const PHOTO_FINDING_LABELS = Object.freeze([
  'weed pressure',
  'thinning turf',
  'color and nutrient stress',
  'color stress',
  'general lawn stress',
  'a lawn condition we are monitoring',
]);
const LABEL_ALLOWLIST = new Set(PHOTO_FINDING_LABELS.filter((label) => CONDITION_LABEL_VALUES.includes(label)));
// The report's own category card (reportV2.diagnosis key) each label is about.
// The two generic labels have no card of their own; the Stress / Damage Signals
// card is the report's statement about general stress.
const CARD_FOR_LABEL = Object.freeze({
  'weed pressure': 'weed_pressure',
  'thinning turf': 'coverage',
  'color and nutrient stress': 'color_vigor',
  'color stress': 'color_vigor',
  'general lawn stress': 'damage_disease_signals',
  'a lawn condition we are monitoring': 'damage_disease_signals',
});
// A finding prints only while its card shows a concern.
const CARD_STATUSES_THAT_PRINT = Object.freeze(['watch', 'needs_attention']);
const MAX_FINDINGS = 4;
const MAX_THUMBNAILS = 3;
const SEVERITY_ORDER = { severe: 0, moderate: 1, mild: 2 };

const SHOT_NAMES = Object.freeze(Object.fromEntries(shotList.SHOTS.map((shot) => [shot.key, String(shot.reportLabel).toLowerCase()])));
const CAUSE_SHOTS = Object.freeze(shotList.SHOTS.filter((shot) => shot.supportsCause === true).map((shot) => shot.key));

// The one sentence a finding may carry. `shotName` comes from the shared shot
// list (reportLabel, lowercased), never from stored text.
const photoCanConfirmSentence = (shotName) => `The photos from this visit cannot confirm this. A ${shotName} photo would let us confirm it.`;

const parseList = (value) => {
  let rows = value;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch { rows = null; }
  }
  return Array.isArray(rows) ? rows : [];
};

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The findings that may print, from a run and the assessment it belongs to.
 * [] unless: the assessment is technician-confirmed, the run is this
 * assessment's own (one run per assessment, so a superseded assessment's run is
 * never the one asked for), the run was reviewed, and a kept finding carries an
 * allowlisted label. Most severe first (stored order inside a severity), none
 * dropped yet: the cap of four is applied by filterByCardStatus's caller after the
 * card check, so a hidden finding never costs a shown one its place. `refs` are the 1-based photo numbers the finding cites.
 */
function selectPhotoFindings(run, assessment) {
  if (!run || !assessment || assessment.confirmed_by_tech !== true) return [];
  if (String(run.assessment_id) !== String(assessment.id)) return [];
  if (run.customer_id != null && assessment.customer_id != null && String(run.customer_id) !== String(assessment.customer_id)) return [];
  if (!run.reviewed_at) return [];
  const { reviewed } = keptRunRows(run);
  return reviewed
    .filter((row) => typeof row.label === 'string' && LABEL_ALLOWLIST.has(row.label))
    .map((row, index) => ({
      index,
      label: row.label,
      severity: Object.prototype.hasOwnProperty.call(SEVERITY_ORDER, row.severity) ? row.severity : null,
      canDetermine: row.can_determine === false ? false : true,
      refs: [...new Set(parseList(row.photo_refs).filter((ref) => Number.isInteger(ref) && ref >= 1 && ref <= 64))],
    }))
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) || a.index - b.index);
}

/**
 * The PDF cache-key component for the block: a short hash of exactly what the
 * block is built from (the selected findings and the run's photo order), or ''
 * when the visit would have no block, so a visit with no block keeps its key.
 */
function photoFindingsSignatureState(run, assessment) {
  const selected = selectPhotoFindings(run, assessment);
  if (!selected.length) return '';
  const photoIds = parseList(run.photo_ids).map(String);
  return crypto.createHash('sha1')
    .update(JSON.stringify({ selected: selected.map(({ label, severity, canDetermine, refs }) => [label, severity, canDetermine, refs]), photoIds }))
    .digest('hex')
    .slice(0, 10);
}

/**
 * The block, from the selected findings and the signed photo set.
 *  - run: the run row (photo_ids maps a finding's photo numbers to photo ids).
 *  - photoRows: the visit's customer-visible photo rows that were signed for the
 *    set, `{ id, zone, url }`.
 *  - photoSet: the finished set (`{ url, shot, label }`), whose entries the
 *    thumbnails reuse, so a thumbnail is always a photo of the set.
 * A photo the finding cites that is not in the set (hidden for quality, outside
 * the eight, unknown id) simply has no thumbnail: never another photo in its
 * place. [] when nothing is selected.
 */
function buildPhotoFindings({ run, assessment, photoRows, photoSet }) {
  const selected = selectPhotoFindings(run, assessment);
  if (!selected.length || !Array.isArray(photoSet) || !photoSet.length) return [];
  const photoIds = parseList(run.photo_ids).map(String);
  const rowById = new Map((photoRows || []).map((row) => [String(row.id), row]));
  const entryByUrl = new Map(photoSet.map((entry) => [entry.url, entry]));
  const shotsInSet = new Set(photoSet.map((entry) => entry.shot).filter(Boolean));
  return selected.map((finding) => {
    const cited = finding.refs.map((ref) => (photoIds[ref - 1] != null ? rowById.get(photoIds[ref - 1]) : null));
    const thumbnails = [];
    for (const row of cited) {
      const entry = row && row.url ? entryByUrl.get(row.url) : null;
      if (entry && !thumbnails.some((t) => t.url === entry.url)) thumbnails.push({ url: entry.url, label: entry.label });
    }
    const out = { label: capitalize(finding.label), photos: thumbnails.slice(0, MAX_THUMBNAILS) };
    if (finding.canDetermine === false) {
      // Name a cause-supporting shot only when the data can say it is missing:
      // every cited photo's shot is known, and the visit has no such photo at all.
      const citedKnown = finding.refs.length > 0 && cited.every((row) => row && row.url);
      const citedShots = new Set(cited.map((row) => shotList.normalizeShotZone(row && row.zone)).filter(Boolean));
      const missing = citedKnown ? CAUSE_SHOTS.find((key) => !citedShots.has(key) && !shotsInSet.has(key)) : null;
      if (missing) out.confirm = photoCanConfirmSentence(SHOT_NAMES[missing]);
    }
    return out;
  });
}

/**
 * Drops every finding whose category card does not show a concern. `diagnosis`
 * is the payload's own reportV2.diagnosis ([{ key, status }]); a missing card or
 * an unknown status leaves the finding out; the first four that remain print.
 * `findings` are block entries
 * ({ label } capitalized by buildPhotoFindings).
 */
function filterByCardStatus(findings, diagnosis) {
  const cards = Array.isArray(diagnosis) ? diagnosis : [];
  const kept = (Array.isArray(findings) ? findings : []).filter((finding) => {
    const key = typeof finding?.label === 'string' ? CARD_FOR_LABEL[finding.label.toLowerCase()] : null;
    const card = key ? cards.find((c) => c && c.key === key) : null;
    return !!card && CARD_STATUSES_THAT_PRINT.includes(card.status);
  });
  return kept.slice(0, MAX_FINDINGS);
}

module.exports = {
  selectPhotoFindings, photoFindingsSignatureState, buildPhotoFindings, photoCanConfirmSentence,
  filterByCardStatus, PHOTO_FINDING_LABELS, CARD_FOR_LABEL, CARD_STATUSES_THAT_PRINT, MAX_FINDINGS, MAX_THUMBNAILS,
};

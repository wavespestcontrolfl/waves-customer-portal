// client/src/lib/tree-shrub-pest-check.js
//
// The rules behind the Tree & Shrub Fast Complete "Live insects found?" block
// (GATE_TS_PEST_CHECK, owner 2026-10-05). Pure functions: the sheet reads the
// gate through the fast-context `pestCheck` key, and the server validates and
// freezes the answer (server/services/tree-shrub-pest-check.js).
//
// Agronomy: Merit 2F (imidacloprid, IRAC 4A) does not control ARMORED scale; it
// is for soft scale, whitefly and borers. Distance scale use is on hold; oil
// on live crawlers or a label-supported Zylam drench are the available card
// paths. TriStar is not for armored scale (owner 2026-10-09). The protocol cards say several products are for live finds
// only; a No answer beside one of them is a note, never a block.
import PEST_CHECK from '../../../shared/tree-shrub-pest-check.json';

export const INSECT_TYPES = PEST_CHECK.insectTypes;
export const LIFE_STAGES = PEST_CHECK.lifeStages;

// The typed Tree & Shrub form stores the same decision as Fast Complete in
// three legacy-compatible fields. The server accepts exactly one evidence
// path: current target + life stage, or a documented preventive reason.
export const TYPED_INSECT_EVIDENCE_KEYS = Object.freeze({
  live: ['insect_target', 'insect_life_stage'],
  preventive: ['insect_preventive_reason'],
});

const COMPLIANCE_WHEN_BY_KEY = Object.freeze({
  pollinator_status: 'insect',
  irac_frac_logged: 'rotation',
  insect_target: 'insect_live',
  insect_life_stage: 'insect_live',
  insect_preventive_reason: 'insect_preventive',
});

export function typedInsectEvidencePath(values = {}) {
  const present = (key) => String(values?.[key] ?? '').trim() !== '';
  const live = TYPED_INSECT_EVIDENCE_KEYS.live.some(present);
  const preventive = TYPED_INSECT_EVIDENCE_KEYS.preventive.some(present);
  if (live && preventive) return 'conflict';
  if (live) return 'live';
  if (preventive) return 'preventive';
  return null;
}

export function pesticideComplianceWhen(field = {}) {
  return field.pesticideComplianceWhen || COMPLIANCE_WHEN_BY_KEY[field.key] || 'pesticide';
}

const insectTreatmentFor = (scope, evidencePath) => scope?.insectProductPresent === true
  || (scope?.insectProductUnknown === true && ['live', 'preventive', 'conflict'].includes(evidencePath));

export function typedPesticideFieldApplies(field, values = {}, scope = {}, selectedPath = null) {
  if (!field?.pesticideOnly || scope.pesticideProductPresent !== true) return !field?.pesticideOnly;
  const evidencePath = selectedPath || typedInsectEvidencePath(values);
  const when = pesticideComplianceWhen(field);
  if (when === 'rotation') return scope.rotationProductPresent === true;
  if (when === 'insect') return insectTreatmentFor(scope, evidencePath);
  if (when === 'insect_live') return insectTreatmentFor(scope, evidencePath) && ['live', 'conflict'].includes(evidencePath);
  if (when === 'insect_preventive') return insectTreatmentFor(scope, evidencePath) && ['preventive', 'conflict'].includes(evidencePath);
  return true;
}

export function missingTypedPesticideCompliance(fields = [], values = {}, scope = {}, selectedPath = null) {
  if (scope.pesticideProductPresent !== true) return [];
  const evidencePath = typedInsectEvidencePath(values) || selectedPath;
  const missing = [];
  const evidenceFieldsServed = fields.some((field) =>
    ['insect_live', 'insect_preventive'].includes(pesticideComplianceWhen(field))
  );
  if (evidenceFieldsServed && scope.insectProductPresent === true && !evidencePath) missing.push('Insect treatment evidence path');
  if (evidenceFieldsServed && evidencePath === 'conflict') missing.push('Choose either current live evidence or documented preventive use (not both)');
  for (const field of fields) {
    if (!typedPesticideFieldApplies(field, values, scope, evidencePath)) continue;
    const value = String(values?.[field.key] ?? '').trim();
    if (!value) missing.push(field.label);
    else if (field.key === 'irac_frac_logged' && value !== 'Yes') missing.push(`${field.label} (must be confirmed Yes)`);
  }
  return [...new Set(missing)];
}

export const MERIT_BLOCK_MESSAGE = 'Merit does not control armored scale. Distance scale use is on hold; use oil on live crawlers or a label-supported Zylam drench.';
export const DISTANCE_SCALE_BLOCK_MESSAGE = 'Distance IGR scale use is on hold. Remove Distance or record a non-scale target supported by the label.';

// Products the protocol says to use on live finds only. Matched on the product
// name, the same text the tech sees on the row.
const LIVE_FINDS_ONLY = [
  { pattern: /\btristar\b/i, label: 'TriStar' },
  { pattern: /\bdistance\b/i, label: 'Distance IGR' },
  { pattern: /\bdipel\b/i, label: 'DiPel PRO DF' },
  { pattern: /\bconserve\b/i, label: 'Conserve' },
  { pattern: /\bmainspring\b/i, label: 'Mainspring' },
  // The plain product only: Acelepryn Xtra is the lawn preventive, another product.
  { pattern: /\bacelepryn\b(?!\s+xtra\b)/i, label: 'Acelepryn' },
  { pattern: /\bfloramite\b/i, label: 'Floramite' },
  // Oil moved to live-find use only (owner 2026-10-09). This stays a note,
  // never a block.
  { pattern: /\btritek\b/i, label: 'TriTek' },
];

export const TRISTAR_BLOCK_MESSAGE = 'TriStar does not control armored scale. Distance scale use is on hold; use oil on live crawlers or a label-supported Zylam drench.';
export const MERIT_TRISTAR_BLOCK_MESSAGE = 'Merit and TriStar do not control armored scale. Distance scale use is on hold; use oil on live crawlers or a label-supported Zylam drench.';

const MERIT_NAME = /\bmerit\b/i;
const IMIDACLOPRID = /imidacloprid/i;
const DISTANCE_NAME = /\bdistance\s+igr\b/i;

// Merit by name, or any imidacloprid product by its active ingredient.
export function isMeritProduct(row) {
  const product = row?.product || {};
  return MERIT_NAME.test(String(row?.name ?? product.name ?? ''))
    || IMIDACLOPRID.test(String(product.active_ingredient ?? ''));
}

export function isDistanceProduct(row) {
  const product = row?.product || {};
  return DISTANCE_NAME.test(String(row?.name ?? product.name ?? ''));
}

const TRISTAR_NAME = /\btristar\b/i;
const ACETAMIPRID = /acetamiprid/i;

// TriStar by name, or any acetamiprid product by its active ingredient.
export function isTristarProduct(row) {
  const product = row?.product || {};
  return TRISTAR_NAME.test(String(row?.name ?? product.name ?? ''))
    || ACETAMIPRID.test(String(product.active_ingredient ?? ''));
}

export function liveFindsOnlyLabel(row) {
  const name = String(row?.name ?? row?.product?.name ?? '');
  const hit = LIVE_FINDS_ONLY.find((entry) => entry.pattern.test(name));
  return hit ? hit.label : '';
}

// Armored scale picked: which active Merit and TriStar rows hold Complete, and
// which only get a note. Soft scale or whitefly beside armored scale: Merit can
// be right for those. TriStar (owner 2026-10-09) also covers mealybug and
// aphid, which the tech records as Other.
function armoredScaleRule(types, active) {
  const meritRows = active.filter(isMeritProduct);
  const tristarRows = active.filter(isTristarProduct);
  const softTarget = types.has('soft_scale') || types.has('whitefly');
  const meritBlocked = meritRows.length > 0 && !softTarget;
  const tristarBlocked = tristarRows.length > 0 && !softTarget && !types.has('other');
  const noteMessages = [];
  if (meritRows.length && !meritBlocked) noteMessages.push(MERIT_BLOCK_MESSAGE);
  if (tristarRows.length && !tristarBlocked) noteMessages.push(TRISTAR_BLOCK_MESSAGE);
  const blocked = [meritBlocked && 'Merit', tristarBlocked && 'TriStar'].filter(Boolean);
  const messages = { Merit: MERIT_BLOCK_MESSAGE, TriStar: TRISTAR_BLOCK_MESSAGE };
  return {
    blockMessage: blocked.length === 2 ? MERIT_TRISTAR_BLOCK_MESSAGE : (messages[blocked[0]] || ''),
    noteMessages,
    blockedRows: [...(meritBlocked ? meritRows : []), ...(tristarBlocked ? tristarRows : [])],
    blockedLabel: blocked.join(' and '),
  };
}

function distanceScaleRule(types, active) {
  if (!types.has('armored_scale') && !types.has('soft_scale')) return null;
  const blockedRows = active.filter(isDistanceProduct);
  if (!blockedRows.length) return null;
  return {
    blockMessage: DISTANCE_SCALE_BLOCK_MESSAGE,
    noteMessages: [],
    blockedRows,
    blockedLabel: 'Distance',
  };
}

function liveFindLabels(active) {
  const labels = [];
  const seen = new Set();
  for (const row of active) {
    const label = liveFindsOnlyLabel(row);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

function isInsectTreatment(row) {
  if (!row?.active) return false;
  const product = row.product || {};
  return product.tsFlags?.insectFamily === true
    || /insect|miticide|acaricide|\bigr\b/i.test(`${product.category || ''} ${product.product_type || ''}`)
    || !!liveFindsOnlyLabel(row)
    || isMeritProduct(row)
    || isTristarProduct(row);
}

const pickedLifeStage = (answer) => LIFE_STAGES.some((stage) => stage.key === answer?.lifeStage);

function evidenceBlock(answer, active) {
  const insect = active.filter(isInsectTreatment);
  if (!insect.length) return '';
  if (answer?.found === true) {
    if (!(answer.types || []).length) return 'Select the live target before recording an insect treatment.';
    if (!pickedLifeStage(answer)) return 'Select the live stage before recording an insect treatment.';
    return '';
  }
  if (answer?.found === false) {
    const liveOnly = liveFindLabels(insect);
    if (liveOnly.length) return `${liveOnly.join(', ')} ${liveOnly.length === 1 ? 'requires' : 'require'} a live target and stage. Remove the treatment or record what was found.`;
    if (!String(answer.preventiveReason || '').trim()) return 'Enter the label-supported preventive reason before recording an insect treatment.';
    return '';
  }
  return 'Record the live target and stage, or a label-supported preventive reason. A scout-only visit needs no insect treatment.';
}

// answer: { found: true | false | null, types: string[] }; rows: the sheet's
// product rows (only the active ones count).
export function evaluatePestCheck(answer, rows) {
  const out = { blockMessage: '', noteMessages: [], blockedRows: [], blockedLabel: '' };
  const active = (rows || []).filter((row) => row?.active);
  const missingEvidence = evidenceBlock(answer, active);
  if (missingEvidence) return { ...out, blockMessage: missingEvidence };
  if (answer?.found === true) {
    const types = new Set(answer.types || []);
    const distanceHold = distanceScaleRule(types, active);
    if (distanceHold) return distanceHold;
    return types.has('armored_scale') ? armoredScaleRule(types, active) : out;
  }
  return out;
}

// The completion body's answer, or null while unanswered. A No carries no types.
export function pestCheckPayload(answer) {
  if (answer?.found === true) {
    const picked = new Set(answer.types || []);
    const lifeStage = LIFE_STAGES.some((stage) => stage.key === answer.lifeStage) ? answer.lifeStage : null;
    return {
      liveInsectsFound: true,
      insectTypes: INSECT_TYPES.map((type) => type.key).filter((key) => picked.has(key)),
      ...(lifeStage ? { lifeStage } : {}),
    };
  }
  if (answer?.found === false) {
    const preventiveReason = String(answer.preventiveReason || '').trim().slice(0, 240);
    return { liveInsectsFound: false, insectTypes: [], ...(preventiveReason ? { preventiveReason } : {}) };
  }
  return null;
}

// Adds the answer to a built completion body as treeShrubReview.pestCheck,
// beside whatever the review already carries. No answer = body unchanged.
export function withPestCheck(body, payload) {
  if (!payload) return body;
  return { ...body, treeShrubReview: { ...(body.treeShrubReview || {}), pestCheck: payload } };
}

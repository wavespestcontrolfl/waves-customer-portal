/**
 * Lawn diagnostic report: the evidence behind each finding
 * (GATE_LAWN_DIAGNOSTIC_EVIDENCE).
 *
 * The stored contract keeps what the photo read saw, assumed and would check
 * next (observed_evidence, inferred_context, confirmation_step). All of it is
 * model or client free text, so none of it is ever published. What a prospect
 * reads instead is selected here from fixed strings, keyed ONLY by values the
 * public egress already allowlists: the finding's customer-facing condition
 * label (safeConditionLabel) and its clamped confidence. A label this table
 * does not know gets no evidence at all.
 *
 * Three lines per finding:
 *   why        what this condition looks like (the naming gate in
 *              lawn-diagnostic-prompt.js publishes a cause label only when its
 *              signature is visible, so this is the reason the label was used)
 *   certainty  how sure the read is, in words
 *   confirm    the on-site check that would settle it (left out when the
 *              finding is already high confidence, or needs no check)
 *
 * Pure: no I/O, no clock, no gate.
 */

const GENERIC_WHY = 'The photos show a stressed area, but not enough detail to point to one cause.';
const ON_SITE_LOOK = 'What would settle it: a closer look on site.';
const BLADE_AND_EDGE_LOOK = 'What would settle it: a close look at the blades and the patch edge on site.';

// kind: 'cause' names a pest, disease or water problem; 'symptom' is what the
// photos show without naming why; 'generic' is the low-confidence fallback;
// 'clear' is a lawn with nothing standing out.
const EVIDENCE_BY_LABEL = {
  'chinch bug activity': {
    kind: 'cause',
    why: 'Chinch bug damage shows as irregular yellow-to-brown patches in full sun or along hot edges like a driveway, and the patches keep spreading instead of greening up after watering.',
    confirm: 'What would settle it: a quick float test at the edge of the patch.',
  },
  'caterpillar activity': {
    kind: 'cause',
    why: 'Lawn caterpillars chew the grass blades, which leaves ragged, thinned areas that can show up quickly.',
    confirm: 'What would settle it: a soap flush on site to bring them to the surface.',
  },
  'grub activity': {
    kind: 'cause',
    why: 'Grubs feed on the roots, so the turf browns in patches and can pull up easily.',
    confirm: 'What would settle it: lifting a small piece of turf to check the roots.',
  },
  'large patch (fungal) activity': {
    kind: 'cause',
    why: 'Large patch shows as roughly round patches with a yellow or orange edge, most often in cooler, wet weather.',
    confirm: BLADE_AND_EDGE_LOOK,
  },
  'gray leaf spot': {
    kind: 'cause',
    why: 'Gray leaf spot shows as small spots on the grass blades, most often in warm, humid weather.',
    confirm: BLADE_AND_EDGE_LOOK,
  },
  'dollar spot': {
    kind: 'cause',
    why: 'Dollar spot shows as small, round, straw-colored spots that can merge into larger areas.',
    confirm: BLADE_AND_EDGE_LOOK,
  },
  'fungal activity': {
    kind: 'cause',
    why: 'Lawn fungus shows as spots on the blades or patches with a distinct edge, usually where the turf stays wet.',
    confirm: BLADE_AND_EDGE_LOOK,
  },
  'drought stress': {
    kind: 'cause',
    why: 'Dry turf takes on a blue-gray cast, the blades fold, and the lawn thins in the driest areas.',
    confirm: 'What would settle it: checking sprinkler coverage and soil moisture at the spot.',
  },
  'overwatering signal': {
    kind: 'cause',
    why: 'Turf that stays too wet looks matted or soggy and tends to invite weeds and fungus.',
    confirm: 'What would settle it: checking how long and how often each zone runs.',
  },
  'weed pressure': {
    kind: 'symptom',
    why: 'Weeds are visible in the photos, growing in with the turf.',
    confirm: null,
  },
  'thinning turf': {
    kind: 'symptom',
    why: 'The photos show areas where the grass is thin or bare.',
    confirm: ON_SITE_LOOK,
  },
  'color and nutrient stress': {
    kind: 'symptom',
    why: 'The photos show yellowing or uneven color in the turf.',
    confirm: ON_SITE_LOOK,
  },
  'color stress': {
    kind: 'symptom',
    why: 'The photos show uneven or faded color in the turf.',
    confirm: ON_SITE_LOOK,
  },
  'general lawn stress': { kind: 'generic', why: GENERIC_WHY, confirm: ON_SITE_LOOK },
  'a lawn condition we are monitoring': { kind: 'generic', why: GENERIC_WHY, confirm: ON_SITE_LOOK },
  'no major visible stress': {
    kind: 'clear',
    why: 'The photos show an even lawn with no problem area standing out.',
    confirm: null,
  },
};

const CERTAINTY = {
  cause: {
    high: 'How sure we are: high. The signs are clear in the photos.',
    moderate: 'How sure we are: moderate. The photos fit this pattern.',
  },
  symptom: {
    high: 'How sure we are: high. This is clear in the photos.',
    moderate: 'How sure we are: moderate. This shows in the photos.',
    low: 'How sure we are: low. The photos hint at this.',
  },
  generic: 'How sure we are: low. Photos alone are not enough to name a cause here.',
};

function certaintyFor(kind, confidence) {
  if (kind === 'clear') return null;
  if (kind === 'generic') return CERTAINTY.generic;
  if (kind === 'cause') {
    // A cause label below moderate never reaches here (the egress downgrades
    // it to the generic label first); if one ever did, it gets the generic line.
    return CERTAINTY.cause[confidence] || CERTAINTY.generic;
  }
  return CERTAINTY.symptom[confidence] || CERTAINTY.symptom.low;
}

/**
 * @param {string|null} label a customer-facing condition label (safeConditionLabel's output)
 * @param {string|null} confidence the clamped public confidence ('low'|'moderate'|'high'|'unknown'|null)
 * @returns {{ why: string, certainty: string|null, confirm: string|null }|null}
 */
function publicFindingEvidence(label, confidence) {
  const entry = Object.prototype.hasOwnProperty.call(EVIDENCE_BY_LABEL, label) ? EVIDENCE_BY_LABEL[label] : null;
  if (!entry) return null;
  return {
    why: entry.why,
    certainty: certaintyFor(entry.kind, confidence),
    confirm: confidence === 'high' ? null : entry.confirm,
  };
}

const MAX_PHOTO_COUNT = 12;
const LIMITED_PHOTOS = 'Some photos limited what we could see, so we kept our wording cautious.';

/**
 * The one-line basis for the whole report: how many photos, and whether their
 * quality held the read back. Photo limitations themselves are free text and
 * are never published.
 * @param {object} input
 * @param {number|null} [input.photoCount] photos stored for this diagnostic
 * @param {string|null} [input.photoQuality] input_assessment.photo_quality
 * @returns {string|null}
 */
function publicBasis({ photoCount = null, photoQuality = null } = {}) {
  const count = Number.isInteger(photoCount) && photoCount > 0 ? Math.min(photoCount, MAX_PHOTO_COUNT) : null;
  const parts = [];
  if (count) parts.push(`Based on ${count} ${count === 1 ? 'photo' : 'photos'}.`);
  if (photoQuality === 'limited' || photoQuality === 'poor') parts.push(LIMITED_PHOTOS);
  return parts.length ? parts.join(' ') : null;
}

module.exports = {
  publicFindingEvidence,
  publicBasis,
  EVIDENCE_BY_LABEL,
  CERTAINTY,
};

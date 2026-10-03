/**
 * Typed decisions caller (dark behind GATE_TYPED_DECISIONS).
 *
 * askPackage(packageId, state) asks a decision model the registered questions
 * of a decision package (./packages.js) about one `state` and returns
 * normalised, threshold-aware answers. `{ images }` (fitImagesForClef records, Clef only,
 * and only for a package that declares `imageSlots`) ride beside the state; see imagesProblem. TypeSafe Jev is the default provider;
 * `{ provider: 'cloudflare' }` puts the same package to Cloudflare Clef
 * (ROUTES.typedDecisionClef, behind GATE_TYPED_DECISIONS_CLEF as well), whose
 * answers share Jev's shape. It is the ONLY way a caller reaches either
 * route: each is single-leg (nothing else answers typed questions), so on
 * `ok:false` the caller keeps its existing path.
 * Shadow/evidence use only: the answers propose, they never send or write on
 * their own, and this module never throws.
 */
const logger = require('../logger');
const MODELS = require('../../config/models');
const { dispatch, rejectCall } = require('../llm/call');
const { typedDecisionsLive, typedDecisionsClefLive } = require('../../config/feature-gates');
const { packageFor, packageHash, validImageSlots, MAX_IMAGE_SLOTS } = require('./packages');

function stateProblem(state, pkg) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return 'state must be an object';
  const keys = Object.keys(state);
  const missing = pkg.stateShape.filter((k) => state[k] === undefined);
  const extra = keys.filter((k) => !pkg.stateShape.includes(k));
  if (missing.length) return `missing state keys: ${missing.join(', ')}`;
  if (extra.length) return `unexpected state keys: ${extra.join(', ')}`;
  return null;
}

const isProb = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

// choice / score answers share a confidence block.
function confidenceBlock(answer, thresholds) {
  const confidence = isProb(answer.confidence) ? answer.confidence : null;
  return {
    confidence,
    probabilities: answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {},
    confident: confidence !== null && confidence >= thresholds.confident_high,
  };
}

// One typed answer -> the shape reviews and callers read. Null when the
// answer is not the type the package asked for.
function normaliseAnswer(question, answer, thresholds) {
  if (!answer || typeof answer !== 'object' || answer.type !== question.type) return null;
  if (question.type === 'noul') {
    const p = answer.noul;
    if (!isProb(p)) return null;
    return { p, yes: p >= 0.5, confident: p <= thresholds.confident_low || p >= thresholds.confident_high };
  }
  if (question.type === 'choice') {
    return typeof answer.choice === 'string' ? { choice: answer.choice, ...confidenceBlock(answer, thresholds) } : null;
  }
  if (question.type === 'score') {
    return Number.isFinite(answer.score) ? { score: answer.score, legend: answer.legend ?? null, ...confidenceBlock(answer, thresholds) } : null;
  }
  return null;
}

// The providers that answer decision packages. typesafe (Jev) is the default;
// cloudflare (Clef on Workers AI) answers the SAME packages as a second
// opinion and needs its own gate on top of GATE_TYPED_DECISIONS. The route
// and lane ids are written out literally in askPackage (not looked up from a
// table) so the switchboard's call-site guard and the ledger coverage test
// can read them in this file.
const KNOWN_PROVIDERS = Object.freeze([MODELS.PROVIDER.TYPESAFE, MODELS.PROVIDER.CLOUDFLARE]);

// Images ride only a package that declares `imageSlots` (1..4), only to Clef,
// never more than the package's slots, and only as records fitImagesForClef
// returned (decoded and re-encoded by sharp; bare strings are refused). Anything
// else is refused before a provider is called; Jev never receives an image.
function imagesProblem(pkg, provider, images) {
  if (images === undefined || images === null) return null;
  if (!Array.isArray(images)) return 'images must be an array';
  if (!images.length) return null;
  if (!validImageSlots(pkg.imageSlots)) return `package declares no valid imageSlots (1..${MAX_IMAGE_SLOTS})`;
  if (provider !== MODELS.PROVIDER.CLOUDFLARE) return 'only the cloudflare provider takes images';
  if (images.length > pkg.imageSlots) return `package takes at most ${pkg.imageSlots} images`;
  // Loaded only when images are present: the fitter pulls in sharp.
  const { isFittedImage } = require('./image-budget');
  if (!images.every(isFittedImage)) return 'images must be records returned by fitImagesForClef';
  return null;
}

async function askPackage(packageId, state, { laneId, provider = MODELS.PROVIDER.TYPESAFE, images } = {}) {
  if (!typedDecisionsLive()) return { ok: false, reason: 'gate_off' };
  if (!KNOWN_PROVIDERS.includes(provider)) return { ok: false, reason: 'unknown_provider', provider };
  const clef = provider === MODELS.PROVIDER.CLOUDFLARE;
  if (clef && !typedDecisionsClefLive()) return { ok: false, reason: 'gate_off' };
  const pkg = packageFor(packageId);
  if (!pkg) return { ok: false, reason: 'unknown_package', packageId };
  const base = { packageId: pkg.id, packageHash: packageHash(pkg), provider };
  const imageIssue = imagesProblem(pkg, provider, images);
  if (imageIssue) {
    logger.warn(`[typed-decisions] images_not_allowed for ${pkg.id}: ${imageIssue}`);
    return { ok: false, reason: 'images_not_allowed', ...base };
  }
  const problem = stateProblem(state, pkg);
  if (problem) {
    logger.warn(`[typed-decisions] bad_state for ${pkg.id}: ${problem}`);
    return { ok: false, reason: 'bad_state', ...base };
  }
  try {
    const route = clef ? MODELS.ROUTES.typedDecisionClef : MODELS.ROUTES.typedDecision;
    const result = await dispatch(route, {
      state,
      questions: pkg.questions,
      ...(Array.isArray(images) && images.length ? { images: images.map((image) => image.dataUrl) } : {}),
      laneId: laneId || (clef ? 'typed_decisions_clef' : 'typed_decisions'),
      promptVersion: pkg.id,
    });
    if (!result || !result.ok) {
      return { ok: false, reason: (result && result.reason) || 'error', ...base, ...(result && result.usage ? { usage: result.usage } : {}) };
    }
    const answers = {};
    for (const [id, question] of Object.entries(pkg.questions)) {
      const normalised = normaliseAnswer(question, result.json && result.json[id], pkg.thresholds);
      if (!normalised) {
        // The adapter filed this call as ok (a 200 with answers); an answer
        // that is missing, mistyped or out of range makes it unusable, so the
        // ledger row flips to invalid_output like any rejected dispatch leg.
        rejectCall(result, 'invalid_output');
        return { ok: false, reason: 'incomplete_answers', ...base, usage: result.usage };
      }
      answers[id] = normalised;
    }
    return { ok: true, answers, servedModel: result.servedModel || null, ...base, usage: result.usage || null };
  } catch (err) {
    logger.error(`[typed-decisions] askPackage failed: ${err.message}`);
    return { ok: false, reason: 'error', ...base };
  }
}

module.exports = { askPackage, normaliseAnswer };

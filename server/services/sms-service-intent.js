/**
 * SMS service-intent classifier for the lead-intake flow.
 *
 * When a new lead replies after submitting a quote request, we call
 * classifyServiceIntent(body) on their inbound SMS to route them into the
 * right estimate draft when they mention service details.
 *
 *   classifyServiceIntent(body) -> Promise<{
 *     interest: 'pest' | 'lawn' | 'one_time' | null,
 *     confidence: number (0..1),
 *     method: 'regex' | 'claude' | 'none',
 *   }>
 *
 * Fast-path unambiguous keyword matches, fall back to Claude FAST for
 * anything ambiguous (multi-service mentions, natural language like
 * "I've got bugs in my yard"). Returns null interest when the classifier
 * can't confidently pick a branch — caller should fall through to the
 * human-draft path in that case.
 *
 * Sibling for inbound PHOTO texts (services/photo-text-triage.js):
 *
 *   classifyPhotoDiagnosisIntent(body) -> Promise<{
 *     intent: 'photo_diagnosis' | null,
 *     assessmentType: 'lawn' | 'pest' | null,
 *     method: 'regex' | 'claude' | 'none',
 *   }>
 *
 * Only meaningful for a message that already carries an image. Same shape
 * of decision: regex fast path first (a subject word or a "what is this"
 * question, or an EMPTY caption — a bare photo is a show-and-ask), Claude
 * FAST only for a caption the regex can't place.
 */

const logger = require('./logger');
const MODELS = require('../config/models');
const { dispatchWithFallback } = require('./llm/call');

// Tokens that unambiguously imply each branch.
const PEST_KEYWORDS = [
  'pest', 'pests', 'bug', 'bugs', 'ant', 'ants', 'roach', 'roaches',
  'cockroach', 'cockroaches', 'spider', 'spiders', 'rat', 'rats',
  'mouse', 'mice', 'rodent', 'rodents', 'termite', 'termites',
  'mosquito', 'mosquitoes', 'flea', 'fleas', 'tick', 'ticks',
  'wasp', 'wasps', 'bee', 'bees', 'silverfish', 'scorpion', 'scorpions',
  'quarterly', 'exterior', 'exterminator',
];

const LAWN_KEYWORDS = [
  'lawn', 'grass', 'turf', 'weed', 'weeds', 'fert', 'fertilizer',
  'fertilization', 'mow', 'mowing', 'plug', 'plugs', 'plugging',
  'sod', 'dethatch', 'dethatching', 'top dress', 'top-dress', 'top dressing',
  'yard', 'yellow grass', 'brown grass', 'crabgrass', 'chinch',
];

// "one time" / "one-time" / "just once" / "single visit"
const ONE_TIME_RE = /\b(one[\s-]?time|just once|one visit|single visit|one[\s-]?off|one shot)\b/i;

function tokenMatches(lower, tokens) {
  for (const t of tokens) {
    const re = new RegExp(`(^|[^a-z])${escapeRe(t)}([^a-z]|$)`, 'i');
    if (re.test(lower)) return true;
  }
  return false;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function regexClassify(body) {
  if (!body || typeof body !== 'string') return null;
  const lower = body.toLowerCase();

  const hasPest = tokenMatches(lower, PEST_KEYWORDS);
  const hasLawn = tokenMatches(lower, LAWN_KEYWORDS);
  const hasOneTime = ONE_TIME_RE.test(body);

  // Explicit one-time wins when paired with a service — e.g. "one-time pest
  // control" should route to one_time, not pest. But a bare "one time" with
  // no service signal is still one_time.
  if (hasOneTime) return { interest: 'one_time', confidence: 0.9, method: 'regex' };

  // Both pest + lawn mentioned → ambiguous, let Claude decide.
  if (hasPest && hasLawn) return null;
  if (hasPest) return { interest: 'pest', confidence: 0.9, method: 'regex' };
  if (hasLawn) return { interest: 'lawn', confidence: 0.9, method: 'regex' };

  return null;
}

// Structured-output contract for the classifier (the provider constrains the
// reply to this shape; see llm/call.js jsonSchema).
const INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['interest', 'confidence'],
  properties: {
    interest: { type: 'string', enum: ['pest', 'lawn', 'one_time', 'unknown'] },
    // Range constraints (minimum/maximum) are outside the structured-output
    // schema subset every provider accepts; the 0–1 range is enforced below.
    confidence: { type: 'number', description: 'Confidence in the classification, from 0 to 1' },
  },
};

async function claudeClassify(body) {
  if (!body) return { interest: null, confidence: 0, method: 'none' };

  try {
    const prompt = `You are classifying a customer SMS reply after they submitted a quote request for Waves Pest Control.

Their reply: ${JSON.stringify(body)}

Classify into ONE of:
- "pest" — recurring pest control (any bug/rodent/termite/mosquito/roach service, including quarterly exterior)
- "lawn" — lawn care (grass, weeds, fertilizer, turf, mowing, lawn treatments)
- "one_time" — a single-visit service (not a recurring plan)
- "unknown" — ambiguous, doesn't match any of the three, a question, or a complaint

Rules:
- Classify by what the customer is ASKING FOR, not by which pest/lawn words appear — a species or yard word is evidence, not the request.
- An explicit statement of cadence or scope (single visit vs recurring plan) outranks any species mention.
- Customers phrase these intents in unseen ways; match the meaning at the least-specific reading that fits, not keywords.`;

    const response = await dispatchWithFallback(MODELS.TEXT_POLICIES.fastStructured, {
      laneId: 'sms_intent',
      text: prompt,
      jsonMode: true,
      jsonSchema: INTENT_SCHEMA,
      maxTokens: 60,
    });
    if (!response.ok || !response.json) return { interest: null, confidence: 0, method: 'ai' };
    const parsed = response.json;
    const interest = ['pest', 'lawn', 'one_time'].includes(parsed.interest) ? parsed.interest : null;
    const confidence = typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1 ? parsed.confidence : 0;
    return { interest, confidence, method: 'ai' };
  } catch (err) {
    logger.error(`[sms-service-intent] AI classify failed: ${err.message}`);
    return { interest: null, confidence: 0, method: 'ai' };
  }
}

async function classifyServiceIntent(body) {
  const regexResult = regexClassify(body);
  if (regexResult) return regexResult;
  return claudeClassify(body);
}

// ── Photo-diagnosis intent (inbound MMS) ────────────────────────────────

// Words that pick the LAWN assessment. Everything else that triggers
// photo_diagnosis runs the pest identifier.
const PHOTO_LAWN_WORDS = ['lawn', 'grass', 'yard', 'turf', 'weed', 'weeds'];
const PHOTO_PEST_WORDS = [
  'bug', 'bugs', 'insect', 'insects', 'pest', 'pests', 'ant', 'ants',
  'termite', 'termites',
];
const PHOTO_TREE_SHRUB_WORDS = [
  'tree', 'trees', 'shrub', 'shrubs', 'bush', 'bushes', 'plant', 'plants',
  'palm', 'palms', 'leaf', 'leaves',
];
// Subject words that say "diagnose this" without leaning lawn or pest.
const PHOTO_NEUTRAL_WORDS = ['fungus', 'fungi', 'mold', 'mushroom', 'mushrooms'];
const PHOTO_QUESTION_RE = /\b(what(?:['’]?s| is| are)? (?:this|that|these|those|it)\b|what(?:['’]?s| is) wrong|what(?:['’]?s| is) going on|can you tell|could you tell|any idea|identify|what kind of|what type of)/i;

// TODO(tree_shrub): tree/shrub photos run the pest identifier until the
// tree_shrub assessment type lands in its own PR; flip this constant then.
const TREE_SHRUB_TRIAGE_TYPE = 'pest';

function countTokens(lower, tokens) {
  return tokens.filter((t) => tokenMatches(lower, [t])).length;
}

// Lawn only when lawn words strictly outnumber the pest-side words (pest +
// tree/shrub, which currently route to TREE_SHRUB_TRIAGE_TYPE); a tie or a
// question with no subject word runs the pest identifier.
function photoAssessmentType(lower) {
  const scores = { lawn: 0, pest: 0 };
  scores.lawn += countTokens(lower, PHOTO_LAWN_WORDS);
  scores.pest += countTokens(lower, PHOTO_PEST_WORDS);
  scores[TREE_SHRUB_TRIAGE_TYPE] += countTokens(lower, PHOTO_TREE_SHRUB_WORDS);
  return scores.lawn > scores.pest ? 'lawn' : 'pest';
}

function regexClassifyPhoto(body) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) return { intent: 'photo_diagnosis', assessmentType: 'pest', method: 'regex' };
  const lower = text.toLowerCase();
  const subject = tokenMatches(lower, [
    ...PHOTO_LAWN_WORDS, ...PHOTO_PEST_WORDS, ...PHOTO_TREE_SHRUB_WORDS, ...PHOTO_NEUTRAL_WORDS,
  ]);
  if (!subject && !PHOTO_QUESTION_RE.test(text)) return null;
  return { intent: 'photo_diagnosis', assessmentType: photoAssessmentType(lower), method: 'regex' };
}

const PHOTO_INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject'],
  properties: {
    subject: { type: 'string', enum: ['lawn', 'pest', 'tree_shrub', 'none'] },
  },
};
const PHOTO_SUBJECT_TYPES = { lawn: 'lawn', pest: 'pest', tree_shrub: TREE_SHRUB_TRIAGE_TYPE };

async function claudeClassifyPhoto(body) {
  const none = { intent: null, assessmentType: null, method: 'ai' };
  try {
    const prompt = `A customer texted Waves Pest Control a PHOTO with this caption: ${JSON.stringify(body)}

Is the customer asking us to look at the photo and tell them what something is or what is wrong with it? Pick ONE subject:
- "lawn" — their grass, turf, or yard (brown/dead patches, weeds, lawn disease)
- "pest" — a bug, insect, spider, rodent, termite, or damage from one
- "tree_shrub" — a tree, shrub, palm, or plant
- "none" — anything else (a gate code, a receipt, a thank-you, a scheduling note, an address, a screenshot)

Classify by what the customer is ASKING, not by which words appear.`;
    const response = await dispatchWithFallback(MODELS.TEXT_POLICIES.fastStructured, {
      laneId: 'sms_intent',
      text: prompt,
      jsonMode: true,
      jsonSchema: PHOTO_INTENT_SCHEMA,
      maxTokens: 40,
    });
    const assessmentType = response.ok && response.json ? PHOTO_SUBJECT_TYPES[response.json.subject] : null;
    return assessmentType ? { intent: 'photo_diagnosis', assessmentType, method: 'ai' } : none;
  } catch (err) {
    logger.error(`[sms-service-intent] AI photo classify failed: ${err.message}`);
    return none;
  }
}

async function classifyPhotoDiagnosisIntent(body) {
  return regexClassifyPhoto(body) || claudeClassifyPhoto(body);
}

module.exports = {
  classifyServiceIntent,
  classifyPhotoDiagnosisIntent,
  TREE_SHRUB_TRIAGE_TYPE,
};

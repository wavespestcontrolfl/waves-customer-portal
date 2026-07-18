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

Return ONLY JSON: {"interest":"pest"|"lawn"|"one_time"|"unknown","confidence":0.0-1.0}`;

    const response = await dispatchWithFallback(MODELS.TEXT_POLICIES.fastStructured, {
      text: prompt,
      jsonMode: true,
      maxTokens: 60,
    });
    if (!response.ok || !response.json) return { interest: null, confidence: 0, method: 'ai' };
    const parsed = response.json;
    const interest = ['pest', 'lawn', 'one_time'].includes(parsed.interest) ? parsed.interest : null;
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
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

module.exports = { classifyServiceIntent };

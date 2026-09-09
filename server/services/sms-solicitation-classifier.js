/**
 * SMS solicitation classifier — lead-gen / marketing / software / staffing
 * pitches TO Waves arriving on the location and tracking lines from numbers
 * that are not customers. 60 days to 2026-09-09: 41 unknown senders, 18 of
 * them vendors (41 texts), zero of them classified anywhere — they sat
 * unread, lit the Messages badge, recurred in the nightly digest, and one
 * earned an unsubscribe reply from a Waves line.
 *
 * Two layers, same asymmetric-cost rule as call-spam-classifier.js:
 *   1. isSolicitationPitch — strong vendor markers, or two weak categories
 *      including an outreach clue (mechanical, no model).
 *   2. FAST structured call, only when the regex missed: `solicitation` +
 *      confidence. Counts only at >= ENFORCE_CONFIDENCE.
 * A homeowner asking for a quote ("free estimate", "rate for a rat
 * problem") is NOT a solicitation and the prompt says so.
 *
 * Dark by default. GATE_SMS_SPAM_CLASSIFIER, read at call time:
 *   unset / anything else → off: nothing runs, nothing is written.
 *   'shadow'              → classify + record the verdict on the sms_log
 *                           row (metadata.spam_verdict) for grading; the
 *                           text is handled exactly as today.
 *   'true'                → enforce: a solicitation verdict lands the text
 *                           already-read (no bell, no push, no Messages
 *                           badge, no nightly-digest row) and keeps it out
 *                           of the estimator. The thread stays in the inbox
 *                           under the Unknown filter — nothing is blocked
 *                           or deleted, so a wrong verdict costs one
 *                           unopened thread, reversed by replying to it.
 *
 * NEVER sends anything. Never runs for a matched customer.
 */

const MODELS = require('../config/models');
const { dispatchWithFallback } = require('./llm/call');
const logger = require('./logger');

const CLASSIFIER_VERSION = 'sms-solicitation-v1';
const ENFORCE_CONFIDENCE = 0.85;
// Webhook-safe ceiling (same reasoning as the estimator's SMS classifier):
// the Twilio handler awaits this before returning TwiML.
const TIMEOUT_MS = 3500;

// Bare carrier commands are handled by the webhook's own STOP/HELP/START
// branches; screening them would spend a model call whose verdict those
// branches discard, and delay their TwiML by up to the timeout. The
// command set is the webhook's own detector — exact / typo keyword
// matches only: its natural-language patterns ("stop texting") are the
// very footers a pitch carries and must NOT bypass the screen.
const { detectSmsOptCommand, detectHelp } = require('./messaging/opt-out-detector');
function isCarrierCommand(text) {
  const cmd = detectSmsOptCommand(text);
  if (cmd.action && /keyword$/.test(String(cmd.detectionMethod || ''))) return true;
  return Boolean(detectHelp(text).help);
}

// Marker CATEGORIES, same shape as call-spam-classifier's robocall script
// signature: a STRONG marker is phrasing a homeowner never writes and is a
// verdict alone; a WEAK marker is vendor-flavored but a prospect can write
// it too ("no upfront cost?", "reply NO if you can't make it", "would you
// like more details?"). Weak matches need two distinct categories,
// including an outreach clue (an opt-out instruction or marketing offer):
// customers can combine pricing and detail questions in a genuine ask.
// Anything softer is left to the model, which is told vendors are not
// quote requests.
const SOLICITATION_MARKERS = [
  { key: 'leads_pitch', strong: true, re: /\b(?:(?:exclusive|qualified|unlimited)\s+(?:\w+\s+){0,3}(?:leads?|jobs?|customers?|estimates?)|(?:more|extra)\s+(?:\w+\s+){0,3}leads?)\b|\bleads?\s+for\s+(?:you|your)\b/i },
  { key: 'ad_spend', strong: true, re: /\bfund\s+your\s+ads?\b|\bad[\s-]?spend\b/i },
  { key: 'grow_business', strong: true, re: /\b(?:grow|scale|book(?:ing)?\s+more|fill)\s+(?:your\s+)?(?:business|schedule|calendar)\b/i },
  { key: 'vendor_tool', strong: true, re: /\b(?:having|offer(?:ing)?|provid(?:e|ing)|try)\s+(?:an?\s+|our\s+)?ai\s+receptionist\b|\breview\s+system\b[^.!?]{0,80}\bfor\s+your\s+business\b/i },
  // Matching homeowners to contractors is lead generation; connecting us
  // with a property manager for access is ordinary quote coordination.
  { key: 'connects_you', strong: true, re: /\bconnect(?:s|ing)?\s+(?:you\s+with\s+(?:local\s+)?homeowners?\s+(?:requesting|seeking)\s+(?:quotes?|estimates?)|local\s+homeowners\s+with\s+(?:local\s+)?(?:contractors?|professionals?))\b/i },
  // A tenant's service request is not a pitch without recruitment copy.
  { key: 'service_requested_by', strong: true, re: /\bservice\s+is\s+being\s+requested\s+by\b[\s\S]{0,160}\b(?:apply\s+(?:here|now|today)|\d+\s*min(?:ute)?s?\s+to\s+apply)\b/i },
  // Capacity outreach needs a second weak category. A customer's request
  // for more estimates is not itself a marker, even with a detail question.
  { key: 'additional_work', strong: false, re: /\b(?:handle|open\s+to)\s+(?:\d+(?:\s*[-–]\s*\d+)?\s+)?(?:more|extra)\s+(?:\w+\s+){0,3}(?:jobs?|customers?|estimates?)\b/i },
  // "$" is not a word character, so the boundary sits inside the
  // alternation rather than in front of it (codex r2).
  { key: 'no_upfront', strong: false, re: /(?:\bno|\bzero|\$0)\s+(?:upfront|up-front|set-?up|monthly)\s+(?:cost|costs|fee|fees)?|\bfree\s+(?:setup|set-up|trial)\b/i },
  { key: 'reply_directive', strong: false, outreach: true, re: /\b(?:reply|say|text)\s+["']?(?:stop|no|byebye|end)["']?\s+(?:to\s+(?:opt[\s-]?out|stop|unsubscribe|be\s+removed)|if\s+you\s+(?:want|need)\s+(?:me|us)\s+to\s+stop)\b/i },
  { key: 'marketing_offer', strong: false, outreach: true, re: /\bour\s+(?:\w+\s+){0,3}(?:marketing|lead[\s-]?gen(?:eration)?)\s+(?:package|service|platform|program)\b/i },
  { key: 'more_details', strong: false, re: /\b(?:want|like)\s+(?:more\s+)?details\?/i },
];

/** Pure. A strong marker, or two weak categories including an outreach clue. */
function isSolicitationPitch(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  const hits = SOLICITATION_MARKERS.filter((m) => m.re.test(t));
  return hits.some((m) => m.strong) || (hits.length >= 2 && hits.some((m) => m.outreach));
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['solicitation', 'confidence'],
  properties: {
    solicitation: { type: 'boolean' },
    confidence: { type: 'number', description: 'Confidence in the decision, from 0 to 1' },
  },
};

function classifierMode() {
  const v = String(process.env.GATE_SMS_SPAM_CLASSIFIER || '').trim().toLowerCase();
  if (v === 'true') return 'enforce';
  if (v === 'shadow') return 'shadow';
  return 'off';
}

/**
 * @param {object} args
 * @param {string} args.body  — the inbound text
 * @returns {Promise<{solicitation:boolean, confidence:number, method:'regex'|'model'|'model_failed'|'empty', version:string}>}
 */
async function classifySolicitation({ body }) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (!text) return { solicitation: false, confidence: 1, method: 'empty', version: CLASSIFIER_VERSION };
  if (isSolicitationPitch(text)) {
    return { solicitation: true, confidence: 1, method: 'regex', version: CLASSIFIER_VERSION };
  }
  try {
    const response = await dispatchWithFallback(MODELS.TEXT_POLICIES.fastStructured, {
      laneId: 'sms_solicitation',
      text: `A text message arrived on a business phone line of Waves Pest Control, a pest control and lawn care company. The sender is not a known customer.

Decide whether the sender is a BUSINESS PITCHING SOMETHING TO WAVES — lead generation or "more jobs/customers", marketing or ads, review or reputation tools, software, an AI receptionist, staffing or recruiting, financing, insurance, or another contractor offering Waves their services or a partnership.

NOT a solicitation: a homeowner, tenant, property manager, or business asking Waves for service, a quote, pricing, availability, or an appointment — even when the message mentions their own company; a question about an existing job or bill; a wrong number; a personal message.

Message: ${JSON.stringify(text.slice(0, 600))}`,
      jsonMode: true,
      jsonSchema: SCHEMA,
      maxTokens: 60,
      timeoutMs: TIMEOUT_MS,
    });
    if (!response.ok || !response.json) {
      return { solicitation: false, confidence: 0, method: 'model_failed', version: CLASSIFIER_VERSION };
    }
    const confidence = Number(response.json.confidence);
    return {
      solicitation: response.json.solicitation === true,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      method: 'model',
      version: CLASSIFIER_VERSION,
    };
  } catch (err) {
    logger.warn(`[sms-solicitation] classifier failed (treating as not spam): ${err.message}`);
    return { solicitation: false, confidence: 0, method: 'model_failed', version: CLASSIFIER_VERSION };
  }
}

/**
 * The webhook entry. Returns null when the gate is off or the text is not
 * eligible (a known sender — customer or service contact — a reaction, a
 * bare carrier command, no body, or the AI assistant line, which answers
 * its own unknown senders and must keep its own routing); otherwise the verdict with
 * `mode` and `enforced` (true only in enforce mode for a confident
 * solicitation). The caller writes the verdict onto the sms_log row and, when
 * enforced, lands the text read and skips the bell + estimator.
 */
async function screenInboundSms({ body, hasCustomer, isReaction, isAiLine = false }) {
  const mode = classifierMode();
  if (mode === 'off') return null;
  const text = String(body || '').trim();
  if (hasCustomer || isReaction || isAiLine || !text || isCarrierCommand(text)) return null;
  const verdict = await classifySolicitation({ body });
  const confident = verdict.solicitation && verdict.confidence >= ENFORCE_CONFIDENCE;
  const enforced = mode === 'enforce' && confident;
  logger.info(`[sms-solicitation] ${verdict.method} solicitation=${verdict.solicitation} confidence=${verdict.confidence.toFixed(2)} mode=${mode} enforced=${enforced}`);
  return { ...verdict, mode, confident, enforced };
}

module.exports = {
  screenInboundSms,
  classifySolicitation,
  classifierMode,
  isSolicitationPitch,
  SOLICITATION_MARKERS,
  ENFORCE_CONFIDENCE,
  CLASSIFIER_VERSION,
};

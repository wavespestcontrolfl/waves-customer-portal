/**
 * Estimator Engine — SMS-thread entry (GATE_ESTIMATOR_SMS_DRAFTS, default
 * OFF; also requires GATE_ESTIMATOR_ENGINE — killing the engine kills this).
 *
 * A quote-flavored inbound text runs the shared draft pipeline against the
 * caller's SMS thread: composed intent → deterministic pricing → DRAFT in a
 * lane + ONE phone-scoped admin bell. Same hard rules as the call entry —
 * the LLM composes intent only, drafts are never sent, and every failure
 * degrades to a bell instead of a silent drop.
 *
 * Trigger cheapness: every inbound SMS passes through here, so a regex
 * prefilter gates the FAST-tier confirm classifier, which gates the DEEP
 * composer. Repeated quote-y texts on one number dedupe three ways: the
 * open-automated-estimate precheck (skip before any model call), the
 * phone-advisory-locked duplicate guard at draft time, and the
 * phone-scoped bell key (`sms:<last10>`).
 */

const logger = require('../logger');
const MODELS = require('../../config/models');
const { dispatchWithFallback } = require('../llm/call');
const { last10 } = require('../external-phone');

function smsThreadDraftsEnabled() {
  const flag = process.env.GATE_ESTIMATOR_SMS_DRAFTS;
  const on = flag === '1' || flag === 'true' || flag === 'on';
  if (!on) return false;
  const { estimatorEngineEnabled } = require('./index');
  return estimatorEngineEnabled();
}

// Cheap prefilter: only texts that plausibly ask for pricing/service reach
// the FAST classifier. Deliberately broad — the classifier is the precise
// gate; this only exists to keep "YES", "thanks!", and reschedule chatter
// away from any model call.
const QUOTE_HINT_RE = new RegExp(
  [
    'quote', 'estimate', 'pric', 'cost', 'how much', 'rate', 'charge',
    'pest', 'bug', 'ant', 'roach', 'termite', 'mosquito', 'rodent', 'rat',
    'mice', 'flea', 'bed ?bug', 'wasp', 'hornet', 'lawn', 'grass', 'weed',
    'fertiliz', 'shrub', 'tree', 'spray', 'treat', 'service',
  ].join('|'),
  'i',
);

/**
 * FAST-tier confirm: is this inbound text (in the context of a thread with
 * a pest-control company) actually requesting a quote/pricing for service?
 * Fail-closed: any classifier failure means "no" — a missed draft costs a
 * manual quote, a false positive costs a DEEP composer run per text.
 */
async function threadQuoteSignal(body) {
  const text = String(body || '').trim();
  if (!text || !QUOTE_HINT_RE.test(text)) return { quoteRequest: false, method: 'regex' };
  try {
    const prompt = `An SMS arrived at Waves Pest Control (pest control + lawn care). Decide if the sender is asking for a QUOTE or PRICING for a service (new or additional service, "how much", "can you give me a price", describing a pest/lawn problem they want serviced).

NOT a quote request: appointment confirmations/rescheduling, payment/billing questions about existing service, thanks/acknowledgments, complaints about a completed job, wrong numbers.

Message: ${JSON.stringify(text)}

Return ONLY JSON: {"quote_request":true|false,"confidence":0.0-1.0}`;
    const response = await dispatchWithFallback(MODELS.TEXT_POLICIES.fastStructured, {
      text: prompt,
      jsonMode: true,
      maxTokens: 60,
    });
    if (!response.ok || !response.json) return { quoteRequest: false, method: 'ai_failed' };
    const quoteRequest = response.json.quote_request === true
      && Number(response.json.confidence || 0) >= 0.6;
    return { quoteRequest, method: 'ai', confidence: response.json.confidence };
  } catch (err) {
    logger.warn(`[estimator-sms] quote-signal classify failed: ${err.message}`);
    return { quoteRequest: false, method: 'ai_failed' };
  }
}

function smsOrigin(threadKey) {
  return {
    channel: 'sms_thread',
    noun: 'text thread',
    threadKey,
    transcriptLabel: 'SMS CONVERSATION (customer ↔ Waves, oldest first)',
    strings: {
      redTitle: 'Quote asked by text — send it',
      redBody: (label, reasons) => `${label}: quote requested over SMS, no auto-draft (${reasons}). Reply with pricing manually.`,
      composerFailBody: (label) => `${label}: a text thread asked for a quote but the estimator engine could not compose a draft. Reply with pricing manually.`,
      errorBody: 'A text thread asked for a quote but the estimator engine hit an error. Reply with pricing manually.',
      blockedTitle: 'Quote asked by text — estimate already open',
      blockedBody: (label) => `${label}: a text thread asked for a quote, but an automated estimate is already open for this phone number. Review and send the existing one.`,
    },
  };
}

/**
 * Non-throwing, mirrors maybeDraftEstimateForCall's contract. `skipIntentGate`
 * is for callers that already established quote intent (the lead-intake state
 * machine, where the customer explicitly picked a service).
 */
async function maybeDraftEstimateForSmsThread({ phone, triggerBody = '', skipIntentGate = false, dryRun = false }) {
  const digits = last10(phone);
  const result = { phone: digits ? `…${digits.slice(-4)}` : null, lane: null, created: false, skipped: null };
  try {
    if (!smsThreadDraftsEnabled()) {
      result.skipped = 'gate_off';
      return result;
    }
    if (!digits) {
      result.skipped = 'no_usable_phone';
      return result;
    }
    if (!skipIntentGate) {
      const signal = await threadQuoteSignal(triggerBody);
      if (!signal.quoteRequest) {
        result.skipped = `no_quote_intent_${signal.method}`;
        return result;
      }
    }

    // No phone-only duplicate precheck here: an open estimate on this phone
    // can be for a DIFFERENT property (multi-property owners are real), and
    // only the composer can read the address out of the thread. The
    // draft-time guard has the address-aware bypass; a true duplicate exits
    // through the blocked path's single thread-keyed bell. Cost is bounded
    // by the FAST quote-intent gate above — only genuine quote requests
    // reach the DEEP composer.
    const { buildSmsThreadContext } = require('./context-builder');
    const { runDraftPipeline, notify } = require('./index');
    const origin = smsOrigin(`sms:${digits}`);
    const context = await buildSmsThreadContext({ phone, triggerBody });
    if (context.error) {
      result.lane = 'red';
      result.reasons = [context.error];
      // Intent was established (gate or classifier) — the request must not
      // die silently just because the thread was unreadable/ambiguous.
      if (!dryRun) {
        await notify({
          call: null,
          context,
          lane: 'red',
          quotePromised: true,
          threadKey: origin.threadKey,
          title: origin.strings.redTitle,
          body: `A text thread asked for a quote the estimator engine could not read (${context.error}). Review the conversation and send the estimate manually.`,
        });
      }
      return result;
    }
    context.origin = origin;

    return await runDraftPipeline({
      context,
      origin,
      result,
      dryRun,
      // The customer asked in their own words — red-lane fallbacks must
      // bell so a text quote request is never silently dropped.
      quotePromised: true,
    });
  } catch (err) {
    logger.error(`[estimator-sms] thread draft failed: ${err.message}`);
    result.skipped = result.skipped || `error: ${err.message}`;
    return result;
  }
}

module.exports = {
  smsThreadDraftsEnabled,
  maybeDraftEstimateForSmsThread,
  _private: { threadQuoteSignal, smsOrigin, QUOTE_HINT_RE },
};

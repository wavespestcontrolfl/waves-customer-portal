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
 * Durability contract (mirrors the call pipeline's synchronous generic
 * bell): startSmsThreadDraft AWAITS the cheap phase — gates, quote-intent
 * classifier, and a durable owed-quote bell — and only then detaches the
 * DEEP composer run. A restart mid-compose leaves the bell as the manual
 * task; on success the engine upgrades that same bell in place (thread-key
 * dedupe), so there is never a second ring and never a silent loss.
 *
 * Trigger cheapness: every inbound SMS passes through here, so a regex
 * prefilter gates the FAST-tier confirm classifier, which gates the DEEP
 * composer. There is deliberately NO phone-only duplicate precheck: an open
 * estimate can be for a DIFFERENT property, and only the composer can read
 * the address out of the thread — the draft-time guard keeps its
 * address-aware bypass, and true duplicates exit through the blocked path's
 * single thread-keyed bell.
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
      // Webhook-safe ceiling: the Twilio handler AWAITS this classifier
      // before returning TwiML, and without it the dispatcher's default
      // multi-minute fallback budget could hold the webhook past Twilio's
      // retry window. Timeout ⇒ fail-closed "not a quote request".
      timeoutMs: 3500,
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

// The heavy detached phase: context build → shared pipeline. Non-throwing.
async function runThreadDraft({ phone, digits, triggerBody, origin, dryRun }) {
  const result = { phone: `…${digits.slice(-4)}`, lane: null, created: false, skipped: null };
  try {
    const { buildSmsThreadContext } = require('./context-builder');
    const { runDraftPipeline, notify } = require('./index');
    const context = await buildSmsThreadContext({ phone, triggerBody });
    if (context.error) {
      result.lane = 'red';
      result.reasons = [context.error];
      // Quote intent was already established — the request must not die
      // silently because the thread was unreadable/ambiguous/unloadable.
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

/**
 * The awaited entry (callers: Twilio webhook, lead-intake handoff). Cheap
 * and bounded — gate checks, the FAST classifier, and one durable bell
 * insert; the DEEP composer runs detached afterwards (returned as
 * `draftPromise` for tests/replay, deliberately not awaited by callers).
 * `skipIntentGate` is for callers that already established quote intent
 * (the lead-intake state machine, where the customer picked a service).
 */
async function startSmsThreadDraft({ phone, triggerBody = '', skipIntentGate = false, skipCooldown = false, dryRun = false }) {
  const digits = last10(phone);
  const result = { phone: digits ? `…${digits.slice(-4)}` : null, started: false, skipped: null };
  try {
    if (!smsThreadDraftsEnabled()) {
      result.skipped = 'gate_off';
      return result;
    }
    if (!digits) {
      result.skipped = 'no_usable_phone';
      return result;
    }
    // DB-backed per-phone cooldown BEFORE any paid call: the durable
    // owed-quote bell doubles as the claim record, so a sender repeating
    // quote-flavored texts can't burn unlimited FAST/DEEP runs — draft-time
    // duplicate detection alone happens after the spend. Independent later
    // requests (different property included) pass once the window clears;
    // within it, the standing bell already tells the operator a quote is
    // owed on this phone.
    // skipCooldown: a clarify-reply resume carries NEW information the
    // customer just supplied — the anti-repeat cooldown must not eat it.
    if (!dryRun && !skipCooldown) {
      const SMS_DRAFT_COOLDOWN_MS = 10 * 60 * 1000;
      const db = require('../../models/db');
      const recentRun = await db('notifications')
        .whereRaw("metadata->>'smsThreadKey' = ?", [`sms:${digits}`])
        .where('created_at', '>=', new Date(Date.now() - SMS_DRAFT_COOLDOWN_MS))
        .first();
      if (recentRun) {
        result.skipped = 'cooldown';
        return result;
      }
    }
    if (!skipIntentGate) {
      const signal = await threadQuoteSignal(triggerBody);
      if (!signal.quoteRequest) {
        result.skipped = `no_quote_intent_${signal.method}`;
        return result;
      }
    }
    const origin = smsOrigin(`sms:${digits}`);
    if (!dryRun) {
      // Durable owed-quote task BEFORE any detached work — a restart or
      // deploy mid-compose must leave a bell, never a silent loss. The
      // pipeline upgrades this same bell in place on success; red-lane and
      // blocked outcomes leave it standing (same manual instruction). A
      // failed insert means NO durable artifact exists: report not-started
      // so callers keep their own fallback (lead-intake keeps the shell).
      const { notify } = require('./index');
      const belled = await notify({
        call: null,
        context: null,
        lane: 'red',
        quotePromised: true,
        threadKey: origin.threadKey,
        title: origin.strings.redTitle,
        body: 'A customer text is asking for a quote. The estimator engine is drafting now — if no draft notification follows, review the thread and send the estimate manually.',
      });
      if (!belled) {
        result.skipped = 'durable_bell_failed';
        return result;
      }
    }
    result.started = true;
    result.draftPromise = runThreadDraft({ phone, digits, triggerBody, origin, dryRun })
      .catch((err) => {
        logger.error(`[estimator-sms] detached draft failed: ${err.message}`);
        return null;
      });
    return result;
  } catch (err) {
    logger.error(`[estimator-sms] start failed: ${err.message}`);
    result.skipped = result.skipped || `error: ${err.message}`;
    return result;
  }
}

module.exports = {
  smsThreadDraftsEnabled,
  startSmsThreadDraft,
  _private: { threadQuoteSignal, smsOrigin, runThreadDraft, QUOTE_HINT_RE },
};

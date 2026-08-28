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
 * composer. With GATE_ESTIMATOR_SCOPE_GUARDS on (scope-guards.js), the
 * classifier is additionally grounded in Waves records — offered services,
 * sender/address→customer matches, booked visits — so existing-job
 * coordination texts and out-of-scope services (power washing) stop
 * minting owed-quote bells. There is deliberately NO phone-only duplicate precheck: an open
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

// Markers that the sender is REPLACING the previous ask rather than
// continuing it. Deliberately narrow — an explicit correction word plus a
// trigger body that itself names nothing out of scope; the grounded
// classifier still makes the actual call.
const CORRECTION_RE = /\b(?:actually|instead|never\s*mind|nevermind|scratch\s+that|forget\s+(?:that|it)|different\s+question|change\s+of\s+plans)\b/i;

/**
 * FAST-tier confirm: is this inbound text (in the context of a thread with
 * a pest-control company) actually requesting a quote/pricing for service?
 * Fail-closed: any classifier failure means "no". Cost asymmetry, learned
 * the hard way (2026-07-30): a missed draft costs a manual quote, but a
 * false positive costs an owner-facing owed-quote bell that nothing can
 * retract — and possibly a parked customer-facing clarify draft — not just
 * a DEEP composer run. Hence the scope guards: with
 * GATE_ESTIMATOR_SCOPE_GUARDS on, the classifier is grounded in what Waves
 * actually knows (offered services, sender/address→customer matches,
 * booked visits) instead of judging the message text alone.
 */
async function threadQuoteSignal(body, triage = null, { hintGate = true } = {}) {
  const text = String(body || '').trim();
  if (!text) return { quoteRequest: false, method: 'regex' };
  // hintGate=false (clarify-resume scope check): resume replies answer a
  // question ("power wash my yard") and rarely carry quote vocabulary, so
  // the cheap prefilter would hide them from the grounded scope vetoes.
  if (hintGate && !QUOTE_HINT_RE.test(text)) return { quoteRequest: false, method: 'regex' };
  try {
    const grounded = !!triage;
    const contextBlock = grounded && triage.lines.length
      ? `\nKNOWN WAVES RECORDS (matched from this message):\n${triage.lines.map((l) => `- ${l}`).join('\n')}\n`
      : (grounded ? '\nKNOWN WAVES RECORDS: no matching customer records.\n' : '');
    // The service being asked about may live in an earlier text ("Do you do
    // power washing?" … "How much?") — judge the message in its thread.
    const threadBlock = grounded && (triage.recentTexts || []).length
      ? `\nRECENT TEXTS IN THIS THREAD (newest first; [sender] = their texts, [Waves] = our replies):\n${triage.recentTexts.slice(0, 5).map((t) => `- ${JSON.stringify(t.slice(0, 200))}`).join('\n')}\n`
      : '';
    const prompt = grounded
      ? `An SMS arrived at Waves Pest Control (pest control + lawn care company).

SERVICES WAVES OFFERS: recurring & one-time pest control, lawn health programs & one-time lawn treatments, tree & shrub care, mosquito programs, termite bait/monitoring and termite/WDO inspections, rodent bait stations, flea/tick, chemical bed bug treatment, wasp/hornet/bee treatment and honeycomb extraction. NOT OFFERED: power washing, roofing, gutters, painting, pools, plumbing, HVAC, electrical, cleaning, junk removal, handyman work, live bee relocation.
${contextBlock}${threadBlock}
Decide three things about the sender's message:
- quote_request: are they asking for a QUOTE or PRICING for a service (new or additional service, "how much", describing a pest/lawn problem they want serviced)?
- service_offered: does the request map to a service Waves offers? (true when it's unclear which service they mean)
- relates_to_existing_job: is this coordinating, scheduling, or adding detail to a visit that is ALREADY BOOKED, or asking for work the customer's CURRENT services already cover — including a third party texting on a customer's behalf? Pricing for a NEW or ADDITIONAL service is a quote request even from an existing customer at a known address (quote_request true, relates_to_existing_job false) — e.g. a pest-control customer asking what a mosquito program costs.

NOT a quote request: appointment confirmations/rescheduling, payment/billing questions about existing service, thanks/acknowledgments, complaints about a completed job, wrong numbers.

Message: ${JSON.stringify(text)}

Return ONLY JSON: {"quote_request":true|false,"service_offered":true|false,"relates_to_existing_job":true|false,"confidence":0.0-1.0}`
      : `An SMS arrived at Waves Pest Control (pest control + lawn care). Decide if the sender is asking for a QUOTE or PRICING for a service (new or additional service, "how much", "can you give me a price", describing a pest/lawn problem they want serviced).

NOT a quote request: appointment confirmations/rescheduling, payment/billing questions about existing service, thanks/acknowledgments, complaints about a completed job, wrong numbers.

Message: ${JSON.stringify(text)}

Return ONLY JSON: {"quote_request":true|false,"confidence":0.0-1.0}`;
    const response = await dispatchWithFallback(MODELS.TEXT_POLICIES.fastStructured, {
      text: prompt,
      jsonMode: true,
      // The grounded response carries three booleans instead of one.
      maxTokens: grounded ? 100 : 60,
      // Webhook-safe ceiling: the Twilio handler AWAITS this classifier
      // before returning TwiML, and without it the dispatcher's default
      // multi-minute fallback budget could hold the webhook past Twilio's
      // retry window. Timeout ⇒ fail-closed "not a quote request".
      timeoutMs: 3500,
    });
    if (!response.ok || !response.json) return { quoteRequest: false, method: 'ai_failed' };
    const j = response.json;
    const confident = j.quote_request === true && Number(j.confidence || 0) >= 0.6;
    if (grounded && !hintGate && Number(j.confidence || 0) >= 0.6) {
      // Resume scope check (hintGate off): honor the EXPLICIT veto
      // booleans regardless of quote_request — a compliant "this is just
      // for Friday's visit" answer is exactly quote_request:false +
      // relates_to_existing_job:true, which the confident-gated branch
      // below would wave through as method 'ai'. But the veto must still
      // MEET THE CONFIDENCE BAR (same 0.6 as the primary path): these
      // vetoes are TERMINAL to callers like lead-intake, which then
      // suppress their fallback — a low-confidence guess would leave an
      // established quote request with no draft and no durable task.
      // Below the bar (and on missing/malformed booleans) the resume
      // proceeds — fail-open, per the documented asymmetry.
      if (j.service_offered === false) {
        return { quoteRequest: false, method: 'ai_out_of_scope', confidence: j.confidence };
      }
      if (j.relates_to_existing_job === true) {
        return { quoteRequest: false, method: 'ai_existing_job', confidence: j.confidence };
      }
    }
    if (grounded && confident) {
      // Grounded vetoes are the point of the context: an in-confidence
      // "quote" for a service Waves doesn't offer, or for an existing
      // customer's already-covered job, must not mint an owed-quote task.
      // Both veto fields must be REAL booleans — a syntactically valid but
      // incomplete response ({"quote_request":true,...} with the veto keys
      // missing) would otherwise bypass both vetoes; treat it like any
      // other malformed classifier output (fail-closed).
      if (typeof j.service_offered !== 'boolean' || typeof j.relates_to_existing_job !== 'boolean') {
        return { quoteRequest: false, method: 'ai_malformed_grounded', confidence: j.confidence };
      }
      if (j.service_offered === false) {
        return { quoteRequest: false, method: 'ai_out_of_scope', confidence: j.confidence };
      }
      if (j.relates_to_existing_job === true) {
        return { quoteRequest: false, method: 'ai_existing_job', confidence: j.confidence };
      }
    }
    return { quoteRequest: confident, method: 'ai', confidence: j.confidence };
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
      proposalTitle: 'Commercial prospect by text — proposal scaffold ready',
      proposalBody: (label) => `${label}: commercial relationship quote from a text thread — prospect research and an unpriced proposal scaffold are drafted. Price it in the proposal builder.`,
    },
  };
}

// The heavy detached phase: context build → shared pipeline. Non-throwing.
// groundedCustomerId (scope guards only, else null): the customer the triage
// grounding matched by address/sender when it matched exactly one — rides
// into the context build so an off-file coordinator's quote links the
// estimate to the customer it is provably about.
async function runThreadDraft({
  phone, digits, triggerBody, origin, dryRun,
  groundedCustomerId = null, groundedConflict = false, groundedScope = null,
  groundedMultiScope = false, groundedOvercap = false,
  groundedUnverifiableLocality = false,
  supersedeEstimateId = null, supersedeReason = null,
}) {
  const result = { phone: `…${digits.slice(-4)}`, lane: null, created: false, skipped: null };
  try {
    const { buildSmsThreadContext } = require('./context-builder');
    const { runDraftPipeline, notify } = require('./index');
    const context = await buildSmsThreadContext({
      phone,
      triggerBody,
      groundedCustomerId,
      groundedConflict,
      groundedScope,
      groundedMultiScope,
      groundedOvercap,
      groundedUnverifiableLocality,
    });
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
    // A clarify reply re-draft names the stale draft it replaces; the
    // draft builder retires it atomically with the replacement insert.
    if (supersedeEstimateId) {
      context.supersedeEstimateId = supersedeEstimateId;
      context.supersedeReason = supersedeReason || null;
    }
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
async function startSmsThreadDraft({
  phone, triggerBody = '', skipIntentGate = false, skipCooldown = false, dryRun = false,
  scopeCheckOnly = false, precomputedTriage,
  // Clarify-reply re-draft: the unsent automated draft this thread draft
  // replaces (retired inside the dedupe transaction, only on a real insert).
  supersedeEstimateId = null, supersedeReason = null,
}) {
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
    // Scope guards run for EVERY entry path — including clarify-reply
    // resumes (skipIntentGate), which bypass only the redundant
    // quote-intent classifier. A customer answering a clarify question
    // with "power washing" must not mint an owed-quote bell just because
    // quote intent was established earlier in the flow.
    const {
      scopeGuardsEnabled, deterministicOutOfScope, outOfScopeIsIncidental, loadThreadTriageContext,
    } = require('./scope-guards');
    const guarded = scopeGuardsEnabled();
    // precomputedTriage (lead-intake): a scopeCheckOnly pre-check already
    // ran the FULL veto ladder on THIS EXACT body and returned its triage
    // (result.triage). Re-running the ladder would double the awaited
    // webhook latency (triage 1.2s + classifier 3.5s, twice) for identical
    // verdicts — so a prechecked call reuses the triage and skips the
    // scope vetoes wholesale. Only callers that just ran the pre-check may
    // pass this.
    const prechecked = precomputedTriage !== undefined;
    // ORDERING: the cheap trigger-only veto runs BEFORE the cooldown. A
    // terminal scope decision must be reported terminally even inside the
    // cooldown window — 'cooldown' reads as operational to lead-intake,
    // whose shell fallback would then draft the out-of-scope work anyway.
    // Only the trigger-body veto runs here (zero DB); the burst veto needs
    // the triage fetch and stays after the cooldown return.
    // The veto defers for INCIDENTAL mentions ("I just had the house
    // pressure washed; how much do you charge for quarterly service?") —
    // the grounded classifier, which knows the catalog, is the precise
    // gate for those.
    if (guarded && !prechecked
      && deterministicOutOfScope(triggerBody) && !outOfScopeIsIncidental(triggerBody)) {
      result.skipped = 'out_of_scope_service';
      // TERMINAL: a scope decision, not an operational failure. Callers
      // that fall back on a failed handoff (lead-intake's shell path) must
      // NOT create an estimate and alert the owner for work Waves does not
      // do — see engineDraftHandoff in services/lead-intake.js.
      result.terminal = true;
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
    if (!dryRun && !skipCooldown && !scopeCheckOnly) {
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
    // Grounding for the classifier (fail-open → ungrounded prompt); a
    // prechecked call reuses the pre-check's triage (may be null — that IS
    // the pre-check's fail-open outcome, reused as-is).
    const triage = guarded
      ? (prechecked ? precomputedTriage : await loadThreadTriageContext({ phone, triggerBody }))
      : null;
    // Second deterministic pass over the CURRENT exchange only: "Do you
    // do power washing?" followed minutes later by "How much?" — the ask
    // and the service live in different texts. vetoTexts is burst-scoped
    // (VETO_BURST_MINUTES) so a stale out-of-scope mention from an older
    // conversation can't hard-kill a new valid request; the grounded
    // classifier still sees the full recent thread and judges stale
    // context itself.
    // A CORRECTION anywhere after the last out-of-scope mention wins.
    // "Do you do power washing?" → "Actually, quarterly service instead"
    // → "How much?" — the correction may be the trigger OR an earlier
    // burst message (one that failed the quote-hint prefilter and was
    // never processed on its own). The burst is newest-first, so messages
    // NEWER than the newest out-of-scope mention are the slice before it;
    // any of them reading as a correction hands the judgment to the
    // grounded classifier (which sees the full labeled thread). A bare
    // follow-up with no correction anywhere still vetoes — same request.
    const correctedSinceOos = (() => {
      if (!guarded || !(triage?.vetoTexts || []).length) return false;
      const vetoSeq = [String(triggerBody || ''), ...triage.vetoTexts];
      const newestOosIdx = vetoSeq.findIndex((t) => deterministicOutOfScope(t));
      return newestOosIdx > 0 && vetoSeq.slice(0, newestOosIdx).some((t) => CORRECTION_RE.test(t));
    })();
    if (guarded && (triage?.vetoTexts || []).length && correctedSinceOos) {
      logger.info('[estimator-sms] burst veto skipped — a correction follows the out-of-scope mention');
    } else if (guarded && !prechecked && (triage?.vetoTexts || []).length
      && deterministicOutOfScope([triggerBody, ...triage.vetoTexts].join('\n'))
      && !outOfScopeIsIncidental([triggerBody, ...triage.vetoTexts].join('\n'))) {
      result.skipped = 'out_of_scope_service_thread';
      result.terminal = true;
      return result;
    }
    if (!skipIntentGate) {
      const signal = await threadQuoteSignal(triggerBody, triage);
      if (!signal.quoteRequest) {
        result.skipped = `no_quote_intent_${signal.method}`;
        return result;
      }
    } else if (guarded && triage && !prechecked) {
      // Clarify resumes established quote intent earlier, but the reply
      // itself can name out-of-scope work in MIXED vocabulary ("power wash
      // my yard") that defeats the deterministic veto above ('yard' is
      // in-scope). Run the grounded classifier anyway and honor ONLY its
      // explicit scope vetoes. The fail direction here is deliberately
      // OPEN — the primary path fails CLOSED on classifier trouble because
      // a false positive mints an unretractable owed-quote bell, but on a
      // resume the quote is ALREADY owed, so ai_failed / malformed /
      // low-confidence outcomes proceed instead of silently dropping an
      // established request. hintGate off: resume replies rarely carry
      // quote vocabulary, and the prefilter would hide them from the veto.
      const signal = await threadQuoteSignal(triggerBody, triage, { hintGate: false });
      if (signal.method === 'ai_out_of_scope' || signal.method === 'ai_existing_job') {
        result.skipped = `no_quote_intent_${signal.method}`;
        // Terminal for the same reason as the deterministic vetoes: the
        // grounded classifier decided this is not quotable work, so a
        // caller's legacy fallback must not draft it anyway.
        result.terminal = true;
        return result;
      }
    }
    // scopeCheckOnly (lead-intake's open-shell branch): every scope veto
    // above has had its chance — the caller only needed the terminal
    // decision, not a bell or draft. The legacy shell patch may proceed.
    if (scopeCheckOnly) {
      result.skipped = 'scope_check_only';
      // The triage rides back so the caller can thread it into the real
      // run (precomputedTriage) instead of paying the ladder twice.
      result.triage = triage;
      return result;
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
    result.draftPromise = runThreadDraft({
      phone,
      digits,
      triggerBody,
      origin,
      dryRun,
      // Gate off ⇒ triage never ran ⇒ null/false flow and the context
      // build is byte-identical to today.
      groundedCustomerId: triage?.groundedCustomerId || null,
      groundedConflict: triage?.groundedConflict === true,
      groundedScope: triage?.groundedScope || null,
      groundedMultiScope: triage?.groundedMultiScope === true,
      groundedOvercap: triage?.groundedOvercap === true,
      groundedUnverifiableLocality: triage?.groundedUnverifiableLocality === true,
      supersedeEstimateId,
      supersedeReason,
    })
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

/**
 * SMS Shadow Drafter — house-voice, draft-only engine for inbound customer SMS.
 *
 * Writes what the AI *would have* replied into message_drafts with
 * status='shadow' — never sends, never alerts, never surfaces in the
 * pending-approval queue (admin-drafts lists status='pending' and its
 * approve/revise routes require status='pending'). Each shadow row is a
 * (customer message, AI draft) pair that a later judge pass scores against
 * the reply a human actually sent — the data flywheel for SMS auto-reply
 * graduation, per intent class.
 *
 * Phase D: intents flipped to 'suggest' (sms_intent_modes) get
 * status='suggested' instead and surface as an Agent Review card in the
 * comms composer via sms-suggest-mode. Still never sends — a human reads,
 * optionally edits, and presses Send.
 *
 * Single Claude call, no tool loop: context arrives pre-aggregated from
 * ContextAggregator (services, billing, SMS history). Actions the live
 * assistant would have taken (escalate, book, payment link) are captured
 * declaratively in the JSON response — never executed.
 *
 * PII: never log message bodies or full phone numbers from this module.
 */
const MODELS = require('../config/models');
const db = require('../models/db');
const logger = require('./logger');
const { CUSTOMER_SMS_HOUSE_VOICE } = require('./ai-assistant/managed-agent-config');

const DRAFTER = 'house_voice';
// v6 (06-13): DATA GROUNDING. Verifier sharpening plateaued at ~13-16%
// (v4≈v5) — the residual is the drafter inventing schedule facts (dates,
// arrival windows, tech names) it was never given. v6 surfaces the REAL
// upcoming schedule with arrival window + assigned tech in the facts block
// (UPCOMING SERVICES), so the drafter can state them instead of inventing
// and the verifier can validate them. LIVE-only effect: backfill context is
// drifted (today's schedule on old inbounds), so this is not backfill-
// measurable — it improves real drafts that feed suggest mode.
const PROMPT_VERSION = 'house_voice_v6';
const SHADOW_STATUS = 'shadow';

const INTENDED_ACTION_TYPES = [
  'none',
  'escalate',
  'book_appointment',
  'send_payment_link',
  'send_portal_link',
  'send_estimate_link',
];

function buildSystemPrompt() {
  return `You are the Waves Pest Control AI assistant drafting an SMS reply to a customer in Southwest Florida. This draft is for INTERNAL EVALUATION ONLY — it will never be sent. Draft exactly what you would send if you were live.

${CUSTOMER_SMS_HOUSE_VOICE}

FACT DISCIPLINE — the single most important rule. A fabricated detail is the worst error you can make, worse than a plain reply. You may ONLY state facts that appear in the context block below (LAST SERVICE, UPCOMING SERVICES, BALANCE, ACCOUNT FLAGS, the thread). A plausible-sounding guess is still a fabrication. You must NEVER:
- State a specific day, date, time, or arrival window ("tomorrow", "Tuesday", "2 PM", "10–10:30am") unless it appears verbatim in UPCOMING SERVICES or the thread. If the customer asks when we're coming and no confirmed appointment is shown, do NOT name a time — say you'll confirm it and get right back to them.
- Name a technician, or say who is coming or on the way, unless UPCOMING SERVICES names the tech for that visit.
- Claim what a trap caught, what was found, or what was treated, unless the context states it.
- Assert a service cadence or frequency ("every other month") or treatment timing ("safe to water in 1–2 hours") that isn't in the context.
- Reference a billing event — a payment, an auto-pay attempt, a charge — that isn't shown in BALANCE.
When you lack a fact the customer needs, the BEST reply acknowledges warmly and says you'll confirm and follow up — that is correct and safe, not a failure, and often better than the answer a human gave. Record the gap in missing_info.

USE THE REAL FACTS when they ARE present: UPCOMING SERVICES lists each scheduled visit with its date, arrival window, and assigned tech when on file. If the customer asks when we're coming or who's coming and that visit's date / window / tech IS listed, answer with it directly and confidently — don't deflect to "I'll confirm" when the answer is right there. A line that says "no arrival window set" or "tech not yet assigned" means that detail genuinely isn't decided — say you'll confirm it; never fill it in.

ALSO:
- If the message warrants a human (cancellation, complaint, billing dispute, chemical/medical concern, legal threat), the reply should acknowledge warmly without resolving, and intended_actions must include {"type":"escalate"}.
- Each intended_actions entry's "type" must be one of: ${INTENDED_ACTION_TYPES.join(', ')}.
- If the message is a pure courtesy acknowledgement that warrants NO reply at all (e.g. "Thanks!", a bare "ok" closing the thread), set "reply" to "" and intended_actions to [{"type":"none","note":"no reply warranted"}]. But a short confirmation that answers a question we asked (a "yes" to a proposed time) DOES warrant a reply.

Respond with ONLY a JSON object, no prose, no code fences:
{
  "reply": "the SMS you would send",
  "intended_actions": [{"type": "escalate", "note": "optional short reason"}],
  "missing_info": "facts you needed but the context lacked, or null"
}`;
}

function formatEtDate(value) {
  if (!value) return '';
  try {
    // service_date / scheduled_date are Postgres DATE values — calendar
    // days, not instants. Reparsing one as an instant puts it at midnight
    // UTC, which formats in ET as the PREVIOUS day. Anchor date-only values
    // to noon instead (same idiom as the legacy drafter in twilio-webhook).
    // pg hands DATE columns over as Date objects at local midnight, so the
    // local calendar parts are the true day.
    const pad = (n) => String(n).padStart(2, '0');
    const dayString = value instanceof Date
      ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
      : String(value);
    const dateOnly = dayString.match(/^(\d{4}-\d{2}-\d{2})/);
    const date = dateOnly ? new Date(`${dateOnly[1]}T12:00:00`) : new Date(value);
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      timeZone: 'America/New_York',
    });
  } catch {
    return String(value || '');
  }
}

/**
 * The fact block the drafter may draw from — and the EXACT same block the
 * verifier checks the draft against, so the two agree on what counts as
 * "supported". Shared by buildUserPrompt and the verify loop.
 */
function buildFactsBlock(context) {
  const conversation = (context.smsHistory || [])
    .slice(0, 10)
    .reverse()
    .map((m) => `[${m.direction === 'inbound' ? 'CUSTOMER' : 'WAVES'}] ${m.body}`)
    .join('\n');

  const flagsSummary =
    (context.flags || []).map((f) => `${f.severity === 'high' ? 'HIGH' : 'warn'} ${f.type}: ${f.detail}`).join('\n') ||
    'No flags.';

  const lastService = context.lastService
    ? `${context.lastService.type} on ${formatEtDate(context.lastService.date)} — "${(context.lastService.notes || '').slice(0, 150)}"`
    : 'None';

  // v6 data grounding: surface the FULL upcoming schedule (up to 3) with the
  // real arrival window and ASSIGNED TECH on each — the exact facts the
  // drafter used to invent ("Tuesday 2 PM", "Adam's on the way"). Each line
  // states only what's on file; a blank window or tech is shown as such so
  // the drafter (and the verifier) know it's genuinely unknown, not omitted.
  const upcoming = (context.upcomingServices || []).filter((s) => s && s.date);
  const upcomingBlock = upcoming.length
    ? upcoming
        .map((s) => {
          const parts = [`${s.type} on ${formatEtDate(s.date)}`];
          parts.push(s.window ? `window ${s.window}` : 'no arrival window set');
          parts.push(s.tech ? `tech ${s.tech}` : 'tech not yet assigned');
          return `- ${parts.join(', ')}`;
        })
        .join('\n')
    : 'Nothing scheduled';

  const balance =
    context.billing?.outstandingBalance > 0
      ? `$${Number(context.billing.outstandingBalance).toFixed(2)} outstanding`
      : 'Current';

  return `CUSTOMER: ${context.summary}

LAST SERVICE: ${lastService}
UPCOMING SERVICES:
${upcomingBlock}
BALANCE: ${balance}
ACCOUNT FLAGS:
${flagsSummary}

RECENT SMS THREAD:
${conversation || '(no recent thread)'}`;
}

function buildUserPrompt(context, inboundMessage, intent, schedulingIntent) {
  return `${buildFactsBlock(context)}

CLASSIFIED INTENT: ${intent?.intent || 'GENERAL'}${schedulingIntent ? ' (scheduling-intent detected — be especially careful to only state schedule facts present above)' : ''}

The facts above are the ONLY ones you have. If answering needs a detail that isn't shown — an exact time, a tech name, what was found, a billing event — do not invent it; say you'll confirm and follow up.

NEW INBOUND MESSAGE: "${inboundMessage}"

Draft the reply JSON now.`;
}

// Verify loop tunables. SHADOW_DRAFT_VERIFY=false reverts to single-pass
// (the pre-v3 drafter) as a kill switch; max revisions is bounded so a
// stubborn draft can't loop forever (default 2 → up to 3 generations and 3
// verifies, mirroring the blog convergence loop's "3 passes").
const VERIFY_ENABLED = process.env.SHADOW_DRAFT_VERIFY !== 'false';
const MAX_REVISIONS = (() => {
  const n = Number(process.env.SHADOW_DRAFT_VERIFY_MAX_REVISIONS);
  return Number.isInteger(n) && n >= 0 && n <= 4 ? n : 2;
})();

async function generateDraftOnce(client, system, userContent) {
  const resp = await client.messages.create({
    model: MODELS.FLAGSHIP,
    max_tokens: 600,
    system,
    messages: [{ role: 'user', content: userContent }],
  });
  return parseShadowResponse(resp.content?.[0]?.text || '');
}

/**
 * Draft → verify → revise convergence loop. Generates a draft, then runs the
 * adversarial verifier; if the draft asserts facts the context doesn't
 * support, feeds the violations back for a rewrite toward deferral, up to
 * MAX_REVISIONS times. Returns the final draft + loop telemetry
 * { parsed, passes, converged }. converged=true means the verifier signed
 * off (or the reply was empty — nothing to assert). Verify failures degrade
 * gracefully: keep the current draft, stop, converged=false — a verification
 * miss must never break drafting. Caller supplies the Anthropic client so
 * live + backfill share one implementation.
 */
async function generateGroundedDraft({ client, context, inboundMessage, intent, schedulingIntent }) {
  const system = buildSystemPrompt();
  const factsBlock = buildFactsBlock(context);
  const userContent = buildUserPrompt(context, inboundMessage, intent, schedulingIntent);

  let parsed = await generateDraftOnce(client, system, userContent);
  if (!parsed) return { parsed: null, passes: 1, converged: false };
  // Kill switch / single-pass mode: no verification claim, behave as pre-v3.
  if (!VERIFY_ENABLED) return { parsed, passes: 1, converged: true };

  const verifier = require('./sms-draft-verifier');
  let passes = 1;
  let converged = false;

  for (let attempt = 0; attempt <= MAX_REVISIONS; attempt += 1) {
    // An empty reply ("no reply warranted") asserts nothing — nothing to check.
    if (!parsed.reply) { converged = true; break; }

    let verdict;
    try {
      const vResp = await client.messages.create({
        model: verifier.VERIFIER_MODEL,
        max_tokens: 400,
        system: verifier.buildVerifierSystemPrompt(),
        messages: [{ role: 'user', content: verifier.buildVerifierUserPrompt(factsBlock, inboundMessage, parsed.reply) }],
      });
      verdict = verifier.parseVerifierResponse(vResp.content?.[0]?.text || '');
    } catch (err) {
      logger.warn(`[sms-shadow] verify pass failed (${err.message}); keeping current draft`);
      converged = false;
      break;
    }

    if (!verdict) { converged = false; break; } // unparseable verdict — stop, don't loop
    if (verdict.supported) { converged = true; break; }

    // Violations present. Out of revision budget → stop, not converged.
    converged = false;
    if (attempt === MAX_REVISIONS) break;

    let revised;
    try {
      revised = await generateDraftOnce(
        client,
        system,
        `${userContent}\n\n${verifier.buildReviseAddendum(verdict.violations)}`
      );
    } catch (err) {
      // A revise call that times out / rate-limits must NOT drop the whole
      // sample — we have a valid prior draft. Keep it (converged stays false
      // so it can't publish as a suggestion).
      logger.warn(`[sms-shadow] revise pass failed (${err.message}); keeping current draft`);
      break;
    }
    if (!revised) break; // revision unparseable — keep the prior draft
    parsed = revised;
    passes += 1;
  }

  return { parsed, passes, converged };
}

/**
 * Tolerant JSON extraction: accepts a bare object, fenced block, or an
 * object embedded in prose. Returns { reply, intended_actions, missing_info }
 * or null when no usable draft can be recovered.
 */
function parseShadowResponse(text) {
  if (!text || typeof text !== 'string') return null;
  let candidate = text.trim();

  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();

  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    candidate = candidate.slice(start, end + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  // Empty reply is a VALID draft: "no reply warranted" (courtesy acks).
  // Only a missing/non-string reply is unusable.
  if (!parsed || typeof parsed.reply !== 'string') return null;

  const intendedActions = Array.isArray(parsed.intended_actions)
    ? parsed.intended_actions
        .filter((a) => a && typeof a.type === 'string' && INTENDED_ACTION_TYPES.includes(a.type))
        .map((a) => ({ type: a.type, note: typeof a.note === 'string' ? a.note.slice(0, 200) : undefined }))
    : [];

  return {
    reply: parsed.reply.trim(),
    intended_actions: intendedActions,
    missing_info: typeof parsed.missing_info === 'string' ? parsed.missing_info.slice(0, 500) : null,
  };
}

/**
 * Generate and persist one shadow draft. Designed to be fire-and-forgotten
 * from the inbound webhook: all failures are caught, logged masked, and
 * recorded nowhere else — a shadow miss must never affect the live path.
 */
async function draftShadowReply({ inboundMessage, fromPhone, customer, smsLogId, intent, schedulingIntent = false }) {
  const startedAt = Date.now();
  try {
    const ContextAggregator = require('./context-aggregator');
    // The webhook already matched a single active customer (deleted_at +
    // shared-number protection) — build context from that row instead of
    // re-looking-up by phone, which could pick a different account.
    const context = customer
      ? await ContextAggregator.getContextForCustomer(customer)
      : await ContextAggregator.getFullCustomerContext(fromPhone);

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // v3: draft → adversarial fact-check → revise loop (generateGroundedDraft).
    const { parsed, passes, converged } = await generateGroundedDraft({
      client, context, inboundMessage, intent, schedulingIntent,
    });
    if (!parsed) {
      logger.warn(`[sms-shadow] unparseable draft response (customer ${customer?.id || 'unknown'}); dropping`);
      return null;
    }

    const intentName = intent?.intent || 'GENERAL';
    // Phase D/E: intents flipped to 'suggest' surface the draft as a composer
    // card; intents flipped to 'auto_send' (and that have earned the rung)
    // have it SENT to the customer automatically. Escalation intents,
    // scheduling-intent messages, and anything without a customer + inbound
    // link stay silent shadow.
    const suggestMode = require('./sms-suggest-mode');
    const deliveryMode = await suggestMode.resolveDeliveryMode({
      reply: parsed.reply,
      customerId: customer?.id || null,
      smsLogId: smsLogId || null,
      intent: intentName,
      schedulingIntent,
    });

    // ALWAYS insert as shadow: the flip to 'suggested' happens atomically
    // with the decision insert inside publishSuggestion's locked
    // transaction. A crash between this insert and the publish leaves a
    // plain shadow row the judge still covers — never a 'suggested' draft
    // with no composer card behind it.
    const [row] = await db('message_drafts')
      .insert({
        sms_log_id: smsLogId || null,
        customer_id: customer?.id || null,
        inbound_message: inboundMessage,
        draft_response: parsed.reply,
        intent: intentName,
        intent_confidence: intent?.confidence ?? null,
        context_summary: context.summary || null,
        flags: JSON.stringify(context.flags || []),
        status: SHADOW_STATUS,
        drafter: DRAFTER,
        model: MODELS.FLAGSHIP,
        prompt_version: PROMPT_VERSION,
        intended_actions: JSON.stringify({
          actions: parsed.intended_actions,
          missing_info: parsed.missing_info,
          verify: { passes, converged },
        }),
        scheduling_intent: Boolean(schedulingIntent),
        draft_ms: Date.now() - startedAt,
      })
      .returning('id');

    // Only verified-clean drafts (verify loop converged) may leave the silent
    // shadow lane — a draft still asserting unsupported facts after the
    // revision budget is never shown to a human OR sent to a customer; it
    // stays a shadow row the judge still covers.
    let deliveredAs = SHADOW_STATUS;
    if (row?.id && converged) {
      if (deliveryMode === suggestMode.AUTO_SEND_MODE) {
        const result = await require('./sms-auto-send').maybeAutoSend({
          draftId: row.id,
          customer,
          smsLogId,
          inboundMessage,
          reply: parsed.reply,
          intent: intentName,
          intendedActions: parsed.intended_actions,
          confidence: intent?.confidence ?? null,
          model: MODELS.FLAGSHIP,
          promptVersion: PROMPT_VERSION,
          schedulingIntent,
        });
        if (result?.sent) {
          deliveredAs = 'auto_sent';
        } else if (result?.reason === 'action_required') {
          // A verified draft that still needs a human action (escalate / send
          // a link / book) must reach a person — not auto-send, and not vanish
          // into silent shadow. Downgrade it one rung to a suggestion card.
          const decisionId = await suggestMode.publishSuggestion({
            draftId: row.id,
            customerId: customer.id,
            smsLogId,
            inboundMessage,
            reply: parsed.reply,
            intent: intentName,
            confidence: intent?.confidence ?? null,
            model: MODELS.FLAGSHIP,
            promptVersion: PROMPT_VERSION,
          });
          if (decisionId) deliveredAs = suggestMode.SUGGESTED_STATUS;
        }
      } else if (deliveryMode === 'suggest') {
        const decisionId = await suggestMode.publishSuggestion({
          draftId: row.id,
          customerId: customer.id,
          smsLogId,
          inboundMessage,
          reply: parsed.reply,
          intent: intentName,
          confidence: intent?.confidence ?? null,
          model: MODELS.FLAGSHIP,
          promptVersion: PROMPT_VERSION,
        });
        if (decisionId) deliveredAs = suggestMode.SUGGESTED_STATUS;
      }
    }

    logger.info(
      `[sms-shadow] draft stored: customer=${customer?.id || 'unknown'} intent=${intentName} status=${deliveredAs} passes=${passes} converged=${converged} actions=${parsed.intended_actions.map((a) => a.type).join(',') || 'none'} ms=${Date.now() - startedAt}`
    );
    return row?.id || null;
  } catch (err) {
    logger.error(`[sms-shadow] draft failed (customer ${customer?.id || 'unknown'}): ${err.message}`);
    return null;
  }
}

module.exports = {
  draftShadowReply,
  generateGroundedDraft,
  parseShadowResponse,
  buildSystemPrompt,
  buildUserPrompt,
  buildFactsBlock,
  DRAFTER,
  PROMPT_VERSION,
  SHADOW_STATUS,
  INTENDED_ACTION_TYPES,
};

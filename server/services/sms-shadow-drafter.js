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
const PROMPT_VERSION = 'house_voice_v1';
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

RULES:
- Never make up dates, prices, or tech names — only reference facts present in the provided context. If the context doesn't contain the fact you need, say what you'd naturally say while a human checks (e.g. "let me confirm the exact time and get right back to you") and list the gap in missing_info.
- If the message warrants a human (cancellation, complaint, billing dispute, chemical/medical concern, legal threat), the reply should acknowledge warmly without resolving, and intended_actions must include {"type":"escalate"}.
- Each intended_actions entry's "type" must be one of: ${INTENDED_ACTION_TYPES.join(', ')}.

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

function buildUserPrompt(context, inboundMessage, intent, schedulingIntent) {
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

  const nextService = context.upcomingServices?.[0]
    ? `${context.upcomingServices[0].type} ${formatEtDate(context.upcomingServices[0].date)}${context.upcomingServices[0].window ? ` ${context.upcomingServices[0].window}` : ''}`
    : 'Nothing scheduled';

  const balance =
    context.billing?.outstandingBalance > 0
      ? `$${Number(context.billing.outstandingBalance).toFixed(2)} outstanding`
      : 'Current';

  return `CUSTOMER: ${context.summary}

LAST SERVICE: ${lastService}
NEXT SERVICE: ${nextService}
BALANCE: ${balance}
ACCOUNT FLAGS:
${flagsSummary}

RECENT SMS THREAD:
${conversation || '(no recent thread)'}

CLASSIFIED INTENT: ${intent?.intent || 'GENERAL'}${schedulingIntent ? ' (scheduling-intent detected — be especially careful to only state schedule facts present above)' : ''}

NEW INBOUND MESSAGE: "${inboundMessage}"

Draft the reply JSON now.`;
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

  if (!parsed || typeof parsed.reply !== 'string' || !parsed.reply.trim()) return null;

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

    const resp = await client.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 600,
      system: buildSystemPrompt(),
      messages: [{ role: 'user', content: buildUserPrompt(context, inboundMessage, intent, schedulingIntent) }],
    });

    const raw = resp.content?.[0]?.text || '';
    const parsed = parseShadowResponse(raw);
    if (!parsed) {
      logger.warn(`[sms-shadow] unparseable draft response (customer ${customer?.id || 'unknown'}); dropping`);
      return null;
    }

    const [row] = await db('message_drafts')
      .insert({
        sms_log_id: smsLogId || null,
        customer_id: customer?.id || null,
        inbound_message: inboundMessage,
        draft_response: parsed.reply,
        intent: intent?.intent || 'GENERAL',
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
        }),
        scheduling_intent: Boolean(schedulingIntent),
        draft_ms: Date.now() - startedAt,
      })
      .returning('id');

    logger.info(
      `[sms-shadow] draft stored: customer=${customer?.id || 'unknown'} intent=${intent?.intent || 'GENERAL'} actions=${parsed.intended_actions.map((a) => a.type).join(',') || 'none'} ms=${Date.now() - startedAt}`
    );
    return row?.id || null;
  } catch (err) {
    logger.error(`[sms-shadow] draft failed (customer ${customer?.id || 'unknown'}): ${err.message}`);
    return null;
  }
}

module.exports = {
  draftShadowReply,
  parseShadowResponse,
  buildSystemPrompt,
  buildUserPrompt,
  DRAFTER,
  PROMPT_VERSION,
  SHADOW_STATUS,
  INTENDED_ACTION_TYPES,
};

/**
 * Completion comms context — F1 of the universal one-time services plan
 * (ratified 2026-07-12, Q13).
 *
 * ONE windowed builder for the "Include recent customer calls/texts/emails
 * in AI draft" context, replacing the two near-duplicate uncapped builders
 * (admin-projects getCustomerCommunicationContext, admin-dispatch
 * loadFindingsRecapCommsContext). Those pulled the customer's most-recent
 * 3 calls / 4 texts / 3 emails with NO date floor — a sparse-comms
 * customer's "recent" context could reach back a year (the exact owner
 * complaint the ratified windows fix).
 *
 * Window (ratified numbers):
 *  - RECURRING service: since the customer's last COMPLETED visit of the
 *    same service line (the inter-visit window), hard cap 120 days.
 *  - ONE-TIME / project: since the job's origin (estimate accepted_at →
 *    booking created_at → caller-supplied originDate), hard cap 180 days.
 *  - No resolvable anchor → the hard cap alone. Never uncapped
 *    most-recent-N: the floor is always applied; per-channel limits are a
 *    secondary size guard inside the window.
 *
 * Floors are real Date objects passed to knex (waves-db §2 — never naive
 * ISO strings), and the caps are ROLLING windows from now, not calendar-day
 * boundaries, so there is no ET/UTC day-edge to leak.
 *
 * Service relevance v1 (ratified): window + a service-line hint for the
 * prompt with an explicit "ignore unrelated topics" instruction — NOT a
 * hard keyword prefilter (which would drop "ants in the kitchen" texts that
 * never name the service). Drafts stay tech-reviewed.
 */

const db = require('../models/db');
const logger = require('./logger');
const { detectServiceLine } = require('./service-report/service-line-configs');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { stripQuotedAndSignature } = require('./email/email-strip');
const ContextAggregator = require('./context-aggregator');

const { redactAccessCodes } = ContextAggregator;

const RECURRING_CAP_DAYS = 120;
const ONE_TIME_CAP_DAYS = 180;
const MAX_CONTEXT_LINES = 8;

function compactText(value, max = 280) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3).trim()}...` : text;
}

function contextDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function contextTs(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function asDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve the context window floor for a completion.
 *
 * @returns {{ floor: Date, reason: string, serviceLine: string|null,
 *   isRecurring: boolean }}
 */
async function resolveContextWindow({
  customerId,
  scheduledServiceId = null,
  originDate = null,
  knex = db,
}) {
  let svc = null;
  if (scheduledServiceId) {
    svc = await knex('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('id', 'customer_id', 'service_type', 'service_id', 'recurring_parent_id', 'is_recurring', 'source_estimate_id', 'created_at', 'scheduled_date')
      .catch(() => null);
  }
  const serviceLine = svc ? detectServiceLine(svc.service_type) : null;

  // Recurring vs one-time: the catalog profile's billing type is the truth
  // when resolvable; a recurring_parent_id chain is recurring by
  // construction. Fail toward one-time (the wider 180d window with a job
  // origin still beats the old unbounded behavior).
  let isRecurring = false;
  if (svc) {
    // Parent rows of a recurring series carry is_recurring with a null
    // recurring_parent_id (Codex r3) — both shapes are recurring by
    // construction before the profile is even consulted.
    if (svc.recurring_parent_id || svc.is_recurring === true) {
      isRecurring = true;
    } else {
      try {
        const { resolveCompletionProfileForScheduledService } = require('./service-completion-profiles');
        const profile = await resolveCompletionProfileForScheduledService(svc, knex);
        isRecurring = String(profile?.billingType || '').toLowerCase() === 'recurring';
      } catch (err) {
        logger.warn(`[comms-context] profile resolution failed (${err.message}) — treating as one-time`);
      }
    }
  }

  if (isRecurring) {
    const cap = daysAgo(RECURRING_CAP_DAYS);
    // Last completed visit of the SAME service line before this visit.
    // service_type stores display names, so line-match happens in JS over a
    // small recent set (waves-db: names, not keys, live on the rows).
    let lastVisit = null;
    try {
      let query = knex('scheduled_services')
        .where({ customer_id: customerId, status: 'completed' })
        .whereNot({ id: svc.id })
        // Bound by the cap instead of an arbitrary row limit (Codex r2):
        // a match older than the cap loses to the cap anyway, and limiting
        // BEFORE the JS line-filter could miss the true prior same-line
        // visit behind >N other-line completions.
        .where('scheduled_date', '>=', cap);
      // Drafting a HISTORICAL visit must anchor to the last completion
      // BEFORE that visit — the customer's most recent completion overall
      // could postdate it and move the floor past the drafted visit
      // (Codex r1).
      const svcDate = asDate(svc.scheduled_date);
      if (svcDate) query = query.where('scheduled_date', '<', svcDate);
      const recent = await query
        .orderBy('scheduled_date', 'desc')
        .limit(200)
        .select('service_type', 'scheduled_date', 'completed_at');
      lastVisit = recent.find((row) => detectServiceLine(row.service_type) === serviceLine) || null;
    } catch (err) {
      logger.warn(`[comms-context] last-visit lookup failed: ${err.message}`);
    }
    // Anchor at COMPLETION time when recorded (Codex r2): scheduled_date is
    // a midnight date, so pre/during-visit coordination chatter from that
    // day would leak into the next draft; legacy rows without completed_at
    // fall back to the schedule date.
    const lastDate = asDate(lastVisit?.completed_at) || asDate(lastVisit?.scheduled_date);
    if (lastDate && lastDate > cap) {
      return { floor: lastDate, reason: `since the last completed ${serviceLine || 'service'} visit (${contextDate(lastDate)})`, serviceLine, isRecurring };
    }
    return { floor: cap, reason: `last ${RECURRING_CAP_DAYS} days`, serviceLine, isRecurring };
  }

  // One-time: job origin = estimate accepted_at → booking created_at →
  // caller-supplied origin (projects pass their created_at).
  const cap = daysAgo(ONE_TIME_CAP_DAYS);
  let origin = null;
  let originLabel = null;
  if (svc?.source_estimate_id) {
    try {
      const est = await knex('estimates')
        .where({ id: svc.source_estimate_id })
        .first('accepted_at');
      // accepted_at ONLY (Codex P2): an unaccepted/legacy estimate's
      // creation time is pre-booking chatter — fall through to the
      // booking's created_at instead.
      origin = asDate(est?.accepted_at);
      if (origin) originLabel = `since the estimate was accepted (${contextDate(origin)})`;
    } catch (err) {
      logger.warn(`[comms-context] estimate origin lookup failed: ${err.message}`);
    }
  }
  if (!origin && svc) {
    origin = asDate(svc.created_at);
    if (origin) originLabel = `since the booking (${contextDate(origin)})`;
  }
  if (!origin && originDate) {
    origin = asDate(originDate);
    if (origin) originLabel = `since the job was opened (${contextDate(origin)})`;
  }
  if (origin && origin > cap) {
    return { floor: origin, reason: originLabel, serviceLine, isRecurring };
  }
  return { floor: cap, reason: `last ${ONE_TIME_CAP_DAYS} days`, serviceLine, isRecurring };
}

/**
 * Build the compact comms-context block for an AI draft.
 *
 * @returns {{ text: string, floor: Date, reason: string,
 *   serviceLine: string|null, promptHint: string }} text is '' when the
 *   window holds nothing.
 */
async function buildCompletionCommsContext({
  customerId,
  scheduledServiceId = null,
  originDate = null,
  knex = db,
} = {}) {
  if (!customerId) return { text: '', floor: null, reason: '', serviceLine: null, promptHint: '' };
  const { floor, reason, serviceLine } = await resolveContextWindow({
    customerId, scheduledServiceId, originDate, knex,
  });

  const [calls, sms, emails] = await Promise.all([
    knex('call_log')
      .where({ customer_id: customerId })
      .where('created_at', '>=', floor)
      .select('created_at', 'direction', 'call_outcome', 'lead_synopsis', 'transcription', 'notes')
      .orderBy('created_at', 'desc')
      .limit(6)
      .catch((err) => {
        logger.warn(`[comms-context] call context unavailable: ${err.message}`);
        return [];
      }),
    // codex #4331 P2 (structural pass): an unresolved review-ask
    // reservation must not read as a delivered message in this context.
    excludeUnresolvedSendReservations(knex('sms_log')
      .where({ customer_id: customerId }))
      .where('created_at', '>=', floor)
      .select('created_at', 'direction', 'message_body', 'message_type')
      .orderBy('created_at', 'desc')
      .limit(8)
      .catch((err) => {
        logger.warn(`[comms-context] sms context unavailable: ${err.message}`);
        return [];
      }),
    knex('emails')
      .where({ customer_id: customerId })
      .where('received_at', '>=', floor)
      .select('received_at', 'subject', 'snippet', 'body_text')
      .orderBy('received_at', 'desc')
      .limit(6)
      .catch((err) => {
        logger.warn(`[comms-context] email context unavailable: ${err.message}`);
        return [];
      }),
  ]);

  const entries = [];
  for (const call of calls) {
    const summary = compactText(call.lead_synopsis || call.notes || call.transcription);
    if (summary) {
      entries.push({
        ts: contextTs(call.created_at),
        line: `Call ${contextDate(call.created_at)} (${call.direction || 'unknown'}${call.call_outcome ? `, ${call.call_outcome}` : ''}): ${summary}`,
      });
    }
  }
  for (const msg of sms) {
    const summary = compactText(msg.message_body, 260);
    if (summary) {
      entries.push({
        ts: contextTs(msg.created_at),
        line: `Text ${contextDate(msg.created_at)} (${msg.direction || 'unknown'}${msg.message_type ? `, ${msg.message_type}` : ''}): ${summary}`,
      });
    }
  }
  for (const email of emails) {
    const summary = compactText(email.snippet || email.body_text, 260);
    const subject = compactText(email.subject, 120);
    if (summary || subject) {
      entries.push({
        ts: contextTs(email.received_at),
        line: `Email ${contextDate(email.received_at)}${subject ? ` "${subject}"` : ''}: ${summary || '[no body preview]'}`,
      });
    }
  }

  const text = entries
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_CONTEXT_LINES)
    .map((entry) => entry.line)
    .join('\n');

  // Ratified relevance rule: window + prompt hint, never a keyword filter.
  const promptHint = serviceLine
    ? `These are the customer's recent communications (${reason}). Use only what is relevant to this ${serviceLine} visit; ignore unrelated topics.`
    : `These are the customer's recent communications (${reason}). Use only what is relevant to this visit; ignore unrelated topics.`;

  return { text, floor, reason, serviceLine, promptHint };
}

// ---------------------------------------------------------------------------
// GATE_REPORT_WRITER_RULES: what the customer told us, for the report writer.
// Same window as above, but only the customer's own words: inbound texts and
// emails, and call summaries labeled by who called (a summary covers both
// sides of the call). Waves' own texts and mail never appear, and every line
// is scrubbed before it is cut, since the writer turns these into "You
// mentioned…" copy.

// Credential-shaped tokens (the redactor's 3+ digit codes, all-caps word
// codes), masked outright wherever the context that would anchor them is gone.
function maskCredentialShapes(text) {
  return String(text || '').replace(/\d{3,}/g, '[redacted]').replace(/\b[A-Z]{3,}\b/g, '[redacted]');
}
// Words that name a credential anywhere in an email.
const CREDENTIAL_ANCHOR_RE = /\b(?:gate|codes?|lock\s*box(?:es)?|alarm|keypad|pins?|pass(?:code|word)s?|combo|combination)\b/i;

// A mailbox copy of something Waves sent (Gmail SENT label or a Waves
// address). The query already leaves these out; this guards the lines.
function wavesSentEmail(email) {
  const labels = Array.isArray(email?.label_ids) ? email.label_ids : [];
  return labels.includes('SENT') || /@wavespestcontrol\.com\s*>?\s*$/i.test(String(email?.from_address || ''));
}

// Only what the customer wrote (quoted history and signature stripped, so a
// quoted Waves promise is never read as theirs), redacted over the whole of
// it before the preview is cut. A bare reply can answer a credential
// question the strip removed ("What is the gate code?" → "4821"), and a
// snippet with no body has lost its context: then anything credential-shaped
// is masked outright.
function customerEmailText(email) {
  const body = String(email.body_text || '').trim();
  const text = body || String(email.snippet || '');
  const own = redactAccessCodes(stripQuotedAndSignature(text));
  return compactText(!body || CREDENTIAL_ANCHOR_RE.test(text) ? maskCredentialShapes(own) : own, 260);
}

const CALLER = { inbound: 'the customer called', outbound: 'Waves called the customer' };

// One entry per channel: its query, which rows count, how many are kept,
// and its line. Every line is scrubbed; texts and subjects are also masked
// for bare codes, because the Waves message they answer is left out.
const CUSTOMER_WORDS_CHANNELS = Object.freeze([
  {
    name: 'call',
    // The canonical call reader's exclusions (context-aggregator
    // getRecentCalls): caller-ID linkage happens before classification, so
    // sandbox, spam and wrong-number calls can carry this customer's id. The
    // whole bounded window is read and extraction-classified misdials are
    // dropped before six are kept, so they never use up the pick.
    read: (knex, customerId, floor) => whereNotSandboxCall(knex('call_log')
      .where({ customer_id: customerId })
      .where('created_at', '>=', floor))
      .where((q) => q.whereNull('call_outcome').orWhereNotIn('call_outcome', ['wrong_number', 'spam']))
      .select('created_at', 'direction', 'lead_synopsis', 'notes', 'processing_status', 'ai_extraction', 'ai_extraction_enriched', 'v2_extraction_status')
      .orderBy('created_at', 'desc')
      .limit(50),
    keep: (row) => !ContextAggregator.isExcludedCall(row),
    max: 6,
    // A raw transcript mixes both speakers, so only the summary or notes.
    line: (row) => {
      const summary = compactText(redactAccessCodes(row.lead_synopsis || row.notes || ''));
      return summary && `Call ${contextDate(row.created_at)} (${CALLER[row.direction] || 'caller unknown'}; AI summary of the whole conversation, not verified): ${summary}`;
    },
    ts: (row) => row.created_at,
  },
  {
    name: 'sms',
    read: (knex, customerId, floor) => excludeUnresolvedSendReservations(knex('sms_log')
      .where({ customer_id: customerId }))
      .where('created_at', '>=', floor)
      .where('direction', 'inbound')
      .select('created_at', 'direction', 'message_body')
      .orderBy('created_at', 'desc')
      .limit(8),
    keep: (row) => row.direction === 'inbound',
    max: 8,
    line: (row) => {
      const summary = compactText(maskCredentialShapes(redactAccessCodes(row.message_body)), 260);
      return summary && `Customer text ${contextDate(row.created_at)}: ${summary}`;
    },
    ts: (row) => row.created_at,
  },
  {
    name: 'email',
    read: (knex, customerId, floor) => knex('emails')
      .where({ customer_id: customerId })
      .where('received_at', '>=', floor)
      .whereRaw("NOT (COALESCE(label_ids, '[]'::jsonb) @> '[\"SENT\"]'::jsonb)")
      .whereRaw("COALESCE(from_address, '') NOT ILIKE '%@wavespestcontrol.com%'")
      .select('received_at', 'subject', 'snippet', 'body_text', 'from_address', 'label_ids')
      .orderBy('received_at', 'desc')
      .limit(6),
    keep: (row) => !wavesSentEmail(row),
    max: 6,
    line: (row) => {
      const summary = customerEmailText(row);
      const subject = compactText(maskCredentialShapes(redactAccessCodes(row.subject)), 120);
      return (summary || subject) && `Customer email ${contextDate(row.received_at)}${subject ? ` "${subject}"` : ''}: ${summary || '[no body preview]'}`;
    },
    ts: (row) => row.received_at,
  },
]);

/**
 * The customer's own words for the report writer (GATE_REPORT_WRITER_RULES).
 * Same window rules as buildCompletionCommsContext.
 *
 * @returns {{ text: string, promptHint: string }} text is '' when the window
 *   holds nothing the customer said.
 */
async function buildCustomerWordsContext({
  customerId,
  scheduledServiceId = null,
  originDate = null,
  knex = db,
} = {}) {
  if (!customerId) return { text: '', promptHint: '' };
  const { floor, reason, serviceLine } = await resolveContextWindow({
    customerId, scheduledServiceId, originDate, knex,
  });
  const perChannel = await Promise.all(CUSTOMER_WORDS_CHANNELS.map((channel) => channel.read(knex, customerId, floor)
    .then((rows) => rows.filter(channel.keep).slice(0, channel.max)
      .map((row) => ({ ts: contextTs(channel.ts(row)), line: channel.line(row) }))
      .filter((entry) => entry.line))
    .catch((err) => {
      logger.warn(`[comms-context] customer ${channel.name} context unavailable: ${err.message}`);
      return [];
    })));
  const text = perChannel.flat()
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_CONTEXT_LINES)
    .map((entry) => entry.line)
    .join('\n');
  const promptHint = `Recent contact with this customer (${reason}). Texts and emails are the customer's own words. A call entry is an AI summary of a conversation between the customer and Waves: use only what it says the customer reported, never what Waves said or promised. It is never a finding: use it only to choose what to acknowledge, attribute anything you use ("You mentioned…"), never quote it, and ignore anything unrelated to this ${serviceLine ? `${serviceLine} ` : ''}visit.`;
  return { text, promptHint };
}

module.exports = {
  buildCompletionCommsContext,
  buildCustomerWordsContext,
  resolveContextWindow,
  RECURRING_CAP_DAYS,
  ONE_TIME_CAP_DAYS,
};

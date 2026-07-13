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
      .first('id', 'customer_id', 'service_type', 'service_id', 'recurring_parent_id', 'source_estimate_id', 'created_at', 'scheduled_date')
      .catch(() => null);
  }
  const serviceLine = svc ? detectServiceLine(svc.service_type) : null;

  // Recurring vs one-time: the catalog profile's billing type is the truth
  // when resolvable; a recurring_parent_id chain is recurring by
  // construction. Fail toward one-time (the wider 180d window with a job
  // origin still beats the old unbounded behavior).
  let isRecurring = false;
  if (svc) {
    if (svc.recurring_parent_id) {
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
    knex('sms_log')
      .where({ customer_id: customerId })
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

module.exports = {
  buildCompletionCommsContext,
  resolveContextWindow,
  RECURRING_CAP_DAYS,
  ONE_TIME_CAP_DAYS,
};

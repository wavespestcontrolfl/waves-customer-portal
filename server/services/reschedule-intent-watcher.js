'use strict';

// Daily owner exception email: reschedule/away texts that nothing acted on.
//
// The real-time half (reschedule-intent-flagger.js) writes an agent_decisions
// row and rings a bell the moment the text arrives. This watcher is the
// backstop: every morning it lists flags from the last few days whose linked
// visit is STILL armed and untouched — i.e. the request has not produced any
// schedule change. Exception-based per the hands-off rule: a quiet window
// sends nothing, ever.
//
// Subject grammar follows the ops-email convention (first word = the owner's
// action): ACT because each line needs a human reply/reschedule decision.
// Live by default with a kill switch (RESCHEDULE_INTENT_WATCHER_DISABLED=1).
// Cron wiring: daily 6:55am ET in scheduler.js, inside runExclusive.

const sendgrid = require('./sendgrid-mail');
const logger = require('./logger');
const db = require('../models/db');
const { isInternalEmailRecipient } = require('../utils/internal-email-recipients');

const watcherDisabled = () => ['1', 'true', 'on']
  .includes(String(process.env.RESCHEDULE_INTENT_WATCHER_DISABLED || '').toLowerCase());
const watcherEmail = () => process.env.RESCHEDULE_INTENT_WATCHER_EMAIL || 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';
const adminPortalUrl = () => (process.env.ADMIN_PORTAL_URL || 'https://portal.wavespestcontrol.com').replace(/\/+$/, '');

const LOOKBACK_DAYS = 4;
// Outbound types that count as a human answer to a waiting customer —
// automated broadcasts (reminders, receipts, review asks) do not.
const HUMAN_REPLY_TYPES = ['manual', 'estimate_sent', 'invoice', 'voicemail_quote_link', 'appointment_rescheduled', 'confirmation', 'reschedule_series_confirmation'];
const MAX_ROWS = 12;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Flags whose linked visit is still upcoming AND has not been touched since
// the flag was created (updated_at predates the flag = nobody rescheduled,
// cancelled, or otherwise moved it). Flags with no linked visit are included
// too — "no upcoming visit" still means the customer is waiting on a reply.
async function loadUnactionedFlags() {
  return db('agent_decisions as ad')
    .leftJoin('scheduled_services as ss', 'ad.entity_id', 'ss.id')
    .leftJoin('customers as cu', 'ad.customer_id', 'cu.id')
    .where('ad.workflow', 'comms_guards')
    .where('ad.detected_intent', 'reschedule_or_away_needs_review')
    .where('ad.created_at', '>=', db.raw(`now() - interval '${LOOKBACK_DAYS} days'`))
    .where(function stillUnactioned() {
      this.where(function noVisitStillUnanswered() {
        // No linked visit: the customer is waiting on a REPLY — the flag
        // drops once any human-initiated outbound went to them after it
        // (codex r1: it otherwise recurs every morning for the lookback).
        this.whereNull('ad.entity_id').whereNotExists(function humanReply() {
          this.select(1).from('sms_log as sl')
            .whereRaw('sl.customer_id = ad.customer_id')
            .where('sl.direction', 'outbound')
            .whereIn('sl.message_type', HUMAN_REPLY_TYPES)
            .whereRaw('sl.created_at > ad.created_at');
        });
      }).orWhere(function visitUnchanged() {
        // Linked visit: unactioned = still upcoming AND still on the
        // flagged slot, judged against the flag's own snapshot — NOT
        // updated_at, which the public rebooker does not bump (codex r1).
        this.whereIn('ss.status', ['pending', 'confirmed', 'en_route', 'on_site'])
          .whereRaw("LEFT(ad.input_snapshot#>>'{visit,scheduled_date}', 10) = ss.scheduled_date::text")
          .whereRaw("COALESCE(ad.input_snapshot#>>'{visit,window_start}', '') = COALESCE(ss.window_start::text, '')");
      });
    })
    .orderBy('ad.created_at', 'asc')
    .limit(MAX_ROWS)
    .select(
      'ad.id', 'ad.created_at', 'ad.input_snapshot', 'ad.customer_id',
      'cu.first_name', 'cu.last_name',
      'ss.scheduled_date', 'ss.window_start', 'ss.service_type', 'ss.status as visit_status',
    );
}

function snapshotExcerpt(snapshot) {
  if (!snapshot) return '';
  try {
    const parsed = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
    return String(parsed.body_excerpt || '');
  } catch {
    return '';
  }
}

// Pure composition: null = nothing worth an email (the common, quiet case).
function composeRescheduleIntentDigest(rows) {
  const flags = (rows || []).filter(Boolean);
  if (!flags.length) return null;

  const lines = flags.map((row) => {
    const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Unknown customer';
    const asked = String(row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at).slice(0, 10);
    const visit = row.scheduled_date
      ? `visit ${String(row.scheduled_date instanceof Date ? row.scheduled_date.toISOString() : row.scheduled_date).slice(0, 10)}${row.window_start ? ` ${String(row.window_start).slice(0, 5)}` : ''}${row.service_type ? ` (${row.service_type})` : ''} STILL ARMED`
      : 'no upcoming visit on the books';
    const excerpt = snapshotExcerpt(row.input_snapshot).slice(0, 140);
    return { name, asked, visit, excerpt, customerId: row.customer_id };
  });

  const subject = `ACT: ${flags.length} reschedule request${flags.length === 1 ? '' : 's'} by text with no schedule change`;
  const text = [
    `${flags.length} customer text${flags.length === 1 ? ' reads' : 's read'} as a reschedule/away request and the linked visit has not moved. Reply or reschedule each — the automation will otherwise run these visits as booked.`,
    '',
    ...lines.map((l) => `- ${l.asked} ${l.name}: "${l.excerpt}" — ${l.visit}`),
    '',
    `Threads: ${adminPortalUrl()}/admin/communications`,
  ].join('\n');
  const html = [
    `<p>${flags.length} customer text${flags.length === 1 ? ' reads' : 's read'} as a <strong>reschedule/away request</strong> and the linked visit has not moved. Reply or reschedule each — the automation will otherwise run these visits as booked.</p>`,
    `<ul style="margin:0 0 12px 18px;padding:0;">${lines.map((l) =>
      `<li style="margin:0 0 6px 0;">${esc(l.asked)} <a href="${esc(adminPortalUrl())}/admin/communications?thread=${esc(l.customerId || '')}"><strong>${esc(l.name)}</strong></a>: &quot;${esc(l.excerpt)}&quot; — ${esc(l.visit)}</li>`,
    ).join('')}</ul>`,
    `<p><a href="${esc(adminPortalUrl())}/admin/communications">Open communications</a></p>`,
  ].join('\n');

  return { subject, text, html, count: flags.length };
}

// Durable daily-send guard — same rationale as turf-variance-digest.js:
// the advisory lock only serializes concurrent ticks; ops_email_send_state
// (not job_health) carries the marker across deploy overlaps.
const SEND_MARKER_KEY = 'reschedule-intent-watcher';
const TWENTY_HOURS_MS = 20 * 60 * 60 * 1000;

async function sentRecently() {
  try {
    const row = await db('ops_email_send_state').where({ email_key: SEND_MARKER_KEY }).first('last_sent_at');
    return Boolean(row?.last_sent_at && (Date.now() - new Date(row.last_sent_at).getTime()) < TWENTY_HOURS_MS);
  } catch (err) {
    logger.warn(`[reschedule-intent-watcher] send-marker read failed (${err.message}) — proceeding without the guard`);
    return false;
  }
}

async function stampSendMarker() {
  try {
    const now = new Date();
    await db('ops_email_send_state')
      .insert({ email_key: SEND_MARKER_KEY, last_sent_at: now, updated_at: now })
      .onConflict('email_key')
      .merge({ last_sent_at: now, updated_at: now });
  } catch (err) {
    logger.warn(`[reschedule-intent-watcher] send-marker write failed (${err.message}) — next tick may re-send`);
  }
}

async function runRescheduleIntentWatcher(opts = {}) {
  if (await (opts.sentRecently || sentRecently)()) return { skipped: 'recent_send' };

  let rows;
  try {
    rows = await (opts.loadRows || loadUnactionedFlags)();
  } catch (err) {
    logger.error(`[reschedule-intent-watcher] query failed: ${err.message}`);
    return { skipped: 'query_failed' };
  }

  const composed = composeRescheduleIntentDigest(rows);
  if (!composed) return { skipped: 'nothing_found' };

  if (watcherDisabled()) {
    logger.info(`[reschedule-intent-watcher] disabled — would send ${composed.count} row(s)`);
    return { skipped: 'disabled', ...composed };
  }

  const mailer = opts.sendgrid || sendgrid;
  if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) {
    logger.warn('[reschedule-intent-watcher] mailer not configured — skipping send');
    return { skipped: 'unconfigured', ...composed };
  }

  // FAIL CLOSED: owner/internal inboxes only — customer names and message
  // excerpts must never leak to a mis-set recipient.
  const to = watcherEmail();
  if (!isInternalEmailRecipient(to)) {
    logger.warn('[reschedule-intent-watcher] recipient is not an internal address — skipping send; set a valid RESCHEDULE_INTENT_WATCHER_EMAIL');
    return { skipped: 'recipient', ...composed };
  }

  try {
    await mailer.sendOne({
      to,
      fromEmail: fromEmail(),
      fromName: FROM_NAME,
      subject: composed.subject,
      html: composed.html,
      text: composed.text,
      categories: ['ops', 'reschedule-intent'],
      suppressErrorLog: true,
    });
  } catch (err) {
    logger.error(`[reschedule-intent-watcher] send failed (status ${Number.isInteger(err?.status) ? err.status : 'network'})`);
    return { sent: false, error: true, ...composed };
  }
  await (opts.stampSendMarker || stampSendMarker)();
  logger.info(`[reschedule-intent-watcher] sent: ${composed.count} unactioned flag(s)`);
  return { sent: true, ...composed };
}

module.exports = {
  runRescheduleIntentWatcher,
  _private: { composeRescheduleIntentDigest },
};

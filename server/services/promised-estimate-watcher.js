'use strict';

// Daily owner exception email: quotes promised on calls that never went out.
//
// The call pipeline already knows when work is owed — the extraction sets
// quote_promised ("WORK IS STILL OWED to the caller after hangup") and
// decideDisposition maps it to estimate_send — but the only surfacing is a
// one-shot bell at call-processing time that never checks whether anything
// happened. The 2026-08-05 weekly sweep found an 812-second call whose
// promised quote was 6 days old with nothing sent. This watcher closes that
// loop: any call that promised a quote >24h ago with no estimate sent AFTER
// the call, across every linkage route, lands in one morning ACT email.
//
// "Sent" means estimates.sent_at IS NOT NULL — the single-writer, post-send
// stamp (same reasoning as wdo-report-attention.js: status can lie in both
// directions, sent_at cannot). The disposition alone is NOT the trigger:
// booked/complaint outrank estimate_send in decideDisposition, so a call
// that booked a job AND promised a quote never carries the label — the raw
// quote_promised extraction flag is OR'd in to cover that class.
//
// Exception-based: a quiet window sends nothing. Live by default with a
// kill switch (PROMISED_ESTIMATE_WATCHER_DISABLED=1). Cron: daily 7:12am ET
// in scheduler.js, inside runExclusive.

const sendgrid = require('./sendgrid-mail');
const logger = require('./logger');
const db = require('../models/db');
const { isInternalEmailRecipient } = require('../utils/internal-email-recipients');
const { etDateString } = require('../utils/datetime-et');

const watcherDisabled = () => ['1', 'true', 'on']
  .includes(String(process.env.PROMISED_ESTIMATE_WATCHER_DISABLED || '').toLowerCase());
const watcherEmail = () => process.env.PROMISED_ESTIMATE_WATCHER_EMAIL || 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';
const adminPortalUrl = () => (process.env.ADMIN_PORTAL_URL || 'https://portal.wavespestcontrol.com').replace(/\/+$/, '');

const LOOKBACK_HOURS = 7 * 24;
// The promise window: calls younger than this may legitimately still be
// in-progress; the estimate lanes send same-day when they work.
const GRACE_HOURS = 24;
const MAX_ROWS = 10;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `…${digits.slice(-4)}` : '(unknown)';
}

// A promise is KEPT when an estimate with sent_at AFTER the call exists via
// any linkage route: (a) estimator-engine provenance (exact), (b) the lead
// hop through twilio_call_sid, (c) shared customer_id, (d) normalized-phone
// match. sent_at > call time is essential — repeat callers usually have an
// older sent estimate on the same phone that must not self-clear the row.
async function loadUnkeptPromises() {
  const { rows } = await db.raw(
    `
    SELECT COUNT(*) OVER () AS total_count,
           c.id, c.created_at, c.customer_id, c.disposition,
           CASE WHEN c.direction = 'outbound' THEN c.to_phone ELSE c.from_phone END AS from_phone,
           c.duration_seconds,
           COALESCE(NULLIF(TRIM(cu.first_name || ' ' || COALESCE(cu.last_name, '')), ''), NULL) AS customer_name,
           LEFT(COALESCE(c.call_summary, c.lead_synopsis, ''), 200) AS summary
    FROM call_log c
    LEFT JOIN customers cu ON cu.id = c.customer_id
    WHERE c.created_at >= now() - (:lookbackHours * interval '1 hour')
      AND c.created_at <  now() - (:graceHours * interval '1 hour')
      -- The PROMISE signal is required: decideDisposition maps a mere
      -- quote_requested to estimate_send too, and a caller who only asked
      -- for pricing is not a broken promise (codex r2).
      AND (c.ai_extraction::text ~ '"quote_promised"\\s*:\\s*true'
           OR c.ai_extraction_enriched #>> '{service_request,quote_promised}' = 'true')
      AND (c.disposition IS NULL
           OR c.disposition NOT IN ('spam_discarded', 'wrong_number_closed'))
      AND NOT EXISTS (
        SELECT 1
        FROM estimates e
        WHERE e.sent_at IS NOT NULL
          AND e.sent_at > c.created_at
          AND (
               e.estimate_data #>> '{estimatorEngine,callLogId}' = c.id::text
            OR EXISTS (
                 SELECT 1 FROM leads l
                 WHERE l.twilio_call_sid = c.twilio_call_sid
                   AND (l.estimate_id = e.id OR e.estimate_data ->> 'lead_id' = l.id::text)
               )
            OR (c.customer_id IS NOT NULL AND e.customer_id = c.customer_id
                AND e.created_at >= c.created_at - interval '1 hour')
            OR (e.customer_phone IS NOT NULL
                AND e.created_at >= c.created_at - interval '1 hour'
                AND RIGHT(REGEXP_REPLACE(e.customer_phone, '\\D', '', 'g'), 10)
                  = RIGHT(REGEXP_REPLACE(CASE WHEN c.direction = 'outbound' THEN c.to_phone ELSE c.from_phone END, '\\D', '', 'g'), 10))
          )
      )
    ORDER BY c.created_at ASC
    LIMIT :maxRows
    `,
    { lookbackHours: LOOKBACK_HOURS, graceHours: GRACE_HOURS, maxRows: MAX_ROWS },
  );
  return rows;
}

function ageDays(createdAt) {
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.max(1, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

// Pure composition: null = every promise was kept (the common, quiet case).
function composePromisedEstimateDigest(rows) {
  const promises = (rows || []).filter(Boolean);
  if (!promises.length) return null;

  const oldest = Math.max(...promises.map((r) => ageDays(r.created_at)));
  const total = Number(promises[0]?.total_count) > 0 ? Number(promises[0].total_count) : promises.length;
  const subject = `ACT: ${total} promised quote${total === 1 ? '' : 's'} never went out — oldest ${oldest}d`;

  const lines = promises.map((r) => {
    const day = etDateString(new Date(r.created_at));
    const who = r.customer_name || maskPhone(r.from_phone);
    const mins = r.duration_seconds ? `${Math.round(r.duration_seconds / 60)}min call` : 'call';
    const summary = String(r.summary || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return { day, who, mins, summary, age: ageDays(r.created_at), callId: r.id };
  });

  const text = [
    `${promises.length} call${promises.length === 1 ? '' : 's'} where a quote was promised and no estimate has been sent since. Oldest is ${oldest} day${oldest === 1 ? '' : 's'} old.`,
    '',
    ...lines.map((l) => `- ${l.day} (${l.age}d ago) ${l.who} — ${l.mins}${l.summary ? `: ${l.summary}` : ''}`),
    ...(total > lines.length ? [`…and ${total - lines.length} more not shown`] : []),
    '',
    `Calls: ${adminPortalUrl()}/admin/communications?tab=calls`,
  ].join('\n');
  const html = [
    `<p>${promises.length} call${promises.length === 1 ? '' : 's'} where a quote was promised and <strong>no estimate has been sent since</strong>. Oldest is ${oldest} day${oldest === 1 ? '' : 's'} old.</p>`,
    `<ul style="margin:0 0 12px 18px;padding:0;">${lines.map((l) =>
      `<li style="margin:0 0 6px 0;">${esc(l.day)} (<strong>${esc(l.age)}d ago</strong>) ${esc(l.who)} — ${esc(l.mins)}${l.summary ? `: ${esc(l.summary)}` : ''}</li>`,
    ).join('')}</ul>`,
    ...(total > lines.length ? [`<p>…and ${total - lines.length} more not shown</p>`] : []),
    `<p><a href="${esc(adminPortalUrl())}/admin/communications?tab=calls">Open call log</a></p>`,
  ].join('\n');

  return { subject, text, html, count: total, oldestDays: oldest };
}

// Durable daily-send guard — same rationale as turf-variance-digest.js.
const SEND_MARKER_KEY = 'promised-estimate-watcher';
const TWENTY_HOURS_MS = 20 * 60 * 60 * 1000;

async function sentRecently() {
  try {
    const row = await db('ops_email_send_state').where({ email_key: SEND_MARKER_KEY }).first('last_sent_at');
    return Boolean(row?.last_sent_at && (Date.now() - new Date(row.last_sent_at).getTime()) < TWENTY_HOURS_MS);
  } catch (err) {
    logger.warn(`[promised-estimate-watcher] send-marker read failed (${err.message}) — proceeding without the guard`);
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
    logger.warn(`[promised-estimate-watcher] send-marker write failed (${err.message}) — next tick may re-send`);
  }
}

async function runPromisedEstimateWatcher(opts = {}) {
  if (await (opts.sentRecently || sentRecently)()) return { skipped: 'recent_send' };

  let rows;
  try {
    rows = await (opts.loadRows || loadUnkeptPromises)();
  } catch (err) {
    logger.error(`[promised-estimate-watcher] query failed: ${err.message}`);
    return { skipped: 'query_failed' };
  }

  const composed = composePromisedEstimateDigest(rows);
  if (!composed) return { skipped: 'nothing_found' };

  if (watcherDisabled()) {
    logger.info(`[promised-estimate-watcher] disabled — would send ${composed.count} row(s)`);
    return { skipped: 'disabled', ...composed };
  }

  const mailer = opts.sendgrid || sendgrid;
  if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) {
    logger.warn('[promised-estimate-watcher] mailer not configured — skipping send');
    return { skipped: 'unconfigured', ...composed };
  }

  // FAIL CLOSED: owner/internal inboxes only.
  const to = watcherEmail();
  if (!isInternalEmailRecipient(to)) {
    logger.warn('[promised-estimate-watcher] recipient is not an internal address — skipping send; set a valid PROMISED_ESTIMATE_WATCHER_EMAIL');
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
      categories: ['ops', 'promised-estimate'],
      suppressErrorLog: true,
    });
  } catch (err) {
    logger.error(`[promised-estimate-watcher] send failed (status ${Number.isInteger(err?.status) ? err.status : 'network'})`);
    return { sent: false, error: true, ...composed };
  }
  await (opts.stampSendMarker || stampSendMarker)();
  logger.info(`[promised-estimate-watcher] sent: ${composed.count} unkept promise(s), oldest ${composed.oldestDays}d`);
  return { sent: true, ...composed };
}

module.exports = {
  runPromisedEstimateWatcher,
  _private: { composePromisedEstimateDigest },
};

'use strict';

// Weekly owner reminder: gaps the Intelligence Bar recorded (the route's
// per-request collector, agent-gap-reports.js) in the last 7
// days — things it told the operator it could not do. Exception-based per
// the hands-off rule (CLAUDE.md rule 14): a quiet week sends nothing.
//
// The bell body is a fixed, short instruction ("ask the bar, or say build
// gap #N") — never the list itself, which can run long and is free text an
// operator typed (owner ruling 2026-09-28: bell alerts stay two short
// actionable lines). The full list goes out only in the email body, to the
// internal ops inbox, same recipient/mailer preflight as turf-variance-digest.
//
// Cron: Monday 8:15am ET in scheduler.js, inside runExclusive.

const sendgrid = require('./sendgrid-mail');
const logger = require('./logger');
const db = require('../models/db');
const { deliverOpsDigest } = require('./ops-digest');
const { isInternalEmailRecipient } = require('../utils/internal-email-recipients');
const { etWeekStart } = require('../utils/datetime-et');
const { gapReportsEnabled, listRecentGaps } = require('./agent-gap-reports');

const digestEmail = () => process.env.AGENT_GAP_DIGEST_EMAIL || 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';

const WINDOW_DAYS = 7;
// Fixed, short instruction — never the list itself (bell-body length rule).
const BELL_BODY = 'Ask the bar "show gap reports" for the list. Tell any session "build gap #N" to start a PR.';

// A gap's `source` (agent-gap-reports.js) read as a short label for the
// email list, so a Monday glance says where it came from. An unrecognized
// or missing source (should not happen — the column is NOT NULL) falls back
// to the raw value, or 'bar' if even that is empty.
const SOURCE_LABELS = {
  'intelligence-bar': 'bar',
  'tech-bar': 'tech bar',
  'texting-ai': 'texting AI',
  'phone-agent': 'phone agent',
};

// Gaps the owner already settled (fixed, by_design, dismissed) stay out of
// the reminder; the recorder reopens a `fixed` gap that happens again, so a
// regression still shows up. Most-seen this week first.
async function loadRecentGaps() {
  return listRecentGaps({ days: WINDOW_DAYS });
}

// Numbers, areas and counts only: a gap's description is model-written text
// and stays in the bar ("show gap reports"), never in the email.
function gapLine(row) {
  const tool = row.closest_tool ? `, closest tool ${row.closest_tool}` : '';
  const source = SOURCE_LABELS[row.source] || row.source || 'bar';
  return `gap #${row.id} (${row.status}, ${row.domain || 'other'}, ${source}${tool}): seen ${row.seen_in_window}x this week, ${row.occurrences}x total`;
}

// Pure composition: null = nothing worth an email (the common, quiet case).
function composeAgentGapDigest(rows) {
  if (!rows || !rows.length) return null;
  const count = rows.length;
  const subject = `ACT: ${count} thing${count === 1 ? '' : 's'} the bar couldn't do this week`;
  const text = [
    `${count} thing${count === 1 ? '' : 's'} the Intelligence Bar could not do in the last ${WINDOW_DAYS} days:`,
    '',
    ...rows.map(gapLine),
    '',
    BELL_BODY,
  ].join('\n');
  return { subject, text, count, itemKeys: rows.map((row) => row.id).filter((id) => id != null).map(String) };
}

// Durable weekly-send guard, same as turf-variance-digest (codex #3230 P1):
// runExclusive only serializes CONCURRENT ticks, so a deploy-overlap
// instance entering after the first released the lock would send again.
// The dedupeKey below already holds the bell to one row per ET week; this
// marker covers the email path. It stamps only after a delivery succeeded.
// Read failure sends anyway (a rare double beats a silently skipped week).
const SEND_MARKER_KEY = 'agent-gap-digest';
const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

async function sentRecently() {
  try {
    const row = await db('ops_email_send_state').where({ email_key: SEND_MARKER_KEY }).first('last_sent_at');
    return Boolean(row?.last_sent_at && (Date.now() - new Date(row.last_sent_at).getTime()) < SIX_DAYS_MS);
  } catch (err) {
    logger.warn(`[agent-gap-digest] send-marker read failed (${err.code || err.name || 'error'}) — proceeding without the guard`);
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
    logger.warn(`[agent-gap-digest] send-marker write failed (${err.code || err.name || 'error'}) — next tick may re-send`);
  }
}

function dedupeKeyFor(now = new Date()) {
  return `agent-gap-digest:${etWeekStart(now)}`;
}

async function runAgentGapDigest(opts = {}) {
  if (!gapReportsEnabled()) return { skipped: 'disabled' };
  let rows;
  try {
    rows = await (opts.loadRows || loadRecentGaps)();
  } catch (err) {
    logger.error(`[agent-gap-digest] query failed: ${err.message}`);
    return { skipped: 'query_failed' };
  }

  const composed = composeAgentGapDigest(rows);
  if (!composed) return { skipped: 'empty' };

  if (await (opts.sentRecently || sentRecently)()) return { skipped: 'recent_send' };

  const mailer = opts.sendgrid || sendgrid;
  if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) {
    logger.warn('[agent-gap-digest] mailer not configured — skipping send');
    return { skipped: 'unconfigured', ...composed };
  }

  // FAIL CLOSED: owner/internal inboxes only.
  const to = digestEmail();
  if (!isInternalEmailRecipient(to)) {
    logger.warn('[agent-gap-digest] recipient is not an internal address — skipping send; set a valid AGENT_GAP_DIGEST_EMAIL');
    return { skipped: 'recipient', ...composed };
  }

  let delivered;
  try {
    delivered = await deliverOpsDigest({
      key: 'agent-gap-digest',
      subject: composed.subject,
      text: BELL_BODY,
      dedupeKey: dedupeKeyFor(opts.now),
      count: composed.count,
      itemKeys: composed.itemKeys,
      sendEmail: () => mailer.sendOne({
        to,
        fromEmail: fromEmail(),
        fromName: FROM_NAME,
        subject: composed.subject,
        text: composed.text,
        categories: ['ops', 'agent-gap-digest'],
        suppressErrorLog: true,
      }),
    });
  } catch (err) {
    logger.error(`[agent-gap-digest] send failed (status ${Number.isInteger(err?.status) ? err.status : 'network'})`);
    return { sent: false, error: true, ...composed };
  }
  // deliverOpsDigest resolves { ok: false } for a mailer that reports failure
  // instead of throwing — that is not a delivery either.
  if (delivered?.ok === false) {
    logger.error('[agent-gap-digest] send failed (delivery reported not ok)');
    return { sent: false, error: true, ...composed };
  }
  await (opts.stampSendMarker || stampSendMarker)();
  logger.info(`[agent-gap-digest] sent: ${composed.count} gap(s) via ${delivered?.channel || 'unknown'}`);
  return { sent: true, ...composed };
}

module.exports = {
  runAgentGapDigest,
  _private: { composeAgentGapDigest, dedupeKeyFor, loadRecentGaps, BELL_BODY, gapLine, SOURCE_LABELS },
};

/**
 * impact-verdict-digest.js — puts the content-optimization impact loop's own
 * findings in front of the owner, instead of leaving them on a dashboard.
 *
 * The impact tracker already grades every published optimization (14d/21d
 * diff-in-differences against control pages) and auto-pauses a bucket once it
 * accrues REGRESSION_PAUSE_THRESHOLD confirmed regressions. Until now the only
 * consumers were autonomous-runner — which silently stops drafting that bucket
 * — and one admin endpoint. A content lane could halt itself indefinitely and
 * nothing said so; the owner had to open /admin and notice.
 *
 * Three exception-based legs (a quiet week sends nothing at all):
 *
 *   1. Paused-lane alert (FIX:) — one or more buckets sit at/over the pause
 *      threshold. Re-nagged every 6 days while unresolved, and the marker is
 *      CLEARED when a bucket stops being paused, so a later re-pause alerts
 *      immediately instead of being swallowed by a stale marker.
 *
 *   2. Blind-loop alert (FIX:) — a meaningful number of optimizations were
 *      measured over BLIND_LOOP_DAYS and not one carries a graded verdict. A
 *      grader that can never grade looks identical to a healthy one on a
 *      dashboard; it is only visible as an absence, so the absence is the
 *      alert.
 *
 *   3. Weekly verdict rollup (OK:/FYI:) — what the loop actually measured in
 *      the last ROLLUP_WINDOW_DAYS. Sends only when at least one verdict was
 *      recorded, so an engine that published nothing stays silent.
 *
 * Runs as a leg of the daily 8am impact-tracker handler, never as its own
 * cron: it must describe POST-sweep state, and a fixed-offset cron could fire
 * mid-sweep and stamp its weekly marker onto pre-sweep counts — suppressing
 * the corrected rollup for six days.
 *
 * Composition is pure (compose* take rows, return null or an email) so the
 * copy and the thresholds are testable without a DB or a mailer.
 */

const sendgrid = require('../sendgrid-mail');
const logger = require('../logger');
const db = require('../../models/db');
const { isInternalEmailRecipient } = require('../../utils/internal-email-recipients');
const { runExclusive } = require('../../utils/cron-lock');
const { addETDays } = require('../../utils/datetime-et');

// Dark-ship gate: inert until the owner flips it. When off we still compute
// and shadow-log what WOULD have gone out, so the flip is a known quantity.
const digestEnabled = () => process.env.GATE_IMPACT_DIGEST === 'true';

// Recipient is deliberately independent of SENDGRID_FROM_EMAIL: the sender
// identity is commonly an automations mailbox, and falling back to it would
// land a halted content lane in the wrong inbox.
const digestEmail = () => process.env.IMPACT_DIGEST_EMAIL || 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';
const adminPortalUrl = () => (process.env.ADMIN_PORTAL_URL || 'https://portal.wavespestcontrol.com').replace(/\/+$/, '');

const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
const ROLLUP_WINDOW_DAYS = 7;
// The two ALERT markers use the six-day re-nag interval above. The rollup
// needs its own: six days would let a daily tick send on day six, turning the
// "weekly" rollup into a drifting six-day one, while a flat seven days lands
// exactly ON the boundary and slips to day eight on any jitter.
//
// The threshold only has to SEPARATE two well-known elapsed times, since the
// cron fires once a day at 08:00 ET and the marker is stamped at that tick's
// own cutoff:
//   day 6 → ~144h (143h or 145h across a DST change)
//   day 7 → ~168h (167h across spring-forward, 169h across fall-back)
// Sitting at the midpoint leaves ~11h of slack on both sides, which absorbs
// the DST hour and any cron jitter — where 167h would be defeated by a
// spring-forward week plus a few milliseconds of early start.
const ROLLUP_DUE_MS = 6.5 * 24 * 60 * 60 * 1000;
const BLIND_LOOP_DAYS = 21;
// Below this many measured-but-ungraded optimizations the silence is just a
// quiet engine, not a blind grader. Keeps the alert off a young/low-volume lane.
const BLIND_LOOP_MIN_MEASURED = 5;

const PAUSED_MARKER_PREFIX = 'impact-paused:';
const BLIND_MARKER_KEY = 'impact-loop-blind';
const ROLLUP_MARKER_KEY = 'impact-verdict-rollup';

const MEASURED_VERDICTS = ['improved', 'neutral', 'regressed'];

// Skips that mean a finding EXISTED but could not be delivered, or that state
// could not be read at all. These become job_health failures. The expected
// quiet outcomes — gated, none-paused, already-alerted, not-due, empty,
// grading, below-floor — stay healthy; a quiet week is the normal case here.
const DELIVERY_BLOCKING_SKIPS = new Set(['unconfigured', 'recipient', 'error']);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// email_key is varchar(60); bucket is varchar(40) and the prefix is 14, so a
// full-length bucket still fits. Truncate defensively rather than throw on a
// future wider bucket column — a clipped key still dedupes per bucket.
function pausedMarkerKey(bucket) {
  return `${PAUSED_MARKER_PREFIX}${String(bucket || '')}`.slice(0, 60);
}

// ── send markers (durable dedupe across deploy-overlap ticks) ───────
// The advisory lock only serializes CONCURRENT ticks; during a Railway deploy
// the second instance can enter after the first released it. Markers live in
// ops_email_send_state (NOT job_health — the Intelligence Bar classifies every
// job_health row as a scheduled job and would flag a quiet marker as
// permanently stale; codex #3230 r2). Stamped only when an email actually
// left. Read failure sends anyway — a rare duplicate beats a silently
// swallowed halted lane.

async function sentRecently(database, key, intervalMs = SIX_DAYS_MS) {
  try {
    const row = await database('ops_email_send_state').where({ email_key: key }).first('last_sent_at');
    return Boolean(row?.last_sent_at && (Date.now() - new Date(row.last_sent_at).getTime()) < intervalMs);
  } catch (err) {
    logger.warn(`[impact-digest] send-marker read failed for ${key} (${err.message}) — proceeding without the guard`);
    return false;
  }
}

// `at` lets the rollup stamp its pre-query CUTOFF rather than the send time —
// see rollupWindowStart. The dedupe-only markers just use now().
async function stampSendMarker(database, key, at = null) {
  try {
    const now = new Date();
    const stampedAt = at || now;
    await database('ops_email_send_state')
      .insert({ email_key: key, last_sent_at: stampedAt, updated_at: now })
      .onConflict('email_key')
      .merge({ last_sent_at: stampedAt, updated_at: now });
  } catch (err) {
    logger.warn(`[impact-digest] send-marker write failed for ${key} (${err.message}) — next tick may re-send`);
  }
}

// Re-arm: a bucket that is no longer paused must be able to alert again the
// moment it re-pauses. Without this the 6-day re-nag window doubles as a
// 6-day blind spot after a human clears the regressions.
async function clearSendMarker(database, key) {
  try {
    await database('ops_email_send_state').where({ email_key: key }).del();
  } catch (err) {
    logger.warn(`[impact-digest] send-marker clear failed for ${key} (${err.message})`);
  }
}

// ── pure composition ────────────────────────────────────────────────

function bucketLine(entry) {
  return `<li style="margin:0 0 8px 0;"><strong>${esc(entry.bucket)}</strong> — ${esc(entry.regressions)} confirmed regression${Number(entry.regressions) === 1 ? '' : 's'}</li>`;
}

function shell(heading, lead, sections) {
  return [
    `<div style="font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1B2C5B;max-width:640px;">`,
    `<h2 style="margin:0 0 4px 0;font-size:16px;">${esc(heading)}</h2>`,
    `<p style="margin:0 0 12px 0;color:#5A6B7B;">${lead}</p>`,
    sections.join(''),
    `</div>`,
  ].join('');
}

/**
 * composePausedAlert(buckets) → email | null
 * buckets: [{ bucket, regressions }] straight from tracker.pausedBuckets().
 *
 * A paused bucket means the autonomous runner has STOPPED drafting that
 * action type — the copy has to say that outright, because "paused" alone
 * reads like a status, not a halt.
 */
function composePausedAlert(buckets) {
  const rows = (buckets || []).filter((b) => b && b.bucket);
  if (!rows.length) return null;

  const impactUrl = `${adminPortalUrl()}/admin/blog?tab=autopilot`;
  const names = rows.map((r) => r.bucket).join(', ');
  const subject = rows.length === 1
    ? `FIX: content lane auto-paused — ${rows[0].bucket} (${rows[0].regressions} confirmed regressions)`
    : `FIX: ${rows.length} content lanes auto-paused — ${names}`;

  const html = shell(
    'Content lane auto-paused',
    `The impact tracker confirmed repeated 21-day regressions, so the autonomous runner has <strong>stopped drafting</strong> the lane${rows.length === 1 ? '' : 's'} below. It stays stopped until the losses are reviewed. Verdicts: <a href="${impactUrl}">${impactUrl}</a>.`,
    [`<ul style="margin:0;padding-left:18px;">${rows.map(bucketLine).join('')}</ul>`],
  );

  const text = [
    'Content lane auto-paused',
    '',
    `The impact tracker confirmed repeated 21-day regressions, so the autonomous runner has STOPPED drafting the lane(s) below. It stays stopped until the losses are reviewed.`,
    '',
    ...rows.map((r) => `- ${r.bucket} — ${r.regressions} confirmed regression(s)`),
    '',
    `Verdicts: ${impactUrl}`,
  ].join('\n');

  return { subject, html, text, buckets: rows.map((r) => r.bucket) };
}

/**
 * composeBlindLoopAlert({ ungraded, days }) → email | null
 *
 * Fires when a meaningful number of optimizations were MEASURED across a long
 * window and not one of them carries a graded verdict. Phrased in terms of
 * optimizations rather than "checks" on purpose: the table keeps one verdict
 * per optimization, the confirmed 21-day one, so the number of underlying
 * check events is not something this row set can honestly report.
 *
 * That state is a threshold/traffic problem (MIN_IMPRESSIONS, or too few
 * control pages), not a quiet week, and it silently disables the judgment half
 * of the loop.
 */
function composeBlindLoopAlert({ ungraded, days = BLIND_LOOP_DAYS, minMeasured = BLIND_LOOP_MIN_MEASURED } = {}) {
  const count = Number(ungraded) || 0;
  if (count < minMeasured) return null;

  const impactUrl = `${adminPortalUrl()}/admin/blog?tab=autopilot`;
  const subject = `FIX: impact loop graded nothing in ${days} days — ${count} measured, none graded`;
  const html = shell(
    'Impact loop is measuring but not grading',
    `${esc(count)} optimizations were measured over the last ${esc(days)} days and every one of them still carries <strong>insufficient_data</strong> — not one improved, neutral, or regressed verdict. The loop is publishing and measuring but cannot grade its own work, so nothing can be paused or re-queued on evidence. Usual causes: pages below the impressions floor, or too few usable control pages. Verdicts: <a href="${impactUrl}">${impactUrl}</a>.`,
    [],
  );
  const text = [
    'Impact loop is measuring but not grading',
    '',
    `${count} optimizations were measured over the last ${days} days and every one still carries insufficient_data — not one improved, neutral, or regressed verdict.`,
    'The loop is publishing and measuring but cannot grade its own work, so nothing can be paused or re-queued on evidence.',
    'Usual causes: pages below the impressions floor, or too few usable control pages.',
    '',
    `Verdicts: ${impactUrl}`,
  ].join('\n');

  return { subject, html, text, ungraded: count };
}

function tallyVerdicts(rows) {
  const counts = { improved: 0, neutral: 0, regressed: 0, insufficient_data: 0 };
  for (const row of rows || []) {
    if (row?.verdict && counts[row.verdict] != null) counts[row.verdict] += 1;
  }
  return counts;
}

function regressedLine(row) {
  const lift = row.estimated_lift_position != null
    ? `${Number(row.estimated_lift_position) > 0 ? '+' : ''}${row.estimated_lift_position} positions vs control`
    : 'lift unavailable';
  return `<li style="margin:0 0 8px 0;"><strong>${esc(row.page_url)}</strong><br><span style="color:#5A6B7B;font-size:12px;">${esc(row.bucket || '—')} · ${esc(lift)}</span></li>`;
}

/**
 * composeVerdictRollup(rows, { days }) → email | null
 *
 * rows: impact rows whose 14d/21d check landed inside the window.
 * Returns null unless at least one row carries a MEASURED verdict — an engine
 * that published nothing, or graded nothing, must not generate a weekly email
 * (the blind-loop leg owns the "graded nothing" case).
 */
function composeVerdictRollup(rows, { days = ROLLUP_WINDOW_DAYS } = {}) {
  const counts = tallyVerdicts(rows);
  const measured = MEASURED_VERDICTS.reduce((sum, key) => sum + counts[key], 0);
  if (!measured) return null;

  const regressedRows = (rows || []).filter((r) => r?.verdict === 'regressed');
  const impactUrl = `${adminPortalUrl()}/admin/blog?tab=autopilot`;

  const parts = MEASURED_VERDICTS
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${key}`)
    .join(', ');
  // A regression that has not yet tripped the pause threshold is worth
  // knowing about but needs no action — FYI. A clean window is OK.
  const subject = counts.regressed > 0
    ? `FYI: content impact — ${parts} (${days}d)`
    : `OK: content impact — ${parts} (${days}d)`;

  const sections = [
    `<ul style="margin:0;padding-left:18px;">`,
    ...MEASURED_VERDICTS.map((key) => `<li style="margin:0 0 4px 0;">${esc(key)}: <strong>${esc(counts[key])}</strong></li>`),
    counts.insufficient_data ? `<li style="margin:0 0 4px 0;color:#5A6B7B;">insufficient data: ${esc(counts.insufficient_data)}</li>` : '',
    `</ul>`,
  ];
  if (regressedRows.length) {
    sections.push(`<h3 style="margin:16px 0 8px 0;font-size:14px;color:#B3261E;">Regressed (${regressedRows.length})</h3><ul style="margin:0;padding-left:18px;">${regressedRows.map(regressedLine).join('')}</ul>`);
  }

  const html = shell(
    `Content impact — last ${days} days`,
    `Control-adjusted verdicts recorded this window. Full history: <a href="${impactUrl}">${impactUrl}</a>.`,
    sections,
  );

  const text = [
    `Content impact — last ${days} days`,
    '',
    ...MEASURED_VERDICTS.map((key) => `${key}: ${counts[key]}`),
    counts.insufficient_data ? `insufficient data: ${counts.insufficient_data}` : null,
    regressedRows.length ? `\nREGRESSED (${regressedRows.length}):\n${regressedRows.map((r) => `- ${r.page_url} (${r.bucket || '—'})`).join('\n')}` : null,
    '',
    `Full history: ${impactUrl}`,
  ].filter((line) => line !== null).join('\n');

  return { subject, html, text, counts, measured };
}

// ── data reads ──────────────────────────────────────────────────────

// Window boundaries are real Date objects built with the ET helpers — a naive
// 'YYYY-MM-DD' string in a timestamptz WHERE is read as UTC and slides the
// window 4-5 hours, moving boundary rows into the wrong day (AGENTS.md).
/**
 * Optimizations whose LATEST measurement landed in the window.
 *
 * content_optimization_impact stores ONE verdict per optimization: checkPending
 * writes a provisional verdict at 14 days and OVERWRITES it at 21 days, which
 * is the confirmed one ("the 21d check confirms the 14d verdict and is the
 * final one persisted"). There is no per-window verdict history to read.
 *
 * So the window keys on COALESCE(checked_21d_at, checked_14d_at) — the check
 * that produced the verdict currently on the row. The previous
 * "either timestamp is in the window" form was logically EQUIVALENT (21d is
 * never earlier than 14d, so a 14d hit implies a 21d hit whenever 21d exists);
 * COALESCE is used because it states the invariant the callers rely on —
 * one row, one measurement event, one matching verdict — instead of leaving
 * it to be re-derived, and it also drops the anomalous-ordering edge case.
 *
 * What this canNOT give callers is a count of check EVENTS: a row that was
 * graded at 14d and re-graded at 21d still returns one verdict. Copy that
 * says "N checks" would be unsupportable — see composeBlindLoopAlert.
 */
function checkedSince(database, since, { exclusive = false, until = null } = {}) {
  const op = exclusive ? '>' : '>=';
  const q = database('content_optimization_impact')
    .whereRaw(`COALESCE(checked_21d_at, checked_14d_at) ${op} ?`, [since]);
  // Upper bound, paired with stamping that same cutoff: see rollupWindowStart.
  if (until) q.whereRaw('COALESCE(checked_21d_at, checked_14d_at) <= ?', [until]);
  return q
    .select('bucket', 'page_url', 'verdict', 'estimated_lift_position', 'estimated_lift_clicks_pct');
}

// ── send legs ───────────────────────────────────────────────────────

async function sendComposed(composed, { mailer, database, markerKey, markerAt = null, categories, label }) {
  if (!digestEnabled()) {
    logger.info(`[impact-digest] gated OFF — would send: ${composed.subject}`);
    return { skipped: 'gated', subject: composed.subject };
  }
  if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) {
    logger.warn(`[impact-digest] mailer not configured — skipping ${label}`);
    return { skipped: 'unconfigured' };
  }

  // FAIL CLOSED: this mail carries internal content-engine state and page
  // URLs. A mis-set IMPACT_DIGEST_EMAIL must skip, never leak it outward.
  const to = digestEmail();
  if (!isInternalEmailRecipient(to)) {
    logger.warn(`[impact-digest] recipient is not an internal address — skipping ${label}; set a valid IMPACT_DIGEST_EMAIL`);
    return { skipped: 'recipient' };
  }

  try {
    await mailer.sendOne({
      to,
      fromEmail: fromEmail(),
      fromName: FROM_NAME,
      subject: composed.subject,
      html: composed.html,
      text: composed.text,
      categories,
      // A SendGrid validation body echoes the address — PII in Railway logs.
      suppressErrorLog: true,
    });
  } catch (err) {
    // Never interpolate err.message here (may echo the recipient address).
    logger.error(`[impact-digest] ${label} send failed (status ${Number.isInteger(err?.status) ? err.status : 'network'})`);
    return { sent: false, error: true };
  }

  await stampSendMarker(database, markerKey, markerAt);
  logger.info(`[impact-digest] sent ${label}: ${composed.subject}`);
  return { sent: true, subject: composed.subject };
}

// Leg 1 — paused lanes. One email covering every bucket that is newly (or
// still, after 6 days) paused; buckets that recovered get their marker cleared
// so the next pause alerts immediately.
async function alertPausedLanes({ database, mailer, tracker }) {
  let paused = [];
  try {
    // strict: pausedBuckets swallows its own query error and returns [] by
    // default. Here that reads as "every paused lane recovered", and the
    // re-arm sweep below would delete every dedupe marker — so the next
    // healthy tick re-emails lanes that never changed, inside the 6-day
    // window the markers exist to enforce. Stand down instead.
    paused = (await tracker.pausedBuckets({ db: database, strict: true })) || [];
  } catch (err) {
    logger.error(`[impact-digest] pause state unreadable, standing down this tick: ${err.message}`);
    return { skipped: 'error' };
  }

  const pausedNames = new Set(paused.map((p) => p.bucket));

  // Re-arm recovered buckets. Only keys we own are touched.
  try {
    const markers = await database('ops_email_send_state')
      .where('email_key', 'like', `${PAUSED_MARKER_PREFIX}%`)
      .select('email_key');
    for (const row of markers) {
      const bucket = String(row.email_key).slice(PAUSED_MARKER_PREFIX.length);
      if (!pausedNames.has(bucket)) await clearSendMarker(database, row.email_key);
    }
  } catch (err) {
    logger.warn(`[impact-digest] paused-marker re-arm sweep failed: ${err.message}`);
  }

  if (!paused.length) return { skipped: 'none-paused' };

  const due = [];
  for (const entry of paused) {
    if (!(await sentRecently(database, pausedMarkerKey(entry.bucket)))) due.push(entry);
  }
  if (!due.length) return { skipped: 'already-alerted' };

  const composed = composePausedAlert(due);
  if (!composed) return { skipped: 'empty' };

  const result = await sendComposed(composed, {
    mailer,
    database,
    // Stamped per bucket below; the shared helper stamps the first key so the
    // loop that follows is the authority on the rest.
    markerKey: pausedMarkerKey(due[0].bucket),
    categories: ['content-engine', 'impact-paused'],
    label: 'paused-lane alert',
  });
  if (result.sent) {
    for (const entry of due.slice(1)) await stampSendMarker(database, pausedMarkerKey(entry.bucket));
  }
  return { ...result, buckets: composed.buckets };
}

// Leg 2 — the loop is checking but never grading.
async function alertBlindLoop({ database, mailer }) {
  if (await sentRecently(database, BLIND_MARKER_KEY)) return { skipped: 'already-alerted' };

  let rows;
  try {
    rows = await checkedSince(database, addETDays(new Date(), -BLIND_LOOP_DAYS));
  } catch (err) {
    logger.error(`[impact-digest] blind-loop query failed: ${err.message}`);
    return { skipped: 'error' };
  }

  const counts = tallyVerdicts(rows);
  const measured = MEASURED_VERDICTS.reduce((sum, key) => sum + counts[key], 0);
  if (measured > 0) return { skipped: 'grading' };

  const composed = composeBlindLoopAlert({ ungraded: counts.insufficient_data, days: BLIND_LOOP_DAYS });
  if (!composed) return { skipped: 'below-floor' };

  return sendComposed(composed, {
    mailer,
    database,
    markerKey: BLIND_MARKER_KEY,
    categories: ['content-engine', 'impact-blind'],
    label: 'blind-loop alert',
  });
}

/**
 * The rollup window's start.
 *
 * A plain now-minus-7-days boundary double-counts: the previous rollup was
 * itself sent by the 8am tick, so last week's checks are stamped at or just
 * after that instant, and a `>=` comparison pulls that whole boundary batch
 * into this week's email as well. The last successful send is therefore an
 * EXCLUSIVE watermark. It also closes the gap the fixed window would leave —
 * after a skipped week, everything since the last real send is reported
 * rather than only the last seven days.
 *
 * The watermark is paired with a pre-query CUTOFF (see sendVerdictRollup),
 * because an exclusive watermark stamped at SEND time turns a harmless
 * double-count into a permanent skip: a verdict written between our query and
 * our stamp would fall below the next window's `>` boundary and never be
 * reported. Bounding the query at a cutoff taken BEFORE it runs, and stamping
 * that same cutoff, makes consecutive windows abut exactly.
 *
 * The cutoff alone does NOT make this safe across instances, and it is not
 * asked to: checkPending stamps checked_* with the `now` it captured at entry,
 * so an overlapping sweep can commit a timestamp below our cutoff after we
 * queried — no wall-clock cutoff can express commit order. The scheduler
 * therefore runs the measurement pass and this reporting leg under ONE
 * cross-instance lease (`impact-tracker-daily`), which is what actually closes
 * that race. The cutoff remains correct and useful for any caller outside that
 * lease (the CLI preview, a future ad-hoc run).
 */
async function rollupWindowStart(database) {
  try {
    const row = await database('ops_email_send_state').where({ email_key: ROLLUP_MARKER_KEY }).first('last_sent_at');
    if (row?.last_sent_at) return { since: new Date(row.last_sent_at), exclusive: true };
    // Read SUCCEEDED and there is no marker: genuinely the first rollup, so
    // the fixed window is the right, inclusive, start.
    return { since: addETDays(new Date(), -ROLLUP_WINDOW_DAYS), exclusive: false };
  } catch (err) {
    // Read FAILED — which is not the same thing. If a watermark older than
    // seven days exists but we cannot see it, falling back to a 7d window and
    // then advancing the marker to our cutoff would permanently skip every
    // verdict between the real watermark and that boundary. An unknown
    // watermark means stand down: no query, no send, no stamp.
    logger.error(`[impact-digest] rollup watermark unreadable, standing down this tick: ${err.message}`);
    return { error: true };
  }
}

// Whole days covered by the window, for the subject line — a fixed "7d" would
// misdescribe the first send, or the catch-up send after a skipped week.
function windowDays(since, until) {
  return Math.max(1, Math.round((until.getTime() - since.getTime()) / 86400000));
}

// Leg 3 — weekly rollup of what was actually graded.
async function sendVerdictRollup({ database, mailer }) {
  if (await sentRecently(database, ROLLUP_MARKER_KEY, ROLLUP_DUE_MS)) return { skipped: 'not-due' };

  const { since, exclusive, error } = await rollupWindowStart(database);
  if (error) return { skipped: 'error' };
  // Taken BEFORE the query and stamped as the watermark, so a concurrent
  // sweep's writes land above it instead of being skipped forever.
  const cutoff = new Date();
  let rows;
  try {
    rows = await checkedSince(database, since, { exclusive, until: cutoff });
  } catch (err) {
    logger.error(`[impact-digest] rollup query failed: ${err.message}`);
    return { skipped: 'error' };
  }

  const composed = composeVerdictRollup(rows, { days: windowDays(since, cutoff) });
  // Quiet window: nothing graded. No email, and NO marker stamp — the first
  // real verdict after a quiet stretch goes out on the next tick rather than
  // waiting out an arbitrary weekly slot.
  if (!composed) return { skipped: 'empty' };

  return sendComposed(composed, {
    mailer,
    database,
    markerKey: ROLLUP_MARKER_KEY,
    // Stamp the CUTOFF, not the send time — the two windows must abut exactly.
    markerAt: cutoff,
    categories: ['content-engine', 'impact-rollup'],
    label: 'verdict rollup',
  });
}

/**
 * Daily entry point, chained after a successful impact sweep. Every leg is
 * independently guarded and independently failure-isolated: a broken rollup
 * must never suppress a halted-lane alert.
 *
 * `opts.db`, `opts.sendgrid` and `opts.tracker` are injectable for tests.
 */
async function sendImpactDigestsIfDue(opts = {}) {
  return runExclusive('impact-verdict-digest', () => sendImpactDigestsLocked(opts));
}

async function sendImpactDigestsLocked(opts = {}) {
  const database = opts.db || db;
  const mailer = opts.sendgrid || sendgrid;
  const tracker = opts.tracker || require('./impact-tracker');

  const results = {};
  for (const [name, leg] of [
    ['paused', () => alertPausedLanes({ database, mailer, tracker })],
    ['blind', () => alertBlindLoop({ database, mailer })],
    ['rollup', () => sendVerdictRollup({ database, mailer })],
  ]) {
    try {
      results[name] = await leg();
    } catch (err) {
      logger.error(`[impact-digest] ${name} leg failed: ${err.message}`);
      results[name] = { skipped: 'error' };
    }
  }

  // A swallowed failure must still read as a FAILED run in job_health — the
  // turf-variance convention (scheduler.js, codex #3230 P2). Otherwise
  // runExclusive records a healthy run while a halted content lane never
  // reached the owner, which is the same silence this whole module exists to
  // end. Aggregated AFTER every leg has run, so throwing here never costs the
  // leg isolation above: a failing rollup does not suppress a paused-lane
  // alert, it only makes the job read as failed once both have been attempted.
  const failed = Object.entries(results)
    .filter(([, r]) => r?.error || DELIVERY_BLOCKING_SKIPS.has(r?.skipped))
    .map(([name, r]) => `${name}:${r.skipped || 'send_failed'}`);
  if (failed.length) throw new Error(`impact digest did not complete (${failed.join(', ')})`);

  return results;
}

module.exports = {
  sendImpactDigestsIfDue,
  // exposed for tests / the CLI preview
  composePausedAlert,
  composeBlindLoopAlert,
  composeVerdictRollup,
  _internals: { tallyVerdicts, pausedMarkerKey, checkedSince },
  THRESHOLDS: { ROLLUP_WINDOW_DAYS, ROLLUP_DUE_MS, BLIND_LOOP_DAYS, BLIND_LOOP_MIN_MEASURED, SIX_DAYS_MS },
};

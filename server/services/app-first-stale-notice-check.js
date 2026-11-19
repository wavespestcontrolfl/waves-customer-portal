'use strict';
/**
 * Daily read-only live check for the stale-app gap (owner 2026-11-18).
 *
 * The gap: with GATE_APP_FIRST_ANY_DEVICE on, a customer got every visit
 * notice as an app push and no text, with no check of when the app was last
 * opened. One customer whose app had last been opened on Oct 10 got the 72 hour
 * reminder, the reminder, on-the-way and arrived notices for their Nov 18 visit
 * as push only (the provider accepted them) and saw none. GATE_APP_FIRST_STALE_TEXT
 * (push-channel-routing.js, staleTextFloor) now sends the text too when the app was
 * not opened in 30 days, and the app alert still goes. This check finds the same gap in live data, so the
 * owner never has to catch it again; with that gate on it should normally find 0.
 *
 * What it reads: routing records the evidence at send time. Every any-device push
 * proof row (sms_log from_phone 'push') carries metadata.app_checked_in_at, the
 * newest check-in of the holder's phone app that routing saw when it chose push
 * (push-channel-routing.js, anyDeviceReach). A problem row: outbound, in the last
 * 48 hours, an automatic replacement of a text (metadata.requestedChannel 'sms',
 * never an explicit App choice), with that stamp more than 30 days before the push.
 * Rows without a stamp are unknown and skipped. One item per visit, or per row when
 * it has no visit. Whatever else went for the visit, a push to a stale app is the miss.
 *
 * Read-only: SELECTs only. The result is one ops digest row (key below) that
 * retires itself on a clean run; a failed query never retires it.
 */
const db = require('../models/db');
const logger = require('./logger');
const { deliverOpsDigest } = require('./ops-digest');
const { retireIfClean } = require('./ops-digest-fall-off');
const sendgrid = require('./sendgrid-mail');
const { isInternalEmailRecipient } = require('../utils/internal-email-recipients');

const OPS_DIGEST_KEY = 'app-first-stale-notice';
// Same bound as APP_FIRST_STALE_DAYS in messaging/push-channel-routing.js (not
// imported: that module loads the whole send stack). Change both together.
const STALE_DAYS = 30;
const PUSH_WINDOW_HOURS = 48;
const MAX_ROWS_SHOWN = 20;
const LINK = '/admin/customers';

const digestEmail = () => process.env.APP_FIRST_STALE_NOTICE_DIGEST_EMAIL || 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';
const adminPortalUrl = () => (process.env.ADMIN_PORTAL_URL || 'https://portal.wavespestcontrol.com').replace(/\/+$/, '');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// One row per automatic app push in the window that carries a stamp. The stamp
// comes back as text and is read in JS (staleRows), so one malformed value can
// never fail the query. Bindings: window start.
const STAMPED_PUSHES_SQL = `
  SELECT l.id, l.customer_id, l.created_at, l.message_type,
         -- Services that share one visit (scheduled_services.visit_id) count as ONE visit;
         -- an ungrouped service counts by its own id.
         COALESCE(ss.visit_id::text, NULLIF(l.metadata->>'scheduled_service_id', '')) AS visit_id,
         l.metadata->>'app_checked_in_at' AS app_checked_in_at,
         ss.scheduled_date::text AS scheduled_date,
         c.first_name, c.last_name
    FROM sms_log l
    LEFT JOIN scheduled_services ss ON ss.id::text = l.metadata->>'scheduled_service_id'
    LEFT JOIN customers c ON c.id = l.customer_id
   WHERE l.direction = 'outbound'
     AND l.from_phone = 'push'
     AND l.created_at >= ?::timestamptz
     AND l.metadata->>'requestedChannel' = 'sms'
     AND l.metadata->>'app_checked_in_at' IS NOT NULL
   ORDER BY l.created_at`;

// A stamp counts only when it is an ISO date that survives a round trip: V8 reads
// 2026-02-31 as Mar 3, so the date part must match (routing writes toISOString).
function stampMs(stamp) {
  const text = String(stamp ?? '');
  const ms = Date.parse(text);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === text.slice(0, 10) ? ms : null;
}

// Rows whose stamp is valid and more than STALE_DAYS before the push, with the
// whole days between them.
function staleRows(rows) {
  const stale = [];
  for (const row of rows) {
    const checkedIn = stampMs(row.app_checked_in_at);
    const gapMs = checkedIn == null ? 0 : new Date(row.created_at).getTime() - checkedIn;
    if (gapMs > STALE_DAYS * 86400000) stale.push({ ...row, days_since_app_use: Math.floor(gapMs / 86400000) });
  }
  return stale;
}

// One item per visit (or per row with no visit): the notice types joined, the
// oldest stamp's days since app use.
function groupByVisit(pushRows) {
  const items = new Map();
  for (const row of pushRows) {
    const key = row.visit_id ? `visit:${row.visit_id}` : `sms:${row.id}`;
    const item = items.get(key) || { key, visit_id: row.visit_id, customer_id: row.customer_id, scheduled_date: row.scheduled_date,
      first_name: row.first_name, last_name: row.last_name, notice_types: [], days_since_app_use: row.days_since_app_use };
    if (row.message_type && !item.notice_types.includes(row.message_type)) item.notice_types.push(row.message_type);
    item.days_since_app_use = Math.max(item.days_since_app_use, row.days_since_app_use);
    items.set(key, item);
  }
  return [...items.values()];
}

async function findStaleAppNoticeVisits({ database = db, now = new Date() } = {}) {
  const windowStart = new Date(now.getTime() - PUSH_WINDOW_HOURS * 3600 * 1000);
  const result = await database.raw(STAMPED_PUSHES_SQL, [windowStart]);
  return groupByVisit(staleRows(result?.rows || []));
}

const who = (row) => {
  const first = String(row.first_name || '').trim() || 'Customer';
  const initial = String(row.last_name || '').trim().charAt(0);
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
};
const lastUse = (row) => `${row.days_since_app_use} days since app use`;
const customerUrl = (row) => (row.customer_id ? `${adminPortalUrl()}/admin/customers?customerId=${encodeURIComponent(row.customer_id)}` : null);
const lineFor = (row) => `${row.scheduled_date || 'no date'} · ${who(row)} · ${(row.notice_types || []).join(', ')} · ${lastUse(row)}`;

// The email fallback goes to an internal address only. A guard failure returns
// { ok: false } (the digest seam still writes the in-app row).
async function sendMail({ subject, html, text }) {
  if (typeof sendgrid.isConfigured === 'function' && !sendgrid.isConfigured()) {
    logger.warn('[app-first-stale-notice] mailer not configured — skipping email');
    return { ok: false, error: 'mailer_unconfigured' };
  }
  const to = digestEmail();
  if (!isInternalEmailRecipient(to)) {
    logger.warn('[app-first-stale-notice] recipient is not an internal address — skipping email');
    return { ok: false, error: 'recipient_not_internal' };
  }
  return sendgrid.sendOne({
    to,
    fromEmail: fromEmail(),
    fromName: FROM_NAME,
    subject,
    html,
    text,
    categories: ['ops', 'app-first-stale-notice'],
    suppressErrorLog: true,
  });
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Visits are counted by distinct visit id. A notice with no visit on record (a
// standalone receipt, say) is reported apart, never as a visit.
function digestSubject(visits, notices) {
  if (!visits) return `FIX: ${plural(notices, 'app-only notice')} went to an app not opened in ${STALE_DAYS}+ days`;
  const base = `FIX: ${plural(visits, 'visit')} got app-only notices on an app not opened in ${STALE_DAYS}+ days`;
  return notices ? `${base}, plus ${plural(notices, 'other notice')}` : base;
}

function digestBody(visitRows, noticeRows) {
  const intro = `In the last ${PUSH_WINDOW_HOURS} hours these went as app push to an app that had not been opened in ${STALE_DAYS}+ days. GATE_APP_FIRST_STALE_TEXT should send the text for these; check that it is on and working.`;
  const groups = [
    { title: `Visits (${visitRows.length})`, rows: visitRows },
    { title: `Other notices, no visit on record (${noticeRows.length})`, rows: noticeRows },
  ].filter((group) => group.rows.length);
  const text = [intro, ...groups.flatMap((g) => ['', `${g.title}:`, ...g.rows.slice(0, MAX_ROWS_SHOWN).map((r) => `- ${lineFor(r)}${customerUrl(r) ? ` · ${customerUrl(r)}` : ''}`)])].join('\n');
  const html = [`<p>${esc(intro)}</p>`, ...groups.map((g) => `<p><strong>${esc(g.title)}</strong></p><ul style="margin:0 0 12px 18px;padding:0;">${g.rows.slice(0, MAX_ROWS_SHOWN).map((r) => `<li style="margin:0 0 6px 0;">${esc(lineFor(r))}${customerUrl(r) ? ` &middot; <a href="${esc(customerUrl(r))}">customer</a>` : ''}</li>`).join('')}</ul>`)].join('\n');
  return { text, html };
}

async function postStaleAppNoticeDigest(rows) {
  if (!rows.length) {
    await retireIfClean(OPS_DIGEST_KEY);
    return { skipped: 'clean' };
  }
  const visitRows = rows.filter((r) => r.visit_id);
  const noticeRows = rows.filter((r) => !r.visit_id);
  const subject = digestSubject(visitRows.length, noticeRows.length);
  const { text, html } = digestBody(visitRows, noticeRows);

  try {
    return await deliverOpsDigest({
      fallOff: true,
      key: OPS_DIGEST_KEY,
      subject,
      html,
      text,
      link: rows.length === 1 && rows[0].customer_id ? `${LINK}?customerId=${encodeURIComponent(rows[0].customer_id)}` : LINK,
      metadata: { visits: visitRows.length, unlinkedNotices: noticeRows.length },
      itemKeys: rows.map((r) => r.key),
      dedupeKey: OPS_DIGEST_KEY,
      refreshOnDedupe: true,
      // The mail guards live inside sendEmail: with in-app digests on, a missing
      // SendGrid key or a bad recipient must not suppress the Activity row.
      sendEmail: () => sendMail({ subject, html, text }),
    });
  } catch (err) {
    // A controlled code only: the mail provider's message can hold an address.
    logger.error(`[app-first-stale-notice] digest send failed: ${err.code || err.statusCode || 'send_failed'}`);
    return { sent: false, error: true };
  }
}

// A failed query never retires the standing row: the check did not run.
async function runAppFirstStaleNoticeCheck({ database = db, now = new Date() } = {}) {
  let rows;
  try {
    rows = await findStaleAppNoticeVisits({ database, now });
  } catch (err) {
    logger.error(`[app-first-stale-notice] query failed: ${err.message}`);
    return { skipped: 'query_failed' };
  }
  logger.info(`[app-first-stale-notice] ${rows.length} visit(s) with app-only notices on a stale app`);
  const digest = await postStaleAppNoticeDigest(rows);
  return { found: rows.length, digest };
}

module.exports = {
  OPS_DIGEST_KEY,
  STALE_DAYS,
  staleRows,
  groupByVisit,
  findStaleAppNoticeVisits,
  postStaleAppNoticeDigest,
  runAppFirstStaleNoticeCheck,
};

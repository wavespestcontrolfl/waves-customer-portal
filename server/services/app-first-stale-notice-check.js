'use strict';
/**
 * Daily read-only live check for the stale-app gap (owner 2026-11-18).
 *
 * The gap: with GATE_APP_FIRST_ANY_DEVICE on, a customer got every visit
 * notice as an app push and no text, with no check of when the app was last
 * opened. One customer whose app had last been opened on Oct 10 got the 72 hour
 * reminder, the reminder, on-the-way and arrived notices for their Nov 18 visit
 * as push only (the provider accepted them) and saw none. GATE_APP_FIRST_STALE_TEXT
 * (push-channel-routing.js, staleTextFloor) now sends the text when the app was
 * not opened in 30 days. This check finds the same gap in live data, so the
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

// One row per stale-stamped push in the window. The stamp is cast only when it
// is an ISO timestamp (no `?` in the pattern: knex reads it as a binding; inside a CASE, so one malformed value cannot fail the
// query). Bindings, in order: window start, stale days.
const ISO_STAMP = '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+){0,1}(Z|[+-][0-9]{2}:[0-9]{2})$';
const STALE_PUSHES_SQL = `
  WITH stamped AS (
    SELECT l.id, l.customer_id, l.created_at, l.message_type,
           NULLIF(l.metadata->>'scheduled_service_id', '') AS visit_id,
           CASE WHEN l.metadata->>'app_checked_in_at' ~ '${ISO_STAMP}'
                THEN (l.metadata->>'app_checked_in_at')::timestamptz END AS checked_in_at
      FROM sms_log l
     WHERE l.direction = 'outbound'
       AND l.from_phone = 'push'
       AND l.created_at >= ?::timestamptz
       AND l.metadata->>'requestedChannel' = 'sms'
       AND l.metadata->>'app_checked_in_at' IS NOT NULL
  )
  SELECT st.id, st.customer_id, st.created_at, st.message_type, st.visit_id, st.checked_in_at,
         floor(extract(epoch FROM (st.created_at - st.checked_in_at)) / 86400)::int AS days_since_app_use,
         ss.scheduled_date::text AS scheduled_date,
         c.first_name, c.last_name
    FROM stamped st
    LEFT JOIN scheduled_services ss ON ss.id::text = st.visit_id
    LEFT JOIN customers c ON c.id = st.customer_id
   WHERE st.checked_in_at < st.created_at - (? * interval '1 day')
   ORDER BY st.created_at`;

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
  const result = await database.raw(STALE_PUSHES_SQL, [windowStart, STALE_DAYS]);
  return groupByVisit(result?.rows || []);
}

const who = (row) => {
  const first = String(row.first_name || '').trim() || 'Customer';
  const initial = String(row.last_name || '').trim().charAt(0);
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
};
const lastUse = (row) => `${row.days_since_app_use} days since app use`;
const customerUrl = (row) => (row.customer_id ? `${adminPortalUrl()}/admin/customers/${row.customer_id}` : null);
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

async function postStaleAppNoticeDigest(rows) {
  if (!rows.length) {
    await retireIfClean(OPS_DIGEST_KEY);
    return { skipped: 'clean' };
  }
  const shown = rows.slice(0, MAX_ROWS_SHOWN);
  const subject = `FIX: ${rows.length} visit${rows.length === 1 ? '' : 's'} got app-only notices on an app not opened in ${STALE_DAYS}+ days`;
  const text = [
    `${rows.length} visit(s) in the last ${PUSH_WINDOW_HOURS} hours went as app push to an app that had not been opened in ${STALE_DAYS}+ days. GATE_APP_FIRST_STALE_TEXT should send the text for these; check that it is on and working.`,
    '',
    ...shown.map((r) => `- ${lineFor(r)}${customerUrl(r) ? ` · ${customerUrl(r)}` : ''}`),
  ].join('\n');
  const html = [
    `<p><strong>${rows.length}</strong> visit(s) in the last ${PUSH_WINDOW_HOURS} hours went as app push to an app that had not been opened in ${STALE_DAYS}+ days. <code>GATE_APP_FIRST_STALE_TEXT</code> should send the text for these; check that it is on and working.</p>`,
    `<ul style="margin:0 0 12px 18px;padding:0;">${shown.map((r) => `<li style="margin:0 0 6px 0;">${esc(lineFor(r))}${customerUrl(r) ? ` &middot; <a href="${esc(customerUrl(r))}">customer</a>` : ''}</li>`).join('')}</ul>`,
  ].join('\n');

  try {
    return await deliverOpsDigest({
      fallOff: true,
      key: OPS_DIGEST_KEY,
      subject,
      html,
      text,
      link: rows.length === 1 && rows[0].customer_id ? `${LINK}/${rows[0].customer_id}` : LINK,
      metadata: { visits: rows.length },
      itemKeys: rows.map((r) => r.key),
      dedupeKey: OPS_DIGEST_KEY,
      refreshOnDedupe: true,
      // The mail guards live inside sendEmail: with in-app digests on, a missing
      // SendGrid key or a bad recipient must not suppress the Activity row.
      sendEmail: () => sendMail({ subject, html, text }),
    });
  } catch (err) {
    logger.error(`[app-first-stale-notice] digest send failed: ${err.message}`);
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
  groupByVisit,
  findStaleAppNoticeVisits,
  postStaleAppNoticeDigest,
  runAppFirstStaleNoticeCheck,
};

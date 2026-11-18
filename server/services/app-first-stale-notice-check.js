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
 * A problem visit: in the last 48 hours at least one outbound visit notice went
 * as an app push (sms_log from_phone 'push' with a scheduled_service_id), no
 * text went for that visit in the 4 days before its newest push, and the
 * customer's last app activity before the visit's FIRST push is older than 30
 * days or missing. Last app activity before T = the latest of the holder's
 * phone-app device check-in (push_subscriptions.updated_at, bumped on every app
 * launch), a token page view and a refresh-token sign-in, each at or before T.
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
const TEXT_LOOKBACK_DAYS = 4;
const MAX_ROWS_SHOWN = 20;
const LINK = '/admin/customers';

const digestEmail = () => process.env.APP_FIRST_STALE_NOTICE_DIGEST_EMAIL || 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';
const adminPortalUrl = () => (process.env.ADMIN_PORTAL_URL || 'https://portal.wavespestcontrol.com').replace(/\/+$/, '');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// One row per visit that got an app push in the window. Bindings, in order:
// window start, stale days, text lookback days.
const PROBLEM_VISITS_SQL = `
  WITH pushes AS (
    SELECT metadata->>'scheduled_service_id' AS visit_id,
           (array_agg(customer_id ORDER BY created_at))[1] AS customer_id,
           min(created_at) AS first_push,
           max(created_at) AS last_push,
           array_agg(DISTINCT message_type) AS notice_types
      FROM sms_log
     WHERE direction = 'outbound'
       AND from_phone = 'push'
       AND created_at >= ?::timestamptz
       AND COALESCE(metadata->>'scheduled_service_id', '') <> ''
     GROUP BY 1
  ), seen AS (
    SELECT p.*,
           GREATEST(
             (SELECT max(s.updated_at) FROM push_subscriptions s
               WHERE s.customer_id = p.customer_id AND s.role = 'customer'
                 AND s.platform IN ('ios', 'android') AND s.contact_phone_key IS NULL
                 AND s.updated_at <= p.first_push),
             (SELECT max(v.viewed_at) FROM customer_page_views v
               WHERE v.customer_id = p.customer_id AND v.viewed_at < p.first_push),
             (SELECT max(r.created_at) FROM customer_refresh_tokens r
               WHERE r.customer_id = p.customer_id AND r.contact_key IS NULL AND r.created_at < p.first_push)
           ) AS last_app_use
      FROM pushes p
  )
  SELECT seen.visit_id, seen.customer_id, seen.first_push, seen.last_push, seen.notice_types, seen.last_app_use,
         CASE WHEN seen.last_app_use IS NULL THEN NULL
              ELSE floor(extract(epoch FROM (seen.first_push - seen.last_app_use)) / 86400)::int END AS days_since_app_use,
         ss.scheduled_date::text AS scheduled_date,
         c.first_name, c.last_name
    FROM seen
    LEFT JOIN scheduled_services ss ON ss.id::text = seen.visit_id
    LEFT JOIN customers c ON c.id = seen.customer_id
   WHERE (seen.last_app_use IS NULL OR seen.last_app_use < seen.first_push - (? * interval '1 day'))
     AND NOT EXISTS (
       SELECT 1 FROM sms_log t
        WHERE t.direction = 'outbound'
          AND t.from_phone IS DISTINCT FROM 'push'
          AND COALESCE(t.status, '') NOT IN ('failed', 'undelivered')
          AND t.metadata->>'scheduled_service_id' = seen.visit_id
          AND t.created_at >= seen.last_push - (? * interval '1 day')
     )
   ORDER BY seen.first_push`;

async function findStaleAppNoticeVisits({ database = db, now = new Date() } = {}) {
  const windowStart = new Date(now.getTime() - PUSH_WINDOW_HOURS * 3600 * 1000);
  const result = await database.raw(PROBLEM_VISITS_SQL, [windowStart, STALE_DAYS, TEXT_LOOKBACK_DAYS]);
  return result?.rows || [];
}

const who = (row) => {
  const first = String(row.first_name || '').trim() || 'Customer';
  const initial = String(row.last_name || '').trim().charAt(0);
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
};
const lastUse = (row) => (row.days_since_app_use == null ? 'no app use on record' : `${row.days_since_app_use} days since app use`);
const customerUrl = (row) => (row.customer_id ? `${adminPortalUrl()}/admin/customers/${row.customer_id}` : null);
const lineFor = (row) => `${row.scheduled_date || 'no date'} · ${who(row)} · ${(row.notice_types || []).join(', ')} · ${lastUse(row)}`;

async function postStaleAppNoticeDigest(rows) {
  if (!rows.length) {
    await retireIfClean(OPS_DIGEST_KEY);
    return { skipped: 'clean' };
  }
  const shown = rows.slice(0, MAX_ROWS_SHOWN);
  const subject = `FIX: ${rows.length} visit${rows.length === 1 ? '' : 's'} got app-only notices on an app not opened in ${STALE_DAYS}+ days`;
  const text = [
    `${rows.length} visit(s) in the last ${PUSH_WINDOW_HOURS} hours got app push notices and no text, and the customer's app was not opened in the ${STALE_DAYS} days before the first notice. GATE_APP_FIRST_STALE_TEXT should send the text for these; check that it is on and working.`,
    '',
    ...shown.map((r) => `- ${lineFor(r)}${customerUrl(r) ? ` · ${customerUrl(r)}` : ''}`),
  ].join('\n');
  const html = [
    `<p><strong>${rows.length}</strong> visit(s) in the last ${PUSH_WINDOW_HOURS} hours got app push notices and no text, and the customer's app was not opened in the ${STALE_DAYS} days before the first notice. <code>GATE_APP_FIRST_STALE_TEXT</code> should send the text for these; check that it is on and working.</p>`,
    `<ul style="margin:0 0 12px 18px;padding:0;">${shown.map((r) => `<li style="margin:0 0 6px 0;">${esc(lineFor(r))}${customerUrl(r) ? ` &middot; <a href="${esc(customerUrl(r))}">customer</a>` : ''}</li>`).join('')}</ul>`,
  ].join('\n');

  if (typeof sendgrid.isConfigured === 'function' && !sendgrid.isConfigured()) {
    logger.warn('[app-first-stale-notice] mailer not configured — skipping digest send');
    return { skipped: 'unconfigured' };
  }
  const to = digestEmail();
  if (!isInternalEmailRecipient(to)) {
    logger.warn('[app-first-stale-notice] recipient is not an internal address — skipping digest send');
    return { skipped: 'recipient' };
  }
  try {
    return await deliverOpsDigest({
      fallOff: true,
      key: OPS_DIGEST_KEY,
      subject,
      html,
      text,
      link: rows.length === 1 && rows[0].customer_id ? `${LINK}/${rows[0].customer_id}` : LINK,
      metadata: { visits: rows.length },
      itemKeys: rows.map((r) => String(r.visit_id)),
      dedupeKey: OPS_DIGEST_KEY,
      refreshOnDedupe: true,
      sendEmail: () => sendgrid.sendOne({
        to,
        fromEmail: fromEmail(),
        fromName: FROM_NAME,
        subject,
        html,
        text,
        categories: ['ops', 'app-first-stale-notice'],
        suppressErrorLog: true,
      }),
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
  findStaleAppNoticeVisits,
  postStaleAppNoticeDigest,
  runAppFirstStaleNoticeCheck,
};

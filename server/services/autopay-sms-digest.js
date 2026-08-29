'use strict';

// Owner notice whenever autopay texts actually go out.
//
// 2026-08-29: the pre-charge reminder texted 12 prepay / per-application
// customers about a "monthly charge" that would never run, and the only way
// the owner found out was customers replying. The lane guard is fixed
// (#3605), but nothing told him a batch had gone out at all. This digest
// closes that loop from the OUTSIDE of every send site: it reads the
// messaging audit log — the single write path every customer SMS crosses —
// for autopay-family sends since the last notice, joins each recipient's
// billing lane, and emails one summary.
//
// Exception-based in the sense that a quiet window sends nothing. When a
// recipient's billing_mode is anything but monthly_membership the subject
// escalates from FYI: to FIX: — that is exactly the 08-29 shape and the
// reason this exists.
//
// Live by default with a kill switch (AUTOPAY_SMS_DIGEST_DISABLED=1).
// Cron: 9:41am + 10:41am ET in scheduler.js (after the 8:00 charge, 9:00
// pre-charge, 9:17 card-expiry and 10:07 retry jobs), inside runExclusive.
// The window is marker-based (ops_email_send_state), so the second tick only
// mails when something new went out.

const sendgrid = require('./sendgrid-mail');
const logger = require('./logger');
const db = require('../models/db');
const { isInternalEmailRecipient } = require('../utils/internal-email-recipients');

const digestDisabled = () => ['1', 'true', 'on']
  .includes(String(process.env.AUTOPAY_SMS_DIGEST_DISABLED || '').toLowerCase());
const digestEmail = () => process.env.AUTOPAY_SMS_DIGEST_EMAIL || 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';
const adminPortalUrl = () => (process.env.ADMIN_PORTAL_URL || 'https://portal.wavespestcontrol.com').replace(/\/+$/, '');

// What counts as an autopay text mirrors the messaging wrapper's OWN
// definition (send-customer-message.js isAutopayCustomerSms — purpose
// 'autopay', or an entry point / original_message_type starting with
// 'autopay_'), so every site the wrapper gates as autopay — including the
// completion-time decline notice and its deferred replay (codex r3 P1) —
// is covered without this file keeping its own drifting list. The three
// send sites that carry none of those markers are named here explicitly.
const AUTOPAY_EXTRA_ENTRY_POINTS = [
  'monthly_billing_success',       // billing-cron.js — charge receipt
  'monthly_billing_failure',       // billing-cron.js — first failure
  'payment_expiry_workflow',       // workflows/payment-expiry.js
];

// Hard ceiling on the window when no marker exists (first run, or the
// marker row was lost) — never replay a month of history into one email.
const MAX_LOOKBACK_HOURS = 7 * 24;
const MAX_ROWS = 60;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function etStamp(date) {
  return new Date(date).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

async function loadSentAutopayTexts(since) {
  const { rows } = await db.raw(
    `
    SELECT COUNT(*) OVER () AS total_count,
           -- Whole-window mismatch count (codex r1): a non-monthly recipient
           -- beyond the display page must still escalate the subject.
           COUNT(*) FILTER (WHERE (CASE WHEN jsonb_exists(a.metadata, 'billing_mode_at_send') THEN a.metadata ->> 'billing_mode_at_send' ELSE cu.billing_mode END) IS DISTINCT FROM 'monthly_membership') OVER () AS mismatch_count,
           a.sent_at, a.entry_point, a.body_preview,
           a.metadata ->> 'original_message_type' AS message_type,
           a.customer_id,
           NULLIF(TRIM(COALESCE(cu.first_name, '') || ' ' || COALESCE(cu.last_name, '')), '') AS customer_name,
           -- Lane AT SEND TIME (codex r2): every autopay send site stamps
           -- billing_mode_at_send into the audit metadata; the live join is
           -- only a fallback for rows written before the stamp existed.
           -- Key PRESENCE decides (codex r3 P2): a stamped JSON null is a
           -- real "lane was NULL at send" and must not fall through to the
           -- customer's current lane.
           CASE WHEN jsonb_exists(a.metadata, 'billing_mode_at_send') THEN a.metadata ->> 'billing_mode_at_send' ELSE cu.billing_mode END AS billing_mode,
           CASE WHEN jsonb_exists(a.metadata, 'billing_mode_at_send') THEN 'at_send' ELSE 'live' END AS lane_source,
           cu.waveguard_tier, cu.monthly_rate
    FROM messaging_audit_log a
    LEFT JOIN customers cu ON cu.id = a.customer_id
    WHERE a.channel = 'sms'
      AND a.audience = 'customer'
      AND a.sent_at IS NOT NULL
      AND a.sent_at > :since
      AND (
        a.purpose = 'autopay'
        OR a.entry_point LIKE 'autopay\\_%'
        OR (a.metadata ->> 'original_message_type') LIKE 'autopay\\_%'
        OR a.entry_point = ANY(:extraEntryPoints)
      )
    ORDER BY a.sent_at DESC
    LIMIT :maxRows
    `,
    { since, extraEntryPoints: AUTOPAY_EXTRA_ENTRY_POINTS, maxRows: MAX_ROWS },
  );
  return rows;
}

// Pure composition: null = nothing went out (the common, quiet case).
function composeAutopaySmsDigest(rows) {
  const sends = (rows || []).filter(Boolean);
  if (!sends.length) return null;

  const total = Number(sends[0]?.total_count) > 0 ? Number(sends[0].total_count) : sends.length;
  const lines = sends.map((r) => {
    // FAIL CLOSED (codex r1): a send with no customer row has an UNKNOWN
    // lane — it cannot be vouched for as a monthly member, so it escalates.
    const laneValue = r.customer_id || r.lane_source === 'at_send' ? (r.billing_mode || 'NULL (inferred)') : 'unknown (no customer row)';
    const lane = r.lane_source === 'live' && r.customer_id ? `${laneValue} (lane as of now)` : laneValue;
    const mismatch = r.billing_mode !== 'monthly_membership';
    return {
      when: etStamp(r.sent_at),
      who: r.customer_name || '(no name on file)',
      type: r.message_type || r.entry_point || 'autopay',
      lane,
      tier: r.waveguard_tier || '—',
      rate: r.monthly_rate != null ? `$${Number(r.monthly_rate).toFixed(2)}/mo` : '',
      preview: String(r.body_preview || '').replace(/\s+/g, ' ').trim().slice(0, 110),
      mismatch,
      customerId: r.customer_id,
    };
  });
  const pageMismatches = lines.filter((l) => l.mismatch).length;
  const mismatches = Number(sends[0]?.mismatch_count) >= pageMismatches ? Number(sends[0].mismatch_count) : pageMismatches;

  const noun = `autopay text${total === 1 ? '' : 's'}`;
  const subject = mismatches > 0
    ? `FIX: ${mismatches} of ${total} ${noun} went to NON-monthly customers`
    : `FYI: ${total} ${noun} went out`;

  const describe = (l) => `${l.when} ${l.who} — ${l.type} · lane ${l.lane} · ${l.tier}${l.rate ? ` · ${l.rate}` : ''}${l.mismatch ? ' ⚠ NOT a monthly member' : ''}`;

  const text = [
    mismatches > 0
      ? `${mismatches} of ${total} autopay texts went to customers whose billing lane is not monthly_membership — they should not receive autopay texts. Check the recipients and the lane guard.`
      : `${total} autopay text${total === 1 ? '' : 's'} went out since the last notice. All recipients are monthly members.`,
    '',
    ...lines.map((l) => `- ${describe(l)}${l.preview ? `\n    "${l.preview}"` : ''}`),
    ...(total > lines.length ? [`…and ${total - lines.length} more not shown`] : []),
    '',
    `SMS log: ${adminPortalUrl()}/admin/communications`,
    'Templates (kill switch for every autopay text): ' + `${adminPortalUrl()}/admin/communications?tab=templates`,
  ].join('\n');

  const html = [
    mismatches > 0
      ? `<p><strong>${mismatches} of ${total}</strong> autopay texts went to customers whose billing lane is <strong>not</strong> monthly_membership — they should not receive autopay texts. Check the recipients and the lane guard.</p>`
      : `<p><strong>${total}</strong> autopay text${total === 1 ? '' : 's'} went out since the last notice. All recipients are monthly members.</p>`,
    `<ul style="margin:0 0 12px 18px;padding:0;">${lines.map((l) =>
      `<li style="margin:0 0 8px 0;${l.mismatch ? 'color:#b91c1c;' : ''}">${esc(l.when)} <strong>${esc(l.who)}</strong> — ${esc(l.type)} · lane <code>${esc(l.lane)}</code> · ${esc(l.tier)}${l.rate ? ` · ${esc(l.rate)}` : ''}${l.mismatch ? ' <strong>⚠ NOT a monthly member</strong>' : ''}${l.preview ? `<br><span style="color:#52525b;">“${esc(l.preview)}”</span>` : ''}</li>`,
    ).join('')}</ul>`,
    ...(total > lines.length ? [`<p>…and ${total - lines.length} more not shown</p>`] : []),
    `<p><a href="${esc(adminPortalUrl())}/admin/communications">Open SMS log</a> · <a href="${esc(adminPortalUrl())}/admin/communications?tab=templates">Autopay templates (kill switch)</a></p>`,
  ].join('\n');

  return { subject, text, html, count: total, mismatches };
}

// Marker-based window: everything sent after the last notice. No 20h guard
// here — two ticks a day are intended, and the marker makes the second one
// a no-op unless new texts landed in between.
const SEND_MARKER_KEY = 'autopay-sms-digest';

async function windowStart() {
  const floor = new Date(Date.now() - MAX_LOOKBACK_HOURS * 60 * 60 * 1000);
  try {
    const row = await db('ops_email_send_state').where({ email_key: SEND_MARKER_KEY }).first('last_sent_at');
    const marker = row?.last_sent_at ? new Date(row.last_sent_at) : null;
    return marker && marker > floor ? marker : floor;
  } catch (err) {
    logger.warn(`[autopay-sms-digest] send-marker read failed (${err.message}) — using the ${MAX_LOOKBACK_HOURS}h floor`);
    return floor;
  }
}

// The marker is stamped with the NEWEST sent_at in the batch, not "now": a
// text that lands between the query and the stamp would otherwise vanish
// from every future window.
async function stampSendMarker(newestSentAt) {
  try {
    const now = new Date();
    const at = newestSentAt ? new Date(newestSentAt) : now;
    await db('ops_email_send_state')
      .insert({ email_key: SEND_MARKER_KEY, last_sent_at: at, updated_at: now })
      .onConflict('email_key')
      .merge({ last_sent_at: at, updated_at: now });
  } catch (err) {
    logger.warn(`[autopay-sms-digest] send-marker write failed (${err.message}) — next tick may re-send`);
  }
}

async function runAutopaySmsDigest(opts = {}) {
  let rows;
  try {
    const since = await (opts.windowStart || windowStart)();
    rows = await (opts.loadRows || loadSentAutopayTexts)(since);
  } catch (err) {
    logger.error(`[autopay-sms-digest] query failed: ${err.message}`);
    return { skipped: 'query_failed' };
  }

  const composed = composeAutopaySmsDigest(rows);
  if (!composed) return { skipped: 'nothing_found' };

  if (digestDisabled()) {
    logger.info(`[autopay-sms-digest] disabled — would report ${composed.count} text(s)`);
    return { skipped: 'disabled', ...composed };
  }

  const mailer = opts.sendgrid || sendgrid;
  if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) {
    logger.warn('[autopay-sms-digest] mailer not configured — skipping send');
    return { skipped: 'unconfigured', ...composed };
  }

  // FAIL CLOSED: owner/internal inboxes only — the body names customers.
  const to = digestEmail();
  if (!isInternalEmailRecipient(to)) {
    logger.warn('[autopay-sms-digest] recipient is not an internal address — skipping send; set a valid AUTOPAY_SMS_DIGEST_EMAIL');
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
      categories: ['ops', 'autopay-sms-digest'],
      suppressErrorLog: true,
    });
  } catch (err) {
    logger.error(`[autopay-sms-digest] send failed (status ${Number.isInteger(err?.status) ? err.status : 'network'})`);
    return { sent: false, error: true, ...composed };
  }
  // rows are newest-first
  await (opts.stampSendMarker || stampSendMarker)(rows[0]?.sent_at);
  logger.info(`[autopay-sms-digest] sent: ${composed.count} autopay text(s), ${composed.mismatches} lane mismatch(es)`);
  return { sent: true, ...composed };
}

module.exports = {
  runAutopaySmsDigest,
  AUTOPAY_EXTRA_ENTRY_POINTS,
  _private: { composeAutopaySmsDigest },
};

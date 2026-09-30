'use strict';

// Rolling admin bell: customers whose address can't be geocoded properly and
// who therefore sit in the staff address-review queue, blocked from booking
// online (owner request 2026-09-29: "when an account or customer is not
// geocoded properly, I want to get an admin notification alert").
//
// Reuses the ops-digest rolling-count mechanism (admin-alerts-brevity /
// admin-alerts-ring, PRs #5236/#5269/#5282 — see promised-estimate-watcher.js
// and unworked-comms-watcher.js for the same shape): one standing bell row,
// refreshed in place. `itemKeys` carries the customer ids currently in the
// queue, so the bell rings again only when a NEW customer joins — a customer
// resolving just updates the count quietly, and an empty queue retires the
// row (ops-digest-fall-off.js).
//
// "In the queue" matches customer-geocode-review.js's listReviewQueue exactly
// (same query, same exclusions — a staff-confirmed outside_area with an
// unchanged address has already dropped out there); this sender additionally
// narrows to the three BLOCKING statuses a customer can be stuck in
// (needs_details, needs_pin, outside_area) — `pending`/`geocoded` rows the
// queue also lists are not yet a problem for staff to act on.
//
// Internal only: no customer communication of any kind. Runs every 15
// minutes (scheduler.js) and reads GATE_GEOCODE_REVIEW at call time — off,
// this is a no-op (no query, no bell, no email). Kill switch for the alert
// itself, independent of that gate: GEOCODE_REVIEW_ALERT_DISABLED=1.

const sendgrid = require('./sendgrid-mail');
const logger = require('./logger');
const db = require('../models/db');
const { deliverOpsDigest, inAppEnabled } = require('./ops-digest');
const { retireIfClean } = require('./ops-digest-fall-off');
const { isInternalEmailRecipient } = require('../utils/internal-email-recipients');

const watcherDisabled = () => ['1', 'true', 'on']
  .includes(String(process.env.GEOCODE_REVIEW_ALERT_DISABLED || '').toLowerCase());
const watcherEmail = () => process.env.GEOCODE_REVIEW_ALERT_EMAIL || 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';
const adminPortalUrl = () => (process.env.ADMIN_PORTAL_URL || 'https://portal.wavespestcontrol.com').replace(/\/+$/, '');

const KEY = 'geocode-review';
const DEDUPE_KEY = 'ops-digest:geocode-review';
const PAGE_SIZE = 200;

// The three statuses that actually stop a customer from booking online
// (docs/CLAUDE.md, customer-geocode-review.js's blocksAutomaticGeocode /
// reviewedCustomerLocation): a queue row sitting at `pending` (never
// attempted yet) or `geocoded` (an unverified automatic pin — usable, just
// not staff-confirmed) is not this bell's business.
const BLOCKING_STATUSES = ['needs_pin', 'needs_details', 'outside_area'];
const KIND_LABEL = { needs_pin: 'need a pin', needs_details: 'address incomplete', outside_area: 'outside service area' };
const STATUS_TEXT = { needs_pin: 'needs a pin', needs_details: 'address incomplete', outside_area: 'possibly outside the service area' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Every customer currently blocking on their address, paged through
// listReviewQueue exactly as the Customer 360 / directory queue reads it
// (same WHERE, same exclusions) — never re-derived here, so this bell can
// never disagree with what staff see in the queue.
async function loadBlockedReviews() {
  const reviewStore = require('./customer-geocode-review');
  if (!reviewStore.reviewEnabled()) return [];
  const blocked = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { records } = await reviewStore.listReviewQueue({ limit: PAGE_SIZE, offset });
    for (const rec of records || []) {
      const status = rec?.review?.status;
      if (BLOCKING_STATUSES.includes(status)) {
        blocked.push({
          customerId: rec.customer.id,
          name: [rec.customer.first_name, rec.customer.last_name].filter(Boolean).join(' ') || null,
          status,
        });
      }
    }
    if (!records || records.length < PAGE_SIZE) break;
  }
  return blocked;
}

// Pure composition: null = the queue holds no blocking rows (the common,
// quiet case).
function composeGeocodeReviewAlert(blocked) {
  const rows = (blocked || []).filter(Boolean);
  if (!rows.length) return null;
  const total = rows.length;

  const counts = { needs_pin: 0, needs_details: 0, outside_area: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;

  const subject = `ACT: ${total} customer${total === 1 ? '' : 's'} can't book online — address review needed`;
  // Admin-alerts-brevity scope (owner ruling 2026-09-28): short bell copy —
  // headline + one-line summary — the full list moves to `detail`.
  const headline = `Address review: ${total} customer${total === 1 ? '' : 's'} can't book online`;
  const summary = BLOCKING_STATUSES.filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${KIND_LABEL[k]}`)
    .join(' · ');

  const lines = rows.map((r) => `- ${r.name || 'Unknown customer'} — ${STATUS_TEXT[r.status] || r.status}`);
  const text = [
    `${total} customer${total === 1 ? '' : 's'} can't book online until staff resolve their address in the review queue.`,
    '',
    ...lines,
    '',
    `Address review queue: ${adminPortalUrl()}/admin/customers`,
  ].join('\n');
  const html = [
    `<p>${total} customer${total === 1 ? '' : 's'} can't book online until staff resolve their address in the review queue.</p>`,
    `<ul style="margin:0 0 12px 18px;padding:0;">${rows.map((r) =>
      `<li style="margin:0 0 6px 0;">${esc(r.name || 'Unknown customer')} — ${esc(STATUS_TEXT[r.status] || r.status)}</li>`,
    ).join('')}</ul>`,
    `<p><a href="${esc(adminPortalUrl())}/admin/customers">Open the address review queue</a></p>`,
  ].join('\n');

  // Item identity (admin-alerts-ring-v2): customer id + blocking status, so
  // the bell rings only when a key absent from the prior list appears — a
  // new customer landing in the queue, or one moving to a different problem
  // (needs a pin -> possibly outside the area), the same way
  // unworked-comms-watcher.js keys a task on its status. A customer
  // resolving (dropping the count) or a stable backlog never re-rings.
  // loadBlockedReviews already pages the WHOLE queue, so this is the full
  // set — no separate all_ids/total_count bookkeeping needed.
  const itemKeys = rows.map((r) => `${r.customerId}:${r.status}`);

  return { subject, text, html, count: total, headline, summary, itemKeys };
}

// Email-fallback throttle: deliverOpsDigest emails unconditionally whenever
// GATE_OPS_DIGESTS_IN_APP is off (its documented behavior — the bell path is
// the normal one, email is the fallback). This sender ticks every 15
// minutes; without a throttle, a standing backlog would re-email contact@
// every tick while the in-app gate is dark. The bell path itself is NEVER
// throttled — ring-only-on-change is ops-digest.js's own job.
const EMAIL_FALLBACK_KEY = 'geocode-review-alert-email-fallback';
const EMAIL_FALLBACK_WINDOW_MS = 20 * 60 * 60 * 1000;

async function emailFallbackRecently() {
  try {
    const row = await db('ops_email_send_state').where({ email_key: EMAIL_FALLBACK_KEY }).first('last_sent_at');
    return Boolean(row?.last_sent_at && (Date.now() - new Date(row.last_sent_at).getTime()) < EMAIL_FALLBACK_WINDOW_MS);
  } catch (err) {
    logger.warn(`[geocode-review-alert] email-fallback marker read failed (${err.message}) — proceeding without the guard`);
    return false;
  }
}

async function stampEmailFallback() {
  try {
    const now = new Date();
    await db('ops_email_send_state')
      .insert({ email_key: EMAIL_FALLBACK_KEY, last_sent_at: now, updated_at: now })
      .onConflict('email_key')
      .merge({ last_sent_at: now, updated_at: now });
  } catch (err) {
    logger.warn(`[geocode-review-alert] email-fallback marker write failed (${err.message})`);
  }
}

async function runGeocodeReviewAlert(opts = {}) {
  const reviewStore = require('./customer-geocode-review');
  if (!reviewStore.reviewEnabled()) return { skipped: 'gated_off' };

  let blocked;
  try {
    blocked = await (opts.loadBlockedReviews || loadBlockedReviews)();
  } catch (err) {
    logger.error(`[geocode-review-alert] query failed: ${err.message}`);
    return { skipped: 'query_failed' };
  }

  const composed = composeGeocodeReviewAlert(blocked);
  if (!composed) {
    await retireIfClean(KEY, { lockKey: DEDUPE_KEY }); // fall-off: nothing left blocking booking
    return { skipped: 'nothing_found' };
  }

  if (watcherDisabled()) {
    logger.info(`[geocode-review-alert] disabled — would post ${composed.count} customer(s)`);
    return { skipped: 'disabled', ...composed };
  }

  const appEnabled = (opts.inAppEnabled || inAppEnabled)();
  if (!appEnabled && await (opts.emailFallbackRecently || emailFallbackRecently)()) {
    return { skipped: 'recent_send', ...composed };
  }

  // The mailer and recipient checks guard the email fallback only:
  // deliverOpsDigest sends email only while the in-app bell is dark, so a
  // mail problem must never stop the bell itself from posting.
  const mailer = opts.sendgrid || sendgrid;
  const to = watcherEmail();
  if (!appEnabled) {
    if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) {
      logger.warn('[geocode-review-alert] mailer not configured — skipping send');
      return { skipped: 'unconfigured', ...composed };
    }
    // FAIL CLOSED: owner/internal inboxes only.
    if (!isInternalEmailRecipient(to)) {
      logger.warn('[geocode-review-alert] recipient is not an internal address — skipping send; set a valid GEOCODE_REVIEW_ALERT_EMAIL');
      return { skipped: 'recipient', ...composed };
    }
  }

  let result;
  try {
    result = await deliverOpsDigest({
      fallOff: true, // retired by retireIfClean once the queue is clean
      key: KEY,
      subject: composed.subject,
      html: composed.html,
      text: composed.text,
      headline: composed.headline,
      summary: composed.summary,
      count: composed.count,
      itemKeys: composed.itemKeys,
      link: '/admin/customers',
      // One standing row, refreshed in place (never a fresh row per tick):
      // the count/summary/itemKeys update quietly, and ops-digest.js's own
      // ring-only-on-change test decides whether this refresh re-bells.
      dedupeKey: DEDUPE_KEY,
      refreshOnDedupe: true,
      sendEmail: () => mailer.sendOne({
        to,
        fromEmail: fromEmail(),
        fromName: FROM_NAME,
        subject: composed.subject,
        html: composed.html,
        text: composed.text,
        categories: ['ops', 'geocode-review'],
        suppressErrorLog: true,
      }),
    });
  } catch (err) {
    logger.error(`[geocode-review-alert] send failed (status ${Number.isInteger(err?.status) ? err.status : 'network'})`);
    return { sent: false, error: true, ...composed };
  }
  if (!appEnabled) await (opts.stampEmailFallback || stampEmailFallback)();
  logger.info(`[geocode-review-alert] posted: ${composed.count} customer(s) blocked on address review`);
  return { sent: true, channel: result?.channel || null, ...composed };
}

module.exports = {
  runGeocodeReviewAlert,
  BLOCKING_STATUSES,
  _private: { composeGeocodeReviewAlert, loadBlockedReviews },
};

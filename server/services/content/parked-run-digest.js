/**
 * parked-run-digest.js — owner visibility email for SILENTLY parked
 * autonomous content runs (owner-authorized lane 2026-08-07).
 *
 * The email-approval flow (email-approvals.js) only emails the APPROVABLE
 * kinds (named_competitor_review | trust_build_*); everything else a run can
 * park as — gate_fail, publish_validation_failed, operator_slug_mismatch,
 * canary caps, … — lands on the admin review queue with no push signal at
 * all (prod 2026-08-07: 74 runs sitting in completed_pending_review the
 * owner had never seen). This module computes that parked set and emails an
 * ACT: rollup, grouped by skip_reason, with a deep link to the review queue
 * (/admin/blog?tab=autopilot — the AutonomousContentReviewPage embed).
 *
 * Visibility ONLY — this is not an approval surface: no tokens, no reply
 * parsing, no decisions, and it NEVER mutates run or opportunity state. Its
 * only write is its own send watermark in ops_email_send_state
 * (migration 20260806001000 — same durable-marker pattern as
 * turf-variance-digest), advanced ONLY after the email path confirms the
 * send (fail-CLOSED: a failed send leaves the watermark alone so the same
 * parks stay "new" next tick).
 *
 * Exception-based cadence (house rule): the daily cron tick SENDS only when
 * runs parked AFTER the last sent digest exist. Sundays additionally send a
 * full digest whenever the parked set is non-empty (so a stalled backlog
 * can't go quiet forever). No parks at all → never send.
 *
 * Buckets:
 *  - active: latest parked run per opportunity whose opportunity_queue row
 *    is still status='pending_review' — genuinely awaiting a decision.
 *    astro_pr_pending_merge runs are excluded: those were ALREADY approved
 *    (the opportunity deliberately stays pending_review while the PR poller
 *    owns them) and are not awaiting the owner.
 *  - stale: parked runs whose opportunity row is gone or already decided
 *    (done/skipped/expired/requeued) — probably dismissible, listed so the
 *    historical backlog is visible once instead of never.
 *
 * NO customer PII: items carry titles/queries/reasons only. reviewer_notes
 * are machine-written gate summaries (autonomous-runner), but excerpts are
 * defensively scrubbed of email/phone shapes anyway before the 120-char cut.
 *
 * Gate: parkedRunDigest (GATE_PARKED_RUN_DIGEST=true) — explicit opt-in in
 * EVERY environment, same posture as contentEmailApprovals: a dev server
 * must never email the real owner inbox. Cron wiring: daily 8:10am ET in
 * scheduler.js inside runExclusive.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { isInternalEmailRecipient } = require('../../utils/internal-email-recipients');

const SEND_MARKER_KEY = 'parked-run-digest';
const NOTE_EXCERPT_CHARS = 120;
const MAX_ITEMS_PER_GROUP = 8;

function digestEnabled() {
  const { isEnabled } = require('../../config/feature-gates');
  return isEnabled('parkedRunDigest');
}

function digestRecipient() {
  return String(process.env.PARKED_RUN_DIGEST_EMAIL || 'contact@wavespestcontrol.com').trim();
}

function adminPortalUrl() {
  return String(process.env.ADMIN_PORTAL_URL || 'https://portal.wavespestcontrol.com').replace(/\/+$/, '');
}

// The review queue's real client route: AutonomousContentReviewPage renders
// embedded in BlogPage under tab=autopilot (App.jsx routes /admin/blog;
// /admin/content-engine is a redirect to this URL). There is no per-item
// route — the queue page is the deep link.
function reviewQueueUrl() {
  return `${adminPortalUrl()}/admin/blog?tab=autopilot`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Defensive PII scrub for reviewer_notes excerpts. Notes are machine-written
 * gate summaries today, but a note that ever carries a contact shape must
 * not reach the email — scrub before truncating.
 */
function sanitizeNote(text) {
  return String(text || '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone]');
}

function noteExcerpt(notes) {
  const clean = sanitizeNote(notes).replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > NOTE_EXCERPT_CHARS ? `${clean.slice(0, NOTE_EXCERPT_CHARS)}…` : clean;
}

function draftTitle(draftPayload) {
  let payload = draftPayload;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = null; } }
  return payload?.title || payload?.frontmatter?.title || null;
}

function etDateString(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date);
}

function isSundayEt(date) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(date) === 'Sun';
}

function parkedAt(item) {
  const value = item.parked_at || item.completed_at || item.created_at;
  return value ? new Date(value) : null;
}

// ---------------------------------------------------------------------------
// Watermark (ops_email_send_state) — the digest's ONLY write.
// ---------------------------------------------------------------------------

async function getWatermark() {
  try {
    const row = await db('ops_email_send_state').where({ email_key: SEND_MARKER_KEY }).first('last_sent_at');
    return row?.last_sent_at ? new Date(row.last_sent_at) : null;
  } catch (err) {
    // Availability over dedupe (same call as turf-variance): a broken read
    // must not silence the digest — worst case the backlog re-sends once.
    logger.warn(`[parked-run-digest] watermark read failed (${err.message}) — treating as unset`);
    return null;
  }
}

async function advanceWatermark(sentAt) {
  try {
    await db('ops_email_send_state')
      .insert({ email_key: SEND_MARKER_KEY, last_sent_at: sentAt, updated_at: new Date() })
      .onConflict('email_key')
      .merge({ last_sent_at: sentAt, updated_at: new Date() });
  } catch (err) {
    logger.warn(`[parked-run-digest] watermark write failed (${err.message}) — next tick may re-send`);
  }
}

// ---------------------------------------------------------------------------
// Parked-set read model — strictly read-only over runs/opportunities.
// ---------------------------------------------------------------------------

async function loadParkedSet() {
  const rows = await db('autonomous_runs as r')
    .leftJoin('opportunity_queue as o', 'o.id', 'r.opportunity_id')
    .where('r.outcome', 'completed_pending_review')
    .where('r.shadow_mode', false)
    // Only the LATEST parked run per opportunity (same rule as the
    // email-approvals sweep): a requeue leaves the old run parked too, and
    // counting both would double-count one review item.
    .whereNotExists(function newerParkedRun() {
      this.select(db.raw('1')).from('autonomous_runs as r2')
        .whereRaw('r2.opportunity_id = r.opportunity_id')
        .where('r2.outcome', 'completed_pending_review')
        .where('r2.shadow_mode', false)
        .whereRaw('r2.created_at > r.created_at');
    })
    .orderBy('r.created_at', 'asc')
    .select(
      'r.id as run_id',
      'r.opportunity_id',
      'r.skip_reason',
      'r.reviewer_notes',
      'r.draft_payload',
      'r.created_at',
      'r.completed_at',
      'o.id as opp_id',
      'o.status as opp_status',
      'o.query',
    );

  // page_type lives on the latest content_brief per opportunity (same
  // latest-by-composed_at rule as autonomous-review-queue.listReviewItems).
  const oppIds = [...new Set(rows.map((r) => r.opportunity_id).filter(Boolean))];
  const pageTypes = new Map();
  if (oppIds.length) {
    try {
      const briefs = await db('content_briefs')
        .whereIn('opportunity_id', oppIds)
        .orderBy('composed_at', 'desc')
        .select('opportunity_id', 'page_type');
      for (const brief of briefs) {
        if (!pageTypes.has(brief.opportunity_id)) pageTypes.set(brief.opportunity_id, brief.page_type);
      }
    } catch (err) {
      // page_type is decoration — a briefs read failure must not hide parks.
      logger.warn(`[parked-run-digest] content_briefs read failed (${err.message}) — items render without page_type`);
    }
  }

  const active = [];
  const stale = [];
  for (const row of rows) {
    const item = {
      run_id: row.run_id,
      opportunity_id: row.opportunity_id,
      skip_reason: row.skip_reason || 'unspecified',
      title: draftTitle(row.draft_payload),
      query: row.query || null,
      page_type: row.opportunity_id ? pageTypes.get(row.opportunity_id) || null : null,
      parked_at: row.completed_at || row.created_at || null,
      note: noteExcerpt(row.reviewer_notes),
    };
    if (row.opp_id && row.opp_status === 'pending_review') {
      // Already approved in the portal — the PR poller owns it, not the
      // owner's review decision; it is not "awaiting a decision".
      if (row.skip_reason === 'astro_pr_pending_merge') continue;
      active.push(item);
    } else {
      // Opportunity gone or already decided (done/skipped/expired/requeued):
      // the run row parked forever with nothing waiting on it.
      item.opp_status = row.opp_id ? row.opp_status : 'gone';
      stale.push(item);
    }
  }
  return { active, stale };
}

// ---------------------------------------------------------------------------
// Composition — pure; null means nothing to say.
// ---------------------------------------------------------------------------

function groupBySkipReason(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.skip_reason)) groups.set(item.skip_reason, []);
    groups.get(item.skip_reason).push(item);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}

function itemHtml(item) {
  const url = reviewQueueUrl();
  const meta = [
    item.query ? `query: ${esc(item.query)}` : null,
    item.page_type ? esc(item.page_type) : null,
    item.parked_at ? `parked ${esc(String(etDateString(new Date(item.parked_at))))}` : null,
    item.opp_status ? `opportunity ${esc(item.opp_status)}` : null,
  ].filter(Boolean).join(' · ');
  return [
    `<li style="margin:0 0 8px 0;">`,
    `<a href="${esc(url)}"><strong>${esc(item.title || item.query || '(untitled draft)')}</strong></a>`,
    meta ? `<br/><span style="color:#555;font-size:13px;">${meta}</span>` : '',
    item.note ? `<br/><span style="color:#777;font-size:13px;">${esc(item.note)}</span>` : '',
    `</li>`,
  ].join('');
}

function groupsHtml(items) {
  return groupBySkipReason(items).map(([reason, groupItems]) => {
    const shown = groupItems.slice(0, MAX_ITEMS_PER_GROUP);
    const more = groupItems.length - shown.length;
    return [
      `<p style="margin:18px 0 6px 0;"><strong>${esc(reason)}</strong> (${groupItems.length})</p>`,
      `<ul style="margin:0 0 4px 18px;padding:0;">${shown.map(itemHtml).join('')}</ul>`,
      more > 0 ? `<p style="margin:0 0 4px 18px;color:#777;font-size:13px;">…and ${more} more in this group.</p>` : '',
    ].join('\n');
  }).join('\n');
}

function composeParkedRunDigest({ active = [], stale = [], newCount = 0 } = {}) {
  const total = active.length + stale.length;
  if (total === 0) return null;
  const subject = `ACT: ${total} content drafts parked for review (${newCount} new since last digest)`;
  const url = reviewQueueUrl();
  const bodyHtml = [
    `<p>${total} autonomous content run${total === 1 ? ' is' : 's are'} parked as completed_pending_review`
      + ` — ${newCount} new since the last digest. These parked silently: only`
      + ` named-competitor/trust-build kinds get per-item approval emails; everything below`
      + ` waits on the review queue.</p>`,
    `<p><a href="${esc(url)}"><strong>Open the review queue</strong></a></p>`,
    active.length
      ? `<p style="margin:22px 0 2px 0;font-size:16px;"><strong>Awaiting your decision (${active.length})</strong></p>\n${groupsHtml(active)}`
      : '',
    stale.length
      ? `<p style="margin:22px 0 2px 0;font-size:16px;"><strong>Stale — probably dismissible (${stale.length})</strong></p>`
        + `<p style="margin:2px 0 6px 0;color:#555;font-size:13px;">Parked runs whose opportunity was already decided or removed — nothing is waiting on them.</p>\n${groupsHtml(stale)}`
      : '',
    `<p style="color:#666;font-size:13px;margin-top:20px;">This digest is visibility only — decisions happen in the portal. It sends when new runs park (plus a Sunday summary while the backlog is non-empty).</p>`,
  ].filter(Boolean).join('\n');
  return { subject, bodyHtml, total, activeCount: active.length, staleCount: stale.length, newCount };
}

// ---------------------------------------------------------------------------
// Runner (cron entrypoint) — fail-soft on read, fail-CLOSED on send.
// ---------------------------------------------------------------------------

async function runParkedRunDigest(opts = {}) {
  if (!(opts.digestEnabled || digestEnabled)()) return { skipped: 'gate_off' };

  // Captured BEFORE the read so runs parking mid-tick stay "new" next tick.
  const now = opts.now ? new Date(opts.now) : new Date();

  let parkedSet;
  try {
    parkedSet = await (opts.loadParkedSet || loadParkedSet)();
  } catch (err) {
    logger.error(`[parked-run-digest] parked-set query failed: ${err.message}`);
    return { skipped: 'query_failed' };
  }
  const { active = [], stale = [] } = parkedSet || {};
  if (active.length + stale.length === 0) return { skipped: 'no_parked_runs' };

  const watermark = await (opts.getWatermark || getWatermark)();
  const isNew = (item) => {
    if (!watermark) return true;
    const at = parkedAt(item);
    return !!at && at > watermark;
  };
  const newCount = [...active, ...stale].filter(isNew).length;

  // Exception-based cadence: daily sends need NEW parks; Sundays send the
  // full digest anyway while the set is non-empty (never twice in one ET day
  // — deploy-overlap ticks re-enter after runExclusive releases).
  const sentTodayEt = !!watermark && etDateString(watermark) === etDateString(now);
  const weeklyFull = isSundayEt(now) && !sentTodayEt;
  if (newCount === 0 && !weeklyFull) return { skipped: 'no_new_parks' };
  if (newCount > 0 && sentTodayEt) return { skipped: 'already_sent_today' };

  const composed = composeParkedRunDigest({ active, stale, newCount });
  if (!composed) return { skipped: 'nothing_to_compose' };

  // FAIL CLOSED on recipient: internal inboxes only — a mis-set env must
  // skip, never push the content backlog outward.
  const to = digestRecipient();
  if (!isInternalEmailRecipient(to)) {
    logger.warn('[parked-run-digest] recipient is not an internal address — skipping send; fix PARKED_RUN_DIGEST_EMAIL');
    return { skipped: 'recipient' };
  }

  // Same internal email path email-approvals uses (services/email.js —
  // Google Workspace SMTP from contact@). Returns { ok, error? }.
  const mailer = opts.email || require('../email');
  let result;
  try {
    result = await mailer.send({
      to,
      subject: composed.subject,
      heading: 'Parked content drafts',
      body: composed.bodyHtml,
    });
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  if (!result || result.ok === false) {
    // Fail CLOSED: the watermark does NOT advance — these parks stay "new"
    // and the next tick retries the send.
    logger.error(`[parked-run-digest] send failed: ${result?.error || 'unknown error'} — watermark not advanced`);
    return { sent: false, error: result?.error || 'send failed', ...composed };
  }

  await (opts.advanceWatermark || advanceWatermark)(now);
  logger.info(`[parked-run-digest] sent: ${composed.total} parked (${composed.activeCount} active, ${composed.staleCount} stale, ${composed.newCount} new)`);
  return { sent: true, ...composed };
}

module.exports = {
  runParkedRunDigest,
  loadParkedSet,
  _private: { composeParkedRunDigest, sanitizeNote, noteExcerpt, groupBySkipReason, reviewQueueUrl, SEND_MARKER_KEY },
};

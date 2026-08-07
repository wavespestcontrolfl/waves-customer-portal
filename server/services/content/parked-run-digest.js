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
 *  - active: every opportunity_queue row at status='pending_review', paired
 *    with its latest run (the portal review queue's own read model) —
 *    genuinely awaiting a decision WHATEVER outcome the run
 *    finalized with (fail-closed paths park with skipped_gate_fail, not
 *    completed_pending_review, and still route to pending_review).
 *    astro_pr_pending_merge runs are excluded: those were ALREADY approved
 *    (the opportunity deliberately stays pending_review while the PR poller
 *    owns them) and are not awaiting the owner.
 *  - stale: parked runs whose opportunity row is gone or already decided
 *    (done/skipped/expired/requeued) — probably dismissible, listed so the
 *    historical backlog is visible once instead of never.
 *
 * NO customer PII: titles, queries, AND reviewer_note excerpts all pass
 * through the canonical pii-redactor with a fail-closed confidence gate —
 * when the redactor reports 'low' confidence it deliberately returns the
 * ORIGINAL text (its heuristics were blind, e.g. all-lowercase prose), so
 * such values are WITHHELD from the email entirely rather than emailed raw.
 * On top of that, email-strict mode withholds any value with a STRUCTURED
 * finding (phone/email/address/…): such text is customer contact material,
 * and the redactor can miss a short lowercase name right next to the
 * redacted token while still reporting an emailable confidence.
 * reviewer_notes matter here because autonomous-runner embeds generated
 * copy (which can repeat customer names/addresses from the brief) in them.
 * Over-redaction is acceptable in this internal visibility email.
 *
 * Gate: parkedRunDigest (GATE_PARKED_RUN_DIGEST=true) — explicit opt-in in
 * EVERY environment, same posture as contentEmailApprovals: a dev server
 * must never email the real owner inbox. Cron wiring: daily 8:10am ET in
 * scheduler.js inside runExclusive.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { isInternalEmailRecipient } = require('../../utils/internal-email-recipients');
const { etDateString, etParts } = require('../../utils/datetime-et');
// Shared classifier — kinds email-approvals already covers with per-item
// approval emails; the digest excludes them (one decision, one notification).
const { isApprovableKind } = require('./email-approvals');
// The comprehensive redactor — opportunity_queue.query and draft titles can
// carry customer-derived text (the runner documents PII in query for some
// lanes). Over-redaction is harmless in an internal visibility email, so
// its known title-case false positives are acceptable HERE (unlike the
// hard publish gates, where they park legitimate drafts).
const piiRedactor = require('./pii-redactor');

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

// Confidences whose redacted text may be emailed. 'low' is the redactor's
// fail-closed signal that its heuristics could NOT be trusted on this text —
// for all-lowercase prose ("john smith needs roach control at his rental…")
// redact() intentionally returns the ORIGINAL text with confidence 'low', so
// emailing .text without checking would break the no-customer-PII contract.
const EMAILABLE_CONFIDENCE = new Set(['high', 'medium']);

// Neutral placeholder when a reviewer note exists but cannot be confidently
// redacted — the owner still sees that a note is waiting in the portal.
const NOTE_WITHHELD = '[note withheld — could not redact confidently]';

function redactForEmail(value) {
  if (!value) return null;
  try {
    const { text, confidence, findings } = piiRedactor.redact(String(value));
    // Fail closed on the redactor's own uncertainty signal: withhold the
    // value rather than emailing text the heuristics were blind to.
    if (!EMAILABLE_CONFIDENCE.has(confidence)) return null;
    // Email-strict mode (Codex r4): confidence alone does not establish the
    // no-customer-PII contract. Any STRUCTURED finding (phone/email/address/
    // card/…) proves the value is customer contact material, and the
    // redactor's lowercase-name pass can miss a short name sitting right
    // next to the redacted token while still reporting an emailable
    // confidence ("jane doe, call [phone]" → high) — so removal of the
    // neighbors cannot be established and the whole value is withheld.
    // Name-only findings remain emailable: there the finding IS the
    // completed redaction ([name] substituted), and the standalone
    // capitalized-pair heuristic fires on ordinary Title-Case draft titles
    // ("Termite Damage [name] for Sarasota Homes") — withholding on it
    // would blank nearly every title in the digest.
    if (findings.some((f) => f.type !== 'name')) return null;
    return text;
  } catch {
    return null; // redactor failure → omit, never emit raw
  }
}

/**
 * Reviewer_notes excerpts go through the SAME canonical redactor + confidence
 * gate as queries/titles — autonomous-runner embeds generated copy (which can
 * repeat customer names and street addresses from the brief) in
 * reviewer_notes, and the old hand-written email/phone scrub missed those
 * shapes. Low confidence or a redactor throw → neutral placeholder, never the
 * raw note.
 */
function noteExcerpt(notes) {
  const raw = String(notes || '').trim();
  if (!raw) return null;
  const redacted = redactForEmail(raw);
  if (redacted === null) return NOTE_WITHHELD;
  const clean = redacted.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > NOTE_EXCERPT_CHARS ? `${clean.slice(0, NOTE_EXCERPT_CHARS)}…` : clean;
}

function draftTitle(draftPayload) {
  let payload = draftPayload;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = null; } }
  return payload?.title || payload?.frontmatter?.title || null;
}

// Canonical ET calendar helpers (utils/datetime-et) — a second local ET
// mechanism drifted from the app's on Intl edge cases (Codex r1).
function isSundayEt(date) {
  return etParts(date).dayOfWeek === 0;
}

function parkedAt(item) {
  const value = item.parked_at || item.completed_at || item.created_at;
  return value ? new Date(value) : null;
}

// When an ACTIVE item became digest-eligible — the moment the row entered
// its CURRENT review state, not the run's original completion. The
// named-competitor janitor converts a stuck publish back into an actionable
// review item by rewriting the RUN's outcome/skip_reason/updated_at (both
// janitor paths bump run.updated_at) while deliberately preserving the old
// completed_at — dating the converted item by completion would land it
// behind the watermark and keep the interruption silent until Sunday
// (Codex r4). opp.updated_at is deliberately NOT consulted when a run
// exists: the daily miner upsert re-touches pending_review rows (status
// preserved by its CASE, updated_at = now()), so an unchanged backlog
// would re-classify as "new" every morning and defeat the watermark.
function activeParkedAt(run, opp) {
  if (run) {
    const value = run.updated_at || run.completed_at || run.created_at;
    return value ? new Date(value) : null;
  }
  // Run-less pending_review rows: completed_at is stamped by the review
  // transition (e.g. the janitor's opportunity path) and never touched by
  // the miner upsert; created_at as last resort.
  const value = opp?.completed_at || opp?.created_at;
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
  // ACTIVE — mirror the portal review queue's read model
  // (autonomous-review-queue.listReviewItems): every opportunity sitting at
  // status='pending_review', paired with its LATEST run (claimed_at desc,
  // the queue's exact latest-run rule), whatever outcome that run
  // finalized with. Keying the active set off
  // outcome='completed_pending_review' alone silently dropped the
  // fail-closed engine paths that park with outcome='skipped_gate_fail'
  // (claims-ledger/guardrails unavailable, refresh-load failures) yet still
  // route the opportunity to pending_review via _pendingReviewClaimOrThrow
  // (Codex r4).
  const activeOpps = await db('opportunity_queue')
    .where('status', 'pending_review')
    .orderBy('created_at', 'asc')
    .select('id', 'status', 'skip_reason', 'query', 'completed_at', 'created_at');
  const runsByOpp = new Map();
  if (activeOpps.length) {
    // Same latest-run selection as the review queue (claimed_at desc, NO
    // shadow filter) — filtering shadow runs here could pick an OLDER live
    // run than the one the portal shows and classify the item off stale
    // state (Codex r4 pre-push audit).
    const runRows = await db('autonomous_runs')
      .whereIn('opportunity_id', activeOpps.map((o) => o.id))
      .orderBy('claimed_at', 'desc')
      .select('id', 'opportunity_id', 'skip_reason', 'reviewer_notes', 'draft_payload', 'created_at', 'completed_at', 'updated_at');
    for (const row of runRows) {
      if (!runsByOpp.has(row.opportunity_id)) runsByOpp.set(row.opportunity_id, row);
    }
  }

  // STALE — parked runs whose opportunity is gone or already decided
  // (done/skipped/expired/requeued): the run row parked forever with
  // nothing waiting on it. Pending-review opportunities are the active
  // path's territory and are excluded here.
  const staleRows = await db('autonomous_runs as r')
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
    .where(function oppGoneOrDecided() {
      this.whereNull('o.id').orWhereNot('o.status', 'pending_review');
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
  const oppIds = [...new Set([
    ...activeOpps.map((o) => o.id),
    ...staleRows.map((r) => r.opportunity_id).filter(Boolean),
  ])];
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
  for (const opp of activeOpps) {
    const run = runsByOpp.get(opp.id) || null;
    const skipReason = run?.skip_reason || opp.skip_reason || 'unspecified';
    // Approvable kinds are email-approvals' territory (per-item approval
    // emails) — one decision, one notification (Codex r1/r2).
    if (isApprovableKind(skipReason)) continue;
    // Already approved in the portal — the PR poller owns it, not the
    // owner's review decision; it is not "awaiting a decision".
    if (skipReason === 'astro_pr_pending_merge') continue;
    active.push({
      run_id: run ? run.id : null,
      opportunity_id: opp.id,
      skip_reason: skipReason,
      title: run ? redactForEmail(draftTitle(run.draft_payload)) : null,
      query: redactForEmail(opp.query || null),
      page_type: pageTypes.get(opp.id) || null,
      parked_at: activeParkedAt(run, opp),
      note: run ? noteExcerpt(run.reviewer_notes) : null,
    });
  }

  const stale = [];
  for (const row of staleRows) {
    // Same approvable exclusion on the stale side: a dismissed or decided
    // approvable run must not resurface here and double-notify one
    // decision (Codex r2).
    if (isApprovableKind(row.skip_reason)) continue;
    stale.push({
      run_id: row.run_id,
      opportunity_id: row.opportunity_id,
      skip_reason: row.skip_reason || 'unspecified',
      title: redactForEmail(draftTitle(row.draft_payload)),
      query: redactForEmail(row.query || null),
      page_type: row.opportunity_id ? pageTypes.get(row.opportunity_id) || null : null,
      // Stale rows keep the run's own park time — updated_at gets bumped by
      // decision stamps, and dating a dismissed run to its dismissal would
      // resurface it as "new" stale right after every portal decision.
      parked_at: row.completed_at || row.created_at || null,
      note: noteExcerpt(row.reviewer_notes),
      opp_status: row.opp_id ? row.opp_status : 'gone',
    });
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
  const { active = [], stale: staleAll = [] } = parkedSet || {};

  const watermark = await (opts.getWatermark || getWatermark)();
  const isNew = (item) => {
    if (!watermark) return true;
    const at = parkedAt(item);
    return !!at && at > watermark;
  };
  // Stale rows are surfaced ONCE: the whole backlog on the first digest
  // (no watermark), then only rows that parked after the last sent digest.
  // The portal review queue only lists pending_review opportunities, so a
  // dismissed run's row can never be cleared there — without this filter
  // the Sunday full digest would resend the same stale rows forever
  // (Codex r1).
  const stale = staleAll.filter(isNew);
  if (active.length + stale.length === 0) return { skipped: 'no_parked_runs' };
  const newCount = [...active, ...stale].filter(isNew).length;

  // Exception-based cadence: daily sends need NEW parks; Sundays send the
  // full digest anyway while ACTIONABLE (active) rows exist (never twice in
  // one ET day — deploy-overlap ticks re-enter after runExclusive releases).
  const sentTodayEt = !!watermark && etDateString(watermark) === etDateString(now);
  const weeklyFull = isSundayEt(now) && !sentTodayEt && active.length > 0;
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
  _private: { composeParkedRunDigest, noteExcerpt, groupBySkipReason, reviewQueueUrl, redactForEmail, activeParkedAt, NOTE_WITHHELD, SEND_MARKER_KEY },
};

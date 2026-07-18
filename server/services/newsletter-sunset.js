/**
 * Newsletter inactivity sunset — the list-hygiene lane from the 2026-07-17
 * deliverability audit: flag long-inactive readers, park a win-back campaign
 * for the owner to approve, then suppress the ones who still don't respond.
 *
 * Weekly (Mon 7:30am ET, scheduler.js), dark behind GATE_NEWSLETTER_SUNSET
 * (default off; unset the var to kill). The job NEVER sends email — the
 * win-back it stages is a normal draft in /admin/newsletter that the owner
 * edits and fires through the existing send flow. Four phases, in order:
 *
 *   A. RECOVER — flagged subscribers who CONFIRMED (stay-subscribed quiz
 *      submit) since flagging lose the 'reengagement_due' tag, and sunset
 *      ('inactive') subscribers who confirm after deactivation reactivate.
 *      Post-flag decisions run on quiz_answered_at ONLY — raw opens/clicks
 *      can be scanner prefetches, and the win-back copy's contract is
 *      explicit: confirm, or the emails stop. (The pre-flag inactivity
 *      clock stays generous: any open/click/quiz counts, so scanner noise
 *      merely delays flagging.)
 *   B. FLAG — active subscribers with ≥MIN_DELIVERED_SENDS delivered
 *      campaigns, the earliest ≥INACTIVITY_DAYS old, and zero engagement
 *      inside INACTIVITY_DAYS get tagged + stamped. A safety valve pauses
 *      the whole run (alert, no writes) when the FLAG + SUNSET cohorts
 *      together are an implausibly large share of the list — a tracking
 *      outage or criteria bug reads as "everyone went quiet" and must not
 *      mass-flag OR mass-suppress (an outage that starts after the win-back
 *      delivers would otherwise valve at 0 flag candidates while the whole
 *      flagged cohort sails into sunset).
 *   C. STAGE — if flagged subscribers are still awaiting a win-back and no
 *      reengagement-type send is open, insert ONE parked draft targeting the
 *      tag (segment_filter { tags: [REENGAGEMENT_TAG] }).
 *   D. SUNSET — flagged subscribers whose win-back was DELIVERED ≥GRACE_DAYS
 *      ago (after their flag date) with still-zero engagement flip to
 *      status='inactive' — suppressed, not deleted: buildSubscriberQuery's
 *      status='active' filter excludes them from every future send, and
 *      subscribeOrResubscribe reactivates them through double-opt-in if they
 *      ever come back.
 *
 * Engagement = newsletter_send_deliveries.opened_at / clicked_at /
 * quiz_answered_at — the three signals the SendGrid webhook + quiz routes
 * stamp. Hard bounces / spam complaints are NOT this lane's job: the
 * suppression ledger (email_suppressions + excludeGloballySuppressed)
 * already blocks those on every send path.
 */

const db = require('../models/db');
const logger = require('./logger');

const MIN_DELIVERED_SENDS = 6;
const INACTIVITY_DAYS = 90;
const GRACE_DAYS = 30;
// Safety valve: pausing beats purging. Both bounds must trip — a small list
// (< MIN_VALVE_COUNT eligible) never valves, and a large cohort only valves
// when it exceeds MAX_FLAG_FRACTION of the active list.
const MAX_FLAG_FRACTION = 0.3;
const MIN_VALVE_COUNT = 25;
const REENGAGEMENT_TAG = 'reengagement_due';
const REENGAGEMENT_TYPE = 'reengagement';
const SUNSET_REASON = 'sunset_inactive_90d';
const ALERT_TYPE = 'newsletter_sunset';
const ALERT_DEDUPE_KEY = 'newsletter_sunset_weekly';

const DAY_MS = 24 * 60 * 60 * 1000;

function gateEnabled() {
  return process.env.GATE_NEWSLETTER_SUNSET === 'true';
}

function safetyValveTripped(candidateCount, activeCount) {
  if (candidateCount < MIN_VALVE_COUNT) return false;
  if (!activeCount) return false;
  return candidateCount / activeCount > MAX_FLAG_FRACTION;
}

// Correlated EXISTS body: this subscriber has an engagement signal newer than
// `after`. Pass a Date to compare against a fixed instant, or one of the
// literal strings 'flagged_at' / 'deactivated_at' to compare against the
// subscriber's OWN reengagement_flagged_at / deactivated_at column.
// opts.signals: 'all' (default — opens/clicks/quiz, the inactivity clock) or
// 'quiz' (a stay-subscribed-v1 quiz confirm ONLY — the deliberate,
// scanner-proof consent the win-back copy promises; answering some other
// quiz from an old issue is engagement for the clock, but it is not the
// promised "keep me on the list" action).
const AFTER_COLUMNS = {
  flagged_at: 'newsletter_subscribers.reengagement_flagged_at',
  deactivated_at: 'newsletter_subscribers.deactivated_at',
};
function engagementSubquery(after, { signals = 'all' } = {}) {
  const cols = signals === 'quiz'
    ? ['quiz_answered_at']
    : ['opened_at', 'clicked_at', 'quiz_answered_at'];
  return function () {
    this.select(db.raw('1'))
      .from('newsletter_send_deliveries as eng')
      .whereRaw('eng.subscriber_id = newsletter_subscribers.id')
      .where(function () {
        const col = AFTER_COLUMNS[after];
        for (const c of cols) {
          if (col) this.orWhereRaw(`eng.${c} > ${col}`);
          else this.orWhere(`eng.${c}`, '>', after);
        }
      });
    if (signals === 'quiz') this.where('eng.quiz_id', WINBACK_QUIZ_ID);
  };
}

// Phase A — flagged subscribers who CONFIRMED since flagging get un-flagged.
// quiz_answered_at only: the win-back copy's contract is "confirm or we stop",
// and scanner-prefetched opens/clicks on the tracked links must not count as
// a response (they'd exempt exactly the scanner-heavy inboxes where dead
// addresses accumulate). The confirm write comes from OUR public route, not a
// SendGrid webhook, so it is also immune to provider-webhook outages.
async function recoverEngagedFlagged(now) {
  const ids = (
    await db('newsletter_subscribers')
      .where({ status: 'active' })
      .whereNotNull('reengagement_flagged_at')
      .whereExists(engagementSubquery('flagged_at', { signals: 'quiz' }))
      .select('id')
  ).map((r) => r.id);
  if (!ids.length) return 0;
  await db('newsletter_subscribers').whereIn('id', ids).update({
    tags: db.raw("COALESCE(tags, '[]'::jsonb) - ?", [REENGAGEMENT_TAG]),
    reengagement_flagged_at: null,
    updated_at: now,
  });
  return ids.length;
}

// Phase A (comeback half) — sunset subscribers who CONFIRM after their
// deactivation (a late stay-subscribed quiz submit) come back to 'active'
// with the hygiene markers cleared, honoring the win-back CTA's promise even
// when the confirm lands after the grace job ran. Consent here is
// quiz_answered_at ONLY: raw opened_at/clicked_at can be produced by
// Safe-Links-style scanners prefetching an old email, and a scanner must not
// resurrect a suppressed address. Safe to run unconditionally: reactivation
// requires a PRESENT deliberate signal, so a tracking outage (missing
// signals) can't mass-fire it.
async function reactivateSunsetComebacks(now) {
  const ids = (
    await db('newsletter_subscribers')
      .where({ status: 'inactive', deactivated_reason: SUNSET_REASON })
      .whereNotNull('deactivated_at')
      .whereExists(engagementSubquery('deactivated_at', { signals: 'quiz' }))
      .select('id')
  ).map((r) => r.id);
  if (!ids.length) return 0;
  await db('newsletter_subscribers')
    .whereIn('id', ids)
    .where({ status: 'inactive', deactivated_reason: SUNSET_REASON })
    .update({
      status: 'active',
      deactivated_at: null,
      deactivated_reason: null,
      reengagement_flagged_at: null,
      updated_at: now,
    });
  return ids.length;
}

// Phase B candidates — active, not already flagged, globally-suppressed
// excluded, ≥MIN_DELIVERED_SENDS delivered campaigns with the earliest at
// least INACTIVITY_DAYS old, and zero engagement inside INACTIVITY_DAYS.
// The delivered-history gate is what makes the job inert until real send
// history accumulates: nobody can be flagged during the first-campaign ramp.
async function findFlagCandidates(now) {
  const { excludeGloballySuppressed } = require('./newsletter-sender');
  const cutoff = new Date(now.getTime() - INACTIVITY_DAYS * DAY_MS);
  const rows = await excludeGloballySuppressed(
    db('newsletter_subscribers')
      .where({ status: 'active' })
      .whereNull('reengagement_flagged_at')
      .whereRaw("NOT (COALESCE(tags, '[]'::jsonb) @> ?::jsonb)", [JSON.stringify([REENGAGEMENT_TAG])])
      .whereNotExists(engagementSubquery(cutoff))
      // Delivered-history gate, bounded to the CURRENT subscription episode:
      // a resubscribed comeback keeps their old delivery rows, and lifetime
      // counting would re-flag them on the next weekly run before a single
      // post-resubscribe newsletter went out. GREATEST over the three
      // episode-start stamps (any may be NULL).
      .whereExists(function () {
        this.select(db.raw('1'))
          .from('newsletter_send_deliveries as hist')
          .whereRaw('hist.subscriber_id = newsletter_subscribers.id')
          .whereNotNull('hist.delivered_at')
          .whereRaw(`hist.delivered_at >= GREATEST(
            COALESCE(newsletter_subscribers.subscribed_at, '-infinity'::timestamptz),
            COALESCE(newsletter_subscribers.resubscribed_at, '-infinity'::timestamptz),
            COALESCE(newsletter_subscribers.confirmed_at, '-infinity'::timestamptz))`)
          .groupBy('hist.subscriber_id')
          .havingRaw('COUNT(*) >= ?', [MIN_DELIVERED_SENDS])
          .havingRaw('MIN(hist.delivered_at) <= ?', [cutoff]);
      }),
  ).select('id');
  return rows.map((r) => r.id);
}

async function applyFlags(ids, now) {
  if (!ids.length) return 0;
  // status guard: a subscriber who unsubscribed between the candidate SELECT
  // and this UPDATE must not get re-touched.
  await db('newsletter_subscribers').whereIn('id', ids).where({ status: 'active' }).update({
    // remove-then-append = idempotent tag add without duplicates.
    tags: db.raw("(COALESCE(tags, '[]'::jsonb) - ?) || ?::jsonb", [REENGAGEMENT_TAG, JSON.stringify([REENGAGEMENT_TAG])]),
    reengagement_flagged_at: now,
    updated_at: now,
  });
  return ids.length;
}

// Owner-editable draft the STAGE phase parks. Chrome (header/footer/
// unsubscribe link) is added by wrapNewsletter at send time; this is the
// operator body only. The CTA is the stay-subscribed QUIZ block — the quiz
// flow's GET-renders / POST-mutates confirm page is scanner-safe (Safe
// Links/Mimecast prefetchers fire raw click events, but only a deliberate
// confirm submit stamps quiz_answered_at, the signal reactivation trusts).
// Copy rules: sign-off per newsletter voice, no prices, no safety/efficacy
// claims.
const WINBACK_QUIZ_ID = 'stay-subscribed-v1';
const WINBACK_SUBJECT = 'Should we keep sending you these?';
const WINBACK_HTML = [
  '<p>Hi{{greeting-name}},</p>',
  "<p>It's been a while since you've opened one of these, so we're checking in before we keep filling your inbox.</p>",
  "<p>If you'd like to keep getting our local events guide and lawn &amp; pest tips, tap below and confirm — that's it:</p>",
  `{{quiz:${WINBACK_QUIZ_ID}}}`,
  "<p>If not, no hard feelings — use the unsubscribe link below, or simply do nothing and we'll stop sending after this note.</p>",
  '<p>— The Waves Pest Control Team</p>',
].join('\n');
const WINBACK_TEXT = [
  'Hi{{greeting-name}},',
  '',
  "It's been a while since you've opened one of these, so we're checking in before we keep filling your inbox.",
  '',
  "Want to keep getting our local events guide and lawn & pest tips? Open the link below and confirm — that's it:",
  `{{quiz-text:${WINBACK_QUIZ_ID}}}`,
  '',
  "If not, no hard feelings — use the unsubscribe link below, or simply do nothing and we'll stop sending after this note.",
  '',
  '— The Waves Pest Control Team',
].join('\n');

function buildWinbackDraftRow() {
  return {
    subject: WINBACK_SUBJECT,
    subject_b: null,
    html_body: WINBACK_HTML,
    text_body: WINBACK_TEXT,
    preview_text: "One click keeps you on the list — otherwise we'll quietly stop.",
    from_name: 'Waves Pest Control',
    from_email: 'newsletter@wavespestcontrol.com',
    reply_to: 'contact@wavespestcontrol.com',
    status: 'draft',
    segment_filter: { tags: [REENGAGEMENT_TAG] },
    newsletter_type: REENGAGEMENT_TYPE,
    // slug stays null — the public archive falls back to send.id, and the
    // owner usually rewords the subject before sending anyway.
    created_by: null,
    // List hygiene, not content — never auto-share a win-back to social, and
    // keep it out of search engines if its archive URL ever leaks (the public
    // feed/archive/RSS surfaces also exclude the type entirely).
    auto_share_social: false,
    indexability: 'noindex',
    event_ids: JSON.stringify([]),
  };
}

// Phase C — how many flagged actives have NOT yet received a win-back sent
// after their flag date, and stage one draft for them if none is open.
async function cohortAwaitingWinback() {
  const row = await db('newsletter_subscribers')
    .where({ status: 'active' })
    .whereNotNull('reengagement_flagged_at')
    .whereNotExists(function () {
      this.select(db.raw('1'))
        .from('newsletter_send_deliveries as wd')
        .join('newsletter_sends as ws', 'ws.id', 'wd.send_id')
        .whereRaw('wd.subscriber_id = newsletter_subscribers.id')
        .where('ws.newsletter_type', REENGAGEMENT_TYPE)
        .whereNotNull('wd.sent_at')
        .whereRaw('wd.sent_at >= newsletter_subscribers.reengagement_flagged_at');
    })
    .count('* as c')
    .first();
  return Number(row?.c || 0);
}

async function ensureWinbackDraft(cohort) {
  const open = await db('newsletter_sends')
    .where({ newsletter_type: REENGAGEMENT_TYPE })
    .whereIn('status', ['draft', 'scheduled', 'sending'])
    .first('id');
  if (open) return { created: false, openSendId: open.id };
  if (!cohort) return { created: false, openSendId: null };
  const [row] = await db('newsletter_sends').insert(buildWinbackDraftRow()).returning('id');
  return { created: true, openSendId: row?.id ?? row };
}

// Phase D candidates — flagged, win-back SENT for this flag episode with the
// grace window fully elapsed, still no stay-subscribed confirm. The grace
// clock runs from delivered_at when the provider confirmed delivery, and
// falls back to sent_at when it never did (hard bounce, dropped, webhook
// gap) — without the fallback an accepted-but-never-delivered win-back
// left the subscriber stranded forever: never suppressed, never re-sent
// (cohortAwaitingWinback keys on sent_at), alert resolved with no outcome.
// SELECT and UPDATE are split so the safety valve can weigh this cohort
// BEFORE any status flips.
async function findSunsetCandidates(now) {
  const graceCutoff = new Date(now.getTime() - GRACE_DAYS * DAY_MS);
  const rows = await db('newsletter_subscribers')
    .where({ status: 'active' })
    .whereNotNull('reengagement_flagged_at')
    .whereExists(function () {
      this.select(db.raw('1'))
        .from('newsletter_send_deliveries as wd')
        .join('newsletter_sends as ws', 'ws.id', 'wd.send_id')
        .whereRaw('wd.subscriber_id = newsletter_subscribers.id')
        .where('ws.newsletter_type', REENGAGEMENT_TYPE)
        .whereNotNull('wd.sent_at')
        .whereRaw('wd.sent_at >= newsletter_subscribers.reengagement_flagged_at')
        .where('wd.sent_at', '<=', graceCutoff)
        .where(function () {
          this.whereNull('wd.delivered_at').orWhere('wd.delivered_at', '<=', graceCutoff);
        });
    })
    // Only a deliberate quiz confirm exempts from suppression — see
    // recoverEngagedFlagged (scanner opens/clicks are not a response).
    .whereNotExists(engagementSubquery('flagged_at', { signals: 'quiz' }))
    .select('id');
  return rows.map((r) => r.id);
}

async function applySunset(ids, now) {
  if (!ids.length) return 0;
  // Guards re-checked ON the UPDATE, not just the candidate SELECT:
  //   - status: an unsubscribe (public route or SendGrid webhook) landing in
  //     between is the subscriber's own choice and outranks list hygiene.
  //   - no-quiz-since-flag: a stay-subscribed confirm landing in between must
  //     win — otherwise deactivated_at would postdate the quiz_answered_at
  //     and reactivateSunsetComebacks() could never bring them back.
  const updated = await db('newsletter_subscribers')
    .whereIn('id', ids)
    .where({ status: 'active' })
    .whereNotExists(engagementSubquery('flagged_at', { signals: 'quiz' }))
    .update({
      status: 'inactive',
      deactivated_at: now,
      deactivated_reason: SUNSET_REASON,
      tags: db.raw("COALESCE(tags, '[]'::jsonb) - ?", [REENGAGEMENT_TAG]),
      // reengagement_flagged_at intentionally kept — audit trail of the episode
      // that led here; comeback/resubscribe paths clear it.
      updated_at: now,
    });
  return updated;
}

// One dedupe-keyed admin_alerts row for the whole lane (≤1 bell). Open while
// the owner has something to do (valve tripped, or a win-back draft is
// waiting to be sent); resolved and silent otherwise. Mirrors the
// lawn-pricing-invariant-sweep upsert shape.
async function syncAlert(summary, now) {
  if (!(await db.schema.hasTable('admin_alerts'))) return null;

  const needsOwner = summary.valveTripped || (summary.cohortAwaiting > 0);
  if (!needsOwner) {
    const resolved = await db('admin_alerts')
      .where({ type: ALERT_TYPE, status: 'open' })
      .update({
        status: 'resolved',
        resolved_at: now,
        last_seen_at: now,
        description: 'Resolved: no inactive-subscriber cohort awaiting owner action.',
        metadata: JSON.stringify(summary),
        updated_at: now,
      });
    return resolved ? { resolved: true } : null;
  }

  const payload = {
    dedupe_key: ALERT_DEDUPE_KEY,
    type: ALERT_TYPE,
    status: 'open',
    severity: summary.valveTripped ? 'high' : 'medium',
    source_record_type: ALERT_TYPE,
    source_record_id: ALERT_DEDUPE_KEY,
    title: summary.valveTripped
      ? `Newsletter sunset paused: ${summary.candidates + summary.sunsetCandidates} of ${summary.activeCount} active look inactive`
      : `Newsletter win-back waiting: ${summary.cohortAwaiting} inactive subscriber${summary.cohortAwaiting === 1 ? '' : 's'} flagged`,
    description: summary.valveTripped
      ? `Safety valve: ${summary.candidates} flag + ${summary.sunsetCandidates} sunset candidates out of ${summary.activeCount} sendable active subscribers matched the ${INACTIVITY_DAYS}-day inactivity criteria (> ${Math.round(MAX_FLAG_FRACTION * 100)}%). That usually means an open/click tracking outage or a criteria bug, not a real mass lapse — nothing was flagged or suppressed. Review before re-running.`
    : `${summary.cohortAwaiting} subscriber(s) have ${INACTIVITY_DAYS}+ days of zero opens/clicks across ${MIN_DELIVERED_SENDS}+ delivered campaigns. A re-engagement draft is parked in /admin/newsletter — review, edit, and send it; non-responders auto-suppress ${GRACE_DAYS} days after delivery.`,
    // Deep-link straight into the parked draft: tab=compose mounts
    // ComposeView (the page defaults to the dashboard tab otherwise), and
    // ?autopilotType= names the lane it hydrates (same mechanism as the
    // Pest Insider bell).
    href: '/admin/newsletter?tab=compose&autopilotType=reengagement',
    detected_at: now,
    last_seen_at: now,
    created_by_rule: 'newsletter_sunset_weekly',
    metadata: JSON.stringify(summary),
    updated_at: now,
  };
  const [alert] = await db('admin_alerts')
    .insert(payload)
    .onConflict('dedupe_key')
    .merge({
      ...payload,
      // A cohort persisting across weekly runs keeps its FIRST detection time
      // (age is the signal); only a re-fire after a resolution starts a new
      // episode with a fresh detected_at.
      detected_at: db.raw("CASE WHEN admin_alerts.status = 'open' THEN admin_alerts.detected_at ELSE excluded.detected_at END"),
      resolved_at: null,
      updated_at: now,
    })
    .returning('id');
  return { alertId: alert?.id ?? alert };
}

async function runNewsletterSunset(now = new Date()) {
  if (!gateEnabled()) return { skipped: 'gate_off' };

  const recovered = await recoverEngagedFlagged(now);
  const reactivated = await reactivateSunsetComebacks(now);
  const candidateIds = await findFlagCandidates(now);
  const sunsetIds = await findSunsetCandidates(now);
  // Valve denominator = the SENDABLE active list (same global-suppression
  // filter the flag candidates run through). Counting suppressed-but-active
  // rows would understate the cohort fraction and let a tracking outage
  // slip past the valve on a bounce-heavy list.
  const { excludeGloballySuppressed } = require('./newsletter-sender');
  const activeRow = await excludeGloballySuppressed(
    db('newsletter_subscribers').where({ status: 'active' }),
  ).count('* as c').first();
  const activeCount = Number(activeRow?.c || 0);
  // Valve over the COMBINED cohorts: a tracking outage that starts after the
  // win-back delivers shows up as sunset candidates (flag candidates may be
  // 0), and one that starts earlier shows up as flag candidates — either way
  // the run must pause instead of mass-writing.
  const valveTripped = safetyValveTripped(candidateIds.length + sunsetIds.length, activeCount);

  let flagged = 0;
  let cohortAwaiting = 0;
  let draft = { created: false, openSendId: null };
  let sunset = 0;
  if (!valveTripped) {
    flagged = await applyFlags(candidateIds, now);
    // Sunset BEFORE staging: this week's non-responders leave the cohort
    // first, so the draft decision sees only people still owed a win-back.
    sunset = await applySunset(sunsetIds, now);
    cohortAwaiting = await cohortAwaitingWinback();
    draft = await ensureWinbackDraft(cohortAwaiting);
  }

  const summary = {
    recovered,
    reactivated,
    candidates: candidateIds.length,
    sunsetCandidates: sunsetIds.length,
    activeCount,
    valveTripped,
    flagged,
    sunset,
    cohortAwaiting,
    draftCreated: draft.created,
    openSendId: draft.openSendId || null,
  };
  await syncAlert(summary, now);
  logger.info(`[newsletter-sunset] ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = {
  runNewsletterSunset,
  // Exported for unit tests
  safetyValveTripped,
  buildWinbackDraftRow,
  MIN_DELIVERED_SENDS,
  INACTIVITY_DAYS,
  GRACE_DAYS,
  MAX_FLAG_FRACTION,
  MIN_VALVE_COUNT,
  REENGAGEMENT_TAG,
  REENGAGEMENT_TYPE,
  SUNSET_REASON,
};

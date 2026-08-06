'use strict';

// Daily owner exception email: reschedule/away texts that nothing acted on.
//
// The real-time half (reschedule-intent-flagger.js) writes an agent_decisions
// row and rings a bell the moment the text arrives. This watcher is the
// backstop: every morning it lists flags from the last few days whose linked
// visit is STILL armed and untouched — i.e. the request has not produced any
// schedule change. Exception-based per the hands-off rule: a quiet window
// sends nothing, ever.
//
// Subject grammar follows the ops-email convention (first word = the owner's
// action): ACT because each line needs a human reply/reschedule decision.
// Live by default with a kill switch (RESCHEDULE_INTENT_WATCHER_DISABLED=1).
// Cron wiring: daily 6:55am ET in scheduler.js, inside runExclusive.

const sendgrid = require('./sendgrid-mail');
const logger = require('./logger');
const db = require('../models/db');
const { isInternalEmailRecipient } = require('../utils/internal-email-recipients');
const { isInternalTestCustomerId, INTERNAL_TEST_CUSTOMER_IDS } = require('./internal-test-customers');
const { etDateString } = require('../utils/datetime-et');

const watcherDisabled = () => ['1', 'true', 'on']
  .includes(String(process.env.RESCHEDULE_INTENT_WATCHER_DISABLED || '').toLowerCase());
const watcherEmail = () => process.env.RESCHEDULE_INTENT_WATCHER_EMAIL || 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';
const adminPortalUrl = () => (process.env.ADMIN_PORTAL_URL || 'https://portal.wavespestcontrol.com').replace(/\/+$/, '');

const LOOKBACK_DAYS = 4;
// Outbound types that count as a human answer to a waiting customer —
// automated broadcasts (reminders, receipts, review asks) do not.
// Canonical human-reply types only (sms-suggest-mode) — estimate_sent is
// excluded here: an unrelated estimate is not an answer to a reschedule
// request (codex r5).
// Human-typed/approved ONLY (codex r7): reschedule confirmations are
// automated post-change sends — the slot-changed branch detects the
// change itself.
const HUMAN_REPLY_TYPES = ['manual', 'ai_approved', 'ai_revised'];
const MAX_ROWS = 12;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Flags whose linked visit is still upcoming AND has not been touched since
// the flag was created (updated_at predates the flag = nobody rescheduled,
// cancelled, or otherwise moved it). Flags with no linked visit are included
// too — "no upcoming visit" still means the customer is waiting on a reply.
// Persist proven resolutions (codex r9): a delivered human reply or a
// moved/cancelled slot marks the decision auto_resolved so the Agent
// Review surfaces and this digest agree; completion is NOT resolution.
async function resolveActionedFlags() {
  try {
    // Correlated EXISTS, not a join — Knex does not carry joins into a
    // PostgreSQL UPDATE (codex r10).
    await db('agent_decisions')
      .where('workflow', 'comms_guards')
      .where('detected_intent', 'reschedule_or_away_needs_review')
      .where('status', 'pending_review')
      .where(function proven() {
        this.whereExists(function humanReply() {
          // Unlinked shared-phone flags (customer_id null) match replies
          // by the phone the reply went TO (codex r25).
          this.select(1).from('sms_log as sl')
            .whereRaw("((sl.customer_id = agent_decisions.customer_id OR (agent_decisions.customer_id IS NULL AND RIGHT(regexp_replace(COALESCE(sl.to_phone, ''), '[^0-9]', '', 'g'), 10) = agent_decisions.input_snapshot->>'phone_tail')) AND (COALESCE(agent_decisions.input_snapshot->>'phone_tail', '') = '' OR RIGHT(regexp_replace(COALESCE(sl.to_phone, ''), '[^0-9]', '', 'g'), 10) = agent_decisions.input_snapshot->>'phone_tail'))")
            .where('sl.direction', 'outbound')
            .whereIn('sl.message_type', HUMAN_REPLY_TYPES)
            // Approved click-followup nudges are proactive, not replies
            // (codex r24) — matched by draft intent + finalize sent_at.
            .whereRaw("NOT EXISTS (SELECT 1 FROM message_drafts mdx WHERE mdx.sms_log_id IS NULL AND (mdx.customer_id = sl.customer_id OR (mdx.customer_id IS NULL AND sl.customer_id IS NULL AND RIGHT(regexp_replace(COALESCE(mdx.flags->>'phone', mdx.flags->>'toPhone', ''), '[^0-9]', '', 'g'), 10) = RIGHT(regexp_replace(COALESCE(sl.to_phone, ''), '[^0-9]', '', 'g'), 10))) AND mdx.sent_at BETWEEN sl.created_at - interval '2 minutes' AND sl.created_at + interval '2 minutes')")
            // Resolution is a durable status write — only CONFIRMED
            // delivery counts (codex r26): a queued/sent reply can still
            // fail, and nothing reopens an auto_resolved decision. The
            // digest's own hide-predicate stays optimistic, so a later
            // failure re-surfaces the flag there.
            .where('sl.status', 'delivered')
            .whereRaw('sl.created_at > agent_decisions.created_at');
        }).orWhere(function ambiguousRescheduled() {
          // Null-entity flags can't observe slot changes — a delivered
          // reschedule confirmation to the customer is the proof
          // (codex r23). Scoped in r32: only NON-ambiguous, customer-
          // linked flags (no upcoming visit at flag time). For a
          // multi-visit customer the moved visit may not be the requested
          // one, and on a shared number it may be the other member's —
          // those stay pending for staff review.
          this.whereNull('agent_decisions.entity_id')
            .whereRaw("COALESCE(agent_decisions.input_snapshot->>'ambiguous', 'false') <> 'true'")
            .whereNotNull('agent_decisions.customer_id')
            .whereExists(function confirmed() {
            this.select(1).from('sms_log as rc')
              .whereRaw("(rc.customer_id = agent_decisions.customer_id AND (COALESCE(agent_decisions.input_snapshot->>'phone_tail', '') = '' OR RIGHT(regexp_replace(COALESCE(rc.to_phone, ''), '[^0-9]', '', 'g'), 10) = agent_decisions.input_snapshot->>'phone_tail'))")
              .where('rc.direction', 'outbound')
              .whereIn('rc.message_type', ['appointment_rescheduled', 'reschedule_series_confirmation'])
              .where('rc.status', 'delivered')
              .whereRaw('rc.created_at > agent_decisions.created_at');
          });
        }).orWhereExists(function slotMovedOrCancelled() {
          this.select(1).from('scheduled_services as ss')
            .whereRaw('ss.id = agent_decisions.entity_id')
            .where(function changed() {
              // 'rescheduled' resolves even when the slot is unchanged —
              // the reschedule path can flip status only (codex r10).
              this.whereIn('ss.status', ['cancelled', 'rescheduled', 'skipped'])
                .orWhereRaw("LEFT(agent_decisions.input_snapshot#>>'{visit,scheduled_date}', 10) <> ss.scheduled_date::text")
                .orWhereRaw("COALESCE(agent_decisions.input_snapshot#>>'{visit,window_start}', '') <> COALESCE(ss.window_start::text, '')");
            });
        });
      })
      .update({ status: 'auto_resolved', updated_at: new Date() });
  } catch (err) {
    logger.warn(`[reschedule-intent-watcher] resolve pass failed: ${err.message}`);
  }
}

// Replay bells whose post-ack fire never ran (codex r16): the pre-ack
// insert is durable, the bell is not — flags still marked bell_pending
// after 10 minutes get their urgent notification here.
async function replayPendingBells() {
  try {
    const stale = await db('agent_decisions as ad')
      .leftJoin('customers as cu', 'ad.customer_id', 'cu.id')
      .where('ad.workflow', 'comms_guards')
      .where('ad.detected_intent', 'reschedule_or_away_needs_review')
      .where('ad.status', 'pending_review')
      .whereRaw("ad.input_snapshot->>'bell_pending' = 'true'")
      .where('ad.created_at', '<', db.raw("now() - interval '10 minutes'"))
      // Newest-first (codex r19): persistently-failing replays must not
      // starve fresh flags out of the capped batch.
      .orderBy('ad.created_at', 'desc')
      .limit(10)
      .select('ad.id', 'ad.customer_id', 'ad.input_snapshot', 'cu.first_name', 'cu.last_name');
    for (const row of stale) {
      let snap = {};
      try { snap = typeof row.input_snapshot === 'string' ? JSON.parse(row.input_snapshot) : (row.input_snapshot || {}); } catch { snap = {}; }
      let landed = false;
      try {
        const { triggerNotification } = require('./notification-triggers');
        const stats = await triggerNotification('appointment_reschedule_intent', {
          name: [row.first_name, row.last_name].filter(Boolean).join(' ')
            || (snap.phone_tail ? `Shared number …${String(snap.phone_tail).slice(-4)}` : 'Customer'),
          customerId: row.customer_id,
          message: snap.body_excerpt || '',
          visitDate: snap.visit ? String(snap.visit.scheduled_date || '').slice(0, 10) : null,
          visitService: snap.visit?.service_type || null,
          ambiguousVisits: snap.ambiguous === true,
          decisionId: row.id,
        });
        landed = Boolean(stats && !stats.error
          && (stats.suppressed || stats.bellWritten || Number(stats.push?.sent || 0) > 0));
      } catch (bellErr) {
        logger.warn(`[reschedule-intent-watcher] bell replay failed for ${row.id}: ${bellErr.message}`);
        continue;
      }
      // Only a LANDED alert clears the marker (codex r17) — a resolved
      // {error} result must leave the replay pending for the next run.
      if (!landed) continue;
      await db('agent_decisions')
        .where({ id: row.id })
        .update({ input_snapshot: db.raw("jsonb_set(COALESCE(input_snapshot, '{}'::jsonb), '{bell_pending}', 'false'::jsonb)"), updated_at: new Date() })
        .catch(() => {});
    }
  } catch (err) {
    logger.warn(`[reschedule-intent-watcher] bell replay pass failed: ${err.message}`);
  }
}

async function loadUnactionedFlags() {
  const rows = await db('agent_decisions as ad')
    .leftJoin('scheduled_services as ss', 'ad.entity_id', 'ss.id')
    .leftJoin('customers as cu', 'ad.customer_id', 'cu.id')
    .where('ad.workflow', 'comms_guards')
    .where('ad.detected_intent', 'reschedule_or_away_needs_review')
    // Staff-resolved decisions (accepted/corrected/dismissed via the agent
    // decisions surface) leave the digest immediately (codex r2).
    .where('ad.status', 'pending_review')
    .where(function windowOrLiveVisit() {
      // The flagger links visits up to 14 days out; a pending flag must
      // stay visible through its linked visit's date, not age out at the
      // 4-day lookback while the visit is still upcoming (codex r24).
      this.where('ad.created_at', '>=', db.raw(`now() - interval '${LOOKBACK_DAYS} days'`))
        .orWhere(function liveLinkedVisit() {
          // Completed visits stay one extra day (codex r35): a visit that
          // COMPLETED after yesterday's 6:53am run must still reach the
          // next digest to emit its "COMPLETED despite the request" line.
          this.whereNotNull('ad.entity_id')
            .whereRaw("(ss.scheduled_date >= (now() at time zone 'America/New_York')::date OR (ss.status IN ('completed', 'no_show') AND ss.scheduled_date >= (now() at time zone 'America/New_York')::date - 1))");
        })
        // Ambiguous flags carry entity_id NULL by design (multi-visit) —
        // retain them too while ANY of the customer's upcoming visits is
        // still armed (codex r28).
        .orWhere(function liveAmbiguous() {
          this.whereNull('ad.entity_id')
            .whereNotNull('ad.customer_id')
            .whereRaw("EXISTS (SELECT 1 FROM scheduled_services live WHERE live.customer_id = ad.customer_id AND ((live.scheduled_date >= (now() at time zone 'America/New_York')::date AND live.status IN ('pending', 'confirmed', 'en_route', 'on_site')) OR (live.status = 'completed' AND live.scheduled_date >= (now() at time zone 'America/New_York')::date - 1)))");
        })
        // Unlinked shared-phone flags (customer AND entity null) are
        // retained while ANY phone-matched customer's visit is still
        // armed (codex r33) — without choosing a customer.
        .orWhere(function livePhoneMatched() {
          this.whereNull('ad.customer_id')
            .whereRaw("COALESCE(ad.input_snapshot->>'phone_tail', '') <> ''")
            .whereRaw("EXISTS (SELECT 1 FROM customers pc JOIN scheduled_services pss ON pss.customer_id = pc.id WHERE pc.deleted_at IS NULL AND (RIGHT(regexp_replace(COALESCE(pc.phone, ''), '[^0-9]', '', 'g'), 10) = ad.input_snapshot->>'phone_tail' OR RIGHT(regexp_replace(COALESCE(pc.service_contact_phone, ''), '[^0-9]', '', 'g'), 10) = ad.input_snapshot->>'phone_tail' OR RIGHT(regexp_replace(COALESCE(pc.service_contact2_phone, ''), '[^0-9]', '', 'g'), 10) = ad.input_snapshot->>'phone_tail' OR RIGHT(regexp_replace(COALESCE(pc.service_contact3_phone, ''), '[^0-9]', '', 'g'), 10) = ad.input_snapshot->>'phone_tail') AND ((pss.scheduled_date >= (now() at time zone 'America/New_York')::date AND pss.status IN ('pending', 'confirmed', 'en_route', 'on_site')) OR (pss.status = 'completed' AND pss.scheduled_date >= (now() at time zone 'America/New_York')::date - 1)))");
        });
    })
    // A HUMAN reply that actually left (accepted carrier statuses) clears
    // ANY flag — linked or not: staff can resolve a request without moving
    // the slot ("exterior is fine, no need to be home") (codex r3).
    .whereNotExists(function humanReply() {
      // Unlinked shared-phone flags match replies by destination phone
      // (codex r25).
      this.select(1).from('sms_log as sl')
        .whereRaw("((sl.customer_id = ad.customer_id OR (ad.customer_id IS NULL AND RIGHT(regexp_replace(COALESCE(sl.to_phone, ''), '[^0-9]', '', 'g'), 10) = ad.input_snapshot->>'phone_tail')) AND (COALESCE(ad.input_snapshot->>'phone_tail', '') = '' OR RIGHT(regexp_replace(COALESCE(sl.to_phone, ''), '[^0-9]', '', 'g'), 10) = ad.input_snapshot->>'phone_tail'))")
        .where('sl.direction', 'outbound')
        .whereIn('sl.message_type', HUMAN_REPLY_TYPES)
            // Approved click-followup nudges are proactive, not replies
            // (codex r24) — matched by draft intent + finalize sent_at.
            .whereRaw("NOT EXISTS (SELECT 1 FROM message_drafts mdx WHERE mdx.sms_log_id IS NULL AND (mdx.customer_id = sl.customer_id OR (mdx.customer_id IS NULL AND sl.customer_id IS NULL AND RIGHT(regexp_replace(COALESCE(mdx.flags->>'phone', mdx.flags->>'toPhone', ''), '[^0-9]', '', 'g'), 10) = RIGHT(regexp_replace(COALESCE(sl.to_phone, ''), '[^0-9]', '', 'g'), 10))) AND mdx.sent_at BETWEEN sl.created_at - interval '2 minutes' AND sl.created_at + interval '2 minutes')")
        .whereIn('sl.status', ['queued', 'sent', 'delivered'])
        .whereRaw('sl.created_at > ad.created_at');
    })
    .where(function stillUnactioned() {
      this.whereNull('ad.entity_id').orWhere(function visitUnchanged() {
        // Linked visit: unactioned = still upcoming AND still on the
        // flagged slot, judged against the flag's own snapshot — NOT
        // updated_at, which the public rebooker does not bump (codex r1).
        // 'completed' stays in the backstop (codex r9): a visit that RAN
        // on the flagged slot despite the request is the incident class
        // itself, not a resolution.
        this.whereIn('ss.status', ['pending', 'confirmed', 'en_route', 'on_site', 'completed', 'no_show'])
          .whereRaw("LEFT(ad.input_snapshot#>>'{visit,scheduled_date}', 10) = ss.scheduled_date::text")
          .whereRaw("COALESCE(ad.input_snapshot#>>'{visit,window_start}', '') = COALESCE(ss.window_start::text, '')");
      });
    })
    // Canonical internal-test exclusion IN the query (codex r45): demo
    // rows must not inflate COUNT(*) OVER () or consume the LIMIT page.
    .where(function noDemoRows() {
      if (INTERNAL_TEST_CUSTOMER_IDS.length) {
        this.whereNull('ad.customer_id').orWhereNotIn('ad.customer_id', INTERNAL_TEST_CUSTOMER_IDS);
      }
    })
    // Newest-first (codex r14): oldest-first pinned the same stale prefix
    // while fresh requests hid in the overflow count.
    .orderBy('ad.created_at', 'desc')
    .limit(MAX_ROWS)
    .select(
      db.raw('COUNT(*) OVER () AS total_count'),
      'ad.id', 'ad.created_at', 'ad.input_snapshot', 'ad.customer_id',
      'cu.first_name', 'cu.last_name',
      'ss.scheduled_date', 'ss.window_start', 'ss.service_type', 'ss.status as visit_status',
    );
  // Demo/App-Review activity is deliberately suppressed at the bell
  // (codex r44) — the daily digest applies the same canonical exclusion.
  return rows.filter((row) => !isInternalTestCustomerId(row.customer_id));
}

function parseSnapshot(snapshot) {
  if (!snapshot) return { excerpt: '', ambiguous: false, phoneTail: null };
  try {
    const parsed = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
    return {
      excerpt: String(parsed.body_excerpt || ''),
      ambiguous: parsed.ambiguous === true,
      phoneTail: parsed.phone_tail ? String(parsed.phone_tail) : null,
    };
  } catch {
    return { excerpt: '', ambiguous: false, phoneTail: null };
  }
}

// Pure composition: null = nothing worth an email (the common, quiet case).
function composeRescheduleIntentDigest(rows) {
  const flags = (rows || []).filter(Boolean);
  if (!flags.length) return null;

  const lines = flags.map((row) => {
    const snapTail = parseSnapshot(row.input_snapshot).phoneTail;
    const name = [row.first_name, row.last_name].filter(Boolean).join(' ')
      || (snapTail ? `Shared number …${snapTail.slice(-4)}` : 'Unknown customer');
    const asked = etDateString(new Date(row.created_at));
    const visit = row.scheduled_date
      ? `visit ${String(row.scheduled_date instanceof Date ? row.scheduled_date.toISOString() : row.scheduled_date).slice(0, 10)}${row.window_start ? ` ${String(row.window_start).slice(0, 5)}` : ''}${row.service_type ? ` (${row.service_type})` : ''} ${row.visit_status === 'completed' ? 'COMPLETED despite the request' : (row.visit_status === 'no_show' ? 'NO-SHOW after the request' : 'STILL ARMED')}`
      : (parseSnapshot(row.input_snapshot).ambiguous
        ? 'multiple upcoming visits — check which one they mean'
        : 'no upcoming visit on the books');
    const excerpt = parseSnapshot(row.input_snapshot).excerpt.slice(0, 140);
    return { name, asked, visit, excerpt, customerId: row.customer_id };
  });

  const total = Number(flags[0]?.total_count) > 0 ? Number(flags[0].total_count) : flags.length;
  const subject = `ACT: ${total} reschedule request${total === 1 ? '' : 's'} by text with no schedule change`;
  const text = [
    `${flags.length} customer text${flags.length === 1 ? ' reads' : 's read'} as a reschedule/away request and the linked visit has not moved. Reply or reschedule each — the automation will otherwise run these visits as booked.`,
    '',
    ...lines.map((l) => `- ${l.asked} ${l.name}: "${l.excerpt}" — ${l.visit}`),
    ...(total > lines.length ? [`…and ${total - lines.length} more not shown`] : []),
    '',
    `Threads: ${adminPortalUrl()}/admin/communications`,
  ].join('\n');
  const html = [
    `<p>${flags.length} customer text${flags.length === 1 ? ' reads' : 's read'} as a <strong>reschedule/away request</strong> and the linked visit has not moved. Reply or reschedule each — the automation will otherwise run these visits as booked.</p>`,
    `<ul style="margin:0 0 12px 18px;padding:0;">${lines.map((l) =>
      `<li style="margin:0 0 6px 0;">${esc(l.asked)} <a href="${esc(adminPortalUrl())}/admin/communications?thread=${esc(l.customerId || '')}"><strong>${esc(l.name)}</strong></a>: &quot;${esc(l.excerpt)}&quot; — ${esc(l.visit)}</li>`,
    ).join('')}</ul>`,
    ...(total > lines.length ? [`<p>…and ${total - lines.length} more not shown</p>`] : []),
    `<p><a href="${esc(adminPortalUrl())}/admin/communications">Open communications</a></p>`,
  ].join('\n');

  return { subject, text, html, count: total };
}

// Durable daily-send guard — same rationale as turf-variance-digest.js:
// the advisory lock only serializes concurrent ticks; ops_email_send_state
// (not job_health) carries the marker across deploy overlaps.
const SEND_MARKER_KEY = 'reschedule-intent-watcher';
const TWENTY_HOURS_MS = 20 * 60 * 60 * 1000;

async function sentRecently() {
  try {
    const row = await db('ops_email_send_state').where({ email_key: SEND_MARKER_KEY }).first('last_sent_at');
    return Boolean(row?.last_sent_at && (Date.now() - new Date(row.last_sent_at).getTime()) < TWENTY_HOURS_MS);
  } catch (err) {
    logger.warn(`[reschedule-intent-watcher] send-marker read failed (${err.message}) — proceeding without the guard`);
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
    logger.warn(`[reschedule-intent-watcher] send-marker write failed (${err.message}) — next tick may re-send`);
  }
}

async function runRescheduleIntentWatcher(opts = {}) {
  if (await (opts.sentRecently || sentRecently)()) return { skipped: 'recent_send' };

  let rows;
  try {
    // Resolution FIRST (codex r18): a flag staff already actioned must
    // not get its bell replayed.
    await (opts.resolveActionedFlags || resolveActionedFlags)();
    await (opts.replayPendingBells || replayPendingBells)();
    rows = await (opts.loadRows || loadUnactionedFlags)();
  } catch (err) {
    logger.error(`[reschedule-intent-watcher] query failed: ${err.message}`);
    return { skipped: 'query_failed' };
  }

  const composed = composeRescheduleIntentDigest(rows);
  if (!composed) return { skipped: 'nothing_found' };

  if (watcherDisabled()) {
    logger.info(`[reschedule-intent-watcher] disabled — would send ${composed.count} row(s)`);
    return { skipped: 'disabled', ...composed };
  }

  const mailer = opts.sendgrid || sendgrid;
  if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) {
    logger.warn('[reschedule-intent-watcher] mailer not configured — skipping send');
    return { skipped: 'unconfigured', ...composed };
  }

  // FAIL CLOSED: owner/internal inboxes only — customer names and message
  // excerpts must never leak to a mis-set recipient.
  const to = watcherEmail();
  if (!isInternalEmailRecipient(to)) {
    logger.warn('[reschedule-intent-watcher] recipient is not an internal address — skipping send; set a valid RESCHEDULE_INTENT_WATCHER_EMAIL');
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
      categories: ['ops', 'reschedule-intent'],
      suppressErrorLog: true,
    });
  } catch (err) {
    logger.error(`[reschedule-intent-watcher] send failed (status ${Number.isInteger(err?.status) ? err.status : 'network'})`);
    return { sent: false, error: true, ...composed };
  }
  await (opts.stampSendMarker || stampSendMarker)();
  logger.info(`[reschedule-intent-watcher] sent: ${composed.count} unactioned flag(s)`);
  return { sent: true, ...composed };
}

module.exports = {
  runRescheduleIntentWatcher,
  replayPendingBells,
  resolveActionedFlags,
  _private: { composeRescheduleIntentDigest },
};

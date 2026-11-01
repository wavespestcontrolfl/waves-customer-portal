/**
 * Lead staleness sweep (leads funnel integrity).
 *
 * Runs daily at 6:35am ET via scheduler.js. Flips `new` leads to
 * `unresponsive` once they've sat past LEAD_STALENESS_DAYS (default 21)
 * with nobody working them: no lead_activities row inside the window, no
 * scheduled future follow-up, and no booked service on a linked customer
 * (a lead whose customer already has scheduled service is pending
 * won-conversion — burying it as unresponsive would hide it from that fix).
 *
 * Threshold lives in env so it can be tuned without a deploy:
 *   LEAD_STALENESS_DAYS=21
 * Setting it to 0 / empty / any non-numeric value disables the sweep
 * entirely (fail-safe off switch). Leave it unset for the default.
 *
 * GATE_LEAD_NO_RESPONSE_REASON (owner 2026-11-01, dark): the sweep also
 * writes lost_reason 'no_response' on every lead it parks, and parks
 * estimate_sent / estimate_viewed leads whose estimate expired with a
 * lost-group disposition. An expired estimate means quiet (estimates expire
 * after 7 idle days), not lost, so the status is 'unresponsive', never 'lost'.
 * Sends nothing to a customer.
 */
const db = require('../models/db');
const logger = require('./logger');
const { bridgeLeadsFunnelStage } = require('./lead-funnel-bridge');
const { DISPOSITIONS } = require('./estimate-disposition');
const { leadNoResponseReasonLive } = require('../config/feature-gates');

const NO_RESPONSE_REASON = 'no_response';
// The estimate dispositions that count against the win rate. Read from the
// disposition module's own group mapping so a new lost code joins here.
const LOST_DISPOSITION_CODES = DISPOSITIONS.filter((d) => d.group === 'lost').map((d) => d.code);
const ESTIMATE_LEAD_STATUSES = ['estimate_sent', 'estimate_viewed'];
// leads.estimate_id is canonical; the public-quote mirror
// estimate_data.lead_id is the fallback (services/estimate-lead-linkage.js).
const LINKED_ESTIMATE_SQL = "(le.id = leads.estimate_id OR (leads.estimate_id IS NULL AND le.estimate_data->>'lead_id' = leads.id::text))";

function getThresholdDays() {
  const raw = process.env.LEAD_STALENESS_DAYS;
  if (raw === undefined) return 21;
  // Whole-string positive integer only. parseInt accepts numeric prefixes
  // ('21days', '30 disabled'), which would silently ENABLE the sweep on an
  // operator typo that was meant to be the off switch. Any other shape —
  // empty, zero, non-numeric, partial — fails safe to "do nothing".
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return 0;
  const parsed = parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

// Set-based UPDATE for stale `new` leads. `qb` is the knex instance or an
// open transaction; the caller awaits the returned builder. Exported so
// tests can compile it to SQL and pin the WHERE semantics.
// `excludeSoftDeleted` is passed by the caller only when leads.deleted_at
// exists (the soft-delete lane ships separately) — a removed lead must not
// be flipped or have activity written on it.
function buildStaleLeadUpdate(qb, { now, cutoff, excludeSoftDeleted = false, noResponseReason = false }) {
  const changes = { status: 'unresponsive', updated_at: now };
  // Only a blank reason is filled; a reason staff already wrote stays.
  if (noResponseReason) changes.lost_reason = qb.raw('COALESCE(leads.lost_reason, ?)', [NO_RESPONSE_REASON]);
  return staleLeadScope(qb('leads').where('leads.status', 'new'), { now, cutoff, excludeSoftDeleted })
    .update(changes)
    .returning('id');
}

// Every exemption the sweep applies, shared by the `new` flip and the
// expired-estimate flip so the two never drift. `builder` already carries the
// status filter.
function staleLeadScope(builder, { now, cutoff, excludeSoftDeleted = false }) {
  return builder
    .where('leads.created_at', '<=', cutoff)
    .modify((builder) => {
      if (excludeSoftDeleted) builder.whereNull('leads.deleted_at');
    })
    // A scheduled future callback means the lead is being worked.
    .where(function () {
      this.whereNull('leads.next_follow_up_at')
        .orWhere('leads.next_follow_up_at', '<=', now);
    })
    // Any activity inside the window means someone/something is on it —
    // except shared-phone cross-notes: another caller minting a lead on a
    // shared number says nothing about THIS lead being worked, and
    // recurring calls on an office line would keep an abandoned lead
    // active indefinitely.
    .whereNotExists(function () {
      this.select(1).from('lead_activities')
        .whereRaw('lead_activities.lead_id = leads.id')
        // IS DISTINCT FROM, not <>: activity_type is nullable and a NULL
        // row must still count as the lead being worked.
        .whereRaw("lead_activities.activity_type IS DISTINCT FROM 'shared_phone_note'")
        .where('lead_activities.created_at', '>=', cutoff);
    })
    // A quote-wizard repeat filed as a 'duplicate' of this lead inside the
    // window is the customer re-engaging (the public route labels the new
    // row and never writes the original — codex #3834 r10 P1), so the
    // original is not stale. The marker can chain (B → A → O when two
    // repeats raced), so every ancestor of a recent repeat is exempt, not
    // just the row it names (pre-push P1 on r12); a removed repeat or hop
    // says nothing about re-engagement (codex r11 P2). A repeat is recent by
    // its LAST wizard submission, not its filing: a rerun on the repeat's
    // own token re-types the row in place (marker kept), and that
    // re-engagement must exempt the original too (codex r23 P1). The
    // submission is the wizard's own extracted_data.wizard_submitted_at
    // stamp, not updated_at — an admin edit or assignment bumps updated_at
    // without the customer re-engaging (codex #3861 r1 P2); a row filed
    // before the stamp existed falls back to its filing.
    .whereRaw(
      `leads.id::text NOT IN (
        WITH RECURSIVE chain AS (
          SELECT r.extracted_data->>'duplicate_of_lead_id' AS parent_id, 1 AS depth
          FROM leads r
          WHERE r.lead_type = 'quote_wizard' AND r.status = 'duplicate' AND COALESCE((r.extracted_data->>'wizard_submitted_at')::timestamptz, r.created_at) >= ?${excludeSoftDeleted ? ' AND r.deleted_at IS NULL' : ''}
          UNION ALL
          SELECT p.extracted_data->>'duplicate_of_lead_id', chain.depth + 1
          FROM chain JOIN leads p ON p.id::text = chain.parent_id
          WHERE p.lead_type = 'quote_wizard' AND p.status = 'duplicate' AND chain.depth < 8${excludeSoftDeleted ? ' AND p.deleted_at IS NULL' : ''}
        )
        SELECT parent_id FROM chain WHERE parent_id IS NOT NULL
      )`,
      [cutoff],
    )
    // A lead linked to a customer with booked (or already-delivered) service
    // FROM THIS LEAD'S COURTSHIP is pending won-conversion, not
    // unresponsive. Two scopes keep one dead or unrelated visit from
    // exempting the lead forever:
    //  - status: cancelled/rescheduled/skipped/no_show rows don't count —
    //    the repo's terminal convention (waveguard-existing-services
    //    TERMINAL_STATUSES minus 'completed'). A reschedule is replaced by
    //    a live row that still matches; a skipped/no_show visit is a
    //    terminal miss, not a standing booking.
    //  - time: the visit must be created on/after the lead (1-day grace for
    //    the call-processing flow where the booking row can precede the
    //    lead row inside one run — same predicate as the cleanup script's
    //    Part A, so the sweep exempts exactly the leads that lane would
    //    convert). A tech-field add-on lead on an established customer is
    //    NOT exempted by that customer's historical services — if nobody
    //    works it, it goes unresponsive like any other stale lead.
    // The correlated subquery can never match when customer_id is NULL, so
    // unlinked leads pass through.
    .whereNotExists(function () {
      this.select(1).from('scheduled_services')
        .whereRaw('scheduled_services.customer_id = leads.customer_id')
        .whereNotIn('scheduled_services.status', ['cancelled', 'rescheduled', 'skipped', 'no_show'])
        .whereRaw("scheduled_services.created_at >= COALESCE(leads.first_contact_at, leads.created_at) - interval '1 day'");
    })
    // A lead whose own funnel row already carries the deal — booked, or
    // completed — is won in everything but its status: a wizard repeat's
    // conversion settles its win onto the open root's funnel row and leaves
    // the root's lead row open for the office to merge (funnel writes are
    // funnel-table only). The exemption above cannot see it — the root is
    // often unlinked, and the settlement writes no activity on it — and the
    // 'unresponsive' bridge would demote that booked row to lost (codex
    // #3834 r37 P1). Same rule as the scheduled_services clause: pending
    // won-conversion, not unresponsive.
    .whereNotExists(function () {
      this.select(1).from('ad_service_attribution')
        .whereRaw('ad_service_attribution.lead_id = leads.id')
        .whereIn('ad_service_attribution.funnel_stage', ['booked', 'completed']);
    });
}

// The lead's linked estimate: expired with a lost-group disposition, not sent
// or opened inside the window (a customer who opened it 10 days ago is not
// quiet for 21), and with no newer live estimate for the same lead or
// customer (accepted, or sent/viewed, unarchived and unexpired: the lead is
// being worked on a fresh quote). `sub` is a builder on `estimates as le`.
function qualifyingLostEstimate(sub, { now, cutoff }) {
  return sub
    .whereRaw(LINKED_ESTIMATE_SQL)
    .where('le.status', 'expired')
    .whereIn('le.disposition', LOST_DISPOSITION_CODES)
    .whereRaw('COALESCE(GREATEST(le.sent_at, le.viewed_at, le.last_viewed_at), le.created_at) <= ?', [cutoff])
    .whereNotExists(function () {
      this.select(1).from('estimates as ne')
        .whereRaw('ne.id <> le.id')
        .whereRaw('ne.created_at > le.created_at')
        .whereRaw(
          `(ne.id = leads.estimate_id OR ne.estimate_data->>'lead_id' = leads.id::text OR ne.customer_id = leads.customer_id)
           AND (ne.status = 'accepted' OR (ne.status IN ('sent', 'viewed') AND ne.archived_at IS NULL AND (ne.expires_at IS NULL OR ne.expires_at > ?)))`,
          [now],
        );
    });
}

// Set-based UPDATE for estimate_sent / estimate_viewed leads whose estimate
// expired as a loss. Same exemptions as the `new` flip (staleLeadScope), plus
// converted_at and the estimate checks above. Status becomes 'unresponsive',
// never 'lost'. The note names the estimate's disposition and is appended to
// any note staff already wrote.
function buildExpiredEstimateLeadUpdate(qb, { now, cutoff, excludeSoftDeleted = false }) {
  const noteSource = qualifyingLostEstimate(qb('estimates as le'), { now, cutoff })
    .select(qb.raw("'estimate ' || le.disposition"))
    .orderBy('le.created_at', 'desc')
    .limit(1);
  return staleLeadScope(qb('leads').whereIn('leads.status', ESTIMATE_LEAD_STATUSES), { now, cutoff, excludeSoftDeleted })
    .whereNull('leads.converted_at')
    .whereExists(function () {
      qualifyingLostEstimate(this.select(1).from('estimates as le'), { now, cutoff });
    })
    .update({
      status: 'unresponsive',
      updated_at: now,
      lost_reason: qb.raw('COALESCE(leads.lost_reason, ?)', [NO_RESPONSE_REASON]),
      lost_notes: qb.raw("COALESCE(NULLIF(leads.lost_notes, '') || chr(10), '') || COALESCE(?, 'estimate expired')", [noteSource]),
    })
    .returning('id');
}

async function runLeadStalenessSweep() {
  const thresholdDays = getThresholdDays();
  if (!thresholdDays) {
    logger.info('[lead-staleness] LEAD_STALENESS_DAYS disabled — skipping sweep');
    return { disabled: true, marked: 0 };
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - thresholdDays * 24 * 60 * 60 * 1000);

  // Column-gated so the sweep is correct on either side of the leads
  // soft-delete migration (separate lane): once deleted_at exists, removed
  // leads are excluded; before it lands, the condition would 500 the query.
  const excludeSoftDeleted = await db.schema.hasColumn('leads', 'deleted_at').catch(() => false);

  const noResponseReason = leadNoResponseReasonLive();
  const opts = { now, cutoff, excludeSoftDeleted };
  let expiredEstimates = 0;

  // The UPDATE(s) + one batched activity INSERT run inside a transaction, so a
  // failed insert rolls the flips back and the next run retries cleanly.
  const marked = await db.transaction(async (trx) => {
    const flipped = await buildStaleLeadUpdate(trx, { ...opts, noResponseReason });
    // Gate on: quiet leads whose estimate expired as a loss are parked too.
    const fromEstimate = noResponseReason ? await buildExpiredEstimateLeadUpdate(trx, opts) : [];
    expiredEstimates = fromEstimate.length;

    if (flipped.length || fromEstimate.length) {
      const activity = (row, extra) => ({
        lead_id: row.id,
        activity_type: 'status_change',
        description: `Auto-marked unresponsive after ${thresholdDays} days with no contact`,
        performed_by: 'system',
        metadata: JSON.stringify({ auto: true, threshold_days: thresholdDays, ...extra }),
      });
      await trx('lead_activities').insert([
        ...flipped.map((row) => activity(row, noResponseReason ? { lost_reason: NO_RESPONSE_REASON } : {})),
        ...fromEstimate.map((row) => activity(row, { lost_reason: NO_RESPONSE_REASON, source: 'estimate_expired' })),
      ]);

      // Collapse the flipped leads' ad_service_attribution funnel rows to the
      // terminal 'lost' bucket (unresponsive is a closed status — leaving the
      // rows at an open stage would overstate active leads). Same transaction,
      // one set-based UPDATE via the shared monotonic bridge.
      await bridgeLeadsFunnelStage([...flipped, ...fromEstimate].map(({ id }) => id), 'unresponsive', trx);
    }

    return flipped.length + fromEstimate.length;
  });

  logger.info(`[lead-staleness] thresholdDays=${thresholdDays} marked=${marked}${noResponseReason ? ` expiredEstimates=${expiredEstimates}` : ''}`);
  return noResponseReason
    ? { disabled: false, marked, expiredEstimates }
    : { disabled: false, marked };
}

module.exports = {
  runLeadStalenessSweep,
  getThresholdDays,
  buildStaleLeadUpdate,
  buildExpiredEstimateLeadUpdate,
};

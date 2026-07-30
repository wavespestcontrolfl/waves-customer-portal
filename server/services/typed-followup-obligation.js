/**
 * Single source of truth for "does a typed specialty visit owe a follow-up,
 * and is that obligation durably parked?"
 *
 * ALERT-policy completion profiles (bed bug, cockroach two-treatment,
 * German/palmetto knockdowns) promise a persistent ops exception when a
 * completed visit owes a follow-up. Pre-cutover the project flow wrote a
 * follow_up_needed dispatch alert inside its completion transaction
 * (createProjectFollowupAlert); the typed cutover left three near-duplicate
 * copies of the override chain (POST /complete, POST /schedule-followup) and
 * no durable alert at all — tapping "Done" on the success overlay dropped
 * the owed follow-up silently (found live on a bed_bug_treatment completion
 * 2026-07-30; Codex rounds 1–2 on PR #3091 then found the crash-resume,
 * idempotent-retry, pre-booked-child, and cancelled-child leaks in the
 * bolt-on fix). This module is the consolidation:
 *
 *  - typedFollowupVerdict()      — the ONE override chain (species rule,
 *                                  included-visit stop, knockdown tech
 *                                  selections), shared by /complete,
 *                                  /schedule-followup, and the cancel hook.
 *  - typedFollowupObligationForCompletedSource() — re-derive the verdict
 *                                  for an already-completed visit from its
 *                                  committed typedReportSnapshot.
 *  - parkFollowupAlert()         — dedup-guarded follow_up_needed insert.
 *                                  Atomicity comes from the partial unique
 *                                  index idx_dispatch_alerts_typed_followup_
 *                                  one_unresolved (migration 20260730500000,
 *                                  covering BOTH payload sources) — the
 *                                  read-side (type, job_id) pre-check is the
 *                                  cross-source guard (project_completion /
 *                                  visit-outcome cards live outside the
 *                                  index) and the fast path. Also skips when
 *                                  a live linked child already exists — the
 *                                  call pipeline can pre-book visit 2, and
 *                                  an alert for a booked follow-up is a
 *                                  false exception.
 *  - handleFollowupChildCancellation() — the shared status writer
 *                                  (transitionJobStatus) calls this when a
 *                                  visit goes cancelled/skipped/no_show: if
 *                                  it was the linked follow-up child and no
 *                                  replacement is live, the source visit's
 *                                  obligation resurfaces as a fresh alert.
 */

const db = require('../models/db');
const logger = require('./logger');

// Tech-facing window labels on the German knockdown checklist → interval
// days. The tech's selected window drives the suggested date so the CTA can
// never book a date the customer report contradicts.
const KNOCKDOWN_FOLLOWUP_WINDOW_DAYS = { '10–14 days': 14, '2–3 weeks': 21 };

// Two-treatment package keys (20260712300000 cutover): the ALERT follow-up
// policy means visit 1 owes an included second visit — and ONLY visit 1;
// an included follow-up completing must not mint a third (Codex r3 on
// #3078-era rounds). Trapping programs deliberately chain and are excluded.
const TWO_TREATMENT_PACKAGE_KEYS = new Set(['cockroach_control', 'bed_bug_treatment']);

// A linked follow-up child in any of these states does NOT cover the
// obligation: cancelled/skipped never happened, and a no_show means the
// visit was missed — the customer still needs the treatment (Codex r3).
// Must stay in lockstep with the partial unique index
// uq_scheduled_services_followup_source_open (migration 20260730500000) so
// a replacement can actually be booked once a child enters these states.
const FOLLOWUP_CHILD_INACTIVE_STATUSES = ['cancelled', 'skipped', 'no_show'];

function parseJsonObjectSafe(value) {
  if (value == null) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The one override chain. Returns the FINAL follow-up suggestion for a
 * typed completion — projectFollowupSuggestion's profile verdict adjusted
 * by every service-specific rule:
 *  - cockroach: German-only, except cockroach_control (sold as a
 *    two-treatment package — the included second visit applies regardless
 *    of species, matching its pre-cutover project-flow behavior).
 *  - two-treatment packages stop at visit 2: the included follow-up
 *    (followup_included) resolves the same ALERT profile on ITS completion,
 *    which would otherwise suggest a third $0 visit, then a fourth.
 *  - german_roach_knockdown: the tech's explicit "No" wins over the
 *    standing ALERT policy; the selected window drives the suggested date.
 *  - palmetto_roach_knockdown: profile policy is 'none', but a checklist
 *    "Yes" earns the suggestion (same 14-day default interval as German).
 */
function typedFollowupVerdict({ scheduledService = {}, profile = {}, findingsType = null, values = {} } = {}) {
  // Lazy require: project-completion requires job-status, and job-status
  // lazy-requires this module from its cancellation hook — a top-level
  // require here would close that cycle at load time.
  const { projectFollowupSuggestion } = require('./project-completion');

  let suggestion = projectFollowupSuggestion({
    scheduledService,
    project: {},
    profile,
  });
  const vals = values || {};

  if (suggestion?.required && findingsType === 'cockroach'
    && profile?.serviceKey !== 'cockroach_control'
    && String(vals.species || '') !== 'German') {
    suggestion = { ...suggestion, required: false, reason: 'species_not_german' };
  }
  if (suggestion?.required
    && TWO_TREATMENT_PACKAGE_KEYS.has(profile?.serviceKey)
    && scheduledService.followup_included === true) {
    suggestion = { ...suggestion, required: false, reason: 'included_followup_visit' };
  }
  if (suggestion?.required && findingsType === 'german_roach_knockdown') {
    if (String(vals.followup_required || '') === 'No') {
      suggestion = { ...suggestion, required: false, reason: 'tech_marked_not_required' };
    } else {
      const windowDays = KNOCKDOWN_FOLLOWUP_WINDOW_DAYS[String(vals.followup_window || '')];
      if (windowDays && windowDays !== suggestion.days) {
        suggestion = projectFollowupSuggestion({
          scheduledService,
          project: {},
          profile: { ...profile, followupPolicy: 'alert', defaultFollowupDays: windowDays },
        });
      }
    }
  }
  if (findingsType === 'palmetto_roach_knockdown'
    && String(vals.followup_needed || '') === 'Yes'
    && !suggestion?.required) {
    suggestion = {
      ...projectFollowupSuggestion({
        scheduledService,
        project: {},
        profile: { ...profile, followupPolicy: 'alert', defaultFollowupDays: profile?.defaultFollowupDays ?? 14 },
      }),
      reason: 'tech_marked_needed',
    };
  }
  return suggestion;
}

/**
 * Re-derive the follow-up verdict for an ALREADY-COMPLETED visit from its
 * committed typedReportSnapshot. Returns null when the visit never earned a
 * typed verdict (untyped profile, no snapshot, type mismatch, not
 * completed) — callers treat null as "no obligation derivable".
 */
async function typedFollowupObligationForCompletedSource({ scheduledService, knex = db } = {}) {
  if (!scheduledService?.id || scheduledService.status !== 'completed') return null;
  const record = await knex('service_records')
    .where({ scheduled_service_id: scheduledService.id })
    .orderBy('created_at', 'desc')
    .first()
    .catch(() => null);
  if (!record) return null;

  // The completion FROZE its final verdict into structured_notes (both
  // directions). Replaying it verbatim is the correctness rule: the live
  // profile is mutable — deactivating or repointing it must not drop an
  // already-promised included treatment, and a policy newly turned on must
  // not retroactively invent one for an old visit (Codex r4).
  const frozenVerdict = parseJsonObjectSafe(record.structured_notes).typedFollowupVerdict;
  if (frozenVerdict && typeof frozenVerdict.required === 'boolean') {
    return { suggestion: frozenVerdict, profile: null, serviceRecordId: record.id, frozen: true };
  }

  // Pre-freeze records (completed before this shipped): re-derive from the
  // committed snapshot + live profile — the best available approximation.
  const { resolveCompletionProfileForScheduledService } = require('./service-completion-profiles');
  const profile = await resolveCompletionProfileForScheduledService(scheduledService, knex).catch(() => null);
  if (!profile?.findingsType) return null;
  const snapshot = parseJsonObjectSafe(record.service_data).typedReportSnapshot;
  if (!snapshot || String(snapshot.type || '') !== String(profile.findingsType)) return null;
  const suggestion = typedFollowupVerdict({
    scheduledService,
    profile,
    findingsType: profile.findingsType,
    values: snapshot.values || {},
  });
  return { suggestion, profile, serviceRecordId: record.id };
}

/**
 * Park the follow_up_needed dispatch alert for a completed source visit,
 * unless the obligation is already covered:
 *  - a LIVE linked child (followup_source_service_id, not
 *    cancelled/skipped) means the follow-up is on the schedule — the call
 *    pipeline pre-books visit 2 for cockroach_control, and alerting on a
 *    booked follow-up parks a false exception;
 *  - an unresolved (follow_up_needed, job_id) alert means it's already
 *    parked (incl. the visit-outcome=follow_up_needed path). This pre-check
 *    is load-bearing — see module header.
 * Returns { created, skipped } for callers/tests.
 */
async function parkFollowupAlert({
  scheduledService,
  suggestion,
  serviceRecordId = null,
  serviceName = null,
  customerName = null,
  source = 'typed_completion',
  knex = db,
  trx = null,
} = {}) {
  if (!suggestion?.required || !scheduledService?.id) {
    return { created: false, skipped: 'not_required' };
  }
  const q = trx || knex;
  const liveChild = await q('scheduled_services')
    .where({ followup_source_service_id: scheduledService.id })
    .whereNotIn('status', FOLLOWUP_CHILD_INACTIVE_STATUSES)
    .first('id');
  if (liveChild) return { created: false, skipped: 'followup_already_booked', childId: liveChild.id };
  const existing = await q('dispatch_alerts')
    .where({ type: 'follow_up_needed', job_id: scheduledService.id })
    .whereNull('resolved_at')
    .first('id');
  if (existing) return { created: false, skipped: 'already_parked', alertId: existing.id };

  const { createAlertOnce } = require('./dispatch-alerts');
  let resolvedCustomerName = customerName;
  if (!resolvedCustomerName && scheduledService.customer_id) {
    const cust = await q('customers')
      .where({ id: scheduledService.customer_id })
      .first('first_name', 'last_name')
      .catch(() => null);
    resolvedCustomerName = [cust?.first_name, cust?.last_name].filter(Boolean).join(' ').trim() || null;
  }
  const result = await createAlertOnce({
    type: 'follow_up_needed',
    severity: 'info',
    techId: scheduledService.technician_id || null,
    jobId: scheduledService.id,
    trx: trx || undefined,
    payload: {
      source,
      serviceRecordId,
      serviceType: scheduledService.service_type || serviceName || null,
      customerId: scheduledService.customer_id || null,
      customerName: resolvedCustomerName,
      followupPolicy: suggestion.policy,
      followupDays: suggestion.days,
      suggestedFollowupDate: suggestion.suggestedDate,
    },
    existingPayloadSource: source,
  });

  // Post-COMMIT cross-check closes the booking race (Codex r4): the
  // live-child read above and a concurrent /schedule-followup booking are
  // not serialized, so the booking's resolve pass can run before this
  // alert commits — leaving a live appointment plus a false open card.
  // Every interleaving is covered by the pair of post-commit passes: if
  // the child committed before THIS check, we resolve our own card here;
  // if it commits after, the booking's own resolveOpenFollowupAlerts pass
  // (which runs after ITS commit) sees our already-committed card and
  // resolves it. Best-effort — a failure leaves an info card staff can
  // one-click resolve, never a lost obligation.
  const alertId = result?.row?.id || null;
  if (result?.created && alertId) {
    const crossCheck = async () => {
      try {
        const bookedChild = await knex('scheduled_services')
          .where({ followup_source_service_id: scheduledService.id })
          .whereNotIn('status', FOLLOWUP_CHILD_INACTIVE_STATUSES)
          .first('id');
        if (bookedChild) {
          const { resolveAlert } = require('./dispatch-alerts');
          await resolveAlert({ id: alertId, resolvedBy: null });
        }
      } catch (e) {
        logger.warn(`[typed-followup] post-park cross-check failed for ${scheduledService.id}: ${e.message}`);
      }
    };
    if (trx) {
      if (trx.executionPromise) trx.executionPromise.then(crossCheck).catch(() => {});
    } else {
      await crossCheck();
    }
  }
  return { created: !!result?.created, alertId };
}

/**
 * Shared-status-writer hook (transitionJobStatus): when a visit transitions
 * to cancelled/skipped/no_show and it was the linked follow-up child of a completed
 * typed visit, the source's obligation resurfaces — without this, an
 * ordinary cancellation left the required visit with neither an appointment
 * nor an open alert (the booking resolved it), permanently losing the
 * follow-up. Best-effort BY DESIGN: a customer-affecting cancellation must
 * never be blocked by an ops-alert write; the dedup in parkFollowupAlert
 * makes any retry of the cancellation re-attempt the park safely.
 */
async function handleFollowupChildCancellation({ jobId, toStatus, trx = null } = {}) {
  if (!FOLLOWUP_CHILD_INACTIVE_STATUSES.includes(String(toStatus || ''))) return { skipped: 'not_cancellation' };
  const q = trx || db;
  try {
    const child = await q('scheduled_services')
      .where({ id: jobId })
      .first('id', 'followup_source_service_id');
    if (!child?.followup_source_service_id) return { skipped: 'not_followup_child' };
    const otherLive = await q('scheduled_services')
      .where({ followup_source_service_id: child.followup_source_service_id })
      .whereNot('id', child.id)
      .whereNotIn('status', FOLLOWUP_CHILD_INACTIVE_STATUSES)
      .first('id');
    if (otherLive) return { skipped: 'replacement_live' };
    const source = await q('scheduled_services')
      .where({ id: child.followup_source_service_id })
      .first();
    if (!source) return { skipped: 'source_missing' };
    const obligation = await typedFollowupObligationForCompletedSource({ scheduledService: source, knex: q });
    if (!obligation?.suggestion?.required) return { skipped: 'not_required' };
    return await parkFollowupAlert({
      scheduledService: source,
      suggestion: obligation.suggestion,
      serviceRecordId: obligation.serviceRecordId,
      serviceName: obligation.profile?.serviceName || null,
      source: 'followup_cancelled',
      trx,
      knex: q,
    });
  } catch (e) {
    logger.warn(`[typed-followup] re-park after child cancellation failed for ${jobId}: ${e.message}`);
    return { skipped: 'error' };
  }
}

module.exports = {
  typedFollowupVerdict,
  typedFollowupObligationForCompletedSource,
  parkFollowupAlert,
  handleFollowupChildCancellation,
  KNOCKDOWN_FOLLOWUP_WINDOW_DAYS,
  TWO_TREATMENT_PACKAGE_KEYS,
  FOLLOWUP_CHILD_INACTIVE_STATUSES,
};

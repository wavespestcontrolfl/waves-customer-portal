/**
 * Sole writer for scheduled_services.status transitions going forward.
 * Wraps the status update + audit log insert in a single Knex
 * transaction and emits TWO Socket.io events *after* commit:
 *
 *   - customer:job_update    → customer:<customer_id> room (one customer)
 *   - dispatch:job_update    → dispatch:admins        room (all staff)
 *
 * Both fire from the same trx commit. Either both fire (commit) or
 * neither fires (rollback) — see "Post-commit emit" below. They go
 * to different rooms with different payloads (see PII BOUNDARY and
 * ADMIN PAYLOAD SCOPE blocks).
 *
 * Atomicity contract:
 *   The scheduled_services.status update AND the job_status_history
 *   insert MUST happen on the same trx handle. If they're split — even
 *   inside a try/catch — there is a window where the audit table says
 *   "transitioned to on_site" but the source-of-truth column still
 *   says "en_route" (or vice versa). Per-table separate transactions
 *   are not equivalent. The atomic guard below uses the shared trx
 *   for both writes. If either fails, both roll back and the emits
 *   never fire.
 *
 * Post-commit emit:
 *   Same pattern as services/tech-status.js#upsertTechStatus. If
 *   the caller passes their own `trx`, this function uses it for the
 *   writes and chains both emits on `trx.executionPromise` so the
 *   broadcasts fire after the caller's commit, and are suppressed if
 *   the caller rolls back. If no trx is passed, this function creates
 *   one, commits it, and emits inline. Either way, the trx scope
 *   wraps both writes and the emits happen after commit.
 *
 *   Both emits chain on the same promise — they fire in sequence
 *   after commit. There's no scenario where one fires and the other
 *   doesn't (short of the io instance disappearing between calls,
 *   which would be a runtime crash, not a leak).
 *
 * Atomic guard:
 *   The status update is gated on the row currently holding
 *   `fromStatus` — if a racing transition already advanced past it,
 *   the UPDATE affects 0 rows and the function throws. Same shape as
 *   track-transitions.markEnRoute. fromStatus is required (Codex P1
 *   on #290) — null was a footgun that bypassed the guard.
 *
 * Auto-resolve overdue-family alerts on terminal-ish transitions:
 *   When toStatus is in OVERDUE_ALERT_AUTO_RESOLVE_STATUSES (on_site,
 *   completed, cancelled, skipped), any open tech_late OR
 *   unassigned_overdue alert for the job is resolved inside the SAME
 *   trx via resolveAlert(trx). The dispatch:alert_resolved broadcast
 *   chains on the same commit, so the Action Queue cards disappear
 *   for every connected dispatcher the instant the job moves to
 *   on_site (etc.). If the outer transition rolls back, the alert
 *   resolution rolls back too.
 *
 * ============================================================
 * PII BOUNDARY — READ THIS BEFORE MODIFYING THE CUSTOMER PAYLOAD
 * ============================================================
 *   The `customer:job_update` payload is sent to a customer's own
 *   room, where it is consumed by the customer's portal / live
 *   tracker UI. The customer can inspect this object via browser
 *   devtools — assume every field reaches them.
 *
 *   The current allowlist:
 *     job_id, status, eta, tech_id, tech_first_name, updated_at
 *
 *   NEVER include in this payload:
 *     - tech last name
 *     - tech license number, certifications, contact info
 *     - internal job notes (notes, internal_notes, technician_notes)
 *     - profit / cost / pricing data
 *     - product names, EPA reg numbers, application rates,
 *       chemical lot numbers, dilution rates
 *     - other customers' data (cross-customer contamination)
 *     - admin-only fields from scheduled_services (anything that
 *       an admin route filters on but a customer route doesn't)
 *
 *   Customer-facing payload — additions to this object require
 *   security review. Internal/admin data flows via dispatch:job_update
 *   only — that event broadcasts to staff (dispatch:admins room),
 *   not to customers, so admin-only fields belong on the admin
 *   payload below.
 * ============================================================
 *
 * ============================================================
 * ADMIN PAYLOAD SCOPE — what dispatch:job_update can carry
 * ============================================================
 *   The `dispatch:job_update` payload is sent only to dispatch:admins
 *   (staff: admin + technician), so it MAY include data that the
 *   customer payload above redacts:
 *
 *     - tech full name
 *     - customer first name (display in roster) — full
 *       customer record stays in the admin detail-view fetch,
 *       not on this real-time event
 *     - service_type (what's being done)
 *     - scheduled_date / window_start / window_end (timing)
 *     - notes (gate codes, dog warnings — coordinator context)
 *     - internal_notes (dispatcher-to-tech context)
 *     - from_status (so the board can animate the transition)
 *     - transitioned_by (audit attribution on-screen)
 *
 *   It does NOT carry, even on the admin path:
 *     - pricing / profit / cost (admin-only detail-view fetch)
 *     - product names / EPA reg numbers / dilution / lot numbers
 *       (compliance audit, not real-time roster context)
 *     - other customers' rows (one event = one job)
 *     - any field added to scheduled_services after this PR without
 *       a maintainer reviewing whether it belongs on a real-time
 *       event vs. an on-click fetch
 *
 *   Rule of thumb: this payload is what the dispatch board's
 *   left-pane roster and Gantt timeline need to RE-RENDER without
 *   an extra fetch. Anything richer (full chemical history, profit
 *   margin, customer's saved payment methods) is detail-view work
 *   and should be fetched on click, not pushed.
 * ============================================================
 */
const db = require('../models/db');
const { getIo } = require('../sockets');
const logger = require('./logger');
const { autoResolveOverdueAlertsForJob } = require('./dispatch-alerts');

const CUSTOMER_EVENT = 'customer:job_update';
const ADMIN_EVENT = 'dispatch:job_update';
const ADMIN_ROOM = 'dispatch:admins';
const STALE_TECH_STATUS_MS = 5 * 60 * 1000;
const CUSTOMER_ETA_TIMEOUT_MS = 750;

// Strictly-increasing claim timestamps within this process — the sweep
// groups series claims by (customer, exact token), and two independent
// same-millisecond cancels must not read as one series (codex #3233 r12;
// cross-process same-ms collision remains theoretical and its consequence
// is only a combined-copy notice).
let lastClaimMs = 0;
function nextClaimTs() {
  const now = Date.now();
  lastClaimMs = now > lastClaimMs ? now : lastClaimMs + 1;
  return new Date(lastClaimMs);
}

function customerRoom(customerId) {
  return `customer:${customerId}`;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

async function buildCustomerEta(row, toStatus, bouncieService) {
  if (toStatus !== 'en_route') return null;
  const techLat = finiteNumber(row.tech_lat);
  const techLng = finiteNumber(row.tech_lng);
  const customerLat = finiteNumber(row.customer_latitude);
  const customerLng = finiteNumber(row.customer_longitude);
  if (techLat == null || techLng == null || customerLat == null || customerLng == null) {
    return null;
  }

  const updatedAt = row.tech_location_updated_at || null;
  const updatedMs = updatedAt ? new Date(updatedAt).getTime() : NaN;
  if (!Number.isFinite(updatedMs) || Date.now() - updatedMs > STALE_TECH_STATUS_MS) {
    return null;
  }

  try {
    const svc = bouncieService || require('./bouncie');
    const etaPromise = Promise.resolve(
      svc.calculateETAFromCoords(techLat, techLng, customerLat, customerLng)
    ).catch((err) => {
      logger.warn(`[job-status] customer ETA calculation failed for ${row.job_id}: ${err.message}`);
      return null;
    });
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve(null), CUSTOMER_ETA_TIMEOUT_MS);
    });
    const eta = await Promise.race([etaPromise, timeoutPromise]);
    if (!eta) return null;
    return {
      minutes: eta.etaMinutes ?? null,
      distanceMiles: eta.distanceMiles ?? null,
      source: eta.source || null,
      techUpdatedAt: updatedAt,
    };
  } catch (err) {
    logger.warn(`[job-status] customer ETA lookup failed for ${row.job_id}: ${err.message}`);
    return null;
  }
}

/**
 * Build BOTH the customer-facing and admin-facing payloads from a
 * freshly-committed row. Reads via the trx so we see post-update
 * values without an extra round-trip after commit. Single LEFT JOIN
 * pulls every column either payload needs in one query.
 *
 * @returns {Promise<{
 *   customerId: string,
 *   customerPayload: object,
 *   adminPayload: object,
 * }>}
 */
async function buildPayloads(trx, jobId, fromStatus, toStatus, transitionedBy) {
  const row = await trx('scheduled_services as s')
    .leftJoin('technicians as t', 's.technician_id', 't.id')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .leftJoin('tech_status as ts', 's.technician_id', 'ts.tech_id')
    .where('s.id', jobId)
    .first(
      's.id as job_id',
      's.customer_id',
      's.technician_id as tech_id',
      's.service_type',
      's.scheduled_date',
      's.window_start',
      's.window_end',
      's.notes',
      's.internal_notes',
      's.updated_at',
      't.name as tech_full_name',
      'c.first_name as cust_first_name',
      'c.latitude as customer_latitude',
      'c.longitude as customer_longitude',
      'ts.lat as tech_lat',
      'ts.lng as tech_lng',
      'ts.location_updated_at as tech_location_updated_at'
    );
  if (!row) throw new Error(`transitionJobStatus: job ${jobId} not found`);

  const techFirstName = row.tech_full_name
    ? row.tech_full_name.split(' ')[0]
    : null;

  const customerPayload = {
    // ── PII BOUNDARY: see file header. Strict allowlist. ─────────────
    job_id: row.job_id,
    status: toStatus,
    eta: await buildCustomerEta(row, toStatus),
    tech_id: row.tech_id,
    tech_first_name: techFirstName,
    updated_at: row.updated_at,
  };

  const adminPayload = {
    // ── ADMIN PAYLOAD SCOPE: see file header. Broader than customer
    //    but still excludes pricing / products / EPA / etc. ──────────
    job_id: row.job_id,
    customer_id: row.customer_id,
    cust_first_name: row.cust_first_name, // customer-first-name only;
                                          // last name stays in detail
                                          // fetch (less PII surface
                                          // even on admin channel)
    status: toStatus,
    from_status: fromStatus,
    tech_id: row.tech_id,
    tech_full_name: row.tech_full_name,   // admin sees full name
    service_type: row.service_type,
    scheduled_date: row.scheduled_date,
    window_start: row.window_start,
    window_end: row.window_end,
    notes: row.notes,
    internal_notes: row.internal_notes,
    transitioned_by: transitionedBy,
    updated_at: row.updated_at,
  };

  return {
    customerId: row.customer_id,
    customerPayload,
    adminPayload,
  };
}

/**
 * Transition a scheduled_services row from fromStatus to toStatus.
 * Writes the status column and appends to job_status_history in the
 * same transaction; emits customer:job_update AND dispatch:job_update
 * after commit (both fire, or neither fires).
 *
 * @param {object} args
 * @param {string} args.jobId           required, scheduled_services.id
 * @param {string} args.fromStatus      required for the atomic guard.
 *                                       Must match the row's current
 *                                       status; null/undefined rejected.
 * @param {string} args.toStatus        required, must be in the
 *                                       scheduled_services_status_check
 *                                       value set
 * @param {string} args.transitionedBy  required, technicians.id of the
 *                                       admin/tech who triggered it
 * @param {number|string} [args.lat]    optional audit GPS latitude
 * @param {number|string} [args.lng]    optional audit GPS longitude
 * @param {string} [args.notes]         optional audit note for the transition
 * @param {object} [args.trx]           optional Knex transaction; if
 *                                       passed, both writes use it and
 *                                       BOTH emits chain on commit. If
 *                                       not passed, this function owns
 *                                       the trx end-to-end.
 * @returns {Promise<{customerPayload: object, adminPayload: object}>}
 *           the two payloads broadcast (or, with an outer trx, the
 *           payloads that will broadcast on commit)
 */
async function transitionJobStatus({ jobId, fromStatus, toStatus, transitionedBy, lat, lng, notes, trx, notifyCustomer, cancelNoticeToken }) {
  if (!jobId || !toStatus || fromStatus == null) {
    throw new Error(
      'transitionJobStatus: jobId, fromStatus, and toStatus are required'
    );
  }

  const auditLat = finiteNumber(lat);
  const auditLng = finiteNumber(lng);
  const auditNotes = notes == null || notes === '' ? null : String(notes);

  // Set inside doWrites when this transition durably claimed a pending
  // cancellation-notice obligation; read by the post-commit worker.
  let cancelNoticeClaimTs = null;
  let cancelNoticeLateClaim = false;

  async function doWrites(t) {
    // A pending outbound-callback booking (AI call pipeline, held for office
    // review) must NOT advance to a day-of / operational status until the office
    // confirms it — en_route fires the customer tracking SMS, completed mints an
    // invoice, etc. Guarded HERE (the one shared status writer) so EVERY caller
    // — dispatch, tech-track, admin-schedule — is covered, not just some routes.
    // Only 'confirmed' / 'cancelled' / 'skipped' are allowed out of the pending
    // review state — confirm approves it, cancel/skip reject it (the dispatch
    // Skip action). Any other (en_route/on_site/completed/etc.) is blocked.
    if (!['confirmed', 'cancelled', 'skipped'].includes(toStatus)) {
      const { CALL_OUTBOUND_REVIEW_SOURCE_ACTION } = require('./call-booking-source-actions');
      const guardRow = await t('scheduled_services')
        .where({ id: jobId })
        .first('source_action', 'status', 'customer_confirmed');
      if (guardRow
        && guardRow.source_action === CALL_OUTBOUND_REVIEW_SOURCE_ACTION
        && guardRow.status === 'pending'
        && !guardRow.customer_confirmed) {
        // Typed operational conflict, not a plain Error: shared-writer callers
        // (tech-track en-route/on-site, dispatch, admin-schedule) allow
        // 'pending' as a source status, so this is an EXPECTED block for them
        // — they translate the code to a 409, same as the 'not in state' race.
        // A bare Error here bubbled to Express as a 500.
        const guardErr = new Error(`transitionJobStatus: ${jobId} is a pending outbound-review booking awaiting office confirmation (cannot ${toStatus})`);
        guardErr.code = 'OUTBOUND_REVIEW_UNCONFIRMED';
        throw guardErr;
      }
    }
    // Atomic guard: only update if the row is currently in fromStatus.
    // 0-row update means a racing transition already advanced past it
    // (or fromStatus is wrong). Either way, we abort — the audit log
    // would otherwise record a transition that didn't happen on the
    // source table.
    const updated = await t('scheduled_services')
      .where({ id: jobId, status: fromStatus })
      .update({ status: toStatus, updated_at: t.fn.now() });
    if (updated === 0) {
      throw new Error(
        `transitionJobStatus: ${jobId} not in state ${fromStatus} (racing transition or stale fromStatus)`
      );
    }

    // Audit log on the SAME trx. If the insert fails, the status
    // update above rolls back too — that's the atomicity guarantee.
    await t('job_status_history').insert({
      job_id: jobId,
      from_status: fromStatus,
      to_status: toStatus,
      transitioned_by: transitionedBy || null,
      lat: auditLat,
      lng: auditLng,
      notes: auditNotes,
    });

    // Outbound-review CONFIRMATION is the booking moment for the
    // inspection credit, and redemption is evidence-required — so the
    // event commits WITH the confirmation, not in the post-commit hook a
    // deploy can lose (Codex #3178 r33 P2). Savepoint-confined: an
    // evidence hiccup never blocks the confirm (and the r31 outbox then
    // covers even that residue). The hook's own marker call remains as an
    // idempotent belt (onConflict ignore).
    if (String(toStatus || '') === 'confirmed') {
      try {
        const { CALL_OUTBOUND_REVIEW_SOURCE_ACTION } = require('./call-booking-source-actions');
        const confirmedRow = await t('scheduled_services')
          .where({ id: jobId })
          .first('source_action', 'customer_id');
        if (confirmedRow
          && confirmedRow.source_action === CALL_OUTBOUND_REVIEW_SOURCE_ACTION
          && confirmedRow.customer_id) {
          await require('./inspection-credit').markBookingForInspectionCredit(t, {
            customerId: confirmedRow.customer_id,
            scheduledServiceId: jobId,
            source: 'phone_call',
          });
        }
      } catch (evidenceErr) {
        logger.warn(`[job-status] outbound-confirm credit evidence failed for ${jobId}: ${evidenceErr.message}`);
      }
    }

    // Auto-resolve any open overdue-family alerts (tech_late +
    // unassigned_overdue) when the transition makes the "running
    // late" signal obsolete. Same trx — if the outer transition
    // rolls back, the alert resolution rolls back with it. The
    // helper internally calls resolveAlert(trx), which defers the
    // dispatch:alert_resolved broadcast to commit and suppresses on
    // rollback (PR #311). No-op for non-terminal toStatus, so safe
    // to call unconditionally.
    await autoResolveOverdueAlertsForJob({
      jobId, resolvedBy: transitionedBy, trx: t, toStatus,
    });

    // Durable cancellation-notice obligation (codex #3233 r4): for
    // hook-owned cancel paths the claim commits WITH the transition — a
    // crash after commit can no longer lose the notice (the 15-minute
    // reminder cron sweeps stale 'pending' claims). Caller-owned paths
    // ('caller') manage their own claims via handleCancellation.
    // Savepoint-confined best-effort: a claim hiccup must never block the
    // cancellation itself (an error inside a Postgres trx aborts every
    // later statement, so the try/catch needs its own savepoint).
    if (['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'].includes(String(toStatus || ''))) {
      // A visit transitioned BACK to a live status (compensated cancel,
      // re-arm) sheds any cancellation-notice marker — a stale terminal
      // 'suppressed'/'sent' would otherwise block the notice for a later
      // real cancellation (codex r8; closes the r3 compensation window).
      try {
        await t.transaction(async (sp) => {
          await sp('appointment_reminders')
            .where({ scheduled_service_id: jobId })
            .whereNotNull('cancellation_notice_state')
            .update({ cancellation_notice_at: null, cancellation_notice_state: null, updated_at: new Date() });
        });
      } catch (clearErr) {
        logger.warn(`[job-status] cancellation-marker clear failed for ${jobId}: ${clearErr.message}`);
      }
    }
    if (String(toStatus || '') === 'cancelled') {
      try {
        const { isEnabled } = require('../config/feature-gates');
        if (isEnabled('cancelNoticeHook')) {
          await t.transaction(async (sp) => {
            // Series routes pass ONE shared token for every target so the
            // sweep sees a single group even if the process dies before
            // the post-commit series handler coalesces them (codex r10).
            const claimTs = cancelNoticeToken instanceof Date ? cancelNoticeToken : nextClaimTs();
            // 'caller_suppress' = the route will suppress (operator chose
            // no-text / consolidated comms): finalize terminally NOW so a
            // crash before the route's own call cannot let the sweep text
            // against that intent (codex r8).
            // 'caller' paths get a durable 'pending' claim too (codex r7):
            // their awaited handleCancellation ADOPTS it (tokenless claims
            // accept pending rows) and settles send/suppress; if the route
            // crashes in its post-commit window, the sweep settles instead
            // — the obligation can no longer vanish. Only an explicit
            // suppress intent finalizes terminally here.
            let targetState = (notifyCustomer === false || notifyCustomer === 'caller_suppress')
              ? 'suppressed'
              : (notifyCustomer === 'caller' ? 'pending_notify' : 'pending');
            // Merged-slot survivor (codex r12): when the status-sync
            // trigger promoted a sibling for the SAME customer/slot, the
            // customer still has a live visit at that time — a
            // cancellation text would be wrong. Suppress terminally.
            if (targetState !== 'suppressed') {
              const own = await sp('appointment_reminders')
                .where({ scheduled_service_id: jobId })
                .first('customer_id', 'appointment_time');
              if (own) {
                const survivor = await sp('appointment_reminders')
                  .where({ customer_id: own.customer_id, appointment_time: own.appointment_time, cancelled: false })
                  .whereNot('scheduled_service_id', jobId)
                  .first('id');
                if (survivor) targetState = 'suppressed';
              }
            }
            const claimedRows = await sp('appointment_reminders')
              .where({ scheduled_service_id: jobId })
              .where(function claimable() {
                this.whereNull('cancellation_notice_at').orWhere(function staleLease() {
                  this.whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
                    .where('cancellation_notice_at', '<', sp.raw("now() - interval '15 minutes'"));
                });
              })
              .update({ cancellation_notice_at: claimTs, cancellation_notice_state: targetState, updated_at: claimTs });
            // The immediate post-commit worker runs only for hook-owned
            // paths; 'caller' claims are settled by the route (or sweep).
            if (claimedRows && targetState === 'pending' && notifyCustomer !== 'caller') cancelNoticeClaimTs = claimTs;
          });
        }
      } catch (claimErr) {
        // The transition still commits; the post-commit worker attempts a
        // LATE claim so the obligation isn't lost (codex r20).
        cancelNoticeLateClaim = notifyCustomer === undefined || notifyCustomer === true;
        logger.warn(`[job-status] cancellation-notice claim failed for ${jobId}: ${claimErr.message}`);
      }
    }

    return buildPayloads(t, jobId, fromStatus, toStatus, transitionedBy);
  }

  function emitBoth(customerId, customerPayload, adminPayload) {
    // Customer event first, then admin event. Order doesn't matter
    // semantically (different rooms, different payloads, different
    // consumers) but keeping a deterministic sequence makes log
    // ordering easier to follow.
    emitToCustomer(customerId, customerPayload);
    emitToAdmins(adminPayload);
  }

  function processCancelNoticeClaim() {
    // Post-commit best-effort attempt on the durably-claimed notice (codex
    // #3233 r4): the 'pending' claim committed WITH the transition inside
    // doWrites, so a crash here just leaves it for the 15-minute
    // reminder-cron sweep (sweepStaleCancellationClaims). This immediate
    // path sends only when delivery evidence ALREADY exists; a no-evidence
    // result stays pending rather than terminally suppressing — an
    // in-flight reminder is dispatched to the provider BEFORE its audit
    // row persists, and the sweep re-checks after the lease expires.
    // Evidence = THIS visit's messaging_audit_log rows (sms_log never
    // stores the visit id) with provider acceptance and a genuine Twilio
    // SID; sends predating the linkage close silently via the sweep.
    if (!cancelNoticeClaimTs && !cancelNoticeLateClaim) return;
    void (async () => {
      try {
        if (!cancelNoticeClaimTs && cancelNoticeLateClaim) {
          // In-trx claim failed (r20): take it now, outside the trx.
          const lateTs = nextClaimTs();
          const won = await db('appointment_reminders')
            .where({ scheduled_service_id: jobId })
            .where(function claimable() {
              this.whereNull('cancellation_notice_at')
                .orWhere(function stale() {
                  // Singleton-only (codex r21): stale shared groups are
                  // the sweep's — it recovers with the combined copy.
                  this.whereIn('cancellation_notice_state', ['pending', 'pending_notify'])
                    .where('cancellation_notice_at', '<', db.raw("now() - interval '15 minutes'"))
                    .whereRaw('NOT EXISTS (SELECT 1 FROM appointment_reminders sib WHERE sib.cancellation_notice_at = appointment_reminders.cancellation_notice_at AND sib.id <> appointment_reminders.id AND sib.cancellation_notice_state IN (\'pending\', \'pending_notify\'))');
                });
            })
            .update({ cancellation_notice_at: lateTs, cancellation_notice_state: 'pending', updated_at: lateTs });
          if (!won) return;
          cancelNoticeClaimTs = lateTs;
        }
        let delivered = Boolean(await db('messaging_audit_log')
          .where({ appointment_id: String(jobId) })
          .whereIn('purpose', ['appointment_reminder_72h', 'appointment_reminder_24h', 'appointment_confirmation'])
          .whereNotNull('sent_at')
          .whereRaw("(provider_message_id ~ '^(SM|MM)' OR channel = 'email')")
          .first('id'));
        if (!delivered) {
          // Appointment EMAILS audit into customer_interactions, not
          // messaging_audit_log (codex r23).
          delivered = Boolean(await db('customer_interactions')
            .where({ interaction_type: 'email_outbound' })
            .whereRaw("metadata->>'scheduled_service_id' = ?", [String(jobId)])
            .whereRaw("metadata->>'status' = 'sent'")
            .first('id'));
        }
        if (!delivered) {
          // Legacy-grace (codex r15): rows created before the linkage
          // epoch have unlinked audits — judge announcement by the
          // reminder flags for that bounded window only.
          delivered = Boolean(await db('appointment_reminders')
            .where({ scheduled_service_id: jobId })
            // Self-calibrating epoch (codex r27) — see the sweep's leg.
            .whereRaw("created_at < (SELECT COALESCE(MIN(created_at), 'infinity') FROM messaging_audit_log WHERE appointment_id IS NOT NULL AND purpose IN ('appointment_reminder_72h', 'appointment_reminder_24h', 'appointment_confirmation'))")
            .where(function announced() {
              this.where('reminder_72h_sent', true)
                .orWhere('reminder_24h_sent', true)
                .orWhere('confirmation_sent', true);
            })
            // Flags are bookkeeping — also require a REAL customer-level
            // reminder/confirmation SMS (codex r29).
            .whereRaw(`EXISTS (
              SELECT 1 FROM sms_log lsl
              WHERE lsl.customer_id = appointment_reminders.customer_id
                AND lsl.direction = 'outbound'
                AND lsl.message_type IN ('reminder_72h', 'appointment_reminder', 'confirmation')
                AND lsl.twilio_sid ~ '^(SM|MM)'
            )`)
            .first('id'));
        }
        if (!delivered) return;
        const AppointmentReminders = require('./appointment-reminders');
        await AppointmentReminders.handleCancellation(jobId, { claimToken: cancelNoticeClaimTs });
      } catch (e) {
        logger.warn(`[job-status] cancellation-notice worker failed for ${jobId}: ${e.message}`);
      }
    })();
  }

  function maybeReparkFollowupObligation() {
    // Cancelling/skipping/no-showing a completion-linked follow-up child
    // resurfaces the source visit's owed follow-up as a fresh dispatch
    // alert — the booking resolved it, and without this an ordinary
    // cancellation left the obligation with neither an appointment nor an
    // open alert (a no_show child likewise no longer covers it; Codex r3).
    // Runs POST-COMMIT, fire-and-forget: it must never block or poison the
    // cancellation transaction (an error inside a Postgres trx aborts every
    // later statement), and the park is dedup-guarded so a same-status
    // cancel re-send safely re-attempts it. Guarded here (the shared
    // status writer) so every transitionJobStatus caller is covered; the
    // one direct-update cancellation writer (Intelligence Bar
    // cancel_appointment) now routes through this writer too. Lazy
    // require: the module's dependency chain reaches back into job-status.
    const { handleFollowupChildCancellation, handleFollowupChildRevival } = require('./typed-followup-obligation');
    if (['cancelled', 'skipped', 'no_show'].includes(String(toStatus || ''))) {
      void handleFollowupChildCancellation({ jobId, toStatus }).catch((e) => {
        logger.warn(`[job-status] follow-up re-park hook failed for ${jobId}: ${e.message}`);
      });
      // Invoice void + inspection-credit reversal seam for every non-live
      // transition (Codex #3178 r25 P1): 'skipped' reached no route branch
      // that ran it, leaving a skipped visit's redeemed credit spendable
      // until the hourly sweep. Guarded HERE — the one shared status
      // writer — so no transition surface can forget it; the helper is
      // idempotent, so routes that also run it (cancel/no-show branches)
      // double-run safely. Post-commit by placement, best-effort by
      // contract.
      void require('./invoice').voidOpenInvoicesForCancelledService(jobId).catch((e) => {
        logger.warn(`[job-status] non-live money seam failed for ${jobId}: ${e.message}`);
      });
    } else {
      // Reverse direction: a compensated cancellation (offboarding /
      // cancellation-processor revert a cancel when tracker state raced) or
      // any other transition back to a covering status re-covers the source
      // obligation — resolve the typed cards the re-park minted, or they
      // linger as false exceptions the reverse transition never cleans
      // (local Codex audit P1).
      void handleFollowupChildRevival({ jobId, toStatus }).catch((e) => {
        logger.warn(`[job-status] follow-up revival hook failed for ${jobId}: ${e.message}`);
      });
    }
  }

  if (trx) {
    // Caller-owned trx. Do the writes; defer both emits until the
    // caller's outer transaction resolves. trx.executionPromise is
    // the promise returned by db.transaction(fn) — resolves on
    // commit, rejects on rollback.
    const { customerId, customerPayload, adminPayload } = await doWrites(trx);
    if (trx.executionPromise) {
      trx.executionPromise
        .then(() => {
          emitBoth(customerId, customerPayload, adminPayload);
          maybeReparkFollowupObligation();
          processCancelNoticeClaim();
        })
        .catch(() => {
          // Rollback path. Caller will see the rejection on their
          // db.transaction() promise; we just suppress both emits.
        });
    } else {
      // Defensive: some Knex test harnesses may pass a bare object as
      // trx. Fall back to inline emit (caller is responsible for
      // commit ordering in that case).
      logger.warn('[job-status] trx.executionPromise missing — emitting inline (test harness?)');
      emitBoth(customerId, customerPayload, adminPayload);
    }
    return { customerPayload, adminPayload };
  }

  // No outer trx — own the lifecycle end-to-end.
  let captured;
  await db.transaction(async (innerTrx) => {
    captured = await doWrites(innerTrx);
  });
  // trx committed by here.
  emitBoth(captured.customerId, captured.customerPayload, captured.adminPayload);
  maybeReparkFollowupObligation();
  processCancelNoticeClaim();
  return {
    customerPayload: captured.customerPayload,
    adminPayload: captured.adminPayload,
  };
}

function emitToCustomer(customerId, payload) {
  const io = getIo();
  if (!io) {
    logger.warn('[job-status] io not initialized; skipping customer broadcast');
    return;
  }
  io.to(customerRoom(customerId)).emit(CUSTOMER_EVENT, payload);
}

function emitToAdmins(payload) {
  const io = getIo();
  if (!io) {
    logger.warn('[job-status] io not initialized; skipping admin broadcast');
    return;
  }
  io.to(ADMIN_ROOM).emit(ADMIN_EVENT, payload);
}

// Terminal visit statuses are one-way (#2717 server hardening). The status
// routes read fromStatus fresh from the row, and transitionJobStatus has no
// transition matrix — only the atomic WHERE guard — so without a route-level
// check a stale board on another device could flip a completed compliance
// visit to cancelled hours after the work was done. no_show keeps its own
// bespoke guards in the routes (distinct codes/messages predate this).
//
// Scope: this conflicts ONLY on a DIFFERENT target status. A same-status
// re-send deliberately passes through (returns null) so the route reruns
// its idempotent post-commit machinery — retrying `cancelled` after a
// partial failure must still re-drive invoice voiding / reminder handling /
// track cancellation, exactly as it did before this guard existed
// (Codex P2 on #2732). Reactivating a visit means booking a new one — no
// un-cancel flow exists in the portal.
const ONE_WAY_FROM_STATUSES = new Set(['completed', 'cancelled', 'skipped']);

function evaluateTerminalTransition(fromStatus, toStatus) {
  const from = String(fromStatus || '').toLowerCase();
  if (!ONE_WAY_FROM_STATUSES.has(from)) return null;
  if (String(toStatus || '').toLowerCase() === from) return null;
  return { conflict: true, status: from };
}

module.exports = {
  nextClaimTs,
  transitionJobStatus,
  evaluateTerminalTransition,
  CUSTOMER_EVENT,
  ADMIN_EVENT,
  ADMIN_ROOM,
  customerRoom,
  _test: {
    buildCustomerEta,
  },
};

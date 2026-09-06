const db = require('../models/db');
const logger = require('./logger');
const trackTransitions = require('./track-transitions');
const { transitionJobStatus } = require('./job-status');
const { etDateString } = require('../utils/datetime-et');
const { randomUUID } = require('crypto');
const { gateEnvValue } = require('../config/feature-gates');

// customers.churn_reason is varchar(30) — keep this at/under 30 chars.
const CHURN_REASON = 'Customer cancellation request';
// The reason the portal request routes pass ("Portal cancellation request
// <id>") — persisted verbatim on each cancelled row's cancellation_reason,
// so anything matching customer-driven cancellations by reason must accept
// this prefix alongside the bare CHURN_REASON default.
const PORTAL_CANCEL_REASON_PREFIX = 'Portal cancellation request';
// Status/track-state vocabulary lives in cancellation-eligibility so the
// POST /api/requests gate, the /api/schedule payload, and this sweep can
// never drift; re-exported below for existing consumers.
const { CANCELLABLE_STATUSES, LIVE_TRACK_STATES } = require('./cancellation-eligibility');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
// Card-hold outcomes that leave money unresolved: the fee path never throws
// into the host flow — a decline / ambiguous Stripe outcome / post-charge
// write failure comes back as a reason code with the hold parked for review.
// waive_race_lost (codex C3 r2 P1): an office-initiated waive that lost the
// row to a concurrent fee worker is NOT a clean waive — a charge may still
// land while the cancellation reports the fee waived.
const CARD_HOLD_REVIEW_REASONS = new Set(['charge_failed', 'charge_review', 'charge_review_write_failed', 'waive_race_lost']);

/**
 * Process an accepted customer cancellation request, in an order chosen so the
 * highest-stakes wind-down happens before the slow parts:
 *   1. Mark the account churned / inactive AND stop billing FIRST (disable
 *      autopay, clear the next charge, disarm any armed failed-payment retry)
 *      — the per-visit sweep below can take a while (Stripe calls), and the
 *      billing crons must not find a chargeable customer in that window.
 *   2. Stop any recurring series BEFORE sweeping, so a concurrent completion
 *      can't auto-extend the series after we've read the visit list.
 *   3. Pull every upcoming cancellable visit off the calendar via the SAME
 *      composed path the admin cancel action uses: transitionJobStatus (status
 *      flip + job_status_history + overdue-alert auto-resolve + dispatch/customer
 *      broadcasts), reminder-record cancellation (suppressing the per-visit SMS —
 *      this flow sends one dedicated confirmation), open-invoice void, one-time
 *      card-hold resolution, and the customer-visible track-layer cancel. A
 *      second sweep pass catches a straggler occurrence inserted mid-flight.
 *      A visit already in progress (en_route / on_site, on either the status
 *      or the track layer) is never auto-cancelled — it's flagged into
 *      `errors` for manual handling, as is any money the helpers couldn't
 *      safely resolve (unvoidable invoice, failed/ambiguous late-cancel fee),
 *      so the admin alert never claims full auto-processing while something
 *      still needs office eyes.
 *
 * Best-effort and safe to call more than once: a retry is not just a no-op —
 * visits a prior attempt of the SAME request already flipped (identified via
 * the request-scoped job_status_history note) get their idempotent side
 * effects re-run, so a partial first attempt is REPAIRED rather than skipped.
 * An already-churned customer is re-inactivated without restamping. Each step
 * is guarded and records into `errors` so a partial failure still lets the
 * others run and is surfaced to the caller (`ok === false`) for manual review —
 * the durable service_requests row and admin notification remain regardless.
 *
 * @returns {Promise<{cancelledCount:number, recurrenceStopped:number,
 *                    churned:boolean, ok:boolean, errors:string[]}>}
 */
// Rental-state predicate, shared with the impact preview: active Waves-owned
// termite-program stations on the map, or the customer-level rental flag
// (migration 20260726000003) when none were ever pinned. The preview must
// promise a retrieval task with exactly the evidence the task uses —
// program filter matters: the table also holds rodent/trapping stations,
// which are always Waves-owned and are NOT bait-station rentals.
async function rentedTermiteStationState(customerId) {
  const stations = await db('termite_stations')
    .where({ customer_id: customerId, program: 'termite' })
    .select('id', 'owned_by', 'is_active');
  const rented = (stations || []).filter((row) => row && row.owned_by === 'waves' && row.is_active !== false);
  let flaggedRental = false;
  if (!rented.length) {
    const customer = await db('customers').where({ id: customerId }).first('termite_stations_rented');
    flaggedRental = !!(customer && customer.termite_stations_rented === true);
  }
  return { rented, flaggedRental };
}

async function raiseTermiteRetrievalTask(customerId, requestId = null, { retrieveAfter = null, termId = null, episodeKey = null } = {}) {
  const { rented, flaggedRental } = await rentedTermiteStationState(customerId);
  if (!rented.length && !flaggedRental) return { raised: false, reason: 'no_rented_stations' };
  const NotificationService = require('./notification-service');
  const count = rented.length;
  // Keyed on (PREPAID TERM, CHURN EPISODE, class) when a term governs the
  // cancel: the admin duplicate latch only echoes a prior run for 24h, so a
  // repeat end-of-coverage commit on the same decided term after that opens
  // a NEW request — a request-keyed task would hand staff a second dated
  // instruction for the same stations (same rule as the refund task,
  // prepay_refund:term:<id>). The episode (customers.churn_episode_id,
  // carried on the request) keeps a WON-BACK customer who later cancels the
  // same still-current term from being silenced by the first episode's row.
  // Dated and immediate classes stay distinct (an end_at_term →
  // end_now_refund transition must still raise "pull now"), and the dated
  // class carries its boundary (a corrected coverage end is a new
  // instruction). No term / no episode (portal path, non-prepaid admin
  // cancel, unanchored churn) keeps the per-EVENT key: retries of the same
  // request stay idempotent, while a restored customer who later cancels
  // another rental program gets a fresh task.
  const termKeyed = !!(termId && episodeKey);
  const dedupeKey = termKeyed
    ? `termite_station_retrieval:term:${termId}:${episodeKey}:${retrieveAfter ? `dated:${retrieveAfter}` : 'immediate'}`
    : `termite_station_retrieval:${customerId}:${requestId || 'no-request'}`;
  let raised = null;
  // Staff hold at most ONE open retrieval instruction per account. Before
  // this raise, every earlier UNREAD retrieval row for the customer is
  // stamped read, whatever its class or date: an ACCELERATED program end
  // (end_at_term later switched to end_now_refund) must not leave a
  // wait-until-term-end instruction beside a pull-now one; a CORRECTED
  // coverage end must not leave two retrieval dates; and a prior churn
  // episode's dated row (cancel at term end, win-back before the date,
  // cancel the same still-current term again) or a repeat end-of-coverage
  // commit that opened a new request must not leave two identical
  // instructions. Supersession follows REQUEST CHRONOLOGY, never call
  // order, and is judged over EVERY retrieval row of the account (read or
  // not): the raise for the NEWEST request wins. Any row raised by a newer
  // request — open, or already acted on — means this raise is stale (a
  // lost-task repair of an older acceptance, or a retry after a later
  // correction): it retires nothing and inserts nothing. Otherwise every
  // other OPEN row is retired, and this event's own row — read because a
  // later instruction retired it, or acted on before a correction was
  // reverted — is reopened so the winning instruction is the open one
  // (notifyAdmin dedupes against it without reopening). Read rows are
  // otherwise never touched: an instruction staff already acted on is
  // history, not a duplicate. Rows without a request (portal no-request
  // raises, legacy rows) count as oldest.
  // Retire + raise are ONE transaction under an account-scoped advisory
  // lock (the same `admin:<key>` namespace notifyAdmin's per-key dedupe
  // lock uses): two concurrent raises for different requests would
  // otherwise each see no stale row, take only their distinct per-key
  // locks, and both insert; and a retire committed apart from its
  // replacement could leave the old instruction unread beside the new one
  // (or neither standing). notifyAdmin runs on this trx, so both land or
  // neither does, and the second raiser's probe sees the first's row.
  const requestKeyPrefix = `termite_station_retrieval:${customerId}:`;
  const parseMeta = (row) => {
    let meta = row.metadata;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = {}; } }
    return meta || {};
  };
  // The request a row was raised for: stamped in metadata since the term
  // key shipped; earlier rows carry it only inside their request key.
  const rowRequestId = (meta) => {
    if (meta.requestId) return String(meta.requestId);
    const key = String(meta.dedupeKey || '');
    if (!key.startsWith(requestKeyPrefix)) return null;
    const suffix = key.slice(requestKeyPrefix.length);
    return suffix && suffix !== 'no-request' ? suffix : null;
  };
  let superseded = null;
  let yieldedTo = null;
  await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:termite_station_retrieval:${customerId}`]);
    try {
      const history = await trx('notifications')
        .where({ recipient_type: 'admin' })
        .whereRaw("metadata->>'kind' = ?", ['termite_station_retrieval'])
        .whereRaw("metadata->>'customerId' = ?", [String(customerId)])
        .select('id', 'read_at', 'metadata');
      const others = (history || []).map((row) => ({ row, meta: parseMeta(row) })).filter(({ meta }) => String(meta.dedupeKey || '') !== dedupeKey);
      const requestIds = [...new Set([requestId, ...others.map(({ meta }) => rowRequestId(meta))].filter(Boolean).map(String))];
      const openedAt = new Map();
      if (requestIds.length) {
        const rows = await trx('service_requests').whereIn('id', requestIds).select('id', 'created_at');
        for (const r of rows || []) openedAt.set(String(r.id), new Date(r.created_at).getTime() || 0);
      }
      const ownOpenedAt = requestId ? (openedAt.get(String(requestId)) || 0) : 0;
      const newer = others.find(({ meta }) => {
        const rid = rowRequestId(meta);
        return !!rid && (openedAt.get(rid) || 0) > ownOpenedAt;
      });
      if (newer) { yieldedTo = rowRequestId(newer.meta); return; }
      // The body's supersession note is derived from the account's whole
      // task HISTORY, not from what this call retired, so a routine retry
      // of the same event renders the identical body (refreshOnDedupe
      // compares content — a transient note would reopen an acted-on task).
      if (others.length) superseded = { dated: others.some(({ meta }) => !!meta.retrieveAfter) };
      const retire = others.filter(({ row }) => row.read_at == null);
      if (retire.length) {
        await trx('notifications').whereIn('id', retire.map(({ row }) => row.id)).update({ read_at: new Date() });
        const ownRead = (history || []).find((row) => row.read_at != null && String(parseMeta(row).dedupeKey || '') === dedupeKey);
        if (ownRead) await trx('notifications').where({ id: ownRead.id }).update({ read_at: null });
      }
    } catch (supersedeErr) {
      // NOT swallowed: raising the new task while a stale one may still
      // stand would leave staff two contradictory instructions with no
      // review error naming the stale one. Throwing lands as
      // termite_retrieval_task on the run, and the latch's lost-task repair
      // retries this whole raise (retire + task) (deferred P2 from #3666
      // r32).
      logger.error(`[cancellation-processor] retrieval-task retire failed for ${customerId}: ${supersedeErr.message}`);
      throw new Error(`earlier retrieval task could not be superseded: ${supersedeErr.message}`);
    }
    // The body names what the new instruction replaces: the dated → immediate
    // transition keeps its specific wording; every other retirement reads as
    // a plain "act on this one".
    const supersedeNote = !superseded
      ? ''
      : (!retrieveAfter && superseded.dated
        ? ' This supersedes the earlier dated retrieval task — the program now ends immediately.'
        : ' This supersedes an earlier station-retrieval task for this account — act on this one.');
    // retrieveAfter (C3 end_of_coverage): paid termite visits stay on the
    // calendar through the coverage boundary — pulling the stations now would
    // make those visits undeliverable, so the task is DATED, never "pull now".
    const timing = (retrieveAfter
      ? ` Paid coverage runs through ${retrieveAfter} — schedule the retrieval AFTER that date, not before; covered termite visits still deliver until then.`
      : ' Schedule the retrieval visit.') + supersedeNote;
    raised = await NotificationService.notifyAdmin(
      'service',
      retrieveAfter
        ? `Termite stations to retrieve after paid coverage ends ${retrieveAfter}`
        : 'Termite stations to retrieve after cancellation',
      (count
        ? `${count} Waves-owned bait station${count === 1 ? '' : 's'} on this property need to be pulled.`
        : 'This account is flagged as a bait-station rental — confirm the stations on site.')
        + timing
        + ' No charge to the customer.',
      {
        icon: '🪵',
        // Forces the bell past GATE_ADMIN_BELL_POLICY (bellAllowed honours
        // options.bell first): this is an office TASK, not an FYI, and must
        // never be silenced by the category allowlist.
        bell: true,
        link: `/admin/customers?customerId=${encodeURIComponent(customerId)}`,
        dedupeKey,
        // A same-key re-raise whose INSTRUCTION changed (a corrected coverage
        // date on the same request) rewrites the standing row and surfaces
        // it unread again; identical content stays a plain dedupe.
        refreshOnDedupe: true,
        metadata: {
          kind: 'termite_station_retrieval', customerId, stationCount: count, flaggedRental,
          ...(requestId ? { requestId } : {}),
          ...(termKeyed ? { termId, churnEpisode: episodeKey } : {}),
          ...(retrieveAfter ? { retrieveAfter } : {}),
        },
        trx,
      }
    );
  });
  if (yieldedTo) {
    logger.info(`[cancellation-processor] retrieval task for request ${requestId || 'no-request'} yields to the open instruction of newer request ${yieldedTo} (${customerId})`);
    return { raised: true, stationCount: count, deduped: true, supersededByNewer: yieldedTo };
  }
  const result = raised;
  // notifyAdmin resolves null (never throws) when the deduped insert fails —
  // surface that as an error so the cancel is not reported fully processed
  // while Waves-owned stations have no retrieval task.
  if (!result) throw new Error('admin notification did not persist');
  if (result.suppressed) {
    // With bell:true the only remaining suppression is the internal
    // test-customer gate (no reason) — no task wanted there. Anything else
    // means no row landed for a real account: fail loudly.
    if (result.reason) throw new Error(`admin notification suppressed (${result.reason})`);
    return { raised: false, reason: 'internal_test_customer', stationCount: count };
  }
  if (!result.id) throw new Error('admin notification did not persist');
  return { raised: true, stationCount: count };
}

// Family key of a scheduled_services row (joined with services.*), or null
// when the row is not WaveGuard plan evidence — the same classifier the
// cancellation facts use, so a scoped cancel and the preview agree on which
// visits belong to a family.
function familyOfServiceRow(row) {
  const {
    detectWaveGuardPlanKeys, isCommercialServiceRow, isRodentLedServiceRow, uniqueServiceFamilies,
  } = require('./self-booking-plan-sync');
  if (isCommercialServiceRow(row) || isRodentLedServiceRow(row)) return null;
  const families = uniqueServiceFamilies(detectWaveGuardPlanKeys(row));
  return families[0] || null;
}

// The visits a PRIOR attempt of this request already cancelled — identified
// by the request-scoped job_status_history note the status flip stamps, and
// re-confirmed STILL cancelled (a visit an admin has since revived is left
// alone). Shared with the admin preview: those rows re-enter the fee rails
// on a repair retry, so the approved fee exposure must cover them (codex GH
// r29 P1).
async function priorCancelledVisits(customerId, visitNote) {
  const history = await db('job_status_history')
    .where({ to_status: 'cancelled', notes: visitNote })
    .select('job_id');
  const priorIds = [...new Set(history.map((h) => h.job_id))];
  if (!priorIds.length) return [];
  return db('scheduled_services')
    .whereIn('id', priorIds)
    // Hard customer scope: job_status_history carries no customer_id, and a
    // duplicated note string must never let this request re-run side
    // effects against ANOTHER customer's cancelled visit.
    .where({ status: 'cancelled', customer_id: customerId })
    .select('id', 'status');
}

async function familyScopedServiceIds(customerId, families) {
  const rows = await db('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .where(function liveOrRecurring() {
      this.where('s.recurring_ongoing', true)
        .orWhere(function upcoming() {
          this.whereIn('s.status', CANCELLABLE_STATUSES)
            .where(function dateOrRescheduled() {
              this.where('s.scheduled_date', '>=', etDateString()).orWhere('s.status', 'rescheduled');
            });
        });
    })
    .select('s.*', 'sv.service_key', 'sv.name as service_name');
  const ids = new Set();
  for (const row of rows) {
    const family = familyOfServiceRow(row);
    if (family && families.includes(family)) ids.add(row.id);
  }
  return ids;
}

function tierDiscountRate(tier) {
  const { WAVEGUARD } = require('./pricing-engine/constants');
  const key = String(tier || '').toLowerCase();
  const rate = Number(WAVEGUARD?.tiers?.[key]?.discount);
  return Number.isFinite(rate) ? rate : 0;
}

/**
 * Plan the per-family billing wind-down WITHOUT writing: which ledger
 * components drop, what the remaining families reprice to at the demoted
 * tier, and the resulting scalar. Components are slices of the BILLED
 * monthly (net of the current tier discount), so a remaining family's new
 * rate = gross at the old discount × (1 − new discount). Per-application
 * and prepay lanes carry no monthly components to reprice — only the tier
 * label moves. Fails closed when a monthly lane's ledger cannot attribute
 * the scoped families (unattributed-only scalar).
 */
// pinnedScope (wind-down boundary re-plan): the families this run ALREADY
// swept own no live rows any more, so their ownership is taken as given and
// only the SURVIVING side (remaining families, their components, their
// per-application rows) is re-derived from live state.
async function planScopedWindDown(customerId, scopedFamilies, dbh = db, { pinnedScope = null } = {}) {
  const { inferTierFromServiceCount, uniqueServiceFamilies, detectWaveGuardPlanKeys, isCommercialServiceRow, isRodentLedServiceRow } = require('./self-booking-plan-sync');
  const { loadComponents } = require('./plan-rate-ledger');
  const customer = await dbh('customers').where({ id: customerId })
    .first('waveguard_tier', 'monthly_rate', 'billing_mode', 'active');
  if (!customer) return { ok: false, error: 'customer_missing' };
  const rows = await dbh('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .where(function liveOrRecurring() {
      this.where('s.recurring_ongoing', true)
        .orWhere(function upcoming() {
          this.whereIn('s.status', CANCELLABLE_STATUSES)
            .where(function dateOrRescheduled() {
              this.where('s.scheduled_date', '>=', etDateString()).orWhere('s.status', 'rescheduled');
            });
        });
    })
    .select('s.*', 'sv.service_key', 'sv.name as service_name');
  const owned = [];
  for (const row of rows) {
    if (isCommercialServiceRow(row) || isRodentLedServiceRow(row)) continue;
    for (const f of uniqueServiceFamilies(detectWaveGuardPlanKeys(row))) if (!owned.includes(f)) owned.push(f);
  }
  const pinned = Array.isArray(pinnedScope) && pinnedScope.length ? pinnedScope : null;
  if (pinned) {
    // A live row still in a swept family = a visit booked after the sweep
    // (under the writer lock this is the only way one exists). The wind-down
    // must not demote the account and report the family cancelled while
    // that visit stays dispatchable — refuse; the run parks and a fresh
    // preview re-sweeps it.
    const stillLive = pinned.filter((f) => owned.includes(f));
    if (stillLive.length) return { ok: false, error: 'scope_still_live', families: stillLive };
    for (const f of pinned) owned.push(f);
  }
  const inScope = pinned ? [...pinned] : scopedFamilies.filter((f) => owned.includes(f));
  if (!inScope.length) return { ok: false, error: 'scope_not_owned' };
  const remaining = owned.filter((f) => !inScope.includes(f));
  if (!remaining.length) return { ok: false, error: 'scope_is_whole_account' };

  const tierBefore = customer.waveguard_tier || inferTierFromServiceCount(owned.length);
  const tierAfter = inferTierFromServiceCount(remaining.length);
  const discountBefore = tierDiscountRate(tierBefore);
  const discountAfter = tierDiscountRate(tierAfter);

  const components = await loadComponents(dbh, customerId);
  // Lane via the canonical resolver (#3140): a positive monthly_rate on a
  // per-visit / annual-prepay / one-time row is legacy residue, not dues —
  // the old rate>0 shortcut demanded attribution and repriced monthly
  // components for lanes the dues cron never bills (Codex #3669 r3 P2).
  const { resolveBillingLane } = require('./billing-lane');
  const laneMode = resolveBillingLane(customer).mode;
  const monthlyLane = laneMode === 'monthly_membership';
  const perApplicationLane = laneMode === 'per_application';
  const byFamily = new Map(components.map((c) => [c.family_key, Number(c.monthly_rate) || 0]));
  // A family on HOLD carries its real price in plan_holds.held_monthly_rate
  // (its component is 0) — reprice THAT and leave the component/source
  // alone, or the resume would restore a stale rate / cancel the hold as
  // obsolete (codex r2 P1).
  const activeHolds = await dbh('plan_holds').where({ customer_id: customerId, status: 'active' }).select('id', 'family_key', 'held_monthly_rate').catch(() => []);
  const heldByFamily = new Map((activeHolds || []).map((h) => [h.family_key, h]));
  const attributed = inScope.every((f) => byFamily.has(f) || heldByFamily.has(f)) && remaining.every((f) => byFamily.has(f) || heldByFamily.has(f));
  if (monthlyLane && !attributed) return { ok: false, error: 'scoped_unattributed' };

  const reprice = (rate) => {
    if (!(rate > 0)) return 0;
    const gross = discountBefore < 1 ? rate / (1 - discountBefore) : rate;
    return Math.round(gross * (1 - discountAfter) * 100) / 100;
  };
  const remainingRates = remaining.map((f) => {
    const hold = heldByFamily.get(f);
    if (hold && hold.held_monthly_rate != null) {
      const before = Number(hold.held_monthly_rate) || 0;
      return { family: f, before, after: monthlyLane ? reprice(before) : null, heldHoldId: hold.id };
    }
    return { family: f, before: byFamily.get(f) ?? null, after: monthlyLane ? reprice(byFamily.get(f) || 0) : null };
  });
  // Scalar = Σ live components after reprice; held families contribute 0
  // until they resume (their repriced rate lives on the hold).
  const scalarAfter = monthlyLane
    ? Math.round(remainingRates.filter((r) => !r.heldHoldId).reduce((sum, r) => sum + (r.after || 0), 0) * 100) / 100
    : (customer.monthly_rate == null ? null : Number(customer.monthly_rate));

  // Per-application lane (codex r2 P1): each surviving UNINVOICED upcoming
  // visit carries its own tier-discounted price on the row — the demotion
  // must reprice those rows or the old bundle discount lives on forever.
  let perAppRows = [];
  if (perApplicationLane) {
    for (const row of rows) {
      if (isCommercialServiceRow(row) || isRodentLedServiceRow(row)) continue;
      const fam = uniqueServiceFamilies(detectWaveGuardPlanKeys(row))[0];
      if (!fam || !remaining.includes(fam)) continue;
      if (!CANCELLABLE_STATUSES.includes(String(row.status))) continue;
      const price = Number(row.estimated_price);
      if (!(price > 0)) continue;
      perAppRows.push({
        id: row.id, family: fam, before: price, after: reprice(price),
        primarySet: row.primary_line_price !== null && row.primary_line_price !== undefined,
        priorPrimary: row.primary_line_price,
      });
    }
    // An already-INVOICED visit bills at its fixed terms: applyScopedWindDown
    // skips it, so it must not be planned — and shown, fingerprinted, and
    // approved — as a `$before → $after` change that never happens (codex
    // GH r26 P1). A row invoiced between preview and commit drops out of the
    // recomputed plan and trips scoped_pricing_changed, like any drift.
    if (perAppRows.length) {
      const invoiced = await dbh('invoices')
        .whereIn('scheduled_service_id', perAppRows.map((r) => r.id))
        .whereNot({ status: 'void' })
        .select('scheduled_service_id');
      const fixed = new Set((invoiced || []).map((i) => String(i.scheduled_service_id)));
      perAppRows = perAppRows.filter((r) => !fixed.has(String(r.id)));
    }
  }
  return {
    ok: true, owned, inScope, remaining, tierBefore, tierAfter, discountBefore, discountAfter,
    monthlyLane, perApplicationLane, remainingRates, perAppRows,
    scalarBefore: customer.monthly_rate == null ? null : Number(customer.monthly_rate), scalarAfter,
    billingMode: customer.billing_mode || null,
  };
}

// Canonical string of a scoped plan's money-bearing facts — the same shape
// the admin commit builds from the approved preview (approvedScopedPricing)
// and reasserts at the wind-down boundary.
// tierbefore + mode: a tier or billing-mode edit that commits during the
// sweep (both take the writer lock ahead of the boundary re-plan) changes
// the plan's INPUTS even when every priced output stays the same (e.g. a
// per-application account whose surviving visits are all invoiced) — it
// must be re-approved, never silently overwritten or applied on the wrong
// lane's assets.
function scopedPricingFingerprint(plan) {
  return [
    `tier=${plan.tierAfter ?? ''}`,
    `monthly=${plan.scalarAfter ?? ''}`,
    `rates=${(plan.remainingRates || []).map((r) => `${r.family}:${r.before}:${r.after}`).sort().join(',')}`,
    `perapp=${(plan.perAppRows || []).map((p) => `${p.id}:${p.before}:${p.after}`).sort().join(',')}`,
    `tierbefore=${plan.tierBefore ?? ''}`,
    `mode=${plan.billingMode ?? ''}`,
  ].join('|');
}

class ScopedPricingChangedError extends Error {
  constructor(message) { super(message); this.code = 'scoped_pricing_changed'; }
}

// Apply the scoped wind-down (tier demote + surviving-family reprice).
//
// The whole thing — re-plan, approval compare, reprice, demote — runs in
// ONE transaction that FIRST takes the per-customer writer lock (rung 6 of
// scheduling/occupancy.js's ORDERING CONTRACT, utils/customer-comms-lock):
// every writer that inserts a scheduled_services row or rewrites the plan
// ledger / tier holds the same key, so a surviving-family visit or component
// can land only BEFORE the re-plan (then it is priced here, and a mismatch
// with the approved facts refuses the run) or AFTER the commit (then its
// writer prices it off the demoted tier). No silent window (#3666 r34 P2;
// the drift-guard / phantom-check attempts that preceded this were closable
// only from the writers' side).
//
// `scopedFamilies` present = re-plan from live rows at the boundary with the
// entry plan's swept scope pinned; `approvedScopedPricing` present = the
// fresh plan must serialize to exactly it or ScopedPricingChangedError is
// thrown (the run parks scoped_pricing_changed and a fresh preview
// re-approves the live numbers). Neither = apply `plan` as given under the
// lock (test harnesses).
async function applyScopedWindDown(customerId, entryPlan, {
  requestId, actorLabel = 'Portal', lateFeeWaived = false, scopedFamilies = null, approvedScopedPricing = null,
} = {}) {
  let plan = entryPlan;
  await db.transaction(async (trx) => {
    await lockCustomerComms(trx, customerId);
    // The customers ROW too: a billing-mode-only admin edit takes no writer
    // lock (it fences tier/rate edits only), so the re-plan below must read
    // a row no such edit can change until this commits — and one that
    // already committed is what it reads.
    await trx('customers').where({ id: customerId }).forUpdate().first('id');
    if (Array.isArray(scopedFamilies) && scopedFamilies.length) {
      // A read failure propagates as scoped_wind_down (retrying a fresh
      // preview cannot repair a connection/schema fault); only successfully
      // read live state that no longer matches is scoped_pricing_changed.
      const fresh = await planScopedWindDown(customerId, scopedFamilies, trx, { pinnedScope: entryPlan.inScope });
      if (!fresh.ok) {
        throw new ScopedPricingChangedError(`scoped wind-down could not be re-planned at the boundary (${fresh.error})`);
      }
      if (approvedScopedPricing != null) {
        const live = scopedPricingFingerprint(fresh);
        if (live !== approvedScopedPricing) {
          throw new ScopedPricingChangedError(`scoped pricing drifted since approval (approved ${approvedScopedPricing} vs live ${live})`);
        }
      }
      plan = fresh;
    }
    // A hold on a swept family created after the processor's unlocked
    // invalidation pass (startHold takes this same lock) would survive the
    // cancel and later text a false restart — retire it here, under the
    // lock, before the ledger/tier writes.
    await trx('plan_holds')
      .where({ customer_id: customerId, status: 'active' })
      .whereIn('family_key', plan.inScope || [])
      .update({ status: 'cancelled', updated_at: new Date() });
    if (plan.monthlyLane) {
      await trx('customer_plan_rates').where({ customer_id: customerId }).whereIn('family_key', plan.inScope).del();
      // CAS like the per-application lane below: the plan was computed at
      // processor ENTRY (a post-sweep recompute is impossible — the scoped
      // rows are already cancelled), so a ledger/hold write landing during
      // the sweep would be silently overwritten with stale planned values
      // and the customer billed differently from the approved facts. Zero
      // rows = the rate is no longer what the plan (and the operator) saw:
      // abort the whole transaction so the run surfaces scoped_wind_down
      // and a fresh preview re-approves the live numbers.
      for (const r of plan.remainingRates) {
        if (r.heldHoldId) {
          // Held family: reprice the HOLD's saved rate; component stays 0 /
          // source plan_hold so the resume restores the demoted price.
          const heldWhere = { id: r.heldHoldId, status: 'active' };
          if (r.before != null) heldWhere.held_monthly_rate = r.before;
          const heldUpdated = await trx('plan_holds').where(heldWhere)
            .update({ held_monthly_rate: r.after, updated_at: new Date() });
          if (!heldUpdated) {
            throw new Error(`held rate CAS matched zero rows for hold ${r.heldHoldId} (${r.family}) — hold changed since the approved preview`);
          }
          continue;
        }
        const rateWhere = { customer_id: customerId, family_key: r.family };
        if (r.before != null) rateWhere.monthly_rate = r.before;
        const rateUpdated = await trx('customer_plan_rates').where(rateWhere)
          .update({ monthly_rate: r.after, source: 'cancellation_scoped', effective_at: new Date(), updated_at: new Date() });
        if (!rateUpdated) {
          throw new Error(`monthly component CAS matched zero rows for ${r.family} — rate changed since the approved preview`);
        }
      }
    }
    if (plan.perApplicationLane) {
      // CAS per row against the price we planned from; an INVOICED row is
      // skipped (it bills at its already-fixed terms, never double-adjusted).
      for (const r of plan.perAppRows || []) {
        const invoiced = await trx('invoices').where({ scheduled_service_id: r.id }).whereNot('status', 'void').first('id');
        if (invoiced) continue;
        const casWhere = { id: r.id, estimated_price: r.before };
        if (r.primarySet) casWhere.primary_line_price = r.priorPrimary;
        const updated = await trx('scheduled_services').where(casWhere)
          .update({ estimated_price: r.after, ...(r.primarySet ? { primary_line_price: r.after } : {}), updated_at: new Date() });
        if (!updated) {
          // Zero rows = the price is no longer what the operator approved
          // (or the row vanished) — claiming the reprice while the visit
          // keeps its old charge is silent money drift. The one acceptable
          // state is an invoice landing after the check above: that visit
          // bills at its fixed terms. Anything else aborts the transaction
          // (tier demote included) so the run surfaces scoped_wind_down
          // and a fresh preview re-approves the live numbers.
          const nowInvoiced = await trx('invoices').where({ scheduled_service_id: r.id }).whereNot('status', 'void').first('id');
          if (nowInvoiced) continue;
          throw new Error(`per-application reprice matched zero rows for visit ${r.id} — price changed since the approved preview`);
        }
      }
    }
    const update = { updated_at: new Date(), waveguard_tier: plan.tierAfter, waveguard_tier_source: 'cancellation_scoped' };
    if (plan.monthlyLane) update.monthly_rate = plan.scalarAfter;
    await trx('customers').where({ id: customerId }).update(update);
    // Durable, REQUEST-scoped proof that this wind-down committed, written
    // in the same transaction as the demote/reprice: the repair-only retry
    // reads it (per-application accounts have no ledger components, and
    // the customer-wide waveguard_tier_source stamp is reusable — a prior
    // scoped cancel leaves it set, so it cannot prove THIS request's
    // wind-down landed; codex GH r33 P1). Read-modify-write is safe here:
    // the commit holds the customer cancel lock and this is the only
    // writer of cancel_plan metadata inside it.
    if (requestId) {
      const reqRow = await trx('service_requests').where({ id: requestId }).first('metadata');
      let meta = {};
      try { meta = (typeof reqRow?.metadata === 'string' ? JSON.parse(reqRow.metadata) : reqRow?.metadata) || {}; } catch { meta = {}; }
      await trx('service_requests').where({ id: requestId }).update({
        metadata: JSON.stringify({ ...meta, cancel_plan: { ...(meta.cancel_plan || {}), scopedWindDownCommitted: true } }),
        updated_at: new Date(),
      });
    }
  });
  try {
    const rateLine = plan.monthlyLane
      ? ` Monthly ${plan.scalarBefore} → ${plan.scalarAfter}; ${plan.remainingRates.map((r) => `${r.family} ${r.before} → ${r.after}`).join(', ')}.`
      : '';
    await db('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: 'note',
      subject: `Cancelled ${plan.inScope.join(', ')} — plan continues with ${plan.remaining.join(', ')}`,
      body: `${actorLabel} cancellation request ${requestId || ''}`.trim()
        + `. WaveGuard ${plan.tierBefore} → ${plan.tierAfter}.${rateLine}`
        + (lateFeeWaived ? ' Scheduled-visit fee waived.' : ''),
    });
  } catch (noteErr) {
    logger.warn(`[cancellation-processor] scoped audit note failed for ${customerId}: ${noteErr.message}`);
  }
  return { plan };
}

/**
 * Whole-account (default) or FAMILY-SCOPED (`families` non-empty) cancel.
 *
 * Scoped: the customer stays active; only the named families' recurrence
 * stops and their upcoming visits are pulled (the same per-visit
 * follow-through as a whole-account cancel), the plan-rate ledger drops
 * those components, and the scalar rate + WaveGuard tier are recomputed
 * from what remains — the tier DEMOTES (ruling C-3: per-service cancel is
 * real, so the bundle discount must follow the bundle). Termite retrieval
 * is raised only when termite_bait is in scope. The result carries `scope`
 * and `remaining` so the route reports exactly what happened.
 */
async function processCancellationRequest({
  customerId, reason, requestId, families,
  // C3 (admin-side cancel on the same engine) — all additive, default =
  // the customer-portal behavior byte-for-byte:
  //   actor        { type: 'customer'|'admin'|'ib', userId } — recorded on
  //                the timeline note and churn_reason_detail so a churn
  //                report can tell who pulled the plan.
  //   keepThrough  YYYY-MM-DD (end of paid coverage): the visit sweep SKIPS
  //                dated visits on/before it (they are already paid for)
  //                while recurrence still stops. Date-exempt 'rescheduled'
  //                rebook intents are still pulled — an open rebook could
  //                land past the paid window.
  //   keepVisitIds REQUIRED with keepThrough: the LIVE term's canonical
  //                covered visit ids (coverageRowsForTerm) — only these
  //                ride out the window; missing set = abort, fail closed.
  //   waiveLateFee scheduled-visit fee waived on every pulled visit — the
  //                card-hold rail releases instead of charging and the
  //                appointment-card rail closes 'waived'; recorded on the
  //                result and the timeline note.
  actor = null, keepThrough = null, keepVisitIds = null, waiveLateFee = false,
  //   feeEvaluationAt (C3): the instant the operator's approved fee
  //                exposure was validated — both fee rails judge their
  //                cancel windows AT this time, so a slow sweep crossing a
  //                visit's cutoff mid-run cannot charge a fee absent from
  //                the approved fingerprint. Null (portal path / repair
  //                retries) = live now, byte-identical to old behavior.
  feeEvaluationAt = null,
  //   approvedScopedPricing (C3): canonical string of the scoped pricing
  //                the operator approved (tier/monthly/rates/per-app) —
  //                the recomputed wind-down plan must serialize to exactly
  //                this or the repricing is refused (scoped_pricing_changed)
  //                and the run parks for a fresh preview. Null = no
  //                assertion (portal path, repairs).
  approvedScopedPricing = null,
  //   deferTermiteRetrieval (C3): the caller records an annual-prepay term
  //                decision AFTER this run — the IMMEDIATE retrieval task
  //                is returned as termiteRetrievalPending ({ retrieveAfter:
  //                null }) instead of raised here, exactly like the dated
  //                one, so a conflicting/failed decision never leaves a
  //                pull-the-stations instruction on a term that still
  //                stands. False (portal path) = raised here, as before.
  deferTermiteRetrieval = false,
  // historyNote (C3): an IMMUTABLE request-scoped marker for the visit
  // history notes and the retry repair matching. The recorded REASON is
  // operator text (churn detail/classification) and may change between a
  // partial run and its retry — keying repairs on it would strand the first
  // attempt's failed side effects the moment the operator edits the note.
  // Absent (portal path) the reason doubles as the note, byte-identical to
  // the old behavior.
  historyNote = null,
  // visitReason (C3): the CUSTOMER-SAFE reason stamped on the cancelled
  // rows (scheduled_services.cancellation_reason, read back verbatim by the
  // public tracker for anyone holding a shared link). The admin path's
  // `reason` carries the operator's internal note for the churn columns and
  // must never reach those rows. Absent (portal path) the reason is used,
  // byte-identical to the old behavior.
  visitReason = null,
} = {}) {
  if (!customerId) throw new Error('processCancellationRequest requires customerId');
  const cancelReason = String(reason || CHURN_REASON).slice(0, 500);
  const rowReason = String(visitReason || cancelReason).slice(0, 500);
  const visitNote = String(historyNote || cancelReason).slice(0, 500);
  const errors = [];
  const actorType = actor && actor.type ? String(actor.type) : 'customer';
  const actorLabel = actorType === 'admin'
    ? `Admin${actor?.userId ? ` (user ${actor.userId})` : ''}`
    : actorType === 'ib'
      ? `Intelligence Bar${actor?.userId ? ` (user ${actor.userId})` : ''}`
      : 'Portal';
  // Sweep floor: keepThrough only ever NARROWS the sweep (a past date is
  // meaningless — nothing before today is swept anyway).
  const today = etDateString();
  const sweepAfter = keepThrough && /^\d{4}-\d{2}-\d{2}$/.test(String(keepThrough)) && String(keepThrough) >= today
    ? String(keepThrough)
    : null;
  // keepVisitIds = the LIVE term's canonical covered rows (the caller reads
  // them from coverageRowsForTerm). A stamp/term-id classifier is NOT the
  // coverage identity: a refunded prior term deliberately RETAINS
  // annual_prepay_term_id for audit while its stamps are cleared, so old
  // dead-term rows would ride out a NEW term's window deliverable for free.
  // A keep-through sweep with no covered-row set is unverifiable — abort
  // before any mutation (fail closed) rather than guess in either direction.
  if (sweepAfter && !Array.isArray(keepVisitIds)) {
    logger.error(`[cancellation-processor] keepThrough for ${customerId} without keepVisitIds — refusing to sweep`);
    return {
      cancelledCount: 0, recurrenceStopped: 0, churned: false, ok: false,
      errors: ['keep_through_missing_coverage'], keptThrough: sweepAfter, lateFeeWaived: false,
    };
  }
  const keepIds = sweepAfter ? keepVisitIds.map(String) : null;
  const lateFeeWaived = waiveLateFee === true;
  // The waiver is REPORTED only after every applicable fee rail confirms
  // release: a lost race or ambiguous outcome ({released:false}, with or
  // without a reason) means a fee may still charge — claiming "waived" then
  // would be a false money fact on the case, the response, and the
  // customer's confirmation copy.
  let feeWaiverConfirmed = lateFeeWaived;
  const scopedFamilies = Array.isArray(families) ? families.filter(Boolean) : [];
  const scoped = scopedFamilies.length > 0;
  let scopedIds = null;
  let scopedPlan = null;
  let scopedRepairOnly = false;
  if (scoped) {
    try {
      scopedIds = await familyScopedServiceIds(customerId, scopedFamilies);
      // MONEY OUTRANKS the visit sweep: prove the wind-down is attributable
      // BEFORE any visit is touched. A ledger that only carries the
      // unattributed scalar cannot price "the families that stay" — fail
      // closed and let the route offer a whole-account cancel instead.
      scopedPlan = await planScopedWindDown(customerId, scopedFamilies);
      if (!scopedPlan.ok) {
        // Repair retry: when a FIRST attempt of this same request already
        // pulled every selected visit, the families are gone from the live
        // rows (scope_not_owned) and no plan can be built — but rows that
        // request cancelled may still carry failed side effects (invoice
        // void, reminders, card fees, tracker). A caller-scoped reason with
        // prior-cancelled rows for THIS customer is the proof; then run
        // repair-only — no wind-down (run 1 applied it or belled its
        // failure), no live sweep (scopedIds is empty), just the repair
        // pass. Without that proof the refusal stands.
        let repairable = false;
        if (scopedPlan.error === 'scope_not_owned' && reason) {
          try {
            const priorCancelled = await db('job_status_history')
              .where({ to_status: 'cancelled', notes: visitNote })
              .select('job_id');
            const ids = [...new Set(priorCancelled.map((h) => h.job_id))];
            if (ids.length) {
              repairable = !!(await db('scheduled_services')
                .whereIn('id', ids)
                .where({ status: 'cancelled', customer_id: customerId })
                .first('id'));
            }
          } catch (probeErr) {
            logger.warn(`[cancellation-processor] scoped repair probe failed for ${customerId}: ${probeErr.message}`);
          }
        }
        if (!repairable) {
          return { cancelledCount: 0, recurrenceStopped: 0, churned: false, ok: false, errors: [scopedPlan.error], scope: scopedFamilies };
        }
        logger.info(`[cancellation-processor] scoped repair-only retry for ${customerId} (${scopedPlan.error}) — re-running side effects on the prior attempt's cancelled rows`);
        scopedRepairOnly = true;
        scopedPlan = null;
      }
    } catch (err) {
      logger.error(`[cancellation-processor] scoped family resolution failed for ${customerId}: ${err.message}`);
      return { cancelledCount: 0, recurrenceStopped: 0, churned: false, ok: false, errors: ['scope_resolution'], scope: scopedFamilies };
    }
  }

  // 1. Churn + stop all billing FIRST — before the (potentially slow,
  // Stripe-touching) visit sweep. The monthly charge loop preselects
  // active/autopay customers and the failed-payment retry ladder only skips
  // soft-deleted ones, so every second the account stays chargeable is a
  // window for a billing cron to charge a customer who just cancelled.
  let churned = false;
  let termiteRetrievalPending = null;
  let wasChurnedStage = false;
  // The churn EPISODE (customers.churn_episode_id): minted here on the
  // first churn of an episode (no stamp on the row), reused on a repeat
  // run, cleared by every reactivation path that clears churned_at. The
  // caller keys the term's end-of-coverage side effects on it — never on
  // churned_at/stage inference.
  let churnEpisodeId = null;
  // A scoped cancel never churns the account — the customer keeps the
  // families that stay; their billing wind-down happens per family below.
  if (!scoped) try {
    // Every churn fact — whether this is a repeat churn, the episode, the
    // churn stamps, the MRR snapshot — is derived from the row AS LOCKED,
    // never from an earlier unlocked read: a concurrent cancel must not
    // mint a second episode from the same unstamped row, and a concurrent
    // reactivation that cleared the stamps must not have this run follow a
    // stale repeat-churn branch (writing 'churned' without restoring
    // churned_at) or reuse an obsolete episode without writing it back.
    // The returned identity always equals customers.churn_episode_id as
    // committed. Returns false when the row does not exist.
    const gated = gateEnvValue('GATE_CANCEL_FLOW_V2');
    const churnWrite = async (trx) => {
      const customer = await trx('customers')
        .where({ id: customerId })
        .forUpdate()
        .first('pipeline_stage', 'active', 'monthly_rate', 'churn_mrr', 'billing_mode', 'churn_episode_id');
      if (!customer) return false;
      wasChurnedStage = customer.pipeline_stage === 'churned';
      // A stored episode is REUSED only while the row is still churned. A
      // promotion to a live stage that never cleared the stamp (tier
      // alignment in self-booking-plan-sync promotes a booked churned member
      // to active_customer without touching churn_episode_id) is a win-back
      // all the same: this cancel is a NEW episode, or its end-of-term side
      // effects would dedupe against the earlier churn's.
      const reuseEpisode = wasChurnedStage && !!customer.churn_episode_id;
      churnEpisodeId = reuseEpisode ? customer.churn_episode_id : randomUUID();
      const now = new Date();
      const update = {
        active: false,
        pipeline_stage: 'churned',
        // Wind down billing: the monthly charge loop skips active=false /
        // autopay_enabled=false, but the failed-payment retry ladder only skips
        // soft-deleted customers — so also disable autopay + clear the next
        // charge, and disarm any armed retry below.
        autopay_enabled: false,
        next_charge_date: null,
        updated_at: now,
        ...(reuseEpisode ? {} : { churn_episode_id: churnEpisodeId }),
      };
      // Preserve the original churn timestamp/reason if already churned.
      if (!wasChurnedStage) {
        update.pipeline_stage_changed_at = now;
        // churned_at is a DATE column — stamp the ET calendar date (a JS Date
        // lands on the wrong day after ET midnight; same rule as the admin
        // stage-change path).
        update.churned_at = etDateString();
        update.churn_reason = CHURN_REASON;
        // Taxonomy (Phase 7): snapshot the rate AT churn (monthly_rate gets
        // zeroed/repriced later — without this the Pareto's dollars rewrite
        // history), keep the customer's own words (legacy churn_reason is
        // varchar(30)), and start at 'unclassified' — the AI classification
        // runs LAST (see below) so it can never block this wind-down.
        update.churn_mrr = Number(customer.monthly_rate) || 0;
        // Actor rides on the detail (C3): a churn pulled by the office
        // reads differently in the Pareto than one the customer chose.
        update.churn_reason_detail = (actorType === 'customer'
          ? cancelReason
          : `${cancelReason} [${actorLabel}]`).slice(0, 500);
        update.churn_reason_code = 'unclassified';
      }
      // PR E (GATE_CANCEL_FLOW_V2): tier/rate wind-down — the 2026-08-30
      // audit's money leak. Tier alignment only ever PROMOTES
      // (self-booking-plan-sync), so a churned account that kept its
      // waveguard_tier / monthly_rate rejoins later at the old discount
      // forever. churn_mrr above already snapshotted the rate for reporting
      // (first churn); on a repeat churn it was stamped the first time.
      // Applied even when the stage was already 'churned' so admin
      // stage-flip residue self-heals on the next processor run. The scalar
      // clear and the per-family ledger reset run in ONE transaction —
      // fail-closed: with GATE_PLAN_RATE_LEDGER authoritative, a surviving
      // positive component would resurrect the old rate on a win-back, so a
      // ledger failure must fail the churn write (→ 'churn' error → office
      // review alert), never be swallowed. Dark: gate off → byte-identical
      // to H0.
      if (gated) {
        // PR E (GATE_CANCEL_FLOW_V2): the tier/rate wind-down (see the
        // transaction below for the all-or-nothing rule).
        update.waveguard_tier = null;
        update.waveguard_tier_source = null;
        update.monthly_rate = null;
        // Repeat churn (admin stage-flip residue): the first churn may never
        // have stamped churn_mrr — snapshot the rate before clearing it, or
        // the reporting dollars are gone for good.
        if (wasChurnedStage && customer.churn_mrr == null && Number(customer.monthly_rate) > 0) {
          update.churn_mrr = Number(customer.monthly_rate);
        }
      }
      await trx('customers').where({ id: customerId }).update(update);
      return true;
    };
    // Both saved payment METHODS (StripeService.charge() picks the default
    // by payment_methods.autopay_enabled alone) and any armed
    // failed-payment retry (the ladder does not check active/churn) are
    // independent charge rails and belong to the same wind-down.
    const disarmPaymentRails = async (dbh) => {
      await dbh('payment_methods')
        .where({ customer_id: customerId })
        .update({ autopay_enabled: false });
      await dbh('payments')
        .where({ customer_id: customerId, status: 'failed' })
        .whereNull('superseded_by_payment_id')
        .whereNotNull('next_retry_at')
        .update({ next_retry_at: null });
    };

    if (gated) {
      // PR E: the ENTIRE billing wind-down — customer flags/tier clear,
      // authoritative ledger reset, payment-method disable, retry disarm —
      // is ONE transaction. All-or-nothing is what makes the abort below
      // sound: on a throw here, nothing persisted and the account is
      // exactly as it was. The advisory ledger reset (gate off for
      // GATE_PLAN_RATE_LEDGER) runs after commit and only warns — an
      // advisory hiccup must never take the committed wind-down back.
      // Per-application lane fields (billing_mode + per_application_fee)
      // are NOT cleared here: they are the live price for unsettled work
      // (an in-progress visit, or a completed-but-uninvoiced application),
      // and any pre-check would race a pending→en_route transition. They
      // are cleared AFTER the visit sweep by one atomic conditional UPDATE
      // (see the gated block near the end of this function).
      const { resetLedgerToScalar } = require('./plan-rate-ledger');
      await db.transaction(async (trx) => {
        // Rung 6 before the customers row lock: this transaction rewrites
        // the plan ledger and tier, the writes the scoped wind-down and
        // every booking/ledger writer serialize on.
        await lockCustomerComms(trx, customerId);
        if (!(await churnWrite(trx))) return;
        // The ledger clear is atomic with the wind-down REGARDLESS of the
        // ledger-read gate (codex r48): rows left behind while the gate
        // is off become authoritative the moment it flips, resurrecting
        // the cancelled rate on a win-back. A failure here rolls the
        // whole wind-down back and the gated abort below stops the run
        // BEFORE any service is swept — nothing is left half-done.
        await resetLedgerToScalar(trx, customerId, 0, { source: 'cancellation' });
        await disarmPaymentRails(trx);
        churned = true;
      });
    } else {
      // Legacy (H0) path: sequential writes, and on failure the catch
      // below records 'churn' and CONTINUES like H0 did. The customers
      // write is the one statement it always was, now under the row lock
      // (no rung 6: this transaction takes no other lock, so it cannot sit
      // in a cycle with the writers that do).
      if (await db.transaction(churnWrite)) {
        await disarmPaymentRails(db);
        churned = true;
      }
    }
  } catch (err) {
    errors.push('churn');
    logger.error(`[cancellation-processor] failed to churn customer ${customerId}: ${err.message}`);
    if (gateEnvValue('GATE_CANCEL_FLOW_V2')) {
      // ABORT (gated path only): the wind-down is a single transaction, so a
      // throw means NOTHING persisted and the account is still active and
      // chargeable. Continuing into the recurrence stop and visit sweep
      // would cancel SERVICE on a live billing account — the exact inversion
      // this processor exists to prevent. Return partial (ok=false): the
      // request row + admin review alert carry it, and both retry paths
      // (60s dedupe, inactive-account) re-run this processor idempotently.
      // The legacy path deliberately keeps H0's continue-and-flag behavior —
      // its writes are sequential, so "nothing persisted" cannot be assumed.
      return { cancelledCount: 0, recurrenceStopped: 0, churned: false, ok: false, errors };
    }
  }

  // 2. Stop any recurring series BEFORE reading the visit list, so a
  // concurrent completion that would auto-extend the series sees
  // recurring_ongoing=false instead of minting a fresh occurrence behind the
  // sweep's back. (The straggler re-sweep below covers an extension already
  // in flight past its flag read.)
  // Rented termite bait stations are Waves property and come out of the
  // ground when the program ends (signed agreement text, migration
  // 20260729000001) — but nothing scheduled that retrieval until H0
  // (2026-08-30). Raise an office task, deduped per request so retries never
  // double-bell. Failure is recorded in `errors` and never blocks the churn.
  // Only once the churn actually persisted: a failed customer update leaves
  // the account active and billable, and staff must never be told to pull
  // hardware from a live program.
  // A cancel supersedes any live hold on the affected families — the
  // lifecycle must not later text a false restart or restore a stale rate
  // (codex r1 P2).
  try {
    let holdQuery = db('plan_holds').where({ customer_id: customerId, status: 'active' });
    if (scoped) holdQuery = holdQuery.whereIn('family_key', scopedFamilies);
    await holdQuery.update({ status: 'cancelled', updated_at: new Date() });
  } catch (err) {
    logger.warn(`[cancellation-processor] hold invalidation failed for ${customerId}: ${err.message}`);
  }

  let recurrenceStopped = 0;
  try {
    await db.transaction(async trx => {
      let seriesQuery = trx('scheduled_services').where({ customer_id: customerId, is_recurring: true });
      if (scopedIds) seriesQuery = seriesQuery.whereIn('id', [...scopedIds]);
      const rows = await seriesQuery.select('id', 'recurring_parent_id', 'customer_id', 'recurring_pattern');
      await require('./recurring-plan-decisions').recordRecurringSeriesStops(trx, rows);
      let stopQuery = trx('scheduled_services').where({ customer_id: customerId, recurring_ongoing: true });
      if (scopedIds) stopQuery = stopQuery.whereIn('id', [...scopedIds]);
      // Stamp the attempt's reason on every row whose recurrence this stop
      // clears (codex GH r8 P1): when the plan's only footprint was a
      // COMPLETED series anchor riding recurring_ongoing=true, the flag
      // itself is gone after this update and the row never turns
      // 'cancelled' — the reason is the surviving request-correlated
      // evidence restart's family recovery reads. Status is untouched; the
      // tracker renders reasons only on cancelled-status rows.
      recurrenceStopped = await stopQuery.update({ recurring_ongoing: false, cancellation_reason: rowReason, updated_at: new Date() });
    });
  } catch (err) {
    errors.push('stop_recurrence');
    logger.error(`[cancellation-processor] failed to stop recurrence for ${customerId}: ${err.message}`);
  }

  // Live in-progress work (tech en route / on property) is never auto-cancelled
  // — but it must not be silently ignored either. Flag each such visit so the
  // admin alert says "review manually" instead of claiming full auto-processing
  // while a tech is rolling; the rest of the wind-down still runs (owner
  // directive: churn immediately on submit). Checked on BOTH layers: the
  // legacy status AND a leading track_state whose status sync lagged (the two
  // queries are disjoint — the second excludes statuses the first matched;
  // terminal statuses there are stale-drift history, not live work).
  try {
    const inProgressByStatus = await db('scheduled_services')
      .where({ customer_id: customerId })
      .whereIn('status', ['en_route', 'on_site'])
      .select('id', 'scheduled_date');
    const inProgressByTrack = await db('scheduled_services')
      .where({ customer_id: customerId })
      .whereIn('track_state', LIVE_TRACK_STATES)
      .whereNotIn('status', ['en_route', 'on_site', 'completed', 'cancelled', 'skipped', 'no_show'])
      .select('id', 'scheduled_date');
    for (const row of [...inProgressByStatus, ...inProgressByTrack]) {
      if (scopedIds && !scopedIds.has(row.id)) continue;
      // Keep-through (end of paid coverage): a covered visit inside the
      // retained window is deliberately staying on the calendar, so a tech
      // mid-delivery on it needs no manual cancellation — flagging it would
      // report an otherwise clean end-of-coverage cancel as partial and skip
      // the term's cancel decision merely because a paid visit is underway.
      if (keepIds && keepIds.includes(String(row.id))) {
        const d = row.scheduled_date instanceof Date
          ? row.scheduled_date.toISOString().slice(0, 10)
          : String(row.scheduled_date || '').slice(0, 10);
        if (d && d <= sweepAfter) continue;
      }
      errors.push(`in_progress_visit:${row.id}`);
      logger.warn(`[cancellation-processor] visit ${row.id} is in progress — left for manual handling`);
    }
  } catch (err) {
    errors.push('load_in_progress');
    logger.error(`[cancellation-processor] failed to check in-progress visits for ${customerId}: ${err.message}`);
  }

  // Visits a PRIOR attempt of this same request already flipped to cancelled:
  // the sweep only selects still-live statuses, so without this a retry (the
  // route re-runs the processor on a deduped resubmit) would skip a visit
  // whose status flip committed but whose side effects (invoice void, card
  // hold, reminders, track layer) failed — leaving them broken forever. The
  // flip stamps the request-scoped reason into job_status_history.notes, which
  // identifies exactly the visits this request cancelled; re-confirm each is
  // STILL cancelled so a visit an admin has since revived is left alone.
  // Repairs are only meaningful with a caller-scoped reason: the shared
  // CHURN_REASON fallback would match every reason-less cancellation's note
  // across requests, resurrecting unrelated work.
  let repairs = [];
  if (reason) {
    try {
      repairs = await priorCancelledVisits(customerId, visitNote);
    } catch (err) {
      errors.push('load_prior_cancelled');
      logger.error(`[cancellation-processor] failed to load prior-cancelled visits for ${customerId}: ${err.message}`);
    }
  }

  // 3. Cancel the customer's upcoming cancellable visits.
  let cancelledCount = 0;
  // The IDs this run actually flipped — the caller reconciles them against
  // the operator-approved preview identities, not just the count (a
  // completed-approved-visit + minted-occurrence swap keeps the count equal
  // while pulling an appointment nobody approved).
  const cancelledIds = [];
  const processed = new Set();

  function sweepCancellable() {
    let query = db('scheduled_services')
      .where({ customer_id: customerId })
      .whereIn('status', CANCELLABLE_STATUSES)
      .where(function () {
        // Upcoming = on/after the ET business date (scheduled_date is a DATE
        // column; same bound as the portal's upcoming query) so historical
        // stale rows keep their status. EXCEPT 'rescheduled': those phantom
        // rows keep their ORIGINAL — often past — date until SmartRebooker
        // actions them back onto the calendar, so an open rebook intent is
        // pulled regardless of date (else a churned customer could be rebooked).
        // keepThrough (C3, end of paid coverage): ONLY the LIVE term's
        // canonical covered rows (keepIds, from coverageRowsForTerm) ride
        // out the paid window. Everything else — a mixed account's monthly
        // services, or a DEAD refunded term's rows that keep their audit
        // link — is pulled NOW like any plain cancel: billing stops
        // immediately, so uncovered work must never stay on the calendar
        // deliverable for free.
        if (sweepAfter) {
          this.where(function keptOrPastWindow() {
            this.where('scheduled_date', '>', sweepAfter)
              .orWhere(function uncoveredUpcoming() {
                this.where('scheduled_date', '>=', today).whereNotIn('id', keepIds);
              });
          });
        } else {
          this.where('scheduled_date', '>=', today);
        }
        this.orWhere('status', 'rescheduled');
      })
      // Never touch a row whose customer-visible track layer says the work is
      // DONE or LIVE — track_state can lead the legacy status (the tracker
      // flips first; the status sync is best-effort), so a status-only filter
      // would sweep a visit a tech is actively working. NULL-safe for legacy
      // rows with no track_state.
      .whereRaw("(track_state IS NULL OR track_state NOT IN ('complete', 'en_route', 'on_property'))");
    if (scopedIds) query = query.whereIn('id', [...scopedIds]);
    return query.select('id', 'status');
  }

  async function processVisit(svc) {
    if (!svc.alreadyCancelled) {
      // Canonical status flip: writes the job_status_history audit row,
      // auto-resolves open tech_late / unassigned_overdue alerts, and broadcasts
      // dispatch + customer job updates — the sole-writer the admin cancel path
      // uses. The atomic guard on fromStatus makes a racing transition throw
      // instead of clobbering it.
      let flipped = false;
      try {
        await transitionJobStatus({
          jobId: svc.id,
          fromStatus: svc.status,
          toStatus: 'cancelled',
          transitionedBy: null,
          notes: visitNote,
          // Caller-owned: this processor suppresses per-visit notices via
          // its OWN awaited handleCancellation AFTER its went-live
          // compensation check — a fire-and-forget hook claim here could
          // land after a compensating revert and close the reminder row of
          // a re-armed active visit (codex r3).
          notifyCustomer: 'caller_suppress',
          // The tech notice waits for the live-state check below: a cancel
          // the tech raced by going en route is reverted, and must never
          // have told them their visit was cancelled.
          suppressTechNotice: true,
        });
        flipped = true;
      } catch (err) {
        // Guard-mismatch race: another path moved the row first. A concurrent
        // duplicate that already CANCELLED it falls through to the (idempotent)
        // side effects below so a half-processed racer still gets repaired;
        // other terminal history is a benign skip; anything else (a tech went
        // en_route mid-request, or a real failure) needs office eyes.
        let freshStatus = null;
        try {
          const fresh = await db('scheduled_services').where({ id: svc.id }).first('status');
          freshStatus = fresh ? fresh.status : null;
        } catch (recheckErr) {
          logger.error(`[cancellation-processor] status re-check failed for ${svc.id}: ${recheckErr.message}`);
        }
        if (freshStatus !== 'cancelled') {
          const benign = !!freshStatus
            && !CANCELLABLE_STATUSES.includes(freshStatus)
            && freshStatus !== 'en_route' && freshStatus !== 'on_site';
          if (!benign) {
            errors.push(`cancel_visit:${svc.id}`);
            logger.error(`[cancellation-processor] failed to cancel visit ${svc.id}: ${err.message}`);
          }
          return;
        }
      }

      if (flipped) {
        // The flip's atomic guard covers only `status` — the tracker can go
        // LIVE between our sweep SELECT and the flip while its best-effort
        // status sync fails, in which case we just cancelled a visit a tech is
        // actively working. Re-read the track layer and compensate: revert the
        // flip (with its own audit row) and flag for manual handling instead.
        let wentLive = false;
        try {
          const freshTrack = await db('scheduled_services').where({ id: svc.id }).first('track_state');
          wentLive = !!freshTrack && LIVE_TRACK_STATES.includes(freshTrack.track_state);
        } catch (trackCheckErr) {
          logger.error(`[cancellation-processor] track-state re-check failed for ${svc.id}: ${trackCheckErr.message}`);
        }
        if (wentLive) {
          try {
            await transitionJobStatus({
              jobId: svc.id,
              fromStatus: 'cancelled',
              toStatus: svc.status,
              transitionedBy: null,
              notes: 'Auto-cancel reverted — tech went live mid-request',
            });
            errors.push(`in_progress_visit:${svc.id}`);
            logger.warn(`[cancellation-processor] visit ${svc.id} went live mid-request — cancel reverted, left for manual handling`);
          } catch (revertErr) {
            // The revert lost its own race (the visit advanced again). Leave
            // the row as-is and flag it — office review decides the end state.
            errors.push(`cancel_visit:${svc.id}`);
            logger.error(`[cancellation-processor] failed to revert live-visit cancel for ${svc.id}: ${revertErr.message}`);
          }
          return;
        }
        cancelledCount += 1;
        cancelledIds.push(svc.id);
        // The cancel stands — now the assigned tech hears it (post-commit,
        // best-effort, gate-dark; recipient read from the row). The actor
        // is the customer (portal path) or the acting staff row, so the card
        // reads "by the customer online" / "by <name>", and a staff member
        // cancelling their own visit stays silent.
        void require('./tech-visit-notifications').notifyVisitCancelled({
          visitId: svc.id, actorId: actorType === 'customer' ? 'customer' : (actor?.userId || null), previousStatus: svc.status,
        });
      }
    }

    // Mirror the admin cancel path's side effects for the committed flip.
    // Each is best-effort so one failure never strands the rest of the sweep;
    // money-path failures are recorded so the admin alert says "review manually".

    // Reminder record → cancelled, so a deferred "appointment confirmed" send
    // can't fire for a pulled visit. Per-visit cancellation SMS suppressed —
    // the route sends one dedicated cancellation-confirmation SMS instead.
    // The helper catches its own failures and returns null (which is ALSO its
    // no-reminder-row signal), so re-check the row: one left uncancelled means
    // deferred confirmations can still fire for a cancelled visit — surface it
    // instead of the alert claiming full auto-processing.
    try {
      const AppointmentReminders = require('./appointment-reminders');
      await AppointmentReminders.handleCancellation(svc.id, { sendNotification: false });
      const staleReminder = await db('appointment_reminders')
        .where({ scheduled_service_id: svc.id })
        .whereRaw('cancelled IS DISTINCT FROM true')
        .first('id');
      if (staleReminder) {
        errors.push(`reminder_cancel:${svc.id}`);
        logger.error(`[cancellation-processor] reminder row for ${svc.id} still active after cancellation — needs manual review`);
      }
    } catch (err) {
      errors.push(`reminder_cancel:${svc.id}`);
      logger.error(`[cancellation-processor] reminder cancellation failed for ${svc.id}: ${err.message}`);
    }

    // Void any still-open invoice pre-minted for this visit (e.g. the admin
    // Charge-now path) so dunning doesn't chase a cancelled job. The helper
    // never throws — it intentionally SKIPS invoices it can't safely void
    // (payment in flight / applied money / unverifiable PI) — so re-check for
    // anything NOT money-resolved and surface it as a manual-review error
    // instead of the alert claiming billing fully stopped. That includes
    // 'paid'/'processing' (cash captured or in flight for a visit that now
    // won't happen → refund/credit decision) and a transient 'sending' claim,
    // not just the voidable statuses the sweep skipped.
    try {
      const InvoiceService = require('./invoice');
      await InvoiceService.voidOpenInvoicesForCancelledService(svc.id);
      const unresolved = await db('invoices')
        .where({ scheduled_service_id: svc.id })
        .whereNotIn('status', InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES)
        .select('id');
      for (const inv of unresolved) {
        errors.push(`invoice_review:${inv.id}`);
        logger.error(`[cancellation-processor] invoice ${inv.id} for visit ${svc.id} still needs money handling — manual review`);
      }
    } catch (err) {
      errors.push(`void_invoices:${svc.id}`);
      logger.error(`[cancellation-processor] invoice void sweep failed for ${svc.id}: ${err.message}`);
    }

    // One-time card-on-file hold: an in-window cancellation charges the flat
    // late-cancel fee, otherwise the hold is released. No-op when no hold
    // exists; dark until ONE_TIME_CARD_HOLD. Failure comes back as a reason
    // code, not a throw — surface the money-unresolved outcomes (declined fee,
    // ambiguous Stripe result, post-charge write failure).
    try {
      const CardHolds = require('./estimate-card-holds');
      // waiveLateFee (C3, office-initiated waive): the hold rail RELEASES
      // instead of judging the fee window — 'offboard' intent on scoped
      // cancels too: the visit's family is ending either way, and with the
      // park-on-cancel gate a plain waived cancel would PARK the hold
      // ({parked:true}, no released field) while the records claim the fee
      // was waived — a parked hold is deferred collection, not a waiver.
      const holdResult = await CardHolds.handleCardHoldCancellation({
        scheduledServiceId: svc.id,
        ...(feeEvaluationAt ? { now: feeEvaluationAt } : {}),
        ...(lateFeeWaived ? { waiveFee: true, intent: 'offboard' } : {}),
      });
      // released === false is unresolved money even with NO reason (a lost
      // release race returns exactly that shape) — same rule as the
      // appointment-card rail below. A WAIVER is confirmed only by an
      // explicit released:true on an existing hold — parked or any other
      // shape is not a waived fee.
      if (holdResult && (CARD_HOLD_REVIEW_REASONS.has(holdResult.reason) || holdResult.released === false
        || (lateFeeWaived && holdResult.reason !== 'no_hold' && holdResult.released !== true))) {
        errors.push(`card_hold:${svc.id}`);
        if (lateFeeWaived) feeWaiverConfirmed = false;
        logger.error(`[cancellation-processor] card hold for ${svc.id} needs review: ${holdResult.reason || 'released:false with no reason'}`);
      }
      // A waiver on a retry must not paper over a fee the FIRST attempt
      // already charged: a charged hold is terminal (status charged_no_show)
      // and invisible to heldCardForScheduledService, so the waive path
      // reads clean while the customer's money is gone. Detect it and park
      // for office review (refund is a human decision, never automatic).
      // Unverifiable = not a confirmed waiver (fail closed).
      if (holdResult?.reason === 'no_hold' && lateFeeWaived) {
        try {
          const charged = await db('estimate_card_holds')
            .where({ scheduled_service_id: svc.id, status: 'charged_no_show' })
            .first('id');
          if (charged) {
            feeWaiverConfirmed = false;
            errors.push(`card_hold_already_charged:${svc.id}`);
            logger.error(`[cancellation-processor] waiver requested for ${svc.id} but a late-cancel fee was already charged (hold ${charged.id}) — office review, not a waiver`);
          }
        } catch (probeErr) {
          feeWaiverConfirmed = false;
          errors.push(`card_hold:${svc.id}`);
          logger.error(`[cancellation-processor] charged-fee probe failed for ${svc.id}: ${probeErr.message}`);
        }
      }
      // Appointment-card fee rail fallback for visits with no hold row
      // (mutually exclusive lanes — the rail re-checks). Customer-initiated
      // cancel: no waive; office-initiated waive closes the fee 'waived'.
      // Same review-reason surfacing.
      if (holdResult?.reason === 'no_hold') {
        const ApptCardRequests = require('./appointment-card-request');
        const apptResult = await ApptCardRequests.handleAppointmentCardCancellation({
          scheduledServiceId: svc.id,
          ...(feeEvaluationAt ? { now: feeEvaluationAt } : {}),
          ...(lateFeeWaived ? { waiveFee: true } : {}),
        });
        // Any non-released outcome from the appt-fee rail is unresolved
        // money (the rail reserves released:false for exactly that), so the
        // reason-set check is belt-and-braces on top of it.
        if (apptResult && (CARD_HOLD_REVIEW_REASONS.has(apptResult.reason) || apptResult.released === false)) {
          errors.push(`appt_card_fee:${svc.id}`);
          if (lateFeeWaived) feeWaiverConfirmed = false;
          logger.error(`[cancellation-processor] appointment-card fee for ${svc.id} needs review: ${apptResult.reason}`);
        }
      }
    } catch (err) {
      errors.push(`card_hold:${svc.id}`);
      if (lateFeeWaived) feeWaiverConfirmed = false;
      logger.error(`[cancellation-processor] card-hold handling failed for ${svc.id}: ${err.message}`);
    }

    // Legacy rows predate the track layer (track_state NULL): normalize to
    // 'scheduled' first so trackTransitions.cancel's guarded update matches
    // and stamps cancelled_at / cancellation_reason — the helper reports ok
    // on its 0-row fallback, which would otherwise count this visit as fully
    // cancelled with the tracker fields never set.
    try {
      await db('scheduled_services')
        .where({ id: svc.id })
        .whereNull('track_state')
        .update({ track_state: 'scheduled' });
    } catch (err) {
      logger.warn(`[cancellation-processor] track-state normalize failed for ${svc.id}: ${err.message}`);
    }

    // Customer-visible track layer: track_state / cancelled_at /
    // cancellation_reason + tech-status clear + token-expiry extension. It
    // no-ops on a genuinely-complete visit, so it can't un-complete anything.
    // A failure/non-ok result means the public tracker still shows the visit
    // live after the status flip above — surface it so staff repair it.
    try {
      const trackResult = await trackTransitions.cancel(svc.id, { reason: rowReason, actorId: null });
      if (!trackResult || trackResult.ok !== true) {
        errors.push(`track_cancel:${svc.id}`);
        logger.error(
          `[cancellation-processor] track-layer cancel not ok for ${svc.id}: ${(trackResult && trackResult.reason) || 'unknown'}`
        );
      }
    } catch (err) {
      errors.push(`track_cancel:${svc.id}`);
      logger.error(`[cancellation-processor] track-layer cancel failed for ${svc.id}: ${err.message}`);
    }
  }

  // Pass 0 processes the sweep plus the prior-attempt repairs; pass 1 re-sweeps
  // ONCE for stragglers — recurrence is already off, but a completion that read
  // recurring_ongoing=true before our flip can still insert one final
  // occurrence while we're cancelling. At most one generation can appear, so a
  // single re-sweep bounds it.
  for (let pass = 0; pass < 2; pass += 1) {
    let rows = [];
    try {
      rows = await sweepCancellable();
    } catch (err) {
      errors.push('load_visits');
      logger.error(`[cancellation-processor] failed to load visits for ${customerId}: ${err.message}`);
      break;
    }
    const batch = rows
      .filter((r) => !processed.has(r.id))
      .map((s) => ({ ...s, alreadyCancelled: false }));
    if (pass === 0) {
      batch.push(...repairs
        .filter((r) => !processed.has(r.id))
        .map((s) => ({ ...s, alreadyCancelled: true })));
    }
    if (!batch.length) break;
    for (const svc of batch) {
      processed.add(svc.id);
      await processVisit(svc);
    }
  }

  // Per-application lane fields (billing_mode + per_application_fee) are
  // deliberately RETAINED at churn (codex rounds 14→34 converged here):
  // they are the price authority for any straggler completion or a
  // deliberately rebooked visit on the churned account, and no clear can
  // be made race-free without every booking writer joining a shared lock
  // protocol. NULL rate + autopay off already stop all automatic billing;
  // the residue is visible in audit-churned-accounts-live-state.js and the
  // office clears the lane after quiescence (ops/agents/
  // churn-residue-backfill.js does it with guards for the backlog).

  // Audit trail on the customer timeline — only the first time we churn, and
  // written AFTER the sweep so the note carries the final visit count.
  // Scoped wind-down AFTER the sweep (the plan was proven attributable up
  // front, so this cannot fail on attribution; a write failure is reported
  // and leaves the visits cancelled — the office repairs the rate, never the
  // reverse).
  // Repair-only retries VERIFY the first run's wind-down instead of assuming
  // it: run 1 may have failed applyScopedWindDown after pulling the visits,
  // and with the families gone from the live rows no new plan can be built —
  // reporting wound-down anyway would close the retry clean while the
  // tier/rate/ledger still bill the cancelled family. Monthly-lane proof =
  // NO component left for a scoped family at all: applyScopedWindDown
  // deletes every in-scope row in the same transaction as the tier demote
  // and the remaining-family reprice, so ANY surviving row — including a
  // held family's legitimately-$0 parked component — means that transaction
  // never landed (codex GH r27 P1: a $0 residual is not "done"). Residual
  // or unverifiable → 'scoped_wind_down' stays on the run and the office
  // repairs the rate by hand — the same bell run 1 raised, never a silent
  // overcharge.
  let scopedWoundDown = false;
  if (scopedRepairOnly) {
    try {
      const { loadComponents } = require('./plan-rate-ledger');
      const components = await loadComponents(db, customerId);
      const residual = (components || []).filter((c) => scopedFamilies.includes(c.family_key));
      scopedWoundDown = residual.length === 0;
      if (scopedWoundDown) {
        // Per-application accounts carry NO monthly components, so the
        // ledger check proves nothing there. The proof is the REQUEST-
        // scoped stamp applyScopedWindDown writes in its transaction
        // (service_requests.metadata.cancel_plan.scopedWindDownCommitted)
        // — never the customer-wide waveguard_tier_source, which a prior
        // scoped cancel leaves set (codex GH r33 P1). Missing/unreadable
        // = not proven: partial + belled (safe side), the office repairs.
        const custRow = await db('customers').where({ id: customerId }).first('billing_mode');
        if (custRow && String(custRow.billing_mode || '') === 'per_application') {
          const reqRow = requestId ? await db('service_requests').where({ id: requestId }).first('metadata') : null;
          let meta = null;
          try { meta = reqRow ? (typeof reqRow.metadata === 'string' ? JSON.parse(reqRow.metadata) : reqRow.metadata) : null; } catch { meta = null; }
          if (!(meta && meta.cancel_plan && meta.cancel_plan.scopedWindDownCommitted === true)) scopedWoundDown = false;
        }
      }
    } catch (verifyErr) {
      logger.error(`[cancellation-processor] repair-retry wind-down verification failed for ${customerId}: ${verifyErr.message}`);
      scopedWoundDown = false;
    }
    if (!scopedWoundDown) errors.push('scoped_wind_down');
  }
  // The operator approved SPECIFIC numbers, and the sweep above is slow: a
  // ledger/hold/tier write — or a surviving-family visit — landing after
  // the commit's validation must be priced or refused, never silently
  // charged. applyScopedWindDown re-plans the surviving side from live rows
  // under the per-customer writer lock and reasserts the approved snapshot
  // in the same transaction; a mismatch refuses the repricing
  // (scoped_pricing_changed: partial + belled; a fresh preview re-approves
  // the live numbers).
  if (scoped && scopedPlan?.ok) {
    try {
      const applied = await applyScopedWindDown(customerId, scopedPlan, {
        requestId, actorLabel, lateFeeWaived: feeWaiverConfirmed, scopedFamilies, approvedScopedPricing,
      });
      scopedPlan = applied.plan;
      scopedWoundDown = true;
    } catch (err) {
      if (err && err.code === 'scoped_pricing_changed') {
        errors.push('scoped_pricing_changed');
        logger.error(`[cancellation-processor] scoped pricing drifted since approval for ${customerId} — wind-down refused (${err.message})`);
        scopedPlan = { ...scopedPlan, ok: false, error: 'pricing_changed' };
      } else {
        errors.push('scoped_wind_down');
        logger.error(`[cancellation-processor] scoped wind-down failed for ${customerId}: ${err.message}`);
      }
    }
  }

  // Termite retrieval — AFTER the sweep and wind-down, never before: the
  // task instructs staff to pull Waves-owned hardware, so it must not
  // exist while the steps that actually end the program can still fail
  // (stations must never come out of a live, still-billed program). Whole
  // account: the churn persisted. Scoped termite: the wind-down committed.
  if (churned || (scoped && scopedFamilies.includes('termite_bait') && scopedWoundDown)) {
    try {
      // The DATED task exists so RETAINED covered termite visits stay
      // deliverable. On a mixed account whose prepaid term covers a
      // DIFFERENT service, the uncovered termite visits are pulled NOW —
      // dating the task by the unrelated term's end would tell staff to
      // leave Waves-owned hardware in the ground for months after the
      // termite program ended. Date it only when a kept covered row is
      // itself a termite visit; anything ambiguous retrieves now (staff
      // can see a live covered visit on the calendar and hold off, but a
      // months-late instruction self-executes).
      let retrieveAfter = null;
      if (sweepAfter && keepIds && keepIds.length) {
        const keptRows = await db('scheduled_services')
          .where({ customer_id: customerId })
          .whereIn('id', keepIds)
          // 'rescheduled' matches the sweep's own predicate: an open rebook
          // intent is pulled regardless of date and keepIds, so a covered
          // termite row in that state does NOT stay deliverable — counting
          // it would date the retrieval task for a visit nobody delivers.
          .whereNotIn('status', ['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled'])
          .select('id', 'scheduled_date', 'status', 'service_id', 'service_type');
        const serviceIds = [...new Set(keptRows.map((r) => r.service_id).filter(Boolean))];
        const services = serviceIds.length
          ? await db('services').whereIn('id', serviceIds).select('id', 'service_key', 'name as service_name')
          : [];
        const byId = new Map(services.map((s) => [s.id, s]));
        const keptTermite = keptRows.some((r) => {
          const d = r.scheduled_date instanceof Date
            ? r.scheduled_date.toISOString().slice(0, 10)
            : String(r.scheduled_date || '').slice(0, 10);
          return d && d <= sweepAfter
            && familyOfServiceRow({ ...r, ...(byId.get(r.service_id) || {}) }) === 'termite_bait';
        });
        if (keptTermite) retrieveAfter = sweepAfter;
      }
      if (retrieveAfter || deferTermiteRetrieval) {
        // Deferred: the DATED task — and, when the caller asks, the
        // immediate one — also depends on the caller's annual-prepay term
        // decision, which happens AFTER this run — the caller raises it
        // only once the cancel decision stands. A conflicting renew
        // decision (or a lost decision write) means the program continues,
        // and no retrieval instruction may exist for a plan that did not
        // end.
        termiteRetrievalPending = { retrieveAfter };
      } else {
        await raiseTermiteRetrievalTask(customerId, requestId, { retrieveAfter: null });
      }
    } catch (err) {
      errors.push('termite_retrieval_task');
      logger.error(`[cancellation-processor] termite station retrieval task failed for ${customerId}: ${err.message}`);
    }
  }

  if (churned && !wasChurnedStage) {
    try {
      await db('customer_interactions').insert({
        customer_id: customerId,
        interaction_type: 'note',
        subject: 'Cancellation processed — churned + upcoming visits pulled',
        body:
          `${actorLabel} cancellation request ${requestId || ''}`.trim() +
          `. Cancelled ${cancelledCount} upcoming visit(s), stopped recurrence, ` +
          'set pipeline_stage=churned + active=false, disabled autopay.' +
          (sweepAfter ? ` Paid coverage kept through ${sweepAfter}.` : '') +
          // Confirmed only — a rail that failed to release must not be
          // recorded as a waived fee.
          (feeWaiverConfirmed ? ' Scheduled-visit fee waived.' : ''),
      });
    } catch (noteErr) {
      logger.warn(`[cancellation-processor] audit note failed for ${customerId}: ${noteErr.message}`);
    }
  }

  // AI churn-reason classification — deliberately the LAST step so a slow or
  // broken model can never delay the billing wind-down or the visit sweep,
  // and deliberately OUTSIDE `errors` — a classification miss leaves the row
  // at 'unclassified' (fail-closed), it is not an operational failure that
  // should flag the request for manual review.
  if (churned && !wasChurnedStage) {
    try {
      const { classifyChurnReason } = require('./churn-classifier');
      const { code } = await classifyChurnReason(cancelReason);
      if (code && code !== 'unclassified') {
        await db('customers').where({ id: customerId }).update({ churn_reason_code: code });
      }
    } catch (err) {
      logger.warn(`[cancellation-processor] churn classification failed for ${customerId} (left unclassified): ${err.message}`);
    }
  }

  const ok = errors.length === 0;
  logger.info(
    `[cancellation-processor] customer ${customerId}: cancelled ${cancelledCount} visit(s), ` +
      `recurrence stopped on ${recurrenceStopped} row(s), churned=${churned}, ok=${ok}` +
      (ok ? '' : ` (errors: ${errors.join(', ')})`)
  );

  return {
    cancelledCount, cancelledIds, recurrenceStopped, churned, ok, errors,
    // Rows a PRIOR attempt of this same request already cancelled (found by
    // its note) — disjoint from cancelledCount; a caller whose first-run
    // record was lost reconstructs the pull count from it.
    repairedCount: repairs.length,
    termiteRetrievalPending,
    churnEpisodeId: churned ? churnEpisodeId : null,
    // C3 facts the caller records on the case: what was kept, and whether
    // the requested waiver was CONFIRMED by every applicable fee rail —
    // never the raw request while a fee may still charge.
    keptThrough: sweepAfter,
    lateFeeWaived: feeWaiverConfirmed,
    ...(scoped ? {
      scope: scopedPlan?.inScope || scopedFamilies,
      remaining: scopedPlan?.remaining || [],
      tierBefore: scopedPlan?.tierBefore ?? null,
      tierAfter: scopedPlan?.tierAfter ?? null,
      scopedWoundDown,
    } : {}),
  };
}

module.exports = {
  processCancellationRequest, raiseTermiteRetrievalTask, rentedTermiteStationState, scopedPricingFingerprint,
  planScopedWindDown, applyScopedWindDown, familyOfServiceRow, priorCancelledVisits,
  CHURN_REASON, PORTAL_CANCEL_REASON_PREFIX, CANCELLABLE_STATUSES,
};

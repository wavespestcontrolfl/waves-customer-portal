// Helpers for tracking a single prepayment across an entire recurring series
// (e.g. customer pays $360 up front to cover four quarterly visits). The
// scheduled_services.prepaid_* columns already exist per-visit; this module
// fans a series-level payment across siblings and reconstructs the "visit X of
// Y · N more covered" context for the appointment detail UI.
const { recordAuditEvent } = require('./audit-log');
const logger = require('./logger');

// Statuses that should NOT receive a prepayment stamp. A completed visit
// already has its books closed; cancelled / no-show / skipped are dead rows
// we don't want to charge against. Rescheduled rows are replaced by another
// appointment, so keeping prepaid coverage on them double-counts visits.
// `skipped` is treated as terminal because
// other dispatch flows already use it as the operator-driven "we did not
// service this row" outcome.
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'no_show', 'rescheduled', 'skipped']);

// The annual-prepay writer's method. Manual writers never create or replace
// it: annual coverage is applied by annual-prepay-renewals after its funding
// and service-scope checks, and the completion billing gate trusts that
// authority only while the method and term link survive.
const ANNUAL_PREPAY_METHOD = 'annual_prepay_invoice';

function hasAnnualCoverage(row) {
  return !!(row?.annual_prepay_term_id || row?.prepaid_method === ANNUAL_PREPAY_METHOD);
}

// Narrower than hasAnnualCoverage: true only when the row's CURRENT stamp
// actually IS the annual method with a positive amount — not merely LINKED
// to a term. attachScheduledServices links a row to a term by date/service
// match before the term ever stamps it, and applyPrepaidCoverageForTerm
// deliberately preserves an existing non-annual prepaid_method rather than
// overwrite it ("its stamp is a real out-of-band payment") — so a row can
// carry a live annual_prepay_term_id while its money is a genuine manual
// cash/Zelle payment. Used wherever a CLEAR must decide "is this specific
// stamp the annual one" rather than "is this row ever touched by a term at
// all" (Codex round-2 P1, symmetric with the DELETE /:id/prepaid route's
// own distinction).
function hasGenuineAnnualStamp(row) {
  return row?.prepaid_method === ANNUAL_PREPAY_METHOD && Number(row?.prepaid_amount) > 0;
}

// Embed the annual-coverage refusal IN a manual single-visit stamp UPDATE
// (bulk mark-prepaid, POST /:id/prepaid) so an annual activation that lands
// between a pre-read and the write is never overwritten with a manual method
// (Codex #4030 r7 P1). IS DISTINCT FROM keeps a NULL method eligible.
function withoutAnnualCoverage(query) {
  return query
    .whereNull('annual_prepay_term_id')
    .whereRaw('prepaid_method IS DISTINCT FROM ?', [ANNUAL_PREPAY_METHOD]);
}

// Series rows of the same family share `recurring_parent_id`. The parent row
// itself has `recurring_parent_id IS NULL` and is identified by its own id
// matching its children's parent pointer. resolveSeriesParentId() collapses
// both cases to the single id we can fan out from.
function resolveSeriesParentId(service) {
  if (!service) return null;
  return service.recurring_parent_id || service.id;
}

// Fetch every row in the recurring family (parent + children) ordered by
// scheduled_date so the UI can show "visit 2 of 4" deterministically.
// `lock: true` (inside a transaction) takes FOR UPDATE on the rows the stamp
// will UPDATE — the non-terminal family only, filtered in SQL — so the
// eligibility read and the stamps see one row state (stampSeriesPrepaid).
// A NULL status is a live visit (service-cadence convention; the annual
// writer's own predicate) — a bare NOT IN evaluates unknown and would drop a
// legacy null-status sibling from the locked set, so an annual term or stamp
// it carries could never refuse the manual write (Codex #4030 r7 P1).
// Terminal rows are deliberately NOT locked: the series cancel locks its
// cancellable children first and touches the (possibly completed) parent
// last for the recurring_ongoing clear; locking the whole family here in
// date order would take that parent first and deadlock against it
// (Codex #3878 r3 P2). Both paths now lock live rows in scheduled_date
// order and nothing else.
async function fetchSeriesRows(db, parentId, { lock = false } = {}) {
  const q = db('scheduled_services')
    .where(function () {
      this.where('recurring_parent_id', parentId).orWhere('id', parentId);
    })
    .orderBy(['scheduled_date', 'window_start', 'id']);
  if (!lock) return q;
  return q.where(function liveRows() {
    this.whereNull('status').orWhereNotIn('status', [...TERMINAL_STATUSES]);
  }).forUpdate();
}

// Round to cents so per-visit stamps reconcile to the series total without
// floating-point drift. The last row absorbs any sub-cent remainder so the
// stamped amounts sum exactly to the input total.
function splitTotalAcrossVisits(totalDollars, visitCount) {
  if (!Number.isFinite(totalDollars) || totalDollars < 0 || visitCount <= 0) return [];
  const totalCents = Math.round(totalDollars * 100);
  const baseCents = Math.floor(totalCents / visitCount);
  const remainder = totalCents - baseCents * visitCount;
  const slices = [];
  for (let i = 0; i < visitCount; i++) {
    const cents = baseCents + (i === visitCount - 1 ? remainder : 0);
    slices.push(cents / 100);
  }
  return slices;
}

// The most recent ACTIVE prepaid_series.allocated audit row for each of
// `ids`, for this customer — i.e. an allocation event by a PRIOR call to
// stampSeriesPrepaid that has not since been retired. Used by a restamp's
// booster reconciliation to find which excluded rows to reconcile — but an
// active audit row alone only proves the row was ONCE part of a series
// allocation, not that its CURRENT stamp still IS that allocation: a
// single-visit clear (or a fresh independent single-visit stamp written
// over it) leaves this audit row active without retiring it. The caller
// must additionally compare the row's current prepaid_amount/
// prepaid_method/prepaid_at against the returned metadata before treating
// the row as still holding that stale slice.
async function mostRecentActiveAllocations(trx, { customerId, ids }) {
  if (!ids.length) return new Map();
  const audits = await trx('audit_log as allocation')
    .where({
      'allocation.action': 'prepaid_series.allocated',
      'allocation.resource_type': 'scheduled_service',
    })
    .whereIn('allocation.resource_id', ids)
    .whereRaw("allocation.metadata->>'customer_id' = ?", [customerId])
    .whereNotExists(function activeClear() {
      this.select(trx.raw('1')).from('audit_log as cleared')
        .where({
          'cleared.action': 'prepaid_series.cleared',
          'cleared.resource_type': 'prepaid_series_allocation',
        })
        .whereRaw('cleared.resource_id = allocation.id');
    })
    .orderBy('allocation.created_at', 'asc')
    .select('allocation.resource_id', 'allocation.metadata');
  const byResourceId = new Map();
  // Last write wins if more than one active allocation somehow exists for
  // the same row (shouldn't happen in normal operation, but the ordering
  // keeps this deterministic rather than picking an arbitrary one).
  for (const row of audits) {
    const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    byResourceId.set(row.resource_id, metadata);
  }
  return byResourceId;
}

async function retireActiveAllocationAudits(trx, { customerId, parentId, ids }) {
  const audits = await trx('audit_log as allocation')
    .where({
      'allocation.action': 'prepaid_series.allocated',
      'allocation.resource_type': 'scheduled_service',
    })
    .whereIn('allocation.resource_id', ids)
    .whereRaw("allocation.metadata->>'customer_id' = ?", [customerId])
    .whereNotExists(function activeClear() {
      this.select(trx.raw('1')).from('audit_log as cleared')
        .where({
          'cleared.action': 'prepaid_series.cleared',
          'cleared.resource_type': 'prepaid_series_allocation',
        })
        .whereRaw('cleared.resource_id = allocation.id');
    })
    .select('allocation.id');
  for (const allocation of audits) {
    await recordAuditEvent({
      actor_type: 'system', action: 'prepaid_series.cleared',
      resource_type: 'prepaid_series_allocation', resource_id: allocation.id,
      metadata: { customer_id: customerId, series_parent_id: parentId, reason: 'superseded' },
      critical: true, trx,
    });
  }
}

// Stamp every eligible row in a recurring series with its share of a single
// prepayment. Eligible = not in a terminal status (completed / cancelled /
// no_show). Returns the stamped rows so the caller can echo them back to the
// client and so the audit log can reference each touched id.
async function stampSeriesPrepaid(db, {
  anchorServiceId,
  totalAmount,
  method,
  note,
  useExistingTransaction = false,
}) {
  const amount = ['number', 'string'].includes(typeof totalAmount) ? Number(totalAmount) : NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error('Series prepayment must be a positive amount');
    err.status = 400;
    err.statusCode = 400;
    err.isOperational = true;
    throw err;
  }
  // Annual coverage is applied by annual-prepay-renewals after its funding
  // and service-scope checks. A manual stamp cannot manufacture that evidence.
  if (method === ANNUAL_PREPAY_METHOD) {
    const err = new Error('Use the annual prepay workflow to apply annual coverage');
    err.status = 409;
    err.statusCode = 409;
    err.isOperational = true;
    throw err;
  }
  const anchor = await db('scheduled_services')
    .where({ id: anchorServiceId })
    .first();
  if (!anchor) {
    const err = new Error('Scheduled service not found');
    err.status = 404;
    err.statusCode = 404;
    err.isOperational = true;
    throw err;
  }
  const parentId = resolveSeriesParentId(anchor);
  const now = new Date();
  const updatedRows = [];
  let eligible = [];
  let stampTargets = [];
  let slices = [];
  const run = useExistingTransaction
    ? async (handler) => handler(db)
    : async (handler) => db.transaction(handler);
  await run(async (trx) => {
    // Eligibility is decided INSIDE the transaction on locked rows: a
    // series cancel (admin-dispatch, FOR UPDATE on the same rows) that
    // commits first is seen here as terminal and never stamped; one that
    // is still open blocks on these locks and then reads the stamps
    // before it transitions (Codex #3878 r1 P1 / hook r2). A pre-read
    // family filtered before the transaction let a stamp land on a visit
    // cancelled in between — money allocated to a visit that never runs.
    const family = await fetchSeriesRows(trx, parentId, { lock: true });
    eligible = family.filter((row) => !TERMINAL_STATUSES.has(String(row.status || '').toLowerCase()));
    if (!eligible.length) {
      const err = new Error('No eligible visits in this series to mark prepaid');
      err.status = 400;
      err.statusCode = 400;
      err.isOperational = true;
      throw err;
    }
    if (eligible.some((row) => row.customer_id !== anchor.customer_id)) {
      const err = new Error('Series contains visits for another customer; reconcile the series before recording prepayment');
      err.status = 409;
      err.statusCode = 409;
      err.isOperational = true;
      throw err;
    }
    // Never replace even pending/stale annual linkage with a cash stamp:
    // that changes which coverage authority the completion billing gate trusts.
    if (eligible.some(hasAnnualCoverage)) {
      const err = new Error('Series has annual prepay coverage; reconcile that term before recording a manual prepayment');
      err.status = 409;
      err.statusCode = 409;
      err.isOperational = true;
      throw err;
    }
    // A recurring family can carry booster rows alongside its cadence
    // visits: same recurring_parent_id, but inserted with is_recurring:
    // false AND no recurring_pattern (admin-schedule.js booster insert
    // never sets one — only the cadence child loop does) because boosters
    // bill their own price and are never a dues-covered plan visit. A
    // series-level prepayment covers the cadence visits the operator was
    // shown and charged for — fanning it across boosters too stamps every
    // cadence visit short (re-billed at completion) while crediting a
    // booster the customer never paid for (ADMIN-BUG-R09). Requiring BOTH
    // signals (not is_recurring alone) keeps this from misfiring on a row
    // that is simply not flagged recurring but still carries a real
    // cadence (schedule-integrity fixtures do this) — that row is not a
    // booster and must not be dropped from the split. stampTargets is
    // every eligible row MINUS the identified boosters (not merely the
    // is_recurring===true subset — a legitimately-patterned but
    // not-flagged-recurring row must survive alongside a real booster in
    // the same family). Only exclude when at least one non-booster row
    // remains — a lone booster stamped on its own (applyToSeries on a
    // family of one) still gets its full stamp, unaffected.
    const boosterIds = new Set(
      eligible.filter((row) => row.is_recurring === false && !row.recurring_pattern).map((row) => row.id),
    );
    stampTargets = (boosterIds.size > 0 && boosterIds.size < eligible.length)
      ? eligible.filter((row) => !boosterIds.has(row.id))
      : eligible;
    if (Math.round(amount * 100) < stampTargets.length) {
      const err = new Error('Series prepayment must allocate at least one cent to every covered visit');
      err.status = 400;
      err.statusCode = 400;
      err.isOperational = true;
      throw err;
    }
    // stampSeriesPrepaid is a general-purpose "record what the office
    // collected across this family" writer (an explicit repair from
    // Customer 360 can legitimately record a different total than
    // visitCount x catalog price — a price change, a negotiated amount).
    // It is deliberately NOT the layer that validates totalAmount against
    // catalog pricing: that reconciliation (ADMIN-BUG-R09 variant B) is the
    // booking ROUTE's job, done BEFORE this is ever called, against the
    // rows it actually placed (admin-schedule.js:
    // assertPrepayTotalMatchesPricing with the placed count, not the
    // requested plannedCount). Here we only ever split whatever total the
    // caller passed evenly across the resolved stampTargets.
    slices = splitTotalAcrossVisits(amount, stampTargets.length);
    // A restamp of a family that a PRIOR call to stampSeriesPrepaid (before
    // this fix, or before a Customer 360 amendment) fanned across boosters
    // must not leave those boosters holding a stale slice: the new stamp
    // below reallocates the WHOLE submitted total across the cadence rows
    // only, so a booster's old series-level slice would otherwise survive
    // untouched — money on the books for a visit the office never actually
    // collected for, suppressing its completion billing. Only clear a
    // booster's stamp when it traces to THIS series mechanism's own prior
    // allocation (an active prepaid_series.allocated audit row) — a
    // booster stamped independently (its own single-visit prepayment,
    // unrelated to any series fan-out) is left alone.
    const excludedBoosterRows = eligible.filter((row) => boosterIds.has(row.id) && Number(row.prepaid_amount) > 0);
    if (excludedBoosterRows.length) {
      const activeAllocations = await mostRecentActiveAllocations(trx, {
        customerId: anchor.customer_id,
        ids: excludedBoosterRows.map((row) => row.id),
      });
      // An ACTIVE allocation audit row only proves this booster was ONCE
      // part of a series allocation — a single-visit clear (or a fresh
      // independent single-visit stamp written over it) leaves that audit
      // row active without retiring it. Only treat the booster as still
      // holding that stale slice when its CURRENT stamp exactly matches
      // what the allocation recorded (amount, method, and the timestamp);
      // anything else — cleared since, or overwritten by an independent
      // payment — is left untouched rather than risk erasing real money.
      const staleBoosterIds = excludedBoosterRows
        .filter((row) => {
          const metadata = activeAllocations.get(row.id);
          if (!metadata) return false;
          const rowPrepaidAt = row.prepaid_at instanceof Date ? row.prepaid_at.toISOString() : new Date(row.prepaid_at).toISOString();
          return Number(metadata.prepaid_amount) === Number(row.prepaid_amount)
            && (metadata.prepaid_method || null) === (row.prepaid_method || null)
            && metadata.prepaid_at === rowPrepaidAt;
        })
        .map((row) => row.id);
      if (staleBoosterIds.length) {
        await trx('scheduled_services').whereIn('id', staleBoosterIds)
          .update({ prepaid_amount: null, prepaid_method: null, prepaid_note: null, prepaid_at: null });
      }
    }
    // An explicit series restamp is an amendment, including a repair after a
    // visit was cleared. Retire the prior allocation evidence atomically
    // before writing the replacement — over the WHOLE family, not just the
    // rows being restamped, so a superseded booster allocation (just
    // reconciled above) is marked retired too, not left as a dangling
    // "active" audit row. A single-visit clear remains the path that
    // intentionally leaves evidence for reconciliation.
    await retireActiveAllocationAudits(trx, {
      customerId: anchor.customer_id,
      parentId,
      ids: eligible.map((row) => row.id),
    });
    for (let i = 0; i < stampTargets.length; i++) {
      const row = stampTargets[i];
      const amt = slices[i];
      const [updated] = await trx('scheduled_services')
        .where({ id: row.id })
        .update({
          prepaid_amount: amt,
          prepaid_method: method || null,
          prepaid_note: note || null,
          prepaid_at: now,
        })
        .returning(['id', 'prepaid_amount', 'prepaid_method', 'prepaid_note', 'prepaid_at', 'scheduled_date']);
      if (!updated) throw new Error('Series prepayment did not update every locked visit');
      // Retain the allocation even if every live stamp is later erased. The
      // audit and money marker commit together, including booking transactions.
      await recordAuditEvent({
        actor_type: 'system', action: 'prepaid_series.allocated',
        resource_type: 'scheduled_service', resource_id: row.id,
        metadata: { customer_id: anchor.customer_id, series_parent_id: parentId,
          prepaid_amount: amt, prepaid_method: method || null, prepaid_at: now.toISOString() },
        critical: true, trx,
      });
      updatedRows.push(updated);
    }
  });
  return {
    seriesParentId: parentId,
    visitsCovered: stampTargets.length,
    perVisitAmount: slices[0] ?? 0,
    seriesTotal: Number(totalAmount),
    updatedRows,
  };
}

// The existing explicit whole-series clear retires its allocation evidence.
// Single-visit clears intentionally leave it outstanding for reconciliation.
async function clearSeriesPrepaid(db, anchor) {
  const parentId = resolveSeriesParentId(anchor);
  return db.transaction(async (trx) => {
    // Same live-row lock order as stamping/cancellation. Lock even erased
    // stamps so a concurrent payment cannot be retired without being cleared.
    await fetchSeriesRows(trx, parentId, { lock: true });
    const family = await fetchSeriesRows(trx, parentId);
    const familyIds = family.filter((row) => row.customer_id === anchor.customer_id).map((row) => row.id);
    // Symmetry with the manual writers (stampSeriesPrepaid, POST
    // /:id/prepaid, bulk mark_prepaid): a series clear must never erase
    // annual-prepay coverage evidence. Nulling the stamp here (with the
    // annual_prepay_term_id link left in place) makes annualPrepayCoversVisit
    // false while the completion billing gate has no other record the visit
    // was already paid inside the annual term — completion mints a second
    // invoice for a visit the customer already paid for (ADMIN-BUG-R33).
    // The only sanctioned way to remove annual coverage is
    // clearPrepaidStampsForTerm (the void/refund path), which operates on
    // the term directly rather than through this manual clear.
    //
    // An ONGOING family spans billing periods: a long-completed visit from a
    // prior, unrelated annual term keeps its historical annual_prepay_term_id
    // / prepaid_method stamp (by design — that's the paid-coverage record
    // for the visit that actually ran), while the family's LIVE siblings can
    // carry an entirely separate, ordinary manual (cash/Zelle) stamp the
    // office legitimately wants to clear. Scanning the WHOLE family for any
    // annual coverage and refusing the entire request punished that
    // unrelated historical row onto every future series clear (Codex
    // round-1 P2). Protect each annual-covered row individually — leave it
    // out of the update entirely — and clear the rest; only refuse outright
    // when EVERY row in the family is annual-covered, i.e. there is no
    // manual stamp here at all to legitimately clear.
    //
    // Gate on the GENUINE annual stamp (hasGenuineAnnualStamp), not the bare
    // link (hasAnnualCoverage): the same distinction the single-visit DELETE
    // route makes (Codex round-2 P1) — a row can carry a live
    // annual_prepay_term_id while its actual stamp is an ordinary manual
    // payment attachScheduledServices linked but never claimed.
    const annualCoveredIds = new Set(
      family.filter((row) => familyIds.includes(row.id) && hasGenuineAnnualStamp(row)).map((row) => row.id),
    );
    if (annualCoveredIds.size > 0 && annualCoveredIds.size === familyIds.length) {
      const err = new Error('Series has annual prepay coverage; reconcile that term (void/refund) before clearing a manual prepayment');
      err.status = 409;
      err.statusCode = 409;
      err.isOperational = true;
      throw err;
    }
    // A booster (is_recurring:false, no recurring_pattern — same identity
    // stampSeriesPrepaid's own fan-out uses) can carry its OWN, independent
    // prepayment: its own cash/Zelle stamp collected for that specific
    // visit, unrelated to any series-level allocation. A `?series=1` clear
    // must not wipe that money too — the booster would then be re-billed at
    // completion for a visit the customer already separately paid for.
    // Reuse stampSeriesPrepaid's own provenance check: only a booster row
    // whose CURRENT stamp still exactly matches an ACTIVE
    // prepaid_series.allocated allocation (amount/method/timestamp) traces
    // to THIS series mechanism (e.g. a pre-fix stamp that fanned across it,
    // or an explicit series re-stamp that included it) and is fair game to
    // clear here; anything else is left alone.
    const boosterIds = new Set(
      family.filter((row) => row.is_recurring === false && !row.recurring_pattern).map((row) => row.id),
    );
    const independentBoosterIds = new Set();
    if (boosterIds.size > 0) {
      const stampedBoosters = family.filter((row) => boosterIds.has(row.id) && Number(row.prepaid_amount) > 0);
      if (stampedBoosters.length) {
        const activeAllocations = await mostRecentActiveAllocations(trx, {
          customerId: anchor.customer_id,
          ids: stampedBoosters.map((row) => row.id),
        });
        for (const row of stampedBoosters) {
          const metadata = activeAllocations.get(row.id);
          const rowPrepaidAt = row.prepaid_at instanceof Date ? row.prepaid_at.toISOString() : (row.prepaid_at ? new Date(row.prepaid_at).toISOString() : null);
          const tracesToSeries = !!metadata
            && Number(metadata.prepaid_amount) === Number(row.prepaid_amount)
            && (metadata.prepaid_method || null) === (row.prepaid_method || null)
            && metadata.prepaid_at === rowPrepaidAt;
          if (!tracesToSeries) independentBoosterIds.add(row.id);
        }
      }
    }
    const ids = familyIds.filter((id) => !independentBoosterIds.has(id) && !annualCoveredIds.has(id));
    const cleared = await trx('scheduled_services').whereIn('id', ids)
      .whereNotNull('prepaid_amount')
      .update({ prepaid_amount: null, prepaid_method: null, prepaid_note: null, prepaid_at: null })
      .returning(['id', 'annual_prepay_term_id']);
    await retireActiveAllocationAudits(trx, {
      customerId: anchor.customer_id, parentId, ids,
    });
    // A cleared row may still be LINKED to a live annual term (its manual
    // stamp was occupying a slot the term itself would otherwise have
    // claimed, same shape the single-visit DELETE route reconciles) —
    // reapply each affected term's coverage so a now-unstamped, in-window
    // visit is picked up if the term still needs it. Best-effort: never
    // blocks the clear response itself — but Postgres aborts the WHOLE
    // transaction on any statement error, so catching a failed refresh on
    // `trx` directly would still leave it poisoned and take the stamp
    // clear/audit-retire above down with it despite the caught error. A
    // SAVEPOINT (nested transaction) isolates each refresh: a failure
    // inside it rolls back only that savepoint, leaving the outer clear
    // free to commit.
    const linkedTermIds = [...new Set(cleared.map((row) => row.annual_prepay_term_id).filter(Boolean))];
    for (const termId of linkedTermIds) {
      try {
        await trx.transaction(async (sp) => {
          await require('./annual-prepay-renewals').refreshTermSnapshot(termId, sp);
        });
      } catch (err) {
        logger.warn(`[prepaid-series] series clear: term coverage re-apply failed for term ${termId}: ${err.message}`);
      }
    }
    return { success: true, clearedCount: cleared.length, seriesParentId: parentId };
  });
}

// Build the "visit X of Y · N more covered" context for the appointment detail
// UI. Returns null when the service isn't part of a recurring family or no
// sibling is prepaid — in that case the existing single-visit "Prepaid $X"
// copy is enough and we don't want to introduce a phantom plan label.
async function buildPrepaidSeriesContext(db, service) {
  if (!service) return null;
  const parentId = resolveSeriesParentId(service);
  if (!parentId) return null;
  const family = await fetchSeriesRows(db, parentId);
  if (family.length <= 1) return null;
  const prepaidSiblings = family.filter((row) => row.prepaid_amount != null && Number(row.prepaid_amount) > 0);
  if (!prepaidSiblings.length) return null;
  const totalCoveredVisits = prepaidSiblings.length;
  const futureCoveredVisits = prepaidSiblings.filter(
    (row) => !TERMINAL_STATUSES.has(String(row.status || '').toLowerCase()) && row.id !== service.id,
  ).length;
  const visitNumber = family.findIndex((row) => row.id === service.id) + 1;
  // Per-visit amount must reflect THIS row's stamped slice, not the first
  // sibling's — splitTotalAcrossVisits dumps any sub-cent remainder onto the
  // final visit, so e.g. $100/3 yields a final row of $33.34 vs $33.33. Using
  // the anchor row keeps the detail card consistent with the row's books.
  const currentRowStamp = service.prepaid_amount != null
    ? Number(service.prepaid_amount)
    : Number(prepaidSiblings[0].prepaid_amount) || 0;
  const seriesTotal = prepaidSiblings.reduce(
    (sum, row) => sum + (Number(row.prepaid_amount) || 0),
    0,
  );
  return {
    seriesParentId: parentId,
    totalVisitsInSeries: family.length,
    totalCoveredVisits,
    futureCoveredVisits,
    visitNumber: visitNumber > 0 ? visitNumber : null,
    perVisitAmount: Math.round(currentRowStamp * 100) / 100,
    seriesTotal: Math.round(seriesTotal * 100) / 100,
    method: service.prepaid_method || prepaidSiblings[0].prepaid_method || null,
  };
}

// Lightweight customer-level rollup of active prepaid plans, used by the
// "Prepaid plans" card on Customer 360. One entry per recurring family that
// has at least one prepaid sibling.
async function listCustomerPrepaidPlans(db, customerId) {
  // Only rows with a positive stamp count — a `prepaid_amount = 0` row carries
  // no coverage and should not surface as an active plan, mirroring the
  // dispatch/detail UI which only shows the PAID pill on `> 0` rows.
  const rows = await db('scheduled_services')
    .where({ customer_id: customerId })
    .whereNotNull('prepaid_amount')
    .where('prepaid_amount', '>', 0)
    .orderBy('scheduled_date');
  if (!rows.length) return [];
  const families = new Map();
  for (const row of rows) {
    const parentId = resolveSeriesParentId(row);
    if (!families.has(parentId)) families.set(parentId, []);
    families.get(parentId).push(row);
  }
  const plans = [];
  for (const [parentId, paidRows] of families.entries()) {
    const family = await fetchSeriesRows(db, parentId);
    // "Prepaid plans" is documented as a recurring-family rollup. Standalone
    // prepaid visits are already covered by the per-visit "Prepaid $X" badge
    // and the dispatch row pill — don't double-count them here as fake plans.
    if (family.length <= 1) continue;
    const usedVisits = family.filter(
      (row) => String(row.status || '').toLowerCase() === 'completed' && row.prepaid_amount != null,
    ).length;
    const remainingVisits = paidRows.filter(
      (row) => !TERMINAL_STATUSES.has(String(row.status || '').toLowerCase()),
    ).length;
    const perVisitAmount = Number(paidRows[0].prepaid_amount) || 0;
    const seriesTotal = paidRows.reduce(
      (sum, row) => sum + (Number(row.prepaid_amount) || 0),
      0,
    );
    plans.push({
      seriesParentId: parentId,
      serviceType: paidRows[0].service_type || 'Service',
      recurringPattern: paidRows[0].recurring_pattern || null,
      totalVisits: family.length,
      paidVisits: paidRows.length,
      usedVisits,
      remainingVisits,
      perVisitAmount: Math.round(perVisitAmount * 100) / 100,
      seriesTotal: Math.round(seriesTotal * 100) / 100,
      method: paidRows[0].prepaid_method || null,
      paidAt: paidRows[0].prepaid_at || null,
      nextVisitDate: paidRows.find(
        (row) => !TERMINAL_STATUSES.has(String(row.status || '').toLowerCase()),
      )?.scheduled_date || null,
    });
  }
  return plans.sort((a, b) => (b.remainingVisits || 0) - (a.remainingVisits || 0));
}

module.exports = {
  TERMINAL_STATUSES,
  ANNUAL_PREPAY_METHOD,
  hasAnnualCoverage,
  withoutAnnualCoverage,
  resolveSeriesParentId,
  fetchSeriesRows,
  splitTotalAcrossVisits,
  stampSeriesPrepaid,
  clearSeriesPrepaid,
  buildPrepaidSeriesContext,
  listCustomerPrepaidPlans,
};

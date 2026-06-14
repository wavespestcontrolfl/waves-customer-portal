// Helpers for tracking a single prepayment across an entire recurring series
// (e.g. customer pays $360 up front to cover four quarterly visits). The
// scheduled_services.prepaid_* columns already exist per-visit; this module
// fans a series-level payment across siblings and reconstructs the "visit X of
// Y · N more covered" context for the appointment detail UI.

// Statuses that should NOT receive a prepayment stamp. A completed visit
// already has its books closed; cancelled / no-show / skipped are dead rows
// we don't want to charge against. Rescheduled rows are replaced by another
// appointment, so keeping prepaid coverage on them double-counts visits.
// `skipped` is treated as terminal because
// other dispatch flows already use it as the operator-driven "we did not
// service this row" outcome.
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'no_show', 'rescheduled', 'skipped']);

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
async function fetchSeriesRows(db, parentId) {
  return db('scheduled_services')
    .where(function () {
      this.where('recurring_parent_id', parentId).orWhere('id', parentId);
    })
    .orderBy(['scheduled_date', 'window_start', 'id']);
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
  const anchor = await db('scheduled_services')
    .where({ id: anchorServiceId })
    .first();
  if (!anchor) {
    const err = new Error('Scheduled service not found');
    err.status = 404;
    throw err;
  }
  const parentId = resolveSeriesParentId(anchor);
  const family = await fetchSeriesRows(db, parentId);
  const eligible = family.filter((row) => !TERMINAL_STATUSES.has(String(row.status || '').toLowerCase()));
  if (!eligible.length) {
    const err = new Error('No eligible visits in this series to mark prepaid');
    err.status = 400;
    throw err;
  }
  const slices = splitTotalAcrossVisits(Number(totalAmount), eligible.length);
  const now = new Date();
  const updatedRows = [];
  const run = useExistingTransaction
    ? async (handler) => handler(db)
    : async (handler) => db.transaction(handler);
  await run(async (trx) => {
    for (let i = 0; i < eligible.length; i++) {
      const row = eligible[i];
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
      if (updated) updatedRows.push(updated);
    }
  });
  return {
    seriesParentId: parentId,
    visitsCovered: eligible.length,
    perVisitAmount: slices[0] ?? 0,
    seriesTotal: Number(totalAmount),
    updatedRows,
  };
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
  resolveSeriesParentId,
  fetchSeriesRows,
  splitTotalAcrossVisits,
  stampSeriesPrepaid,
  buildPrepaidSeriesContext,
  listCustomerPrepaidPlans,
};

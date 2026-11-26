/**
 * Production share on the pay run (PR 2 of the technician production share; Technician Terms v3, "Production share";
 * owner 2026-11-24). production-share.js works out the weekly credit and the share; this file is what the pay run
 * (payroll-runs.js) needs around it: who gets a line, what the check freezes, and how a changed credit makes a draft stale.
 *
 * The line (behind GATE_PAYROLL_PRODUCTION_SHARE, dark): a W-2 technician with approved hours in the run's week and
 * production share settings in force for that week (production_share_settings) gets a "Production share" earning equal to
 * shareForWeek(weekCredits).shareCents, on the Friday check for its OWN pay week. A technician with no settings in force
 * gets no line (the check keeps exactly its earlier keys). A technician with settings and a share of $0 gets the stored
 * figure 0 and the snapshot, so the stub can show the bar they did not pass.
 *
 * Taxes and overtime: the share is taxable wages (payroll-calc.js), and it is a nondiscretionary production bonus, so it is
 * in the federal regular rate FOR ITS OWN WEEK (29 CFR 778.208, 778.209: a bonus is allocated to the workweek it was
 * earned in). The extra overtime it causes is not worked out here: the check passes the share to the same function every
 * pay line uses (payroll-regular-rate.js lineOvertimePremium, through payroll-pay-lines.js priceLines), as one more line
 * dated to the run's week:
 *
 *   extra premium = 1/2 x (share / hours worked in the week) x overtime hours in the week
 *
 * The hourly pay already paid straight time for every hour, so only the half is owed on top. Worked example, a technician
 * at $20.00 an hour who works 45 hours and earns a $162.00 share: hourly pay is 40 x $20.00 + 5 x $30.00 = $950.00; the
 * regular rate of the share part is $162.00 / 45 h = $3.60; the half-time premium is 0.5 x $3.60 x 5 h = $9.00, so the
 * check adds $162.00 + $9.00 = $171.00 to the hourly pay. A week with no overtime pays no premium.
 *
 * What the check freezes (calc_snapshot.productionShare, with payroll_checks.production_share_cents): the credited
 * production, the bar, the amount above it, the rate, the bar type, the shifts and one row per stop { visitId, workDate,
 * kind, creditCents, needsReview, bases? }. No customer name, address or price detail is copied. A stop that needs review credits
 * $0 (production-share.js) and the draft says how many; it never blocks the run. The review token takes the share and a
 * signature of those rows, so a credit that changes after drafting makes the draft stale.
 *
 * Refunds (PR 3a; production-share-refunds.js): the code never measures a refund. It detects one and the owner sets the take-back.
 * A stop with a refund signal in its own week is $0 and needs review (kind refund_flagged). Every stop row also freezes refundSignals (the
 * signal ids at finalize, only when there are any). Later a signal not in that list, on a stop a final check paid, is listed in the
 * week's snapshot as takeBackToSet [{ checkId, visitId, workDate, paidWeekStart, creditCents, newSignals, reason, previousCents }] until the owner answers with
 * the TOTAL to take back for that stop. His answers move credit between weeks: the snapshot lists takeBacks [{ sourceCheckId, visitId,
 * workDate, paidWeekStart, cents, dependsOnRuns }] (signed: negative = credit given back) and refundTakeBackCents (their net), and
 * creditedCents is after them, never below $0; what does not fit stays owed for the next week. It is credit accounting for the technician
 * the source check paid: wages, hourly pay and every other line are never reduced, and a take-back still owed when the technician has no
 * later share week is never collected. refundSignals, takeBackToSet, takeBacks and the owner's answers are in the revision and the signature,
 * so an answer or a new refund between draft and finalize makes the draft stale. dependsOnRuns of a take-back names the run that paid the
 * credit and every run that holds an entry for that source, so voidRun refuses (dependentChecksOf) while a later final check relied on it.
 * A stop row of a paid stop also freezes refundInvoices (the invoice ids its refund signals were read from) and the snapshot freezes
 * refundAnswers (the owner's answers the week used, by revision): both are in the signature, so a changed answer makes the draft stale.
 * A take-back source is a stop row on a final check whose share was above $0 (the paidLedger rule): a $0-share week is none.
 */
const productionShare = require('./production-share');
const refunds = require('./production-share-refunds');
const { payrollProductionShareLive } = require('../config/feature-gates');

// GATE_PAYROLL_PRODUCTION_SHARE, read at call time. The typeof guard keeps a test mock of feature-gates that lacks the reader
// working (off).
const shareOn = () => typeof payrollProductionShareLive === 'function' && payrollProductionShareLive();

const KIND = 'production_share';

/** The frozen record of one technician's week: the figures and one row per stop. Plain JSON, ids and cents only. Pure. */
function snapshotOf({ weekStart, settings, result, stops, degraded = false, takeBacks = [], takeBackToSet = [], takeBackAnswers = [], outstandingTakeBackCents = null }) {
  return {
    weekStart,
    // Set when the credits came from the per-technician retry of a failed shared read: such a draft is never accepted by finalize.
    ...(degraded ? { degraded: true } : {}),
    settingsId: settings.id,
    fromWeek: settings.fromWeek,
    rateBps: settings.rateBps,
    barType: settings.barType,
    barPerUnitCents: settings.barCents,
    shifts: result.shifts,
    creditedCents: result.creditedCents,
    barCents: result.barCents,
    aboveBarCents: result.aboveBarCents,
    shareCents: result.shareCents,
    // Refund take-backs moved this week (signed), and the paid stops with a new refund the owner has not answered (see the header).
    ...(takeBacks.length ? {
      refundTakeBackCents: takeBacks.reduce((sum, one) => sum + one.cents, 0),
      // What is still owed after this week's take-backs, frozen so a reopened week shows it (an older snapshot has no such line).
      ...(outstandingTakeBackCents == null ? {} : { outstandingTakeBackCents }),
      takeBacks: takeBacks.map((one) => ({
        sourceCheckId: one.sourceCheckId, visitId: one.visitId, workDate: one.workDate || null, paidWeekStart: one.paidWeekStart, cents: one.cents,
        dependsOnRuns: [...(one.dependsOnRuns || [])].sort(),
      })),
    } : {}),
    // The owner's answers this week read (what he decided, by revision): a changed answer changes the review token even when the credit
    // moved stays the same.
    ...(takeBackAnswers.length ? {
      refundAnswers: takeBackAnswers.map((one) => ({ sourceCheckId: one.checkId, visitId: one.visitId, cents: one.cents, revision: one.revision })),
    } : {}),
    ...(takeBackToSet.length ? {
      takeBackToSet: takeBackToSet.map((one) => ({
        checkId: one.checkId, visitId: one.visitId, workDate: one.workDate || null, paidWeekStart: one.paidWeekStart, creditCents: one.creditCents,
        newSignals: [...one.newSignals].sort(), reason: one.reason, previousCents: one.previousCents == null ? null : one.previousCents,
      })),
    } : {}),
    stops: stops.map((stop) => ({
      visitId: stop.visitId, workDate: stop.workDate, kind: stop.kind, creditCents: stop.creditCents, needsReview: Boolean(stop.needsReview),
      // The refund signals at finalize: a later signal that is not here is a new refund on a paid stop.
      ...(stop.refundSignals && stop.refundSignals.length ? { refundSignals: [...stop.refundSignals].sort() } : {}),
      // The invoice ids those signals were read from, for a paid stop (the term's prepay invoice included), so a later refund is found even
      // when the visit is deleted or the invoice relinked.
      ...(stop.creditCents > 0 && stop.refundInvoices && stop.refundInvoices.length ? { refundInvoices: [...stop.refundInvoices].sort() } : {}),
      // What later weeks read from a paid stop (production-share.js, CREDIT RULES): the invoice ids linked to its visit, and for a
      // package visit its package { basisType: 'job', basisId, totalCents, sold, slot }.
      ...(stop.invoices && stop.invoices.length ? { invoices: stop.invoices } : {}),
      ...(stop.bases && stop.bases.length ? { bases: stop.bases } : {}),
      // The runs whose paid rows this credit was worked out against (voiding one of them is refused while this check is final).
      ...(stop.dependsOnRuns && stop.dependsOnRuns.length ? { dependsOnRuns: [...stop.dependsOnRuns].sort() } : {}),
    })),
  };
}

/**
 * The credit inputs of EVERY W-2 technician with settings in force for the pay week, read in ONE REPEATABLE READ, read-only
 * transaction: Map of technician id -> { settings, stops } (stops = the credit rows), or { error } for one that could not be
 * read. The credits of all of them are worked out TOGETHER (production-share.js weekCreditsFor: one stop list, one read of the invoices
 * and jobs, one ledger), by the same function the read under the payroll lock uses (collectInputs), so a draft and the finalize that
 * checks it always compute the same rows from the same data. One snapshot for the whole run, so a visit reassigned from one technician to another while the run reads is credited
 * to exactly one of them, never to both or neither, and a price edited between two technicians' reads cannot split them.
 * Empty with the gate off (nothing is read).
 *
 * The pay run calls this BEFORE its own transaction opens, as the season bonus scores are read (tech-rewards-pay-lines.js
 * readSeasonScores): the run then never holds the payroll lock while it waits for a second connection. `conn` is the pool.
 * Given a transaction (a caller with no earlier read) the isolation level cannot be raised after its first query, so the reads
 * run on it as they are; the pay run does not do that.
 */
async function readInputs(conn, weekStart) {
  if (!shareOn()) return new Map();
  return conn.transaction((trx) => collectInputs(trx, weekStart), { isolationLevel: 'repeatable read', readOnly: true });
}

/**
 * The same inputs as readInputs, read on the connection the pay run already holds UNDER THE PAYROLL LOCK (finalize), which is READ
 * COMMITTED and cannot open a second connection (the pool can be small, and a waiting payroll write would stall). Consistency
 * comes from the shape of the reads instead: the week's stops of ALL W-2 technicians with settings are listed in ONE statement
 * (production-share.js weekCreditsFor), so a stop reassigned after that statement is credited to whoever held it at that
 * statement, never to both and never to neither; the reads after it are keyed by visit. Each technician's reads are in a
 * savepoint, so a failed read marks that technician and does not abort the pay run's transaction.
 */
async function collectInputs(trx, weekStart, { retry = true, technicianIds = null } = {}) {
  const inputs = new Map();
  // `technicianIds` narrows the read to the technicians a run can pay a share to (the authoritative read under the lock). The facts
  // behind their stops (invoice members, weights, jobs) are read for any visit whatever the others' settings, so a split is the same.
  const only = technicianIds ? new Set(technicianIds.map(String)) : null;
  const ids = (await trx('technicians').where({ employment_type: 'w2' }).orderBy('id').pluck('id')).filter((id) => !only || only.has(String(id)));
  const settingsById = new Map();
  for (const id of ids) {
    try {
      await trx.transaction(async (sp) => {
        const settings = await productionShare.settingsFor(sp, id, weekStart);
        if (settings) settingsById.set(id, settings);
      });
    } catch (err) {
      inputs.set(id, { error: `The production share could not be worked out: ${(err && err.message) || 'unknown problem'}` });
    }
  }
  const credits = await productionShare.weekCreditsFor(trx, settingsById, weekStart, { retryPerTechnician: retry });
  for (const [id, one] of credits) {
    inputs.set(id, one.rows
      ? {
        settings: settingsById.get(id), stops: one.rows, takeBackOwed: one.takeBackOwed || [], takeBackToSet: one.takeBackToSet || [],
        takeBackAnswers: one.takeBackAnswers || [], ...(one.degraded ? { degraded: true } : {}),
      }
      : { error: `The production share could not be worked out: ${one.error}` });
  }
  return inputs;
}

const readInputsUnderLock = (trx, weekStart, technicianIds = null) => (shareOn()
  ? collectInputs(trx, weekStart, { retry: false, technicianIds })
  : Promise.resolve(new Map()));

/** The inputs of `technicianIds` only (a wider read narrowed to the technicians of one run). Pure. */
const restrictInputs = (inputs, technicianIds) => new Map([...inputs].filter(([id]) => technicianIds.map(String).includes(String(id))));

/**
 * A revision of what readInputs returned: the same string for the same settings and the same credit rows (visit, date, kind,
 * credit, review mark), whatever the order. The pay run's finalize reads the inputs again under the payroll lock and compares
 * revisions, so credits that changed between its first read and the lock are never frozen onto a check. Pure.
 */
// What a stop records for the rules in production-share.js, in a fixed order: its package basis [[type, id, total, sold, slot]] and the
// invoice ids linked to its visit. The review token and the revision both take it, so a link or a package slot that changes after
// drafting makes the draft stale even when the credits do not move.
function basesSignature(bases, invoices) {
  return [
    (Array.isArray(bases) ? bases : []).map((one) => [one.basisType, one.basisId, one.totalCents == null ? null : Number(one.totalCents), one.sold == null ? null : Number(one.sold), Number(one.slot)])
      .sort((a, b) => (`${a[0]}:${a[1]}` < `${b[0]}:${b[1]}` ? -1 : 1)),
    (Array.isArray(invoices) ? [...invoices].map(String).sort() : []),
  ];
}

// What the refund ledger gives a week, in a fixed order: the paid stops to ask about, the take-backs the week moves, the owner's answers
// (id, total, signals, when set) and a stop's own signals. The revision and the signature both take it.
const sortedJson = (rows) => rows.map((one) => JSON.stringify(one)).sort();
const takeBackSignature = (takeBacks, toSet, answers = []) => [
  sortedJson((takeBacks || []).map((one) => [one.sourceCheckId || null, one.visitId, one.paidWeekStart, one.workDate || null, Number(one.cents), [...(one.dependsOnRuns || [])].sort()])),
  sortedJson((toSet || []).map((one) => [one.checkId, one.visitId, one.paidWeekStart, Number(one.creditCents), [...one.newSignals].sort(), one.reason || null, one.previousCents == null ? null : Number(one.previousCents)])),
  sortedJson(answers.map((one) => [one.sourceCheckId, one.visitId, Number(one.cents), one.revision])),
];
// A stop's refund signals and, for a paid stop (credit above $0), the sorted invoice ids they were read from: both are frozen with the check.
const stopRefundSignature = (stop) => [[...(stop.refundSignals || [])].sort(), Number(stop.creditCents) > 0 ? [...(stop.refundInvoices || [])].sort() : []];

function revisionOf(inputs) {
  const rows = [...inputs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([id, input]) => {
    if (input.error) return [id, 'error', input.error];
    const { settings } = input;
    const stops = input.stops.map((stop) => [stop.visitId, stop.workDate, stop.kind, Number(stop.creditCents), stop.needsReview === true, basesSignature(stop.bases, stop.invoices), [...(stop.dependsOnRuns || [])].sort(), stopRefundSignature(stop)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const moved = takeBackSignature(refunds.applyTakeBacks(input.stops, input.takeBackOwed || []).takeBacks, input.takeBackToSet,
      (input.takeBackAnswers || []).map((one) => ({ sourceCheckId: one.checkId, visitId: one.visitId, cents: one.cents, revision: one.revision })));
    return [id, settings.id, settings.rateBps, settings.barType, settings.barCents, settings.callbackStopValueCents, stops, input.degraded === true, moved];
  });
  return JSON.stringify(rows);
}

/**
 * The shares of the technicians in `technicianIds` for the pay week `weekStart`, from the inputs readInputs returned: Map of
 * technician id -> { shareCents, snapshot } for each one with settings in force, or { error } when the share could not be
 * worked out (the pay run lists that technician as blocked, in these words). A technician with no settings has no entry.
 * Pure: reads nothing, so every share of a run comes from the one snapshot.
 */
function sharesFor(inputs, technicianIds, weekStart) {
  const shares = new Map();
  for (const id of technicianIds) {
    const input = inputs.get(id);
    if (!input) continue;
    if (input.error) { shares.set(id, { error: input.error }); continue; }
    try {
      const { settings, stops } = input;
      // A take-back the owner set for a refund on a paid stop comes off this week's credited production, never below $0.
      const applied = refunds.applyTakeBacks(stops, input.takeBackOwed || []);
      const result = productionShare.shareForWeek({ credits: [applied.creditedCents], shifts: productionShare.shiftDays(stops).length, settings });
      shares.set(id, {
        shareCents: result.shareCents,
        snapshot: snapshotOf({ weekStart, settings, result, stops, degraded: input.degraded === true, takeBacks: applied.takeBacks, takeBackToSet: input.takeBackToSet || [], takeBackAnswers: input.takeBackAnswers || [], outstandingTakeBackCents: applied.outstandingCents }),
      });
    } catch (err) {
      shares.set(id, { error: `The production share could not be worked out: ${(err && err.message) || 'unknown problem'}` });
    }
  }
  return shares;
}

/**
 * The finalized checks (of ANY technician) whose credits were worked out against a paid row of the run `runId`, or whose refund
 * take-backs relied on it (takeBacks[].dependsOnRuns): { employeeName, weekStart }.
 * Voiding that run would change those credits after they were paid, so voidRun refuses while there are any.
 */
async function dependentChecksOf(trx, runId) {
  const { rows } = await trx.raw(`SELECT DISTINCT c.employee_name, to_char(c.week_start, 'YYYY-MM-DD') AS week_start
    FROM payroll_checks c
    JOIN payroll_runs r ON r.id = c.run_id
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.calc_snapshot->'productionShare'->'stops') = 'array'
      THEN c.calc_snapshot->'productionShare'->'stops' ELSE '[]'::jsonb END) AS stop(value)
    WHERE c.status = 'finalized' AND r.status = 'finalized' AND c.run_id <> ?::uuid
      AND jsonb_typeof(stop.value->'dependsOnRuns') = 'array' AND jsonb_exists(stop.value->'dependsOnRuns', ?::text)
    UNION
    SELECT c.employee_name, to_char(c.week_start, 'YYYY-MM-DD') AS week_start
    FROM payroll_checks c
    JOIN payroll_runs r ON r.id = c.run_id
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.calc_snapshot->'productionShare'->'takeBacks') = 'array'
      THEN c.calc_snapshot->'productionShare'->'takeBacks' ELSE '[]'::jsonb END) AS tb(value)
    WHERE c.status = 'finalized' AND r.status = 'finalized' AND c.run_id <> ?::uuid
      AND jsonb_typeof(tb.value->'dependsOnRuns') = 'array' AND jsonb_exists(tb.value->'dependsOnRuns', ?::text)
    ORDER BY week_start, employee_name`, [runId, String(runId), runId, String(runId)]);
  return rows.map((row) => ({ employeeName: row.employee_name, weekStart: row.week_start }));
}

/** The pay line the share is priced as in payroll-regular-rate.js: one line in the check's own week. */
const priceableLine = (weekStart, shareCents) => ({
  kind: KIND, amountCents: shareCents, earnedWeekStart: weekStart, coversFrom: null, coversTo: null,
});

// The snapshot of a check row: a stored row carries it as `production_share` (calc_snapshot->'productionShare'); a row about
// to be stored carries it in its calc_snapshot text.
function snapshotOfRow(row) {
  let snapshot = row.production_share;
  if (!('production_share' in row) && typeof row.calc_snapshot === 'string') {
    try { snapshot = JSON.parse(row.calc_snapshot).productionShare; } catch { snapshot = null; }
  }
  return snapshot && typeof snapshot === 'object' ? snapshot : null;
}

/**
 * What the review token takes from a check's share: the figures and every stop's credit, sorted, so a credit that changes
 * after drafting (a price, a callback test, a stop completed late) changes the token. Pure.
 */
function signature(row) {
  const snapshot = snapshotOfRow(row) || {};
  const stops = (Array.isArray(snapshot.stops) ? snapshot.stops : [])
    .map((stop) => [stop.visitId, stop.workDate, stop.kind, Number(stop.creditCents), stop.needsReview === true, basesSignature(stop.bases, stop.invoices), [...(stop.dependsOnRuns || [])].sort(), stopRefundSignature(stop)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return [
    snapshot.settingsId == null ? null : Number(snapshot.settingsId),
    Number(snapshot.rateBps), snapshot.barType, Number(snapshot.barPerUnitCents), Number(snapshot.shifts),
    Number(snapshot.creditedCents), Number(snapshot.barCents), Number(snapshot.aboveBarCents), Number(snapshot.shareCents),
    stops,
    snapshot.degraded === true,
    takeBackSignature(snapshot.takeBacks, snapshot.takeBackToSet, snapshot.refundAnswers),
  ];
}

/**
 * What a check shows of its share: the figures a technician reads on the stub (no stop rows), and the stops that need review
 * (id and date only), so the owner can find them before he finalizes. {} for a check with no share figure. Pure.
 */
function viewOf(row) {
  if (row.production_share_cents == null) return {};
  const snapshot = snapshotOfRow(row) || {};
  const review = (Array.isArray(snapshot.stops) ? snapshot.stops : []).filter((stop) => stop.needsReview === true);
  // A 0-cent take-back only keeps a dependency (it moves nothing), so it is not counted.
  const moved = (Array.isArray(snapshot.takeBacks) ? snapshot.takeBacks : []).filter((one) => Number(one.cents) !== 0);
  const toSet = Array.isArray(snapshot.takeBackToSet) ? snapshot.takeBackToSet : [];
  return {
    productionShareCents: Number(row.production_share_cents),
    productionShare: {
      creditedCents: Number(snapshot.creditedCents || 0),
      barCents: Number(snapshot.barCents || 0),
      aboveBarCents: Number(snapshot.aboveBarCents || 0),
      rateBps: Number(snapshot.rateBps || 0),
      barType: snapshot.barType || null,
      shifts: Number(snapshot.shifts || 0),
      stopCount: Array.isArray(snapshot.stops) ? snapshot.stops.length : 0,
      needsReviewCount: review.length,
      // Refund take-backs this week moved (the net cents, negative = credit given back), and paid stops with a refund the owner has not answered.
      ...(moved.length ? { refundTakeBackCents: Number(snapshot.refundTakeBackCents || 0), takeBackCount: moved.length } : {}),
      ...(toSet.length ? { takeBackToSetCount: toSet.length } : {}),
      ...(review.length ? { needsReview: review.map((stop) => ({ visitId: stop.visitId, workDate: stop.workDate })) } : {}),
    },
  };
}

/** The plain note a draft shows for a check with stops that need review, or null. */
function reviewNote(name, count) {
  if (!(count > 0)) return null;
  return `${name}: ${count} ${count === 1 ? 'stop needs' : 'stops need'} review for the production share. ${count === 1 ? 'It pays' : 'They pay'} $0 in the share until fixed. Open the production share preview for the week, fix ${count === 1 ? 'it' : 'them'}, then recompute.`;
}

/** The plain note a draft shows for paid stops with a refund the owner has not answered, or null. */
function takeBackNote(name, count) {
  if (!(count > 0)) return null;
  return `${name}: ${count} paid ${count === 1 ? 'stop has' : 'stops have'} a new or changed refund. Open the production share preview for the week and set the take-back for ${count === 1 ? 'it' : 'each'}, then recompute.`;
}

/** Raises the refund bells for the flags a draft or a preview read (production-share-refund-alerts.js). Never throws. */
async function alertRefundFlags(inputs) {
  const { raiseRefundFlagAlerts } = require('./production-share-refund-alerts');
  for (const [technicianId, input] of inputs || []) {
    if (input && input.stops) await raiseRefundFlagAlerts({ technicianId, stops: input.stops, takeBackToSet: input.takeBackToSet || [] });
  }
}

module.exports = { KIND, shareOn, readInputs, readInputsUnderLock, restrictInputs, dependentChecksOf, revisionOf, sharesFor, priceableLine, signature, viewOf, reviewNote, takeBackNote, alertRefundFlags, snapshotOf };

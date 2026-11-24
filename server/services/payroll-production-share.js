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
 */
const productionShare = require('./production-share');
const { payrollProductionShareLive } = require('../config/feature-gates');

// GATE_PAYROLL_PRODUCTION_SHARE, read at call time. The typeof guard keeps a test mock of feature-gates that lacks the reader
// working (off).
const shareOn = () => typeof payrollProductionShareLive === 'function' && payrollProductionShareLive();

const KIND = 'production_share';

/** The frozen record of one technician's week: the figures and one row per stop. Plain JSON, ids and cents only. Pure. */
function snapshotOf({ weekStart, settings, result, stops }) {
  return {
    weekStart,
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
    stops: stops.map((stop) => ({
      visitId: stop.visitId, workDate: stop.workDate, kind: stop.kind, creditCents: stop.creditCents, needsReview: Boolean(stop.needsReview),
      // What this credit drew from each basis (a shared invoice or a multi-visit job): [{ basisType, basisId, cents }]. Every later
      // week reads the paid cents of a basis from these rows (production-share.js, the credit ledger).
      ...(stop.bases && stop.bases.length ? { bases: stop.bases } : {}),
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
async function collectInputs(trx, weekStart) {
  const inputs = new Map();
  const ids = await trx('technicians').where({ employment_type: 'w2' }).orderBy('id').pluck('id');
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
  const credits = await productionShare.weekCreditsFor(trx, settingsById, weekStart);
  for (const [id, one] of credits) {
    inputs.set(id, one.rows
      ? { settings: settingsById.get(id), stops: one.rows }
      : { error: `The production share could not be worked out: ${one.error}` });
  }
  return inputs;
}

const readInputsUnderLock = (trx, weekStart) => (shareOn() ? collectInputs(trx, weekStart) : Promise.resolve(new Map()));

/**
 * A revision of what readInputs returned: the same string for the same settings and the same credit rows (visit, date, kind,
 * credit, review mark), whatever the order. The pay run's finalize reads the inputs again under the payroll lock and compares
 * revisions, so credits that changed between its first read and the lock are never frozen onto a check. Pure.
 */
// The credit bases a stop drew from, in a fixed order: [[type, id, cents], ...] (the credit ledger, production-share.js). The review token
// and the revision both take it, so a basis that changes after drafting makes the draft stale even when the credits do not move.
function basesSignature(bases) {
  return (Array.isArray(bases) ? bases : []).map((one) => [one.basisType, one.basisId, Number(one.cents)])
    .sort((a, b) => (`${a[0]}:${a[1]}` < `${b[0]}:${b[1]}` ? -1 : 1));
}

function revisionOf(inputs) {
  const rows = [...inputs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([id, input]) => {
    if (input.error) return [id, 'error', input.error];
    const { settings } = input;
    const stops = input.stops.map((stop) => [stop.visitId, stop.workDate, stop.kind, Number(stop.creditCents), stop.needsReview === true, basesSignature(stop.bases)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return [id, settings.id, settings.rateBps, settings.barType, settings.barCents, settings.callbackStopValueCents, stops];
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
      const result = productionShare.shareForWeek({ credits: stops, shifts: productionShare.shiftDays(stops).length, settings });
      shares.set(id, { shareCents: result.shareCents, snapshot: snapshotOf({ weekStart, settings, result, stops }) });
    } catch (err) {
      shares.set(id, { error: `The production share could not be worked out: ${(err && err.message) || 'unknown problem'}` });
    }
  }
  return shares;
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
    .map((stop) => [stop.visitId, stop.workDate, stop.kind, Number(stop.creditCents), stop.needsReview === true, basesSignature(stop.bases)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return [
    snapshot.settingsId == null ? null : Number(snapshot.settingsId),
    Number(snapshot.rateBps), snapshot.barType, Number(snapshot.barPerUnitCents), Number(snapshot.shifts),
    Number(snapshot.creditedCents), Number(snapshot.barCents), Number(snapshot.aboveBarCents), Number(snapshot.shareCents),
    stops,
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
      ...(review.length ? { needsReview: review.map((stop) => ({ visitId: stop.visitId, workDate: stop.workDate })) } : {}),
    },
  };
}

/** The plain note a draft shows for a check with stops that need review, or null. */
function reviewNote(name, count) {
  if (!(count > 0)) return null;
  return `${name}: ${count} ${count === 1 ? 'stop needs' : 'stops need'} review for the production share. ${count === 1 ? 'It pays' : 'They pay'} $0 in the share until fixed. Open the production share preview for the week, fix ${count === 1 ? 'it' : 'them'}, then recompute.`;
}

module.exports = { KIND, shareOn, readInputs, readInputsUnderLock, revisionOf, sharesFor, priceableLine, signature, viewOf, reviewNote, snapshotOf };

/**
 * Production share, PR 3a: refunds. THE CODE NEVER MEASURES A REFUND (owner ruling 2026-11-25, "A"): a first attempt did the refund math
 * (fractions, charged totals, allocation across a shared invoice) and could not be made right for every payment-record shape. Here the
 * code only DETECTS a refund and ASKS the owner; the owner says how much credit the technician's share takes back.
 *
 * 1. Signals. refundSignalsOf lists, for each visit, the ids of every sign of a refund on the invoices linked to it (see below). It
 *    over-detects on purpose: a false signal costs the owner one tap, a missed refund costs a wrong paycheck.
 * 2. Own week. A stop with a signal in the week it is credited is $0, needs review and says so (production-share.js applyLedger, kind
 *    'refund_flagged'). The owner sets its credit with the stop credit he already has (stop override); the signal ids ride in that
 *    override's conflict tuples, so an override set before a new signal is no longer used.
 * 3. Paid week. A finalized check freezes the signals of each paid stop (stops[].refundSignals). Later, a signal that is not in that
 *    list is a NEW refund on a paid stop: the stop is listed (takeBackToSet) until the owner answers with a TOTAL to take back for it
 *    (production_share_refund_take_backs, 0 up to the credit the check paid). An answer covers the signals it names; a later signal
 *    outside them lists the stop again.
 * 4. Ledger. For each answered source (check id, visit id): moved = the owner's total minus the sum of the takeBacks entries finalized
 *    checks already hold for that same source. A positive amount comes off the week's credited production (oldest paid week first), never
 *    below $0: what does not fit stays owed and is moved next week. A negative amount (the owner lowered or cleared the total) adds credit
 *    back. It is credit accounting only: the take-back is charged to the technician the source check paid, never to wages, hourly pay or
 *    any other line, and a take-back still owed when the technician has no later share week is never collected.
 *    dependsOnRuns of an entry = the run of the source check and every run that holds an entry for that source, so voiding any of them is
 *    refused while a later final check relied on it (payroll-production-share.js dependentChecksOf). A source with any finalized history
 *    keeps a 0-cent entry each week so that dependency is not lost.
 *
 * Signal sources (all read-only; one statement for a batch of visits). Invoices linked to a visit by the links the credit uses
 * (rate-review.js VISIT_INVOICE_LINK_SQL: direct, service record, first application, completion packet), for the visit and every visit of
 * its package (included follow-ups, both directions), plus, for a visit stamped as an annual prepay payment (the stamp, not the term link,
 * says so: production-share.js isAnnualPrepayStamp), the prepay invoice of its term and the invoices stamped to the term:
 *   pay:<payment id>:<refunded cents>        payments.refund_amount > 0 matched by metadata.invoice_id, OR payment intent, OR charge id
 *                                            (any of them; a combined charge flags every invoice it paid). The cents are in the id so a
 *                                            second refund on the same payment row is a new signal.
 *   stmt:<payment id>:<refunded cents>       a refund on a payer-statement payment (payments.statement_id) whose statement covers the invoice
 *   orphan:<stripe_orphan_charges id>        a parked or unattributed refund (stripe-webhook.js parks partial refunds on combined and
 *                                            statement charges there) for the invoice, its payment intent or its charge
 *   credit:<customer_credit_ledger id>       account credit returned on the invoice by a refund
 *   inv-refunded:<invoice id>                the invoice status is 'refunded'
 * Same gate as the share: GATE_PAYROLL_PRODUCTION_SHARE. No new gate.
 */
const Joi = require('joi');
const crypto = require('node:crypto');
const db = require('../models/db');
const { PayrollError } = require('./payroll-w4');
const { ANNUAL_PREPAY_PREPAID_METHOD } = require('./billing-lane');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CENTS = 100000000;
const PACKAGE_DEPTH = 12;
const canonicalId = (id) => (id == null ? id : String(id).toLowerCase());

// ---------------------------------------------------------------- signals

/**
 * The refund signals of a batch of visits: Map visit id (lowercase) -> sorted array of signal ids ([] when none). Read-only.
 */
async function refundSignalsOf(conn, visitIds) {
  const ids = [...new Set((visitIds || []).filter(Boolean).map(canonicalId))];
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const { VISIT_INVOICE_LINK_SQL } = require('./rate-review');
  const { rows } = await conn.raw(`
    WITH RECURSIVE grp(origin, id, depth) AS (
      SELECT s.id, s.id, 0 FROM scheduled_services s WHERE s.id = ANY(?::uuid[])
      UNION
      SELECT g.origin, n.id, g.depth + 1
      FROM grp g
      JOIN scheduled_services cur ON cur.id = g.id
      JOIN scheduled_services n ON (n.followup_source_service_id = cur.id AND n.followup_included)
        OR (cur.followup_included AND n.id = cur.followup_source_service_id)
      WHERE g.depth < ?
    ), members AS (
      SELECT DISTINCT origin, id FROM grp
    ), linked AS (
      SELECT m.origin, i.id AS invoice_id
      FROM members m
      JOIN scheduled_services s ON s.id = m.id
      LEFT JOIN (SELECT r.scheduled_service_id, r.id AS service_record_id FROM service_records r
        WHERE r.scheduled_service_id IN (SELECT id FROM members)) sr ON sr.scheduled_service_id = s.id
      JOIN invoices i ON ${VISIT_INVOICE_LINK_SQL}
      UNION
      SELECT m.origin, t.prepay_invoice_id
      FROM members m
      JOIN scheduled_services s ON s.id = m.id AND s.prepaid_method = ? AND s.prepaid_amount > 0
      JOIN annual_prepay_terms t ON t.id = s.annual_prepay_term_id
      WHERE t.prepay_invoice_id IS NOT NULL
      UNION
      SELECT m.origin, i.id
      FROM members m
      JOIN scheduled_services s ON s.id = m.id AND s.prepaid_method = ? AND s.prepaid_amount > 0
      JOIN invoices i ON i.annual_prepay_term_id = s.annual_prepay_term_id
      WHERE s.annual_prepay_term_id IS NOT NULL
    ), invs AS (
      SELECT DISTINCT origin, invoice_id FROM linked
    ), keys AS (
      SELECT i.id AS invoice_id, i.stripe_payment_intent_id AS pi, i.stripe_charge_id AS ch
      FROM invoices AS i WHERE i.id IN (SELECT invoice_id FROM invs)
      UNION
      SELECT i.id, p.stripe_payment_intent_id, p.stripe_charge_id
      FROM invoices AS i JOIN payments p ON p.metadata ->> 'invoice_id' = i.id::text
      WHERE i.id IN (SELECT invoice_id FROM invs)
      UNION
      SELECT i.id, ps.stripe_payment_intent_id, NULL
      FROM invoices AS i JOIN payer_statements ps ON ps.id = i.payer_statement_id
      WHERE i.id IN (SELECT invoice_id FROM invs)
      UNION
      SELECT i.id, p.stripe_payment_intent_id, p.stripe_charge_id
      FROM invoices AS i JOIN payments p ON p.statement_id = i.payer_statement_id
      WHERE i.payer_statement_id IS NOT NULL AND i.id IN (SELECT invoice_id FROM invs)
    ), found AS (
      SELECT v.origin, 'pay:' || p.id::text || ':' || round(p.refund_amount * 100)::bigint::text AS signal
      FROM invs v
      JOIN payments p ON COALESCE(p.refund_amount, 0) > 0 AND (
        p.metadata ->> 'invoice_id' = v.invoice_id::text
        OR (p.stripe_payment_intent_id IS NOT NULL AND p.stripe_payment_intent_id IN (SELECT k.pi FROM keys k WHERE k.invoice_id = v.invoice_id))
        OR (p.stripe_charge_id IS NOT NULL AND p.stripe_charge_id IN (SELECT k.ch FROM keys k WHERE k.invoice_id = v.invoice_id)))
      UNION
      SELECT v.origin, 'stmt:' || p.id::text || ':' || round(p.refund_amount * 100)::bigint::text
      FROM invs v
      JOIN invoices i ON i.id = v.invoice_id AND i.payer_statement_id IS NOT NULL
      JOIN payments p ON p.statement_id = i.payer_statement_id AND COALESCE(p.refund_amount, 0) > 0
      UNION
      SELECT v.origin, 'orphan:' || o.id::text
      FROM invs v
      JOIN stripe_orphan_charges o ON (o.invoice_id = v.invoice_id
        OR (o.stripe_charge_id IS NOT NULL AND o.stripe_charge_id IN (SELECT k.ch FROM keys k WHERE k.invoice_id = v.invoice_id))
        OR split_part(o.stripe_payment_intent_id, ':', 1) IN (SELECT k.pi FROM keys k WHERE k.invoice_id = v.invoice_id))
      WHERE o.original_db_error ILIKE '%refund%' OR o.stripe_payment_intent_id LIKE '%:partial-refund:%'
      UNION
      SELECT v.origin, 'credit:' || l.id::text
      FROM invs v
      JOIN customer_credit_ledger l ON l.invoice_id = v.invoice_id AND l.delta > 0
        AND (l.note ILIKE '%refund%' OR l.note ILIKE '%returned%')
      UNION
      SELECT v.origin, 'inv-refunded:' || i.id::text
      FROM invs v JOIN invoices i ON i.id = v.invoice_id WHERE i.status = 'refunded'
    )
    SELECT origin::text AS visit_id, signal FROM found`, [ids, PACKAGE_DEPTH, ANNUAL_PREPAY_PREPAID_METHOD, ANNUAL_PREPAY_PREPAID_METHOD]);
  for (const row of rows) out.get(canonicalId(row.visit_id)).push(row.signal);
  for (const [id, list] of out) out.set(id, [...new Set(list)].sort());
  return out;
}

// ---------------------------------------------------------------- the paid week: what to ask, what was answered, what moves

const STOPS_OF_CHECK_SQL = `CASE WHEN jsonb_typeof(c.calc_snapshot->'productionShare'->'stops') = 'array'
      THEN c.calc_snapshot->'productionShare'->'stops' ELSE '[]'::jsonb END`;
const TAKE_BACKS_OF_CHECK_SQL = `CASE WHEN jsonb_typeof(c.calc_snapshot->'productionShare'->'takeBacks') = 'array'
      THEN c.calc_snapshot->'productionShare'->'takeBacks' ELSE '[]'::jsonb END`;

const sourceKey = (checkId, visitId) => `${canonicalId(checkId)}:${canonicalId(visitId)}`;

// The stop rows of finalized checks of finalized runs, for these technicians, in weeks before `weekStart`, that paid a credit above $0.
async function paidStopsOf(conn, technicianIds, weekStart) {
  return (await conn.raw(`SELECT c.id AS check_id, r.id AS run_id, c.technician_id, to_char(c.week_start, 'YYYY-MM-DD') AS week_start,
      stop.value->>'visitId' AS visit_id, stop.value->>'workDate' AS work_date, (stop.value->>'creditCents')::bigint AS credit_cents,
      CASE WHEN jsonb_typeof(stop.value->'refundSignals') = 'array' THEN stop.value->'refundSignals' ELSE '[]'::jsonb END AS frozen
    FROM payroll_checks c
    JOIN payroll_runs r ON r.id = c.run_id
    CROSS JOIN LATERAL jsonb_array_elements(${STOPS_OF_CHECK_SQL}) AS stop(value)
    WHERE c.status = 'finalized' AND r.status = 'finalized' AND c.technician_id = ANY(?::uuid[]) AND c.week_start < ?::date
      AND COALESCE((stop.value->>'creditCents')::bigint, 0) > 0
    ORDER BY c.week_start, c.id, stop.value->>'visitId'`, [technicianIds, weekStart])).rows;
}

// The owner's answers for finalized checks of these technicians before `weekStart`: Map source key -> answer.
async function answersOf(conn, technicianIds, weekStart) {
  const rows = await conn('production_share_refund_take_backs as b')
    .join('payroll_checks as c', 'c.id', 'b.source_check_id')
    .join('payroll_runs as r', 'r.id', 'c.run_id')
    .where({ 'c.status': 'finalized', 'r.status': 'finalized' })
    .whereIn('c.technician_id', technicianIds).where('c.week_start', '<', weekStart)
    .select('b.id', 'b.source_check_id', 'b.visit_id', 'b.signals', 'b.cents', 'b.note', 'b.updated_at');
  return new Map(rows.map((row) => [sourceKey(row.source_check_id, row.visit_id), {
    id: Number(row.id), sourceCheckId: canonicalId(row.source_check_id), visitId: canonicalId(row.visit_id),
    signals: [...(Array.isArray(row.signals) ? row.signals : [])].map(String).sort(), cents: Number(row.cents), note: row.note || null,
    updatedAt: new Date(row.updated_at).toISOString(),
  }]));
}

// What finalized checks (other than the week being read) already moved for each source, signed: Map source key -> { cents, runs }.
async function takenBackOf(conn, visitIds, weekStart) {
  const taken = new Map();
  if (!visitIds.length) return taken;
  const rows = (await conn.raw(`SELECT r.id AS run_id, tb.value->>'sourceCheckId' AS source_check_id, tb.value->>'visitId' AS visit_id,
      (tb.value->>'cents')::bigint AS cents
    FROM payroll_checks c
    JOIN payroll_runs r ON r.id = c.run_id
    CROSS JOIN LATERAL jsonb_array_elements(${TAKE_BACKS_OF_CHECK_SQL}) AS tb(value)
    WHERE c.status = 'finalized' AND r.status = 'finalized' AND c.week_start <> ?::date AND tb.value->>'visitId' = ANY(?::text[])`,
  [weekStart, visitIds])).rows;
  for (const row of rows) {
    const key = sourceKey(row.source_check_id, row.visit_id);
    const one = taken.get(key) || { cents: 0, runs: new Set() };
    one.cents += Number(row.cents);
    one.runs.add(row.run_id); // every run that holds an entry for this source, whatever its sign or size
    taken.set(key, one);
  }
  return taken;
}

const byWeekVisit = (a, b) => {
  const [x, y] = [a, b].map((one) => `${one.paidWeekStart}|${one.visitId}|${one.sourceCheckId || ''}`);
  return x < y ? -1 : (x > y ? 1 : 0);
};

/**
 * What the paid weeks ask of a week and what the owner answered, per technician (the one the CHECK paid, whoever holds the visit now):
 * Map id -> { owed, toSet, answers }.
 *   toSet:   [{ checkId, visitId, workDate, paidWeekStart, creditCents, newSignals }] paid stops with a refund signal the check did not
 *            freeze and no answer covers.
 *   answers: [{ checkId, visitId, workDate, paidWeekStart, creditCents, cents, note, signals, newSignals, id, updatedAt }] the owner's answers.
 *   owed:    [{ visitId, sourceCheckId, paidWeekStart, workDate, cents, dependsOnRuns }] (signed) what the week moves: the answer minus
 *            what finalized checks already took for that source; a 0 entry for a source with finalized history, to keep its dependency.
 * Only checks of weeks BEFORE `weekStart` are read, and a check of `weekStart` itself is ignored as everywhere in the ledger.
 */
async function refundLedgerOf(conn, technicianIds, weekStart) {
  const out = new Map(technicianIds.map((id) => [id, { owed: [], toSet: [], answers: [] }]));
  if (!technicianIds.length) return out;
  const paid = await paidStopsOf(conn, technicianIds, weekStart);
  if (!paid.length) return out;
  const visitIds = [...new Set(paid.map((row) => canonicalId(row.visit_id)))];
  const [signals, answers, taken] = await Promise.all([
    refundSignalsOf(conn, visitIds), answersOf(conn, technicianIds, weekStart), takenBackOf(conn, visitIds, weekStart),
  ]);
  for (const row of paid) {
    const mine = out.get(canonicalId(row.technician_id));
    if (!mine) continue;
    const key = sourceKey(row.check_id, row.visit_id);
    const answer = answers.get(key);
    const history = taken.get(key);
    const frozen = new Set(row.frozen);
    const newSignals = (signals.get(canonicalId(row.visit_id)) || []).filter((id) => !frozen.has(id));
    const where = { checkId: canonicalId(row.check_id), visitId: canonicalId(row.visit_id), workDate: row.work_date || null, paidWeekStart: row.week_start, creditCents: Number(row.credit_cents) };
    if (newSignals.length && !(answer && newSignals.every((id) => answer.signals.includes(id)))) mine.toSet.push({ ...where, newSignals });
    if (answer) mine.answers.push({ ...where, id: answer.id, cents: answer.cents, note: answer.note, signals: answer.signals, newSignals, updatedAt: answer.updatedAt });
    if (answer || history) {
      const delta = (answer ? answer.cents : 0) - (history ? history.cents : 0);
      // ONE RULE for dependencies: a source with any finalized history is evaluated every week; its entry (0 cents when nothing moves)
      // carries the run of the source check and every run that holds an entry for it.
      if (delta !== 0 || (history && history.runs.size)) {
        mine.owed.push({
          visitId: where.visitId, sourceCheckId: where.checkId, paidWeekStart: row.week_start, workDate: where.workDate, cents: delta,
          dependsOnRuns: [...new Set([row.run_id, ...(history ? history.runs : [])])].sort(),
        });
      }
    }
  }
  return out;
}

/**
 * The take-backs a week's production takes now, and the credit it gets back. `stops` = the week's credit rows, `owed` = the ledger's
 * owed list for the technician (signed). Credit given back (a negative entry) is added first; take-backs then come off the credited
 * production, oldest paid week first, never below $0: what does not fit is a 0 entry, so it is still owed next week. Returns
 * { takeBacks: [{ visitId, sourceCheckId, paidWeekStart, workDate, cents, dependsOnRuns }] (cents signed), refundTakeBackCents (the net),
 * creditedCents } with creditedCents after them. Pure.
 */
function applyTakeBacks(stops, owed = []) {
  let room = stops.reduce((sum, stop) => sum + Number(stop.creditCents), 0);
  const order = [...owed].sort(byWeekVisit);
  const entry = (one, cents) => ({
    visitId: one.visitId, sourceCheckId: one.sourceCheckId || null, paidWeekStart: one.paidWeekStart, workDate: one.workDate || null, cents,
    dependsOnRuns: [...(one.dependsOnRuns || [])].sort(),
  });
  const kept = [];
  for (const one of order.filter((each) => Number(each.cents) <= 0)) { room -= Number(one.cents); kept.push(entry(one, Number(one.cents))); }
  for (const one of order.filter((each) => Number(each.cents) > 0)) {
    const cents = Math.min(room, Number(one.cents));
    room -= cents;
    kept.push(entry(one, cents));
  }
  const takeBacks = kept.sort(byWeekVisit);
  return { takeBacks, refundTakeBackCents: takeBacks.reduce((sum, one) => sum + one.cents, 0), creditedCents: room };
}

// ---------------------------------------------------------------- the owner's answer

const answerSchema = Joi.object({
  checkId: Joi.string().pattern(UUID_RE).required().error(new Error('Choose a paid stop')),
  visitId: Joi.string().pattern(UUID_RE).required().error(new Error('Choose a paid stop')),
  cents: Joi.number().integer().min(0).max(MAX_CENTS).required().error(new Error('Enter the amount to take back as whole cents, $0 or more')),
  // The refund signals the page was showing for this stop: refused (409) when they changed since.
  signals: Joi.array().items(Joi.string().max(200)).max(200).required().error(new Error('Reload the week: the refunds on the stop must be sent')),
  note: Joi.string().trim().max(500).allow('', null).error(new Error('The note is up to 500 characters')),
});
const answerKeySchema = answerSchema.fork(['cents', 'signals', 'note'], (field) => field.optional());

function validated(schema, input) {
  const { value, error } = schema.validate(input || {}, { abortEarly: true, convert: true, allowUnknown: false });
  if (error) throw new PayrollError(400, error.details ? error.details[0].message : error.message);
  return value;
}

// The finalized check that paid the stop, and the stop's frozen row. Throws the plain refusal when it is not one.
async function paidStopOf(trx, checkId, visitId) {
  const check = await trx('payroll_checks as c').join('payroll_runs as r', 'r.id', 'c.run_id').where({ 'c.id': checkId })
    .first('c.id', 'c.status', 'r.status as run_status', trx.raw(`(SELECT s.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.calc_snapshot->'productionShare'->'stops') = 'array'
      THEN c.calc_snapshot->'productionShare'->'stops' ELSE '[]'::jsonb END) s(value) WHERE s.value->>'visitId' = ?) AS stop`, [visitId]));
  if (!check) throw new PayrollError(404, 'Pay check not found.');
  if (check.status !== 'finalized' || check.run_status !== 'finalized') throw new PayrollError(409, 'That pay check is not final. A take-back is set only for credit a final pay check paid.');
  if (!check.stop || !(Number(check.stop.creditCents) > 0)) throw new PayrollError(400, 'That stop is not a paid stop of this pay check.');
  return check.stop;
}

const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Sets the TOTAL credit to take back for one paid stop (the owner account's alone; the route checks it), replacing an earlier answer. The
 * check must be final and the total 0 up to the credit it paid for the stop. The page sends the signals it saw: refused (409) when the
 * refunds on the stop changed since. Under the payroll mutation lock, with a critical audit event.
 */
async function setRefundTakeBack(input, actor, conn = db) {
  const v = validated(answerSchema, input);
  const actorId = (actor && typeof actor === 'object' ? actor.id : actor) || null;
  const { recordAuditEvent } = require('./audit-log');
  const { lockPayrollMutations } = require('./payroll-runs');
  return conn.transaction(async (trx) => {
    await lockPayrollMutations(trx);
    const [checkId, visitId] = [canonicalId(v.checkId), canonicalId(v.visitId)];
    const stop = await paidStopOf(trx, checkId, visitId);
    if (v.cents > Number(stop.creditCents)) throw new PayrollError(400, 'The take-back cannot be more than the credit the pay check paid for this stop.');
    const before = await trx('production_share_refund_take_backs').where({ source_check_id: checkId, visit_id: visitId }).first('cents', 'signals', 'note');
    const frozen = new Set(Array.isArray(stop.refundSignals) ? stop.refundSignals : []);
    const current = ((await refundSignalsOf(trx, [visitId])).get(visitId) || []).filter((id) => !frozen.has(id));
    if (!current.length && !before) throw new PayrollError(409, 'No new refund is recorded on this stop.');
    if (!sameList([...v.signals].sort(), current)) throw new PayrollError(409, 'The refunds on this stop changed since you loaded the week. Reload the week and look at it again.');
    // The answer covers every signal it saw and every one an earlier answer covered.
    const signals = [...new Set([...current, ...(before && Array.isArray(before.signals) ? before.signals : [])])].sort();
    await trx('production_share_refund_take_backs').insert({
      source_check_id: checkId, visit_id: visitId, signals: JSON.stringify(signals), cents: v.cents, note: v.note || null,
      set_by: actorId, set_at: trx.fn.now(), updated_at: trx.fn.now(),
    }).onConflict(['source_check_id', 'visit_id']).merge(['signals', 'cents', 'note', 'set_by', 'updated_at']);
    await recordAuditEvent({
      trx, critical: true, actor_type: 'admin', actor_id: actorId,
      action: 'payroll.production_share_refund_take_back_set', resource_type: 'production_share_refund_take_back', resource_id: visitId,
      metadata: { check_id: checkId, visit_id: visitId, cents: v.cents, signals, ...(before ? { before_cents: Number(before.cents) } : {}) },
    });
    return { checkId, visitId, cents: v.cents, signals };
  });
}

/** Removes the owner's answer for a paid stop: what a later week already took back is given back. Same lock and audit as setRefundTakeBack. */
async function clearRefundTakeBack(input, actor, conn = db) {
  const v = validated(answerKeySchema, input);
  const actorId = (actor && typeof actor === 'object' ? actor.id : actor) || null;
  const { recordAuditEvent } = require('./audit-log');
  const { lockPayrollMutations } = require('./payroll-runs');
  return conn.transaction(async (trx) => {
    await lockPayrollMutations(trx);
    const [checkId, visitId] = [canonicalId(v.checkId), canonicalId(v.visitId)];
    const before = await trx('production_share_refund_take_backs').where({ source_check_id: checkId, visit_id: visitId }).first('cents');
    if (!before) throw new PayrollError(404, 'No take-back was set for that stop.');
    await trx('production_share_refund_take_backs').where({ source_check_id: checkId, visit_id: visitId }).del();
    await recordAuditEvent({
      trx, critical: true, actor_type: 'admin', actor_id: actorId,
      action: 'payroll.production_share_refund_take_back_cleared', resource_type: 'production_share_refund_take_back', resource_id: visitId,
      metadata: { check_id: checkId, visit_id: visitId, before_cents: Number(before.cents) },
    });
    return { checkId, visitId };
  });
}

// A short id of what an alert is about, for its dedupe key: the visit and its signals.
const flagKeyOf = (visitId, signals) => crypto.createHash('sha1').update(JSON.stringify([canonicalId(visitId), [...signals].sort()])).digest('hex').slice(0, 20);

module.exports = {
  refundSignalsOf, refundLedgerOf, applyTakeBacks, setRefundTakeBack, clearRefundTakeBack, flagKeyOf,
};

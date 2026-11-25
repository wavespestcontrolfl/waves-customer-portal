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
 * A take-back SOURCE is exactly what paidLedger (production-share.js) counts as paid: a stop row with creditCents > 0 on a finalized check
 * of a finalized run whose share is above $0. A refund on a stop of a $0-share check is no take-back source: that week paid no share.
 * A paid stop's refunds are found from the invoice ids FROZEN on its snapshot row (stops[].invoices and stops[].refundInvoices, the
 * latter also holding an annual term's prepay invoice) UNION the live visit links, so a deleted visit or a relinked invoice still asks.
 * pay and stmt signals carry the Stripe refund identity when the webhooks recorded it (payments.stripe_refund_id and
 * metadata.stamped_refund_ids): a failed refund followed by a new one of the same amount is a new signal. Legacy rows fall back to cents.
 * Every owner mutation names the answer it was shown (answerRevision, 'none' when there is no answer) and is refused (409) when the
 * stored answer is another one, under the payroll lock; the answers a week used are frozen in its snapshot and in its review token.
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

// The Stripe refund identity a payment row recorded, as a short suffix (':' + hash), or '' for a legacy row with none. The webhooks write
// the newest refund id in stripe_refund_id and every refund that entered refund_amount in metadata.stamped_refund_ids.
const REFUND_IDENTITY_SQL = `COALESCE((SELECT ':' || left(md5(string_agg(x.id, ',' ORDER BY x.id)), 10) FROM (
      SELECT p.stripe_refund_id AS id WHERE p.stripe_refund_id IS NOT NULL
      UNION SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.metadata -> 'stamped_refund_ids') = 'array' THEN p.metadata -> 'stamped_refund_ids' ELSE '[]'::jsonb END)
    ) x), '')`;

const asUuids = (list) => [...new Set((list || []).map(String).filter((id) => UUID_RE.test(id)).map(canonicalId))];

/**
 * The refund signals of a batch of visits: Map visit id (lowercase) -> sorted array of signal ids ([] when none). Read-only.
 * `frozen` (optional): Map visit id -> invoice ids frozen on a paid stop; their refunds count for that visit too.
 */
async function refundSignalsOf(conn, visitIds, frozen = new Map()) {
  const sources = await refundSourcesOf(conn, visitIds, frozen);
  return new Map([...sources].map(([id, one]) => [id, one.signals]));
}

/**
 * The same read with the invoice ids behind each visit: Map visit id -> { signals, invoiceIds } (the live links of the visit and its package,
 * an annual term's prepay invoice, and the frozen ids given). A pay run freezes invoiceIds with a paid stop (refundInvoices).
 */
async function refundSourcesOf(conn, visitIds, frozen = new Map()) {
  const ids = [...new Set([...(visitIds || []), ...frozen.keys()].filter(Boolean).map(canonicalId))];
  const out = new Map(ids.map((id) => [id, { signals: [], invoiceIds: [] }]));
  if (!ids.length) return out;
  const pairs = [...frozen].flatMap(([visit, list]) => asUuids(list).map((invoice) => [canonicalId(visit), invoice]));
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
      SELECT origin, invoice_id FROM linked
      UNION
      SELECT f.origin, f.invoice_id FROM unnest(?::uuid[], ?::uuid[]) AS f(origin, invoice_id)
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
      SELECT v.origin, 'pay:' || p.id::text || ':' || round(p.refund_amount * 100)::bigint::text || ${REFUND_IDENTITY_SQL} AS signal
      FROM invs v
      JOIN payments p ON COALESCE(p.refund_amount, 0) > 0 AND (
        p.metadata ->> 'invoice_id' = v.invoice_id::text
        OR (p.stripe_payment_intent_id IS NOT NULL AND p.stripe_payment_intent_id IN (SELECT k.pi FROM keys k WHERE k.invoice_id = v.invoice_id))
        OR (p.stripe_charge_id IS NOT NULL AND p.stripe_charge_id IN (SELECT k.ch FROM keys k WHERE k.invoice_id = v.invoice_id)))
      UNION
      SELECT v.origin, 'stmt:' || p.id::text || ':' || round(p.refund_amount * 100)::bigint::text || ${REFUND_IDENTITY_SQL}
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
    SELECT origin::text AS visit_id, signal, NULL AS invoice_id FROM found
    UNION ALL
    SELECT origin::text, NULL, invoice_id::text FROM invs`, [ids, PACKAGE_DEPTH, ANNUAL_PREPAY_PREPAID_METHOD, ANNUAL_PREPAY_PREPAID_METHOD,
    pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1])]);
  const signals = new Map(ids.map((id) => [id, new Set()]));
  const invoices = new Map(ids.map((id) => [id, new Set()]));
  for (const row of rows) {
    if (row.signal) signals.get(canonicalId(row.visit_id)).add(row.signal);
    if (row.invoice_id) invoices.get(canonicalId(row.visit_id)).add(row.invoice_id);
  }
  for (const id of ids) out.set(id, { signals: [...signals.get(id)].sort(), invoiceIds: [...invoices.get(id)].sort() });
  return out;
}

// ---------------------------------------------------------------- the paid week: what to ask, what was answered, what moves

const STOPS_OF_CHECK_SQL = `CASE WHEN jsonb_typeof(c.calc_snapshot->'productionShare'->'stops') = 'array'
      THEN c.calc_snapshot->'productionShare'->'stops' ELSE '[]'::jsonb END`;
const TAKE_BACKS_OF_CHECK_SQL = `CASE WHEN jsonb_typeof(c.calc_snapshot->'productionShare'->'takeBacks') = 'array'
      THEN c.calc_snapshot->'productionShare'->'takeBacks' ELSE '[]'::jsonb END`;

const sourceKey = (checkId, visitId) => `${canonicalId(checkId)}:${canonicalId(visitId)}`;

// What names one stored answer: its id and the exact time it was last written (microseconds, as text). The page sends it back with a
// change or a clear; 'none' = the page saw no answer.
const UPDATED_TEXT_SQL = `to_char(b.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS updated_text`;
const NO_ANSWER = 'none';
const answerRevisionOf = (row) => (row ? `${Number(row.id)}:${row.updated_text}` : NO_ANSWER);

// The stop rows paidLedger (production-share.js) counts as paid, for these technicians, in weeks before `weekStart`: a credit above $0 on a
// finalized check of a finalized run whose share is above $0. A $0-share week paid no share, so a refund there is no take-back source.
// `frozen` = the refund signals the check froze; `invoices` = the invoice ids it froze (stops[].invoices and stops[].refundInvoices).
async function paidStopsOf(conn, technicianIds, weekStart) {
  return (await conn.raw(`SELECT c.id AS check_id, r.id AS run_id, c.technician_id, to_char(c.week_start, 'YYYY-MM-DD') AS week_start,
      stop.value->>'visitId' AS visit_id, stop.value->>'workDate' AS work_date, (stop.value->>'creditCents')::bigint AS credit_cents,
      ${FROZEN_LISTS_SQL}
    FROM payroll_checks c
    JOIN payroll_runs r ON r.id = c.run_id
    CROSS JOIN LATERAL jsonb_array_elements(${STOPS_OF_CHECK_SQL}) AS stop(value)
    WHERE c.status = 'finalized' AND r.status = 'finalized' AND c.technician_id = ANY(?::uuid[]) AND c.week_start < ?::date
      AND COALESCE(c.production_share_cents, 0) > 0 AND COALESCE((stop.value->>'creditCents')::bigint, 0) > 0
    ORDER BY c.week_start, c.id, stop.value->>'visitId'`, [technicianIds, weekStart])).rows;
}

// What a check froze of a stop: the refund signals at finalize, and the invoice ids (a list, whatever the snapshot's age).
const jsonList = (column) => `CASE WHEN jsonb_typeof(stop.value->'${column}') = 'array' THEN stop.value->'${column}' ELSE '[]'::jsonb END`;
const FROZEN_LISTS_SQL = `${jsonList('refundSignals')} AS frozen, ${jsonList('invoices')} AS frozen_invoices, ${jsonList('refundInvoices')} AS frozen_refund_invoices`;
// Frozen invoice ids of a paid stop row (either list).
const frozenInvoicesOf = (row) => asUuids([...(row.frozen_invoices || []), ...(row.frozen_refund_invoices || [])]);

// The owner's answers for finalized checks of these technicians before `weekStart`: Map source key -> answer.
async function answersOf(conn, technicianIds, weekStart) {
  const rows = await conn('production_share_refund_take_backs as b')
    .join('payroll_checks as c', 'c.id', 'b.source_check_id')
    .join('payroll_runs as r', 'r.id', 'c.run_id')
    .where({ 'c.status': 'finalized', 'r.status': 'finalized' }).where('c.production_share_cents', '>', 0)
    .whereIn('c.technician_id', technicianIds).where('c.week_start', '<', weekStart)
    .select('b.id', 'b.source_check_id', 'b.visit_id', 'b.signals', 'b.cents', 'b.note', 'b.updated_at', conn.raw(UPDATED_TEXT_SQL));
  return new Map(rows.map((row) => [sourceKey(row.source_check_id, row.visit_id), {
    id: Number(row.id), sourceCheckId: canonicalId(row.source_check_id), visitId: canonicalId(row.visit_id),
    signals: [...(Array.isArray(row.signals) ? row.signals : [])].map(String).sort(), cents: Number(row.cents), note: row.note || null,
    updatedAt: new Date(row.updated_at).toISOString(), revision: answerRevisionOf(row),
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

// One paid stop row against the refund signals now, the owner's answer and what finalized weeks took: fills the technician's lists.
function addSource(mine, row, { signals, answer, history }) {
  const frozen = new Set(row.frozen);
  const newSignals = signals.filter((id) => !frozen.has(id));
  const where = {
    checkId: canonicalId(row.check_id), visitId: canonicalId(row.visit_id), workDate: row.work_date || null, paidWeekStart: row.week_start,
    creditCents: Number(row.credit_cents), answerRevision: answer ? answer.revision : NO_ANSWER,
  };
  if (newSignals.length && !(answer && newSignals.every((id) => answer.signals.includes(id)))) mine.toSet.push({ ...where, newSignals });
  if (answer) mine.answers.push({ ...where, id: answer.id, cents: answer.cents, note: answer.note, signals: answer.signals, newSignals, updatedAt: answer.updatedAt, revision: answer.revision });
  if (!answer && !history) return;
  const delta = (answer ? answer.cents : 0) - (history ? history.cents : 0);
  // ONE RULE for dependencies: a source with any finalized history is evaluated every week; its entry (0 cents when nothing moves)
  // carries the run of the source check and every run that holds an entry for it.
  if (delta === 0 && !(history && history.runs.size)) return;
  mine.owed.push({
    visitId: where.visitId, sourceCheckId: where.checkId, paidWeekStart: row.week_start, workDate: where.workDate, cents: delta,
    dependsOnRuns: [...new Set([row.run_id, ...(history ? history.runs : [])])].sort(),
  });
}

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
  // The invoices the paid rows froze count with the live links of the visit: a deleted visit or a relinked invoice still asks.
  const frozenInvoices = new Map();
  for (const row of paid) frozenInvoices.set(canonicalId(row.visit_id), [...(frozenInvoices.get(canonicalId(row.visit_id)) || []), ...frozenInvoicesOf(row)]);
  const [signals, answers, taken] = await Promise.all([
    refundSignalsOf(conn, visitIds, frozenInvoices), answersOf(conn, technicianIds, weekStart), takenBackOf(conn, visitIds, weekStart),
  ]);
  for (const row of paid) {
    const mine = out.get(canonicalId(row.technician_id));
    if (!mine) continue;
    const key = sourceKey(row.check_id, row.visit_id);
    addSource(mine, row, { signals: signals.get(canonicalId(row.visit_id)) || [], answer: answers.get(key), history: taken.get(key) });
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
  // The answer the page was showing (its answerRevision; 'none' when it showed none): refused (409) when the stored answer is another one.
  answerRevision: Joi.string().max(80).required().error(new Error('Reload the week: the answer must be sent with its revision')),
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
    .first('c.id', 'c.status', 'c.production_share_cents', 'r.status as run_status', trx.raw(`(SELECT s.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.calc_snapshot->'productionShare'->'stops') = 'array'
      THEN c.calc_snapshot->'productionShare'->'stops' ELSE '[]'::jsonb END) s(value) WHERE s.value->>'visitId' = ?) AS stop`, [visitId]));
  if (!check) throw new PayrollError(404, 'Pay check not found.');
  if (check.status !== 'finalized' || check.run_status !== 'finalized') throw new PayrollError(409, 'That pay check is not final. A take-back is set only for credit a final pay check paid.');
  // The same rule as paidLedger: a credit above $0 on a check whose share is above $0. A $0-share week paid no share.
  if (!check.stop || !(Number(check.stop.creditCents) > 0) || !(Number(check.production_share_cents) > 0)) {
    throw new PayrollError(400, 'That stop is not a paid stop of this pay check (it needs a credit above $0 on a check that paid a share).');
  }
  return check.stop;
}

// The stored answer of a source, with its revision: null when there is none.
const storedAnswer = (trx, checkId, visitId) => trx('production_share_refund_take_backs as b').where({ 'b.source_check_id': checkId, 'b.visit_id': visitId })
  .first('b.id', 'b.cents', 'b.signals', 'b.note', trx.raw(UPDATED_TEXT_SQL));

// A change or a clear is for the answer the page was showing, and no other (under the payroll lock).
function requireSameAnswer(stored, revision) {
  if (answerRevisionOf(stored) !== revision) throw new PayrollError(409, 'The take-back for this stop changed since you loaded the week. Reload the week and look at it again.');
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
    const before = await storedAnswer(trx, checkId, visitId);
    requireSameAnswer(before, v.answerRevision);
    const frozen = new Set(Array.isArray(stop.refundSignals) ? stop.refundSignals : []);
    // The refunds on the stop now: its live links and the invoices its check froze (a deleted visit or a relinked invoice still counts).
    const frozenInvoices = new Map([[visitId, asUuids([...(stop.invoices || []), ...(stop.refundInvoices || [])])]]);
    const current = ((await refundSignalsOf(trx, [visitId], frozenInvoices)).get(visitId) || []).filter((id) => !frozen.has(id));
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
    const before = await storedAnswer(trx, checkId, visitId);
    if (!before) throw new PayrollError(404, 'No take-back was set for that stop.');
    requireSameAnswer(before, v.answerRevision);
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
  refundSignalsOf, refundSourcesOf, refundLedgerOf, applyTakeBacks, setRefundTakeBack, clearRefundTakeBack, flagKeyOf,
};

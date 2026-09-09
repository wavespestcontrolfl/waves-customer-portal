// MUTATES (dry-run default; pass --execute to write)
//
// Attach office-raised invoices to the visits they billed. The Invoices page
// could only link a new invoice to a COMPLETED visit, so an invoice raised on
// the visit date before the closeout stayed unlinked: the completion minted a
// duplicate and Billing Recovery's leak query read the visit as unbilled.
// This is the one-shot, HUMAN-REVIEWED repair for those rows. The pairing is
// a heuristic and lives ONLY here — the runtime never infers a link (owner
// decision 2026-09-07 after five review rounds each found a way an inferred
// pairing could hide a legitimate charge). Read the dry-run list, then run
// --execute.
//
// Pairing rule (every "no" leaves the invoice alone):
//   - the invoice is live (not void/refunded/canceled), unlinked, not an
//     annual-prepay or archived row, and has a service_date BEFORE today
//     (ET). Past dates only (GitHub r3 P1): a same-day invoice is the
//     runtime's job — the Invoices page links it to its open visit at
//     creation. A past date is NOT immune to schedule writes: a silent
//     record correction may move a visit into the past
//     (admin-schedule update-details with notifyCustomer false), so under
//     --execute the customer row is locked FOR UPDATE (an INSERT of a new
//     visit takes FOR KEY SHARE on it through the FK and waits) and EVERY
//     visit row the customer has is locked FOR UPDATE (a date move or a
//     status flip on any of them waits) before the single-visit predicate
//     is re-evaluated — held through commit (pre-push r4 + r5 P1).
//   - the customer has exactly ONE live visit on that date, with NO add-on
//     lines, no other non-void invoice (direct or through its service
//     records), no visit_billing_dispositions row (a human already ruled
//     the visit billed or intentionally_free in Billing Recovery — the
//     /bill and /dismiss routes refuse such a visit and job-costing treats
//     the ruling as authoritative; GitHub r8 P1), and not owned by a saved
//     grouped closeout;
//   - the invoice is the customer's ONLY live unlinked invoice dated that
//     day. Under --execute that predicate is read from LOCKED rows: EVERY
//     invoice row the customer has — any date, any status — is taken FOR
//     UPDATE (in the pre-lock ladder, before any customer lock) and held
//     through commit, so a terminal sibling flipped back to live
//     (handleRefundFailed rewinding refunded → paid) or an invoice redated
//     onto the day contends on its own row and waits (GitHub r8 P1);
//   - the frozen invoice payer and PO match the visit's effective Bill-To;
//     exempt payers carry zero tax. Resolution errors abort the run.
//   - a positive line reads like the visit's application: exactly the
//     visit's label or an active catalog service name in the visit's family
//     (or a ≥8-char label contained in one); fee/charge and product words
//     never qualify; a line naming another family refuses the pairing.
//   - service_record_id is set only to the visit's CANONICAL completion
//     record: its single record, or the one a succeeded
//     service_completion_attempts row names; several records and no
//     succeeded attempt → the visit link alone (GitHub r3 P1 — the payment
//     path reads review timing / outcome from the record, so a sibling
//     recap or project row must never be guessed).
//
// Two-step by design (the review IS the safeguard):
//   1. Dry run prints the pairings and writes them to --plan-out=<file>
//      — ALWAYS, an empty plan included, so a stale file from an earlier
//      scan can never be the one --execute consumes (GitHub r3 P2). Each
//      pairing carries the ids, the figures the reviewer reads (invoice
//      total, visit service, previous and resulting technician ids) and a
//      sha256 DIGEST of every review-relevant
//      invoice and visit field (status, dates, service type, line items,
//      amounts, technician, completion record). The operator reads the list.
//   2. --execute --plan=<file> links ONLY the pairs in that reviewed file —
//      never a recomputed list — in one transaction; per pair the visit's
//      mint lock chain (advisory → customer key share → visit row FOR
//      UPDATE), the invoice row FOR UPDATE, and the FULL rule re-evaluated
//      on the locked rows; the digest recomputed from the locked rows must
//      equal the reviewed one, so an invoice amount / line edit or a visit
//      service change after the review — even one that still passes the
//      rule — aborts the whole batch (GitHub r8 P1). A plan without digests
//      is refused. --execute without --plan is refused.
// --days=N: lookback on invoices.created_at (120) for the plan.
//
// Run (repo root):
//   railway run --service Postgres node ops/agents/link-unlinked-visit-invoices.js [--days=120] --plan-out=/tmp/link-plan.json
//   railway run --service Postgres node ops/agents/link-unlinked-visit-invoices.js --execute --plan=/tmp/link-plan.json

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const fs = require('fs');
const crypto = require('crypto');
const EXECUTE = process.argv.includes('--execute');
const argValue = (name) => { const hit = process.argv.find((a) => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : null; };
const DAYS = Math.max(1, parseInt(argValue('days') || '120', 10) || 120);
const PLAN_OUT = argValue('plan-out');
const PLAN_IN = argValue('plan');
const PayerService = require(path.join(ROOT, 'server', 'services', 'payer'));
const InvoiceService = require(path.join(ROOT, 'server', 'services', 'invoice'));
const { serviceKeyFor } = require(path.join(ROOT, 'server', 'services', 'recurring-appointment-seeder'));
const { acquireScheduledInvoiceMintLock, acquireScheduledMintLockChain, assertScheduledInvoiceNotPacketOwned } = require(path.join(ROOT, 'server', 'services', 'scheduled-invoice-mint'));
const { etDateString } = require(path.join(ROOT, 'server', 'utils', 'datetime-et'));

const DEAD_VISIT_STATUSES = ['cancelled', 'rescheduled', 'skipped', 'no_show'];
const KNOWN_FAMILIES = new Set(['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'palm_injection', 'foam_recurring', 'rodent_bait', 'termite_bait']);
const NON_APPLICATION_LINE_RE = /\b(fee|fees|surcharge|cancel\w*|reschedul\w*|no[- ]?show|late|deposit|credit|discount|tax|tip|gratuity|warranty|renewal)\b/i;
const PRODUCT_LINE_RE = /\b(refill|refills|supplies|supply|product|products|equipment|parts?|materials?)\b/i;
const SHORT_LABEL_MIN_CHARS = 8;

const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : (String(v || '').match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || null);
function parseLines(row) { let i = row?.line_items; if (typeof i === 'string') { try { i = JSON.parse(i); } catch { i = null; } } return Array.isArray(i) ? i : null; }
function lineAmount(li) { const q = li?.quantity != null ? Number(li.quantity) : 1; const a = li?.amount != null ? Number(li.amount) : Number(li?.unit_price) * q; return Number.isFinite(a) ? a : NaN; }

// What the reviewer signed off on. Recomputed from the LOCKED rows at
// --execute and compared with the plan: any review-relevant edit in between
// (amount, lines, status, dates, service type, technician, completion
// record) aborts the batch even when the edited rows still pass the rule.
const INVOICE_DIGEST_FIELDS = ['id', 'customer_id', 'status', 'service_date', 'service_type', 'title', 'line_items', 'subtotal', 'discount_amount', 'tax_amount', 'total', 'technician_id', 'payer_id', 'po_number', 'tax_rate', 'payer_snapshot'];
const VISIT_DIGEST_FIELDS = ['id', 'customer_id', 'scheduled_date', 'service_type', 'status', 'technician_id', 'payer_id', 'po_number', 'self_pay_override'];
function pairingDigest(inv, svc, serviceRecordId, billTo) {
  const pick = (row, keys) => keys.map((k) => { const v = row[k]; return v instanceof Date ? v.toISOString() : (v === undefined ? null : v); });
  const body = JSON.stringify({ invoice: pick(inv, INVOICE_DIGEST_FIELDS), visit: pick(svc, VISIT_DIGEST_FIELDS), serviceRecordId: serviceRecordId || null, billTo });
  return crypto.createHash('sha256').update(body).digest('hex');
}

function invoiceBillsVisitApplication(invoice, svc, catalogNames) {
  const visitFamily = serviceKeyFor({ service_type: svc.service_type });
  if (!KNOWN_FAMILIES.has(visitFamily)) return false;
  if (invoice.service_type) {
    const f = serviceKeyFor({ service_type: invoice.service_type });
    if (KNOWN_FAMILIES.has(f) && f !== visitFamily) return false;
  }
  const items = parseLines(invoice);
  if (!items || !items.length) return false;
  const visitLabel = norm(svc.service_type);
  let evidence = false;
  for (const li of items) {
    if (!(lineAmount(li) > 0)) continue;
    const desc = String(li?.description || '');
    const f = serviceKeyFor({ service_type: desc });
    if (KNOWN_FAMILIES.has(f) && f !== visitFamily) return false;
    if (NON_APPLICATION_LINE_RE.test(desc) || PRODUCT_LINE_RE.test(desc)) continue;
    const label = norm(desc);
    if (!label) continue;
    let matched = label === visitLabel;
    if (!matched) {
      for (const name of catalogNames) {
        if (name === label || (label.length >= SHORT_LABEL_MIN_CHARS && name.includes(label))) {
          if (serviceKeyFor({ service_type: name }) !== visitFamily) return false;
          matched = true; break;
        }
      }
    }
    if (matched) evidence = true;
  }
  return evidence;
}

// One invoice's pairing verdict. Runs for the plan and AGAIN inside the
// write transaction on locked rows (lock = true).
async function evaluate(conn, invoiceId, catalogNames, { lock = false } = {}) {
  const inv = await conn('invoices').where({ id: invoiceId })
    .modify((q) => { if (lock) q.forUpdate(); })
    .whereNull('scheduled_service_id').whereNull('service_record_id').whereNull('annual_prepay_term_id').whereNull('archived_at')
    .whereNotNull('service_date').whereNotIn('status', InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES)
    .first();
  if (!inv) return { skip: 'invoiceChanged' };
  const day = dateOnly(inv.service_date);
  if (!day || day >= etDateString()) return { skip: 'notPast' };
  const visits = await conn('scheduled_services').where({ customer_id: inv.customer_id })
    .whereRaw('scheduled_date::date = ?::date', [day]).whereNotIn('status', DEAD_VISIT_STATUSES).select('id');
  if (visits.length === 0) return { skip: 'noVisit' };
  if (visits.length > 1) return { skip: 'ambiguous' };
  let svc;
  if (lock) {
    // The canonical chain every invoice-attaching writer takes; the visit
    // row comes back locked and fresh (status / date / service_type).
    svc = await acquireScheduledMintLockChain(conn, { scheduledServiceId: visits[0].id, customerId: inv.customer_id,
      visitColumns: ['id', 'customer_id', 'scheduled_date', 'service_type', 'status', 'technician_id', 'payer_id', 'po_number', 'self_pay_override'] });
    if (!svc || DEAD_VISIT_STATUSES.includes(String(svc.status)) || dateOnly(svc.scheduled_date) !== day) return { skip: 'visitChanged' };
    // Uniqueness AGAIN under the locks (pre-push P1): a visit moved onto or
    // reactivated for this date while we waited makes the pairing a guess.
    // The customer row goes FOR UPDATE (upgrading the chain's KEY SHARE):
    // an INSERT of a new visit for this customer takes FOR KEY SHARE on it
    // through the FK and waits for our commit. Then EVERY visit row the
    // customer has — any date, any status — is locked: a silent past-date
    // edit moving another visit onto this date, or a `rescheduled` sibling
    // flipped back to `confirmed`, contends on its own row and waits
    // (pre-push r4 + r5 P1). The predicate is then read from the locked set.
    await conn.raw('SELECT id FROM customers WHERE id = ? FOR UPDATE', [inv.customer_id]);
    const allVisits = await conn('scheduled_services').where({ customer_id: inv.customer_id })
      .forUpdate().select('id', 'scheduled_date', 'status');
    const stillOne = allVisits.filter((row) => dateOnly(row.scheduled_date) === day && !DEAD_VISIT_STATUSES.includes(String(row.status)));
    if (stillOne.length !== 1 || String(stillOne[0].id) !== String(svc.id)) return { skip: 'ambiguous' };
  } else {
    svc = await conn('scheduled_services').where({ id: visits[0].id }).first('id', 'customer_id', 'scheduled_date', 'service_type', 'status', 'technician_id', 'payer_id', 'po_number', 'self_pay_override');
  }
  // The invoice must be the customer's ONLY live unlinked invoice dated
  // that day. Under the locks the predicate is read from EVERY invoice row
  // the customer has — any date, any status — taken FOR UPDATE and held
  // through commit (GitHub r8 P1): a terminal sibling that a refund-failed
  // webhook rewinds to paid, or an invoice redated onto the day, contends
  // on its own row and waits; a NEW invoice for the customer waits on the
  // customer row held FOR UPDATE above. The pre-lock ladder in --execute
  // already holds these rows (re-entrant), so no customer lock is taken
  // while a fresh invoice row is still wanted.
  const customerInvoices = await conn('invoices').where({ customer_id: inv.customer_id })
    .modify((q) => { if (lock) q.forUpdate(); })
    .select('id', 'status', 'service_date', 'scheduled_service_id', 'service_record_id', 'annual_prepay_term_id', 'archived_at');
  const sameDayLive = customerInvoices.filter((row) => dateOnly(row.service_date) === day
    && row.scheduled_service_id == null && row.service_record_id == null && row.annual_prepay_term_id == null && row.archived_at == null
    && !InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES.includes(String(row.status)));
  if (sameDayLive.length !== 1 || String(sameDayLive[0].id) !== String(inv.id)) return { skip: 'ambiguous' };
  if (await conn('scheduled_service_addons').where({ scheduled_service_id: svc.id }).first('id')) return { skip: 'visitHasAddons' };
  const invoiced = await conn('invoices')
    .where((qb) => qb.where({ scheduled_service_id: svc.id })
      .orWhereIn('service_record_id', conn('service_records').select('id').where({ scheduled_service_id: svc.id })))
    .whereNot('status', 'void').first('id');
  if (invoiced) return { skip: 'visitAlreadyInvoiced' };
  // A human already ruled this visit in Billing Recovery (billed against
  // some invoice, or intentionally_free): honor it as the canonical /bill
  // and /dismiss routes do (GitHub r8 P1). Both writers insert under the
  // visit's mint advisory lock, which the chain above holds, so under
  // --execute a ruling cannot land between this read and the commit.
  if (await conn('visit_billing_dispositions').where({ scheduled_service_id: svc.id }).first('id')) return { skip: 'dispositioned' };
  try { await assertScheduledInvoiceNotPacketOwned(conn, svc.id); } catch { return { skip: 'packetOwned' }; }
  if (!invoiceBillsVisitApplication(inv, svc, catalogNames)) return { skip: 'noEvidence' };
  // Customer and visit are already locked during execute. Hold the referenced
  // payer rows too: deactivation/exemption edits must wait through commit.
  const customer = await conn('customers').where({ id: inv.customer_id }).first();
  if (!customer) return { skip: 'customerChanged' };
  if (lock) {
    const payerIds = [...new Set([customer.payer_id, svc.payer_id, inv.payer_id].filter((id) => id != null))];
    await conn('payers').whereIn('id', payerIds).orderBy('id').forUpdate().select('id');
  }
  const billTo = await PayerService.resolveForInvoice({ database: conn, customerId: inv.customer_id,
    customer, scheduledServiceId: svc.id, throwOnError: true });
  if (String(inv.payer_id || '') !== String(billTo.payerId || '')
    || String(inv.po_number || '').trim() !== String(billTo.poNumber || '').trim()) return { skip: 'billToMismatch' };
  if (billTo.taxExempt && (Number(inv.tax_rate) !== 0 || Number(inv.tax_amount) !== 0)) return { skip: 'payerTaxMismatch' };
  const record = await canonicalCompletionRecordId(conn, svc.id);
  return { pairing: { invoiceId: inv.id, invoiceStatus: inv.status, invoiceTotal: inv.total == null ? null : Number(inv.total), serviceDate: day,
    visitId: svc.id, visitStatus: svc.status, visitService: svc.service_type || null,
    serviceRecordId: record, previousTechnicianId: inv.technician_id || null, technicianId: svc.technician_id || inv.technician_id || null,
    digest: pairingDigest(inv, svc, record, billTo) } };
}

// The visit's canonical completion record, or null when it cannot be told:
// one record → that one; several (completion + project / recap rails) →
// only the record a SUCCEEDED completion attempt names; otherwise null and
// the invoice links to the visit alone.
async function canonicalCompletionRecordId(conn, scheduledServiceId) {
  const records = await conn('service_records').where({ scheduled_service_id: scheduledServiceId }).select('id');
  if (records.length === 0) return null;
  if (records.length === 1) return records[0].id;
  const ids = new Set(records.map((r) => String(r.id)));
  const attempt = await conn('service_completion_attempts')
    .where({ service_id: scheduledServiceId, status: 'succeeded' }).whereNotNull('service_record_id')
    .orderBy('updated_at', 'desc').first('service_record_id');
  return attempt && ids.has(String(attempt.service_record_id)) ? attempt.service_record_id : null;
}

async function catalog(conn) {
  const rows = await conn('services').where({ is_active: true }).select('name');
  return new Set(rows.map((r) => norm(r.name)).filter(Boolean));
}

async function plan(conn) {
  const catalogNames = await catalog(conn);
  const unlinked = await conn('invoices as i')
    .whereNull('i.scheduled_service_id').whereNull('i.service_record_id').whereNull('i.annual_prepay_term_id').whereNull('i.archived_at')
    .whereNotNull('i.service_date').whereNotIn('i.status', InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES)
    .where('i.created_at', '>', conn.raw(`now() - interval '${DAYS} days'`)).orderBy('i.service_date').select('i.id');
  const pairings = []; const skipped = {};
  for (const { id } of unlinked) {
    const v = await evaluate(conn, id, catalogNames);
    if (v.pairing) pairings.push(v.pairing); else skipped[v.skip] = (skipped[v.skip] || 0) + 1;
  }
  return { scanned: unlinked.length, pairings, skipped, catalogNames };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^[0-9a-f]{64}$/;
function readPlan(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pairs = Array.isArray(parsed?.pairings) ? parsed.pairings : null;
  if (!pairs || !pairs.length) throw new Error(`${file}: no pairings — nothing to execute`);
  for (const p of pairs) {
    if (!UUID_RE.test(String(p.invoiceId)) || !UUID_RE.test(String(p.visitId)) || (p.serviceRecordId && !UUID_RE.test(String(p.serviceRecordId)))) {
      throw new Error(`${file}: malformed pairing ${JSON.stringify(p)}`);
    }
    if (!DIGEST_RE.test(String(p.digest || ''))) {
      throw new Error(`${file}: pairing for invoice ${p.invoiceId} has no review digest — re-run the dry run with --plan-out and review the fresh plan`);
    }
  }
  return pairs;
}

async function main() {
  if (EXECUTE && !PLAN_IN) { console.error('--execute requires --plan=<file written by a reviewed dry run>'); process.exit(2); }

  // The Postgres service's public endpoint (the app service's DATABASE_URL is
  // the private host and is unreachable from a laptop).
  const CONNECTION = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!CONNECTION) { console.error('DATABASE_PUBLIC_URL (or DATABASE_URL) is required'); process.exit(2); }

  const knex = require(path.join(ROOT, 'node_modules', 'knex'))({ client: 'pg', connection: CONNECTION, pool: { min: 0, max: 2 } });

  try {
    if (!EXECUTE) {
      const { scanned, pairings, skipped } = await plan(knex);
      console.log(`DRY RUN — ${scanned} unlinked invoice(s) in the last ${DAYS} days; ${pairings.length} pairing(s); skipped: ${JSON.stringify(skipped)}`);
      for (const p of pairings) {
        const total = p.invoiceTotal == null ? '' : ` $${p.invoiceTotal.toFixed(2)}`;
        console.log(`  ${p.serviceDate}  invoice ${p.invoiceId} (${p.invoiceStatus}${total}) -> visit ${p.visitId} (${p.visitStatus}${p.visitService ? `, ${p.visitService}` : ''})${p.serviceRecordId ? ` + record ${p.serviceRecordId}` : ''}; technician ${p.previousTechnicianId || 'none'} -> ${p.technicianId || 'none'}`);
      }
      if (PLAN_OUT) {
        // Written on EVERY scan, an empty plan included — a stale file from
        // an earlier scan must never be the list --execute consumes.
        fs.writeFileSync(PLAN_OUT, JSON.stringify({ plannedAt: new Date().toISOString(), days: DAYS, pairings }, null, 2));
        console.log(pairings.length
          ? `Plan written to ${PLAN_OUT} — review it, then: --execute --plan=${PLAN_OUT}`
          : `Empty plan written to ${PLAN_OUT} — nothing to execute.`);
      } else if (pairings.length) {
        console.log('Dry run — nothing written. Re-run with --plan-out=<file> to save the reviewed list for --execute.');
      }
      return;
    }
    // Execute ONLY the reviewed pairs (pre-push P1): never a recomputed list.
    const reviewed = readPlan(PLAN_IN);
    const catalogNames = await catalog(knex);
    let written = 0;
    await knex.transaction(async (trx) => {
      // Every reviewed visit's mint advisory lock FIRST, in one deterministic
      // order, before any customer / visit row lock is held (pre-push r6
      // P1): with visits A and B of one customer in the plan, evaluating A
      // holds the customer FOR UPDATE through commit, a live mint for B
      // takes B's advisory lock and waits on that customer, and evaluating
      // B would then wait on B's advisory lock — a deadlock that aborts the
      // repair or live billing. Advisory xact locks are re-entrant, so the
      // per-pair chain below re-acquires without waiting.
      for (const visitId of [...new Set(reviewed.map((p) => String(p.visitId)))].sort()) {
        await acquireScheduledInvoiceMintLock(trx, visitId);
      }
      // Then EVERY invoice row of every reviewed invoice's customer — any
      // date, any status — sorted, before any customer lock (pre-push r7 +
      // GitHub r8 P1): credit settlement locks an invoice row and then
      // waits on its customer, so an invoice row of a customer whose row we
      // already hold FOR UPDATE would deadlock with it; and the uniqueness
      // recheck inside evaluate() reads the same-day predicate from these
      // locked rows. Any order inversion this ladder still misses is caught
      // by Postgres deadlock detection, which aborts the ONE batch
      // transaction — nothing half-written; re-run the reviewed plan.
      const reviewedIds = [...new Set(reviewed.map((p) => String(p.invoiceId)))];
      const owners = await trx('invoices').whereIn('id', reviewedIds).select('id', 'customer_id');
      if (owners.length !== reviewedIds.length) throw new Error('a reviewed invoice no longer exists — batch aborted, nothing written');
      const customerIds = [...new Set(owners.map((r) => String(r.customer_id)))];
      const ladder = await trx('invoices').whereIn('customer_id', customerIds).orderBy('id').select('id');
      for (const { id } of ladder) {
        await trx('invoices').where({ id }).forUpdate().first('id');
      }
      for (const p of reviewed) {
        const again = await evaluate(trx, p.invoiceId, catalogNames, { lock: true });
        const same = again.pairing && String(again.pairing.visitId) === String(p.visitId)
          && String(again.pairing.serviceRecordId || '') === String(p.serviceRecordId || '')
          && String(again.pairing.technicianId || '') === String(p.technicianId || '')
          && again.pairing.digest === p.digest;
        if (!same) throw new Error(`invoice ${p.invoiceId}: pairing changed since the reviewed plan (${again.skip || 'different visit/record/technician, or the reviewed invoice/visit fields were edited'}) — batch aborted, nothing written`);
        // Everything written comes from the LOCKED re-evaluation, not the plan.
        const live = again.pairing;
        const updated = await trx('invoices').where({ id: live.invoiceId }).whereNull('scheduled_service_id').whereNull('service_record_id')
          .update({ scheduled_service_id: live.visitId, ...(live.serviceRecordId ? { service_record_id: live.serviceRecordId } : {}),
            ...(live.technicianId ? { technician_id: live.technicianId } : {}), updated_at: new Date() });
        if (updated !== 1) throw new Error(`invoice ${live.invoiceId} changed under us (updated ${updated}) — batch aborted, nothing written`);
        written += 1;
      }
    });
    console.log(`Linked ${written} invoice(s) from the reviewed plan.`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
}

if (require.main === module) void main();
module.exports = { evaluate, pairingDigest, readPlan };

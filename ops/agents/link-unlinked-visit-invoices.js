// READ-ONLY: candidate planner for a one-shot, human-reviewed invoice repair.
// Never infers links in runtime billing and never writes database rows.
// --execute is refused; the transactional executor is a separate review unit.
//
// Candidates: past-date, live unlinked invoices; exactly one live invoice and
// visit on that customer/date; no callbacks, composite programs, add-ons,
// existing visit invoice, Billing Recovery disposition, or saved closeout.
// Positive application evidence and effective Bill-To must agree. Unknown or
// conflicting evidence leaves the invoice alone; database failures abort.
//
// Plans show every proposed link and technician change, plus a digest binding
// the reviewed invoice, visit, completion records, and Bill-To. Plan version 2
// intentionally rejects plans from the former combined planner/executor.
// A plan is only a review artifact: the executor must lock and re-evaluate it.
//
// node ops/agents/link-unlinked-visit-invoices.js --days=120 --plan-out=/tmp/link-plan.json
// Uses REPAIR_DATABASE_URL explicitly; no ambient application database URL.
const fs = require('fs');
const crypto = require('crypto');
const PayerService = require('../../server/services/payer');
const InvoiceService = require('../../server/services/invoice');
const { serviceKeyFor } = require('../../server/services/recurring-appointment-seeder');
const { assertScheduledInvoiceNotPacketOwned } = require('../../server/services/scheduled-invoice-mint');
const { etDateString } = require('../../server/utils/datetime-et');

const PLAN_VERSION = 2;
const DEAD_VISIT_STATUSES = ['cancelled', 'rescheduled', 'skipped', 'no_show'];
const KNOWN_FAMILIES = new Set(['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'palm_injection', 'foam_recurring', 'rodent_bait', 'termite_bait']);
const NON_APPLICATION_LINE_RE = /\b(fee|fees|surcharge|cancel\w*|reschedul\w*|no[- ]?show|late|deposit|credit|discount|tax|tip|gratuity|warranty|renewal|callback|re[- ]?treat\w*|refills?|supplies|supply|products?|equipment|parts?|materials?)\b/i;
// Retired identities can encode multiple programs without any add-on rows.
// This is deliberately conservative: declining a candidate needs manual
// reconciliation; accepting a partial bill could suppress legitimate billing.
const COMPOSITE_LABEL_RE = /\+|\b(combo|combined)\b|\bpest\b.*\b(rodent|termite|mosquito)\b|\blawn\b.*\b(tree|shrub)\b/i;
const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : (String(v || '').match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || null);
function parseLines(row) { let i = row?.line_items; if (typeof i === 'string') { try { i = JSON.parse(i); } catch { i = null; } } return Array.isArray(i) ? i : []; }
function lineAmount(li) { const q = li?.quantity != null ? Number(li.quantity) : 1; const a = li?.amount != null ? Number(li.amount) : Number(li?.unit_price) * q; return Number.isFinite(a) ? a : NaN; }

function isCompositeService(label) {
  if (COMPOSITE_LABEL_RE.test(String(label || '').replace(/_/g, ' '))) return true;
  const families = String(label || '').split(/&|\band\b/i)
    .map((part) => serviceKeyFor({ service_type: part })).filter((f) => KNOWN_FAMILIES.has(f));
  return new Set(families).size > 1;
}

const INVOICE_DIGEST_FIELDS = ['id', 'customer_id', 'status', 'service_date', 'service_type', 'title', 'line_items', 'subtotal', 'discount_amount', 'tax_amount', 'total', 'technician_id', 'tech_name', 'payer_id', 'po_number', 'tax_rate', 'payer_snapshot'];
const VISIT_DIGEST_FIELDS = ['id', 'customer_id', 'scheduled_date', 'service_type', 'service_key_snapshot', 'status', 'technician_id', 'payer_id', 'po_number', 'self_pay_override', 'is_callback'];
function pairingDigest(inv, svc, serviceRecordId, billTo, records = []) {
  const pick = (row, keys) => keys.map((k) => { const v = row[k]; return v instanceof Date ? v.toISOString() : (v === undefined ? null : v); });
  const recordEvidence = records.map((r) => [String(r.id), r.is_callback === true]).sort((a, b) => a[0].localeCompare(b[0]));
  const body = JSON.stringify({ version: PLAN_VERSION, invoice: pick(inv, INVOICE_DIGEST_FIELDS), visit: pick(svc, VISIT_DIGEST_FIELDS),
    serviceRecordId: serviceRecordId || null, records: recordEvidence, billTo });
  return crypto.createHash('sha256').update(body).digest('hex');
}

function invoiceBillsVisitApplication(invoice, svc, catalogNames) {
  const visitFamily = serviceKeyFor({ service_type: svc.service_type });
  if (!KNOWN_FAMILIES.has(visitFamily)) return false;
  const otherFamily = (label) => {
    const family = serviceKeyFor({ service_type: label });
    return KNOWN_FAMILIES.has(family) && family !== visitFamily;
  };
  if (isCompositeService(invoice.service_type) || otherFamily(invoice.service_type)) return false;
  const items = parseLines(invoice).filter((li) => lineAmount(li) > 0);
  if (items.some((li) => isCompositeService(li.description) || otherFamily(li.description))) return false;
  const visitLabel = norm(svc.service_type);
  let evidence = false;
  for (const li of items) {
    const desc = String(li.description || '');
    if (NON_APPLICATION_LINE_RE.test(desc)) continue;
    const label = norm(desc);
    if (!label) continue;
    // Inspect ALL containing catalog names: unordered catalog rows must never
    // let the first matching family hide a conflicting service identity.
    const matches = [...catalogNames].filter((name) => norm(name) === label || (label.length >= 8 && norm(name).includes(label)));
    if (matches.some((name) => isCompositeService(name) || serviceKeyFor({ service_type: name }) !== visitFamily)) return false;
    if (label === visitLabel || matches.length > 0) evidence = true;
  }
  return evidence;
}

// The same live/unlinked filter governs the scan, candidate read, and
// customer/date uniqueness predicate; the runtime's terminal statuses win.
function unlinkedInvoices(conn) {
  return conn('invoices').whereNull('scheduled_service_id').whereNull('service_record_id')
    .whereNull('annual_prepay_term_id').whereNull('archived_at').whereNotNull('service_date')
    .whereNotIn('status', InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES);
}

// Reads only. The planner supplies a consistent read-only snapshot; the
// separately reviewed executor supplies a transaction holding the row locks.
async function evaluate(conn, invoiceId, catalogNames) {
  const inv = await unlinkedInvoices(conn).where({ id: invoiceId }).first();
  if (!inv) return { skip: 'invoiceChanged' };
  const day = dateOnly(inv.service_date);
  if (!day || day >= etDateString()) return { skip: 'notPast' };
  const visits = await conn('scheduled_services').where({ customer_id: inv.customer_id })
    .whereRaw('scheduled_date::date = ?::date', [day]).whereNotIn('status', DEAD_VISIT_STATUSES).select(VISIT_DIGEST_FIELDS);
  if (visits.length !== 1) return { skip: visits.length ? 'ambiguous' : 'noVisit' };
  const svc = visits[0];
  if (svc.is_callback) return { skip: 'callback' };
  if ([svc.service_type, svc.service_key_snapshot].some(isCompositeService)) return { skip: 'compositeVisit' };
  const sameDayLive = await unlinkedInvoices(conn).where({ customer_id: inv.customer_id })
    .whereRaw('service_date::date = ?::date', [day]).select('id');
  if (sameDayLive.length !== 1 || String(sameDayLive[0].id) !== String(inv.id)) return { skip: 'ambiguous' };
  if (await conn('scheduled_service_addons').where({ scheduled_service_id: svc.id }).first('id')) return { skip: 'visitHasAddons' };
  const records = await conn('service_records').where({ scheduled_service_id: svc.id }).select('id', 'is_callback');
  if (records.some((r) => r.is_callback)) return { skip: 'callback' };
  const invoiced = await conn('invoices')
    .where((qb) => qb.where({ scheduled_service_id: svc.id }).orWhereIn('service_record_id', records.map((r) => r.id)))
    .whereNot('status', 'void').first('id');
  if (invoiced) return { skip: 'visitAlreadyInvoiced' };
  if (await conn('visit_billing_dispositions').where({ scheduled_service_id: svc.id }).first('id')) return { skip: 'dispositioned' };
  try { await assertScheduledInvoiceNotPacketOwned(conn, svc.id); } catch (err) {
    if (err.code === 'VISIT_PACKET_OWNS_BILLING') return { skip: 'packetOwned' };
    throw err;
  }
  if (!invoiceBillsVisitApplication(inv, svc, catalogNames)) return { skip: 'noEvidence' };
  const customer = await conn('customers').where({ id: inv.customer_id }).first();
  if (!customer) return { skip: 'customerChanged' };
  const billTo = await PayerService.resolveForInvoice({ database: conn, customerId: inv.customer_id,
    customer, scheduledServiceId: svc.id, throwOnError: true });
  if (String(inv.payer_id || '') !== String(billTo.payerId || '')
    || String(inv.po_number || '').trim() !== String(billTo.poNumber || '').trim()) return { skip: 'billToMismatch' };
  if (billTo.taxExempt && (Number(inv.tax_rate) !== 0 || Number(inv.tax_amount) !== 0)) return { skip: 'payerTaxMismatch' };
  const record = await canonicalCompletionRecordId(conn, svc.id, records);
  const technicianId = svc.technician_id || inv.technician_id || null;
  return { pairing: { invoiceId: inv.id, invoiceStatus: inv.status, invoiceTotal: inv.total == null ? null : Number(inv.total), serviceDate: day,
    visitId: svc.id, visitStatus: svc.status, visitService: svc.service_type || null,
    serviceRecordId: record, previousTechnicianId: inv.technician_id || null, technicianId,
    previousTechName: inv.tech_name || null, techName: technicianId === (inv.technician_id || null) ? inv.tech_name || null : null,
    digest: pairingDigest(inv, svc, record, billTo, records) } };
}

// Multiple completion/project/recap records never imply the newest is the
// canonical completion. Only a succeeded completion attempt can disambiguate.
async function canonicalCompletionRecordId(conn, scheduledServiceId, records) {
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
  return new Set(rows.map((r) => r.name).filter(Boolean));
}

async function plan(conn, days = 120) {
  const catalogNames = await catalog(conn);
  const unlinked = await unlinkedInvoices(conn)
    .whereRaw("created_at > now() - (? * interval '1 day')", [days]).orderBy('service_date').select('id');
  const pairings = []; const skipped = {};
  for (const { id } of unlinked) {
    const v = await evaluate(conn, id, catalogNames);
    if (v.pairing) pairings.push(v.pairing); else skipped[v.skip] = (skipped[v.skip] || 0) + 1;
  }
  return { version: PLAN_VERSION, plannedAt: new Date().toISOString(), days, scanned: unlinked.length, pairings, skipped };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^[0-9a-f]{64}$/;
function readPlan(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed?.version !== PLAN_VERSION) throw new Error('Unsupported plan version — generate and review a fresh plan');
  const pairs = parsed.pairings;
  if (!Array.isArray(pairs) || !pairs.length) throw new Error('Plan has no pairings — nothing to execute');
  const seen = new Set();
  for (const p of pairs) {
    if (!p || ![p.invoiceId, p.visitId].every((id) => UUID_RE.test(String(id)))
      || (p.serviceRecordId && !UUID_RE.test(String(p.serviceRecordId))) || !DIGEST_RE.test(String(p.digest || ''))) {
      throw new Error('Malformed pairing — generate and review a fresh plan');
    }
    if (seen.has(p.invoiceId)) throw new Error('Duplicate invoice in reviewed plan');
    seen.add(p.invoiceId);
  }
  return pairs;
}

function formatPairing(p) {
  return `${p.serviceDate} invoice ${p.invoiceId} (${p.invoiceStatus}, $${p.invoiceTotal}) -> visit ${p.visitId} (${p.visitStatus}, ${p.visitService}); record ${p.serviceRecordId || 'none'}; technician ${p.previousTechnicianId || 'none'} -> ${p.technicianId || 'none'}; tech_name ${JSON.stringify(p.previousTechName)} -> ${JSON.stringify(p.techName)}`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((a) => !/^--(?:days|plan-out)=.+$/.test(a))) throw new Error('Read-only planner: accepts only --days=N and --plan-out=FILE; execution is separate');
  const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const days = Number(value('days') || 120);
  if (!Number.isSafeInteger(days) || days < 1) throw new Error('--days must be a positive integer');
  if (!process.env.REPAIR_DATABASE_URL) throw new Error('REPAIR_DATABASE_URL is required');
  const knex = require('knex')({ client: 'pg', connection: process.env.REPAIR_DATABASE_URL, pool: { min: 0, max: 1 } });
  try {
    const result = await knex.transaction((trx) => plan(trx, days), { isolationLevel: 'repeatable read', readOnly: true });
    console.log(`READ-ONLY — ${result.scanned} unlinked invoice(s); ${result.pairings.length} candidate(s); skipped: ${JSON.stringify(result.skipped)}`);
    for (const p of result.pairings) console.log(formatPairing(p));
    // Always replace the artifact, including an empty result; never leave a
    // previous run's candidates in the operator's selected output file.
    if (value('plan-out')) fs.writeFileSync(value('plan-out'), JSON.stringify(result, null, 2), { mode: 0o600 });
  } finally { await knex.destroy(); }
}

if (require.main === module) void main().catch((err) => { console.error(err.message); process.exitCode = 1; });
module.exports = { evaluate, pairingDigest, readPlan, plan, catalog, formatPairing, invoiceBillsVisitApplication, isCompositeService };

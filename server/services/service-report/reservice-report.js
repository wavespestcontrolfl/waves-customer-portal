/**
 * Re-service (callback) report copy — one source for the web hero and the
 * PDF, keyed on the AUTHORITATIVE `service_records.is_callback` flag, not
 * the editable display name (audit 2026-08-30 G4).
 *
 * Dark behind GATE_RESERVICE_REPORT_COPY. Off (unset) = the payload carries
 * `isCallback` as data only and `reserviceReport: null`; the client keeps
 * its legacy name-regex headline byte-for-byte. Kill = unset the var.
 *
 * What the copy says and does NOT say:
 *  - lawn vs pest split (a lawn callback is weed/disease breakthrough —
 *    "knock activity down" was pest copy on a turf report). Any OTHER
 *    service line (the rodent trapping follow-up is a callback by key)
 *    gets NO block: this copy describes a re-treatment and would be false
 *    for a trap check.
 *  - "$0 — included with WaveGuard" is a MONEY claim on a permanent record.
 *    It prints only when (a) a member tier is frozen on the record AND
 *    (b) the linked visit is proven free: no positive estimated_price on
 *    the scheduled row (admin-schedule supports is_callback + a priced
 *    extra — a PAID callback) and no non-void invoice with a positive total
 *    linked by record OR scheduled-service id. Missing row / failed lookup
 *    ⇒ not proven ⇒ no claim.
 *    Non-member callbacks may bill (owner doctrine 2026-08-27: record-only,
 *    no enforcement), so no money claim is ever made for them.
 *  - No field observations are invented: every sentence is about what a
 *    re-service IS, not about what was found today.
 */

const { detectServiceLine } = require('./service-line-configs');

// Read at CALL time, exact `'true'` — the same rule as the sibling V2
// report gates (cockroach-report-v2.js / termite-report-v2.js) and the
// feature-gates.js table entry: a Railway flip changes the next render and
// the next PDF cache key without a deploy.
const GATE_ENV = 'GATE_RESERVICE_REPORT_COPY';
function gateOn() {
  return process.env[GATE_ENV] === 'true';
}

const WAVEGUARD_TIERS = new Set(['Bronze', 'Silver', 'Gold', 'Platinum']);
// Invoice statuses that carry no collectible claim on the customer.
const NON_COLLECTIBLE_INVOICE_STATUSES = ['void', 'cancelled', 'canceled'];

function isCallbackRecord(service = {}) {
  return service?.is_callback === true;
}

// ONLY the tier frozen on the record at completion (service_records.
// service_tier). The customer's CURRENT waveguard_tier must never qualify an
// old callback: a customer who joined WaveGuard later would get a permanent
// report claiming that older visit was included — money claims fail closed.
function memberTier(service = {}) {
  const tier = service?.service_tier || null;
  return WAVEGUARD_TIERS.has(tier) ? tier : null;
}

function positiveMoney(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0;
}

// The report's resolved line when the builder passes it; the same
// pre-render rule the sibling PDF signatures use otherwise.
function lineOf(service, serviceLine) {
  return serviceLine || service?.service_line || detectServiceLine(service?.service_type) || null;
}

const COPY = {
  lawn: {
    heading: 'we came back and took care of it!',
    result: 'Lawn re-service completed — we returned between your regular applications to re-treat the problem areas you reported.',
    completedFallback: 'Reported problem areas were re-treated today.',
    expectation: 'Lawn treatments take time to show — weeds and disease can take two to three weeks to respond after an application. Contact us if the problem areas are not improving after three weeks.',
  },
  pest: {
    heading: 'we came back and took care of it!',
    result: 'Re-service completed — we returned between your regular visits to address the activity you reported and re-treated the affected areas.',
    completedFallback: 'Reported activity areas were re-treated today.',
    expectation: 'Treatments can take several days to knock activity down fully — contact us if you are still seeing activity after two weeks.',
  },
};

/**
 * Was this callback visit actually free? Fails CLOSED: anything short of
 * positive proof (row present, no positive price, no collectible invoice)
 * reports `free: false` with the reason, and no money claim is printed.
 */
async function resolveCallbackBilling(service = {}, knex = null) {
  if (!knex) return { free: false, reason: 'no_db' };
  try {
    if (!service?.scheduled_service_id) return { free: false, reason: 'no_visit' };
    const row = await knex('scheduled_services')
      .where({ id: service.scheduled_service_id })
      .first('id', 'estimated_price', 'is_callback');
    if (!row) return { free: false, reason: 'visit_missing' };
    if (positiveMoney(row.estimated_price)) return { free: false, reason: 'priced' };
    // Linked by EITHER key: "Charge now" mints an invoice before completion
    // against scheduled_service_id only (migration 20260420000002), and a
    // positive invoice that never back-linked to the record must still
    // block the $0 claim.
    const invoice = await knex('invoices')
      .where((qb) => qb.where({ service_record_id: service.id }).orWhere({ scheduled_service_id: service.scheduled_service_id }))
      .whereNotIn('status', NON_COLLECTIBLE_INVOICE_STATUSES)
      .where('total', '>', 0)
      .first('id');
    if (invoice) return { free: false, reason: 'invoiced' };
    return { free: true, reason: 'free' };
  } catch {
    return { free: false, reason: 'lookup_failed' };
  }
}

/**
 * Payload block for a lawn/pest callback record, or null when the gate is
 * dark, the record is not a callback, or the service line is one this copy
 * does not describe.
 */
async function buildReserviceReport(service = {}, { serviceLine = null, knex = null } = {}) {
  if (!gateOn()) return null;
  if (!isCallbackRecord(service)) return null;
  const line = lineOf(service, serviceLine);
  const copy = COPY[line];
  if (!copy) return null;
  const tier = memberTier(service);
  const billing = tier ? await resolveCallbackBilling(service, knex) : { free: false, reason: 'non_member' };
  const includedWithWaveGuard = Boolean(tier) && billing.free === true;
  return {
    serviceLine: line,
    heading: copy.heading,
    result: copy.result,
    completedFallback: copy.completedFallback,
    expectation: copy.expectation,
    includedWithWaveGuard,
    billingLine: includedWithWaveGuard
      ? `This re-service was included with your WaveGuard ${tier} membership — $0.00 billed.`
      : null,
    // Why no $0 line printed (diagnostic; the client never renders it).
    billingReason: billing.reason,
  };
}

function signatureFor(block) {
  if (!block) return '';
  return block.includedWithWaveGuard ? '-rs1m' : '-rs1n';
}

/**
 * PDF cache-key component for the LOOKUP side: a gate flip, a tier
 * difference, or a billing outcome change re-renders the stored document.
 * '' while dark or for non-callback/other-line records — existing keys stay
 * byte-identical (same contract as the V2 dashboard signatures).
 */
async function reserviceReportPdfSignature(service = {}, { serviceLine = null, knex = null } = {}) {
  return signatureFor(await buildReserviceReport(service, { serviceLine, knex }));
}

/**
 * STORE side: the signature of the block the render ACTUALLY used, read
 * from the payload — never re-resolved — so a render that fell closed on a
 * transient lookup failure (no $0 line) is stored under the no-claim key,
 * not the lookup's correct-state key (same contract as
 * cockroachReportV2RenderedSignature / treatmentNarrativeRenderedSignature).
 */
function reserviceReportRenderedSignature(data, service = {}) {
  if (!gateOn()) return '';
  if (!isCallbackRecord(service)) return '';
  const block = data?.reserviceReport && typeof data.reserviceReport === 'object' ? data.reserviceReport : null;
  return signatureFor(block);
}

module.exports = {
  buildReserviceReport,
  resolveCallbackBilling,
  reserviceReportPdfSignature,
  reserviceReportRenderedSignature,
  isCallbackRecord,
};

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
 *    no enforcement), so no money claim is ever made for them. A tier that
 *    is an auto-derived LABEL is not a membership either — the claim reads
 *    ONLY the provenance FROZEN on the record (service_tier_source; NULL =
 *    pre-freeze record = unprovable = no claim; the mutable customer row is
 *    never consulted, so later membership changes cannot rewrite history).
 *  - inspection_only / customer_declined callbacks performed NO application
 *    (admin-dispatch visitPerformed), so their copy inspects/records — it
 *    never claims areas "were re-treated".
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

// Copy per line × visit outcome. `treated` is the performed-application
// default; `inspection_only` and `customer_declined` completions performed
// NO application (admin-dispatch's visitPerformed rule), so their copy must
// never claim anything was re-treated.
const COPY = {
  lawn: {
    treated: {
      heading: 'we came back and took care of it!',
      result: 'Lawn re-service completed — we returned between your regular applications to re-treat the problem areas you reported.',
      completedFallback: 'Reported problem areas were re-treated today.',
      expectation: 'Lawn treatments take time to show — weeds and disease can take two to three weeks to respond after an application. Contact us if the problem areas are not improving after three weeks.',
    },
    inspection_only: {
      heading: 'we came back to check on it!',
      result: 'Lawn re-service visit completed — we returned and inspected the problem areas you reported. No application was made on this visit.',
      completedFallback: 'Reported problem areas were inspected today.',
      expectation: 'If the problem areas are not improving, contact us and we will get back out.',
    },
    customer_declined: {
      heading: 'your visit is complete!',
      result: 'We returned for your lawn re-service; treatment was not performed at this visit.',
      completedFallback: 'No application was made today.',
      expectation: 'If the problem areas are not improving, contact us and we will get back out.',
    },
    incomplete: {
      heading: 'about your visit',
      result: 'We returned for your lawn re-service, but the visit could not be completed.',
      completedFallback: 'No application was made today.',
      expectation: 'We will follow up to finish the visit — contact us if the problem areas are getting worse in the meantime.',
    },
  },
  pest: {
    treated: {
      heading: 'we came back and took care of it!',
      result: 'Re-service completed — we returned between your regular visits to address the activity you reported and re-treated the affected areas.',
      completedFallback: 'Reported activity areas were re-treated today.',
      expectation: 'Treatments can take several days to knock activity down fully — contact us if you are still seeing activity after two weeks.',
    },
    inspection_only: {
      heading: 'we came back to check on it!',
      result: 'Re-service visit completed — we returned and inspected the areas you reported. No application was made on this visit.',
      completedFallback: 'Reported activity areas were inspected today.',
      expectation: 'If you are still seeing activity, contact us and we will get back out.',
    },
    customer_declined: {
      heading: 'your visit is complete!',
      result: 'We returned for your re-service; treatment was not performed at this visit.',
      completedFallback: 'No application was made today.',
      expectation: 'If you are still seeing activity, contact us and we will get back out.',
    },
    incomplete: {
      heading: 'about your visit',
      result: 'We returned for your re-service, but the visit could not be completed.',
      completedFallback: 'No application was made today.',
      expectation: 'We will follow up to finish the visit — contact us if you are still seeing activity in the meantime.',
    },
  },
};

const NON_PERFORMED_OUTCOMES = new Set(['inspection_only', 'customer_declined', 'incomplete']);

// Explicit param (report-data's resolved protocol.visitOutcome) wins; the
// pre-render signature paths fall back to the protocol frozen in
// service_data. Anything unrecognized renders the treated copy — the same
// default the completion billing rule applies.
function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function outcomeOf(service, visitOutcome) {
  let outcome = visitOutcome;
  if (!outcome) {
    // SAME fallback chain as buildProtocolPayload (report-data.js):
    // protocol.visitOutcome, then structured_notes.visitOutcome — a repaired
    // record with only the structured field must key the PDF under the same
    // suffix the render stored (codex r2 P2), then the raw column.
    const serviceData = parseMaybeJson(service?.service_data) || {};
    const protocol = parseMaybeJson(serviceData.protocol) || {};
    const structured = parseMaybeJson(service?.structured_notes) || {};
    outcome = protocol.visitOutcome || structured.visitOutcome || service?.visit_outcome || null;
  }
  const key = String(outcome || '').toLowerCase();
  return NON_PERFORMED_OUTCOMES.has(key) ? key : 'treated';
}

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
      .first('id', 'estimated_price', 'prepaid_amount', 'is_callback');
    if (!row) return { free: false, reason: 'visit_missing' };
    if (positiveMoney(row.estimated_price)) return { free: false, reason: 'priced' };
    // Money can be collected with NO invoice: the prepaid lane stamps
    // scheduled_services.prepaid_amount when a payment is taken up front.
    if (positiveMoney(row.prepaid_amount)) return { free: false, reason: 'prepaid' };
    // Linked by EITHER key: "Charge now" mints an invoice before completion
    // against scheduled_service_id only (migration 20260420000002), and a
    // positive invoice that never back-linked to the record must still
    // block the $0 claim.
    // invoices.status is nullable and SQL NOT IN never matches NULL — a
    // NULL-status positive invoice is COLLECTIBLE for this proof.
    const invoice = await knex('invoices')
      .where((qb) => qb.where({ service_record_id: service.id }).orWhere({ scheduled_service_id: service.scheduled_service_id }))
      .where((qb) => qb.whereNull('status').orWhereNotIn('status', NON_COLLECTIBLE_INVOICE_STATUSES))
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
async function buildReserviceReport(service = {}, { serviceLine = null, knex = null, visitOutcome = null } = {}) {
  if (!gateOn()) return null;
  if (!isCallbackRecord(service)) return null;
  const line = lineOf(service, serviceLine);
  const lineCopy = COPY[line];
  if (!lineCopy) return null;
  const outcome = outcomeOf(service, visitOutcome);
  const copy = lineCopy[outcome];
  const tier = memberTier(service);
  let billing = tier ? await resolveCallbackBilling(service, knex) : { free: false, reason: 'non_member' };
  if (billing.free === true) {
    // Membership must hold AT THE TIME OF THE VISIT, and the customer's
    // current row changes later — so the claim reads the provenance FROZEN
    // on the record at completion (service_tier_source, migration
    // 20260830000050): 'auto' was a label, and NULL/absent (a record that
    // predates the freeze) is unprovable — both refuse (codex r3 P1).
    // The frozen snapshot is the SOLE authority (codex r4 P1): re-checking
    // the CURRENT customer row would let later membership changes rewrite —
    // or churn — what a permanent report claims about a past visit, in
    // either direction. 'auto' was a label at the visit; NULL predates the
    // freeze and is unprovable; anything else was a real membership then.
    const frozenSource = service.service_tier_source;
    if (frozenSource == null || frozenSource === 'auto') {
      billing = { free: false, reason: frozenSource === 'auto' ? 'tier_label' : 'tier_provenance_unfrozen' };
    }
  }
  const includedWithWaveGuard = Boolean(tier) && billing.free === true;
  return {
    serviceLine: line,
    outcome,
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
  const outcomeKey = block.outcome === 'inspection_only' ? 'i'
    : block.outcome === 'customer_declined' ? 'd'
      : block.outcome === 'incomplete' ? 'x' : 't';
  return `${block.includedWithWaveGuard ? '-rs1m' : '-rs1n'}${outcomeKey}`;
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

// Payload marker: TRUE means the server ran the gated composer, so a null
// `reserviceReport` on a callback is a DELIBERATE withholding (unsupported
// service line) — the client must not fall back to the legacy name-regex
// pest copy for it (codex #3617 GH-r2 P1).
function reserviceReportCopyGateOn() {
  return gateOn();
}

module.exports = {
  buildReserviceReport,
  reserviceReportCopyGateOn,
  resolveCallbackBilling,
  reserviceReportPdfSignature,
  reserviceReportRenderedSignature,
  isCallbackRecord,
};

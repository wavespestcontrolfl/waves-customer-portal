'use strict';

/**
 * Shared CTA service-request writer — ONE mechanism for every customer
 * surface whose tap files a staff-actionable "add service" request (today:
 * the report cross-sell card and the portal home recommendations).
 *
 * Extracted from reports-public's cross-sell click path (codex pre-push P1
 * on the portal lane): two surface-scoped writers would let a customer tap
 * the same service on the report AND the portal and mint two open rows and
 * two staff bells. The open-row lookup here spans every CTA source, so the
 * second tap refreshes the one row with the latest validated snapshot
 * instead.
 */

const { stableStringify } = require('./service-report/ai-summary');
const { OPEN_REQUEST_TERMINAL_STATUSES } = require('./estimate-add-service-request');

const parseJsonOrNull = (value) => { try { return JSON.parse(value); } catch { return null; } };

// Does a stored service_requests.pricing_revision already hold exactly this
// offer snapshot? Compared STRUCTURALLY (codex #3367 PR r11 P2):
// pricing_revision is JSONB, so PostgreSQL stores it decomposed and returns
// its own canonical key order — and its own numeric form (114.00 → 114.00,
// not 114). A raw string compare against a freshly serialized object
// therefore misses on ordering alone, so an identical repeat tap would churn
// the row and mint another event row instead of being the intended no-op.
// Both sides are parsed to JS values and canonically serialized; an
// unparsable stored value simply fails to match and takes the refresh path.
function storedRevisionMatches(stored, snapshot) {
  const prior = typeof stored === 'string' ? parseJsonOrNull(stored) : (stored ?? null);
  // mintedEstimate is row LINKAGE the mint hook stamps AFTER the snapshot is
  // stored (click-to-estimate lane) — it records which estimate this request
  // minted, and the freshly recomputed snapshot can never carry it. Leaving
  // it in the compare would make every repeat tap on a minted offer look
  // like a material refresh, churning the row and superseding a perfectly
  // valid estimate on each tap.
  const comparable = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const { mintedEstimate, ...rest } = value;
    return rest;
  };
  return stableStringify(comparable(prior)) === stableStringify(comparable(snapshot));
}

// Sources that share one open-request slot per (customer, requested service).
const CTA_REQUEST_SOURCES = ['service_report', 'portal_home'];

// One transaction, serialized per customer (the row lock makes
// check-then-insert idempotent — the estimate flow's partial-unique index
// only covers estimate-linked rows; CTA rows have estimate_id NULL).
// Outcomes:
//   { deduped: true, request }         — identical snapshot + subject: pure
//                                        no-op, no row churn, no onWrite.
//                                        `request` is the existing open row
//                                        (the mint hook resolves its linked
//                                        estimate from it).
//   { request, refreshed: true }       — open row existed, snapshot moved:
//                                        the stored shown-price lock now
//                                        reflects what the customer just saw.
//   { request }                        — first open request.
// onWrite(trx) runs INSIDE the transaction after a row write (never on the
// dedupe no-op) — the report path records its analytics event there so the
// event can never claim a request that has no actionable record.
// withRow(trx, { row, deduped, refreshed, priorPricingRevision }) runs on
// EVERY outcome, dedupe included, still inside the transaction — the seam
// for work that must stay consistent with the row across repeat taps (the
// click-to-estimate mint reuses or supersedes its estimate here).
// priorPricingRevision is the row's pre-call pricing_revision: on a refresh
// the row write above has already replaced the stored snapshot, and any
// linkage the previous snapshot carried (mintedEstimate) would otherwise be
// unreachable exactly when the hook needs it to supersede. A withRow throw
// rolls back the whole outcome, row write included.
async function writeOrRefreshCtaRequest(db, {
  customerId, requestedService, source, subject, description, revisionSnapshot,
  onWrite = null, withRow = null,
}) {
  return db.transaction(async (trx) => {
    await trx('customers').where({ id: customerId }).forUpdate().first('id');
    const existing = await trx('service_requests')
      .where({ customer_id: customerId, requested_service: requestedService })
      .whereIn('source', CTA_REQUEST_SOURCES)
      .whereNotIn('status', OPEN_REQUEST_TERMINAL_STATUSES)
      .orderBy('created_at', 'desc')
      .first();
    const priorPricingRevision = existing
      ? (typeof existing.pricing_revision === 'string'
        ? parseJsonOrNull(existing.pricing_revision)
        : (existing.pricing_revision ?? null))
      : null;
    if (existing) {
      if (storedRevisionMatches(existing.pricing_revision, revisionSnapshot)
        && existing.subject === subject) {
        if (withRow) {
          await withRow(trx, {
            row: existing, deduped: true, refreshed: false, priorPricingRevision,
          });
        }
        return { deduped: true, request: existing };
      }
      // A refresh is a MATERIAL change, not a no-op (codex #3367 PR r12):
      // the customer just price-locked a different offer — another surface,
      // another price, quote→priced. updated_at is stamped so the row does
      // not sit frozen at its created_at.
      await trx('service_requests').where({ id: existing.id }).update({
        subject,
        description,
        pricing_revision: JSON.stringify(revisionSnapshot),
        updated_at: new Date(),
      });
      if (onWrite) await onWrite(trx);
      if (withRow) {
        await withRow(trx, {
          row: existing, deduped: false, refreshed: true, priorPricingRevision,
        });
      }
      return { request: existing, refreshed: true };
    }
    const [request] = await trx('service_requests').insert({
      customer_id: customerId,
      requested_service: requestedService,
      source,
      category: 'add_service',
      subject,
      description,
      urgency: 'routine',
      status: 'new',
      // The server-computed offer snapshot — the shown price is the honored
      // price (sent-quote price-lock doctrine).
      pricing_revision: JSON.stringify(revisionSnapshot),
    }).returning('*');
    if (onWrite) await onWrite(trx);
    if (withRow) {
      await withRow(trx, {
        row: request, deduped: false, refreshed: false, priorPricingRevision: null,
      });
    }
    return { request };
  });
}

module.exports = { storedRevisionMatches, writeOrRefreshCtaRequest, CTA_REQUEST_SOURCES };

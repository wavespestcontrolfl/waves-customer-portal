const db = require('../models/db');
const logger = require('./logger');
const { flatView, isV2Extraction } = require('../utils/extraction-compat');

const FIELD_PATHS = {
  first_name: ['/caller/first_name', '/caller/name_full'],
  last_name: ['/caller/last_name', '/caller/name_full'],
  email: ['/caller/email'],
  phone: ['/caller/phone_e164', '/caller/phone_raw_spoken'],
  address_line1: ['/property/service_address', '/property/service_address/street_line_1'],
  // Unit/suite corrections ("it's unit 4B, not 4") surface via flatView as
  // address_line2 — staged so the contact-correction proposal lane can see
  // them (codex #3413 r4).
  address_line2: ['/property/service_address', '/property/service_address/street_line_2', '/property/service_address/unit'],
  city: ['/property/service_address', '/property/service_address/city'],
  state: ['/property/service_address', '/property/service_address/state'],
  zip: ['/property/service_address', '/property/service_address/postal_code'],
  requested_service: ['/service_request/primary_service_category'],
  matched_service: ['/service_request/primary_service_category'],
};

const CANDIDATE_FIELDS = Object.keys(FIELD_PATHS);

let tableCache = new Map();

async function tableExists(name) {
  if (tableCache.has(name)) return tableCache.get(name);
  const exists = await db.schema.hasTable(name).catch(() => false);
  tableCache.set(name, exists);
  return exists;
}

function findEvidence(v2Extraction, field) {
  const paths = FIELD_PATHS[field] || [];
  const evidence = Array.isArray(v2Extraction?.evidence) ? v2Extraction.evidence : [];
  // Most-specific path wins, not evidence order (codex #3413 r18): a
  // generic /property/service_address item listed before a unit-specific
  // one would otherwise pin the street quote to address_line2, and the
  // correction lane then discards a genuine unit correction for lacking
  // intent in its quote (or bells the wrong evidence). Ties keep the
  // first evidence item, preserving the old behavior within a
  // specificity level.
  let best = null;
  let bestLen = -1;
  for (const item of evidence) {
    if (!item?.quote) continue;
    const fieldPath = String(item.field_path || '');
    for (const path of paths) {
      if (fieldPath.startsWith(path) && path.length > bestLen) {
        best = item;
        bestLen = path.length;
      }
    }
  }
  return best;
}

function confidence(v2Extraction, key, fallback = null) {
  const value = v2Extraction?.confidence?.[key];
  return typeof value === 'number' ? value : fallback;
}

function confidenceForField(v2Extraction, field) {
  if (!isV2Extraction(v2Extraction)) return null;
  if (field === 'address_line1' || field === 'address_line2' || field === 'city' || field === 'state' || field === 'zip') {
    return confidence(v2Extraction, 'service_address');
  }
  if (field === 'matched_service' || field === 'requested_service') {
    return confidence(v2Extraction, 'primary_service_category');
  }
  if (field === 'first_name' || field === 'last_name') {
    return confidence(v2Extraction, 'caller_identity');
  }
  return null;
}

function buildCustomerFieldCandidates({ callId, customerId = null, extraction, v2Extraction = null }) {
  if (!callId || !extraction) return [];
  const hasV2 = isV2Extraction(v2Extraction);
  const flat = flatView(hasV2 ? v2Extraction : extraction);
  const source = hasV2 ? 'gemini_v2' : 'legacy_gemini';

  return CANDIDATE_FIELDS
    .map((field) => {
      const value = flat[field];
      if (value === null || value === undefined || value === '') return null;
      const evidence = hasV2 ? findEvidence(v2Extraction, field) : null;

      return {
        call_log_id: callId,
        customer_id: customerId,
        field_name: field,
        extracted_value: String(value),
        enriched_value: String(value),
        final_recommended_value: String(value),
        evidence_quote: evidence?.quote || null,
        source,
        confidence: confidenceForField(v2Extraction, field),
        reason_code: evidence ? 'evidence_pinned' : 'observed_only',
        status: 'pending',
      };
    })
    .filter(Boolean);
}

async function stageCustomerFieldCandidates(args = {}) {
  const { procToken = null } = args;
  const rows = buildCustomerFieldCandidates(args);
  if (!rows.length || !(await tableExists('customer_field_candidates'))) {
    return { staged: 0, skipped: rows.length };
  }

  let staged = 0;
  // Ids of the rows carrying THIS pass's extracted values — newly inserted
  // or already present via the value-keyed dedupe. The correction consumer
  // scopes to these so a stale worker's rows (different values, no
  // provenance) can never ride an owning pass's valid token (round-14).
  const stagedIds = [];
  for (const row of rows) {
    try {
      const existing = await db('customer_field_candidates')
        .where({
          call_log_id: row.call_log_id,
          field_name: row.field_name,
          source: row.source,
        })
        .where('final_recommended_value', row.final_recommended_value)
        .first('id', 'customer_id', 'status');
      if (existing) {
        // Linkage can change between passes (an unlinked call later linked
        // and force-reprocessed): a same-value row carrying the old/null
        // customer_id would be returned as this pass's provenance and then
        // filtered out by the runner's customer scope, silently dropping
        // the correction (codex #3413 r17). Relink a still-pending row to
        // the current linkage; a row already resolved under the OLD
        // linkage is history — stage a fresh row instead.
        if ((existing.customer_id || null) === (row.customer_id || null)) {
          stagedIds.push(existing.id);
          continue;
        }
        if (existing.status === 'pending') {
          // The relink is fenced to the pass that owns the call's
          // processing token (codex #3413 r18): a timed-out processor
          // overlapping the worker that reclaimed its claim must not move
          // the row back to the stale linkage after the owner relinked it
          // — the call_log row is locked token-conditioned in the same
          // transaction, so a reclaim (which rewrites processing_token)
          // serializes against this write. A pass whose token is gone
          // skips the relink AND the provenance id: it fails closed, same
          // as its own downstream token check.
          const relinked = await db.transaction(async (trx) => {
            if (procToken) {
              const held = await trx('call_log')
                .where({ id: row.call_log_id })
                .where('processing_token', procToken)
                .forUpdate()
                .first('id');
              if (!held) return false;
            }
            await trx('customer_field_candidates')
              .where({ id: existing.id, status: 'pending' })
              .update({ customer_id: row.customer_id || null, updated_at: trx.fn.now() });
            return true;
          });
          if (relinked) stagedIds.push(existing.id);
          else logger.warn(`[call-candidates] relink fenced out for call ${row.call_log_id} (processing token lost)`);
          continue;
        }
      }
      const inserted = await db('customer_field_candidates').insert(row).returning('id');
      const id = inserted?.[0]?.id ?? inserted?.[0];
      if (id != null) stagedIds.push(id);
      staged += 1;
    } catch (err) {
      logger.warn(`[call-candidates] candidate skipped for call ${row.call_log_id}: ${err.message}`);
    }
  }

  return { staged, skipped: rows.length - staged, stagedIds };
}

function __resetForTests() {
  tableCache = new Map();
}

module.exports = {
  buildCustomerFieldCandidates,
  stageCustomerFieldCandidates,
  __resetForTests,
};

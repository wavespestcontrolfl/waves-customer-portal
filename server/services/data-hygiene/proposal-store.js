const crypto = require('crypto');
const db = require('../../models/db');
const {
  hashSensitiveValue,
  redactSensitiveValue,
  vaultStoreSensitive,
} = require('./sensitive-vault');

function stableJson(value) {
  if (value === undefined) return 'null';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function buildIdempotencyKey(proposal) {
  const evidence = proposal.evidence || {};
  const evidenceSourceType = evidence.evidence_source_type || evidence.source_type || '';
  const evidenceSourceId = evidence.evidence_source_id || evidence.source_id || evidence.message_id || evidence.call_id || '';
  const parts = [
    proposal.resource_type,
    proposal.resource_id || '',
    proposal.scope_type,
    proposal.scope_id,
    proposal.field,
    proposal.source === 'normalization' ? stableJson(proposal.current_value) : '',
    stableJson(proposal.proposed_value),
    proposal.source,
    proposal.rule_id,
    proposal.rule_version,
    evidenceSourceType,
    evidenceSourceId,
  ];
  return sha256(parts.join('|'));
}

function isSensitiveProposal(proposal) {
  const rule = String(proposal.rule_id || '');
  const field = String(proposal.field || '');
  return /extract\.(gate_code|lockbox_code|garage_code|access_notes|parking_notes|pet_details)/.test(rule)
    || /(^|_)(gate_code|lockbox_code|garage_code|access_notes|parking_notes|pet_details)$/.test(field);
}

async function upsertProposal(proposal, { trx = null, run_id = null } = {}) {
  const client = trx || db;
  const isSensitive = isSensitiveProposal(proposal) || proposal.is_sensitive === true;
  if (isSensitive) {
    throw new Error('Sensitive data-hygiene proposals require vault-backed redaction before insertion');
  }

  const idempotencyKey = proposal.idempotency_key || buildIdempotencyKey(proposal);
  const row = {
    run_id,
    rule_id: proposal.rule_id,
    rule_version: proposal.rule_version,
    resource_type: proposal.resource_type,
    resource_id: proposal.resource_id || null,
    scope_type: proposal.scope_type,
    scope_id: proposal.scope_id,
    field: proposal.field,
    current_value: JSON.stringify(proposal.current_value === undefined ? null : proposal.current_value),
    proposed_value: JSON.stringify(proposal.proposed_value === undefined ? null : proposal.proposed_value),
    source: proposal.source,
    confidence: proposal.confidence,
    tier: proposal.tier,
    evidence: JSON.stringify(proposal.evidence || {}),
    is_sensitive: false,
    status: proposal.status || 'pending',
    idempotency_key: idempotencyKey,
  };

  const inserted = await client('data_hygiene_proposals')
    .insert(row)
    .onConflict('idempotency_key')
    .ignore()
    .returning(['id']);

  return {
    inserted: inserted.length > 0,
    id: inserted[0]?.id || null,
    idempotency_key: idempotencyKey,
  };
}

async function upsertSensitiveProposal(proposal, { trx = null, run_id = null } = {}) {
  const client = trx || db;
  if (!isSensitiveProposal(proposal) && proposal.is_sensitive !== true) {
    throw new Error('upsertSensitiveProposal requires a sensitive proposal');
  }

  const insertWithVault = async (transaction) => {
    const idempotencyKey = proposal.idempotency_key || buildIdempotencyKey(proposal);
    const beforeHash = hashSensitiveValue(proposal.current_value);
    const afterHash = hashSensitiveValue(proposal.proposed_value);
    const evidence = {
      ...(proposal.evidence || {}),
      before_hash: beforeHash,
      after_hash: afterHash,
    };
    const row = {
      run_id,
      rule_id: proposal.rule_id,
      rule_version: proposal.rule_version,
      resource_type: proposal.resource_type,
      resource_id: proposal.resource_id || null,
      scope_type: proposal.scope_type,
      scope_id: proposal.scope_id,
      field: proposal.field,
      current_value: JSON.stringify(redactSensitiveValue(proposal.current_value, proposal.field)),
      proposed_value: JSON.stringify(redactSensitiveValue(proposal.proposed_value, proposal.field)),
      source: proposal.source,
      confidence: proposal.confidence,
      tier: proposal.tier,
      evidence: JSON.stringify(evidence),
      is_sensitive: true,
      status: proposal.status || 'pending',
      idempotency_key: idempotencyKey,
    };

    const inserted = await transaction('data_hygiene_proposals')
      .insert(row)
      .onConflict('idempotency_key')
      .ignore()
      .returning(['id']);

    if (!inserted.length) {
      return {
        inserted: false,
        id: null,
        idempotency_key: idempotencyKey,
      };
    }

    const proposalId = inserted[0].id;
    await vaultStoreSensitive({
      trx: transaction,
      proposal_id: proposalId,
      field: proposal.field,
      before_raw: proposal.current_value === undefined ? null : proposal.current_value,
      after_raw: proposal.proposed_value === undefined ? null : proposal.proposed_value,
    });

    return {
      inserted: true,
      id: proposalId,
      idempotency_key: idempotencyKey,
    };
  };

  return trx ? insertWithVault(client) : client.transaction(insertWithVault);
}

async function stalePendingNormalizationForResource({
  resource_type,
  resource_id,
  currentValues,
  trx = null,
}) {
  const client = trx || db;
  const rows = await client('data_hygiene_proposals')
    .select('id', 'field', 'current_value', 'proposed_value')
    .where({
      resource_type,
      resource_id,
      source: 'normalization',
      status: 'pending',
    });

  const staleIds = [];
  for (const row of rows) {
    if (!Object.prototype.hasOwnProperty.call(currentValues, row.field)) continue;

    const actual = currentValues[row.field] === undefined ? null : currentValues[row.field];
    const proposed = row.proposed_value === undefined ? null : row.proposed_value;
    const original = row.current_value === undefined ? null : row.current_value;

    if (stableJson(actual) === stableJson(proposed) || stableJson(actual) !== stableJson(original)) {
      staleIds.push(row.id);
    }
  }

  if (staleIds.length) {
    const updated = await client('data_hygiene_proposals')
      .whereIn('id', staleIds)
      .where({ status: 'pending' })
      .update({ status: 'stale', updated_at: db.fn.now() });
    return Number(updated) || 0;
  }

  return 0;
}

// Retire pending extraction proposals for a field an automatic writer has
// just filled: approve would fail their before-value check anyway, and the
// live value is the customer's own message. Same status the normalization
// sweep uses when a live value moves under a proposal.
// `notNewerThan` limits the retirement to siblings whose source evidence is
// no newer than the given instant (evidence without a source_at counts as
// older), so a retried older message cannot displace a newer proposal.
// Existing proposals link to either source table; resolve their Twilio identity
// as well as newly stamped identities. Timestamps alone never establish twins.
const EXTRACTION_MESSAGE_SID = `COALESCE(evidence->>'twilio_sid',
  (SELECT twilio_sid FROM sms_log WHERE id = NULLIF(data_hygiene_proposals.evidence->>'sms_log_id', '')::uuid),
  (SELECT twilio_sid FROM messages WHERE id = NULLIF(data_hygiene_proposals.evidence->>'message_id', '')::uuid))`;

async function findSmsExtractionProposals({ trx, scope_id, sms_log_id, twilio_sid }) {
  // Rejection does not take the preference advisory lock. Keep dispositions
  // stable until the replay transaction commits, including terminal rows.
  return trx('data_hygiene_proposals')
    .where({ scope_type: 'customer', scope_id, source: 'message-extraction', resource_type: 'property_preferences' })
    .where(function sameMessage() {
      this.whereRaw("evidence->>'sms_log_id' = ?", [sms_log_id]);
      if (twilio_sid) this.orWhereRaw(`${EXTRACTION_MESSAGE_SID} = ?`, [twilio_sid]);
    }).orderBy('created_at', 'desc').orderBy('id').forUpdate().select('id', 'field', 'status', 'evidence');
}

async function stalePendingExtractionProposals({ trx = null, scope_id, field, source = 'message-extraction', notNewerThan = null, sameMessageSid = null }) {
  const client = trx || db;
  const query = client('data_hygiene_proposals')
    .where({ resource_type: 'property_preferences', scope_type: 'customer', scope_id, field, source, status: 'pending' });
  if (notNewerThan) {
    query.where((candidate) => {
      candidate.whereRaw("(evidence->>'source_at') IS NULL OR (evidence->>'source_at')::timestamptz <= ?", [new Date(notNewerThan)]);
      if (sameMessageSid) candidate.orWhereRaw(`${EXTRACTION_MESSAGE_SID} = ?`, [sameMessageSid]);
    });
  }
  // Return affected identities so replay can bind every retired sibling to
  // the operator's preview. Other writers do not need the returned rows.
  return query.update({ status: 'stale', updated_at: client.fn.now() }, ['id']);
}

// The pending sibling an extraction writer must not stack a second entry on.
async function findPendingExtractionProposal({ trx = null, scope_id, field, source = 'message-extraction', newerThan = null, sameMessageSid = null, keepTwin = false }) {
  const client = trx || db;
  const query = client('data_hygiene_proposals')
    .where({ resource_type: 'property_preferences', scope_type: 'customer', scope_id, field, source, status: 'pending' });
  if (newerThan) {
    query.where((candidate) => {
      candidate.whereRaw("(evidence->>'source_at')::timestamptz > ?", [new Date(newerThan)]);
      if (sameMessageSid) {
        candidate.whereRaw(`${EXTRACTION_MESSAGE_SID} IS DISTINCT FROM ?`, [sameMessageSid]);
        if (keepTwin) candidate.orWhereRaw(`${EXTRACTION_MESSAGE_SID} = ?`, [sameMessageSid]);
      }
    });
  }
  if (trx) query.forUpdate();
  return query.first('id');
}

module.exports = {
  buildIdempotencyKey,
  stableJson,
  upsertProposal,
  upsertSensitiveProposal,
  stalePendingNormalizationForResource,
  stalePendingExtractionProposals,
  findPendingExtractionProposal,
  findSmsExtractionProposals,
  isSensitiveProposal,
};

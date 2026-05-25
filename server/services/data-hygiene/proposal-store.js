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

module.exports = {
  buildIdempotencyKey,
  stableJson,
  upsertProposal,
  upsertSensitiveProposal,
  stalePendingNormalizationForResource,
  isSensitiveProposal,
};

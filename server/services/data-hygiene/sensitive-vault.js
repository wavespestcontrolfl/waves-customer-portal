const crypto = require('crypto');
const db = require('../../models/db');
const { recordAuditEvent } = require('../audit-log');

const NULL_SENTINEL = '__DATA_HYGIENE_NULL__';

function stableValueString(value) {
  return value === null || value === undefined ? NULL_SENTINEL : JSON.stringify(value);
}

function hashSensitiveValue(value, key = vaultKey()) {
  return crypto
    .createHmac('sha256', key)
    .update(stableValueString(value))
    .digest('hex');
}

function redactSensitiveValue(value, field = '') {
  if (value === null || value === undefined) {
    return null;
  }

  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const length = raw.length;
  const isCode = /(^|_)(gate_code|lockbox_code|garage_code)$/.test(field);

  if (isCode) {
    return { masked: '*'.repeat(Math.min(Math.max(length, 1), 8)), length };
  }

  if (length <= 2) {
    return { masked: '*'.repeat(length), length };
  }

  return {
    masked: `${raw[0]}${'*'.repeat(Math.min(length - 2, 12))}${raw[length - 1]}`,
    length,
  };
}

function vaultKey() {
  const key = process.env.DATA_HYGIENE_VAULT_KEY;
  if (!key) {
    throw new Error('DATA_HYGIENE_VAULT_KEY is required for sensitive data-hygiene vault access');
  }
  return key;
}

async function vaultStoreSensitive({
  trx = null,
  proposal_id,
  field,
  before_raw = null,
  after_raw = null,
}) {
  const conn = trx || db;
  const key = vaultKey();
  const beforeText = before_raw === null || before_raw === undefined ? null : stableValueString(before_raw);
  const afterText = after_raw === null || after_raw === undefined ? null : stableValueString(after_raw);
  const beforeHash = hashSensitiveValue(before_raw, key);
  const afterHash = hashSensitiveValue(after_raw, key);

  const [row] = await conn('data_hygiene_sensitive_vault')
    .insert({
      proposal_id,
      field,
      before_hash: beforeHash,
      after_hash: afterHash,
      before_encrypted: beforeText === null ? null : conn.raw('pgp_sym_encrypt(?, ?)', [beforeText, key]),
      after_encrypted: afterText === null ? null : conn.raw('pgp_sym_encrypt(?, ?)', [afterText, key]),
    })
    .onConflict(['proposal_id', 'field'])
    .merge({
      before_hash: beforeHash,
      after_hash: afterHash,
      before_encrypted: beforeText === null ? null : conn.raw('pgp_sym_encrypt(?, ?)', [beforeText, key]),
      after_encrypted: afterText === null ? null : conn.raw('pgp_sym_encrypt(?, ?)', [afterText, key]),
    })
    .returning(['id', 'before_hash', 'after_hash']);

  return row;
}

async function vaultAttachAuditLog({ trx = null, vault_id, audit_log_id }) {
  const conn = trx || db;
  await conn('data_hygiene_sensitive_vault')
    .where({ id: vault_id })
    .update({ audit_log_id });
}

async function vaultReadSensitive({
  trx = null,
  vault_id,
  actor_id,
  reason = 'data_hygiene_sensitive_read',
}) {
  const conn = trx || db;
  const key = vaultKey();
  const { rows } = await conn.raw(`
    SELECT
      id,
      proposal_id,
      audit_log_id,
      field,
      before_hash,
      after_hash,
      CASE WHEN before_encrypted IS NULL THEN NULL ELSE pgp_sym_decrypt(before_encrypted, ?) END AS before_text,
      CASE WHEN after_encrypted IS NULL THEN NULL ELSE pgp_sym_decrypt(after_encrypted, ?) END AS after_text
    FROM data_hygiene_sensitive_vault
    WHERE id = ?
  `, [key, key, vault_id]);

  const row = rows[0];
  if (!row) {
    return null;
  }

  await recordAuditEvent({
    actor_type: 'technician',
    actor_id: actor_id || null,
    action: 'data_hygiene.vault.read',
    resource_type: 'data_hygiene_sensitive_vault',
    resource_id: vault_id,
    metadata: {
      proposal_id: row.proposal_id,
      audit_log_id: row.audit_log_id || null,
      field: row.field,
      reason,
    },
    critical: true,
    trx,
  });

  return {
    id: row.id,
    proposal_id: row.proposal_id,
    audit_log_id: row.audit_log_id,
    field: row.field,
    before_hash: row.before_hash,
    after_hash: row.after_hash,
    before_raw: row.before_text === null ? null : JSON.parse(row.before_text),
    after_raw: row.after_text === null ? null : JSON.parse(row.after_text),
  };
}

module.exports = {
  hashSensitiveValue,
  redactSensitiveValue,
  vaultStoreSensitive,
  vaultAttachAuditLog,
  vaultReadSensitive,
};

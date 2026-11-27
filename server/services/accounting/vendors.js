/**
 * Vendor Master & W-9 / 1099-NEC Ledger.
 *
 * Sensitive TIN/EIN values are encrypted strictly in the Node application layer
 * with AES-256-GCM (never passed in Postgres SQL parameters) using a dedicated key
 * (ACCOUNTING_TIN_KEY, falling back to DATA_HYGIENE_VAULT_KEY) and masked to last-4
 * on all API responses.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const { recordAuditEvent } = require('../audit-log');
const { AccountingError, assertValidDate, assertOptionalUuid } = require('./ledger');

const ENTITY_TYPES = new Set([
  'individual', 'sole_prop', 'single_member_llc', 'partnership', 's_corp', 'c_corp', 'government', 'unknown',
]);

function deriveTinKey() {
  const raw = process.env.ACCOUNTING_TIN_KEY || process.env.DATA_HYGIENE_VAULT_KEY || '';
  if (!raw || raw.length < 16) return null;
  return crypto.createHash('sha256').update(`waves-gl-tin-v1:${raw}`).digest();
}

function encryptTin(rawTin) {
  const digits = String(rawTin || '').replace(/\D/g, '');
  if (digits.length !== 9) {
    throw new AccountingError(400, 'TIN/EIN must contain exactly 9 digits');
  }
  const key = deriveTinKey();
  if (!key) {
    throw new AccountingError(503, 'ACCOUNTING_TIN_KEY is not configured — refusing to store TIN');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(digits, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    tin_last4: digits.slice(-4),
    tin_enc: `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`,
  };
}

function publicVendor(row) {
  if (!row) return null;
  const copy = { ...row };
  delete copy.tin_enc;
  return {
    ...copy,
    w9_received_at: row.w9_received_at ? String(row.w9_received_at).slice(0, 10) : null,
    has_tin: Boolean(row.tin_enc),
  };
}

async function listVendors({ includeInactive = false, conn = db } = {}) {
  let q = conn('gl_vendors as v')
    .leftJoin('gl_accounts as a', 'a.id', 'v.default_account_id')
    .orderBy('v.display_name', 'asc')
    .select('v.*', 'a.code as default_account_code', 'a.name as default_account_name');
  if (!includeInactive) q = q.where('v.active', true);
  const rows = await q;
  return rows.map(publicVendor);
}

const STRING_VENDOR_FIELDS = [
  ['legalName', 'legal_name', 200],
  ['email', 'email', 200],
  ['phone', 'phone', 40],
  ['addressLine1', 'address_line1', 200],
  ['city', 'city', 100],
  ['state', 'state', 20],
  ['zip', 'zip', 20],
  ['notes', 'notes', 1000],
];

function readPair(obj, camel, snake) {
  if (obj[camel] !== undefined) return { present: true, value: obj[camel] };
  if (obj[snake] !== undefined) return { present: true, value: obj[snake] };
  return { present: false, value: undefined };
}

function parseVendorFields(input, isCreate) {
  const fields = {};
  const display = readPair(input, 'displayName', 'display_name');
  if (isCreate || display.present) {
    const name = String(display.value ?? '').trim();
    if (!name || name.length > 160) throw new AccountingError(400, 'displayName is required (max 160 chars)');
    fields.display_name = name;
  }

  const entity = readPair(input, 'entityType', 'entity_type');
  if (entity.present) {
    const et = String(entity.value ?? 'unknown').trim();
    if (!ENTITY_TYPES.has(et)) throw new AccountingError(400, `Invalid entityType: ${et}`);
    fields.entity_type = et;
  }

  const elig = readPair(input, 'is1099Eligible', 'is_1099_eligible');
  if (elig.present) fields.is_1099_eligible = Boolean(elig.value);

  const w9 = readPair(input, 'w9ReceivedAt', 'w9_received_at');
  if (w9.present) fields.w9_received_at = w9.value ? assertValidDate(String(w9.value).trim(), 'w9ReceivedAt') : null;

  const defAcct = readPair(input, 'defaultAccountId', 'default_account_id');
  if (defAcct.present) fields.default_account_id = assertOptionalUuid(defAcct.value, 'defaultAccountId');

  for (const [camel, col, max] of STRING_VENDOR_FIELDS) {
    const pair = readPair(input, camel, col);
    if (pair.present) fields[col] = pair.value ? String(pair.value).trim().slice(0, max) : null;
  }

  if (input.tin != null && String(input.tin).trim() !== '') {
    Object.assign(fields, encryptTin(input.tin));
  }
  if (input.active !== undefined) fields.active = Boolean(input.active);
  return fields;
}

async function createVendor(input, { actorId = null, requestMeta = {}, conn = db } = {}) {
  const fields = parseVendorFields(input || {}, true);

  return conn.transaction(async (trx) => {
    const dup = await trx('gl_vendors')
      .whereRaw('lower(trim(display_name)) = lower(trim(?))', [fields.display_name])
      .first('id');
    if (dup) throw new AccountingError(409, `Vendor "${fields.display_name}" already exists`);

    const [created] = await trx('gl_vendors').insert(fields).returning('*');
    await recordAuditEvent({
      actor_type: actorId ? 'technician' : 'system',
      actor_id: actorId,
      action: 'accounting.vendor.create',
      resource_type: 'gl_vendor',
      resource_id: created.id,
      metadata: {
        display_name: created.display_name,
        entity_type: created.entity_type,
        is_1099_eligible: created.is_1099_eligible,
        tin_stored: Boolean(created.tin_enc),
      },
      ip_address: requestMeta.ip || null,
      user_agent: requestMeta.userAgent || null,
      critical: true,
      trx,
    });
    return publicVendor(created);
  });
}

async function updateVendor(id, input, { actorId = null, requestMeta = {}, conn = db } = {}) {
  const validId = assertOptionalUuid(id, 'id');
  if (!validId) throw new AccountingError(400, 'Vendor id is required');
  const fields = parseVendorFields(input || {}, false);
  if (!Object.keys(fields).length) throw new AccountingError(400, 'Nothing to update');

  return conn.transaction(async (trx) => {
    const existing = await trx('gl_vendors').where({ id: validId }).forUpdate().first();
    if (!existing) throw new AccountingError(404, 'Vendor not found');

    const [updated] = await trx('gl_vendors')
      .where({ id: validId })
      .update({ ...fields, updated_at: trx.fn.now() })
      .returning('*');

    await recordAuditEvent({
      actor_type: actorId ? 'technician' : 'system',
      actor_id: actorId,
      action: 'accounting.vendor.update',
      resource_type: 'gl_vendor',
      resource_id: validId,
      metadata: { changed_fields: Object.keys(fields).filter((k) => k !== 'tin_enc') },
      ip_address: requestMeta.ip || null,
      user_agent: requestMeta.userAgent || null,
      critical: true,
      trx,
    });
    return publicVendor(updated);
  });
}

module.exports = {
  ENTITY_TYPES,
  encryptTin,
  publicVendor,
  listVendors,
  createVendor,
  updateVendor,
};

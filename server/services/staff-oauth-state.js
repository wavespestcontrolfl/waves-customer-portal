const crypto = require('crypto');
const db = require('../models/db');

const OAUTH_STATE_RE = /^[A-Za-z0-9_-]{43}$/;

function invalidStateError() {
  return Object.assign(new Error('Invalid or expired OAuth state'), {
    code: 'STAFF_OAUTH_STATE_INVALID',
  });
}

function integerTokenVersion(value) {
  if (value === null || value === undefined || value === '') return null;
  const version = Number(value);
  return Number.isInteger(version) && version >= 1 ? version : null;
}

function parseStatePayload(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function assertInitiatingAdmin(technician) {
  const tokenVersion = integerTokenVersion(technician?.auth_token_version);
  if (
    !technician?.id
    || !technician.active
    || technician.role !== 'admin'
    || technician.must_change_password
    || tokenVersion === null
  ) {
    throw new Error('A current admin session is required to start OAuth');
  }
  return tokenVersion;
}

/**
 * Persist an opaque, one-time OAuth state bound to the initiating admin's
 * current credential version. system_settings is used for every integration so
 * callbacks can atomically claim their own row without schema changes.
 */
async function createStaffOAuthState({
  prefix,
  technician,
  ttlMs,
  metadata = {},
  description = 'Staff OAuth one-time state',
}, connection = db) {
  if (!prefix || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('OAuth state prefix and positive ttlMs are required');
  }
  const tokenVersion = assertInitiatingAdmin(technician);
  const state = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  // Each integration prefix has one TTL. Sweep expired attempts opportunistically
  // so abandoned consent tabs do not grow system_settings without bound.
  await connection('system_settings')
    .where('key', 'like', `${prefix}%`)
    .andWhere('updated_at', '<', new Date(now.getTime() - ttlMs))
    .del();

  await connection('system_settings').insert({
    key: `${prefix}${state}`,
    value: JSON.stringify({
      ...metadata,
      state,
      technicianId: technician.id,
      tokenVersion,
      expiresAt: expiresAt.toISOString(),
    }),
    category: 'integrations',
    description,
    created_at: now,
    updated_at: now,
  });
  return state;
}

/**
 * Atomically claim an OAuth state, revalidate and row-lock the initiating
 * admin, and keep that credential boundary locked until the provider callback
 * has stored its credentials.
 *
 * Every credential mutation updates this same technician row, so FOR UPDATE
 * gives the callback a linear order with password/email/activation changes.
 * Holding only the initiating row during a slow provider exchange avoids
 * blocking unrelated staff changes across the entire technicians table.
 */
async function withClaimedStaffOAuthState({
  prefix,
  rawState,
  validatePayload,
  callback,
}, database = db) {
  const state = typeof rawState === 'string' ? rawState : '';
  if (!prefix || !OAUTH_STATE_RE.test(state) || typeof callback !== 'function') {
    throw invalidStateError();
  }

  const outcome = await database.transaction(async (trx) => {
    const claimed = await trx('system_settings')
      .where({ key: `${prefix}${state}` })
      .delete()
      .returning(['value']);
    if (!Array.isArray(claimed) || claimed.length !== 1) throw invalidStateError();

    try {
      const payload = parseStatePayload(claimed[0].value);
      const expiresAt = payload?.expiresAt ? new Date(payload.expiresAt) : null;
      const tokenVersion = integerTokenVersion(payload?.tokenVersion);
      if (
        payload?.state !== state
        || !payload?.technicianId
        || tokenVersion === null
        || !expiresAt
        || !Number.isFinite(expiresAt.getTime())
        || expiresAt <= new Date()
      ) {
        throw invalidStateError();
      }
      if (validatePayload && validatePayload(payload) !== true) throw invalidStateError();

      const technician = await trx('technicians')
        .where({ id: payload.technicianId })
        .forUpdate()
        .first('id', 'active', 'role', 'auth_token_version', 'must_change_password');
      if (
        !technician
        || !technician.active
        || technician.role !== 'admin'
        || technician.must_change_password
        || integerTokenVersion(technician.auth_token_version) !== tokenVersion
      ) {
        throw invalidStateError();
      }

      return {
        ok: true,
        value: await callback(payload, { technician, trx }),
      };
    } catch (error) {
      // The row was claimed successfully, so commit its deletion even when the
      // provider rejects the code or the initiating session was revoked. A
      // failed callback must not turn the state back into a reusable capability.
      return { ok: false, error };
    }
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

module.exports = {
  OAUTH_STATE_RE,
  createStaffOAuthState,
  parseStatePayload,
  withClaimedStaffOAuthState,
};

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');
const db = require('../models/db');
const logger = require('../services/logger');

const REFRESH_TABLE = 'customer_refresh_tokens';
const DEFAULT_ACCESS_TOKEN_EXPIRY = '15m';
const CONCURRENT_ROTATION_GRACE_MS = 10 * 1000;

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function tokenHashMatches(storedHash, suppliedHash) {
  const stored = Buffer.from(String(storedHash || ''), 'utf8');
  const supplied = Buffer.from(String(suppliedHash || ''), 'utf8');
  return stored.length === supplied.length && crypto.timingSafeEqual(stored, supplied);
}

function accountIdForCustomer(customer) {
  return customer?.account_id || customer?.id || null;
}

function refreshExpiryDate(token) {
  const decoded = jwt.decode(token);
  return decoded?.exp ? new Date(decoded.exp * 1000) : null;
}

function verifyRefreshCredential(refreshToken) {
  try {
    const decoded = jwt.verify(refreshToken, config.jwt.secret);
    if (decoded.type !== 'refresh' || !decoded.customerId) return null;
    // A transition token minted before refresh-session persistence has neither
    // claim. A partially shaped token is never valid.
    if (Boolean(decoded.jti) !== Boolean(decoded.familyId)) return null;
    return decoded;
  } catch {
    return null;
  }
}

async function insertRefreshRecord(
  executor,
  customerId,
  accountId,
  familyId = crypto.randomUUID(),
  jti = crypto.randomUUID(),
  parentJti = null,
) {
  const refreshToken = generateRefreshToken(customerId, accountId, { jti, familyId });
  const expiresAt = refreshExpiryDate(refreshToken);
  await executor(REFRESH_TABLE).insert({
    jti,
    family_id: familyId,
    customer_id: customerId,
    account_id: accountId || null,
    token_hash: hashRefreshToken(refreshToken),
    parent_jti: parentJti,
    expires_at: expiresAt,
  });
  return { refreshToken, familyId, jti, expiresAt };
}

/**
 * Customers created by paths that skip the account layer (public estimate
 * accept, self-book, lead webhooks, call pipeline) have account_id NULL and
 * no customer_accounts row, so the refresh-session insert's NOT NULL FK on
 * account_id rejects their login AFTER Twilio approves the SMS code.
 * Adopt the customer as their own account — the same self-adoption the
 * 20260504000008 backfill applied to then-existing customers — before
 * minting the session. Only the customerId-fallback case can be missing a
 * row: a non-null customers.account_id is itself an FK onto customer_accounts.
 */
async function ensureSelfAccountRow(trx, customerId, accountId) {
  if (String(accountId) !== String(customerId)) return;
  const existing = await trx('customer_accounts').where({ id: accountId }).first('id');
  if (existing) return;
  const customer = await trx('customers').where({ id: customerId }).first();
  if (!customer) return;
  await trx('customer_accounts')
    .insert({
      id: customer.id,
      first_name: customer.first_name || 'Customer',
      last_name: customer.last_name || null,
      email: customer.email || null,
      phone: customer.phone || null,
      company_name: customer.company_name || null,
    })
    .onConflict('id')
    .ignore();
  await trx('customers')
    .where({ id: customerId })
    .whereNull('account_id')
    .update({
      account_id: customer.id,
      is_primary_profile: true,
      profile_label: customer.profile_label || 'Primary',
    });
  logger.info(`[auth] adopted account-less customer ${customerId} as own account at login`);
}

/** Create a durable, revocable refresh-token family for a login session. */
async function createRefreshSession(customerId, accountId = null) {
  return db.transaction(async (trx) => {
    const resolvedAccountId = accountId || customerId;
    await ensureSelfAccountRow(trx, customerId, resolvedAccountId);
    return insertRefreshRecord(trx, customerId, resolvedAccountId);
  });
}

/**
 * Atomically consume a refresh token and replace it inside the same family.
 * Reusing any consumed token revokes every descendant in that family.
 *
 * Legacy signed refresh tokens (minted before this table existed) get one
 * compatible exchange. Their SHA-256 hash becomes the durable old-token row,
 * so a second exchange is detected as replay instead of creating a new family.
 */
async function rotateRefreshSession(refreshToken, options = {}) {
  const decoded = verifyRefreshCredential(refreshToken);
  if (!decoded) return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
  if (options.expectedCustomerId
    && String(decoded.customerId) !== String(options.expectedCustomerId)) {
    return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
  }
  if (options.expectedFamilyId
    && String(decoded.familyId || '') !== String(options.expectedFamilyId)) {
    return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
  }
  const suppliedHash = hashRefreshToken(refreshToken);

  const result = await db.transaction(async (trx) => {
    const customer = await trx('customers')
      .where({ id: decoded.customerId, active: true })
      .whereNull('deleted_at')
      .first();
    if (!customer) return { ok: false, code: 'INVALID_REFRESH_TOKEN' };

    const accountId = decoded.accountId || accountIdForCustomer(customer);
    if (decoded.accountId && String(decoded.accountId) !== String(accountIdForCustomer(customer))) {
      return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
    }
    if (options.expectedAccountId && String(accountId) !== String(options.expectedAccountId)) {
      return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
    }

    let nextCustomer = customer;
    if (options.targetCustomerId && String(options.targetCustomerId) !== String(customer.id)) {
      nextCustomer = await trx('customers')
        .where({ id: options.targetCustomerId, active: true })
        .whereNull('deleted_at')
        .first();
      if (!nextCustomer || String(accountIdForCustomer(nextCustomer)) !== String(accountId)) {
        return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
      }
    }

    let row;
    if (decoded.jti && decoded.familyId) {
      row = await trx(REFRESH_TABLE)
        .where({ jti: decoded.jti, family_id: decoded.familyId })
        .forUpdate()
        .first();
    } else {
      const legacyFamilyId = crypto.randomUUID();
      const [inserted] = await trx(REFRESH_TABLE).insert({
        jti: suppliedHash,
        family_id: legacyFamilyId,
        customer_id: decoded.customerId,
        account_id: accountId,
        token_hash: suppliedHash,
        expires_at: new Date(decoded.exp * 1000),
      }).onConflict('token_hash').ignore().returning('*');
      row = inserted || await trx(REFRESH_TABLE)
        .where({ token_hash: suppliedHash })
        .forUpdate()
        .first();
    }

    if (!row || !tokenHashMatches(row.token_hash, suppliedHash)) {
      return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
    }
    if (String(row.customer_id) !== String(decoded.customerId)
      || (row.account_id && String(row.account_id) !== String(accountId))) {
      return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
    }

    const now = new Date();
    // Check consumption first: rows may already carry revoked_at from a prior
    // replay or property switch, but replay must still revoke descendants.
    if (row.consumed_at) {
      // Two same-origin tabs can submit the same token before the first tab
      // publishes its replacement to shared storage. Do not hand the second
      // caller any credential, but give it a brief signal to adopt the pair
      // published by the winner. A later reuse remains theft-like and revokes
      // the entire family below.
      const consumedAgoMs = now.getTime() - new Date(row.consumed_at).getTime();
      if (consumedAgoMs >= 0
        && consumedAgoMs <= CONCURRENT_ROTATION_GRACE_MS
        && row.replaced_by_jti) {
        const liveReplacement = await trx(REFRESH_TABLE)
          .where({ jti: row.replaced_by_jti, family_id: row.family_id })
          .whereNull('consumed_at')
          .whereNull('revoked_at')
          .first();
        if (liveReplacement && new Date(liveReplacement.expires_at) > now) {
          return {
            ok: false,
            code: 'REFRESH_TOKEN_ALREADY_ROTATED',
            familyId: row.family_id,
          };
        }
      }
      await trx(REFRESH_TABLE)
        .where({ family_id: row.family_id })
        .whereNull('revoked_at')
        .update({ revoked_at: now, revoke_reason: 'replay_detected', updated_at: now });
      return { ok: false, code: 'REFRESH_TOKEN_REUSED', familyId: row.family_id };
    }
    if (row.revoked_at || new Date(row.expires_at) <= now) {
      return { ok: false, code: 'REFRESH_SESSION_REVOKED' };
    }

    const nextJti = crypto.randomUUID();
    const consumeUpdate = { consumed_at: now, replaced_by_jti: nextJti, updated_at: now };
    if (options.revokeReason) {
      consumeUpdate.revoked_at = now;
      consumeUpdate.revoke_reason = options.revokeReason;
    }
    const consumed = await trx(REFRESH_TABLE)
      .where({ jti: row.jti })
      .whereNull('consumed_at')
      .whereNull('revoked_at')
      .update(consumeUpdate);
    if (consumed !== 1) {
      // The row lock should make this unreachable, but fail closed if a
      // database/adapter behaves unexpectedly.
      await trx(REFRESH_TABLE)
        .where({ family_id: row.family_id })
        .whereNull('revoked_at')
        .update({ revoked_at: now, revoke_reason: 'rotation_conflict', updated_at: now });
      return { ok: false, code: 'REFRESH_SESSION_REVOKED' };
    }

    const next = await insertRefreshRecord(
      trx,
      nextCustomer.id,
      accountId,
      row.family_id,
      nextJti,
      row.jti,
    );
    return { ok: true, ...next, customer: nextCustomer, accountId };
  });

  if (result.code === 'REFRESH_TOKEN_REUSED') {
    // Do not log the token, JTI, customer ID, or family ID.
    logger.warn('[auth] refresh-token replay detected; session family revoked');
  }
  return result;
}

/**
 * Replace the current family token when an authenticated customer switches
 * service properties. New access tokens carry the family ID; legacy access
 * tokens without it start a new family during the rollout window.
 */
async function reissueRefreshSessionForProperty(
  refreshToken,
  customerId,
  accountId,
  expectedCustomerId,
  expectedFamilyId,
) {
  return rotateRefreshSession(refreshToken, {
    targetCustomerId: customerId,
    expectedAccountId: accountId,
    expectedCustomerId,
    expectedFamilyId,
    revokeReason: 'property_switch',
  });
}

/** Revoke the whole family represented by a refresh credential. */
async function revokeRefreshSession(refreshToken, reason = 'logout') {
  const decoded = verifyRefreshCredential(refreshToken);
  if (!decoded) return { revoked: false };
  const suppliedHash = hashRefreshToken(refreshToken);

  return db.transaction(async (trx) => {
    let row;
    if (decoded.jti && decoded.familyId) {
      row = await trx(REFRESH_TABLE)
        .where({ jti: decoded.jti, family_id: decoded.familyId })
        .forUpdate()
        .first();
    } else {
      row = await trx(REFRESH_TABLE)
        .where({ token_hash: suppliedHash })
        .forUpdate()
        .first();

      if (!row) {
        // A signed pre-rollout token has no durable row until its first
        // refresh. Logout must still leave a tombstone or that same token can
        // later take the legacy migration path and create a live family.
        // Validate the current customer/account exactly as rotation does
        // before inserting anything; arbitrary, access, deleted-customer, or
        // account-mismatched credentials never reach the session table.
        const customer = await trx('customers')
          .where({ id: decoded.customerId, active: true })
          .whereNull('deleted_at')
          .first();
        if (!customer) return { revoked: false };

        const accountId = decoded.accountId || accountIdForCustomer(customer);
        if (!accountId
          || (decoded.accountId
            && String(decoded.accountId) !== String(accountIdForCustomer(customer)))) {
          return { revoked: false };
        }

        const expiresAt = Number.isFinite(decoded.exp)
          ? new Date(decoded.exp * 1000)
          : null;
        const now = new Date();
        if (!expiresAt || expiresAt <= now) return { revoked: false };

        const [inserted] = await trx(REFRESH_TABLE).insert({
          // The legacy token has no JTI. Its collision-resistant fingerprint
          // is already the rollout identifier used by rotateRefreshSession.
          jti: suppliedHash,
          family_id: crypto.randomUUID(),
          customer_id: decoded.customerId,
          account_id: accountId,
          token_hash: suppliedHash,
          expires_at: expiresAt,
          revoked_at: now,
          revoke_reason: reason,
        }).onConflict('token_hash').ignore().returning('*');

        // A concurrent logout/refresh may have won the unique-hash insert.
        // Lock and revoke that winner's whole family, including a replacement
        // created by a simultaneous legacy migration refresh.
        row = inserted || await trx(REFRESH_TABLE)
          .where({ token_hash: suppliedHash })
          .forUpdate()
          .first();
      }
    }
    if (!row || !tokenHashMatches(row.token_hash, suppliedHash)) return { revoked: false };

    const now = new Date();
    await trx(REFRESH_TABLE)
      .where({ family_id: row.family_id })
      .whereNull('revoked_at')
      .update({ revoked_at: now, revoke_reason: reason, updated_at: now });
    return { revoked: true };
  });
}

async function revokeCustomerRefreshSessions(customerId, accountId = null, reason = 'account_deleted') {
  const query = db(REFRESH_TABLE).whereNull('revoked_at');
  if (accountId) query.where({ account_id: accountId });
  else query.where({ customer_id: customerId });
  return query.update({ revoked_at: new Date(), revoke_reason: reason, updated_at: new Date() });
}

/**
 * Verify JWT token and attach customer to request
 */
async function authenticateCore(req, res, next, { allowInactive = false } = {}) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, config.jwt.secret);

    // Refresh tokens are exchange-only (POST /auth/refresh). They're minted
    // with a longer TTL, so accepting one here would let a leaked refresh
    // token act as a long-lived access token.
    if (decoded.type === 'refresh') {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    const query = db('customers')
      .where({ id: decoded.customerId })
      .whereNull('deleted_at');
    if (!allowInactive) query.where({ active: true });
    const customer = await query.first();

    if (!customer) {
      return res.status(401).json({ error: 'Customer not found or inactive' });
    }

    const customerAccountId = customer.account_id || customer.id;
    if (decoded.accountId && String(decoded.accountId) !== String(customerAccountId)) {
      return res.status(401).json({ error: 'Invalid token account' });
    }

    req.customer = customer;
    req.customerId = customer.id;
    // Anything other than active === true counts as inactive (the column is
    // nullable; the strict middleware requires active=true, so a NULL-active
    // customer must not slip past allow-inactive routes' per-action gates).
    req.customerInactive = customer.active !== true;
    req.accountId = decoded.accountId || customerAccountId;
    req.authSessionId = decoded.sessionId || null;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function authenticate(req, res, next) {
  return authenticateCore(req, res, next, { allowInactive: false });
}

/**
 * Same as authenticate but admits an INACTIVE (not deleted) customer, setting
 * req.customerInactive so the route can gate per-action. Exists for the
 * cancellation-request path: auto-processing churns the account (active=false)
 * mid-flight, and a client retry after a lost response must still reach the
 * idempotent dedupe/repair sweep instead of dying on a 401 here. Routes using
 * this MUST explicitly reject inactive customers for anything else.
 */
function authenticateAllowInactive(req, res, next) {
  return authenticateCore(req, res, next, { allowInactive: true });
}

/**
 * Generate JWT for a customer
 */
function generateToken(customerId, accountId = null, sessionId = null) {
  return jwt.sign(
    { customerId, accountId: accountId || undefined, sessionId: sessionId || undefined },
    config.jwt.secret,
    // Customer access tokens are deliberately short-lived. Existing signed
    // tokens still verify until their original expiry, while the client uses
    // the durable refresh session to renew new 15-minute access tokens.
    { expiresIn: DEFAULT_ACCESS_TOKEN_EXPIRY }
  );
}

function generateRefreshToken(customerId, accountId = null, options = {}) {
  const jti = options.jti || crypto.randomUUID();
  const familyId = options.familyId || crypto.randomUUID();
  return jwt.sign(
    { customerId, accountId: accountId || undefined, type: 'refresh', jti, familyId },
    config.jwt.secret,
    { expiresIn: config.jwt.refreshExpiry }
  );
}

// Optional-auth resolver for public routes that ACCEPT a customer bearer but
// must not demand one (e.g. /booking/confirm under the customers-only gate).
// Mirrors authenticateCore's access-token contract — refresh tokens rejected,
// active non-deleted customer required, accountId consistency enforced — but
// returns the customer row (or null) instead of writing 401 responses, so an
// absent/expired/garbage header simply resolves to "not a verified customer"
// and the caller decides what that means.
async function resolveBearerCustomer(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], config.jwt.secret);
    if (decoded.type === 'refresh' || !decoded.customerId) return null;
    const customer = await db('customers')
      .where({ id: decoded.customerId, active: true })
      .whereNull('deleted_at')
      .first();
    if (!customer) return null;
    const customerAccountId = customer.account_id || customer.id;
    if (decoded.accountId && String(decoded.accountId) !== String(customerAccountId)) return null;
    return customer;
  } catch {
    return null;
  }
}

module.exports = {
  authenticate,
  authenticateAllowInactive,
  resolveBearerCustomer,
  createRefreshSession,
  generateToken,
  generateRefreshToken,
  reissueRefreshSessionForProperty,
  revokeCustomerRefreshSessions,
  revokeRefreshSession,
  rotateRefreshSession,
  verifyRefreshCredential,
  _test: { CONCURRENT_ROTATION_GRACE_MS },
};

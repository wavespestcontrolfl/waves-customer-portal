const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const {
  rateLimitKey,
  unauthenticatedAuthLimitKey,
} = require('../middleware/rate-limit-key');
const logger = require('../services/logger');
const PushService = require('../services/push-notifications');
const {
  RESET_LINK_TTL_MINUTES,
  sendStaffPasswordResetEmail,
} = require('../services/staff-password-reset-email');
const {
  MAX_STAFF_PASSWORD_BYTES,
  isRetiredLegacyStaffPassword,
  validateStaffPassword,
} = require('../utils/staff-password-policy');
const { canonicalStaffEmail } = require('../utils/staff-identity');

const RESET_TOKEN_BYTES = 32;
const RESET_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const RESET_REQUEST_COOLDOWN_MS = 2 * 60 * 1000;
const FAILED_LOGIN_FLOOR_MS = process.env.NODE_ENV === 'test' ? 0 : 750;
const FAILED_LOGIN_JITTER_MS = process.env.NODE_ENV === 'test' ? 0 : 125;
// Cost-12 hash for a fixed, non-credential string. Unknown, duplicate, and
// passwordless accounts still perform the same expensive verification step as
// a real account so the login endpoint does not become a timing oracle.
const DUMMY_STAFF_PASSWORD_HASH = '$2a$12$wVxtRl4tyja/w/3.qCfpfeNQlj08XuIxnyc0J7rm7zHPUpZpL7emG';
const GENERIC_RESET_RESPONSE = {
  message: 'If that address belongs to an active staff account, a reset link is on its way.',
};

const resetRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many reset requests. Please try again in 15 minutes.' },
  // Unauthenticated endpoint: attached JWTs must not create extra buckets.
  keyGenerator: unauthenticatedAuthLimitKey,
  skip: () => process.env.NODE_ENV !== 'production',
});

const resetSubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many reset attempts. Please request a new link later.' },
  // Unauthenticated endpoint: attached JWTs must not create extra buckets.
  keyGenerator: unauthenticatedAuthLimitKey,
  skip: () => process.env.NODE_ENV !== 'production',
});

const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many password attempts. Please try again in 15 minutes.' },
  keyGenerator: rateLimitKey,
  skip: () => process.env.NODE_ENV !== 'production',
});

function staffTokenVersion(tech) {
  const version = Number(tech?.auth_token_version);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('staff account has no valid auth token version');
  }
  return version;
}

function staffUser(tech) {
  return {
    id: tech.id,
    name: tech.name,
    email: tech.email,
    role: tech.role,
    mustChangePassword: Boolean(tech.must_change_password),
  };
}

function mintStaffTokens(tech) {
  const tokenVersion = staffTokenVersion(tech);
  return {
    token: jwt.sign({
      technicianId: tech.id,
      role: tech.role,
      name: tech.name,
      type: 'access',
      tokenVersion,
    }, config.jwt.secret, { expiresIn: '30d' }),
    refreshToken: jwt.sign({
      technicianId: tech.id,
      type: 'refresh',
      tokenVersion,
    }, config.jwt.secret, { expiresIn: '30d' }),
  };
}

function normalizeStaffEmail(value) {
  return canonicalStaffEmail(value);
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function rejectInvalidCredentials(res, startedAt) {
  const jitter = FAILED_LOGIN_JITTER_MS > 0
    ? crypto.randomInt(0, FAILED_LOGIN_JITTER_MS + 1)
    : 0;
  const remaining = FAILED_LOGIN_FLOOR_MS + jitter - (Date.now() - startedAt);
  if (remaining > 0) {
    await new Promise((resolve) => { setTimeout(resolve, remaining); });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
}

// Long-lived signed cookie used by the public estimate routes to skip
// counting views from admin-authenticated devices (Virginia / Waves
// previewing estimates). 2-year expiry; refreshed on every /login + /me
// hit so an active admin's marker keeps rolling forward.
const ADMIN_MARKER_MAX_AGE_MS = 2 * 365 * 24 * 60 * 60 * 1000; // 2y
function setAdminMarkerCookie(res, technicianId) {
  const token = jwt.sign(
    { kind: 'admin_marker', sub: technicianId },
    config.jwt.secret,
    { expiresIn: '730d' },
  );
  res.cookie('waves_admin', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: ADMIN_MARKER_MAX_AGE_MS,
    path: '/',
  });
}

async function login(req, res, next) {
  const startedAt = Date.now();
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password required' });
    }
    if (Buffer.byteLength(password, 'utf8') > MAX_STAFF_PASSWORD_BYTES) {
      return rejectInvalidCredentials(res, startedAt);
    }
    // Return the same reset direction for every supplied email so the retired
    // repository-known credential cannot become an account-existence oracle.
    if (isRetiredLegacyStaffPassword(password)) {
      return res.status(401).json({
        error: 'This retired staff password cannot be used. Use Forgot password to request a secure reset link.',
        code: 'PASSWORD_RESET_REQUIRED',
      });
    }
    const normalizedEmail = normalizeStaffEmail(email);
    if (!normalizedEmail) return rejectInvalidCredentials(res, startedAt);

    const matches = await db('technicians')
      .whereRaw('LOWER(BTRIM(email)) = ?', [normalizedEmail])
      .whereIn('role', ['admin', 'technician'])
      .where({ active: true })
      .select('*');

    const candidate = matches.length === 1 ? matches[0] : null;
    const passwordHash = typeof candidate?.password_hash === 'string' && candidate.password_hash
      ? candidate.password_hash
      : DUMMY_STAFF_PASSWORD_HASH;
    const valid = await bcrypt.compare(password, passwordHash);

    if (matches.length !== 1) {
      if (matches.length > 1) {
        logger.error(`[staff-auth] Login blocked by canonical email collision (matches=${matches.length})`);
      }
      return rejectInvalidCredentials(res, startedAt);
    }
    const tech = candidate;
    if (!valid) return rejectInvalidCredentials(res, startedAt);

    const { token, refreshToken } = mintStaffTokens(tech);

    await db('technicians').where({ id: tech.id }).update({ last_login_at: db.fn.now() });
    setAdminMarkerCookie(res, tech.id);

    res.json({
      token, refreshToken,
      user: staffUser(tech),
    });
  } catch (err) { next(err); }
}

router.post('/login', login);

async function lockStaffAccountMutations(trx) {
  await trx.raw('LOCK TABLE technicians IN SHARE ROW EXCLUSIVE MODE');
}

function canonicalStaffEmailQuery(connection, email) {
  return connection('technicians')
    .whereNotNull('email')
    .whereRaw('LOWER(BTRIM(email)) = ?', [email]);
}

function disconnectRevokedStaffSessions(technicianId, reason) {
  try {
    // Lazy require avoids coupling route module initialization to Socket.io's
    // server bootstrap. The helper is a no-op before sockets attach.
    const { disconnectStaffSockets } = require('../sockets');
    disconnectStaffSockets(technicianId, reason);
  } catch (error) {
    logger.error(`[staff-auth] Live-session disconnect failed for technician id=${technicianId} (${error.message})`);
  }
}

async function issuePasswordReset(email) {
  const normalizedEmail = normalizeStaffEmail(email);
  if (!normalizedEmail) return { issued: false };
  const token = crypto.randomBytes(RESET_TOKEN_BYTES).toString('base64url');
  const tokenHash = hashResetToken(token);
  const now = new Date();
  const cooldownCutoff = new Date(now.getTime() - RESET_REQUEST_COOLDOWN_MS);
  const expiresAt = new Date(now.getTime() + (RESET_LINK_TTL_MINUTES * 60 * 1000));

  // Serialize every staff identity writer, then fail closed unless the
  // canonical email resolves to exactly one active staff row. Without this,
  // duplicate rows would receive the same token hash and token consumption
  // could reset an arbitrary privilege row.
  const tech = await db.transaction(async (trx) => {
    await lockStaffAccountMutations(trx);
    const matches = await canonicalStaffEmailQuery(trx, normalizedEmail)
      .where({ active: true })
      .whereIn('role', ['admin', 'technician'])
      .select('id', 'email');
    if (matches.length !== 1) {
      if (matches.length > 1) {
        logger.error(`[staff-auth] Password reset blocked by canonical email collision (matches=${matches.length})`);
      }
      return null;
    }

    const [updated] = await trx('technicians')
      .where({ id: matches[0].id, active: true })
      .where(function resetCooldown() {
        this.whereNull('password_reset_requested_at')
          .orWhere('password_reset_requested_at', '<=', cooldownCutoff);
      })
      .update({
        password_reset_token_hash: tokenHash,
        password_reset_expires_at: expiresAt,
        password_reset_requested_at: now,
        updated_at: trx.fn.now(),
      })
      .returning(['id']);
    return updated ? { id: updated.id, email: normalizedEmail } : null;
  });

  if (!tech) return { issued: false };

  try {
    await sendStaffPasswordResetEmail({
      technicianId: tech.id,
      email: tech.email,
      token,
    });
  } catch (error) {
    // A provider 5xx/network failure is ambiguous: the message may have been
    // accepted before the response was lost. Keep that short-lived token so a
    // possibly delivered link remains usable. Definite pre-send/4xx failures
    // clear it; the hash condition cannot erase a newer concurrent request.
    const status = Number(error?.status);
    const definitelyNotQueued = error?.definitelyNotQueued === true
      || (Number.isInteger(status) && status >= 400 && status < 500);
    if (definitelyNotQueued) {
      await db('technicians')
        .where({ id: tech.id, password_reset_token_hash: tokenHash })
        .update({
          password_reset_token_hash: null,
          password_reset_expires_at: null,
          password_reset_requested_at: null,
          updated_at: db.fn.now(),
        });
    } else {
      logger.warn(`[staff-auth] Retaining reset token after ambiguous delivery failure (status=${error?.status || 'n/a'})`);
    }
    throw error;
  }

  return { issued: true };
}

function forgotPassword(req, res) {
  const email = normalizeStaffEmail(req.body?.email);
  if (email) {
    // Return the same response at the same point for known and unknown
    // addresses. The caught background task avoids an account-existence
    // oracle while preserving operational visibility without logging PII.
    void issuePasswordReset(email).catch((error) => {
      logger.error(`[staff-auth] Password reset issuance failed (status=${error?.status || 'n/a'})`);
    });
  }
  return res.status(200).json(GENERIC_RESET_RESPONSE);
}

async function resetPassword(req, res, next) {
  try {
    const { token, newPassword } = req.body || {};
    const policyError = validateStaffPassword(newPassword);
    if (policyError) return res.status(400).json({ error: policyError });
    if (typeof token !== 'string' || !RESET_TOKEN_RE.test(token)) {
      return res.status(400).json({ error: 'Reset link is invalid or expired' });
    }

    const tokenHash = hashResetToken(token);
    const tech = await db('technicians')
      .where({ password_reset_token_hash: tokenHash, active: true })
      .whereIn('role', ['admin', 'technician'])
      .where('password_reset_expires_at', '>', db.fn.now())
      .first();
    if (!tech) return res.status(400).json({ error: 'Reset link is invalid or expired' });
    if (tech.password_hash && await bcrypt.compare(newPassword, tech.password_hash)) {
      return res.status(400).json({ error: 'New password must be different from the current password' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    const currentVersion = staffTokenVersion(tech);
    const updated = await db.transaction(async (trx) => {
      const [row] = await trx('technicians')
        .where({
          id: tech.id,
          active: true,
          auth_token_version: currentVersion,
          password_reset_token_hash: tokenHash,
        })
        .where('password_reset_expires_at', '>', trx.fn.now())
        .update({
          password_hash: passwordHash,
          auth_token_version: currentVersion + 1,
          must_change_password: false,
          password_changed_at: trx.fn.now(),
          password_reset_token_hash: null,
          password_reset_expires_at: null,
          password_reset_requested_at: null,
          last_login_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        })
        .returning('*');
      if (row) await PushService.deactivateStaffUser(row.id, trx);
      return row || null;
    });
    if (!updated) return res.status(400).json({ error: 'Reset link is invalid or expired' });

    disconnectRevokedStaffSessions(updated.id, 'password_reset');
    const tokens = mintStaffTokens(updated);
    setAdminMarkerCookie(res, updated.id);
    return res.json({ ...tokens, user: staffUser(updated) });
  } catch (error) {
    return next(error);
  }
}

router.post('/forgot-password', resetRequestLimiter, forgotPassword);
router.post('/reset-password', resetSubmitLimiter, resetPassword);

async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || !currentPassword) {
      return res.status(400).json({ error: 'Current password is required' });
    }
    const policyError = validateStaffPassword(newPassword);
    if (policyError) return res.status(400).json({ error: policyError });

    const tech = req.technician;
    if (!tech.password_hash || !(await bcrypt.compare(currentPassword, tech.password_hash))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    if (await bcrypt.compare(newPassword, tech.password_hash)) {
      return res.status(400).json({ error: 'New password must be different from the current password' });
    }

    const nextTokenVersion = staffTokenVersion(tech) + 1;
    const passwordHash = await bcrypt.hash(newPassword, 12);
    const updated = await db.transaction(async (trx) => {
      const [row] = await trx('technicians')
        .where({ id: tech.id, auth_token_version: staffTokenVersion(tech) })
        .update({
          password_hash: passwordHash,
          auth_token_version: nextTokenVersion,
          must_change_password: false,
          password_changed_at: trx.fn.now(),
          password_reset_token_hash: null,
          password_reset_expires_at: null,
          password_reset_requested_at: null,
          updated_at: trx.fn.now(),
        })
        .returning('*');
      if (row) await PushService.deactivateStaffUser(row.id, trx);
      return row || null;
    });
    if (!updated) {
      return res.status(409).json({ error: 'Account changed before the password could be updated. Sign in again.' });
    }

    disconnectRevokedStaffSessions(updated.id, 'password_changed');
    const { token, refreshToken } = mintStaffTokens(updated);
    setAdminMarkerCookie(res, updated.id);
    res.json({ token, refreshToken, user: staffUser(updated) });
  } catch (err) { next(err); }
}

router.post('/change-password', adminAuthenticate, changePasswordLimiter, changePassword);

router.post('/register', adminAuthenticate, requireAdmin, async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || !email || !password) {
      return res.status(400).json({ error: 'Name, email, password required' });
    }
    const normalizedName = name.trim();
    const normalizedEmail = normalizeStaffEmail(email);
    if (!normalizedEmail) return res.status(400).json({ error: 'A valid staff email is required' });
    const staffRole = role || 'technician';
    if (!['admin', 'technician'].includes(staffRole)) {
      return res.status(400).json({ error: 'Role must be admin or technician' });
    }
    const policyError = validateStaffPassword(password);
    if (policyError) return res.status(400).json({ error: policyError });

    const hash = await bcrypt.hash(password, 12);
    const outcome = await db.transaction(async (trx) => {
      await lockStaffAccountMutations(trx);
      const existing = await canonicalStaffEmailQuery(trx, normalizedEmail).first('id');
      if (existing) return { conflict: true };
      const [tech] = await trx('technicians').insert({
        name: normalizedName,
        email: normalizedEmail,
        password_hash: hash,
        role: staffRole,
        active: true,
        password_changed_at: trx.fn.now(),
      }).returning('*');
      return { tech };
    });
    if (outcome.conflict) return res.status(409).json({ error: 'Email already in use' });
    const { tech } = outcome;

    res.status(201).json({ id: tech.id, name: tech.name, email: tech.email, role: tech.role });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use' });
    return next(err);
  }
});

router.get('/me', adminAuthenticate, (req, res) => {
  const t = req.technician;
  // Refresh the admin marker on every authenticated /me — covers admins
  // who were logged in before the cookie was introduced and rolls the
  // 2-year expiry forward on every active session.
  setAdminMarkerCookie(res, t.id);
  res.json(staffUser(t));
});

module.exports = router;
module.exports._handlers = {
  changePassword,
  forgotPassword,
  issuePasswordReset,
  lockStaffAccountMutations,
  login,
  resetPassword,
};

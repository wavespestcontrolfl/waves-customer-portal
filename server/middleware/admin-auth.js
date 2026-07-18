const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../models/db');
const { installStaffCallRecordingPrivacy } = require('./staff-call-recording-privacy');

function isStaffAccessToken(decoded) {
  return decoded?.type === 'access'
    && Number.isInteger(decoded.tokenVersion)
    && decoded.tokenVersion >= 1;
}

function staffTokenVersionMatches(decoded, tech) {
  if (!isStaffAccessToken(decoded)) return false;
  const currentVersion = Number(tech?.auth_token_version);
  return Number.isInteger(currentVersion)
    && currentVersion >= 1
    && decoded.tokenVersion === currentVersion;
}

function passwordChangeRouteAllowed(req) {
  const routePath = `${req.baseUrl || ''}${req.path || ''}`.replace(/\/+$/, '');
  return routePath === '/api/admin/auth/me'
    || routePath === '/api/admin/auth/change-password';
}

async function adminAuthenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], config.jwt.secret);
    if (!isStaffAccessToken(decoded)) return res.status(401).json({ error: 'Invalid token type' });
    if (!decoded.technicianId) return res.status(401).json({ error: 'Invalid admin token' });
    if (decoded.scope === 'terminal') return res.status(401).json({ error: 'Terminal-scoped token not accepted here' });

    const tech = await db('technicians').where({ id: decoded.technicianId }).first();
    if (!tech || !tech.active) return res.status(401).json({ error: 'Account not found or inactive' });
    if (!['admin', 'technician'].includes(tech.role)) {
      return res.status(401).json({ error: 'Account not found or inactive' });
    }
    if (!staffTokenVersionMatches(decoded, tech)) {
      return res.status(401).json({ error: 'Session has been revoked', code: 'TOKEN_REVOKED' });
    }
    if (tech.must_change_password && !passwordChangeRouteAllowed(req)) {
      return res.status(403).json({
        error: 'Password change required',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
    }

    req.technician = tech;
    req.technicianId = tech.id;
    req.techRole = tech.role;
    req.staffToken = decoded;
    installStaffCallRecordingPrivacy(res);
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.techRole !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Non-middleware variant for PUBLIC routes that offer an optional staff-
// authenticated upgrade (e.g. the estimate tool's draft preview on the public
// /:token/data endpoint). Runs the same checks as adminAuthenticate +
// requireTechOrAdmin — Bearer JWT, non-terminal scope, active technician row,
// staff role — but never writes a response: returns the technician row on
// success and null on ANY failure, so the caller's public behavior is
// unchanged for everyone else.
async function verifyStaffBearer(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], config.jwt.secret);
    if (!isStaffAccessToken(decoded)) return null;
    if (!decoded.technicianId) return null;
    if (decoded.scope === 'terminal') return null;
    const tech = await db('technicians').where({ id: decoded.technicianId }).first();
    if (!tech || !tech.active) return null;
    if (!['admin', 'technician'].includes(tech.role)) return null;
    if (!staffTokenVersionMatches(decoded, tech)) return null;
    if (tech.must_change_password) return null;
    return tech;
  } catch {
    return null;
  }
}

function requireTechOrAdmin(req, res, next) {
  if (!['admin', 'technician'].includes(req.techRole)) return res.status(403).json({ error: 'Staff access required' });
  next();
}

module.exports = {
  adminAuthenticate,
  isStaffAccessToken,
  requireAdmin,
  requireTechOrAdmin,
  staffTokenVersionMatches,
  verifyStaffBearer,
};

const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../models/db');

async function adminAuthenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], config.jwt.secret);
    if (!decoded.technicianId) return res.status(401).json({ error: 'Invalid admin token' });

    const tech = await db('technicians').where({ id: decoded.technicianId }).first();
    if (!tech || !tech.active) return res.status(401).json({ error: 'Account not found or inactive' });

    req.technician = tech;
    req.technicianId = tech.id;
    req.techRole = tech.role;
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

function requireTechOrAdmin(req, res, next) {
  if (!['admin', 'technician'].includes(req.techRole)) return res.status(403).json({ error: 'Staff access required' });
  next();
}

module.exports = { adminAuthenticate, requireAdmin, requireTechOrAdmin };

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const tech = await db('technicians')
      .where({ email: email.toLowerCase().trim() })
      .whereIn('role', ['admin', 'technician'])
      .where({ active: true })
      .first();

    if (!tech || !tech.password_hash) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, tech.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ technicianId: tech.id, role: tech.role, name: tech.name }, config.jwt.secret, { expiresIn: '12h' });
    const refreshToken = jwt.sign({ technicianId: tech.id, type: 'refresh' }, config.jwt.secret, { expiresIn: '30d' });

    await db('technicians').where({ id: tech.id }).update({ last_login_at: db.fn.now() });

    res.json({
      token, refreshToken,
      user: { id: tech.id, name: tech.name, email: tech.email, role: tech.role },
    });
  } catch (err) { next(err); }
});

router.post('/register', adminAuthenticate, requireAdmin, async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, password required' });

    const existing = await db('technicians').where({ email: email.toLowerCase().trim() }).first();
    if (existing) return res.status(409).json({ error: 'Email already in use' });

    const hash = await bcrypt.hash(password, 10);
    const [tech] = await db('technicians').insert({
      name, email: email.toLowerCase().trim(), password_hash: hash,
      role: role || 'technician', active: true,
    }).returning('*');

    res.status(201).json({ id: tech.id, name: tech.name, email: tech.email, role: tech.role });
  } catch (err) { next(err); }
});

router.get('/me', adminAuthenticate, (req, res) => {
  const t = req.technician;
  res.json({ id: t.id, name: t.name, email: t.email, role: t.role });
});

module.exports = router;

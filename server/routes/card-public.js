/**
 * Public digital-business-card endpoints (mounted at /api/card).
 *
 *   GET /api/card/:token              → card payload for the /card/:token page
 *   GET /api/card/:token/contact.vcf  → Save-contact vCard download
 *
 * Token-scoped public routes, same trust contract as the other /:token
 * customer surfaces (estimate/report/rate): the 64-hex share token IS the
 * credential; unknown tokens 404 with no existence oracle. The global /api
 * rate limiter covers both routes.
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const CardService = require('../services/customer-card');
const { WAVES_LOCATIONS } = require('../config/locations');
const {
  WAVES_FL_LICENSE_LINE,
  WAVES_ADDRESS_LINE,
} = require('../constants/business');

const TOKEN_RE = /^[a-f0-9]{64}$/;

router.get('/:token', async (req, res, next) => {
  try {
    const data = await CardService.getCardData(req.params.token);
    if (!data) return res.status(404).json({ error: 'Card not found' });
    // Bearer-token payload (name, review flag, referral link, presigned tech
    // photo) — same no-store treatment as the /card/:token shell.
    res.set('Cache-Control', 'private, no-store');
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/:token/contact.vcf', async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) return res.status(404).send('Not found');
    const card = await db('customer_cards').where({ share_token: token }).first();
    if (!card) return res.status(404).send('Not found');
    // Consistent with the JSON route: archived/merged customers' old tokens
    // must 404 here too, not keep serving the contact (Codex P3 #2588 r2).
    const customer = await db('customers').where({ id: card.customer_id }).first('id', 'deleted_at');
    if (!customer || customer.deleted_at) return res.status(404).send('Not found');

    let techName = null;
    if (card.technician_id) {
      const tech = await db('technicians').where({ id: card.technician_id }).first('name');
      techName = tech?.name || null;
    }
    const location = WAVES_LOCATIONS.find((l) => l.id === card.location_id) || WAVES_LOCATIONS[0];

    const vcf = CardService.buildVcard({
      techName,
      phoneE164: location.phoneRaw,
      licenseLine: WAVES_FL_LICENSE_LINE,
      addressLine: WAVES_ADDRESS_LINE,
    });

    const slug = String(techName || 'waves')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'waves';
    res.set('Content-Type', 'text/vcard; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="waves-${slug}.vcf"`);
    res.set('Cache-Control', 'private, no-store');
    res.send(vcf);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

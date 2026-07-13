/**
 * Public price-change notice page data — GET /api/public/price-change/:token.
 *
 * No auth; the 32-hex token is the only gate (same contract as the prep
 * guide page). Payload is deliberately minimal: first name, the price
 * change itself, and support contact — a forwarded/leaked link never yields
 * usable PII. Views are counted for the delivery record.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { formatMoney } = require('../services/price-change-notices');
const { formatDisplayDate } = require('../utils/date-only');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
}));

const TOKEN_RE = /^[a-f0-9]{32}$/i;

const PRIVACY_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
};

router.get('/:token', async (req, res) => {
  res.set(PRIVACY_HEADERS);

  // TOKEN_RE accepts uppercased hex (copy/intermediary casing), but stored
  // tokens are lowercase and the DB equality check is case-sensitive —
  // normalize before lookup so a valid-but-uppercased link doesn't 404.
  const token = String(req.params.token || '').toLowerCase();
  if (!TOKEN_RE.test(token)) return res.status(404).json({ error: 'Not found' });

  try {
    const notice = await db('price_change_notices').where({ notice_token: token }).first();
    if (!notice) return res.status(404).json({ error: 'Not found' });

    const customer = await db('customers').where({ id: notice.customer_id }).first('first_name');
    const firstName = String(customer?.first_name || '').trim().split(/\s+/)[0] || 'there';

    void db('price_change_notices').where({ id: notice.id }).update({
      view_count: db.raw('view_count + 1'),
      first_viewed_at: db.raw('COALESCE(first_viewed_at, now())'),
      status: 'viewed',
      updated_at: new Date(),
    }).catch((err) => logger.warn(`[price-change-public] view update failed: ${err.message}`));

    return res.json({
      firstName,
      currentPrice: formatMoney(notice.current_amount_cents),
      newPrice: formatMoney(notice.new_amount_cents),
      cadenceLabel: notice.cadence_label || 'month',
      effectiveDate: formatDisplayDate(notice.effective_date, { fallback: '' }),
      supportPhone: WAVES_SUPPORT_PHONE_DISPLAY,
    });
  } catch (err) {
    logger.error(`[price-change-public] error for token: ${err.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

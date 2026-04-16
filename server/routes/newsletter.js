const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');

router.post('/subscribe', async (req, res) => {
  try {
    const { email, source } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    const normalized = email.trim().toLowerCase();

    const existing = await db('newsletter_subscribers')
      .where({ email: normalized })
      .first();

    if (existing) {
      if (existing.status === 'unsubscribed') {
        await db('newsletter_subscribers')
          .where({ id: existing.id })
          .update({ status: 'active', source: source || existing.source, resubscribed_at: db.fn.now() });
        return res.json({ success: true, message: 'Welcome back!' });
      }
      return res.json({ success: true, message: 'Already subscribed' });
    }

    await db('newsletter_subscribers').insert({
      email: normalized,
      source: source || 'website',
      status: 'active',
      subscribed_at: db.fn.now(),
    });

    logger.info(`[newsletter] New subscriber: ${normalized} (source: ${source || 'website'})`);
    res.json({ success: true, message: 'Subscribed!' });
  } catch (err) {
    logger.error('[newsletter] Subscribe error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

router.post('/unsubscribe', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    await db('newsletter_subscribers')
      .where({ email: email.trim().toLowerCase() })
      .update({ status: 'unsubscribed', unsubscribed_at: db.fn.now() });

    res.json({ success: true, message: 'Unsubscribed' });
  } catch (err) {
    logger.error('[newsletter] Unsubscribe error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;

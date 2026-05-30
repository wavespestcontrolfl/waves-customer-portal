const express = require('express');
const db = require('../models/db');
const {
  hashNullable,
  hashToken,
} = require('../services/lawn-service-outline');

const router = express.Router();

function publicPacket(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    content: row.content_json || {},
    summary: row.summary_json || {},
    noindex: row.noindex !== false,
    expiresAt: row.expires_at,
  };
}

router.get('/:token', async (req, res, next) => {
  try {
    const tokenHash = hashToken(req.params.token);
    const packet = await db('service_outline_packets')
      .where({ token_hash: tokenHash })
      .whereNull('revoked_at')
      .first();

    if (!packet) return res.status(404).json({ error: 'Service outline not found' });
    if (packet.expires_at && new Date(packet.expires_at) <= new Date()) {
      await db('service_outline_packets')
        .where({ id: packet.id })
        .update({ status: 'expired', updated_at: db.fn.now() });
      return res.status(410).json({ error: 'Service outline link has expired' });
    }

    const firstViewedAt = packet.first_viewed_at || db.fn.now();
    const [updated] = await db.transaction(async (trx) => {
      const [row] = await trx('service_outline_packets')
        .where({ id: packet.id })
        .update({
          status: packet.status === 'sent' || packet.status === 'approved' || packet.status === 'draft' ? 'viewed' : packet.status,
          first_viewed_at: firstViewedAt,
          last_viewed_at: trx.fn.now(),
          view_count: trx.raw('view_count + 1'),
          updated_at: trx.fn.now(),
        })
        .returning('*');
      await trx('service_outline_events').insert({
        packet_id: packet.id,
        customer_id: packet.customer_id || null,
        lead_id: packet.lead_id || null,
        estimate_id: packet.estimate_id || null,
        event_type: 'viewed',
        metadata_json: {},
        actor_type: 'customer',
        ip_hash: hashNullable(req.ip),
        user_agent_hash: hashNullable(req.get('user-agent')),
      });
      return [row];
    });

    res.set('X-Robots-Tag', 'noindex, noarchive');
    res.json({ packet: publicPacket(updated) });
  } catch (err) {
    next(err);
  }
});

router.post('/:token/cta-click', async (req, res, next) => {
  try {
    const tokenHash = hashToken(req.params.token);
    const packet = await db('service_outline_packets')
      .where({ token_hash: tokenHash })
      .whereNull('revoked_at')
      .first();

    if (!packet) return res.status(404).json({ error: 'Service outline not found' });
    if (packet.expires_at && new Date(packet.expires_at) <= new Date()) {
      await db('service_outline_packets')
        .where({ id: packet.id })
        .update({ status: 'expired', updated_at: db.fn.now() });
      return res.status(410).json({ error: 'Service outline link has expired' });
    }

    await db('service_outline_events').insert({
      packet_id: packet.id,
      customer_id: packet.customer_id || null,
      lead_id: packet.lead_id || null,
      estimate_id: packet.estimate_id || null,
      event_type: 'cta_clicked',
      metadata_json: {
        cta: req.body?.cta || 'view_estimate',
        target: req.body?.target || packet.content_json?.cta?.estimatePath || null,
      },
      actor_type: 'customer',
      ip_hash: hashNullable(req.ip),
      user_agent_hash: hashNullable(req.get('user-agent')),
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;

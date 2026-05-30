const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const {
  hashNullable,
  hashToken,
} = require('../services/lawn-service-outline');

const router = express.Router();
const PUBLIC_PACKET_STATUSES = new Set(['approved', 'sent', 'viewed']);
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const outlineLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
});

const outlineEventLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many service outline events. Please try again in a minute.' },
});

function canServePublicPacket(packet) {
  return packet && PUBLIC_PACKET_STATUSES.has(String(packet.status || '').toLowerCase());
}

function setPublicPacketHeaders(res) {
  res.set('X-Robots-Tag', 'noindex, noarchive');
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
}

function normalizeTokenParam(req) {
  const token = String(req.params.token || '').trim();
  return TOKEN_RE.test(token) ? token : '';
}

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

async function loadPacketForTokenHash(tokenHash) {
  const primaryPacket = await db('service_outline_packets')
    .where({ token_hash: tokenHash })
    .whereNull('revoked_at')
    .first();
  if (primaryPacket) return { packet: primaryPacket, tokenRecord: null };

  const tokenRecord = await db('service_outline_public_tokens')
    .where({ token_hash: tokenHash })
    .whereNull('revoked_at')
    .first();
  if (!tokenRecord) return { packet: null, tokenRecord: null };

  const packet = await db('service_outline_packets')
    .where({ id: tokenRecord.packet_id })
    .whereNull('revoked_at')
    .first();
  return { packet, tokenRecord };
}

function tokenExpiresAt(packet, tokenRecord) {
  return tokenRecord?.expires_at || packet?.expires_at || null;
}

router.get('/:token', outlineLimiter, async (req, res, next) => {
  try {
    setPublicPacketHeaders(res);
    const token = normalizeTokenParam(req);
    if (!token) return res.status(404).json({ error: 'Service outline not found' });
    const tokenHash = hashToken(token);
    const { packet, tokenRecord } = await loadPacketForTokenHash(tokenHash);

    if (!packet || !canServePublicPacket(packet)) return res.status(404).json({ error: 'Service outline not found' });
    const expiresAt = tokenExpiresAt(packet, tokenRecord);
    if (expiresAt && new Date(expiresAt) <= new Date()) {
      if (tokenRecord) {
        await db('service_outline_public_tokens')
          .where({ id: tokenRecord.id })
          .update({ revoked_at: db.fn.now(), updated_at: db.fn.now() });
      } else {
        await db('service_outline_packets')
          .where({ id: packet.id })
          .update({ status: 'expired', updated_at: db.fn.now() });
      }
      return res.status(410).json({ error: 'Service outline link has expired' });
    }

    const firstViewedAt = packet.first_viewed_at || db.fn.now();
    const [updated] = await db.transaction(async (trx) => {
      const [row] = await trx('service_outline_packets')
        .where({ id: packet.id })
        .update({
          status: packet.status === 'sent' || packet.status === 'approved' ? 'viewed' : packet.status,
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

    res.json({ packet: publicPacket(updated) });
  } catch (err) {
    next(err);
  }
});

router.post('/:token/cta-click', outlineEventLimiter, async (req, res, next) => {
  try {
    setPublicPacketHeaders(res);
    const token = normalizeTokenParam(req);
    if (!token) return res.status(404).json({ error: 'Service outline not found' });
    const tokenHash = hashToken(token);
    const { packet, tokenRecord } = await loadPacketForTokenHash(tokenHash);

    if (!packet || !canServePublicPacket(packet)) return res.status(404).json({ error: 'Service outline not found' });
    const expiresAt = tokenExpiresAt(packet, tokenRecord);
    if (expiresAt && new Date(expiresAt) <= new Date()) {
      if (tokenRecord) {
        await db('service_outline_public_tokens')
          .where({ id: tokenRecord.id })
          .update({ revoked_at: db.fn.now(), updated_at: db.fn.now() });
      } else {
        await db('service_outline_packets')
          .where({ id: packet.id })
          .update({ status: 'expired', updated_at: db.fn.now() });
      }
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

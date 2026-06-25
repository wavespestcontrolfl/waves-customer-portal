/**
 * Voice Agent webhook — the bilingual AI voice agent (ElevenLabs Conversational
 * AI) posts a captured lead here when a call ends. Writes the lead into the
 * existing pipeline via createLeadFromExtraction so it appears in the Leads UI
 * exactly like a transcribed-voicemail lead.
 *
 * Auth is fail-closed, mirroring hermes-auth: requires GATE_VOICE_AI_AGENT on
 * (403 otherwise) AND a configured VOICE_AGENT_WEBHOOK_SECRET (503 otherwise),
 * sent as `Authorization: Bearer <secret>` or `X-Voice-Agent-Token` and
 * compared constant-time (401 on mismatch). Mounted after express.json, so the
 * JSON body is parsed.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const logger = require('../services/logger');
const { isEnabled } = require('../config/feature-gates');
const { toE164 } = require('../utils/phone');
const { createLeadFromExtraction } = require('../services/lead-from-extraction');

function safeEqual(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function voiceAgentAuth(req, res, next) {
  if (!isEnabled('voiceAiAgent')) {
    return res.status(403).json({ error: 'voice ai agent disabled' });
  }
  const expected = process.env.VOICE_AGENT_WEBHOOK_SECRET;
  if (!expected) {
    return res.status(503).json({ error: 'voice agent webhook not configured' });
  }
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ')
    ? header.slice(7)
    : (req.headers['x-voice-agent-token'] || '');
  if (!safeEqual(provided, expected)) {
    return res.status(401).json({ error: 'invalid voice agent token' });
  }
  next();
}

function normalizeQuality(value) {
  const q = String(value || '').toLowerCase();
  return ['hot', 'warm', 'cold'].includes(q) ? q : null;
}

// POST /api/webhooks/voice-agent/lead
router.post('/lead', voiceAgentAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const phone = toE164(b.phone || b.caller_phone || b.from || '') || null;
    if (!phone) return res.status(400).json({ error: 'phone required' });

    const extracted = {
      first_name: b.first_name || null,
      last_name: b.last_name || null,
      email: b.email || null,
      address_line1: b.address_line1 || b.address || null,
      city: b.city || null,
      zip: b.zip || null,
      requested_service: b.requested_service || b.service || null,
      matched_service: b.matched_service || null,
      preferred_date_time: b.preferred_date_time || null,
      pain_points: b.pain_points || null,
      call_summary: b.summary || b.call_summary || null,
      lead_quality: normalizeQuality(b.lead_quality),
    };

    const result = await createLeadFromExtraction(extracted, {
      phone,
      toPhone: b.to_phone || b.to || null,
      callSid: b.call_sid || b.callSid || null,
      language: b.language || null,
      callDurationSeconds: Number.isFinite(Number(b.call_duration_seconds)) ? Number(b.call_duration_seconds) : null,
    });

    return res.json({ ok: true, ...result });
  } catch (err) {
    logger.error(`[voice-agent] lead webhook error: ${err.message}`);
    return res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;

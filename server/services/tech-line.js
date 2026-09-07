/**
 * Per-tech Twilio line (Field Team Program, Phase 0 item 3).
 *
 * The registry (config/twilio-numbers.js `fieldTech`) says which numbers are
 * tech lines; `technicians.twilio_number` (Team tab) says who answers on one.
 * This module is the only reader of that pairing:
 *   - technicianForLine(number)  → the assignable technician holding it, or null
 *   - ringTargetForLine(number)  → that technician's cell (E.164) — the voice
 *                                  webhook rings it BEFORE the office list
 *   - lineForTechnician(id)      → the registry entry the customer card carries
 *   - notifyTechLineText(...)    → tech-home card + one-line push for an
 *                                  inbound text on the line
 *
 * Gate: the registry answers `type: 'tech_line'` only while GATE_TECH_LINES is
 * on, and the webhooks key on that type, so this module re-reads the gate only
 * where no numberConfig exists (lineForTechnician). A line nobody assignable
 * holds behaves as an office line — the office bell / forward list still run
 * on the webhook side; there is simply no tech leg.
 *
 * Fails soft everywhere: a DB hiccup here must never break an inbound webhook
 * or a customer card read.
 */
const db = require('../models/db');
const logger = require('./logger');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { gateEnvValue } = require('../config/feature-gates');
const { isAssignable } = require('./technician-eligibility');
const { toE164, isLikelyE164 } = require('../utils/phone');

const GATE = 'GATE_TECH_LINES';
const TEXT_CARD_TYPE = 'tech_line_sms';
const PUSH_SNIPPET_CHARS = 80;
const CARD_BODY_CHARS = 500;

function registryLine(number) {
  return TWILIO_NUMBERS.fieldTech.find((t) => t.number === number) || null;
}

function maskPhone(value) {
  return String(value || '').replace(/\+1(\d{3})(\d{3})(\d{4})/g, '+1$1***$3');
}

function displayPhone(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(e164 || ''));
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(e164 || '');
}

async function technicianForLine(number, connection = db) {
  if (!registryLine(number)) return null;
  try {
    const tech = await connection('technicians')
      .where({ twilio_number: number })
      .first('id', 'name', 'phone', 'employment_status', 'field_dispatchable');
    return isAssignable(tech) ? tech : null;
  } catch (err) {
    logger.warn(`[tech-line] holder lookup failed for ${maskPhone(number)}: ${err.message}`);
    return null;
  }
}

// The cell to ring for a call on the line; null when nobody assignable holds
// it or the holder has no usable cell (the office list then rings alone).
async function ringTargetForLine(number) {
  const tech = await technicianForLine(number);
  const cell = tech ? toE164(tech.phone) : null;
  return cell && isLikelyE164(cell) ? cell : null;
}

// Registry entry for the line a technician holds, or null (gate off, no line,
// not assignable). The customer card swaps the office number for this.
async function lineForTechnician(technicianId) {
  if (!technicianId || !gateEnvValue(GATE)) return null;
  try {
    const tech = await db('technicians')
      .where({ id: technicianId })
      .first('id', 'twilio_number', 'employment_status', 'field_dispatchable');
    if (!isAssignable(tech) || !tech.twilio_number) return null;
    return registryLine(tech.twilio_number);
  } catch (err) {
    logger.warn(`[tech-line] line lookup failed for technician ${technicianId}: ${err.message}`);
    return null;
  }
}

// One tech_notifications card (kept until the tech taps "Got it") + one
// best-effort push. Returns true when the card was written.
async function notifyTechLineText({ lineNumber, from, body, customer = null, mediaCount = 0 }) {
  const tech = await technicianForLine(lineNumber);
  if (!tech) return false;
  const senderName = customer
    ? [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || displayPhone(from)
    : displayPhone(from);
  const text = String(body || '').trim();
  const mediaText = mediaCount > 0 ? `${mediaCount} photo${mediaCount === 1 ? '' : 's'}` : '';
  const snippet = text || mediaText || '(empty message)';
  try {
    await db('tech_notifications').insert({
      technician_id: tech.id,
      type: TEXT_CARD_TYPE,
      message: `Text from ${senderName}: ${snippet.slice(0, PUSH_SNIPPET_CHARS)}`,
      payload: JSON.stringify({
        headline: 'Text on your line',
        line: lineNumber,
        from,
        customer_id: customer?.id || null,
        customer_name: senderName,
        body: text.slice(0, CARD_BODY_CHARS),
        media_count: mediaCount,
      }),
    });
  } catch (err) {
    logger.error(`[tech-line] text card failed for technician ${tech.id}: ${err.message}`);
    return false;
  }
  try {
    const PushService = require('./push-notifications');
    await PushService.sendToAdminUser(tech.id, {
      title: `Text from ${senderName}`,
      body: snippet.slice(0, PUSH_SNIPPET_CHARS),
      url: '/tech',
      tag: `tech-line-${String(from || '').replace(/\D/g, '')}`,
      priority: 'high',
    });
  } catch (pushErr) {
    logger.warn(`[tech-line] push failed for technician ${tech.id} (card already written): ${pushErr.message}`);
  }
  return true;
}

module.exports = {
  GATE,
  TEXT_CARD_TYPE,
  technicianForLine,
  ringTargetForLine,
  lineForTechnician,
  notifyTechLineText,
  _test: { displayPhone },
};

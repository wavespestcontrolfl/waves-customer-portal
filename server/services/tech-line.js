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
 *   - techLineContext(id)        → { line, cell } for the tech portal's own
 *                                  call/text from the line (routes/tech-line.js)
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

// Log tags only — a knex error message can carry the failed SQL and its bound
// values (sender phone, customer name, the text itself). Never log err.message.
function errorTag(err) {
  return String((err && (err.code || err.name)) || 'error');
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
    logger.warn(`[tech-line] holder lookup failed for ${maskPhone(number)} (${errorTag(err)})`);
    return null;
  }
}

// A technician's own phone as an E.164 dial target, or null. A Waves-owned
// number is never one: technicians.phone can hold an office line (the
// owner's row does), and dialing our own Twilio number from inside /voice or
// the bridge would open a second inbound call into the same webhook.
function usableCell(tech) {
  const cell = tech ? toE164(tech.phone) : null;
  if (!cell || !isLikelyE164(cell)) return null;
  if (TWILIO_NUMBERS.isOwnedNumber(cell)) {
    logger.warn(`[tech-line] technician ${tech.id} has a Waves line as their phone — not a dial target`);
    return null;
  }
  return cell;
}

// The cell to ring for a call on the line; null when nobody assignable holds
// it or the holder has no usable cell (the office list then rings alone).
async function ringTargetForLine(number) {
  return usableCell(await technicianForLine(number));
}

// The tech portal's view of its own line: { line, cell } when the caller
// holds a line (gate on, assignable), else null. `cell` may be null (no
// usable phone on the row) — texting from the line still works, the
// press-1 bridge does not.
// `strict`: rethrow a DB failure instead of failing soft to null — the tech
// portal's own lookup must not report "no line" on an outage, or the
// client shows the personal-phone links (codex #4072 r6 P2). Inbound
// routing and the customer card keep the fail-soft default.
async function techLineContext(technicianId, { strict = false } = {}) {
  const line = await lineForTechnician(technicianId, { strict });
  if (!line) return null;
  try {
    const tech = await db('technicians').where({ id: technicianId }).first('id', 'name', 'phone');
    return { line, cell: usableCell(tech), technicianName: tech?.name || null };
  } catch (err) {
    if (strict) throw err;
    logger.warn(`[tech-line] context lookup failed for technician ${technicianId} (${errorTag(err)})`);
    return null;
  }
}

// Registry entry for the line a technician holds, or null (gate off, no line,
// not assignable). The customer card swaps the office number for this.
async function lineForTechnician(technicianId, { strict = false } = {}) {
  if (!technicianId || !gateEnvValue(GATE)) return null;
  try {
    const tech = await db('technicians')
      .where({ id: technicianId })
      .first('id', 'twilio_number', 'employment_status', 'field_dispatchable');
    if (!isAssignable(tech) || !tech.twilio_number) return null;
    return registryLine(tech.twilio_number);
  } catch (err) {
    if (strict) throw err;
    logger.warn(`[tech-line] line lookup failed for technician ${technicianId} (${errorTag(err)})`);
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
    logger.error(`[tech-line] text card failed for technician ${tech.id} (${errorTag(err)})`);
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
    logger.warn(`[tech-line] push failed for technician ${tech.id} (card already written, ${errorTag(pushErr)})`);
  }
  return true;
}

module.exports = {
  GATE,
  TEXT_CARD_TYPE,
  technicianForLine,
  ringTargetForLine,
  lineForTechnician,
  techLineContext,
  notifyTechLineText,
  _test: { displayPhone },
};

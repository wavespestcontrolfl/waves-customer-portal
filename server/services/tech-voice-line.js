/**
 * The "Waves Tech" voice line (GATE_TECH_VOICE_LINE, dark): admission for one
 * inbound call, decided BEFORE Twilio answers, so a refused call is a
 * <Reject> that Twilio does not bill.
 *
 * A call is admitted only when all hold:
 *   - the gate is on and the call is to TECH_VOICE_NUMBER (twilio-numbers.js);
 *   - the caller ID is the usable cell of an active, dispatchable technician
 *     (tech-line.js usableCell: never a Waves line). The PIN, the real factor,
 *     is checked inside the call; the carrier's STIR/SHAKEN verdict is only
 *     logged, since most real callers arrive unsigned;
 *   - the call has its own call_log row, source 'tech_voice', adopted under
 *     the per-CallSid lock /voice and /call-status share (like /relay-sandbox:
 *     a /call-status fallback row is adopted, a row any other source owns is
 *     refused). That source keeps the call out of every customer reader
 *     (relay-protocol.js whereNotSandboxCall / isInternalCallSource);
 *   - its billed minutes are reserved (tech-voice-usage.js).
 */
const logger = require('./logger');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { techVoiceLineLive } = require('../config/feature-gates');
const { toE164 } = require('../utils/phone');
const { usableCell } = require('./tech-line');
const { applyAssignable } = require('./technician-eligibility');
const { TECH_VOICE_SOURCE } = require('./voice-agent/relay-protocol');
const { reserveTechVoiceCall } = require('./tech-voice-usage');

// The technician whose own cell placed the call, or null. A cell held by two
// technician rows is ambiguous and admits nobody.
async function technicianForCell(conn, from) {
  const cell = toE164(from || '');
  if (!cell) return null;
  const techs = await applyAssignable(conn('technicians')).select('id', 'name', 'phone');
  const matches = techs.filter((t) => usableCell(t) === cell);
  return matches.length === 1 ? matches[0] : null;
}

// The call's own call_log row, or false when another source owns the CallSid.
async function stampTechVoiceCallLog(conn, { callSid, from, to, callStatus, technicianId, stirVerstat }) {
  const meta = { tech_voice: true, technician_id: technicianId, stir_verstat: stirVerstat || null };
  return conn.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [callSid]);
    const existing = await trx('call_log').where({ twilio_call_sid: callSid }).first('id', 'source');
    if (!existing) {
      await trx('call_log').insert({
        direction: 'inbound',
        from_phone: toE164(from) || null,
        to_phone: toE164(to) || null,
        twilio_call_sid: callSid,
        status: callStatus || 'ringing',
        source: TECH_VOICE_SOURCE,
        metadata: JSON.stringify(meta),
      });
      return true;
    }
    if (existing.source != null && existing.source !== TECH_VOICE_SOURCE) return false;
    await trx('call_log').where({ id: existing.id }).update({
      source: TECH_VOICE_SOURCE,
      customer_id: null,
      metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify(meta)]),
      updated_at: new Date(),
    });
    return true;
  });
}

/**
 * @returns {Promise<{ ok: true, technicianId: string } | { ok: false, reason: string }>}
 */
async function admitTechVoiceCall(conn, { callSid, from, to, callStatus, stirVerstat, now = new Date() }) {
  if (!techVoiceLineLive()) return { ok: false, reason: 'gate_off' };
  if (!TWILIO_NUMBERS.isTechVoiceLine(toE164(to || ''))) return { ok: false, reason: 'not_the_line' };
  if (!callSid) return { ok: false, reason: 'no_call_sid' };
  const tech = await technicianForCell(conn, from);
  if (!tech) return { ok: false, reason: 'unknown_caller' };
  if (!(await stampTechVoiceCallLog(conn, { callSid, from, to, callStatus, technicianId: tech.id, stirVerstat }))) {
    return { ok: false, reason: 'call_sid_owned_elsewhere' };
  }
  const reserved = await reserveTechVoiceCall(conn, { callSid, technicianId: tech.id, now });
  if (!reserved.ok) {
    logger.info(`[tech-voice] technician ${tech.id} refused: ${reserved.reason}`);
    return { ok: false, reason: reserved.reason };
  }
  return { ok: true, technicianId: tech.id };
}

module.exports = { admitTechVoiceCall, technicianForCell, stampTechVoiceCallLog };

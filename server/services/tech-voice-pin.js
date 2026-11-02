/**
 * The "Waves Tech" voice line's PIN (tech_voice_pins): the real factor of a
 * call, after the caller ID the line already checked. One PIN per
 * technician, 4 to 6 digits, stored only as a salted scrypt hash. A PIN is
 * never logged, never spoken back and never returned by any read.
 *
 *   setTechVoicePin    an admin sets or resets a technician's PIN; a reset
 *                      also clears a lockout.
 *   checkTechVoicePin  one try from a call, under the PIN row's lock so two
 *                      calls cannot race the count. A locked PIN refuses
 *                      without comparing. A wrong try counts; the fifth wrong
 *                      try in a row locks the PIN for 15 minutes and raises
 *                      one admin alert. A right try clears the count.
 */
const crypto = require('crypto');
const { promisify } = require('util');
const logger = require('./logger');

const scrypt = promisify(crypto.scrypt);

const PIN_RE = /^\d{4,6}$/;
const MAX_FAILED_TRIES = 5;
const LOCK_MS = 15 * 60 * 1000;
const KEY_BYTES = 32;

async function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pin, salt, KEY_BYTES);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function pinMatches(pin, stored) {
  const [scheme, salt, key] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  if (expected.length !== KEY_BYTES) return false;
  const actual = await scrypt(pin, Buffer.from(salt, 'base64'), KEY_BYTES);
  return crypto.timingSafeEqual(actual, expected);
}

/** @returns {Promise<{ ok: true } | { ok: false, reason: 'pin_format' }>} */
async function setTechVoicePin(conn, { technicianId, pin }) {
  const value = String(pin == null ? '' : pin);
  if (!PIN_RE.test(value)) return { ok: false, reason: 'pin_format' };
  const pinHash = await hashPin(value);
  await conn('tech_voice_pins')
    .insert({ technician_id: technicianId, pin_hash: pinHash, failed_attempts: 0, locked_until: null, updated_at: new Date() })
    .onConflict('technician_id')
    .merge(['pin_hash', 'failed_attempts', 'locked_until', 'updated_at']);
  return { ok: true };
}

// Whether the technician has a PIN at all (never the PIN itself).
async function hasTechVoicePin(conn, technicianId) {
  return Boolean(await conn('tech_voice_pins').where({ technician_id: technicianId }).first('technician_id'));
}

// One admin alert per lockout: someone failed five times in a row on this
// technician's line (the technician forgot it, or someone else is guessing).
async function alertLockout({ technicianId, technicianName, lockedUntil }) {
  try {
    const { raiseAdminAlert } = require('./admin-alert-compose');
    const first = String(technicianName || '').trim().split(/\s+/)[0] || '';
    await raiseAdminAlert('system', {
      area: 'System',
      action: first ? `check ${first}'s voice line PIN lockout` : 'check a voice line PIN lockout',
      why: 'Five wrong PINs in a row locked this technician out of the voice line for 15 minutes.',
      severity: 'needs-you',
      link: '/admin/timetracking?tab=team',
      subject: { type: 'check', id: `tech-voice-pin:${technicianId}` },
      doneWhen: 'pin_checked',
      who: 'person',
    }, {
      dedupeKey: `tech-voice-pin-locked:${technicianId}:${lockedUntil.toISOString()}`,
      detail: `${technicianName || 'A technician'}'s voice line PIN was entered wrong five times in a row, so the line refuses `
        + 'that PIN for 15 minutes. If the technician forgot it, set a new one in the Team tab. If they did not call, '
        + 'someone may be calling with their caller ID: reset the PIN and tell them. No PIN was logged.',
      metadata: { technicianId: String(technicianId) },
    });
  } catch (err) {
    logger.warn(`[tech-voice-pin] lockout alert failed for technician ${technicianId} (${String(err?.code || err?.name || 'error')})`);
  }
}

/**
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'no_pin'|'locked'|'wrong_pin'|'locked_now' }>}
 */
async function checkTechVoicePin(conn, { technicianId, technicianName = null, pin, now = new Date() }) {
  const value = String(pin == null ? '' : pin);
  const result = await conn.transaction(async (trx) => {
    const row = await trx('tech_voice_pins').where({ technician_id: technicianId }).forUpdate()
      .first('pin_hash', 'failed_attempts', 'locked_until');
    if (!row) return { ok: false, reason: 'no_pin' };
    const lockedUntil = row.locked_until ? new Date(row.locked_until) : null;
    if (lockedUntil && lockedUntil > now) return { ok: false, reason: 'locked' };
    if (PIN_RE.test(value) && await pinMatches(value, row.pin_hash)) {
      if (row.failed_attempts || lockedUntil) {
        await trx('tech_voice_pins').where({ technician_id: technicianId }).update({ failed_attempts: 0, locked_until: null, updated_at: now });
      }
      return { ok: true };
    }
    // A lapsed lock starts a fresh count.
    const failed = (lockedUntil ? 0 : Number(row.failed_attempts) || 0) + 1;
    const lock = failed >= MAX_FAILED_TRIES ? new Date(now.getTime() + LOCK_MS) : null;
    await trx('tech_voice_pins').where({ technician_id: technicianId }).update({
      failed_attempts: failed, locked_until: lock, updated_at: now,
    });
    return lock ? { ok: false, reason: 'locked_now', lockedUntil: lock } : { ok: false, reason: 'wrong_pin' };
  });
  if (result.reason === 'locked_now') {
    await alertLockout({ technicianId, technicianName, lockedUntil: result.lockedUntil });
    return { ok: false, reason: 'locked_now' };
  }
  return result;
}

module.exports = {
  PIN_RE,
  MAX_FAILED_TRIES,
  setTechVoicePin,
  hasTechVoicePin,
  checkTechVoicePin,
  _test: { hashPin, pinMatches, LOCK_MS },
};

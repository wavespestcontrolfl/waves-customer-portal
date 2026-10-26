'use strict';

/**
 * Active technicians' own phones as STAFF SENDERS (census M12, GATE_TECH_STAFF_GUARDS).
 *
 * The env staff list (TWILIO_NUMBERS.staffForwardLast10) knows only owner and office phones.
 * A second technician texts or calls an office line from his own cell; without this he is an
 * "Unknown" customer thread, and his call runs the customer call pipeline.
 *
 * Only the question "is this INBOUND SENDER staff?" asks this module. It must never decide who
 * receives an outbound message: the owner phone set in services/twilio.js, tech-line.js's
 * "phone on file is a Waves number" check and the outbound-voicemail admin check stay env-only.
 *
 * A phone that is BOTH an active technician's and on a live customer record (primary, secondary or
 * service-contact slot) stays a customer: it is left out of the set and counted in one log line
 * (no name, no number). Gate off: nothing here reads the database and every answer is false.
 *
 * The set is cached for 60 seconds and read synchronously (the call pipeline asks from sync
 * helpers). Async entry points call refresh() once first. A failed load keeps the old set, and a
 * set that never loaded answers false, which is today's behavior.
 */
const db = require('../models/db');
const logger = require('./logger');
const gates = require('../config/feature-gates');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { knownCallerPhoneExists } = require('../utils/known-caller-phone');

const TTL_MS = 60 * 1000;
const RETRY_MS = 10 * 1000;

let cache = { at: 0, keys: new Set() };
let inflight = null;
let lastSharedCount = 0;

const live = () => typeof gates.techStaffGuardsLive === 'function' && gates.techStaffGuardsLive();

function last10(phone) {
  const digits = String(phone == null ? '' : phone).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

async function loadKeys() {
  const rows = await db('technicians')
    .where({ employment_status: 'active' })
    .whereNotNull('phone')
    .select('phone');
  const candidates = [...new Set(rows.map((r) => last10(r.phone)).filter(Boolean))];
  const keys = new Set();
  let shared = 0;
  for (const key of candidates) {
    // The owner's technician row holds the office line: a Waves line is internal already and
    // is never a staff SENDER through this set.
    if (TWILIO_NUMBERS.isOwnedNumber(key)) continue;
    if (await knownCallerPhoneExists(db, key)) { shared += 1; continue; }
    keys.add(key);
  }
  if (shared !== lastSharedCount) {
    lastSharedCount = shared;
    if (shared > 0) logger.info(`[staff-sender] ${shared} active technician phone(s) also on a customer record stay customers`);
  }
  return keys;
}

// Load (or reuse) the set. Never throws; callers go on with whatever set is cached.
async function refresh() {
  if (!live()) return;
  if (Date.now() - cache.at < TTL_MS) return;
  if (!inflight) {
    inflight = loadKeys()
      .then((keys) => { cache = { at: Date.now(), keys }; })
      .catch((err) => {
        logger.warn(`[staff-sender] technician phone load failed: ${err.code || err.name || 'error'}`);
        cache = { at: Date.now() - TTL_MS + RETRY_MS, keys: cache.keys };
      })
      .finally(() => { inflight = null; });
  }
  await inflight;
}

// Sync answer from the cached set. False when the gate is off or the set never loaded.
function isStaffTechPhone(phone) {
  if (!live()) return false;
  const key = last10(phone);
  return Boolean(key) && cache.keys.has(key);
}

// For async entry points: load first, then answer.
async function isStaffTechSender(phone) {
  await refresh();
  return isStaffTechPhone(phone);
}

function resetForTests() {
  cache = { at: 0, keys: new Set() };
  inflight = null;
  lastSharedCount = 0;
}

module.exports = { refresh, isStaffTechPhone, isStaffTechSender, resetForTests };

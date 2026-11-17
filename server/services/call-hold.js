'use strict';

/**
 * Star-key hold on the conference call path (GATE_CALL_HOLD, owner 2026-11-16 "ok build all").
 * The staff press star in the room (<Dial hangupOnStar>): Twilio takes them out and the action URL
 * runs startHold. The caller (a conference participant) is put on hold with a holdUrl that speaks the
 * pest-fact script, and the call recording pauses. The staff press 1 on the menu: endHold takes the
 * caller off hold, closes the claim and resumes the recording.
 *
 * State: call_log.metadata.conference_path.hold { open, open_at, by, leg_sid, count, total_sec }.
 * Every change is one conditional UPDATE, so a double star or a redelivered webhook cannot claim twice.
 * No function here throws to the route; logs carry masked SIDs and error codes only.
 */

const twilio = require('twilio');
const logger = require('./logger');
const featureGates = require('../config/feature-gates');
const conferencePath = require('./call-conference-path');

const WEBHOOK_BASE = '/api/webhooks/twilio';
const NOT_CLOSED_SQL = "(metadata #>> '{conference_path,closed_at}') IS NULL";
const HAS_STATE_SQL = "(metadata -> 'conference_path') IS NOT NULL";
const HOLD_OPEN_SQL = "(metadata #>> '{conference_path,hold,open}') = 'true'";
const HOLD_NOT_OPEN_SQL = "COALESCE(metadata #>> '{conference_path,hold,open}', 'false') <> 'true'";

// Read through the module object at call time: a suite that mocks feature-gates as a bare object reads off.
const isEnabled = () => typeof featureGates.callHoldLive === 'function' && featureGates.callHoldLive();
const masked = (sid) => (sid ? `…${String(sid).slice(-6)}` : 'none');
// Errors are logged by code only: a Twilio error message can carry a phone number.
const errorCode = (err) => String(err?.code || err?.status || err?.name || 'error');
const isGone = (err) => err?.status === 404 || Number(err?.code) === 20404;
const client = () => twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const publicUrl = (path) => `https://${process.env.SERVER_DOMAIN || 'portal.wavespestcontrol.com'}${path}`;

function holdFrom(state) {
  const hold = state?.hold;
  return hold && typeof hold === 'object' ? hold : { open: false, count: 0, total_sec: 0 };
}

// { open, closed, found }: for the routes. A read error answers open: the staff stay on the menu and the
// caller keeps the script, rather than the staff rejoining a room while the caller is still held.
async function holdState(callSid) {
  try {
    const state = await conferencePath.loadState(callSid);
    return { found: Boolean(state), open: Boolean(state?.hold?.open), closed: Boolean(state?.closed_at) };
  } catch (err) {
    logger.warn(`[call-hold] state read failed for ${masked(callSid)} (${errorCode(err)})`);
    return { found: false, open: true, closed: false, error: true };
  }
}

// The open room of the call: its SID, or null when the caller's room is gone. Throws on a REST error.
async function findRoomSid(callSid) {
  const rooms = await client().conferences.list({ friendlyName: conferencePath.roomFor(callSid), status: 'in-progress', limit: 5 });
  return rooms?.[0]?.sid || null;
}

// True when the caller's room is open. A lookup error answers true: the staff rejoin rather than hang up.
async function roomIsOpen(callSid) {
  try {
    return Boolean(await findRoomSid(callSid));
  } catch (err) {
    logger.warn(`[call-hold] room lookup failed for ${masked(callSid)} (${errorCode(err)})`);
    return true;
  }
}

const writeHold = (callSid, hold, conditions) => conferencePath.updateState(callSid, [[['hold'], hold]], conditions);

async function pauseRecording(callSid) {
  try {
    await client().calls(callSid).recordings('Twilio.CURRENT').update({ status: 'paused', pauseBehavior: 'silence' });
  } catch (err) {
    logger.error(`[call-hold] recording not paused for ${masked(callSid)} (${errorCode(err)}); the hold stays`);
  }
}

async function resumeRecording(callSid) {
  try {
    await client().calls(callSid).recordings('Twilio.CURRENT').update({ status: 'in-progress' });
  } catch (err) {
    logger.error(`[call-hold] recording NOT resumed for ${masked(callSid)} (${errorCode(err)}); the rest of the recording is silent`);
  }
}

// One claim: never while a hold is open, never after the caller left. Returns the open hold or null.
async function claimHold(callSid, { by, legSid }) {
  const prev = holdFrom(await conferencePath.loadState(callSid));
  const hold = {
    open: true,
    open_at: new Date().toISOString(),
    by: by || 'star',
    leg_sid: legSid || null,
    count: (Number(prev.count) || 0) + 1,
    total_sec: Number(prev.total_sec) || 0,
  };
  const won = await writeHold(callSid, hold, [HAS_STATE_SQL, NOT_CLOSED_SQL, HOLD_NOT_OPEN_SQL]);
  return won > 0 ? { hold, prev } : null;
}

const releaseClaim = (callSid, prev) => writeHold(callSid, { ...prev, open: false }, [HAS_STATE_SQL, HOLD_OPEN_SQL])
  .catch((err) => logger.warn(`[call-hold] claim not released for ${masked(callSid)} (${errorCode(err)})`));

// The claim lost: a hold already open (a redelivered star) is held; a closed call is gone.
async function startHoldWithoutClaim(callSid) {
  const state = await holdState(callSid);
  if (state.closed) return 'no_room';
  return state.open && !state.error ? 'held' : 'failed';
}

// 'held' | 'no_room' | 'failed'. Never throws.
async function startHold(callSid, { by = 'star', legSid = null } = {}) {
  let claim = null;
  try {
    claim = await claimHold(callSid, { by, legSid });
    if (!claim) return await startHoldWithoutClaim(callSid);
    const roomSid = await findRoomSid(callSid);
    if (!roomSid) {
      await releaseClaim(callSid, claim.prev);
      return 'no_room';
    }
    await client().conferences(roomSid).participants(callSid).update({
      hold: true,
      holdUrl: publicUrl(`${WEBHOOK_BASE}/conference-hold-facts?parent=${encodeURIComponent(callSid)}&step=0`),
      holdMethod: 'POST',
    });
    await pauseRecording(callSid);
    logger.info(`[call-hold] caller ${masked(callSid)} on hold (${by})`);
    return 'held';
  } catch (err) {
    logger.warn(`[call-hold] hold not started for ${masked(callSid)} (${errorCode(err)})`);
    if (claim) await releaseClaim(callSid, claim.prev);
    return isGone(err) ? 'no_room' : 'failed';
  }
}

// Close the open claim and add its seconds to total_sec. 0 = nothing was open (another request closed it).
async function closeClaim(callSid) {
  const hold = holdFrom(await conferencePath.loadState(callSid));
  if (!hold.open) return 0;
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(hold.open_at || '')) / 1000)) || 0;
  return writeHold(callSid, { ...hold, open: false, total_sec: (Number(hold.total_sec) || 0) + seconds }, [HAS_STATE_SQL, HOLD_OPEN_SQL]);
}

// closeClaim that never throws: -1 when the write failed (unknown whether another request closed it).
const closeClaimSafely = (callSid) => closeClaim(callSid).catch((err) => {
  logger.error(`[call-hold] hold claim not closed for ${masked(callSid)} (${errorCode(err)})`);
  return -1;
});

// 'returned' | 'no_room' | 'failed'. Takes the caller off hold FIRST, then closes the claim, then
// resumes the recording. Once the caller is off hold the answer is 'returned' even when the claim
// write fails, so the staff always go back to a caller who is waiting in the room. Never throws.
async function endHold(callSid) {
  try {
    const roomSid = await findRoomSid(callSid);
    if (!roomSid) {
      await closeClaimSafely(callSid);
      return 'no_room';
    }
    await client().conferences(roomSid).participants(callSid).update({ hold: false });
  } catch (err) {
    if (isGone(err)) {
      await closeClaimSafely(callSid);
      return 'no_room';
    }
    logger.warn(`[call-hold] hold not ended for ${masked(callSid)} (${errorCode(err)})`);
    return 'failed';
  }
  // 0 = a duplicate press 1 closed it first and resumes the recording itself.
  if ((await closeClaimSafely(callSid)) !== 0) await resumeRecording(callSid);
  logger.info(`[call-hold] caller ${masked(callSid)} back from hold`);
  return 'returned';
}

module.exports = { isEnabled, startHold, endHold, holdState, roomIsOpen };

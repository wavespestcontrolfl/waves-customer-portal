'use strict';

/**
 * Star-key hold on the conference call path (GATE_CALL_HOLD, owner 2026-11-16 "ok build all").
 * The staff press star in the room (<Dial hangupOnStar>): Twilio takes them out and the action URL
 * runs startHold. The caller (a conference participant) is put on hold with a holdUrl that speaks the
 * pest-fact script, and the call recording pauses. The staff press 1 on the menu: endHold takes the
 * caller off hold, closes the claim and resumes the recording.
 *
 * Hold timer (same gate): the 3 minute reminder and the 5 minute limit ride the loops Twilio already runs
 * (/conference-hold-facts about every 10 s, /conference-staff-menu every ~15 s), measured from open_at; no
 * timer of our own. At the limit, or when the staff phone hangs up during the hold, startHoldVoicemail claims
 * once and ENDS THE ROOM: the caller's <Dial> action then runs /call-complete?conf=1, which sees the claim and
 * lets the caller leave a message inside the call's own recording (never a <Record>, never a redirect).
 *
 * State: call_log.metadata.conference_path.hold { open, open_at, by, leg_sid, count, total_sec,
 * voicemail_at, voicemail_reason }.
 * Every change is one conditional UPDATE, so a double star or a redelivered webhook cannot claim twice.
 * No function here throws to the route; logs carry masked SIDs and error codes only.
 */

const twilio = require('twilio');
const db = require('../models/db');
const logger = require('./logger');
const featureGates = require('../config/feature-gates');
const conferencePath = require('./call-conference-path');

const WEBHOOK_BASE = '/api/webhooks/twilio';
const NOT_CLOSED_SQL = "(metadata #>> '{conference_path,closed_at}') IS NULL";
const HAS_STATE_SQL = "(metadata -> 'conference_path') IS NOT NULL";
const HOLD_OPEN_SQL = "(metadata #>> '{conference_path,hold,open}') = 'true'";
const HOLD_NOT_OPEN_SQL = "COALESCE(metadata #>> '{conference_path,hold,open}', 'false') <> 'true'";
const HOLD_NO_VOICEMAIL_SQL = "(metadata #>> '{conference_path,hold,voicemail_at}') IS NULL";
// A hold open this long is told to the staff phone (reminder) and sent to voicemail (limit). Owner-approved.
const HOLD_REMINDER_SEC = 180;
const HOLD_LIMIT_SEC = 300;

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

// { open, closed, found, openAt, voicemailAt }: for the routes. A read error answers open: the staff stay on
// the menu and the caller keeps the script, rather than the staff rejoining a room while the caller is held.
async function holdState(callSid) {
  try {
    const state = await conferencePath.loadState(callSid);
    return {
      found: Boolean(state),
      open: Boolean(state?.hold?.open),
      closed: Boolean(state?.closed_at),
      openAt: state?.hold?.open_at || null,
      voicemailAt: state?.hold?.voicemail_at || null,
    };
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

const secondsSince = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso || '')) / 1000)) || 0;

// Seconds the open hold has lasted, or 0 when none is open.
const heldSeconds = (state) => (state?.open && state.openAt ? secondsSince(state.openAt) : 0);

// One claim, one conditional UPDATE: the whole hold object, closed, with the voicemail stamp. Returns
// { hold, prev } or null (no hold open, one already went to voicemail, the call closed: another request won).
async function claimHoldVoicemail(callSid, reason) {
  const prev = holdFrom(await conferencePath.loadState(callSid));
  if (!prev.open || prev.voicemail_at) return null;
  const hold = {
    ...prev,
    open: false,
    voicemail_at: new Date().toISOString(),
    voicemail_reason: reason,
    total_sec: (Number(prev.total_sec) || 0) + secondsSince(prev.open_at),
  };
  const won = await writeHold(callSid, hold, [HAS_STATE_SQL, NOT_CLOSED_SQL, HOLD_OPEN_SQL, HOLD_NO_VOICEMAIL_SQL]);
  return won > 0 ? { hold, prev } : null;
}

// Puts the hold back as it was, only while our own stamp is still on it.
const restoreHold = (callSid, claim) => writeHold(callSid, claim.prev, [HAS_STATE_SQL, { sql: "(metadata #>> '{conference_path,hold,voicemail_at}') = ?", bindings: [claim.hold.voicemail_at] }])
  .catch((err) => logger.warn(`[call-hold] voicemail claim not restored for ${masked(callSid)} (${errorCode(err)})`));

// Ends every open room of the call. A room that is already gone (404) does not count. Throws on any other error.
async function endOpenRooms(callSid) {
  const api = client();
  const rooms = await api.conferences.list({ friendlyName: conferencePath.roomFor(callSid), status: 'in-progress', limit: 5 });
  let ended = 0;
  for (const room of rooms || []) {
    try {
      await api.conferences(room.sid).update({ status: 'completed' });
      ended += 1;
    } catch (err) {
      if (!isGone(err)) throw err;
    }
  }
  return ended;
}

// The alert says who to call back: the customer on the call, else the one name on file for the number.
async function callerNameFor(call) {
  const { realName, nameOnFileForPhone } = require('./admin-alert-names');
  try {
    if (call.customer_id) return realName(await db('customers').where('id', call.customer_id).first('first_name', 'last_name'));
    return await nameOnFileForPhone(db, call.from_phone);
  } catch (err) {
    logger.warn(`[call-hold] caller name lookup failed (${errorCode(err)})`);
    return null;
  }
}

const VOICEMAIL_WHY = {
  timeout: 'Waited 5 minutes on hold, then went to voicemail.',
  staff_left: 'The staff phone hung up during a hold; the caller went to voicemail.',
};

// One bell per call (dedupeKey on the CallSid). A failure is logged by code and never stops the voicemail.
async function raiseVoicemailAlert(callSid, reason) {
  try {
    const call = await db('call_log').where('twilio_call_sid', callSid).first('id', 'customer_id', 'from_phone');
    if (!call) return;
    const { raiseAdminAlert } = require('./admin-alert-compose');
    const { fitAction } = require('./admin-alert-names');
    const name = await callerNameFor(call);
    await raiseAdminAlert('voicemail_callback', {
      area: 'Comms',
      action: name ? fitAction('Comms', name, [(n) => `call ${n} back`]) : 'call back an unknown caller',
      why: VOICEMAIL_WHY[reason] || VOICEMAIL_WHY.timeout,
      severity: 'needs-you',
      link: `/admin/communications#tab=calls&call=${encodeURIComponent(call.id)}`,
      subject: { type: 'call', id: String(call.id) },
      doneWhen: 'caller_reached',
      who: 'person',
    }, {
      bell: true,
      dedupeKey: `call-hold-voicemail:${callSid}`,
      // payload = what the relevance sweep reads (class hold_voicemail): the caller's number, and no call id, so the
      // bell is judged from its own time and closes once a person reaches the caller after it.
      metadata: { callLogId: call.id, reason, payload: { customerId: call.customer_id || null, phone: call.from_phone || null } },
    });
  } catch (err) {
    logger.error(`[call-hold] voicemail alert not raised for ${masked(callSid)} (${errorCode(err)})`);
  }
}

// 'started' | 'not_needed' | 'caller_gone' | 'failed'. Never throws. The hold limit passed, or the staff phone
// hung up during the hold: claim once, end the room (the caller's <Dial> action then runs /call-complete,
// which lets the caller leave a message), then raise the alert. A room that is already gone keeps the claim
// and rings nothing (the caller left). Any other Twilio error restores the hold: the next loop tries again.
async function startHoldVoicemail(callSid, reason) {
  let claim = null;
  try {
    claim = await claimHoldVoicemail(callSid, reason);
    if (!claim) return 'not_needed';
    if (!(await endOpenRooms(callSid))) return 'caller_gone';
  } catch (err) {
    logger.warn(`[call-hold] hold voicemail not started for ${masked(callSid)} (${errorCode(err)})`);
    if (claim) await restoreHold(callSid, claim);
    return 'failed';
  }
  logger.info(`[call-hold] caller ${masked(callSid)} sent to voicemail (${reason})`);
  await raiseVoicemailAlert(callSid, reason);
  return 'started';
}

module.exports = {
  HOLD_REMINDER_SEC, HOLD_LIMIT_SEC, isEnabled, startHold, endHold, holdState, roomIsOpen, heldSeconds, startHoldVoicemail, resumeRecording,
};

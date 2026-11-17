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
 * voicemail_at, voicemail_reason, return_at }.
 * Every change is one conditional UPDATE, so a double star or a redelivered webhook cannot claim twice.
 * Return and voicemail exclude each other: endHold stamps return_at (only while the hold is open with no
 * voicemail stamp) BEFORE it asks Twilio to unhold, and the voicemail claim needs no live return_at, so one
 * of the two wins and the other does nothing. A return claim older than RETURN_CLAIM_STALE_SEC is abandoned
 * (the Twilio call failed and its release write failed too) and no longer blocks either transition. A star
 * that finds an open claim WITH a return_at knows the unhold went through (the staff are back in the room)
 * and only the close write was lost: it closes that claim and starts a fresh hold.
 * The staff phone hanging up (call-conference-path onWinnerLegEnded) while a press 1 holds the return claim stamps
 * hold.voicemail_pending = 'staff_left' in a write conditional on the hold still being open. The press 1 then
 * closes its claim only while voicemail_pending is null, so exactly one of two things happens: the close wins (the
 * staff rejoined, today's room end runs when they hang up) or the stamp wins (the staff are gone, the caller was
 * unheld, and endHold runs the staff_left voicemail itself; if that fails it puts the caller back on hold so the
 * hold script's next fetch retries).
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
const RETURN_AT_PATH = "metadata #>> '{conference_path,hold,return_at}'";
const PENDING_PATH = "metadata #>> '{conference_path,hold,voicemail_pending}'";
const HOLD_NO_PENDING_SQL = `(${PENDING_PATH}) IS NULL`;
// A hold open this long is told to the staff phone (reminder) and sent to voicemail (limit). Owner-approved.
const HOLD_REMINDER_SEC = 180;
const HOLD_LIMIT_SEC = 300;
// A return claim that old belongs to a request that is gone (a REST call ends in seconds).
const RETURN_CLAIM_STALE_SEC = 30;

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

// { open, closed, found, openAt, voicemailAt, returnAt, voicemailPending }: for the routes. A read error answers open: the staff stay on
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
      returnAt: state?.hold?.return_at || null,
      voicemailPending: state?.hold?.voicemail_pending || null,
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

// A hold object without its transient marks: the return claim and the pending voicemail reason.
const withoutReturn = ({ return_at: _returnAt, voicemail_pending: _pending, ...rest }) => rest;
const secondsSince = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso || '')) / 1000)) || 0;
// A return claim another request is still working on. A stale one (its request is gone) blocks nothing.
const returnInFlight = (hold) => Boolean(hold.return_at) && secondsSince(hold.return_at) < RETURN_CLAIM_STALE_SEC;
// SQL twin of returnInFlight: no return_at, or one older than the stale limit (ISO strings sort by time).
// `orStaffLeft` (the voicemail claim): a pending staff_left reason means the staff phone is gone, so a press 1 still
// in flight is moot and no longer blocks the voicemail (see claimReturn and the close in endHold).
const returnFreeCondition = ({ orStaffLeft = false } = {}) => ({
  sql: orStaffLeft ? `(COALESCE(${RETURN_AT_PATH}, '') < ? OR (${PENDING_PATH}) IS NOT NULL)` : `COALESCE(${RETURN_AT_PATH}, '') < ?`,
  bindings: [new Date(Date.now() - RETURN_CLAIM_STALE_SEC * 1000).toISOString()],
});

async function pauseRecording(callSid) {
  try {
    await client().calls(callSid).recordings('Twilio.CURRENT').update({ status: 'paused', pauseBehavior: 'silence' });
  } catch (err) {
    logger.error(`[call-hold] recording not paused for ${masked(callSid)} (${errorCode(err)}); the hold stays`);
  }
}

// true when Twilio accepted the resume, false when it did not. Never throws.
async function resumeRecording(callSid) {
  try {
    await client().calls(callSid).recordings('Twilio.CURRENT').update({ status: 'in-progress' });
    return true;
  } catch (err) {
    logger.error(`[call-hold] recording NOT resumed for ${masked(callSid)} (${errorCode(err)}); the rest of the recording is silent`);
    return false;
  }
}

// Pause the recording for a hold, then check the pause did not land AFTER the voicemail's resume. The voicemail
// claim commits before it ends the room, and the room end comes before /call-complete resumes the recording, so a
// re-read after the pause finished has two outcomes: it sees the voicemail stamp (or the hold gone), and this resumes
// the recording itself; or it does not, so the claim commits after the pause finished and the resume comes later.
// A state read that fails leaves the pause (the hold is the likely case). Never throws.
async function pauseRecordingForHold(callSid) {
  await pauseRecording(callSid);
  const state = await holdState(callSid);
  if (!state.error && (state.voicemailAt || !state.open)) await resumeRecording(callSid);
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

const holdParticipant = (callSid, roomSid) => client().conferences(roomSid).participants(callSid).update({
  hold: true,
  holdUrl: publicUrl(`${WEBHOOK_BASE}/conference-hold-facts?parent=${encodeURIComponent(callSid)}&step=0`),
  holdMethod: 'POST',
});

// A star that finds an open claim with a return_at: the earlier press 1 took the caller off hold (the staff
// are in the room again) and only its close write was lost, or the unhold failed and the release write was
// lost. Either way that claim is not a hold applied now: close it so this star can start a fresh one. (A REST
// read of the participant would cost a call and still not say which claim is ours.) closeClaim is declared below.
async function closeReturnedClaim(callSid) {
  const hold = holdFrom(await conferencePath.loadState(callSid));
  return hold.open && hold.return_at && !hold.voicemail_at ? closeClaim(callSid) : 0;
}

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
    if (!claim && (await closeReturnedClaim(callSid)) > 0) claim = await claimHold(callSid, { by, legSid });
    if (!claim) return await startHoldWithoutClaim(callSid);
    const roomSid = await findRoomSid(callSid);
    if (!roomSid) {
      await releaseClaim(callSid, claim.prev);
      return 'no_room';
    }
    await holdParticipant(callSid, roomSid);
    await pauseRecordingForHold(callSid);
    logger.info(`[call-hold] caller ${masked(callSid)} on hold (${by})`);
    return 'held';
  } catch (err) {
    logger.warn(`[call-hold] hold not started for ${masked(callSid)} (${errorCode(err)})`);
    if (claim) await releaseClaim(callSid, claim.prev);
    return isGone(err) ? 'no_room' : 'failed';
  }
}

// Close the open claim and add its seconds to total_sec (up to the return, when one was claimed). 0 = nothing
// was open (another request closed it).
async function closeClaim(callSid, { unlessStaffLeft = false } = {}) {
  const hold = holdFrom(await conferencePath.loadState(callSid));
  if (!hold.open) return 0;
  const seconds = secondsSince(hold.open_at) - (hold.return_at ? secondsSince(hold.return_at) : 0);
  return writeHold(callSid, { ...withoutReturn(hold), open: false, total_sec: (Number(hold.total_sec) || 0) + Math.max(0, seconds) },
    unlessStaffLeft ? [HAS_STATE_SQL, HOLD_OPEN_SQL, HOLD_NO_PENDING_SQL] : [HAS_STATE_SQL, HOLD_OPEN_SQL]);
}

// closeClaim that never throws: -1 when the write failed (unknown whether another request closed it).
// `unlessStaffLeft`: do not close while a staff_left voicemail is pending (0 then).
const closeClaimSafely = (callSid, options) => closeClaim(callSid, options).catch((err) => {
  logger.error(`[call-hold] hold claim not closed for ${masked(callSid)} (${errorCode(err)})`);
  return -1;
});

// Why a return cannot be claimed: 'voicemail' (the caller went to voicemail, or the staff phone hung up and that
// voicemail is pending), 'idle' (no hold is open: a
// duplicate press 1, nothing to claim), 'busy' (another press 1 is working), or null (free to claim).
function returnBlockedBy(hold) {
  if (hold.voicemail_at || hold.voicemail_pending) return 'voicemail';
  if (!hold.open) return 'idle';
  return returnInFlight(hold) ? 'busy' : null;
}

// One conditional UPDATE: return_at is set only while the hold is open, has no voicemail stamp and no live return
// claim, so it and claimHoldVoicemail cannot both win. { stamp, hold } | { stamp: null } (nothing to claim) | { lost }.
async function claimReturn(callSid) {
  const hold = holdFrom(await conferencePath.loadState(callSid));
  let blocked = returnBlockedBy(hold);
  if (!blocked) {
    const stamp = new Date().toISOString();
    const won = await writeHold(callSid, { ...hold, return_at: stamp }, [HAS_STATE_SQL, HOLD_OPEN_SQL, HOLD_NO_VOICEMAIL_SQL, HOLD_NO_PENDING_SQL, returnFreeCondition()]);
    if (won > 0) return { stamp, hold };
    blocked = returnBlockedBy(holdFrom(await conferencePath.loadState(callSid))) || 'busy';
  }
  return blocked === 'idle' ? { stamp: null } : { lost: blocked };
}

// Fails closed: a claim read or write that errors answers { lost: 'failed' }, never an unclaimed unhold. The error may
// be one request's own, while another request has already won the voicemail claim; the staff stay on the menu and
// press 1 again once the claim can be read.
const claimReturnSafely = (callSid) => claimReturn(callSid).catch((err) => {
  logger.warn(`[call-hold] return not claimed for ${masked(callSid)} (${errorCode(err)})`);
  return { lost: 'failed' };
});

// The unhold did not happen: lift our own return claim so the next press 1 or the 5 minute limit can act.
// If this write fails too, the claim goes stale after RETURN_CLAIM_STALE_SEC and blocks nothing. A staff_left
// stamp that landed meanwhile is never overwritten (the write then does nothing; the pending voicemail ignores
// a return claim anyway).
const releaseReturn = (callSid, claim) => (claim.stamp
  ? writeHold(callSid, withoutReturn(claim.hold), [HAS_STATE_SQL, HOLD_OPEN_SQL, HOLD_NO_PENDING_SQL, { sql: `(${RETURN_AT_PATH}) = ?`, bindings: [claim.stamp] }])
    .catch((err) => logger.warn(`[call-hold] return claim not released for ${masked(callSid)} (${errorCode(err)})`))
  : Promise.resolve());

// 'returned' | 'voicemail' | 'no_room' | 'failed'. Claims the return FIRST (so the 5 minute voicemail cannot
// claim the same room), takes the caller off hold, then closes the claim, then resumes the recording. Once the
// caller is off hold the answer is 'returned' even when the close write fails, so the staff always go back to
// a caller who is waiting in the room. 'voicemail' = the caller already went to voicemail. Never throws.
async function endHold(callSid) {
  const claim = await claimReturnSafely(callSid);
  if (claim.lost) return claim.lost === 'voicemail' ? 'voicemail' : 'failed';
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
    await releaseReturn(callSid, claim);
    return 'failed';
  }
  // 0 = the claim was already closed (a duplicate press 1, or no claim was open) or a staff_left stamp blocked the
  // close: nothing to resume here.
  const closed = await closeClaimSafely(callSid, { unlessStaffLeft: Boolean(claim.stamp) });
  if (closed === 0 && claim.stamp) {
    const gone = await staffLeftDuringReturn(callSid);
    if (gone) return gone;
  }
  if (closed !== 0) await resumeRecording(callSid);
  logger.info(`[call-hold] caller ${masked(callSid)} back from hold`);
  return 'returned';
}

// Our close found the hold changed under us. The voicemail won the claim ('voicemail'), or the staff phone hung up
// while our unhold was in flight (voicemail_pending): the staff are gone and the caller is unheld and alone, so
// run the staff_left voicemail here. If it cannot start (the hold was restored) put the caller back on hold, so
// the hold script's next fetch retries it. null = nothing of that kind (the hold was just closed already).
async function staffLeftDuringReturn(callSid) {
  const state = await holdState(callSid);
  if (state.voicemailAt) return 'voicemail';
  if (!state.open || !state.voicemailPending) return null;
  if ((await startHoldVoicemail(callSid, state.voicemailPending)) === 'failed') await holdAgain(callSid);
  return 'voicemail';
}

async function holdAgain(callSid) {
  try {
    const roomSid = await findRoomSid(callSid);
    if (roomSid) await holdParticipant(callSid, roomSid);
    await pauseRecordingForHold(callSid);
  } catch (err) {
    logger.error(`[call-hold] caller ${masked(callSid)} not put back on hold (${errorCode(err)})`);
  }
}

// Seconds the open hold has lasted, or 0 when none is open.
const heldSeconds = (state) => (state?.open && state.openAt ? secondsSince(state.openAt) : 0);

// One claim, one conditional UPDATE: the whole hold object, closed, with the voicemail stamp. Returns
// { hold, prev } or null (no hold open, one already went to voicemail, the call closed, or a press 1 holds the
// return claim: another request won).
async function claimHoldVoicemail(callSid, reason) {
  const prev = holdFrom(await conferencePath.loadState(callSid));
  if (!prev.open || prev.voicemail_at || (returnInFlight(prev) && !prev.voicemail_pending)) return null;
  const hold = {
    ...withoutReturn(prev),
    open: false,
    voicemail_at: new Date().toISOString(),
    voicemail_reason: reason,
    total_sec: (Number(prev.total_sec) || 0) + secondsSince(prev.open_at),
  };
  const won = await writeHold(callSid, hold, [HAS_STATE_SQL, NOT_CLOSED_SQL, HOLD_OPEN_SQL, HOLD_NO_VOICEMAIL_SQL, returnFreeCondition({ orStaffLeft: true })]);
  return won > 0 ? { hold, prev } : null;
}

// Puts the hold back as it was, only while our own stamp is still on it. A voicemail that is not the plain 5 minute
// limit (the staff phone hung up) leaves its reason on the restored hold as voicemail_pending: the caller's hold
// script fetch starts that voicemail at once, with this reason, instead of waiting for the limit.
const restoreHold = (callSid, claim, reason) => writeHold(callSid, reason === 'timeout' ? claim.prev : { ...claim.prev, voicemail_pending: reason }, [HAS_STATE_SQL, { sql: "(metadata #>> '{conference_path,hold,voicemail_at}') = ?", bindings: [claim.hold.voicemail_at] }])
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

// 'started' | 'not_needed' | 'caller_gone' | 'failed'. Never throws. 'failed' = the hold is still open (restored,
// with the reason pending when it is not the 5 minute limit) or its state could not be read. The hold limit passed, or the staff phone
// hung up during the hold: claim once, end the room (the caller's <Dial> action then runs /call-complete,
// which lets the caller leave a message), then raise the alert. A room that is already gone keeps the claim
// and rings nothing (the caller left). Any other Twilio error restores the hold: the next hold script fetch tries again.
async function startHoldVoicemail(callSid, reason) {
  let claim = null;
  try {
    claim = await claimHoldVoicemail(callSid, reason);
    if (!claim) return 'not_needed';
    if (!(await endOpenRooms(callSid))) return 'caller_gone';
  } catch (err) {
    logger.warn(`[call-hold] hold voicemail not started for ${masked(callSid)} (${errorCode(err)})`);
    if (claim) await restoreHold(callSid, claim, reason);
    return 'failed';
  }
  logger.info(`[call-hold] caller ${masked(callSid)} sent to voicemail (${reason})`);
  await raiseVoicemailAlert(callSid, reason);
  return 'started';
}

module.exports = {
  HOLD_REMINDER_SEC, HOLD_LIMIT_SEC, isEnabled, startHold, endHold, holdState, roomIsOpen, heldSeconds, startHoldVoicemail, resumeRecording,
};

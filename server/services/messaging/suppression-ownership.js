// Standing-verdict ownership (codex #3495 r14). When a messaging_suppression
// row is ACTIVE, its source encodes which ATTEMPT authored it:
//
//   'twilio_status_21610:<sid>'  — delivery-callback verdict; the attempt's
//                                  send time is that SID's sms_log row
//   'twilio_send_21610:<iso>'    — synchronous send-time rejection; the
//                                  attempt's own pre-handoff timestamp is
//                                  embedded directly (no SID ever exists)
//
// Both 21610 recorders must defer to a standing row authored by a NEWER
// attempt: a slower, OLDER attempt that ignored ownership would run its
// newest-command recheck over a scan window containing an intervening
// START and clear the newer carrier verdict, leaving an opted-out phone
// textable. This is the one shared reader both paths consult under the
// same per-phone advisory lock.
//
// Returns the owning attempt's Date, or null when the row is not active,
// carries no parseable provenance, or (callback rows) the SID's sms_log
// row is missing — callers treat null as "no newer owner proven" and fall
// through to their existing ordering rules.
async function standingVerdictTime(supRow, { dbh, excludeSid = null } = {}) {
  if (!supRow || supRow.active !== true) return null;
  const src = String(supRow.source || '');
  const sync = /^twilio_send_21610:(.+)$/.exec(src);
  if (sync) {
    const t = new Date(sync[1]);
    return Number.isNaN(t.getTime()) ? null : t;
  }
  const cb = /^twilio_status_21610:(.+)$/.exec(src);
  if (cb && cb[1] && cb[1] !== excludeSid && dbh) {
    const ownerLog = await dbh('sms_log').where({ twilio_sid: cb[1] }).first('created_at');
    return ownerLog?.created_at ? new Date(ownerLog.created_at) : null;
  }
  return null;
}

// True when an sms_log row's created_at was captured BEFORE the Twilio
// handoff (TwilioService.sendSMS stamps every row it writes with
// metadata.pre_handoff_stamp). Delayed-callback readers apply their
// send-race grace only to rows WITHOUT the stamp: the grace compensates
// legacy writers that log after messages.create() returns, and backdating
// an accurately-stamped row instead misorders a START received between
// the handoff and the carrier verdict (hook #3495 P1).
function hasPreHandoffStamp(row) {
  const meta = row?.metadata;
  if (!meta) return false;
  try {
    const obj = typeof meta === 'string' ? JSON.parse(meta) : meta;
    return obj?.pre_handoff_stamp === true;
  } catch {
    return false;
  }
}

module.exports = { standingVerdictTime, hasPreHandoffStamp };

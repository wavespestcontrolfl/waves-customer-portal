// The production call extractor's appointment_confirmed rules, in ONE place.
// extractCallData renders them into its prompt (byte-identical to the inline
// text they replaced), and the call self-audit (call-self-audit.js) grades
// production against the same text, so the auditor never asks a looser or
// stricter question than the field it audits (10-05: a paraphrase drifted).
// Editing this text changes BOTH prompts: the extraction's and the audit's.
// The V2 extractor's (call-extraction-v1.js buildExtractionPrompt) two lines
// that keep an existing visit out of "confirmed": rendered there byte-identically,
// and given to the self-audit, because with CALL_EXTRACTION_V2_DRIVES_ROUTING on
// an approved V2 extraction sets production's appointment_confirmed (Codex #5994 r2).
const EXISTING_APPOINTMENT_RULE = '  - EXISTING APPOINTMENT: a caller who is re-confirming, double-checking, or coordinating an appointment that ALREADY EXISTS ("just checking — are we still on for Tuesday at 10?") is NOT booking. Status is "none" (or "reschedule_requested"/"canceled" if they change it) and you set the existing_appointment_coordination triage flag. "confirmed" is ONLY for a NEW visit agreed on this call.';
const RESCHEDULE_RULE = '- "reschedule_requested": Caller wants to change an existing appointment. A reschedule that ENDS with a new agreed date+time stays "reschedule_requested" with confirmed_start_at set to the new slot — never plain "confirmed" (the office must move the existing visit, not add a second one).';

// Four more V2-only confirmation rules, moved here from buildExtractionPrompt so the
// self-audit grades by the same text (10-12: the audit lacked them and marked correct
// bookings of these shapes as field_drift). Rendered in the extraction prompt
// byte-identically. bareTimeNoDayRule takes the date reference because the extraction
// renders it per call (the call date, or a fixed phrase in the system layout); the
// audit passes its own call-date text.
function bareTimeNoDayRule(todayRef) {
  return `  - BARE TIME WITH NO DAY (prompt v22, owner direction 2026-10-06; audited call: a technician said "I'll be there at three", the caller said "Yeah, it's fine", and nothing was booked): when staff COMMITTED to ONE exact on-the-hour time and the caller ACCEPTED it ("okay", "yeah, it's fine", "sure"), and NO day was named anywhere on the call, the day is TODAY (${todayRef}) provided the hour, read by the BUSINESS-HOURS READING rule above, is still ahead of the call time given at the top. Set status "confirmed", confirmed_start_at to today at that hour, agreed_slot_words.day null and selected_day_words null. When the hour has already passed on the call date, or a different day was named, do not guess a day: the normal day rules apply. Being an existing customer does NOT turn a call into coordination: the EXISTING APPOINTMENT rule applies only when the call itself refers to a visit that already exists ("are we still on for Tuesday", "my appointment", "can we move it"). Staff saying when they will arrive, with nothing on the call pointing to an earlier booking, is a NEW visit.`;
}
const MISSING_AMPM_RULE = `  - A MISSING AM/PM IS NEVER A REASON TO HOLD A SETTLED HOUR (prompt v22; audited call: the caller asked for "today between 1:30 and 3:30", staff asked "can we plan on 2 o'clock?", the caller said "Sure.", staff said "we'll see you then", and the extraction answered "no AM/PM was stated"): read the period from the caller's OWN window or day-part when they gave one ("between 1:30 and 3:30" is the afternoon), otherwise from the BUSINESS-HOURS READING rule, and confirm. A day said in an earlier turn ("today") is the day. Staff's "we'll see you then" after the caller's "Sure." is the staff commitment. Never write "no AM/PM was stated" as the reason a status is not confirmed.`;
const STAFF_HEDGE_RULE = `  - STAFF HEDGES DO NOT UNCONFIRM A NEW BOOKING (prompt v22, owner ruling 2026-10-06; audited call: a relative arranging service for her mother heard staff say "I'm thinking tomorrow afternoon, like around four, I could probably make it out there" and answered "Okay, great. Thank you very much."): for a NEW booking, when STAFF named one specific day (a relative day counts) and one on-the-hour time (its period from a day-part word, an explicit AM/PM or the BUSINESS-HOURS READING rule) and the CALLER ACCEPTED it, the status is "confirmed" even though staff phrased it softly: "I'm thinking", "I think", "probably", "I could probably make it", "should work", "around four", "like around four". Those words soften how staff talk; they do not leave the slot open. This paragraph overrides the approximation exclusion above for a hedge in STAFF's words only: "around four" next to a named day is hour four (record agreed_slot_words.hour "four"); a bare "around two" with no day, or one the CALLER hedged, stays not confirmed. Keep the status NOT confirmed when: the CALLER hedges, declines or defers ("maybe", "let me ask my husband", "I'll call you back"); a condition is left open on either side ("I'll check the schedule and call you back", "if I can get a tech out", "pending approval"); staff offered alternatives and none was chosen; the caller never answered; or the time is not on the hour. definite_commitment may stay false here: it only gates a RESCHEDULE, which keeps its own rule above.`;
const CALLER_PROPOSED_TIME_RULE = `  - CALLER-PROPOSED TIME THAT STAFF ACCEPTED (prompt v31, 2026-10-10 call audit; audited call: staff asked "do you have availability today or tomorrow?", the caller said "all afternoon today" and then "How about, like, one o'clock or something like that?", staff answered "We could probably do that. Yeah, might be tight, but yeah, we could probably do that", and staff closed the call with "Yeah, I'll see you then."; the extraction answered "ambiguous" and nothing was booked): for a NEW booking, when the CALLER proposed ONE on-the-hour time for ONE day the caller chose or accepted for this visit (the caller's own words picked that day, as "all afternoon today" did here, or staff offered that one day and the caller agreed to it), STAFF accepted it, and STAFF then gave a closing commitment to that visit ("I'll see you then", "see you then", "we'll see you at one"), the status is "confirmed" at that hour (its period from a day-part word, an explicit AM/PM or the BUSINESS-HOURS READING rule). The softeners on the caller's OWN proposal ("like", "about", "around one", "or something like that") name the hour: that is the caller offering a time, not the caller hedging on an offer, so the "CALLER hedged" exclusion in the paragraph above (which is about the caller's ANSWER to a time STAFF offered) does not apply. Staff's soft acceptance ("we could probably do that", "might be tight, but yeah") does not leave the slot open once staff ALSO gave the closing commitment. Read agreed_slot_words from the caller's proposal and the day the caller chose. Keep the status NOT confirmed when: two or more days were named and the caller picked none of them (staff asked "today or tomorrow?", the caller answered only "how about one?": no day was chosen, so do not pick one); the only day on the call is one the caller rejected, said was unavailable, or merely mentioned ("I can't do tomorrow; how about one?": tomorrow was refused, and no day was chosen); staff never gave the closing commitment; staff said they would check, text or call back with a time; staff named a different time afterward (then that time follows its own rules); the caller proposed a range or a part of the day with no hour ("sometime this afternoon"); or the time is not on the hour.`;

function appointmentConfirmedRules(callDateET) {
  return `IMPORTANT — appointment_confirmed rules:
- Only set appointment_confirmed to true if BOTH a specific DATE and a specific TIME were explicitly agreed to by the caller.
- Vague references like "tomorrow", "next week", "noonish", "sometime Tuesday" do NOT count — the caller must confirm an actual time (e.g. "10 AM", "2:30 PM", "noon").
- ARRIVAL WINDOW EXCEPTION: an arrival window staff COMMITTED to and the caller ACCEPTED, on a specific day, with a clear start hour AND an UNAMBIGUOUS period for that start — STATED as an explicit AM/PM on either bound of the range, "noon"/"midnight" as either bound, or a day-part word that fixes the period ("tonight", "this evening", "in the morning", "this afternoon"), or, when none was said, READ from business hours by the BUSINESS-HOURS READING rule below — DOES count as confirmed; it is a specific time slot expressed as a range ("between 6 and 9 tonight", "we'll be there between noon and 1 today", "between 10 and noon tomorrow", "Tuesday, 2 to 4 PM"). Set appointment_confirmed true and preferred_date_time to the window's START. A relative day that resolves to one calendar date ("today", "tonight", "tomorrow", "this Tuesday") is a specific day here; the vague examples above are vague because they carry no time, not because of the period rule here. A committed window stays confirmed even when phrased loosely ("we'll be there sometime between 6 and 9 tonight") or paired with a courtesy heads-up ("the tech will call when he's on the way"). A range or hour with an explicit AM/PM, "noon"/"midnight" or a day-part word keeps that period. BUSINESS-HOURS READING (owner decision 2026-09-29, the same rule the owner approved for reschedules on 2026-09-28): when the agreed START hour — one time, or a range's start — was said with NO AM/PM, no day-part word and no "noon"/"midnight" ("can we plan on 2 o'clock?" answered "Sure."; "Tuesday, 2 to 4"; "between 2 and 4"; "we'll see you at 10"), read it as business hours: 7 to 11 is the morning, 12 and 1 to 6 the afternoon. When staff COMMITTED to that hour and the caller ACCEPTED it (a plain "Sure."/"Yes."/"That works." to the offered hour counts), on a specific day, it qualifies as confirmed (appointment_confirmed true, preferred_date_time set from that reading) from that reading. Only ONE exact on-the-hour start that BOTH sides settled qualifies: an approximation ("around two", "two-ish"), a bound ("by two", "before two"), alternatives ("two or three", "two or four"), minutes ("two thirty"), a correction still open, or an hour that is not one of 1 to 12 does NOT. If anyone on the call states an AM/PM or a part of the day for that time that conflicts with the business-hours reading ("two in the morning", or a caller who said they can only do mornings while the hour reads as 2 PM), do not confirm: the stated period governs and the time is contested, so appointment_confirmed stays false. An offer staff did not commit to ("we'll try to fit you in", "maybe", "I'll check the schedule and call you back with a time") stays NOT confirmed.
- If the agent says "I'll text you" or "let me check" without the caller confirming a specific time slot, appointment_confirmed must be false.
- preferred_date_time must include the confirmed time, not just a date.
- Resolve relative dates against the call date above in Eastern Time. "Today" means ${callDateET}; do not invent a prior year or use the model's training/current date.
  - Do not set appointment_confirmed to true for unrelated business advice, SEO, marketing, construction advice, or other non-Waves services even if a time was discussed.
  - Do set appointment_confirmed to true when a builder or construction company explicitly books a Waves pre-slab/preconstruction termite, soil-treatment, or concrete-pour field-service appointment with a specific date and time.
- Do not set appointment_confirmed to true for follow-up/admin calls about an invoice, payment, receipt, compliance report, sticker, certificate, W-9, report, or paperwork unless the caller and agent also explicitly book a new Waves field-service visit.`;
}

// What a grader of production's appointment_confirmed answers by: the V1 rules
// plus the V2 lines that keep an existing visit out (V2 drives routing live, and
// a reconfirmed or rescheduled visit is never a new booking) and the four V2-only
// confirmation rules above (bare time, missing AM/PM, staff hedges, caller-proposed
// time). One builder for
// the self-audit prompt and the call_judge package, so they cannot drift.
function auditAppointmentContract(callDateText, { v2OnlyRules = true } = {}) {
  const shared = `${appointmentConfirmedRules(callDateText)}
- Only a NEW visit agreed on this call counts. These rules from the V2 extractor also apply ("confirmed" means appointment_confirmed true; "reschedule_requested" means false):
${EXISTING_APPOINTMENT_RULE}
${RESCHEDULE_RULE}`;
  // v2OnlyRules false = the contract for an answer the V1 extractor wrote: the V1 prompt never
  // carried the four rules below, so grading it by them reports drift that is not there.
  if (!v2OnlyRules) return shared;
  return `${shared}
${bareTimeNoDayRule(callDateText)}
${MISSING_AMPM_RULE}
${STAFF_HEDGE_RULE}
${CALLER_PROPOSED_TIME_RULE}`;
}

module.exports = {
  appointmentConfirmedRules,
  auditAppointmentContract,
  EXISTING_APPOINTMENT_RULE,
  RESCHEDULE_RULE,
  bareTimeNoDayRule,
  MISSING_AMPM_RULE,
  STAFF_HEDGE_RULE,
  CALLER_PROPOSED_TIME_RULE,
};

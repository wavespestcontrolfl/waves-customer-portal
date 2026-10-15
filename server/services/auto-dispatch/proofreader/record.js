/**
 * MOVE PROOFREADER — the customer record.
 *
 * Owner 2026-10-05: the dispatch check must read all customer messages for
 * time promises. Owner 2026-10-09 ("proofreader yes"): a model reads the full
 * record before an automatic move. This file builds that record with code, so
 * the model never searches for anything: every stored text, email, call
 * transcript and note for one customer, written before `asOf`, oldest first.
 *
 * Read-only. Each source is read by itself: a source that cannot be read is
 * listed in `unread` (the verdict is then never "allow"), it does not fail
 * the record. A call with a recording and no transcript is unread too.
 *
 * Nothing is cut. A text longer than MAX_ENTRY_CHARS becomes several entries
 * (`split` counts them), each starting a little before the last one ended, so
 * a statement near the end of a long call is still read. Every `at` is an
 * Eastern time with its offset, as the prompt tells the model.
 *
 * `asOf` exists for the replay: a past move is judged on the words that
 * existed before it. The nightly run passes the run's own time.
 *
 * Undated notes (the customer's file notes, the visit's notes) have no
 * written-at time in the database, so they are read as they are NOW, in the
 * replay too. They come first and are marked undated.
 *
 * Access codes and card / SSN numbers never reach a provider
 * (redactAccessCodes). When that mask also hides a word that can say when
 * (a time or a day in the same sentence as a code), the entry is listed in
 * `unread` as `time_masked`: the verdict is then never "allow".
 */
const logger = require('../../logger');
// A database error's message can carry the query's bindings (a customer's
// email address, a phone number): logs get the error's code or name only
// (notification-service.js safeErrorSummary; Codex #6313 r22).
const safeError = (err) => require('../../notification-service').safeErrorSummary(err);
const contextAggregator = require('../../context-aggregator');

const { redactAccessCodes } = contextAggregator;
const { excludeUnresolvedSendReservations } = require('../../messaging/review-ask-reservation');
const { resolveEmailCustomerLink, personSentFilter, extractEmailAddresses } = require('../../email/email-customer-link');
const { emailPlainText, stripQuotedAndSignature, ownReplySubject } = require('../../email/email-strip');
const { operatorReply, smsContactSelects } = require('../../staff-contact');
const { etOffsetIso } = require('../../../utils/datetime-et');
const { whereNotSandboxCall } = require('../../voice-agent/relay-protocol');
const { RETAINED_HISTORY_STATUSES } = require('../../visit-context/statuses');

// One entry's longest text. A longer one is split into parts, never cut
// (Codex #6258 r1: a restriction near the end of a long call was dropped).
const MAX_ENTRY_CHARS = 12000;
// Each part repeats this much of the part before it, so a statement that
// falls on a boundary is whole in one of the two.
const PART_OVERLAP_CHARS = 600;
// The whole record's limit. Past it no model is asked and the verdict is
// "unknown" (measured 2026-10-09 over 112 customers: median 6k, max 56k).
const MAX_RECORD_CHARS = 300000;

// Interaction rows that only repeat a text or an email already read from its
// source table, and the 'call' row the recording processor writes: its body
// is a model's summary of a call whose own words come from the call log table, and
// a paraphrase must never stand as a quote (Codex #6258 r4).
// 'inbound_call' is the raw transcript copied again when staff tag a call
// (admin-call-recordings.js), dated at the tagging (r8).
const INTERACTION_COPIES = ['sms_outbound', 'email_outbound', 'call', 'inbound_call'];
// A call the voice webhook linked by caller ID and the extractor then found
// was not this customer (context-aggregator.js isExcludedCall is the rule).
const NOT_THIS_CUSTOMER_OUTCOMES = ['wrong_number', 'spam'];
const SUBJECT_SETTLE_MS = 15 * 60 * 1000;
// reschedule_log rows written by code: their notes are program text.
const PROGRAM_RESCHEDULERS = ['system', 'auto_dispatch'];

const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
// Eastern wall time with its offset: the prompt says every time is Eastern,
// so "this Friday" in an evening text is read against the right day.
const eastern = (value) => (value ? etOffsetIso(value) : null);
const msOf = (value) => (value ? new Date(value).getTime() : null);

// A row whose text can be edited in place carries the time of its last edit.
// Edited at or after `asOf`, its text is not the text that existed then: the
// replay lists it as unread instead of reading it (Codex #6258 r2, r3). The
// nightly run passes its own time, so nothing is ever "later" there.
function revisedLater(row, asOf, channel, unread) {
  if (!row.updated_at || msOf(row.updated_at) < msOf(asOf)) return false;
  unread.push({ channel, at: eastern(row.created_at), reason: 'revised_later' });
  return true;
}

function partsOf(body) {
  if (body.length <= MAX_ENTRY_CHARS) return [body];
  const parts = [];
  for (let from = 0; from < body.length; from += MAX_ENTRY_CHARS - PART_OVERLAP_CHARS) {
    parts.push(body.slice(from, from + MAX_ENTRY_CHARS));
    if (from + MAX_ENTRY_CHARS >= body.length) break;
  }
  return parts;
}

// Words that can say WHEN: a clock time, an hour after a time word ("before
// 9", "between 9 and 11", "no earlier than 9", "past 3"), "9 o'clock", "9
// or later", an hour range ("7-7"), a part of the day, a weekday.
// The access-code mask works on a whole sentence that names a code, and it
// masks every token with a digit in it and every word in capitals: in "gate
// code 4821, not before 10am" the 10am goes too, in "CODE 4821 FRIDAYS ONLY"
// the day, in "the code works 7-7" the hours. The model then cannot see a
// time statement that is on file. The code never reaches a provider, so the
// text is not unmasked; the record says it could not read that entry in full
// (`time_masked`), and a verdict on it is never "allow".
// A bare number is NOT counted: the mask also takes the day numbers of the
// date stamps staff notes carry ("[call Fri Aug 14]", "2026-09-25"), and on
// production notes that was six of seven flags (measured 2026-10-13). A
// range inside a longer run of digits and dashes or slashes is a date.
// Words that introduce an hour, and the hours a person spells out (an
// all-caps note "DO NOT COME BEFORE NINE" loses both to the mask: r4).
const HOUR_LEADS = 'before|after|by|until|till|til|at|from|around|about|between|than|past';
// Words that tie a date to the visit or the access; never taken for the
// credential either ("access code expires 10/20": r8).
// Not "good": "good 10/10 service" is a rating; "good until" is read by
// "until" (r11).
// Not "on": "spoke with the owner on 10/10" is history (r12).
// ends / ending / stops / until: the end of the access ("ACCESS ENDS OCTOBER
// 20"): r32.
const DATE_LEADS = 'expires?|expiring|expired|through|thru|starting|starts?|valid|ends?|ending|ended|stops?|stopping|changes?|changing';
// The hour words that also tie a DATE: not "about / around / than / past /
// at", which come before quantities ("about 5/8 acre": r9).
const DATE_HOUR_LEADS = 'before|after|by|until|till|til|from|between';
const SPELLED_HOURS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
// The words that may follow an hour in a time ("before 9 please", "after
// NINE at night"); any other word makes it a count ("about THREE acres",
// "ONE of the owners"): r5, r7, r15.
const AFTER_HOUR_OK = 'am|pm|a\\.m|p\\.m|o\\W?clock|or|and|to|until|till|only|please|on|at|in|sharp|latest|earliest|ish|then|so|is|works?|thirty|fifteen|forty|twenty';
const SPELLED_HOUR = `(?:${SPELLED_HOURS})\\b(?!\\s{1,5}(?!(?:${AFTER_HOUR_OK})\\b)[A-Za-z])`;
// A quantity in a duration, in digits or words ("TWO DAYS NOTICE", "a week
// ahead", "every couple of weeks"): r15.
// A 24-hour clock time in four digits ("before 1400 hours"): only after an
// hour word or before "hours / hrs", never alone (a four-digit number alone
// is most often a code or a house number): r16.
const HHMM = '(?:[01]\\d|2[0-3])[0-5]\\d(?![\\w:/-])';
// The shapes of a calendar date: ISO, slash, month name (with an optional
// ordinal), an ordinal day alone (with an optional "the"), or a month alone
// ("VALID THROUGH OCTOBER"; "TILL END OF OCTOBER": r36; a year alone,
// "VALID THROUGH 2026": r37; not before a day or a mask, which the
// month-and-day shape reads), or day first ("EXPIRES 20 OCTOBER"): r7 to
// r19, r28, r31.
// Whole month names and their short forms only: "JANITOR" is not January (r33).
const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE_SHAPES = `(?:(?:the\\s{1,5})?(?:year|month|week)[\\s-]{0,3}end(?![\\w/])|\\d{1,2}-\\d{1,2}-(?:\\d{4}|\\d{2})(?![\\w/-])|(?:19|20)\\d{2}(?![\\w/:-])|(?:the\\s{1,5})?end\\s{1,5}of\\s{1,5}(?:(?:the|this|next)\\s{1,5})?(?:${MONTHS}|month|year|week)(?![\\w/])|\\d{4}-\\d{1,2}-\\d{1,2}(?![\\w/-])|(?:${MONTHS})\\.?,?\\s{1,5}\\d{4}(?![\\w/])|\\d{1,2}(?:st|nd|rd|th)?\\s{1,5}(?:of\\s{1,5})?(?:${MONTHS})\\.?(?![\\w/])|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?(?![\\w/])|(?:${MONTHS})\\.?\\s{1,5}\\d{1,2}(?:st|nd|rd|th)?(?![\\w/])|(?:the\\s{1,5})?\\d{1,2}(?:st|nd|rd|th)(?![\\w/])|(?:${MONTHS})\\.?(?![\\w/])(?!\\s{1,5}(?:\\d|\\[)))`;
// An hour with "ish" ("around 10ish", "10-ish"): r21.
const HOUR_ISH = '(?:[01]?\\d|2[0-3])-?ish\\b';
// A word between the quantity and the unit ("2 business days"): r21.
const DURATION_MOD = '(?:(?:business|calendar|full|working|school|week)[\\s-]{1,3})?';
// "TWO AND A HALF HOURS": r22.
// Spelled tens too ("THIRTY MINUTES NOTICE"): r30.
const QTY = `(?:\\d{1,3}|a|an|half|an?\\s{1,3}half|${SPELLED_HOURS}|fifteen|twenty|thirty|forty[\\s-]?five|forty|fifty|sixty|ninety|few|couple(?:\\s{1,5}of)?)(?:\\s{1,5}and\\s{1,5}a\\s{1,5}half)?`;
// An hour is 0-23, and a number followed by a unit is a quantity ("about 50
// lbs", "after 5 minutes"), not a time (r5).
// A word after the number must be one that goes with a time ("before 9
// please", "after 9 at night"); any other word makes it a count ("about 5
// dogs", "50 lbs"): r5, r7.
const HOUR = `(?:[01]?\\d|2[0-3])(?![\\w:/%-])(?!\\s{1,5}(?!(?:${AFTER_HOUR_OK})\\b)[A-Za-z])`;
// Times a person names instead of an hour ("AFTER LUNCH ONLY", "before
// sunset", "after work"): r5.
// Not work / school: "AT WORK" is a place; "after work" is read below (r39).
const NAMED_TIMES = 'lunch(?:time)?|breakfast|dinner|supper|sunrise|sunset|dawn|dusk|daylight|dark';
// The words a lead word may point at that count by their own pattern too
// ("BEFORE noon", "after DARK", "by Friday"): r12, r21.
const TIME_ANCHORS = `(?:${NAMED_TIMES}|noon|midnight|mornings?|afternoons?|evenings?|night|weekdays?|weekends?|(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:days?)?)\\b`;
const TIME_WORDS_RE = new RegExp([
  // The hour alone is the match, the AM / PM a look-ahead: the mask can take
  // the hour and leave "A.M.", which counts by its own pattern (r21).
  // Not a mix ratio ("mix ratio 1:10"): r27.
  '(?<!\\b(?:ratio|mix|mixed|dilution|dilute|diluted|rate|scale)\\s{1,5})\\b\\d{1,2}:\\d{2}(?=\\s?[ap]\\.?m\\.?(?![\\w])|-?ish\\b|(?![\\w:]))',
  '\\b\\d{1,2}(?=\\s?[ap]\\.?m\\.?(?![\\w]))',
  // The lead word alone is the match, the anchor a look-ahead: in "BEFORE
  // lunch" the mask takes BEFORE and leaves lunch, and a match that took
  // both would count one on each side (r12). The anchor's own word counts
  // by its own pattern.
  `\\b(?:${HOUR_LEADS})(?=\\s+(?:${HOUR}|${HHMM}|${HOUR_ISH}|${SPELLED_HOUR}|${TIME_ANCHORS}))`,
  `\\b${HOUR_ISH}`,
  `\\b(?:${HHMM}|[1-9][0-5]\\d(?![\\w:/-]))(?=\\s{0,3}(?:hours|hrs|h)\\b)`,
  // Minutes to / past an hour, spelled ("TEN TO TWO"): r23. Digits are read
  // by the range pattern.
  `\\b(?:five|ten|fifteen|twenty(?:[\\s-]{1,3}five)?)(?=\\s{1,5}(?:to|past|after|til|till)\\s{1,5}(?:${HOUR}|${SPELLED_HOUR}))`,
  // Quarter or half to / past an hour ("QUARTER TO TEN"): r15.
  `\\b(?:quarter|half)(?=\\s{1,5}(?:to|past|after|til|till|before)\\s{1,5}(?:${HOUR}|${SPELLED_HOUR}))`,
  // A meal or a sun time counts only with a word that makes it a time
  // ("AFTER LUNCH", "lunch only", "by sunset"): "DOG EATS BREAKFAST INSIDE"
  // is about the dog (r38).
  '(?<=\\b(?:before|after|until|till|til|by|at|around|about|from|past|during|over|through|thru|only|not|no|never|except)\\s{1,5})(?:lunch(?:time)?|breakfast|dinner|supper|sunrise|sunset|dawn|dusk)(?![\\w])',
  '\\b(?:lunch(?:time)?|breakfast|dinner|supper|sunrise|sunset|dawn|dusk)(?=\\s{0,3}(?:(?:only|ok|okay|is|works?|time|hour|or\\s{1,3}later|please)\\b|[,;!)]|\\.(?:\\s|$)|$))',
  // A calendar date after a word that ties it to the visit or the access
  // ("CODE 4821 EXPIRES 10/20", "until Oct 20"): r7. A date alone is a
  // note's own stamp and does not count.
  // A day of the month after a word that limits the visit to it ("ONLY ON
  // THE 20TH", "except the 5th"): r17. "on the 20th" alone is history.
  `\\b(?:only|except|never|not)(?=\\s{1,5}(?:on\\s{1,5})?${DATE_SHAPES})`,
  // ...and the date first ("on 10/20 only", "10/31 works"): r20, r29.
  // Not the verb in "TECH MAY ONLY USE" (r51).
  `(?<![\\w/-])(?!may\\b(?!\\s{1,5}\\d))${DATE_SHAPES}(?=[\\s,]{1,5}(?:only|works?|please|preferred|is\\s{1,3}(?:best|better|fine|good|ok|okay))\\b)`,
  // A connector may stand between ("expires on 10/20"): r14.
  `\\b(?:${DATE_HOUR_LEADS}|${DATE_LEADS})(?=\\s{1,5}(?:(?:on|by|at|the)\\s{1,5})?${DATE_SHAPES})`,
  // An hour a phrase after it makes a time ("10 in the morning", "9 sharp",
  // "8 onwards"): r9.
  // A look-ahead: the phrase is not consumed, so its own time word still
  // counts on both sides and the hour alone tells the loss.
  '\\b(?:[01]?\\d|2[0-3])(?=\\s{1,5}(?:in\\s{1,5}the\\s{1,5}(?:morning|afternoon|evening)|at\\s{1,5}night|sharp|onwards?|or\\s{1,5}so)(?![\\w]))',
  // The same with the hour spelled out, and a spelled hour with spelled
  // minutes ("TEN THIRTY in the morning"): r13.
  `\\b(?:${SPELLED_HOURS})(?=\\s{1,5}(?:in\\s{1,5}the\\s{1,5}(?:morning|afternoon|evening)|at\\s{1,5}night|sharp|onwards?|or\\s{1,5}so)(?![\\w]))`,
  `\\b(?:${SPELLED_HOURS})(?=\\s{1,5}(?:fifteen|thirty|forty[\\s-]?five|forty|twenty|o\\W?clock)(?![\\w]))`,
  // A notice period or a change interval ("need 7 days notice", "expires
  // in 2 weeks", "changes every 30 days"): r10. A length or a count is not one.
  // A hyphen may join the quantity and the unit ("48-hour notice"): r20.
  `\\b${QTY}[\\s-]{0,3}${DURATION_MOD}(?:days?|weeks?|hours?|hrs?|months?|minutes?|mins?)(?:.?s)?(?:\\s{1,5}and\\s{1,5}a\\s{1,5}half)?\\W{0,2}\\s{0,3}(?:(?:minimum|min|at\\s{1,3}least|full)\\W{0,2}\\s{1,3})?(?:notice|warning|lead[\\s-]{0,3}time|heads?[\\s-]{0,3}up|ahead|in\\s{1,5}advance|advance|prior|before|beforehand)(?![\\w])`,
  `\\b(?:expires?|expiring|changes?|changing|resets?|every|valid|good)(?=\\s{1,5}(?:(?:in|after|for)\\s{1,5})?${QTY}[\\s-]{0,3}${DURATION_MOD}(?:days?|weeks?|months?|years?|hours?|hrs?|minutes?|mins?)(?![\\w]))`,
  // AM or PM on its own ("PM ONLY"): r8.
  // Not the verb in "I AM" (r11).
  // Not the property manager: "contact the PM", "PM for access" (r12).
  '(?<!\\bi\\s{1,5})\\bam(?![\\w])|\\b(?:a\\.m\\.|p\\.m\\.)(?![\\w])',
  // PM alone only before a word that makes it a time ("PM ONLY", "PM is
  // best"); otherwise it is the property manager ("PM approved access",
  // "SPOKE TO PM": r24, r39).
  '(?<!\\b(?:the|a|our|my|your|their|contact|call|text|email|ask|tell|notify|with)\\s{1,5})\\bpm(?=\\s{0,3}(?:(?:only|ok|okay|please|preferred|works?|visits?|appointments?|service|is\\s{1,3}(?:best|better|fine|ok|okay))\\b))',
  // Relative days ("TOMORROW ONLY", "NOT TODAY", "next week"): r6.
  // Not daily / weekly: in "DOG GETS DAILY MEDICATION" it is about the dog
  // (r17); "every week" is read below.
  // Only with a word that makes it a limit ("TOMORROW ONLY", "NOT ON
  // HOLIDAYS"): "owner called YESTERDAY" is history (r18).
  '\\b(?:today|tonight|tomorrow|holidays?)(?=\\s{1,5}(?:only|not|ok|okay|works?|is|are)\\b)',
  '\\b(?:only|not|never|except|after|before|until|by|from|on|no)(?=\\s{1,5}(?:today|tonight|tomorrow|holidays?)(?![\\w]))',
  // An hour with earliest / latest ("NINE EARLIEST", "5 at the latest"): r24.
  `\\b(?:[01]?\\d|2[0-3]|${SPELLED_HOURS})(?=\\s{1,5}(?:at\\s{1,5}the\\s{1,5})?(?:earliest|latest)\\b)`,
  // early / late of a visit ("NO EARLY APPOINTMENTS", "PLEASE COME LATE",
  // "late in the day"): r49.
  '\\b(?:early|earlier|late|later)(?=\\s{1,3}(?:appointments?|appts?|visits?|arrivals?|service|stops?|slots?|in\\s{1,3}the\\s{1,3}day|morning|afternoon|evening)\\b)',
  '(?<=\\b(?:come|arrive|arrival|visit|service|be|show\\s{1,3}up|get\\s{1,3}here)\\s{1,3})(?:early|earlier|late|later)(?![\\w])',
  // A week or a weekday of the month ("FIRST WEEK OF THE MONTH ONLY",
  // "SECOND TUESDAY OF THE MONTH"): r49, r50.
  '\\b(?:first|second|third|fourth|last|\\d(?:st|nd|rd|th))(?=\\s{1,3}(?:week|weekend|half|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)s?\\s{1,3}of\\s{1,3}(?:the\\s{1,3}|each\\s{1,3}|every\\s{1,3})?month\\b)',
  // "AS EARLY AS 9", "as late as 5": r35.
  `\\b(?:early|late)(?=\\s{1,5}as\\s{1,5}(?:${HOUR}|${HHMM}|${SPELLED_HOUR}))`,
  // An hour after a word that names the visit's time ("appointment time 9"): r24.
  `\\b(?:time|arrival|arrive|appointment|appt|scheduled?|window|slot)(?=\\s{1,5}(?:(?:is|of|at|for)\\s{1,5}|:\\s{0,3})?(?:${HOUR}|${HHMM}|${SPELLED_HOUR}))`,
  // Windows named in words ("END OF DAY ONLY", "NIGHT ONLY"): r24.
  '\\b(?:end\\s{1,3}of\\s{1,3}(?:the\\s{1,3})?day|eod|mid-?day)(?![\\w])',
  // "first thing" as a time only with in the morning / AM / only / please or
  // after come / be here ("FIRST THING ON LEFT" is a place): r53.
  '\\bfirst\\s{1,3}thing(?=\\s{1,3}(?:in\\s{1,3}the\\s{1,3}morning|tomorrow|am|a\\.m|only|please|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b|\\s{0,3}(?:[,;!]|\\.(?:\\s|$)|$))',
  '(?<=\\b(?:come|be\\s{1,3}here|arrive|show\\s{1,3}up|get\\s{1,3}here)\\s{1,3})first\\s{1,3}thing\\b',
  // Night only as a limit ("NIGHT ONLY"); "NIGHT LIGHT" is a thing (r25).
  '\\b(?:nights?|overnight)(?=\\s{0,3}(?:(?:only|ok|okay|please|preferred|works?|visits?|appointments?|service)\\b|[,;!)]|\\.(?:\\s|$)|$))',
  // "FIRST APPOINTMENT ONLY", "last stop", "1st appointment": r25, r30.
  // ...only as a wish or a limit ("FIRST APPOINTMENT ONLY", "want the 1st
  // appointment"): "FIRST APPOINTMENT COMPLETED" is history (r41).
  '\\b(?:first|second|third|last|\\d{1,2}(?:st|nd|rd|th))(?=\\s{1,5}(?:appointments?|appts?|stops?|slots?)\\s{0,3}(?:(?:only|please|preferred|ok|okay|works?|of\\s{1,3}the\\s{1,3}day|if\\s{1,3}possible)\\b|[,;!)]|\\.(?:\\s|$)|$))',
  '(?<=\\b(?:only|need|needs|want|wants|prefer|prefers|book|schedule|must|always|be|as|request|requests|requested)\\s{1,5}(?:the\\s{1,5})?)(?:first|second|third|last|\\d{1,2}(?:st|nd|rd|th))(?=\\s{1,5}(?:appointments?|appts?|stops?|slots?)\\b)',
  // A bare hour before a word that makes it a time ("9 works for us", "TEN
  // ONLY"): r27.
  `(?<![\\d:/.-])\\b(?:${HHMM}|[01]?\\d|2[0-3]|${SPELLED_HOURS})(?=\\s{1,5}(?:works?|only|please|preferred|is\\s{1,3}(?:best|better|fine|good|ok|okay))\\b)`,
  // "after work", "before school" (not "at work": a place): r39.
  '\\b(?:before|after|until|till|til|by)(?=\\s{1,5}(?:work|school)\\b)',
  // Spanish, the other language the proofreader reads (its hard cases have
  // Spanish standing statements): weekdays, months, parts of the day and
  // the usual time words ("SOLO LOS MARTES", "NUNCA ANTES DE LAS DIEZ"): r42.
  // Not "hoy" alone: "HOY HABLE CON EL DUENO" is history (r51).
  '\\b(?:lunes|martes|mi[e\u00e9]rcoles|jueves|viernes|s[a\u00e1]bados?|domingos?|ma[n\u00f1]ana|ma[n\u00f1]anas|tardes?|noches?|mediod[i\u00ed]a|madrugada|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|antes|despu[e\u00e9]s|hasta|horas?|semanas?|d[i\u00ed]as?|aviso)(?![\\w\u00c0-\u024f])',
  // A stretch of time after a visit word ("DO NOT COME FOR TWO WEEKS",
  // "COME BACK IN TWO WEEKS", "wait 3 days"): r45.
  `\\b(?:come|coming|back|return|visit|service|wait|hold|pause|skip|away|gone|out(?:\\s{1,3}of\\s{1,3}(?:town|state|the\\s{1,3}country|country))?|traveling|travelling|vacation)(?=\\s{1,5}(?:(?:for|in|after|within|another|the\\s{1,5}next)\\s{1,5})?${QTY}[\\s-]{0,3}${DURATION_MOD}(?:days?|weeks?|months?|years?|hours?|hrs?|minutes?|mins?)(?![\\w]))`,
  // A hold with no end date ("NO SERVICE UNTIL FURTHER NOTICE", "ON HOLD"): r48.
  '\\b(?:until|till|til)(?=\\s{1,5}(?:further|notified|told|advised|we\\s{1,3}call|they\\s{1,3}call|i\\s{1,3}call)\\b)',
  // paused / suspended only of the service or the visits ("SERVICE
  // SUSPENDED"; not "SUSPENDED CEILING"): r49.
  '\\b(?:on\\s{1,3}hold|indefinitely)(?![\\w])',
  '(?<=\\b(?:service|services|visits?|appointments?|account|treatments?|spraying|program|plan)\\s{1,3}(?:is\\s{1,3}|are\\s{1,3})?)(?:paused|suspended)(?![\\w])',
  '\\b(?:pause|suspend|paused|suspended)(?=\\s{1,3}(?:the\\s{1,3})?(?:service|services|visits?|appointments?|account|treatments?|program|plan)\\b)',
  // "AFTER HOURS": r22.
  '\\bafter[\\s-]{1,3}hours\\b',
  // A named window of the day ("BUSINESS HOURS ONLY"): r18.
  '\\b(?:business|office|working|opening|open|normal|regular|school)(?=\\s{1,5}hours\\b)',
  '\\b(?:next|this|every|each)\\s+(?:week|month|time|visit)(?![\\w])',
  // "EVERY OTHER WEEK", "every second month": r20.
  '\\b(?:every|each)(?=\\s{1,5}(?:other|second|2nd|third|3rd|fourth|4th)\\s{1,5}(?:week|month|day|visit)s?(?![\\w]))',
  `\\b(?:${SPELLED_HOURS})\\s?o\\W?clock\\b`,
  '\\b\\d{1,2}\\s?o\\W?clock\\b',
  '\\b\\d{1,2}\\s+(?:or|and)\\s+(?:later|earlier|after|before)\\b',
  '(?<![\\d/-])\\b\\d{1,2}\\s?(?:-|to)\\s?\\d{1,2}(?![\\w/-])',
  // Not a color or a plant or bird ("MIDNIGHT BLUE", "MORNING GLORY"): r47, r52.
  '\\b(?:noon|midnight|mornings?|afternoons?|evenings?|weekdays?|weekends?)(?![\\w])(?!\\s{1,3}(?:blue|black|green|purple|navy|gr[ae]y|colou?r|paint|glory|glories|dove|doves|star|primrose)\\b)',
  // Not in a note's own bracketed stamp ("[CALL FRI AUG 14]"): r33.
  // A short form ("SUN", "SAT", "WED") is also a word ("FULL SUN"): only in
  // a list or a range, or before only / ok ("Mon-Fri", "Sat only"): r34.
  // A plural weekday is a habit ("MONDAYS ONLY"); one weekday counts only
  // with a word that ties it to the visit ("on Monday", "Monday works",
  // "Friday is when", "SCHEDULE FOR TUESDAY", "can't do Friday"): "OWNER
  // CALLED MONDAY" is history (r35, r37).
  '(?<!\\[[a-z]{0,12}\\s{0,3})\\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s(?![\\w])',
  '(?<!\\[[a-z]{0,12}\\s{0,3})(?<=\\b(?:on|every|only|no|not|never|except|before|after|by|until|till|next|this|from|any|or|and|thru|through|to|for|coming|upcoming|expires?|expiring|changes?|starts?|starting|ends?|ending|valid|thru|avoid|avoids|skip|do|come|visit|service|arrive|show|go|stop|available|unavailable|free|busy|away|open|closed|cant|can\'t|cannot|won\'t|wont|prefer|prefers|book|schedule|scheduled)[\\s:,-]{1,5})(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?![\\w])',
  '(?<!\\[[a-z]{0,12}\\s{0,3})\\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?=\\s{0,3}(?:[,/&-]|(?:appointments?|appts?|visits?|service|services|stops?|slots?|available|unavailable|free|busy|closed|off|will\\s{1,3}not|would\\s{1,3}not|wouldn.?t|doesn.?t|does\\s{1,3}not|don.?t|won.?t|isn.?t|can.?t|cannot|not|never|no\\s{1,3}good|only|ok|okay|is|are|was|works?|please|preferred|and|or|thru|through|to|morning|afternoon|evening|night|mornings|afternoons|evenings)\\b))',
  '(?<!\\[[a-z]{0,12}\\s{0,3})\\b(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)\\.?(?=\\s{0,3}(?:[,/&-]|\\d|(?:only|ok|okay|and|or|thru|through|to)\\b|$))',
].join('|'), 'gi');
// Counted in constant memory: a long stored text builds no array of matches
// (Codex security r8).
function timeWords(text) {
  const re = new RegExp(TIME_WORDS_RE.source, 'gi');
  let n = 0;
  while (re.exec(text)) n += 1;
  return n;
}

// The value that directly follows a code noun is the credential itself, not
// a statement about when: "gate code Friday", "password is noon". It is left
// out of the count on the raw side, so a code that happens to be a day or a
// time word does not make the record incomplete (Codex #6328 r2).
// A value followed by "only" is a restriction, not the credential ("gate
// code WEEKDAYS ONLY": r11); a value of digits stays the credential
// ("GATE CODE 1234 ONLY": r48).
// A word that introduces an hour is never taken for the credential: in "no
// gate code after 9" the "after 9" is the statement (r4). Only the ONE token
// after the noun is taken: a passphrase of several words that are day or time
// words ("Friday morning") still counts, on purpose. Which it is cannot be
// told from the text, and the safe side is a person reading it.
const CODE_PLACES = '(?:gate|front|back|side|main|door|garage|lockbox|lock|box|entry|access|keypad|community|pool|building|alarm|house|home|lanai|shed|fence|unit)';
const CREDENTIAL_VALUE_RE = new RegExp(`\\b(code|password|passcode|passphrase|pin|combo|combination)\\b(\\s{0,5}(?:is|=|:|-)?\\s{0,5})(?!(?:${HOUR_LEADS}|${DATE_LEADS})\\b)["'\\u201c\\u2018]?[A-Za-z0-9#*]{1,40}(?![A-Za-z0-9#*])(?:(?<=[0-9#*])|(?![\\s,:;()\\u2013\\u2014-]{1,5}only\\b))["'\\u201d\\u2019]?`, 'gi');
// The same in the reverse order the mask also reads: "Friday is the gate
// code", "Noon is the gate password", "Friday is the front door access
// code" (r3, r7). Between "is" and the code noun only words that name
// what the code opens: "TUESDAY is available with gate code" is a day, not
// the credential (r25).
// Only "is" and "=", as the mask itself reads: "Friday WAS
// the gate code" stays visible to the model, so it is not left out (r14).
// Bounded tokens and gaps in both credential patterns: an unbounded run was
// retried at every byte of a long stored text (a 64 KB entry took 5.9 s on
// the event loop: Codex security r5; the forward one's spaces: r7).
const CREDENTIAL_VALUE_REVERSE_RE = new RegExp(String.raw`(?<![A-Za-z0-9#*])["'\u201c\u2018]?[A-Za-z0-9#*]{1,40}["'\u201d\u2019]?(\s{1,5}(?:is|=)\s{1,5}(?:(?:the|my|our|your)\s{1,5})?(?:${CODE_PLACES}\s{1,5}){0,3}(?:code|password|passcode|passphrase|pin|combo|combination)\b)`, 'gi');
const withoutCredentialValues = (text) => String(text).replace(CREDENTIAL_VALUE_RE, '$1$2').replace(CREDENTIAL_VALUE_REVERSE_RE, '$1');

// The mask removed at least one word that can say when. The list is the
// common ways to say when, not every way: a rule that counted every word
// the mask removes flagged 37 of 244 production records (technicians'
// product names in capitals), against 4 with this list (measured
// 2026-10-13); a statement the list misses is the known limit.
// `lineMasked`: the same text masked with its line breaks kept, when it has
// any. The neighbor rule must hold there too, so a break ends a clause
// ("ask MANAGER\nFriday works": r34). The model never reads that form.
function maskHidTime(raw, masked, lineMasked = null) {
  if (raw === masked) return false;
  // A text past the whole record's limit is not scanned (security r8). Its
  // masked form decides: still past the limit, the record is too long and no
  // model is asked; shorter (the mask took a long credential run), it is
  // counted as not fully read, unscanned (r9).
  if (raw.length > MAX_RECORD_CHARS) return masked.length <= MAX_RECORD_CHARS;
  return timeWords(masked) < timeWords(withoutCredentialValues(raw)) || maskBesideTimeWord(masked, lineMasked);
}

// The broad rule beside the count (Codex #6328 r22, after 21 rounds that each
// named a new phrase): a masked word right next to a visible word that only
// says when ("every [redacted] Tuesday", "[redacted] A.M.", "[redacted]
// Fridays", "expires [redacted] October") hid part of a statement about when.
// The credential's own mask (right after a code noun, or before "is the
// ... code") is left out: it sits next to a time word whenever the note
// states one ("gate code [redacted] after 9").
const NEIGHBOR_TIME_WORDS = new Set([
  // No short forms that are also words (mon, wed, sat, sun): r34.
  'monday', 'mondays', 'tue', 'tues', 'tuesday', 'tuesdays', 'wednesday', 'wednesdays', 'thu', 'thur', 'thurs', 'thursday', 'thursdays',
  'fri', 'friday', 'fridays', 'saturday', 'saturdays', 'sunday', 'sundays', 'weekday', 'weekdays', 'weekend', 'weekends',
  'am', 'pm', 'a.m', 'p.m', 'noon', 'midnight', 'morning', 'mornings', 'afternoon', 'afternoons', 'evening', 'evenings', 'night', 'nights', 'tonight',
  'today', 'tomorrow', 'lunch', 'lunchtime', 'breakfast', 'dinner', 'supper', 'sunrise', 'sunset', 'dawn', 'dusk',
  'hour', 'hours', 'hrs', 'notice', "o'clock", 'oclock', 'ish',
]);
// A month counts only after the mask ("expires [redacted] October"): before
// it ("Aug [redacted]") is a month-first date, which the count reads after a
// lead word, and a note's own date stamp otherwise.
const NEXT_MONTHS = new Set(['january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec']);
// A word that limits a time, before the mask ("NEVER [redacted]"): only when
// nothing but an end or a joining word follows the mask. "only [redacted]
// dogs" is a count (r23); "every [redacted] Tuesday" is read by the weekday.
const PREV_LIMITS = new Set(['until', 'till', 'before', 'after', 'except', 'never', 'every', 'only']);
const AFTER_LIMIT_OK = new Set(['and', 'or', 'please', 'only', 'ok', 'okay', 'then', 'at', 'in', 'on', 'before', 'after', 'until', 'till', 'thanks', 'thank']);
const MARK = '[redacted]';
const CODE_NOUN_BEFORE_RE = /\b(?:code|password|passcode|passphrase|pin|combo|combination)\b\s{0,5}(?:(?:is|=|:|#|-)\s{0,5})?$/i;
const CODE_NOUN_AFTER_RE = new RegExp(String.raw`^\s{0,5}(?:is|=)\s{1,5}(?:(?:the|my|our|your)\s{1,5})?(?:${CODE_PLACES}\s{1,5}){0,3}(?:code|password|passcode|passphrase|pin|combo|combination)\b`, 'i');
const wordsOf = (text) => (text.replace(/\[redacted\]/g, ' ').toLowerCase().match(/[a-z][a-z.']*/g) || []).map((w) => w.replace(/\.+$/, ''));

const CLAUSE_END_RE = /(?<!\b[ap]\.m)[.!?;](?=\s|$)|\n/gi;
function firstClause(text) {
  const re = new RegExp(CLAUSE_END_RE.source, 'gi');
  const m = re.exec(text);
  return m ? text.slice(0, m.index) : text;
}
function lastClause(text) {
  const re = new RegExp(CLAUSE_END_RE.source, 'gi');
  let end = 0;
  let m;
  while ((m = re.exec(text))) end = m.index + m[0].length;
  return text.slice(end);
}

function maskBesideTimeWord(masked, lineMasked = null) {
  if (lineMasked != null && lineMasked !== masked && !maskBesideTimeWord(lineMasked)) return false;
  let at = masked.indexOf(MARK);
  while (at !== -1) {
    // Within the mask's own sentence (r25): "ask [redacted]. Friday works" is
    // two statements. The dots inside "A.M." are not an end.
    const before = lastClause(masked.slice(Math.max(0, at - 60), at));
    const after = firstClause(masked.slice(at + MARK.length, at + MARK.length + 80));
    const own = CODE_NOUN_BEFORE_RE.test(before) || CODE_NOUN_AFTER_RE.test(after);
    if (!own) {
      const prev = wordsOf(before).pop();
      const next = wordsOf(after)[0];
      const following = wordsOf(after);
      if (NEIGHBOR_TIME_WORDS.has(prev) || NEIGHBOR_TIME_WORDS.has(next) || NEXT_MONTHS.has(next)) return true;
      // "May" is also a verb: a month only when nothing, or a joining word,
      // follows it ("expires [redacted] May", "... May only"): r24, r25.
      if (next === 'may' && (following.length === 1 || AFTER_LIMIT_OK.has(following[1]))) return true;
      // One hidden word after the limit ("NEVER [redacted]"): a longer
      // hidden run ("ONLY [redacted] [redacted]", "ONLY TWO DOGS") is a
      // phrase, not a time (r33, r43); a time in it is read by the count.
      const run = (masked.slice(at).match(/^(?:\[redacted\]\s{0,3}){1,3}/) || [''])[0].split(MARK).length - 1;
      // The limit must stand right before this mask, not before an earlier one.
      const afterMask = /\[redacted\][\s,]*$/.test(before);
      if (PREV_LIMITS.has(prev) && !afterMask && run <= 1 && (next === undefined || AFTER_LIMIT_OK.has(next))) return true;
    }
    at = masked.indexOf(MARK, at + MARK.length);
  }
  return false;
}

// The entries of one stored text: one, or its parts when it is long. `ms`
// (sort key), `split` and `maskedTime` are dropped before the record is
// returned.
//
// The hidden-time scan runs here, as each text is read, and keeps a yes / no
// only: no raw text is held until the record is built (Codex #6328 security
// r12: 300 replies of 800 KB raised the process's memory by 230 MB). One
// record shares one budget of MAX_RECORD_CHARS raw characters (its own
// AsyncLocalStorage store, so records built at once do not share it); a text
// past what is left is counted as not fully read without a scan (r8, r10).
const { AsyncLocalStorage } = require('async_hooks');
const scanBudget = new AsyncLocalStorage();

// The model reads the one-line text with the one-line mask, as before this
// check existed: a mask run on the line-kept text first can let a multi-word
// password on the next line through (Codex security r41). The line-kept mask
// only tells the neighbor rule where a clause ends.
const keepLines = (value) => String(value == null ? '' : value).replace(/[^\S\n]+/g, ' ').replace(/ ?\n\s*/g, '\n').trim();

// One entry is charged once against the record's budget (r36).
// A "[redacted]" already in the stored text is not this mask's work: for
// the scan it is renamed first, so only the mask's own markers are judged
// ("Prior caller [redacted] Monday": r47). The model reads the text as is.
const PRIOR_MARK_RE = /\[redacted\]/gi;

function hiddenTimeIn(text, raw, masked) {
  if (raw === masked) return false;
  const budget = scanBudget.getStore();
  if (budget && raw.length > budget.left) return true;
  if (budget) budget.left -= raw.length;
  const prior = raw.includes(MARK);
  const scanRaw = prior ? raw.replace(PRIOR_MARK_RE, '[prior]') : raw;
  const scanMasked = prior ? redactAccessCodes(scanRaw) : masked;
  const lines = prior ? keepLines(text).replace(PRIOR_MARK_RE, '[prior]') : keepLines(text);
  return maskHidTime(scanRaw, scanMasked, lines.includes('\n') ? redactAccessCodes(lines) : null);
}

function entry(channel, from, at, text) {
  const raw = clean(text);
  const body = redactAccessCodes(raw);
  if (!body) return [];
  const parts = partsOf(body);
  const hidden = hiddenTimeIn(text, raw, body);
  return parts.map((part, i) => ({
    channel, from, at: eastern(at), ms: msOf(at), text: parts.length > 1 ? `[part ${i + 1} of ${parts.length}] ${part}` : part, ...(parts.length > 1 && i > 0 ? { split: true } : {}),
    ...(hidden && i === 0 ? { maskedTime: true } : {}),
  }));
}

// sms_log keeps no time for its status changes. An outbound text created in
// the minutes before the move may have been only reserved then and sent
// after: whether the customer had it at the move is unknown (r7).
const SMS_SETTLE_MS = 10 * 60 * 1000;

async function readTexts(conn, { customerId, asOf }, unread) {
  const rows = await excludeUnresolvedSendReservations(conn('sms_log'))
    .where({ customer_id: customerId })
    .where('created_at', '<', asOf)
    .whereNotNull('message_body')
    // Only a text that reached the customer can have promised anything.
    .where(function reached() { this.where('direction', 'inbound').orWhereIn('status', ['sent', 'delivered']); })
    .orderBy('created_at')
    .select('direction', 'message_body', 'message_type', 'created_at', ...smsContactSelects(conn));
  return rows.map((row) => {
    if (row.direction !== 'inbound' && msOf(asOf) - msOf(row.created_at) < SMS_SETTLE_MS) {
      unread.push({ channel: 'text', at: eastern(row.created_at), reason: 'delivery_not_settled' });
      return [];
    }
    // The one operator-provenance rule (staff-contact.js): message_type
    // 'manual' alone is reused by automated senders (Codex #6258 r6).
    const from = row.direction === 'inbound' ? 'customer' : (operatorReply(row) ? 'staff' : 'system');
    return entry('text', from, row.created_at, row.message_body);
  });
}

// Mail the sync linked to the customer, plus our own replies. A sent mail is
// stored with no customer (measured 2026-10-09: 3,062 sent mails, none
// linked), so each unlinked SENT mail (personSentFilter: never a draft) of
// the customer's threads, or one that names the customer's address, is put
// to the ONE linkage rule the mail lanes share (email-customer-link.js: To,
// Cc and Bcc parsed as addresses; a mixed thread or a second customer among
// the recipients links to nobody). Only a mail that rule gives to this
// customer is read (Codex #6258 r1).
//
// A mail synced before Cc/Bcc were captured cannot be linked by that rule
// (who else it reached is unknown), and it is not guessed here (r2). When
// such a mail sits in one of the customer's own threads it is very likely
// our reply (196 of the 211 unlinked mails in customer threads, 2026-10-09),
// so the record says it could not read it: the verdict is then never allow.
//
// The body is the shared reader's (email-strip.js emailPlainText): an
// HTML-only mail is converted, never replaced by Gmail's short snippet.
// Each entry holds only the words that mail added: the quoted thread and the
// signature are stripped, and a subject counts only when it is new in its
// thread (stripQuotedAndSignature, ownSubjectsInThreads). Otherwise an old
// "Tuesdays only" would be read again at the date of every later reply (r3).
// Which subjects are new words in their thread, judged as the thread stood at
// `asOf` (email-strip.js ownSubjectsInThreads asks the same of the thread as
// it stands NOW, on the database clock: a replay needs the move's clock, r6).
// Only mail stored and received before `asOf` counts as a thread partner. A
// mail stored in the 15 minutes before `asOf` had no settled thread yet (its
// partners could still be syncing): its subject is unread, not absent.
async function ownSubjectsAsOf(conn, rows, asOf, live, unread) {
  const own = new Map();
  const withSubject = rows.filter((row) => clean(row.subject));
  const threadIds = [...new Set(withSubject.map((row) => row.gmail_thread_id).filter(Boolean))];
  const stored = threadIds.length ? await live(conn('emails').whereIn('gmail_thread_id', threadIds)).whereNotNull('subject')
    .whereRaw("NOT COALESCE(jsonb_exists(label_ids::jsonb, 'DRAFT'), false)")
    .select('id', 'gmail_thread_id', 'subject', 'received_at') : [];
  for (const row of withSubject) {
    if (row.created_at && msOf(asOf) - msOf(row.created_at) < SUBJECT_SETTLE_MS) {
      unread.push({ channel: 'email', at: eastern(row.received_at), reason: 'subject_not_settled' });
      continue;
    }
    const at = msOf(row.received_at);
    const earlier = stored.filter((o) => o.gmail_thread_id && o.gmail_thread_id === row.gmail_thread_id && String(o.id) !== String(row.id)
      && (msOf(o.received_at) < at || (msOf(o.received_at) === at && String(o.id) < String(row.id))));
    own.set(row.id, ownReplySubject(row.subject, earlier.map((o) => o.subject)));
  }
  return own;
}

async function readEmails(conn, { customerId, asOf, customerEmail }, unread) {
  const columns = ['id', 'gmail_thread_id', 'customer_id', 'from_address', 'to_address', 'cc_address', 'bcc_address', 'subject', 'body_text', 'body_html', 'snippet', 'received_at', 'created_at'];
  // received_at is Gmail's time; a backfill stores an old mail later, so the
  // row's own created_at is bounded too (Codex #6258 r5).
  const live = (query) => query.where('received_at', '<', asOf).where('created_at', '<', asOf).whereNull('quarantined_at')
    .whereRaw("COALESCE(classification, '') <> 'spam'");
  // The mail sync also links an inbound mail by the sender's display name
  // alone (email-actions.js), and a display name is whatever the sender
  // typed. Only a mail FROM the customer's own address is the customer's
  // words; any other linked mail is unread, never quoted (r8).
  const stored = await live(conn('emails').where({ customer_id: customerId })).select(columns);
  const own = clean(customerEmail).toLowerCase();
  const linked = stored.filter((row) => own && extractEmailAddresses(row.from_address).includes(own));
  for (const row of stored) {
    if (!linked.includes(row)) unread.push({ channel: 'email', at: eastern(row.received_at), reason: 'sender_not_verified' });
  }
  const threads = new Set(linked.map((row) => row.gmail_thread_id).filter(Boolean));
  const address = clean(customerEmail).toLowerCase();
  let candidates = [];
  if (threads.size || address) {
    candidates = await live(conn('emails').whereNull('customer_id')).whereRaw(personSentFilter('emails'))
      .where(function ours() {
        if (threads.size) this.whereIn('gmail_thread_id', [...threads]);
        // A coarse pre-filter only; resolveEmailCustomerLink decides.
        if (address) this.orWhereRaw("position(? in lower(concat_ws(' ', to_address, cc_address, bcc_address))) > 0", [address]);
      })
      .select(columns);
  }
  const replies = [];
  for (const row of candidates) {
    if (row.cc_address == null || row.bcc_address == null) {
      if (threads.has(row.gmail_thread_id)) unread.push({ channel: 'email', at: eastern(row.received_at), reason: 'recipients_not_captured' });
      continue;
    }
    const owner = await resolveEmailCustomerLink(conn, row, { asOf });
    if (owner != null && String(owner) === String(customerId)) replies.push(row);
  }
  const subjects = await ownSubjectsAsOf(conn, [...linked, ...replies], asOf, live, unread);
  const mail = (row, from) => entry(
    'email', from, row.received_at,
    [clean(subjects.get(row.id)), clean(stripQuotedAndSignature(emailPlainText(row)))].filter(Boolean).join(': '),
  );
  return [...linked.map((row) => mail(row, 'customer')), ...replies.map((row) => mail(row, 'staff'))];
}

async function readCalls(conn, { customerId, asOf }, unread) {
  const rows = await conn('call_log')
    .where({ customer_id: customerId })
    .where('created_at', '<', asOf)
    // A sandbox test call is nobody's words (relay-protocol.js).
    .modify((qb) => whereNotSandboxCall(qb))
    .select('direction', 'transcription', 'recording_sid', 'created_at', 'updated_at', 'call_outcome', 'processing_status', 'ai_extraction', 'ai_extraction_enriched', 'v2_extraction_status');
  const ours = rows.filter((row) => !NOT_THIS_CUSTOMER_OUTCOMES.includes(row.call_outcome) && !contextAggregator.isExcludedCall(row));
  return ours.map((row) => {
    // The transcript is written, and can be replaced or purged, after the
    // call row: a row touched after the move is unread whatever it holds now (r10).
    if (revisedLater(row, asOf, 'call', unread)) return [];
    const said = entry('call', 'both', row.created_at, row.transcription);
    // A recording nobody has turned into words yet: the record is incomplete.
    if (!said.length && row.recording_sid) unread.push({ channel: 'call', at: eastern(row.created_at), reason: 'not_transcribed' });
    return said;
  });
}

async function readInteractions(conn, { customerId, asOf }) {
  const rows = await conn('customer_interactions')
    .where({ customer_id: customerId })
    .where('created_at', '<', asOf)
    .whereNotIn('interaction_type', INTERACTION_COPIES)
    .select('interaction_type', 'subject', 'body', 'created_at');
  // A note can be its subject alone ("Afternoons only", no body).
  return rows.map((row) => entry(
    'note', row.interaction_type === 'service_request' ? 'customer' : 'staff', row.created_at,
    [clean(row.subject), clean(row.body)].filter(Boolean).join(': '),
  ));
}

async function readStaffNotes(conn, { customerId, asOf }, unread) {
  const rows = await conn('admin_notes').where({ customer_id: customerId }).where('created_at', '<', asOf)
    .select('note_text', 'created_at', 'updated_at');
  // Before any content test: a note cleared after the move reads empty today (r8).
  return rows.map((row) => (revisedLater(row, asOf, 'note', unread)
    ? [] : entry('note', 'staff', row.created_at, row.note_text)));
}

// A recap edit overwrites technician_notes and stamps updated_at.
async function readTechNotes(conn, { customerId, asOf }, unread) {
  const rows = await conn('service_records').where({ customer_id: customerId }).where('created_at', '<', asOf)
    .select('technician_notes', 'service_type', 'created_at', 'updated_at');
  // The note names the service it was written on: a statement about another
  // service is not a hold (prompt.js), and the model needs to see which (r9).
  return rows.map((row) => (revisedLater(row, asOf, 'technician_note', unread)
    ? [] : entry('technician_note', 'staff', row.created_at, clean(row.technician_notes) && clean(row.service_type) ? `[${clean(row.service_type)} visit] ${row.technician_notes}` : row.technician_notes)));
}

// The offer row is written when the offer is sent; the customer's reply
// lands on it later, at sms_responded_at. Each is bounded by its own time
// (Codex #6258 r1: a replay read replies that did not exist yet).
async function readRescheduleReplies(conn, { customerId, asOf }) {
  const rows = await conn('reschedule_log').where({ customer_id: customerId }).where('created_at', '<', asOf)
    .select('initiated_by', 'customer_response_text', 'sms_responded_at', 'notes', 'created_at');
  const before = (at) => !!at && new Date(at).getTime() < new Date(asOf).getTime();
  return rows.flatMap((row) => [
    before(row.sms_responded_at) ? entry('reschedule_reply', 'customer', row.sms_responded_at, row.customer_response_text) : [],
    PROGRAM_RESCHEDULERS.includes(row.initiated_by) ? [] : entry('note', 'staff', row.created_at, row.notes),
  ]);
}

// What the customer wrote in the portal's request form ("schedule_change"
// is one of its categories). These rows are not copied anywhere else. An
// open request can be revised in place (routes/schedule.js appends to it).
async function readPortalRequests(conn, { customerId, asOf }, unread) {
  const rows = await conn('service_requests').where({ customer_id: customerId }).where('created_at', '<', asOf)
    // source 'admin' is an operator's own record (admin-cancellation.js): staff
    // words in the same table, never the customer's (r8).
    // 'voice_agent' is the phone assistant's paraphrase of a call whose own
    // words come from the call log table (r9).
    .whereRaw("COALESCE(source, '') NOT IN ('admin', 'voice_agent')")
    .select('category', 'subject', 'description', 'created_at', 'updated_at');
  // updated_at moves on a status or assignment change too, so it does not
  // say when the customer's words were written. A row touched since it was
  // made carries no date: undated, it is never "the newest statement" (r8).
  const statedAt = (row) => (row.updated_at && msOf(row.updated_at) > msOf(row.created_at) ? null : row.created_at);
  return rows.map((row) => (revisedLater(row, asOf, 'portal_request', unread) ? [] : entry(
    'portal_request', 'customer', statedAt(row),
    [clean(row.category), clean(row.subject), clean(row.description)].filter(Boolean).join(': '),
  )));
}

// What the customer told the portal assistant, and what it answered. A
// signed-in chat is stored only here (agent_messages under the customer's
// agent_sessions); the text channel's turns are in sms_log already.
async function readAssistantChat(conn, { customerId, asOf }) {
  const rows = await conn('agent_messages')
    .join('agent_sessions', 'agent_sessions.id', 'agent_messages.conversation_id')
    .where('agent_sessions.customer_id', customerId)
    .where('agent_messages.created_at', '<', asOf)
    .whereIn('agent_messages.role', ['user', 'assistant'])
    .whereRaw("COALESCE(agent_sessions.channel, '') <> 'sms'")
    .select('agent_messages.role', 'agent_messages.content', 'agent_messages.created_at');
  return rows.map((row) => entry('portal_chat', row.role === 'user' ? 'customer' : 'system', row.created_at, row.content));
}

// What the customer wrote about the property in the portal. Auto-dispatch
// enforces only the structured day/time fields of this row (preferences.js);
// a "never Fridays" in the free text is for the proofreader. One row per
// customer, edited in place, so it is undated like the file notes.
// Every free-text field of the row that can hold a day or time rule (r8).
const PROPERTY_NOTE_FIELDS = ['special_instructions', 'access_notes', 'hoa_timing_restrictions', 'hoa_restrictions', 'mowing_notes', 'irrigation_schedule_notes'];

async function readPropertyNotes(conn, { customerId, asOf }, unread) {
  const row = await conn('property_preferences').where({ customer_id: customerId }).first(...PROPERTY_NOTE_FIELDS, 'created_at', 'updated_at');
  if (!row) return [];
  // Before the content test: a note cleared after the move reads empty today (r6).
  if (revisedLater(row, asOf, 'property_note', unread)) return [];
  return PROPERTY_NOTE_FIELDS.map((field) => entry('property_note', 'customer', null, clean(row[field]) ? `${field.replace(/_/g, ' ')}: ${row[field]}` : ''));
}

// The customer's file notes and the notes on the visit and its series. A
// visit that is not given, or is gone (a replay of a move whose visit was
// deleted since), has notes nobody can read: the record says so (r3).
// A grouped stop moves as one: the notes of every member's series are read,
// and `args.serviceTypes` names every service the move takes with it (r5).
async function readUndatedNotes(conn, args, unread) {
  const { customer, serviceId } = args;
  const out = [
    entry('customer_file_note', 'staff', null, customer && customer.crm_notes),
    entry('customer_file_note', 'staff', null, customer && customer.internal_notes),
    entry('customer_file_note', 'staff', null, customer && customer.follow_up_notes),
    entry('customer_file_note', 'staff', null, customer && customer.access_notes),
  ];
  const visit = serviceId ? await conn('scheduled_services').where({ id: serviceId }).first('id', 'recurring_parent_id', 'visit_id', 'service_type') : null;
  if (!visit) {
    unread.push({ channel: 'visit_note', reason: 'visit_not_found' });
    return out;
  }
  const members = visit.visit_id
    // Not the rows a frozen visit keeps only as history (statuses.js): they did not move.
    ? await conn('scheduled_services').where({ visit_id: visit.visit_id }).whereNotIn('status', RETAINED_HISTORY_STATUSES).select('id', 'recurring_parent_id', 'service_type')
    : [visit];
  const unit = members.length ? members : [visit];
  args.serviceTypes = [...new Set(unit.map((row) => clean(row.service_type)).filter(Boolean))];
  const parentIds = [...new Set(unit.map((row) => row.recurring_parent_id || row.id))];
  // The moved rows and their series parents only. A note on another
  // occurrence of the series is about that visit, not this one (r8).
  const series = await conn('scheduled_services')
    .whereIn('id', [...new Set([...parentIds, ...unit.map((row) => row.id)])])
    .select('notes', 'internal_notes');
  const texts = new Set();
  for (const row of series) for (const text of [row.notes, row.internal_notes]) if (clean(text)) texts.add(clean(text));
  return out.concat([...texts].map((text) => entry('visit_note', 'staff', null, text)));
}

const SOURCES = [
  ['text', readTexts], ['email', readEmails], ['call', readCalls], ['note', readInteractions],
  ['note', readStaffNotes], ['technician_note', readTechNotes], ['reschedule_reply', readRescheduleReplies],
  ['portal_request', readPortalRequests], ['portal_chat', readAssistantChat], ['property_note', readPropertyNotes], ['customer_file_note', readUndatedNotes],
];

/**
 * @returns {{ entries: Array<{id,channel,from,at,text}>, unread: Array<{channel,at?,reason}>, split: number, chars: number, tooLong: boolean, serviceTypes: string[] }}
 * `serviceTypes`: every service the visit's stop holds today (one, or the
 * members of a grouped stop); empty when the visit could not be read.
 */
async function buildCustomerRecord(conn, { customerId, serviceId = null, asOf = new Date() }) {
  const unread = [];
  const found = [];
  let customer = null;
  try {
    customer = await conn('customers').where({ id: customerId })
      .first('email', 'crm_notes', 'internal_notes', 'follow_up_notes', 'access_notes');
  } catch (err) {
    logger.warn(`[auto-dispatch] proofreader could not read the customer file: ${safeError(err)}`);
  }
  // No customer row: its notes and its mail address are both unread.
  if (!customer) unread.push({ channel: 'customer_file_note', reason: 'read_failed' });
  const args = {
    customerId, serviceId, asOf, customer, customerEmail: customer && customer.email,
  };
  const budget = { left: MAX_RECORD_CHARS };
  for (const [channel, read] of SOURCES) {
    try {
      found.push(...(await scanBudget.run(budget, () => read(conn, args, unread))).flat(2));
    } catch (err) {
      unread.push({ channel, reason: 'read_failed' });
      logger.warn(`[auto-dispatch] proofreader could not read ${channel}: ${safeError(err)}`);
    }
  }
  // Undated notes first, then oldest to newest.
  found.sort((a, b) => (a.ms ?? -1) - (b.ms ?? -1));
  // An entry whose access-code mask also hid a word that can say when
  // (maskHidTime): read, but not in full.
  for (const row of found) {
    if (row.maskedTime) unread.push({ channel: row.channel, ...(row.at ? { at: row.at } : {}), reason: 'time_masked' });
  }
  const entries = found.map(({ split: _split, ms: _ms, maskedTime: _masked, ...rest }, i) => ({ id: `E${i + 1}`, ...rest }));
  const chars = entries.reduce((sum, row) => sum + row.text.length, 0);
  const tooLong = chars > MAX_RECORD_CHARS;
  return {
    entries, unread, split: found.filter((row) => row.split).length, chars, tooLong, serviceTypes: args.serviceTypes || [],
  };
}

module.exports = {
  buildCustomerRecord, MAX_ENTRY_CHARS, MAX_RECORD_CHARS, _internals: { maskHidTime },
};

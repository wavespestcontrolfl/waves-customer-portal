/**
 * Who may hear from a website-only line.
 *
 * A call to a website-only line (config/shared-phone-lines) proves a website
 * visit: the Calls and Leads screens list it as Website. So a staff text or
 * call goes out from one only to a person who already called or texted that
 * line. Anyone else would learn the number outside the website, and a later
 * call from them would be counted as a website lead.
 *
 * Every staff route that sends a text from a line the sender picks checks it
 * here: the Communications composer (the Intelligence Bar and like-text sends
 * run through it), the lead composer, the draft approve and revise sends, and
 * the scheduled-text route. The scheduled-text dispatcher checks it again at
 * send time (scheduled-sms-delivery.js), because the contact fan-out can move
 * a queued text to a new phone. Replies pass: a text to someone who called or
 * texted that line. In the year to 2026-11-19 every text and call sent from a
 * website-only line was one. A staff call needs no check: its caller ID is
 * the home line or the main line (admin-communications.js callHandler,
 * home-line.js homeLineCallerId), whatever line the screen picked.
 *
 * Read-only. Phone identity is the full E.164 number, never a bare last-10
 * suffix: phoneMatchDigits on our side, storedE164Sql on the stored side. A
 * leading + keeps its country code as written; a bare 10-digit or 1+10-digit
 * value is a US number. So a 10-digit international number never matches the
 * US number with the same digits. The last-10 expression index on from_phone
 * (migration 20260927000006, the outbound-call-reason.js probes) narrows each
 * read first.
 */
const db = require('../models/db');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { websiteOnlyLines } = require('../config/shared-phone-lines');
const { phoneMatchDigits } = require('../utils/phone');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');

const WEBSITE_LINE_REFUSAL = 'That line is shown only on a Waves website. Use it only for someone who already called or texted it, or pick another line.';

// A number's E.164 identity, or null: phoneMatchDigits gives its full digits first.
const e164Of = (number) => {
  const [full] = phoneMatchDigits(String(number || ''));
  return full ? `+${full}` : null;
};
// The same identity for a stored value, by the same rule (no ? in the SQL:
// knex reads every ? as a binding).
const storedE164Sql = (column) => {
  const digits = `regexp_replace(coalesce(${column}, ''), '[^0-9]', '', 'g')`;
  return `(CASE WHEN btrim(coalesce(${column}, '')) LIKE '+%' THEN '+' || ${digits}`
    + ` WHEN ${digits} ~ '^1[0-9]{10}$' THEN '+' || ${digits}`
    + ` WHEN ${digits} ~ '^[0-9]{10}$' THEN '+1' || ${digits} END)`;
};
// Character for character the indexed expression, so the planner can use it.
const FROM_LAST10_SQL = "right(regexp_replace(from_phone, '\\D', '', 'g'), 10) = ?";

function websiteOnlyLineE164(number) {
  const e164 = e164Of(number);
  if (!e164) return null;
  return websiteOnlyLines(TWILIO_NUMBERS).some((line) => e164Of(line.number) === e164) ? e164 : null;
}

/**
 * WEBSITE_LINE_REFUSAL when a staff text or call from `fromNumber` to `to`
 * would give a website-only line to a person who never called or texted it;
 * otherwise null (any other line, or a reply on that line).
 */
async function websiteLineRefusal(fromNumber, to, { database = db } = {}) {
  const line = websiteOnlyLineE164(fromNumber);
  if (!line) return null;
  const person = e164Of(to);
  if (!person) return WEBSITE_LINE_REFUSAL;
  const contacted = (query) => query
    .where('direction', 'inbound')
    // Digits only: the indexed expression has no +, and a short international number keeps it in its last 10.
    .whereRaw(FROM_LAST10_SQL, [person.slice(1).slice(-10)])
    .whereRaw(`${storedE164Sql('from_phone')} = ?`, [person])
    .whereRaw(`${storedE164Sql('to_phone')} = ?`, [line])
    .first('id');
  // A Sandy sandbox call or a tech-voice call is internal: it is never a
  // person who reached Waves on that line.
  const [text, call] = await Promise.all([
    contacted(database('sms_log')),
    contacted(whereNotSandboxCall(database('call_log'))),
  ]);
  return text || call ? null : WEBSITE_LINE_REFUSAL;
}

module.exports = { websiteLineRefusal, WEBSITE_LINE_REFUSAL };

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
 * the scheduled-text route. Replies pass: a text to someone who called or
 * texted that line. In the year to 2026-11-19 every text and call sent from a
 * website-only line was one. A staff call needs no check: its caller ID is
 * the home line or the main line (admin-communications.js callHandler,
 * home-line.js homeLineCallerId), whatever line the screen picked.
 *
 * Read-only. Phone identity is the full number (phoneMatchDigits), never a
 * bare last-10 suffix, the same rule as home-line.js staffTextSender. The
 * last-10 expression index on from_phone (migration 20260927000006, the
 * outbound-call-reason.js probes) narrows each read first.
 */
const db = require('../models/db');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { websiteOnlyLines } = require('../config/shared-phone-lines');
const { phoneMatchDigits } = require('../utils/phone');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');

const WEBSITE_LINE_REFUSAL = 'That line is shown only on a Waves website. Use it only for someone who already called or texted it, or pick another line.';

const digitsOf = (number) => phoneMatchDigits(String(number || ''));
const digitsSql = (column) => `regexp_replace(coalesce(${column}, ''), '[^0-9]', '', 'g')`;
// Character for character the indexed expression, so the planner can use it.
const FROM_LAST10_SQL = "right(regexp_replace(from_phone, '\\D', '', 'g'), 10) = ?";

function websiteOnlyLineDigits(number) {
  const digits = digitsOf(number);
  if (!digits.length) return null;
  const listed = websiteOnlyLines(TWILIO_NUMBERS).some((line) => digitsOf(line.number).some((d) => digits.includes(d)));
  return listed ? digits : null;
}

/**
 * WEBSITE_LINE_REFUSAL when a staff text or call from `fromNumber` to `to`
 * would give a website-only line to a person who never called or texted it;
 * otherwise null (any other line, or a reply on that line).
 */
async function websiteLineRefusal(fromNumber, to, { database = db } = {}) {
  const line = websiteOnlyLineDigits(fromNumber);
  if (!line) return null;
  const person = digitsOf(to);
  if (!person.length) return WEBSITE_LINE_REFUSAL;
  const contacted = (query) => query
    .where('direction', 'inbound')
    .whereRaw(FROM_LAST10_SQL, [person[0].slice(-10)])
    .whereRaw(`${digitsSql('from_phone')} = ANY (?::text[])`, [person])
    .whereRaw(`${digitsSql('to_phone')} = ANY (?::text[])`, [line])
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

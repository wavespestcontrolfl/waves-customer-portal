'use strict';

// Small helpers for admin alerts that must say WHO and WHAT (owner audit 2026-10-01):
// the customer's name leads the headline and the words behind the alert ride in the
// why, so the bell is actionable without opening anything. Contract:
// docs/admin-notifications.md. Pure except lookupCustomerName; nothing here rings a bell.
const { MAX_HEADLINE_CHARS, MAX_WHY_CHARS, cutAtWord } = require('./admin-alert-compose');

const DASH = ' — ';

const fullName = (row) => [row?.first_name, row?.last_name]
  .map((part) => String(part || '').trim()).filter(Boolean).join(' ');

// The customer's display name, or '' when there is no usable one. Best effort: a failed
// lookup must never cost the alert its bell.
async function lookupCustomerName(conn, customerId) {
  if (!customerId) return '';
  try {
    return fullName(await conn('customers').where({ id: customerId }).first('first_name', 'last_name'));
  } catch (_) {
    return '';
  }
}

// A name typed by a customer can carry code-shaped characters (underscores, dots) that the
// headline rule refuses; spaces read the same to a person.
const tidyName = (name) => String(name || '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

// The action half of a headline ("<Area> — <action>"), using the first template whose
// result fits the 60 characters. Each template takes the name. When none fits, the last
// template runs with the name cut to what is left.
function fitAction(area, name, templates) {
  const room = MAX_HEADLINE_CHARS - (area + DASH).length;
  const who = tidyName(name);
  for (const template of templates) {
    const action = template(who);
    if (action.length <= room) return action;
  }
  // Too long even with the last template: shorten the NAME at a word boundary with a visible
  // ellipsis (room is reserved for the action around it). If not even the first word fits,
  // that word is cut and gets the ellipsis.
  const last = templates[templates.length - 1];
  const words = who.split(' ');
  for (let n = words.length - 1; n >= 1; n -= 1) {
    const action = last(`${words.slice(0, n).join(' ')}…`);
    if (action.length <= room) return action;
  }
  let first = words[0];
  while (first.length > 1 && last(`${first}…`).length > room) first = first.slice(0, -1);
  return last(`${first}…`);
}

// A short ET date a person would say ("Sep 29").
function shortDateET(value) {
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
}

// A customer's (or our own) words, redacted the way every other bell body is: contact
// details and street addresses are masked. The registry's helper is read at call time so
// this module never loads the notification stack just to compose copy.
function redactedWords(text) {
  const { redactSensitiveText } = require('./notification-triggers').__private;
  return redactSensitiveText(String(text || '').replace(/\s+/g, ' ').trim());
}

// `<lead>“quote”<tail>` inside the why budget: the quote gives up characters first, and
// is cut at a word with an ellipsis. Returns the whole why.
function whyWithQuote({ lead = '', quote, tail = '', max = MAX_WHY_CHARS }) {
  const room = max - lead.length - tail.length - 2;
  if (!quote || room < 12) return cutAtWord(`${lead}${tail}`.trim(), max);
  return `${lead}“${cutAtWord(quote, room)}”${tail}`;
}

module.exports = { fullName, lookupCustomerName, tidyName, fitAction, shortDateET, redactedWords, whyWithQuote };

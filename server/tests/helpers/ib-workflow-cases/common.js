'use strict';

// Shared helpers for the workflow case scripts. Nothing here requires service code at
// load time: the database environment is configured when the harness boots.

const { nextWeekdayET, plusDaysET } = require('../ib-workflow-fixtures');
const { rowState, noWrites, noSends, sendState } = require('../ib-workflow-state');

/** A date value from a reader (a plain YYYY-MM-DD or a JS Date instant) as the set of YYYY-MM-DD days it can denote. */
function ymdSet(value) {
  if (!value) return new Set();
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Set([text]);
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return new Set();
  const { etDateString } = require('../../../utils/datetime-et');
  return new Set([etDateString(d), d.toISOString().slice(0, 10)]);
}
const sameDay = (value, ymd) => ymdSet(value).has(ymd);

/** Tool result from a turn by tool name (first match unless an index is given). */
const pick = (turn, name, nth = 0) => { const found = turn.toolCalls.filter((c) => c.name === name); return found[nth] ? found[nth].result : undefined; };
const picks = (turn, name) => turn.toolCalls.filter((c) => c.name === name).map((c) => c.result);

/** A read round: look the customer up, then read by the id the lookup returned. */
const lookupThen = (search, makeTools) => [
  { tools: [['query_customers', { search }]] },
  (prev) => {
    const hit = prev[0] && prev[0].result && prev[0].result.customers && prev[0].result.customers[0];
    return { tools: hit ? makeTools(hit.id, hit) : [] };
  },
];

/** YYYY-MM-DD plus whole days, calendar arithmetic only. */
const ymdAdd = (ymd, days) => new Date(Date.parse(`${ymd}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/** The tool refused for the actor's role (the registry's own wording): evidence of a refusal, not merely the absence of a card. */
const roleRefusal = (result) => !!result && typeof result === 'object' && /not available to your role/i.test(String(result.error || ''));
/** The send tool answered that the number is opted out / blocked, in its own words or a code. */
const optOutRefusal = (result) => !!result && typeof result === 'object' && /opt.?out|\bstop\b|consent|unsubscrib|do.not.(text|contact)|blocked/i.test(`${result.code || ''} ${result.error || ''}`);

const errorCode = (result) => (result && typeof result === 'object' ? result.code || null : null);
const has = (haystack, needle) => JSON.stringify(haystack || '').includes(needle);

module.exports = { roleRefusal, optOutRefusal, rowState, noWrites, noSends, sendState, ymdSet, sameDay, pick, picks, lookupThen, errorCode, has, ymdAdd, nextWeekdayET, plusDaysET };

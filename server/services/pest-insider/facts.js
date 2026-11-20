/**
 * Pest Insider fact bank: the sourced facts a "Today I learned" lead is made
 * of. Loaded from server/data/pest-insider-facts-v1.json (converted from the
 * researched fact bank; every quote is copied verbatim from its source).
 * Each main fact carries its reviewed `lead`: the LEAD_MIN to LEAD_MAX
 * sentences an issue prints as they are, checked against the quotes by
 * claim-check.js.
 *
 * The bank is validated on load and throws on a malformed entry, so a bad
 * edit fails the first call instead of reaching a customer.
 */
'use strict';

const bank = require('../../data/pest-insider-facts-v1.json');
const { etDateString } = require('../../utils/datetime-et');
const { validDateOnly } = require('../../utils/date-only');

const SERVICES = new Set(['pest', 'lawn', 'tree_shrub', 'mosquito', 'termite', 'rodent']);
const KINDS = new Set(['pest', 'plant', 'rule']);
const CONFIDENCES = new Set(['high', 'medium']);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// An ISO timestamp with no offset is Eastern wall-clock time (the portal is
// Eastern-only); one with Z or an offset is an instant.
const CLOCK = '(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?';
const LOCAL_TIMESTAMP = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})[T ]${CLOCK}$`);
const OFFSET_TIMESTAMP = new RegExp(`^\\d{4}-\\d{2}-\\d{2}[T ]${CLOCK}(?:Z|[+-](?:[01]\\d|2[0-3]):?[0-5]\\d)$`, 'i');

/** How many reviewed lead sentences a main fact carries. */
const LEAD_MIN = 2;
const LEAD_MAX = 4;

const isText = (v) => typeof v === 'string' && v.trim().length > 0;

function sourceProblem(s) {
  if (!s || typeof s !== 'object') return 'source is not an object';
  if (!isText(s.publisher) || !isText(s.title) || !isText(s.url) || !isText(s.date_text)) return 'source needs publisher, title, url and date_text';
  if (s.pub_id !== null && !isText(s.pub_id)) return 'source pub_id must be text or null';
  if (!/^https?:\/\//.test(s.url)) return 'source url must be http(s)';
  return null;
}

function quotesProblem(f) {
  if (!Array.isArray(f.quotes) || !f.quotes.length || !f.quotes.every(isText)) return 'quotes must be a non-empty array of text';
  if (!Array.isArray(f.sources) || !f.sources.length) return 'sources must be non-empty';
  const bad = f.sources.map(sourceProblem).find(Boolean);
  if (bad) return bad;
  // quote_sources[i] is the index in `sources` of the publisher quotes[i] came from.
  if (!Array.isArray(f.quote_sources) || f.quote_sources.length !== f.quotes.length
    || !f.quote_sources.every((i) => Number.isInteger(i) && i >= 0 && i < f.sources.length)) return 'quote_sources must give a source index for each quote';
  return null;
}

// A reserve fact never leads an issue (factsForSend drops it), so only a
// main fact must carry its copy; a reserve fact that has one is checked too.
function leadProblem(f) {
  if (f.reserve && f.lead === undefined) return null;
  const ok = Array.isArray(f.lead) && f.lead.length >= LEAD_MIN && f.lead.length <= LEAD_MAX && f.lead.every(isText);
  return ok ? null : `lead must be ${LEAD_MIN} to ${LEAD_MAX} sentences of text`;
}

function factProblem(f) {
  if (!f || typeof f !== 'object') return 'entry is not an object';
  if (!/^[A-Z]\d{2}$/.test(String(f.id))) return 'id must look like P03';
  if (!isText(f.title) || !isText(f.statement)) return 'title and statement are required';
  const quoteBad = quotesProblem(f);
  if (quoteBad) return quoteBad;
  if (!Array.isArray(f.months) || !f.months.length || !f.months.every((m) => Number.isInteger(m) && m >= 1 && m <= 12)) return 'months must be integers 1-12';
  if (!SERVICES.has(f.service)) return `service must be one of ${[...SERVICES].join(', ')}`;
  if (!KINDS.has(f.kind)) return `kind must be one of ${[...KINDS].join(', ')}`;
  if (!CONFIDENCES.has(f.confidence)) return 'confidence must be high or medium';
  if (f.expires_on !== undefined && !validDateOnly(String(f.expires_on))) return 'expires_on must be a real YYYY-MM-DD date';
  return leadProblem(f);
}

function validateBank(data) {
  if (!data || !Array.isArray(data.facts) || !data.facts.length) throw new Error('pest-insider facts: bank has no facts');
  const seen = new Set();
  for (const f of data.facts) {
    const problem = factProblem(f);
    if (problem) throw new Error(`pest-insider facts: ${f && f.id ? f.id : 'entry'}: ${problem}`);
    if (seen.has(f.id)) throw new Error(`pest-insider facts: duplicate id ${f.id}`);
    seen.add(f.id);
  }
  return data.facts;
}

// The bank is reviewed copy, and the copy check reads a fact's own quotes as
// its evidence, so no caller may change it between builds: the facts are
// frozen all the way down (pre-push round 13).
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const FACTS = deepFreeze(validateBank(bank));

/**
 * ET calendar date 'YYYY-MM-DD' for a send date: a 'YYYY-MM-DD' string, an
 * ISO timestamp (no offset = Eastern wall-clock time; Z or an offset = an
 * instant) or a Date. Anything else, and a calendar day that does not exist
 * (2027-02-30), is refused before any plan is made.
 */
function sendDateET(sendDate) {
  if (sendDate instanceof Date) {
    if (Number.isNaN(sendDate.getTime())) throw new Error('pest-insider: sendDate is not a valid date');
    return etDateString(sendDate);
  }
  const text = typeof sendDate === 'string' ? sendDate.trim() : '';
  const day = text.slice(0, 10);
  if (DATE_ONLY.test(day) && !validDateOnly(day)) throw new Error(`pest-insider: ${day} is not a real calendar date`);
  if (DATE_ONLY.test(text)) return text;
  const local = LOCAL_TIMESTAMP.exec(text);
  if (local) return local[1];
  if (OFFSET_TIMESTAMP.test(text)) {
    const d = new Date(text);
    if (!Number.isNaN(d.getTime())) return etDateString(d);
  }
  throw new Error('pest-insider: sendDate must be YYYY-MM-DD, an ISO timestamp or a Date');
}

const monthOf = (dateET) => Number(dateET.slice(5, 7));
const rank = (f) => [f.kind === 'pest' ? 0 : 1, f.confidence === 'high' ? 0 : 1];

function byPreference(a, b) {
  const ra = rank(a);
  const rb = rank(b);
  return (ra[0] - rb[0]) || (ra[1] - rb[1]) || a.id.localeCompare(b.id);
}

/**
 * Facts that may lead an issue sent on `sendDate` (ET): reserve facts, facts
 * past their expires_on and facts outside the send month are dropped, as are
 * `excludeIds`. A fact marked recheck_before_send (a source that changes or
 * could not be re-read automatically) is dropped too, unless its id is in
 * `recheckedIds`: the caller's record that a person re-read the source for
 * this send. Order: kind 'pest' first, then confidence high, then id.
 */
function factsForSend(sendDate, { excludeIds = [], recheckedIds = [] } = {}) {
  const dateET = sendDateET(sendDate);
  const month = monthOf(dateET);
  const excluded = new Set(excludeIds);
  const rechecked = new Set(recheckedIds);
  return FACTS
    .filter((f) => !f.reserve)
    .filter((f) => !f.expires_on || dateET <= f.expires_on)
    .filter((f) => f.months.includes(month))
    .filter((f) => !excluded.has(f.id))
    .filter((f) => !f.recheck_before_send || rechecked.has(f.id))
    .sort(byPreference);
}

const factById = (id) => FACTS.find((f) => f.id === id) || null;

/** The name a sentence gives a source: "UF/IFAS", "CDC", "Florida law", ... */
function sourceLabel(source) {
  const publisher = source.publisher;
  if (/^UF\/IFAS/.test(publisher)) return 'UF/IFAS';
  if (publisher === 'Florida Statutes') return 'Florida law';
  return publisher;
}

/** Each quote with the label of the publisher it came from. */
const attributedQuotes = (fact) => fact.quotes.map((text, i) => ({ text, label: sourceLabel(fact.sources[fact.quote_sources[i]]) }));

module.exports = { FACTS, SERVICES, LEAD_MIN, LEAD_MAX, factsForSend, factById, sendDateET, validateBank, sourceLabel, attributedQuotes };

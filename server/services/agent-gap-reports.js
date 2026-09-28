'use strict';

/**
 * Intelligence Bar gap reports — server-owned recorder + per-request collector.
 *
 * Prod data shows the bar tells the operator "I can't / no tool for that"
 * in roughly half its replies, and about half of those are a real missing
 * feature or bug. The query log is redacted whenever customer data is
 * touched, so none of that could be mined afterwards.
 *
 * The model is given NO tool that writes here (the #1568 trust boundary:
 * a model-facing write goes through the confirmation card). Instead the
 * route feeds the collector what the server itself observed in the tool
 * loop — its own capability-search results and a tool name that does not
 * exist — and at the end of the request the
 * collector records those signals only when the reply told the operator
 * the bar could not do something. `writeGapRows()` is the only write path
 * (server/models/migrations/20260928160000_agent_gap_reports.js) and never
 * throws: a broken gap report must never break the request that surfaced it.
 */
const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { redactText } = require('./agent-decision-training');
const policy = require('./intelligence-bar/action-policy.json');

// The table's CHECK also allows 'tool_failure' and 'blocked'; nothing
// produces them. Broken tools are already tracked per call in
// tool_health_events (the Tool Health dashboard).
const KINDS = new Set(['missing_capability']);
// The owner's triage lifecycle (migration CHECK). Closed statuses stay out of
// the default list and the Monday digest; a recurrence reopens `fixed`.
const GAP_STATUSES = Object.freeze(['new', 'building', 'fixed', 'by_design', 'dismissed']);
const CLOSED_STATUSES = Object.freeze(['fixed', 'by_design', 'dismissed']);
const MAX_TEXT = 300;
const TOOL_NAME_RE = /^[a-z0-9_]{1,64}$/;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Record numbers (invoice, property, account) left after redactText's
// phone pass. Four digits or more, so "2 times" and short counts survive.
const LONG_NUMBER_RE = /\b\d{4,}\b/g;
const KNOWN_DOMAINS = new Set(Object.values(policy).map((entry) => entry?.domain).filter(Boolean));
// A house number followed by capitalized street words ("12 Palm Row"),
// including suffixes redactText's address pattern does not know.
const STREET_RE = /\b\d{1,6}(?:\s+\p{Lu}[\p{L}'’-]*){1,4}/gu;
// The same in any case, when the last word is a street type: "12 palm row".
const STREET_ANY_CASE_RE = /\b\d{1,6}(?:\s+[\p{L}'’.-]+){1,3}?\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|cir|circle|way|pl|place|blvd|boulevard|ter|terrace|row|loop|trl|trail|pkwy|parkway|hwy|highway|cv|cove|sq|square|plz|plaza|cres|crescent|xing|crossing|mnr|manor|hts|heights|grv|grove|bnd|bend|rdg|ridge|lndg|landing)\b\.?/giu;
const CAPITALIZED_RE = /\p{Lu}[\p{L}'’-]*/gu;
const NAME_TOKEN_RE = /\p{L}[\p{L}'’-]{2,}/gu;
const ACRONYM_RE = /^[\p{Lu}\d]{2,6}$/u; // WDO, SMS, ACH, GA4 — kept
// Capitalized words a general description may use without naming anyone:
// services the bar integrates with, the Waves plan tiers, days and months.
const KEEP_CAPITALIZED = new Set(('Waves WaveGuard Bronze Silver Gold Platinum Stripe Twilio SendGrid Google Gmail '
  + 'Meta Facebook Instagram Sentry Cloudflare GitHub Railway GrowthBook Bouncie Apify QuickBooks Zelle PayPal '
  + 'Venmo Apple Android Yelp Nextdoor Angi Thumbtack TikTok YouTube LinkedIn Bing OpenAI Claude Gemini DataForSEO '
  + 'Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August '
  + 'September October November December').split(' '));
// A capitalized first word is kept only when it reads as the request's verb.
const LEADING_VERBS = new Set(('add create cancel refund merge update change send schedule reschedule move delete '
  + 'remove show find list set mark book charge void issue edit export import sync connect split combine assign '
  + 'reassign apply waive pause resume stop start text email call print upload download approve reject close open '
  + 'reopen transfer convert archive restore generate draft post publish check verify track view pull run look '
  + 'see get').split(' '));
const DISCOVERY_TOOL_NAME = 'discover_capabilities';

// Same stopword list as the discovery ranker (action-registry.js
// DISCOVERY_STOPWORDS) — kept local so this module has no load-order
// dependency on the registry.
const STOPWORDS = new Set(('a an the i me my we our you your it this that these those do does did can could '
  + 'will would should please like want need to for from of on in with is are be have has and or what how '
  + 'get find show search list').split(' '));

// The reply told the operator the bar could not do something. Nothing is
// recorded without it: an exploratory search or a retried tool that ended
// in a real answer is not a gap.
const DECLINE_RE = /\b(?:can(?:not|'t|’t)|could(?: not|n't|n’t)|unable to|not able to|no tool|don(?:'t|’t) have (?:a|any) (?:tool|way))\b|\b(?:isn(?:'t|’t)|not) (?:available|supported|possible)\b/i;

// Kill switch (CLAUDE.md rule 14): AGENT_GAP_REPORTS=off stops the prompt
// line, the collector's writes and the Monday digest. Read at call time, so
// a flip needs no redeploy. Default on.
function gapReportsEnabled() {
  return String(process.env.AGENT_GAP_REPORTS || '').trim().toLowerCase() !== 'off';
}

const PROMPT_LINE = '\nBefore you tell the operator that something they asked for cannot be done from the bar, '
  + 'call discover_capabilities with a short, general description of it (no names, phone numbers, emails, '
  + 'street addresses or record ids).';

// Appended to the platform prompt; empty while the kill switch is off.
function gapReportPromptLine() {
  return gapReportsEnabled() ? PROMPT_LINE : '';
}

// Deterministic scrub for model-written text, which can carry a name or a
// new address the request never resolved to a customer: every capitalized
// word becomes [name] unless it is an acronym, on the keep list, or the
// leading verb; a house number with its street becomes [address].
function scrubProperNouns(text) {
  return text.replace(STREET_RE, '[address]').replace(CAPITALIZED_RE, (word, offset) => {
    if (ACRONYM_RE.test(word) || KEEP_CAPITALIZED.has(word)) return word;
    if (offset === 0 && LEADING_VERBS.has(word.toLowerCase())) return word;
    return '[name]';
  });
}

// `freeText` marks model-written text (a search description); the server's
// own fixed phrasings skip the proper-noun scrub.
function cleanText(value, names, { freeText = false } = {}) {
  if (!value) return null;
  // Strip UUIDs BEFORE redactText: its phone regex has no leading word
  // boundary and can otherwise eat into a UUID's digit runs first.
  const withoutIds = String(value).replace(UUID_RE, '[id]').replace(/\s+/g, ' ').trim();
  // Contact patterns first, then the request's names: redactText replaces
  // names before emails, so a name inside an address would otherwise break
  // the email match and leave "[name]@domain" behind.
  const redacted = redactText(redactText(withoutIds), { names }).replace(STREET_ANY_CASE_RE, '[address]');
  const scrubbed = (freeText ? scrubProperNouns(redacted) : redacted).replace(LONG_NUMBER_RE, '[number]');
  const text = scrubbed.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  return text || null;
}

function cleanTool(value) {
  const tool = String(value || '').trim();
  return TOOL_NAME_RE.test(tool) ? tool : null;
}

function cleanDomain(value) {
  const domain = String(value || '').trim();
  return KNOWN_DOMAINS.has(domain) ? domain : null;
}

// Word-order-independent key: "add property to customer" and "customer
// property add" dedupe to the same fingerprint.
function wordKeyOf(summary) {
  const words = [...new Set((summary || '').toLowerCase().match(/[a-z0-9]+/g) || [])]
    .filter((word) => !STOPWORDS.has(word)).sort();
  return words.length ? words.join(' ') : String(summary || '').toLowerCase();
}

// The closest tool is only the search's best guess, which varies between
// requests for the same ask, so it stays out of the key (and is enriched on
// merge instead).
function fingerprintFor({ source, kind, summary }) {
  const key = `${source}|${kind}|${wordKeyOf(summary)}`;
  return crypto.createHash('sha256').update(key).digest('hex');
}

// Pure: a cleaned, fingerprinted row for one signal, or null if it carries
// nothing recordable. `names` are the request's customer names to redact.
function prepareGapRow({ source, kind, summary, freeText, attempted, closestTool, domain } = {}, names = []) {
  if (!KINDS.has(kind)) return null;
  const cleanSummary = cleanText(summary, names, { freeText: freeText === true });
  if (!cleanSummary) return null;
  const tool = cleanTool(closestTool);
  const src = String(source || 'unknown').slice(0, 32);
  return {
    source: src,
    kind,
    domain: cleanDomain(domain),
    summary: cleanSummary,
    attempted: cleanText(attempted, names),
    closest_tool: tool,
    fingerprint: fingerprintFor({ source: src, kind, summary: cleanSummary }),
  };
}

// Insert-or-bump. A recurrence counts, refreshes last_seen_at, reopens a
// `fixed` gap as `new` (building / by_design / dismissed stay), and fills in
// detail the first sighting lacked rather than discarding it.
// The sighting row (one per hit) is what windowed counts read.
async function upsertGapRow(row) {
  const now = new Date();
  return db.transaction(async (trx) => {
    const rows = await trx('agent_gap_reports')
      .insert({ ...row, occurrences: 1, status: 'new', first_seen_at: now, last_seen_at: now })
      .onConflict('fingerprint')
      .merge({
        occurrences: trx.raw('agent_gap_reports.occurrences + 1'),
        last_seen_at: now,
        status: trx.raw("CASE WHEN agent_gap_reports.status = 'fixed' THEN 'new' ELSE agent_gap_reports.status END"),
        domain: trx.raw('COALESCE(agent_gap_reports.domain, EXCLUDED.domain)'),
        closest_tool: trx.raw('COALESCE(agent_gap_reports.closest_tool, EXCLUDED.closest_tool)'),
        attempted: trx.raw('COALESCE(EXCLUDED.attempted, agent_gap_reports.attempted)'),
      })
      .returning(['id', 'occurrences', 'status']);
    const saved = rows && rows[0];
    if (!saved) return null;
    await trx('agent_gap_report_sightings').insert({ gap_id: saved.id, seen_at: now });
    // bigint ids come back from pg as strings; "gap #<id>" wants a number.
    return { id: Number(saved.id), occurrences: Number(saved.occurrences), status: saved.status };
  });
}

/**
 * Records each distinct signal once (deduped by fingerprint, so a search the
 * model retried in several rounds counts one occurrence for the request).
 * Returns the saved { id, occurrences, status } per written row. Never
 * throws; a failed write is logged with the error code only — the error text
 * can carry a compiled query with the summary in it.
 */
async function writeGapRows(signals, { names = [] } = {}) {
  if (!gapReportsEnabled()) return [];
  const seen = new Set();
  const saved = [];
  for (const signal of signals || []) {
    try {
      const row = prepareGapRow(signal, names);
      if (!row || seen.has(row.fingerprint)) continue;
      seen.add(row.fingerprint);
      const result = await upsertGapRow(row);
      if (result) saved.push(result);
    } catch (err) {
      logger.warn(`[agent-gap-reports] record failed (${err.code || err.name || 'error'})`);
    }
  }
  return saved;
}

/**
 * Gaps hit in the last `days` days, each with `seen_in_window` (sightings in
 * the window) beside its lifetime `occurrences`; most-seen-in-window first,
 * then most recent. Closed statuses are left out unless `includeClosed`.
 * The one reader behind list_gap_reports and the Monday digest.
 */
async function listRecentGaps({ days, includeClosed = false } = {}) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const counts = await db('agent_gap_report_sightings')
    .where('seen_at', '>=', cutoff)
    .groupBy('gap_id')
    .select('gap_id')
    .count('* as seen');
  if (!counts.length) return [];
  const seenById = new Map(counts.map((row) => [String(row.gap_id), Number(row.seen)]));
  const query = db('agent_gap_reports').whereIn('id', [...seenById.keys()]);
  if (!includeClosed) query.whereNotIn('status', CLOSED_STATUSES);
  const rows = await query;
  return rows
    .map((row) => ({ ...row, seen_in_window: seenById.get(String(row.id)) || 0 }))
    .sort((a, b) => (b.seen_in_window - a.seen_in_window)
      || (new Date(b.last_seen_at).getTime() - new Date(a.last_seen_at).getTime()));
}

/**
 * The owner's triage: move one gap to a GAP_STATUSES value. Run through
 * ops/agents/gap-status.js by a session (dry run first). Returns the updated
 * row, or null when no gap has that number; throws on an unknown status.
 */
async function setGapStatus(gapId, status) {
  if (!GAP_STATUSES.includes(status)) throw new Error(`status must be one of: ${GAP_STATUSES.join(', ')}`);
  const [row] = await db('agent_gap_reports').where('id', gapId).update({ status }).returning(['id', 'kind', 'status', 'occurrences']);
  return row || null;
}

// Customer names (and street addresses) the request resolved — the most
// likely identifying text in a model-written search description.
function namesFromTaskContext(taskContext) {
  const names = new Set();
  for (const target of [...(taskContext?.targets || []), ...(taskContext?.candidates || [])]) {
    const label = String(target?.label || '').trim();
    if (label) {
      names.add(label);
      for (const part of label.split(/\s+/)) names.add(part);
    }
    if (target?.address) names.add(String(target.address).trim());
  }
  return [...names];
}

// Customer and lead first/last names that appear in the texts, in any case —
// the case-independent guard for a name the request never resolved ("add
// josé at …"). Matched against the stored names, so a lowercase or
// unresolved name is still caught.
async function knownNamesIn(texts) {
  const tokens = [...new Set(texts.flatMap((text) => String(text || '').toLowerCase().match(NAME_TOKEN_RE) || []))].slice(0, 100);
  if (!tokens.length) return [];
  const byName = (table) => db(table)
    .whereRaw('lower(first_name) = ANY(?) OR lower(last_name) = ANY(?)', [tokens, tokens])
    .select('first_name', 'last_name');
  const rows = [...await byName('customers'), ...await byName('leads')];
  const found = new Set();
  for (const row of rows) {
    for (const part of [row.first_name, row.last_name]) {
      const lower = String(part || '').trim().toLowerCase();
      if (tokens.includes(lower)) found.add(lower);
    }
  }
  return [...found];
}

function searchAttempt(search) {
  if (!search.surfaced.size) return 'Searched the bar; no matching tool';
  return search.relatedToolRan
    ? 'Searched the bar; a related tool ran, but the reply still declined part of the request'
    : `Searched the bar; ${search.surfaced.size} related tool(s) found, none used successfully`;
}

/**
 * Per-request collector. The route reports what the server observed; flush()
 * decides, once the reply is known, what to record.
 *
 * The server cannot tell which part of a partly declined request failed —
 * a related tool succeeding (listing refunds) does not prove the searched
 * capability (issuing one) exists — so a declined request records every
 * search it made, each noting whether a related tool ran.
 */
function createGapCollector({ source, isRegisteredTool = () => false }) {
  const searches = []; // { query, domain, closestTool, surfaced:Set, relatedToolRan }
  const unknownTools = new Set();
  const refusedCases = new Map(); // registered tool -> its own unsupported-case message

  function discovery(input, result) {
    const status = result?.status;
    if (status !== 'capability_unimplemented' && status !== 'capabilities_found') return;
    const capabilities = Array.isArray(result.capabilities) ? result.capabilities : [];
    searches.push({
      query: input?.query,
      domain: input?.domain || capabilities[0]?.domain,
      closestTool: capabilities[0]?.id || null,
      surfaced: new Set(capabilities.map((capability) => capability.id)),
      relatedToolRan: false,
    });
  }

  function toolResult(name, result, failed) {
    if (name === DISCOVERY_TOOL_NAME) return;
    if (!failed) {
      for (const search of searches) if (search.surfaced.has(name)) search.relatedToolRan = true;
    } else if (result?.code === 'capability_unimplemented') {
      // The same code means two things: the registry has no such tool, or a
      // registered tool does not support this case (a commercial estimate
      // revision). Keep the tool's own description of the latter.
      if (isRegisteredTool(name)) refusedCases.set(name, result.error || 'This case is not supported');
      else unknownTools.add(name);
    }
  }

  function pendingSignals() {
    const signals = searches.map((search) => ({
      source, kind: 'missing_capability', summary: search.query, freeText: true, domain: search.domain,
      closestTool: search.closestTool, attempted: searchAttempt(search),
    }));
    for (const name of unknownTools) {
      signals.push({ source, kind: 'missing_capability', summary: `Asked for a tool the bar does not have: ${name}`, closestTool: name });
    }
    for (const [name, message] of refusedCases) {
      signals.push({ source, kind: 'missing_capability', summary: `${name}: ${message}`, closestTool: name,
        attempted: 'The tool exists but does not support this case' });
    }
    return signals;
  }

  async function flush({ reply, taskContext } = {}) {
    try {
      if (!gapReportsEnabled() || !DECLINE_RE.test(String(reply || ''))) return;
      const signals = pendingSignals();
      if (!signals.length) return;
      // A failed name lookup throws into the catch below: nothing is written
      // unscrubbed.
      const stored = await knownNamesIn(signals.map((signal) => signal.summary));
      await writeGapRows(signals, { names: [...namesFromTaskContext(taskContext), ...stored] });
    } catch (err) {
      logger.warn(`[agent-gap-reports] collector flush failed (${err.code || err.name || 'error'})`);
    }
  }

  return { discovery, toolResult, flush };
}

module.exports = {
  GAP_STATUSES,
  CLOSED_STATUSES,
  gapReportsEnabled,
  gapReportPromptLine,
  writeGapRows,
  listRecentGaps,
  setGapStatus,
  createGapCollector,
  _private: { prepareGapRow, scrubProperNouns, knownNamesIn, DECLINE_RE },
};

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
const MAX_TEXT = 300;
const TOOL_NAME_RE = /^[a-z0-9_]{1,64}$/;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Record numbers (invoice, property, account) left after redactText's
// phone pass. Four digits or more, so "2 times" and short counts survive.
const LONG_NUMBER_RE = /\b\d{4,}\b/g;
const KNOWN_DOMAINS = new Set(Object.values(policy).map((entry) => entry?.domain).filter(Boolean));
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

function cleanText(value, names) {
  if (!value) return null;
  // Strip UUIDs BEFORE redactText: its phone regex has no leading word
  // boundary and can otherwise eat into a UUID's digit runs first.
  const withoutIds = String(value).replace(UUID_RE, '[id]');
  // Contact patterns first, then the request's names: redactText replaces
  // names before emails, so a name inside an address would otherwise break
  // the email match and leave "[name]@domain" behind.
  const redacted = redactText(redactText(withoutIds), { names }).replace(LONG_NUMBER_RE, '[number]');
  const text = redacted.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
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
function prepareGapRow({ source, kind, summary, attempted, closestTool, domain } = {}, names = []) {
  if (!KINDS.has(kind)) return null;
  const cleanSummary = cleanText(summary, names);
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
async function upsertGapRow(row) {
  const now = new Date();
  const rows = await db('agent_gap_reports')
    .insert({ ...row, occurrences: 1, status: 'new', first_seen_at: now, last_seen_at: now })
    .onConflict('fingerprint')
    .merge({
      occurrences: db.raw('agent_gap_reports.occurrences + 1'),
      last_seen_at: now,
      status: db.raw("CASE WHEN agent_gap_reports.status = 'fixed' THEN 'new' ELSE agent_gap_reports.status END"),
      domain: db.raw('COALESCE(agent_gap_reports.domain, EXCLUDED.domain)'),
      closest_tool: db.raw('COALESCE(agent_gap_reports.closest_tool, EXCLUDED.closest_tool)'),
      attempted: db.raw('COALESCE(EXCLUDED.attempted, agent_gap_reports.attempted)'),
    })
    .returning(['id', 'occurrences', 'status']);
  const saved = rows && rows[0];
  // bigint ids come back from pg as strings; "gap #<id>" wants a number.
  return saved ? { id: Number(saved.id), occurrences: Number(saved.occurrences), status: saved.status } : null;
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
function createGapCollector({ source }) {
  const searches = []; // { query, domain, closestTool, surfaced:Set, relatedToolRan }
  const unknownTools = new Set();

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
      unknownTools.add(name);
    }
  }

  function pendingSignals() {
    const signals = searches.map((search) => ({
      source, kind: 'missing_capability', summary: search.query, domain: search.domain,
      closestTool: search.closestTool, attempted: searchAttempt(search),
    }));
    for (const name of unknownTools) {
      signals.push({ source, kind: 'missing_capability', summary: `Asked for a tool that does not exist: ${name}`, closestTool: name });
    }
    return signals;
  }

  async function flush({ reply, taskContext } = {}) {
    try {
      if (!gapReportsEnabled() || !DECLINE_RE.test(String(reply || ''))) return;
      const signals = pendingSignals();
      if (!signals.length) return;
      await writeGapRows(signals, { names: namesFromTaskContext(taskContext) });
    } catch (err) {
      logger.warn(`[agent-gap-reports] collector flush failed (${err.code || err.name || 'error'})`);
    }
  }

  return { discovery, toolResult, flush };
}

module.exports = {
  gapReportsEnabled,
  gapReportPromptLine,
  writeGapRows,
  createGapCollector,
  _private: { prepareGapRow, DECLINE_RE },
};

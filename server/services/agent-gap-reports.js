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
const { addETDaysAtWallClock } = require('../utils/datetime-et');
const policy = require('./intelligence-bar/action-policy.json');

// The table's CHECK also allows 'tool_failure' and 'blocked'; nothing
// produces them. Broken tools are already tracked per call in
// tool_health_events (the Tool Health dashboard).
const KINDS = new Set(['missing_capability']);
// The owner's triage lifecycle (migration CHECK). Closed statuses stay out of
// the default list; a recurrence reopens `fixed` (and rings the bell again).
const GAP_STATUSES = Object.freeze(['new', 'building', 'fixed', 'by_design', 'dismissed']);
const CLOSED_STATUSES = Object.freeze(['fixed', 'by_design', 'dismissed']);
const MAX_TEXT = 300;
const TOOL_NAME_RE = /^[a-z0-9_]{1,64}$/;
const KNOWN_DOMAINS = new Set(Object.values(policy).map((entry) => entry?.domain).filter(Boolean));
const DISCOVERY_TOOL_NAME = 'discover_capabilities';

// Same stopword list as the discovery ranker (action-registry.js
// DISCOVERY_STOPWORDS) — kept local so this module has no load-order
// dependency on the registry.
const STOPWORDS = new Set(('a an the i me my we our you your it this that these those do does did can could '
  + 'will would should please like want need to for from of on in with is are be have has and or what how '
  + 'get find show search list').split(' '));

// The reply told the operator THE BAR cannot do something — a refusal tied to
// its tools or to what it supports, not "I couldn't find any matching
// invoices" or "that time is not available" (a read that worked). Nothing
// is recorded without it: an exploratory search or a retried tool that
// ended in a real answer is not a gap.
const DECLINE_RE = new RegExp([
  String.raw`\bno tools?\b`,
  String.raw`\bdon['’]t have (?:a|an|any)\b[^.!?\n]{0,40}?\b(?:tools?|way|capability)\b`,
  String.raw`\b(?:isn['’]t|not|aren['’]t) (?:currently )?supported\b`,
  String.raw`\bno way to\b`,
  String.raw`\b(?:not|isn['’]t) something i can\b`,
  String.raw`\boutside (?:of )?what i can\b`,
  // "can't / couldn't / unable to …" only when the sentence ties it to the bar
  String.raw`\b(?:can(?:not|['’]t)|could(?: not|n['’]t)|unable to|not able to)\b[^.!?\n]{0,80}?\b(?:from here|(?:from|in|through|with) (?:the|this) bar|directly)\b`,
  String.raw`\b(?:isn['’]t|not) (?:available|possible) (?:from here|(?:from|in|through) (?:the|this) bar)\b`,
].join('|'), 'i');

// The tech-bar `ask` fallback has no search behind it, so it needs a refusal
// that names the bar itself: a field answer can say "not supported by the
// label" or "no way to treat that indoors" and still be a real answer.
const BAR_DECLINE_RE = new RegExp([
  String.raw`\bno tools?\b`,
  String.raw`\bdon['’]t have (?:a|an|any)\b[^.!?\n]{0,40}?\b(?:tools?|capability)\b`,
  String.raw`\b(?:not|isn['’]t) something i can\b`,
  String.raw`\boutside (?:of )?what i can\b`,
  String.raw`\b(?:can(?:not|['’]t)|could(?: not|n['’]t)|unable to|not able to)\b[^.!?\n]{0,80}?\b(?:from here|(?:from|in|through|with) (?:the|this) bar)\b`,
  String.raw`\b(?:isn['’]t|not) (?:available|possible) (?:from here|(?:from|in|through) (?:the|this) bar)\b`,
].join('|'), 'i');

// Kill switch (CLAUDE.md rule 14): AGENT_GAP_REPORTS=off stops the prompt
// line, the collector's writes and the admin bell. Read at call time, so a
// flip needs no redeploy. Default on.
function gapReportsEnabled() {
  return String(process.env.AGENT_GAP_REPORTS || '').trim().toLowerCase() !== 'off';
}

const PROMPT_LINE = '\nBefore you tell the operator that something they asked for cannot be done from the bar, '
  + 'call discover_capabilities with a short, general description of it.';

// Appended to the platform prompt; empty while the kill switch is off.
function gapReportPromptLine() {
  return gapReportsEnabled() ? PROMPT_LINE : '';
}

// Stored as written (owner 2026-09-28: no name or contact scrubbing in gap
// reports), trimmed to one line of MAX_TEXT characters.
function cleanText(value) {
  if (!value) return null;
  const text = String(value).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
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
// nothing recordable.
function prepareGapRow({ source, kind, summary, attempted, closestTool, domain } = {}) {
  if (!KINDS.has(kind)) return null;
  const cleanSummary = cleanText(summary);
  if (!cleanSummary) return null;
  const tool = cleanTool(closestTool);
  const src = String(source || 'unknown').slice(0, 32);
  return {
    source: src,
    kind,
    domain: cleanDomain(domain),
    summary: cleanSummary,
    attempted: cleanText(attempted),
    closest_tool: tool,
    fingerprint: fingerprintFor({ source: src, kind, summary: cleanSummary }),
  };
}

// A gap's `source` read as a short label for the admin bell title. An
// unrecognized source (the column is NOT NULL, so it should not happen) falls
// back to the raw value, or 'bar' if even that is empty.
const SOURCE_LABELS = {
  'intelligence-bar': 'bar',
  'tech-bar': 'tech bar',
  'texting-ai': 'texting assistant',
  'phone-agent': 'phone agent',
};

// Sources where a Claude window on the Mac picks the gap up on its own (the
// bar-side gaps carry a self-contained summary); the texting AI and phone
// agent gaps need the owner to start the build.
const AUTO_PICKUP_SOURCES = new Set(['intelligence-bar', 'tech-bar']);

const BELL_LINK = '/admin/agents';

/**
 * The admin bell for one ring event: two short actionable lines (owner
 * ruling 2026-09-28: bell body <= 110 chars). The title names the number,
 * the source and the area only — a gap's description is model-written or
 * customer-authored text and stays in the bar ("show gap reports").
 */
function gapBellText({ id, source, domain, reopened = false }) {
  const label = SOURCE_LABELS[source] || source || 'bar';
  const lead = reopened ? `Gap #${id} is back` : `Gap #${id}`;
  const title = `${lead}: ${label} (${domain || 'other'})`;
  const body = AUTO_PICKUP_SOURCES.has(source)
    ? 'A Claude window on the Mac starts building it within 10 min.'
    : `Say "build gap #${id}" in any Claude session to start a PR.`;
  return { title, body };
}

// Rings the admin bell for a newly recorded (or reopened) gap. Runs AFTER the
// row's transaction committed, never awaited by the caller, and never
// throws: a bell failure must not fail or slow the reply that surfaced the
// gap. The dedupe key is unique per ring event (first sighting, or the
// reopening sighting), so a reopen rings again but a replay of the same
// event does not double-ring.
async function ringGapBell(event) {
  try {
    if (!gapReportsEnabled()) return;
    const { title, body } = gapBellText(event);
    const NotificationService = require('./notification-service');
    await NotificationService.notifyAdmin('agents', title, body, {
      link: BELL_LINK,
      bell: true,
      dedupeKey: `agent-gap:${event.id}:${event.at.toISOString()}`,
      metadata: { gapId: event.id, source: event.source, reopened: Boolean(event.reopened) },
    });
  } catch (err) {
    logger.warn(`[agent-gap-reports] bell failed (${err.code || err.name || 'error'})`);
  }
}

// Insert-or-bump. A recurrence counts, refreshes last_seen_at, reopens a
// `fixed` gap as `new` (building / by_design / dismissed stay), and fills in
// detail the first sighting lacked rather than discarding it.
// The sighting row (one per hit) is what windowed counts read.
//
// `rang` reports whether this hit is a bell event: the first sighting, or a
// `fixed` gap coming back. A repeat of an already-open gap is quiet. Two
// signals decide it inside the one transaction: the existing row's status is
// read FOR UPDATE first (so a concurrent triage or recurrence cannot flip it
// between the read and the merge), and Postgres' `xmax = 0` on the returned
// row says the statement inserted instead of merging (which also settles
// two simultaneous first sightings: only the inserter rings). The bell itself
// fires after the commit, fire-and-forget.
async function upsertGapRow(row) {
  const now = new Date();
  const saved = await db.transaction(async (trx) => {
    const prior = await trx('agent_gap_reports')
      .where({ fingerprint: row.fingerprint })
      .forUpdate()
      .first('status');
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
      .returning(['id', 'occurrences', 'status', 'domain', 'xmax']);
    const result = rows && rows[0];
    if (!result) return null;
    await trx('agent_gap_report_sightings').insert({ gap_id: result.id, seen_at: now });
    const inserted = String(result.xmax) === '0';
    const reopened = !inserted && prior?.status === 'fixed';
    // bigint ids come back from pg as strings; "gap #<id>" wants a number.
    return {
      id: Number(result.id),
      occurrences: Number(result.occurrences),
      status: result.status,
      domain: result.domain || null,
      rang: inserted || reopened,
      reopened,
    };
  });
  if (saved?.rang) {
    // Deliberately not awaited: the caller's reply never waits on the bell.
    ringGapBell({ id: saved.id, source: row.source, domain: saved.domain, reopened: saved.reopened, at: now });
  }
  return saved;
}

/**
 * One-shot record for a source with no per-request collector to sample (the
 * texting AI and phone-agent hooks each observe exactly one signal per
 * event, not a discovery loop). Same table, same dedupe-by-fingerprint;
 * never throws.
 */
async function recordGap({ source, summary, attempted, closestTool } = {}) {
  return writeGapRows([{ source, kind: 'missing_capability', summary, attempted, closestTool }]);
}

/**
 * Records each distinct signal once (deduped by fingerprint, so a search the
 * model retried in several rounds counts one occurrence for the request).
 * Returns the saved { id, occurrences, status, domain, rang, reopened } per
 * written row. Never
 * throws; a failed write is logged with the error code only — the error text
 * can carry a compiled query with the summary in it.
 */
async function writeGapRows(signals) {
  if (!gapReportsEnabled()) return [];
  const seen = new Set();
  const saved = [];
  for (const signal of signals || []) {
    try {
      const row = prepareGapRow(signal);
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

// Same Eastern wall-clock time `days` calendar days back, so a window of
// whole days spans the same ET wall-clock time across a DST seam (e.g. 167 or
// 169 elapsed hours for a week, never a fixed 168).
function gapWindowCutoff(days, now = new Date()) {
  return addETDaysAtWallClock(now, -days);
}

/**
 * Gaps hit in the last `days` days, each with `seen_in_window` (sightings in
 * the window) beside its lifetime `occurrences`; most-seen-in-window first,
 * then most recent. Closed statuses are left out unless `includeClosed`.
 * The reader behind list_gap_reports.
 */
async function listRecentGaps({ days, includeClosed = false } = {}) {
  const cutoff = gapWindowCutoff(days);
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
  let toolBroke = false; // a genuine tool failure this request (Tool Health's, not a gap)

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
    } else {
      toolBroke = true;
    }
  }

  function pendingSignals() {
    const signals = searches.map((search) => ({
      source, kind: 'missing_capability', summary: search.query, domain: search.domain,
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

  // `ask` (the caller's own request text) is the tech-bar's fallback signal:
  // that context has no discover_capabilities search, so a decline with
  // nothing collected would otherwise vanish. Admin platform requests keep
  // their existing behaviour — they always searched first, so an empty
  // `signals` there already means nothing worth recording.
  async function flush({ reply, ask } = {}) {
    try {
      if (!gapReportsEnabled() || !DECLINE_RE.test(String(reply || ''))) return;
      const signals = pendingSignals();
      if (!signals.length) {
        // A decline after a tool broke is an outage talking, not a missing
        // feature — the failure is already in tool_health_events.
        if (toolBroke || !BAR_DECLINE_RE.test(String(reply || ''))) return;
        const asked = cleanText(ask);
        if (asked) await writeGapRows([{ source, kind: 'missing_capability', summary: asked,
          attempted: 'The bar declined; no capability search ran' }]);
        return;
      }
      await writeGapRows(signals);
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
  recordGap,
  listRecentGaps,
  setGapStatus,
  createGapCollector,
  _private: { prepareGapRow, gapWindowCutoff, gapBellText, ringGapBell, SOURCE_LABELS, DECLINE_RE, BAR_DECLINE_RE },
};

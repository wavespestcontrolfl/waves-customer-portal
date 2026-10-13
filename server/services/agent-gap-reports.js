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
const { isPolicyRefusal } = require('./intelligence-bar/outcomes');

// The table's CHECK allows 'missing_capability', 'tool_failure' and 'blocked'
// (no migration needed). 'blocked' is a request that ended on a tool's coded
// refusal or ran out of steps; broken tools stay out ('tool_failure' is not
// produced): those are tracked per call in tool_health_events (the Tool Health
// dashboard).
const KINDS = new Set(['missing_capability', 'blocked']);
const BLOCKED_KIND = 'blocked';
const LOOP_EXHAUSTED_CODE = 'tool_loop_exhausted';
const CODE_RE = /^[a-z][a-z0-9_]{1,47}$/;
// Refusal codes that become a gap row: the bar lacks a capability, could not
// establish who or what the ask is about, or must be sent to another workflow.
// Anything else with a code (not found, invalid input, a gate that is off) is
// a normal answer and records nothing, unless its text names another screen.
const RECORDED_REFUSAL_CODES = new Set([
  'capability_unimplemented', 'capability_not_loaded', 'dependency_unresolved',
  'target_clarification_required', 'customer_scope_required', 'requires_existing_owner_workflow',
]);
// By design: the bar working as intended. Never recorded, so they never become
// `new` build work for the gap launcher (it claims every `new` bar row).
const BY_DESIGN_REFUSAL_CODES = new Set([
  'permission_denied', 'approval_required', 'invalid_input', 'owner_direct_bulk_limit',
  'write_access_required', 'execution_interrupted', 'verify_failed',
]);
// A tool's own refusal that sends the operator to another screen. Only used to
// classify; the text itself is never stored (it can hold customer data).
const OTHER_SCREEN_RE = /\b(?:use|on|from|in|via|at) (?:the )?[\w' -]{0,40}?\b(?:screen|page|queue)\b/i;
const OTHER_SCREEN_CODE = 'other_screen';
const REFUSAL_NOTES = {
  capability_unimplemented: 'no tool supports this case',
  capability_not_loaded: 'the tool was used before it was discovered',
  dependency_unresolved: 'an earlier write had no recorded outcome',
  target_clarification_required: 'the target customer or record could not be established',
  customer_scope_required: 'the tool needs a customer scope the request did not give',
  requires_existing_owner_workflow: 'this belongs in an existing owner workflow',
  [OTHER_SCREEN_CODE]: 'the tool sends the operator to another screen',
  [LOOP_EXHAUSTED_CODE]: 'the tool loop ran out of steps',
};
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

const TOOL_SEARCH_PROMPT_LINE = '\nBefore you tell the operator that something they asked for cannot be done from the bar, '
  + 'search with the tool search tool using a short, general description of it. If that finds nothing, '
  + 'call discover_capabilities once with the same description.';

// Appended to the platform prompt; empty while the kill switch is off. A
// request on the API's tool search (GATE_IB_TOOL_SEARCH) names the tool search
// first and discover_capabilities as the fallback.
function gapReportPromptLine({ toolSearch = false } = {}) {
  if (!gapReportsEnabled()) return '';
  return toolSearch ? TOOL_SEARCH_PROMPT_LINE : PROMPT_LINE;
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
function fingerprintFor({ source, kind, summary, tool, code }) {
  // A blocked row is keyed on what stopped the request (tool + code), never on
  // prose, so the same refusal in different words stays one row.
  const key = kind === BLOCKED_KIND
    ? `${source}|${kind}|${tool || ''}|${code}`
    : `${source}|${kind}|${wordKeyOf(summary)}`;
  return crypto.createHash('sha256').update(key).digest('hex');
}

// Pure: a cleaned, fingerprinted row for one signal, or null if it carries
// nothing recordable. A `blocked` signal needs a refusal `code`; the code is
// part of its fingerprint and its summary, and is the only machine text kept.
function prepareGapRow({ source, kind, summary, attempted, closestTool, domain, code } = {}) {
  if (!KINDS.has(kind)) return null;
  const cleanSummary = cleanText(summary);
  if (!cleanSummary) return null;
  const blockedCode = kind === BLOCKED_KIND ? String(code || '') : '';
  if (kind === BLOCKED_KIND && !CODE_RE.test(blockedCode)) return null;
  const tool = cleanTool(closestTool);
  const src = String(source || 'unknown').slice(0, 32);
  return {
    source: src,
    kind,
    domain: cleanDomain(domain),
    summary: cleanSummary,
    attempted: cleanText(attempted),
    closest_tool: tool,
    fingerprint: fingerprintFor({ source: src, kind, summary: cleanSummary, tool: code === LOOP_EXHAUSTED_CODE ? '' : tool, code: blockedCode }),
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

// Writes the admin bell for a newly recorded (or reopened) gap INSIDE the
// gap row's transaction, in a savepoint: the bell row and the belled_at stamp
// commit together with the sighting, so a process exit (a deploy) can never
// leave a gap marked as rung with no bell. A bell that is not written
// (notifyAdmin throws inside the savepoint) rolls back only the savepoint —
// the sighting still commits, belled_at stays NULL, and the next sighting
// rings. Never throws. The dedupe key is unique per ring event (first
// sighting, or the reopening sighting), so a reopen rings again but a replay
// of the same event does not double-ring. Returns true when the bell landed.
async function ringGapBell(trx, event) {
  if (!gapReportsEnabled()) return false;
  try {
    await trx.transaction(async (sp) => {
      const { title, body } = gapBellText(event);
      const dedupeKey = `agent-gap:${event.id}:${event.at.toISOString()}`;
      const metadata = { gapId: event.id, source: event.source, reopened: Boolean(event.reopened) };
      // A gap a Claude window on the Mac picks up by itself is Claude's work, not
      // the owner's (owner 2026-10-01): an engineering row in the Agents Activity
      // feed, never the bell. The `FIX:` subject gives it the actionable kind
      // (an unprefixed subject reads as FYI: completed in Activity, dropped by
      // needs-me); the headline keeps the bell-style title. Only a row really
      // written in-app counts: with the feed off (GATE_OPS_DIGESTS_IN_APP /
      // GATE_AGENT_ACTIVITY) deliverOpsDigest takes its email path, writes
      // nothing, and the gap falls back to the bell below. A gap that waits for
      // the owner's "build gap N" (texting AI, phone agent) is always a bell.
      let result = null;
      if (AUTO_PICKUP_SOURCES.has(event.source)) {
        const digest = await require('./ops-digest').deliverOpsDigest({
          key: 'agent-gap', subject: `FIX: ${title}`, headline: title, summary: body, text: body,
          audience: 'engineering', link: BELL_LINK, dedupeKey, metadata, trx: sp,
          sendEmail: async () => ({ ok: true }),
        });
        if (digest?.channel === 'in_app' && !digest.fallback) result = digest;
      }
      if (!result) {
        result = await require('./notification-service').notifyAdmin('agents', title, body, {
          link: BELL_LINK,
          bell: true,
          trx: sp,
          dedupeKey,
          metadata,
        });
      }
      if (!result || result.ok === false || result.fallback) throw Object.assign(new Error('bell not written'), { code: 'NOT_WRITTEN' });
      await sp('agent_gap_reports').where('id', event.id).update({ belled_at: event.at });
    });
    return true;
  } catch (err) {
    logger.warn(`[agent-gap-reports] bell failed (${err.code || err.name || 'error'})`);
    return false;
  }
}

// Insert-or-bump. A recurrence counts, refreshes last_seen_at, reopens a
// `fixed` gap as `new` (building / by_design / dismissed stay), and fills in
// detail the first sighting lacked rather than discarding it.
// The sighting row (one per hit) is what windowed counts read.
//
// `rang` reports whether this hit is a bell event: the first sighting, or a
// `fixed` gap coming back, or an open (new / building) gap that has never
// rung (`belled_at` NULL: recorded before the per-gap bell existed, so its
// next sighting rings once). Any other repeat is quiet, and by_design /
// dismissed never ring. Two signals decide it inside the one transaction: the
// existing row's status and belled_at are read FOR UPDATE first (so a
// concurrent triage or recurrence cannot flip them between the read and the
// merge), and Postgres' `xmax = 0` on the returned row says the statement
// inserted instead of merging (which also settles two simultaneous first
// sightings: only the inserter rings). The bell row and the belled_at stamp
// are written in a savepoint of the same transaction (ringGapBell), so they
// commit with the sighting or not at all.
async function upsertGapRow(row, database = db) {
  const now = new Date();
  return database.transaction(async (trx) => {
    const prior = await trx('agent_gap_reports')
      .where({ fingerprint: row.fingerprint })
      .forUpdate()
      .first('status', 'belled_at');
    const rows = await trx('agent_gap_reports')
      .insert({ ...row, occurrences: 1, status: 'new', first_seen_at: now, last_seen_at: now })
      .onConflict('fingerprint')
      .merge({
        occurrences: trx.raw('agent_gap_reports.occurrences + 1'),
        last_seen_at: now,
        status: trx.raw("CASE WHEN agent_gap_reports.status = 'fixed' THEN 'new' ELSE agent_gap_reports.status END"),
        // A reopen clears the old ring: the reopen's own bell re-stamps it in
        // the savepoint, and if that bell is not written the gap stays
        // unrung, so its next sighting retries.
        belled_at: trx.raw("CASE WHEN agent_gap_reports.status = 'fixed' THEN NULL ELSE agent_gap_reports.belled_at END"),
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
    const neverRang = !inserted && !reopened && !prior?.belled_at
      && (prior?.status === 'new' || prior?.status === 'building');
    const rang = inserted || reopened || neverRang;
    const id = Number(result.id);
    const belled = rang
      ? await ringGapBell(trx, { id, source: row.source, domain: result.domain || null, reopened, at: now })
      : false;
    // bigint ids come back from pg as strings; "gap #<id>" wants a number.
    return {
      id,
      occurrences: Number(result.occurrences),
      status: result.status,
      domain: result.domain || null,
      rang: belled,
      reopened,
    };
  });
}

/**
 * One-shot record for a source with no per-request collector to sample (the
 * texting AI and phone-agent hooks each observe exactly one signal per
 * event, not a discovery loop). Same table, same dedupe-by-fingerprint;
 * never throws.
 */
async function recordGap({ source, summary, attempted, closestTool } = {}, database = db) {
  return writeGapRows([{ source, kind: 'missing_capability', summary, attempted, closestTool }], database);
}

/**
 * Records each distinct signal once (deduped by fingerprint, so a search the
 * model retried in several rounds counts one occurrence for the request).
 * Returns the saved { id, occurrences, status, domain, rang, reopened } per
 * written row. Never
 * throws; a failed write is logged with the error code only — the error text
 * can carry a compiled query with the summary in it.
 */
async function writeGapRows(signals, database = db) {
  if (!gapReportsEnabled()) return [];
  const seen = new Set();
  const saved = [];
  for (const signal of signals || []) {
    try {
      const row = prepareGapRow(signal);
      if (!row || seen.has(row.fingerprint)) continue;
      seen.add(row.fingerprint);
      const result = await upsertGapRow(row, database);
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

// The refusal code worth a gap row for one failed tool result, or null: a
// by-design code, an unknown business code, a fault and a plain error record
// nothing. Reads only; the result's text is classified and never kept.
function recordableRefusalCode(result) {
  // Only a policy refusal (the shared predicate: a coded refusal or a
  // refused/refusal marker). An uncoded failure is a fault, whatever its text
  // says, and is never a gap.
  if (!isPolicyRefusal(result)) return null;
  const code = typeof result.code === 'string' ? result.code.trim() : '';
  if (BY_DESIGN_REFUSAL_CODES.has(code)) return null;
  if (RECORDED_REFUSAL_CODES.has(code)) return code;
  const text = [result.error, result.refused].filter((value) => typeof value === 'string').join(' ');
  if (!OTHER_SCREEN_RE.test(text)) return null;
  return CODE_RE.test(code) ? code : OTHER_SCREEN_CODE;
}

// Fixed text only: the tool name and code, never the tool's input or message.
function blockedSignal({ source, tool, code, lastTool }) {
  const note = REFUSAL_NOTES[code] || 'the tool declined this case';
  const exhausted = code === LOOP_EXHAUSTED_CODE;
  return {
    source,
    kind: BLOCKED_KIND,
    code,
    closestTool: exhausted ? lastTool : tool,
    domain: exhausted ? null : policy[tool]?.domain,
    summary: exhausted
      ? 'The bar used all its steps and could not finish the request'
      : `The request ended on a refusal from ${tool} (${code}): ${note}`,
    attempted: exhausted
      ? `Tool loop exhausted${lastTool ? `; last tool ${lastTool}` : ''}. No request text is kept`
      : `Refusal code ${code} from ${tool}. No request text is kept`,
  };
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
function createGapCollector({ source, isRegisteredTool = () => false, recordBlocked = source === 'intelligence-bar' }) {
  const searches = []; // { query, domain, closestTool, surfaced:Set, relatedToolRan }
  // The tool round the request ended on: its coded refusals and the tools that
  // proposed or committed a write in it.
  // Earlier rounds are forgotten, so a refusal the model recovered from is
  // never a gap.
  let tail = { round: null, refusals: new Map(), wroteTools: new Set() };
  let lastTool = null;
  const unknownTools = new Set();
  const refusedCases = new Map(); // registered tool -> its own unsupported-case message
  let toolBroke = false; // a genuine tool failure this request (Tool Health's, not a gap)

  // `fromToolSearch` marks a search the API's tool search ran (GATE_IB_TOOL_SEARCH).
  // The prompt sends the model on to discover_capabilities when that search finds
  // nothing, so one missing capability would otherwise be recorded twice, under
  // two different query wordings. When any discover_capabilities search ran, the
  // tool-search ones are left out of the record.
  function discovery(input, result, { fromToolSearch = false } = {}) {
    const status = result?.status;
    if (status !== 'capability_unimplemented' && status !== 'capabilities_found') return;
    const capabilities = Array.isArray(result.capabilities) ? result.capabilities : [];
    searches.push({
      fromToolSearch,
      query: input?.query,
      domain: input?.domain || capabilities[0]?.domain,
      closestTool: capabilities[0]?.id || null,
      surfaced: new Set(capabilities.map((capability) => capability.id)),
      relatedToolRan: false,
    });
  }

  function trackTail(name, result, failed, meta = {}) {
    lastTool = cleanTool(name) || lastTool;
    if (meta.round !== tail.round) tail = { round: meta.round, refusals: new Map(), wroteTools: new Set() };
    if (meta.wrote === true) tail.wroteTools.add(name);
    const code = failed ? recordableRefusalCode(result) : null;
    if (code) tail.refusals.set(`${name}|${code}`, { tool: name, code });
  }

  function toolResult(name, result, failed, meta) {
    // A capability search is a tool round too: the model moving on to it
    // after a refusal means the refusal was not where the request ended.
    if (recordBlocked) trackTail(name, result, failed, meta);
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

  // The one classification of a server-observed capability_unimplemented
  // refusal: a missing_capability row from the tool name (and the tool's own
  // case message), never from the reply's wording.
  function capabilitySignal(name) {
    if (refusedCases.has(name)) {
      return { source, kind: 'missing_capability', summary: `${name}: ${refusedCases.get(name)}`, closestTool: name,
        attempted: 'The tool exists but does not support this case' };
    }
    return { source, kind: 'missing_capability', summary: `Asked for a tool the bar does not have: ${name}`, closestTool: name };
  }

  function pendingSignals() {
    const discovered = searches.filter((search) => !search.fromToolSearch);
    const signals = (discovered.length ? discovered : searches).map((search) => ({
      source, kind: 'missing_capability', summary: search.query, domain: search.domain,
      closestTool: search.closestTool, attempted: searchAttempt(search),
    }));
    for (const name of [...unknownTools, ...refusedCases.keys()]) signals.push(capabilitySignal(name));
    return signals;
  }

  // Signals for a request that stopped without doing what was asked, whatever
  // the reply said.
  //  - Out of steps AND no final answer (the model still wanted a tool in the
  //    tool-less round): one tool_loop_exhausted row, replacing any other.
  //    With a final answer the request finished, even on its last step.
  //  - Otherwise each recordable refusal in the last tool round whose own tool
  //    did not write in that round (an unrelated refusal in a parallel round is
  //    kept): a blocked row on tool + code. A capability_unimplemented refusal
  //    is always the missing_capability row instead (capabilitySignal), so the
  //    reply's wording never changes its kind or fingerprint.
  function blockedSignals({ stepLimitReached, noReply }) {
    if (!recordBlocked) return [];
    if (stepLimitReached === true && noReply === true) return [blockedSignal({ source, code: LOOP_EXHAUSTED_CODE, lastTool })];
    const signals = [];
    for (const { tool, code } of tail.refusals.values()) {
      if (tail.wroteTools.has(tool)) continue;
      signals.push(code === 'capability_unimplemented' ? capabilitySignal(tool) : blockedSignal({ source, tool, code }));
    }
    return signals;
  }

  // `ask` (the caller's own request text) is the tech-bar's fallback signal:
  // that context has no discover_capabilities search, so a decline with
  // nothing collected would otherwise vanish. Admin platform requests keep
  // their existing behaviour — they always searched first, so an empty
  // `signals` there already means nothing worth recording.
  function declinedSignals({ reply, ask }) {
    const signals = pendingSignals();
    if (signals.length) return signals;
    // A decline after a tool broke is an outage talking, not a missing
    // feature — the failure is already in tool_health_events.
    if (toolBroke || !BAR_DECLINE_RE.test(String(reply || ''))) return [];
    const asked = cleanText(ask);
    return asked ? [{ source, kind: 'missing_capability', summary: asked,
      attempted: 'The bar declined; no capability search ran' }] : [];
  }

  async function flush({ reply, ask, stepLimitReached, noReply } = {}) {
    try {
      if (!gapReportsEnabled()) return;
      const declined = DECLINE_RE.test(String(reply || ''));
      const blocked = blockedSignals({ stepLimitReached, noReply });
      // Out of steps is ONE record: when the exhaustion row is written, a prose
      // decline in the same reply would add a second row with its own
      // fingerprint. The tech bar writes no exhaustion row, so its prose
      // record stays (pre-push P1s).
      const exhaustionRecorded = blocked.some((signal) => signal.code === LOOP_EXHAUSTED_CODE);
      const signals = [...blocked, ...(declined && !exhaustionRecorded ? declinedSignals({ reply, ask }) : [])];
      if (signals.length) await writeGapRows(signals);
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
  _private: { prepareGapRow, recordableRefusalCode, RECORDED_REFUSAL_CODES, BY_DESIGN_REFUSAL_CODES, gapWindowCutoff, gapBellText, ringGapBell, SOURCE_LABELS, DECLINE_RE, BAR_DECLINE_RE },
};

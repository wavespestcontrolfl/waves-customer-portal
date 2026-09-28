'use strict';

/**
 * Intelligence Bar gap reports — recorder + per-request collector.
 *
 * Prod data shows the bar tells the operator "I can't / no tool for that"
 * in roughly half its replies, and about half of those are a real missing
 * feature or bug. Nothing captured them, and the query log is redacted
 * whenever customer data is touched (most of the time). This module writes
 * a structured, PII-scrubbed record the moment the bar hits one — either
 * because the model called `report_gap` itself, or because the collector
 * below noticed a discovery miss or a repeatedly-failing tool the model
 * never reported.
 *
 * `recordGapReport()` is the only write path (server/models/migrations/
 * 20260928160000_agent_gap_reports.js) and NEVER throws — a broken gap
 * report must never break the request that surfaced it.
 */
const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { redactText } = require('./agent-decision-training');
const policy = require('./intelligence-bar/action-policy.json');

const KINDS = new Set(['missing_capability', 'tool_failure', 'blocked']);
const MAX_TEXT = 300;
const TOOL_NAME_RE = /^[a-z0-9_]{1,64}$/;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const KNOWN_DOMAINS = new Set(Object.values(policy).map((entry) => entry?.domain).filter(Boolean));

// Same stopword list as the discovery ranker (action-registry.js
// DISCOVERY_STOPWORDS) — kept local so this module has no load-order
// dependency on the registry.
const STOPWORDS = new Set(('a an the i me my we our you your it this that these those do does did can could '
  + 'will would should please like want need to for from of on in with is are be have has and or what how '
  + 'get find show search list').split(' '));

function cleanText(value) {
  if (!value) return null;
  // Strip UUIDs BEFORE redactText: its phone regex has no leading word
  // boundary and can otherwise eat into a UUID's digit runs before the
  // dedicated UUID pass ever sees a clean 8-4-4-4-12 shape to match.
  const withoutIds = String(value).replace(UUID_RE, '[id]');
  const redacted = redactText(withoutIds);
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

function fingerprintFor({ source, kind, closestTool, summary }) {
  const key = `${source}|${kind}|${closestTool || ''}|${wordKeyOf(summary)}`;
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Insert-or-bump a gap report. Returns { id, occurrences, status } or null
 * (rejected input, or a DB failure — logged with the error code only, never
 * the error text, which can carry a compiled query with model-supplied
 * strings). A recurrence on a row the owner already marked `fixed` reopens
 * it as `new`; `building` / `by_design` / `dismissed` are left alone.
 */
async function recordGapReport({ source, kind, summary, attempted, closestTool, domain } = {}) {
  try {
    if (!KINDS.has(kind)) return null;
    const cleanSummary = cleanText(summary);
    if (!cleanSummary) return null;
    const tool = cleanTool(closestTool);
    const now = new Date();
    const fingerprint = fingerprintFor({ source, kind, closestTool: tool, summary: cleanSummary });
    const rows = await db('agent_gap_reports')
      .insert({
        source: String(source || 'unknown').slice(0, 32),
        kind,
        domain: cleanDomain(domain),
        summary: cleanSummary,
        attempted: cleanText(attempted),
        closest_tool: tool,
        fingerprint,
        occurrences: 1,
        status: 'new',
        first_seen_at: now,
        last_seen_at: now,
      })
      .onConflict('fingerprint')
      .merge({
        occurrences: db.raw('agent_gap_reports.occurrences + 1'),
        last_seen_at: now,
        status: db.raw("CASE WHEN agent_gap_reports.status = 'fixed' THEN 'new' ELSE agent_gap_reports.status END"),
      })
      .returning(['id', 'occurrences', 'status']);
    const row = rows && rows[0];
    // bigint columns come back from pg as strings; coerce for a caller that
    // renders "gap #<id>" or compares occurrences numerically.
    return row ? { id: Number(row.id), occurrences: Number(row.occurrences), status: row.status } : null;
  } catch (err) {
    logger.warn(`[agent-gap-reports] record failed (${err.code || err.name || 'error'})`);
    return null;
  }
}

const IGNORED_TOOL_NAMES = new Set(['discover_capabilities', 'report_gap']);
// A tool that failed only because it was never discover_capabilities-loaded
// yet is a routing artifact of the loop, not a real capability gap.
const IGNORED_FAILURE_CODE = 'capability_not_loaded';
const TOOL_FAILURE_THRESHOLD = 2;

/**
 * Per-request signal collector. Queues candidate gaps while the tool loop
 * runs and writes them once, at flush(), so a discovery that later succeeds
 * or a gap the model already reported itself never also produces a noisier
 * automatic duplicate.
 */
function createGapCollector({ source }) {
  let discoverySignals = [];
  const toolFailures = new Map(); // toolName -> { count, lastCode }
  const reportedTools = new Set();
  let anyReported = false;

  function discovery(input, result) {
    if (result?.status === 'capability_unimplemented') {
      discoverySignals.push({
        kind: 'missing_capability',
        summary: input?.query,
        attempted: 'Searched the bar for a matching tool; none found',
        domain: input?.domain,
      });
    } else if (result?.status === 'capabilities_found') {
      // The model recovered — whatever it does next, this was not a gap.
      discoverySignals = [];
    }
  }

  function toolResult(name, result, failed) {
    if (IGNORED_TOOL_NAMES.has(name)) return;
    if (result?.code === 'capability_unimplemented') {
      discoverySignals.push({
        kind: 'missing_capability',
        summary: `Asked for a tool that does not exist: ${name}`,
        closestTool: name,
      });
      return;
    }
    if (failed && result?.code !== IGNORED_FAILURE_CODE) {
      const entry = toolFailures.get(name) || { count: 0, lastCode: null };
      entry.count += 1;
      if (result?.code) entry.lastCode = result.code;
      toolFailures.set(name, entry);
    }
  }

  function reported(input) {
    anyReported = true;
    if (input?.tool) reportedTools.add(String(input.tool));
  }

  async function flush() {
    try {
      const signals = [];
      // The model already told us about this request's gap(s) — an automatic
      // discovery signal alongside it would just be noisy duplication.
      if (!anyReported) {
        for (const signal of discoverySignals) signals.push(signal);
      }
      for (const [tool, entry] of toolFailures) {
        if (entry.count < TOOL_FAILURE_THRESHOLD || reportedTools.has(tool)) continue;
        signals.push({
          kind: 'tool_failure',
          summary: `${tool} failed ${entry.count} times in one request${entry.lastCode ? ` (${entry.lastCode})` : ''}`,
          closestTool: tool,
        });
      }
      for (const signal of signals) {
        await recordGapReport({ source, ...signal });
      }
    } catch (err) {
      // recordGapReport itself never throws, but this guards the loop above too.
      logger.warn(`[agent-gap-reports] collector flush failed (${err.code || err.name || 'error'})`);
    }
  }

  return { discovery, toolResult, reported, flush };
}

module.exports = { recordGapReport, createGapCollector };

/**
 * Intelligence Bar — Visit Closeout Tools (read-only)
 *
 * Thin IB surface over the canonical closeout-status service (#3647):
 * getCloseoutStatus(serviceId) → ten separate facts (completion,
 * application, photos, report, reportDelivery, invoice, invoiceDelivery,
 * comms, followUp, license), each not_required | pending | done | failed |
 * unknown with reason + evidence, plus contradictions[] and unavailable[].
 *
 * READ-ONLY: no writes, no comms, no Stripe — deliberately NOT registered in
 * write-gates.js. Admin-only by the standing role gate (non-admin tokens
 * pass only TECH_TOOL_NAMES). Results carry ids, states, and reasons — no
 * customer names/phones/addresses, and error text is scrubbed by the
 * service before it gets here.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { getCloseoutStatus, FACT_NAMES } = require('../closeout-status');
const { etDateString, validCalendarDate } = require('../../utils/datetime-et');

// Each closeout load is ~20 indexed probes — bound the day-sweep fan-out
// (same bound the command center uses).
const CLOSEOUT_CONCURRENCY = 4;
const DAY_SWEEP_VISIT_CAP = 50;

const CLOSEOUT_TOOLS = [
  {
    name: 'get_closeout_status',
    description: `Full closeout status for ONE visit (scheduled_services id): ten separate facts — completion, application log, photos, report, report delivery, invoice, invoice delivery, customer comms, follow-up, technician license — each not_required | pending | done | failed | unknown with the reason and evidence, plus contradictions (e.g. an invoice on a dues-covered or non-performed visit) and any lookups that were unavailable. 'unknown' means a lookup outage, NEVER a confirmed gap — say so rather than reporting something as missing.
Use for: "check the closeout for the visit we just finished", "did the report go out for this job?", "why isn't this visit closed out?"`,
    input_schema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', format: 'uuid', description: 'scheduled_services.id of the visit' },
      },
      required: ['service_id'],
    },
  },
  {
    name: 'list_open_closeouts',
    description: `Sweep every COMPLETED visit on a date (default: today ET) through the closeout service and return only the ones that are not fully closed out — with which facts are open (pending/failed), which are unknown (lookup outages, not gaps), and any contradictions. Checks at most ${DAY_SWEEP_VISIT_CAP} visits.
Use for: "show me every service today where something is missing", "which of yesterday's jobs still owe a report or invoice?"`,
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Service date YYYY-MM-DD (ET). Defaults to today.' },
      },
    },
  },
];

function compactFacts(status) {
  const out = {};
  for (const name of FACT_NAMES) {
    const f = status.facts?.[name];
    if (!f) continue;
    out[name] = { state: f.state, reason: f.reason };
  }
  return out;
}

async function getCloseoutStatusTool(input) {
  const serviceId = String(input?.service_id || '').trim();
  if (!serviceId) return { error: 'service_id is required' };
  const status = await getCloseoutStatus(serviceId);
  if (!status.found) {
    return status.lookupFailed
      ? { error: 'scheduled_services lookup unavailable — status unknown, not missing', serviceId }
      : { error: 'No visit with that id', serviceId };
  }
  return status;
}

async function listOpenCloseouts(input) {
  const raw = String(input?.date || '').trim();
  // Absent → today ET. Supplied → must be a REAL calendar date; an impossible
  // or malformed value is an error, never an empty all-clear.
  const date = raw ? validCalendarDate(raw) : etDateString();
  if (!date) return { error: `Invalid date '${raw.slice(0, 20)}' — use YYYY-MM-DD`, date: raw.slice(0, 20) };
  let visits = [];
  try {
    visits = await db('scheduled_services')
      .where({ scheduled_date: date, status: 'completed' })
      .orderBy('window_start', 'asc')
      .limit(DAY_SWEEP_VISIT_CAP)
      .select('id', 'service_type', 'customer_id', 'window_start');
  } catch (err) {
    return { error: `scheduled_services lookup unavailable: ${err.message}`, date };
  }
  const results = [];
  for (let i = 0; i < visits.length; i += CLOSEOUT_CONCURRENCY) {
    const slice = visits.slice(i, i + CLOSEOUT_CONCURRENCY);
    const loaded = await Promise.all(slice.map((v) => getCloseoutStatus(v.id).catch(() => null)));
    slice.forEach((v, j) => results.push({ visit: v, status: loaded[j] }));
  }
  const open = [];
  let closedOut = 0;
  let unavailableCount = 0;
  for (const { visit, status } of results) {
    if (!status || !status.found) { unavailableCount += 1; continue; }
    if (status.summary?.closedOut) { closedOut += 1; continue; }
    open.push({
      serviceId: visit.id,
      serviceType: visit.service_type || null,
      customerId: visit.customer_id || null,
      windowStart: visit.window_start || null,
      open: status.summary?.open || [],
      failed: status.summary?.failed || [],
      unknown: status.summary?.unknown || [],
      contradictions: status.summary?.contradictions || [],
      unevaluated: status.summary?.unevaluated || [],
      facts: compactFacts(status),
    });
  }
  return {
    date,
    completedVisitsChecked: results.length,
    cap: DAY_SWEEP_VISIT_CAP,
    closedOut,
    openCloseouts: open,
    statusUnavailable: unavailableCount,
    note: 'unknown = a lookup outage, not a confirmed gap; contradictions block closedOut',
  };
}

async function executeCloseoutTool(toolName, input) {
  try {
    switch (toolName) {
      case 'get_closeout_status': return await getCloseoutStatusTool(input);
      case 'list_open_closeouts': return await listOpenCloseouts(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:closeout] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { CLOSEOUT_TOOLS, executeCloseoutTool };

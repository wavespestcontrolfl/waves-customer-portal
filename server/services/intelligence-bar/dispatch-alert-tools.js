/**
 * Intelligence Bar — resolve one Dispatch Action Queue card
 * server/services/intelligence-bar/dispatch-alert-tools.js
 *
 * Owner ask 2026-10-28 (IB gap #4: "resolve a dispatch alert from the bar"): a card that replays the Dispatch
 * board's own single-card Resolve.
 *
 *   resolve_dispatch_alert — the Action Queue card's Resolve button (PATCH /admin/dispatch/alerts/:id/resolve),
 *                            run through services/dispatch-alerts.js resolveAlertAsDispatcher: the SAME function
 *                            the route calls, so every rule and refusal is the board's own.
 *
 * What the Resolve writes (read end to end, dispatch-alerts.js resolveAlert): the card's resolved_at and
 * resolved_by (the row is kept for history); for a no-show-detector tracking card, the admin bell linked to it
 * is closed (clearTrackingBells) and the detector's own dedupe reads a person's Resolve as an answer, so the same
 * tracking alert is not raised again; after commit, dispatch:alert_resolved goes to the dispatch:admins room so every
 * open board drops the card. It sends NO text, email or call and changes no visit, route or technician.
 * A decision-only card (a visit not closed out) is settled by its own decision routes and is refused here too.
 *
 * ONE card per ask. The board's "Clear all" (POST /alerts/resolve-all) stays on the board: the bar resolves one
 * alert at a time.
 *
 * Always a confirm card (write-gates.js two-step), admin only (the route is requireAdmin), never owner-direct,
 * platform path only, dark behind GATE_IB_RESOLVE_DISPATCH_ALERT (which needs GATE_IB_PLATFORM).
 *
 *   unconfirmed -> a PREVIEW: nothing is written. Its `_version` pins what the card showed (the alert id, type,
 *                  severity, text, payload, raised time, still unresolved, and the visit, customer and technician
 *                  it names). The model never supplies a pin.
 *   confirmed   -> re-derives the preview, then re-reads the alert FOR UPDATE inside the write's transaction and
 *                  refuses with preview_changed if it was resolved, changed or is gone. Nothing is written then.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');

function resolveDispatchAlertLive() {
  return require('../../config/feature-gates').ibResolveDispatchAlertLive() === true;
}

const DISPATCH_ALERT_TOOLS = [
  {
    name: 'resolve_dispatch_alert',
    description: `Resolve ONE open card in the Dispatch board's Action Queue (late technician, unassigned job, missed photo, a tracking alert, and so on): the card's Resolve button. The first call returns a PREVIEW and writes nothing: the alert's type and text, when it was raised, the visit, customer and technician it names, and exactly what resolving does. The operator approves on the confirmation card; the confirmed run re-checks the alert and refuses if it changed or was already resolved.
Effects: the card is marked resolved by the operator and kept in the alert history; every open Dispatch board drops it at once; a tracking alert also closes its linked admin bell and is not raised again for the same visit and promised time. Nothing is sent to the customer or the technician, and the visit, route and technician do not change. The board has no way to reopen a resolved card.
ONE alert at a time. Clearing the whole queue ("clear all", "resolve everything", "resolve all alerts") is NOT available in the bar: tell the operator the bar resolves one alert at a time and to use the Clear all button on the Dispatch board. A card that needs a decision ("Visit not closed out": "This was a miss" or "Not a miss") is refused: those are decided on the board.
Give alert_id (the card's id), or job_id (the visit) when that visit has exactly one open alert. With neither, or when a visit has several open alerts, the reply lists the open cards (type, raised time, id) so you can ask which one. Admin only.
Use for: "resolve the late alert for the Smith visit", "dismiss that dispatch alert", "clear the missed photo alert on this job", "close this action queue card", "mark that dispatch alert resolved".`,
    input_schema: {
      type: 'object',
      properties: {
        alert_id: { type: 'string', format: 'uuid', description: 'The Action Queue card id (from the reply that lists the open cards)' },
        job_id: { type: 'string', format: 'uuid', description: 'The visit (scheduled service) id, used instead of alert_id when the visit has exactly one open alert' },
      },
    },
    _sideEffects: true,
  },
];

const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 32);
const CANDIDATE_LIMIT = 10;
const MESSAGE_CHARS = 300;

const typeLabel = (type) => {
  const words = String(type || 'alert').replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Alert';
};

const fullName = (c) => [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.company_name || null;

const clip = (text, max) => {
  const plain = String(text).replace(/\s+/g, ' ').trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
};

// The text the board shows is type-specific (AlertCard.jsx); payloads that carry a plain `message` show it, the
// rest show the type, with the delay when the payload has one.
function alertMessage(row) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  if (typeof payload.message === 'string' && payload.message.trim()) return clip(payload.message, MESSAGE_CHARS);
  const delay = Number(payload.delay_minutes);
  return Number.isFinite(delay) && delay > 0
    ? `${typeLabel(row.type)}: ${delay} min`
    : `${typeLabel(row.type)} (this card carries no more text)`;
}

function raisedAtEt(value) {
  const at = value ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  const { formatETDate, formatETTime } = require('../../utils/datetime-et');
  return `${formatETDate(at)}, ${formatETTime(at)} ET`;
}

const ALERT_COLUMNS = ['id', 'type', 'severity', 'tech_id', 'job_id', 'payload', 'created_at', 'resolved_at', 'resolved_by'];

// The open cards, newest first, for the "which one?" reply. Names are first name and last initial, like the board.
async function openCandidates(database, jobId = null) {
  const q = database('dispatch_alerts as a')
    .leftJoin('scheduled_services as s', 'a.job_id', 's.id')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .whereNull('a.resolved_at')
    .orderBy('a.created_at', 'desc')
    .limit(CANDIDATE_LIMIT)
    .select('a.id', 'a.type', 'a.severity', 'a.created_at', 'c.first_name', 'c.last_name');
  if (jobId) q.where('a.job_id', jobId);
  const rows = await q;
  return rows.map((r) => ({
    alert_id: r.id,
    type: r.type,
    severity: r.severity,
    raised_at: raisedAtEt(r.created_at),
    customer: r.first_name ? `${r.first_name}${r.last_name ? ` ${String(r.last_name).charAt(0).toUpperCase()}.` : ''}` : null,
  }));
}

// The one alert the call names. Under `lock` the alert row is held FOR UPDATE (read on its own, so the join to the
// visit never has to lock a nullable side).
async function loadAlert(input, { database, lock }) {
  const rawId = String(input?.alert_id || '').trim().toLowerCase();
  const rawJob = String(input?.job_id || '').trim().toLowerCase();
  if (rawId && rawJob) return refusal('Give alert_id or job_id, not both', 'invalid_target');
  if (!rawId && !rawJob) {
    const candidates = await openCandidates(database);
    return refusal(candidates.length
      ? 'Which Action Queue card? The bar resolves one alert at a time. Ask the operator which one, then pass its alert_id.'
      : 'There is no open card in the Action Queue.', candidates.length ? 'alert_required' : 'alert_not_found', { candidates });
  }
  if (rawId) {
    if (!UUID_RE.test(rawId)) return refusal('A valid alert_id is required', 'invalid_target');
    const q = database('dispatch_alerts').where({ id: rawId });
    const row = await (lock ? q.forUpdate() : q).first(...ALERT_COLUMNS);
    return row ? { row } : refusal('Dispatch alert not found. Nothing was changed.', 'alert_not_found');
  }
  if (!UUID_RE.test(rawJob)) return refusal('A valid job_id is required', 'invalid_target');
  const q = database('dispatch_alerts').where({ job_id: rawJob }).whereNull('resolved_at').orderBy('created_at', 'desc');
  const rows = await (lock ? q.forUpdate() : q).select(...ALERT_COLUMNS);
  if (!rows.length) return refusal('That visit has no open alert. Nothing was changed.', 'alert_not_found');
  if (rows.length > 1) {
    return refusal('That visit has several open alerts. The bar resolves one at a time: ask which one, then pass its alert_id.', 'alert_required', {
      candidates: await openCandidates(database, rawJob),
    });
  }
  return { row: rows[0] };
}

function planEffects({ tracking }) {
  return [
    { kind: 'operational', text: 'The card is marked resolved by you and stays in the alert history. It is not deleted.' },
    { kind: 'operational', text: 'Every open Dispatch board drops the card right away.' },
    tracking
      ? { kind: 'operational', text: 'This is a tracking alert: its linked admin bell is marked done, and the tracking check does not raise the same alert again for this visit, promised time and stage.' }
      : null,
    { kind: 'operational', text: 'The board has no Reopen: a resolved card does not come back.' },
    { kind: 'comms', text: 'Nothing is sent: no text, email or call goes to the customer or the technician. The visit, route and technician do not change.' },
  ].filter(Boolean);
}

// The technician, visit and customer the card names (plain reads; the alert row itself is the one held FOR UPDATE).
async function loadContext(database, row) {
  const tech = row.tech_id ? await database('technicians').where({ id: row.tech_id }).first('id', 'name') : null;
  const visit = row.job_id
    ? await database('scheduled_services').where({ id: row.job_id }).first('id', 'customer_id', 'service_type', 'scheduled_date', 'window_start', 'window_end', 'status')
    : null;
  const customer = visit?.customer_id
    ? await database('customers').where({ id: visit.customer_id }).first('first_name', 'last_name', 'company_name')
    : null;
  const { etCalendarDayOf } = require('../../utils/datetime-et');
  const visitView = visit ? {
    id: visit.id,
    service_type: visit.service_type || null,
    status: visit.status || null,
    // A pg DATE arrives as a Date at UTC midnight: the repo's calendar-day helper keeps the day.
    date: visit.scheduled_date ? etCalendarDayOf(visit.scheduled_date) : null,
    window: [visit.window_start, visit.window_end].map((v) => (v ? String(v).slice(0, 5) : '')).join('-'),
  } : null;
  return { visitView, customerName: fullName(customer), techName: tech?.name || null };
}

async function buildPlan(input, { database = db, lock = false } = {}) {
  const found = await loadAlert(input, { database, lock });
  if (found.error) return found;
  const { row } = found;
  if (row.resolved_at) {
    return refusal(`That card was already resolved${raisedAtEt(row.resolved_at) ? ` (${raisedAtEt(row.resolved_at)})` : ''}. Nothing was changed.`, 'already_resolved', { alert_id: row.id });
  }
  const { DECISION_ONLY_ALERT_TYPES } = require('../dispatch-alerts');
  if (DECISION_ONLY_ALERT_TYPES.includes(row.type)) {
    return refusal('This card needs a decision, not a bare resolve: use "This was a miss" or "Not a miss" on the Dispatch board. Nothing was changed.', 'needs_decision', { alert_id: row.id });
  }

  const { visitView, customerName, techName } = await loadContext(database, row);
  const message = alertMessage(row);
  const tracking = row.payload?.source === 'no_show_detector';
  const raised = raisedAtEt(row.created_at);

  return {
    preview: true,
    tool: 'resolve_dispatch_alert',
    alert_id: row.id,
    alert_type: row.type,
    alert_label: typeLabel(row.type),
    severity: row.severity,
    message,
    raised_at_et: raised,
    visit: visitView,
    customer_name: customerName,
    technician_name: techName,
    effects: planEffects({ tracking }),
    sends_to_customer: false,
    // What the confirm re-checks: every fact the card showed, plus the whole payload (a detector updating the
    // card's numbers is a change), and that the card is still unresolved.
    _version: {
      alert_id: row.id,
      type: row.type,
      severity: row.severity,
      resolved: false,
      tech_id: row.tech_id || null,
      job_id: row.job_id || null,
      raised_ms: row.created_at ? new Date(row.created_at).getTime() : null,
      payload: digest(row.payload),
      message,
      tracking,
      visit: visitView,
      customer: customerName,
      technician: techName,
    },
    note: 'PREVIEW ONLY — nothing was changed. Confirm resolves exactly this card; if anything changed it refuses.',
  };
}

async function verifiedPlan(input, pinned) {
  if (!pinned) return { refusal: refusal('Use the confirmation card to approve resolving this alert.', 'approval_required') };
  const plan = await buildPlan(input);
  if (plan.error) return { refusal: { error: `Nothing was changed: ${plan.error}`, code: plan.code, preview_changed: true } };
  if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
    return { refusal: { error: 'The alert changed after the card was shown, so nothing was changed. Ask again for a fresh confirmation card.', code: 'preview_changed', preview_changed: true } };
  }
  return { plan };
}

const changedError = () => Object.assign(new Error('The alert changed after the card was shown.'), { code: 'preview_changed' });

// Whether the alert reads back resolved after a failed resolve: true only when a read SUCCEEDED and shows it resolved.
// A failed read says nothing about the alert, so it is never read as "done" (the caller then reports outcome_unknown).
async function readsResolved(alertId) {
  try {
    const now = await db('dispatch_alerts').where({ id: alertId }).first('resolved_at');
    return Boolean(now?.resolved_at);
  } catch {
    return false;
  }
}

async function commitResolve(input, actionContext) {
  const { plan, refusal: refused } = await verifiedPlan(input, input._verified_dispatch_alert_version);
  if (refused) return refused;
  const base = { alert_id: plan.alert_id };
  const resolvedBy = actionContext?.technicianId || null;
  let result;
  try {
    await db.transaction(async (trx) => {
      // The alert re-read by its pinned id FOR UPDATE, in the write's own transaction, then compared to the card.
      const locked = await buildPlan({ alert_id: plan.alert_id }, { database: trx, lock: true });
      if (locked.error || JSON.stringify(locked._version) !== JSON.stringify(plan._version)) throw changedError();
      result = await require('../dispatch-alerts').resolveAlertAsDispatcher({ id: plan.alert_id, resolvedBy, trx });
      if (result.outcome !== 'resolved') throw changedError();
    });
  } catch (err) {
    if (err?.code === 'preview_changed') {
      return { ...base, failed: true, code: 'preview_changed', preview_changed: true, error: 'The alert changed or was already resolved after the card was shown, so nothing was changed. Ask again for a fresh confirmation card.' };
    }
    logger.error(`[intelligence-bar:dispatch-alert] resolve failed (${err?.code || err?.name || 'error'})`);
    if (await readsResolved(plan.alert_id)) {
      return { ...base, success: true, warning: true, sent_to_customer: false,
        note: `The ${plan.alert_label} alert is resolved, but a later step reported a problem. Check the Dispatch board.` };
    }
    return { ...base, outcome_unknown: true, code: 'execution_interrupted',
      error: 'Resolving the alert was interrupted — it may or may not have happened. Check the Dispatch board before trying again.' };
  }
  logger.info(`[intelligence-bar:dispatch-alert] alert ${plan.alert_id} resolved`);
  return { ...base, success: true, sent_to_customer: false,
    note: `The ${plan.alert_label} alert is resolved. The Dispatch boards drop it now. Nothing was sent to anyone.` };
}

// ── card lines (authorization-contract.js) ──────────────────────

function cardLines(toolName, preview) {
  if (toolName !== 'resolve_dispatch_alert' || !preview || preview.preview !== true) return [];
  const visit = preview.visit;
  const visitText = visit
    ? [visit.service_type, [visit.date, visit.window && visit.window !== '-' ? visit.window : null].filter(Boolean).join(' ')].filter(Boolean).join(', ')
    : null;
  return [
    { kind: 'operational', text: `${preview.alert_label} alert (${preview.severity}): ${preview.message}` },
    preview.raised_at_et ? { kind: 'operational', text: `Raised ${preview.raised_at_et}` } : null,
    visitText ? { kind: 'operational', text: `Visit: ${visitText}` } : { kind: 'operational', text: 'Not tied to a visit' },
    preview.customer_name ? { kind: 'customer', text: `Customer: ${preview.customer_name}` } : null,
    preview.technician_name ? { kind: 'operational', text: `Technician: ${preview.technician_name}` } : null,
    ...(preview.effects || []).map(({ kind, text }) => ({ kind, text })),
  ].filter(Boolean);
}

async function executeDispatchAlertTool(toolName, input = {}, actionContext = {}) {
  if (!DISPATCH_ALERT_TOOLS.some((t) => t.name === toolName)) return { error: `Unknown tool: ${toolName}` };
  // Admin only, like the board's Resolve (requireAdmin); the confirmed run needs a positive admin flag. A technician
  // context never reaches here (the registry lists the tool for admins only).
  if (actionContext?.isAdmin === false || (input.confirmed === true && actionContext?.isAdmin !== true)) {
    return refusal('Resolving a dispatch alert is limited to admin accounts', 'permission_denied');
  }
  if (!resolveDispatchAlertLive()) return refusal('Resolving a dispatch alert from the bar is switched off.', 'gate_off');
  try {
    // Only /confirm-action sets confirmed (route-derived, never a model param).
    return input.confirmed === true ? await commitResolve(input, actionContext) : await buildPlan(input);
  } catch (err) {
    logger.error(`[intelligence-bar:dispatch-alert] ${toolName} failed (${err?.code || err?.name || 'error'})`);
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: 'Resolving the alert was interrupted — it may or may not have happened. Check the Dispatch board before trying again.' }
      : { error: 'Could not prepare the alert resolve' };
  }
}

module.exports = {
  DISPATCH_ALERT_TOOLS,
  executeDispatchAlertTool,
  resolveDispatchAlertLive,
  cardLines,
  buildPlan,
};

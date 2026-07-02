const { parseETDateTime, etDateString } = require('./datetime-et');

// Speed-to-Lead fresh-start baseline (owner directive 2026-06-30: "fresh start
// tomorrow"). Queries that count "leads still waiting for a first response"
// floor first_contact_at at this ET date, so a one-time reset isn't dragged
// down forever by the pre-reset backlog of never-answered leads.
//
// Env-overridable (SPEED_TO_LEAD_FRESH_START=YYYY-MM-DD) for a future reset;
// set it empty to disable the floor. Invalid values fail open (no floor).
//
// Shared by the Leads page gauge (routes/admin-leads.js) and the dashboard
// Action Inbox (services/dashboard-alerts.js) so the two "still waiting"
// definitions can't drift.
function resolveSpeedToLeadFreshStart(raw = process.env.SPEED_TO_LEAD_FRESH_START ?? '2026-07-01') {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    // A date-only baseline is the START of that ET day (a bare new Date(raw)
    // would parse midnight UTC and shift the cutoff by the ET offset).
    const d = parseETDateTime(`${raw}T00:00:00`);
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
    // parseETDateTime builds the cutoff with Date.UTC(), which silently rolls a
    // non-existent calendar date over (2026-02-30 -> Mar 2) instead of failing.
    // Round-trip through ET and reject any mismatch, so a typoed reset env
    // falls open to "no floor" rather than a wrong cutoff.
    if (etDateString(d) !== raw) return null;
    return d;
  }
  const d = new Date(raw);
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
}

// Resolved once at require time (mirrors the original route-level IIFE); tests
// that change the env re-require through jest.resetModules.
const SPEED_TO_LEAD_FRESH_START = resolveSpeedToLeadFreshStart();

module.exports = { SPEED_TO_LEAD_FRESH_START, resolveSpeedToLeadFreshStart };

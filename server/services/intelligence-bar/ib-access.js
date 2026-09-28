/**
 * Intelligence Bar full-access predicate (owner ruling 2026-09-28).
 *
 * Every admin login already gets the bar's yellow/green scope (unchanged).
 * Red-tier tools — CONFIRMED_ENDPOINT_WRITE_TOOL_NAMES in write-gates.js,
 * whatever `tierFor(toolName) === 'red'` classifies today or in the future
 * (payout requests, the SEO pipeline, and any future confirmed-endpoint
 * write such as refunds/charges or GrowthBook/Railway GATE_* writes) — are
 * additionally restricted to the contact@wavespestcontrol.com login, still
 * through the same owner-only confirm flow (/execute with confirmed:true +
 * idempotency key) those tools already require. A future tool inherits the
 * restriction automatically by being classified red; nothing here is
 * per-tool.
 *
 * Technician tokens are unaffected — they never reach this predicate,
 * because every red-tier entry point already default-denies non-admin
 * tokens before this check runs.
 */

const DEFAULT_FULL_ACCESS_EMAILS = ['contact@wavespestcontrol.com'];

// Parsed fresh on every call (never cached at require time) so a Railway
// variable change takes effect on the next request with no redeploy.
function fullAccessAllowlist() {
  const raw = process.env.IB_FULL_ACCESS_EMAILS;
  if (raw === undefined || raw === null) return DEFAULT_FULL_ACCESS_EMAILS;
  const parsed = String(raw)
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length ? parsed : DEFAULT_FULL_ACCESS_EMAILS;
}

// True only for an authenticated admin login whose OWN technicians-row email
// (adminAuthenticate's req.technician, never a client-supplied value) is on
// the allow-list. A missing/blank email never matches — fail closed.
function ibFullAccess(req) {
  if (req?.techRole !== 'admin') return false;
  const email = String(req?.technician?.email || '').trim().toLowerCase();
  if (!email) return false;
  return fullAccessAllowlist().includes(email);
}

module.exports = { ibFullAccess, fullAccessAllowlist, DEFAULT_FULL_ACCESS_EMAILS };

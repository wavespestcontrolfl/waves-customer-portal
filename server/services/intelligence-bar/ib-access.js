/**
 * Intelligence Bar full-access predicate + the write guard that protects it
 * (owner ruling 2026-09-28).
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
 *
 * Because ibFullAccess() keys off technicians.email, every write that can
 * change that column is itself part of the trust boundary —
 * assertMayChangeFullAccessEmail() below is the ONE guard for all of them
 * (createTechnician / updateTechnician in admin-timetracking.js, and
 * POST /api/admin/auth/register), so the rule is defined once rather than
 * copied per route.
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

// Middleware form of ibFullAccess() for the SAME red-tier actions when they
// are reachable from an ordinary admin page route rather than the bar (owner
// ruling 2026-09-28: the restriction is contact@-only EVERYWHERE those
// actions live, not just inside the Intelligence Bar). Apply it per-route to
// each red-tier action handler — never router-wide, since every other route
// on these routers stays open to any admin. Reads stay open; only the write
// itself is gated.
function requireFullAccess(req, res, next) {
  if (!ibFullAccess(req)) {
    return res.status(403).json({ error: 'This action is limited to the owner account.' });
  }
  next();
}

function canonicalOrNull(email) {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed || null;
}

function isFullAccessEmail(email) {
  const canonical = canonicalOrNull(email);
  return canonical ? fullAccessAllowlist().includes(canonical) : false;
}

/**
 * The ONE guard for every staff-identity write that can touch
 * technicians.email — createTechnician, updateTechnician, and the
 * standalone POST /api/admin/auth/register all call this before writing,
 * so the rule lives in exactly one place rather than three per-route
 * copies (owner ruling 2026-09-28, hardened after two pre-push-audit
 * findings on PR #5228):
 *
 *  - Escalation: a non-owner admin must not be able to ASSIGN a
 *    full-access email to any row (their own, a new hire, or someone
 *    else's) — that would hand them full IB access at their next login.
 *  - Stripping: a non-owner admin must not be able to move a row's
 *    CURRENT full-access email to anything else either — that would
 *    permanently strip the owner's own access with no in-product way to
 *    reassign it back (`fromEmail` on the row they are editing).
 *
 * Both directions are refused (403) unless the requester already has
 * full access. An edit that leaves the email UNCHANGED is never blocked,
 * whatever the value is — only an actual change to a row's email is
 * assessed. `fromEmail` is null for a brand-new row (register /
 * createTechnician): there is nothing to strip, only a possible
 * assignment to check.
 */
function assertMayChangeFullAccessEmail(req, { fromEmail = null, toEmail = null } = {}) {
  const from = canonicalOrNull(fromEmail);
  const to = canonicalOrNull(toEmail);
  if (from === to) return null;
  if ((isFullAccessEmail(from) || isFullAccessEmail(to)) && !ibFullAccess(req)) {
    return { error: 'Only the owner account can change this email address.' };
  }
  return null;
}

module.exports = {
  ibFullAccess,
  requireFullAccess,
  fullAccessAllowlist,
  isFullAccessEmail,
  assertMayChangeFullAccessEmail,
  DEFAULT_FULL_ACCESS_EMAILS,
};

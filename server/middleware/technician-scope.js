// Technician reach, as an allow-list (owner ruling 2026-10-02).
//
// Before this, every staff router was OPEN to a technician login unless someone
// remembered to add requireAdmin. Across ~130 routers a few were forgotten
// (call recordings, the SMS log, the knowledge base). This flips the default:
// with GATE_STAFF_DEFAULT_DENY on, a technician-role request reaches a staff
// route ONLY if (method, full path) matches an entry below. Everything else is
// a 403 before the route runs. Admins are never affected.
//
// With the gate OFF (today), nothing is denied; a request that WOULD be denied
// is logged once per route so the production log shows what technicians
// actually use before the flip.
//
// The list is a floor, not the whole story: routers that already scope a
// technician to their own visits/customers (admin-schedule scopeToAssignedTech,
// admin-customers technicianServicesCustomer, tech-track) keep doing so behind
// this gate. A path on this list is "a technician may call this at all", never
// "for any record".
//
// scripts/staff-route-census.js renders the list against every mounted staff
// route into docs/technician-reachable-routes.md; the gates CI job fails when
// that file is stale, so a review always sees the reach a change grants.

const ANY = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const READ = ['GET', 'HEAD'];

// Each entry: methods, a regex over `${req.baseUrl}${req.path}` (no query
// string, trailing slash stripped), and the owner bucket it belongs to.
const TECHNICIAN_ALLOW_LIST = [
  // Session plumbing the admin shell needs for any staff role.
  { bucket: 'session', methods: ANY, pattern: /^\/api\/admin\/auth(\/.*)?$/ },
  { bucket: 'session', methods: ANY, pattern: /^\/api\/admin\/push(\/.*)?$/ },
  { bucket: 'session', methods: ANY, pattern: /^\/api\/admin\/notifications(\/.*)?$/ },
  { bucket: 'session', methods: ANY, pattern: /^\/api\/tech\/notifications(\/.*)?$/ },
  // The flag read every staff screen boots from (useFeatureFlag fails closed
  // on a 403 and would switch field features off). The admin-only flag
  // routes under it carry their own requireAdmin.
  { bucket: 'session', methods: READ, pattern: /^\/api\/admin\/feature-flags$/ },

  // Own schedule and visits (the routers scope to the assigned technician).
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/admin\/schedule(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/admin\/dispatch(\/.*)?$/ },
  // The dispatch facade's job list only (the route pins a technician to their
  // own visits); the route board and insights are admin-only.
  { bucket: 'own-visits', methods: READ, pattern: /^\/api\/dispatch\/jobs$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/admin\/visit-closeouts(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/tech\/services(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/tech\/line(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/tech\/field-lead(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/tech\/lawn-diagnostic(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/tech\/social(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/admin\/projects(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/admin\/treatment-plans(\/.*)?$/ },
  // Lawn assessment: the field flow only (the router scopes each of these to
  // the technician's own route/customers; reset-baseline is requireAdmin).
  { bucket: 'own-visits', methods: READ, pattern: /^\/api\/admin\/lawn-assessment\/customers$/ },
  { bucket: 'own-visits', methods: ['POST'], pattern: /^\/api\/admin\/lawn-assessment\/(assess|confirm)$/ },
  { bucket: 'own-visits', methods: READ, pattern: /^\/api\/admin\/lawn-assessment\/(service|history|baseline|latest)\/[^/]+$/ },
  // Consultation outcome on a visit (the router pins it to the assigned tech).
  { bucket: 'own-visits', methods: ['GET', 'HEAD', 'POST'], pattern: /^\/api\/admin\/consultations\/[^/]+\/outcome$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/admin\/customers(\/.*)?$/ },
  // Intelligence Bar: the router hard-pins a technician token to the isolated
  // tech context (admin-intelligence-bar.js ~2605) and executes tools under
  // that role/context scope, so every route may be reached; the scoping is
  // the router's.
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/admin\/intelligence-bar(\/.*)?$/ },
  { bucket: 'own-visits', methods: READ, pattern: /^\/api\/admin\/(services|technicians|discounts)$/ },
  // Not on the list: estimate reads (schedule-source returns lead PII and
  // pricing with no visit to scope by) and the estimator (its /verify persists
  // field overrides; the Field Estimator UI is admin-only). Codex #5568 r3.
  { bucket: 'own-visits', methods: READ, pattern: /^\/api\/admin\/protocols(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/admin\/protocols\/job-card(\/.*)?$/ },
  // Pay at the visit (owner: card on file, pay after the first visit).
  { bucket: 'own-visits', methods: READ, pattern: /^\/api\/admin\/invoices\/[^/]+$/ },
  { bucket: 'own-visits', methods: ['POST'], pattern: /^\/api\/admin\/invoices\/[^/]+\/(charge-card|charge-card-quote|void)$/ },
  { bucket: 'own-visits', methods: ['POST'], pattern: /^\/api\/admin\/pricing-config\/(estimate|quick-quote)$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/admin\/job-costs(\/.*)?$/ },
  // Tap to Pay at the visit: the technician mints the handoff (the route
  // checks the invoice's customer is on their route); the terminal-scoped
  // token does the rest. /capture is admin-only.
  { bucket: 'own-visits', methods: ['POST'], pattern: /^\/api\/stripe\/terminal\/handoff$/ },
  // Visual service notes on a job (visibility and customer caption stay admin).
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/jobs\/[^/]+\/visual-moments$/ },
  { bucket: 'own-visits', methods: ['PATCH', 'DELETE'], pattern: /^\/api\/visual-moments\/[^/]+$/ },
  { bucket: 'own-visits', methods: READ, pattern: /^\/api\/service\/records\/[^/]+\/validate-photo-chain$/ },

  // Own timesheet and mileage.
  { bucket: 'own-time', methods: ANY, pattern: /^\/api\/tech\/timetracking(\/.*)?$/ },
  { bucket: 'own-time', methods: ANY, pattern: /^\/api\/admin\/timetracking(\/.*)?$/ },
  { bucket: 'own-time', methods: ['POST'], pattern: /^\/api\/admin\/timesheets\/dispute$/ },

  // Texts with customers on their own visits: admin-communications scopes a
  // technician's inbox, sends, drafts and read-marks to customers on their
  // route (technicianCustomerGuard / technicianCustomerIdsSubquery). This
  // list closes the routes a technician has no business calling at all:
  // stats, the compliance export, outbound calls from the business line,
  // auto-reply and link library configuration.
  { bucket: 'own-texts', methods: READ, pattern: /^\/api\/admin\/communications\/(log|unread-count|link-library|ai-auto-reply-status|customer-link|agent-draft)$/ },
  { bucket: 'own-texts', methods: ['POST'], pattern: /^\/api\/admin\/communications\/(sms|messages\/read|reschedule-link|reservice-link|send-prep|schedule-sms|rewrite-sms|ai-draft|customer-link)$/ },
  { bucket: 'own-texts', methods: READ, pattern: /^\/api\/admin\/communications\/blocked-numbers$/ },
  // The single-draft read the SMS tab uses (the router scopes it to the
  // technician's customers); list and stats are admin-only in the router.
  { bucket: 'own-texts', methods: READ, pattern: /^\/api\/admin\/drafts\/[^/]+$/ },
  { bucket: 'own-texts', methods: READ, pattern: /^\/api\/admin\/sms-templates(\/.*)?$/ },

  // Promises and reschedule proposals (the Promises tab, the field cards).
  { bucket: 'promises', methods: ANY, pattern: /^\/api\/admin\/call-recordings\/(commitments|proposals)(\/.*)?$/ },
  { bucket: 'promises', methods: ['POST'], pattern: /^\/api\/admin\/call-recordings\/calls\/[^/]+\/commitments$/ },
  { bucket: 'promises', methods: READ, pattern: /^\/api\/admin\/call-recordings\/blocked$/ },

  // The field app's review-request trigger after a visit (the router already
  // scopes a technician to those two POSTs; everything else there is admin).
  { bucket: 'own-visits', methods: ['POST'], pattern: /^\/api\/admin\/review-requests\/(trigger|tech-trigger)$/ },
  // The completion panel's "when will the review ask go out" preview (a
  // service-type lookup, no customer data; registered before admin-reviews'
  // admin-only guard).
  { bucket: 'own-visits', methods: READ, pattern: /^\/api\/admin\/reviews\/send-time-preview$/ },

  // Documents, pay and growth.
  { bucket: 'documents', methods: ANY, pattern: /^\/api\/tech\/staff-documents(\/.*)?$/ },
  { bucket: 'pay-growth', methods: ANY, pattern: /^\/api\/tech\/pay-growth(\/.*)?$/ },

  // Knowledge base: read, and ask. Never write, verify, or run paid jobs.
  { bucket: 'knowledge-read', methods: READ, pattern: /^\/api\/admin\/kb(\/[^/]+)?$/ },
  { bucket: 'knowledge-read', methods: READ, pattern: /^\/api\/admin\/kb\/stats$/ },
  { bucket: 'knowledge-read', methods: READ, pattern: /^\/api\/admin\/knowledge(\/.*)?$/ },
  { bucket: 'knowledge-read', methods: ['POST'], pattern: /^\/api\/admin\/knowledge\/query$/ },
  { bucket: 'knowledge-read', methods: ANY, pattern: /^\/api\/tech\/knowledge(\/.*)?$/ },
  { bucket: 'knowledge-read', methods: READ, pattern: /^\/api\/knowledge(\/.*)?$/ },
  // Field wiki reads (review, tier, update and generate carry requireAdmin).
  { bucket: 'knowledge-read', methods: READ, pattern: /^\/api\/admin\/wiki(\/.*)?$/ },

  // Equipment and inventory: read only.
  { bucket: 'equipment-read', methods: READ, pattern: /^\/api\/admin\/equipment(-systems|-maintenance)?(\/.*)?$/ },
  { bucket: 'equipment-read', methods: READ, pattern: /^\/api\/admin\/inventory(\/.*)?$/ },
];

function normalizePath(req) {
  const full = `${req.baseUrl || ''}${req.path || ''}`;
  const trimmed = full.length > 1 ? full.replace(/\/+$/, '') : full;
  return trimmed || '/';
}

function technicianMayReach(method, fullPath) {
  const m = String(method || '').toUpperCase();
  return TECHNICIAN_ALLOW_LIST.some((e) => e.methods.includes(m) && e.pattern.test(fullPath));
}

function staffDefaultDenyEnabled() {
  try {
    return require('../config/feature-gates').isEnabled('staffDefaultDeny');
  } catch {
    return false;
  }
}

// Once per (method, route template) per process, and bounded. The key is the
// route Express actually matched (req.baseUrl + req.route.path, read when the
// response finishes), so every parameter position is its template name and a
// technician varying any path value — ids, phone numbers, or a plain
// lowercase word — maps to the same key (codex #5568 r1 P2, r10 P2). A request
// no route matched keys as one '(unmatched)' per method. The set also stops
// growing at SHADOW_LOG_CAP keys (one final line says so).
const SHADOW_LOG_CAP = 200;
const shadowLogged = new Set();
function shadowRouteKey(method, req) {
  const route = req.route && req.route.path;
  if (route === undefined || route === null) return `${method} (unmatched)`;
  return `${method} ${req.baseUrl || ''}${String(route)}`;
}

function shadowLogOnce(key) {
  if (shadowLogged.has(key)) return;
  if (shadowLogged.size >= SHADOW_LOG_CAP) {
    if (!shadowLogged.has('__cap__')) {
      shadowLogged.add('__cap__');
      try {
        require('../services/logger').warn(`[staff-scope] would-deny log reached ${SHADOW_LOG_CAP} distinct route shapes; further shapes are not logged`);
      } catch { /* logging never blocks a request */ }
    }
    return;
  }
  shadowLogged.add(key);
  try {
    require('../services/logger').info(`[staff-scope] would-deny technician ${key} (GATE_STAFF_DEFAULT_DENY off)`);
  } catch { /* logging never blocks a request */ }
}

// Middleware step. Call AFTER req.techRole is set. Admins pass untouched.
// Returns true when it responded (denied), false to continue.
function enforceTechnicianScope(req, res) {
  // Every non-admin staff role is scoped. adminAuthenticate admits only admin
  // and technician today; a future role is denied by default, not skipped.
  if (req.techRole === 'admin') return false;
  const method = String(req.method || 'GET').toUpperCase();
  const fullPath = normalizePath(req);
  if (technicianMayReach(method, fullPath)) return false;
  if (!staffDefaultDenyEnabled()) {
    // Keyed on the matched route template once the response is done; a
    // request reaching here through several staff routers logs once.
    if (!req._staffScopeShadowArmed && res && typeof res.once === 'function') {
      req._staffScopeShadowArmed = true;
      res.once('finish', () => shadowLogOnce(shadowRouteKey(method, req)));
    }
    return false;
  }
  res.status(403).json({ error: 'Admin access required', code: 'TECHNICIAN_SCOPE' });
  return true;
}

module.exports = {
  TECHNICIAN_ALLOW_LIST,
  technicianMayReach,
  enforceTechnicianScope,
  normalizePath,
  shadowRouteKey,
  SHADOW_LOG_CAP,
  _shadowLoggedForTests: shadowLogged,
};

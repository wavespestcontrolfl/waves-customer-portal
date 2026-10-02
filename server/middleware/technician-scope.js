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
  { bucket: 'own-visits', methods: READ, pattern: /^\/api\/dispatch\/(jobs|routes|insights|csr\/slots)$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/admin\/visit-closeouts(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/tech\/services(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/tech\/line(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/tech\/field-lead(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/tech\/lawn-diagnostic(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/tech\/social(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/admin\/projects(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/admin\/treatment-plans(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/admin\/lawn-assessment(\/.*)?$/ },
  // Consultation outcome on a visit (the router pins it to the assigned tech).
  { bucket: 'own-visits', methods: ['GET', 'HEAD', 'POST'], pattern: /^\/api\/admin\/consultations\/[^/]+\/outcome$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/admin\/customers(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/admin\/intelligence-bar(\/.*)?$/ },
  { bucket: 'own-visits', methods: READ, pattern: /^\/api\/admin\/(services|technicians|discounts)$/ },
  { bucket: 'own-visits', methods: READ, pattern: /^\/api\/admin\/estimates\/[^/]+\/schedule-source$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/admin\/estimator(\/.*)?$/ },
  { bucket: 'own-visits', methods: READ, pattern: /^\/api\/admin\/protocols(\/.*)?$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/admin\/protocols\/job-card(\/.*)?$/ },
  // Pay at the visit (owner: card on file, pay after the first visit).
  { bucket: 'own-visits', methods: READ, pattern: /^\/api\/admin\/invoices\/[^/]+$/ },
  { bucket: 'own-visits', methods: ['POST'], pattern: /^\/api\/admin\/invoices\/[^/]+\/(charge-card|charge-card-quote|void)$/ },
  { bucket: 'own-visits', methods: ['POST'], pattern: /^\/api\/admin\/pricing-config\/(estimate|quick-quote)$/ },
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/admin\/job-costs(\/.*)?$/ },
  // Tap to Pay at the visit: the technician mints the handoff and captures;
  // the terminal-scoped token (not a staff session) does the rest.
  { bucket: 'own-visits', methods: ['POST'], pattern: /^\/api\/stripe\/terminal\/(handoff|capture)$/ },
  // Visual service notes on a job (visibility and customer caption stay admin).
  { bucket: 'own-visits', methods: ANY, pattern: /^\/api\/jobs\/[^/]+\/visual-moments$/ },
  { bucket: 'own-visits', methods: ['PATCH', 'DELETE'], pattern: /^\/api\/visual-moments\/[^/]+$/ },
  { bucket: 'own-visits', methods: READ, pattern: /^\/api\/service\/records\/[^/]+\/validate-photo-chain$/ },

  // Own timesheet and mileage.
  { bucket: 'own-time', methods: ANY, pattern: /^\/api\/tech\/timetracking(\/.*)?$/ },
  { bucket: 'own-time', methods: ANY, pattern: /^\/api\/admin\/timetracking(\/.*)?$/ },
  { bucket: 'own-time', methods: ['POST'], pattern: /^\/api\/admin\/timesheets\/dispute$/ },

  // Texts with customers on their own visits. (Per-customer scoping inside
  // admin-communications is the follow-up PR; this list only closes the
  // routes a technician has no business calling at all: the compliance
  // export, outbound calls from the business line, auto-reply and link
  // library configuration.)
  { bucket: 'own-texts', methods: READ, pattern: /^\/api\/admin\/communications\/(log|stats|unread-count|link-library|ai-auto-reply-status|customer-link)$/ },
  { bucket: 'own-texts', methods: ['POST'], pattern: /^\/api\/admin\/communications\/(sms|messages\/read|reschedule-link|reservice-link|send-prep|schedule-sms|rewrite-sms|ai-draft|agent-draft|customer-link)$/ },
  { bucket: 'own-texts', methods: READ, pattern: /^\/api\/admin\/communications\/blocked-numbers$/ },
  { bucket: 'own-texts', methods: READ, pattern: /^\/api\/admin\/drafts(\/.*)?$/ },
  { bucket: 'own-texts', methods: READ, pattern: /^\/api\/admin\/sms-templates(\/.*)?$/ },

  // Promises and reschedule proposals (the Promises tab, the field cards).
  { bucket: 'promises', methods: ANY, pattern: /^\/api\/admin\/call-recordings\/(commitments|proposals)(\/.*)?$/ },
  { bucket: 'promises', methods: ['POST'], pattern: /^\/api\/admin\/call-recordings\/calls\/[^/]+\/commitments$/ },
  { bucket: 'promises', methods: READ, pattern: /^\/api\/admin\/call-recordings\/blocked$/ },

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

// Once per (method, path-shape) per process: the shadow log must not grow
// with traffic, and it must never carry a record identifier. Every path
// segment that is not a plain lowercase route word (ids, SIDs, phone numbers,
// tokens, emails) collapses to :x before the key is built or logged.
const shadowLogged = new Set();
function shadowKey(method, fullPath) {
  const shape = fullPath.split('/').map((seg) => (seg === '' || /^[a-z][a-z-]*$/.test(seg) ? seg : ':x')).join('/');
  return `${method} ${shape}`;
}

// Middleware step. Call AFTER req.techRole is set. Admins pass untouched.
// Returns true when it responded (denied), false to continue.
function enforceTechnicianScope(req, res) {
  if (req.techRole !== 'technician') return false;
  const method = String(req.method || 'GET').toUpperCase();
  const fullPath = normalizePath(req);
  if (technicianMayReach(method, fullPath)) return false;
  if (!staffDefaultDenyEnabled()) {
    const key = shadowKey(method, fullPath);
    if (!shadowLogged.has(key)) {
      shadowLogged.add(key);
      try {
        require('../services/logger').info(`[staff-scope] would-deny technician ${key} (GATE_STAFF_DEFAULT_DENY off)`);
      } catch { /* logging never blocks a request */ }
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
  shadowKey,
  _shadowLoggedForTests: shadowLogged,
};

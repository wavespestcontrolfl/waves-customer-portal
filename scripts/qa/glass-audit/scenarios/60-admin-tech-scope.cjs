'use strict';
// Theme-scope probes: the customer Liquid Glass scene (html[data-glass-theme],
// .glass-scene-orbs / .glass-scene-grain, backdrop-filter surfaces, the system
// font stack) must NOT reach the admin shell (Roboto monochrome Tier 1) or the
// tech portal (dark inline palette). Every scenario seeds a synthetic staff
// session in localStorage (same keys as scripts/qa/design-system.cjs) and
// answers the admin API locally with plausible empty payloads — empty states
// are fine, the evidence is the theme, not the data. Unmatched endpoints are
// deliberate: they 404 and are counted; the shell still renders.
/* global document, window */

const { source: estimateSource } = require('../../estimate-foundation-fixtures.cjs');

const TOKEN = 'synthetic-local-token';
const ADMIN_USER = { id: 'fixture-user', role: 'admin', name: 'Fixture operator', email: 'operator@example.invalid' };
const TECH_USER = { id: 'tech-fixture', role: 'technician', name: 'Fixture Technician', email: 'tech@example.invalid' };
const CUSTOMER_ID = estimateSource.customerId; // 'customer-example-a'
const CUSTOMER = {
  id: CUSTOMER_ID, name: estimateSource.customerName, first_name: 'Avery', last_name: 'Example', firstName: 'Avery', lastName: 'Example',
  email: estimateSource.customerEmail, phone: estimateSource.customerPhone, address: estimateSource.address,
  status: 'active', plan: 'Quarterly Pest Control', service_plan: 'Quarterly Pest Control', monthly_rate: 50,
  billing_mode: 'card', created_at: '2026-01-15T15:00:00Z', properties: [], tags: [], notes: '',
};

const seed = (user) => ({ waves_admin_token: TOKEN, waves_admin_user: JSON.stringify(user) });

// Static GET fixtures shared by every admin / tech route. Keys are the exact
// pathname; querystrings are matched separately below.
const staticGets = (user) => ({
  '/api/admin/auth/me': user,
  '/api/admin/feature-flags': { flags: {} },
  '/api/admin/communications/unread-count': { count: 0, conversations: 0 },
  '/api/admin/notifications/unread-count': { count: 0, conversations: 0 },
  '/api/admin/notifications': { notifications: [], unread: 0 },
  '/api/admin/discounts': [],
  '/api/admin/triage': { items: [] },
  // /admin/dashboard and its sub-endpoints are deliberately UNMOCKED: the
  // dashboard reads nested KPI fields (`.days`, `.completionRate`, …) and an
  // empty object crashes the page into the error boundary (which unmounts
  // the shell); a 404 is caught by the page's own track() and renders the
  // load-error state inside the shell instead.
  '/api/admin/dashboard/alerts': { alerts: [] },
  '/api/admin/billing-health': { ok: true, issues: [] },
  '/api/admin/command-center/stale-visits': { visits: [] },
  '/api/admin/customers/pipeline/view': { groups: [] },
  '/api/admin/invoices': { invoices: [], total: 0 },
  '/api/admin/invoices/stats': { open: 0, overdue: 0, paid: 0, totals: {} },
  '/api/admin/inventory': { items: [], total: 0 },
  '/api/admin/inventory/approvals': { approvals: [] },
  '/api/admin/inventory/label-pipeline': { items: [] },
  '/api/admin/inventory/protocol-health': { items: [] },
  '/api/admin/inventory/service-usage': { items: [] },
  '/api/admin/inventory/scrape-jobs': { jobs: [] },
  '/api/admin/inventory/lawn-outline-facts': { facts: [] },
  '/api/admin/inventory/price-sync/vendors': { vendors: [] },
  '/api/admin/inventory/price-sync/needs-mapping': { items: [] },
  '/api/admin/inventory/price-sync/review-queue': { items: [] },
  '/api/admin/estimates': { estimates: [], total: 0 },
  '/api/admin/leads': { leads: [], total: 0 },
  '/api/admin/services': { services: [] },
  '/api/admin/services/dropdown': { services: [] },
  '/api/admin/service-library': { services: [] },
  '/api/admin/payers': { payers: [] },
  '/api/admin/dispatch/products/catalog': { products: [] },
  '/api/admin/projects/types': { types: [] },
  '/api/admin/technicians': { technicians: [{ id: TECH_USER.id, name: TECH_USER.name, role: 'technician' }] },
  '/api/admin/users': { users: [] },
  '/api/admin/communications/stats': { sms: 0, calls: 0, email: 0 },
  '/api/admin/communications/conversations': { conversations: [], total: 0 },
  '/api/admin/communications/ai-auto-reply-status': { enabled: false },
  '/api/admin/communications/link-library': { links: [] },
  '/api/admin/kpi-targets': { targets: {} },
  '/api/admin/revenue/settings': { settings: {} },
  '/api/admin/schedule/blackout-dates': { dates: [] },
  '/api/admin/schedule/blackout-dates/weekly': { days: [] },
  '/api/admin/settings/service-coverage': { coverage: {} },
  '/api/admin/settings/visit-timeline': { timeline: {} },
  '/api/admin/settings/linkedin/status': { connected: false },
  '/api/admin/gbp/locations': { locations: [] },
  '/api/admin/document-templates': { templates: [] },
  '/api/admin/protocols/photos': { photos: [] },
  '/api/admin/protocols/scripts': { scripts: [] },
  '/api/admin/protocols': { protocols: [] },
  '/api/tech/line': { line: null },
  '/api/tech/notifications': { notifications: [], cards: [], unread: 0 },
  '/api/tech/timetracking/status': { status: 'clocked_out', clockedIn: false, shift: null, entries: [], todayMinutes: 0 },
  '/api/tech/timetracking/pending-signoff': { pending: [], entries: [] },
  '/api/admin/intelligence-bar/quick-actions': { actions: [] },
  '/api/admin/leads/sources': { sources: [] },
  '/api/admin/dispatch/technicians': { technicians: [{ id: TECH_USER.id, name: TECH_USER.name, role: 'technician', active: true }] },
  '/api/admin/dispatch/board': { jobs: [], services: [], technicians: [], unassigned: [], date: null },
  '/api/admin/dispatch/alerts': { alerts: [], count: 0 },
  '/api/admin/communications/log': { log: [], items: [], messages: [], total: 0, page: 1, totalPages: 1 },
  '/api/admin/inventory/vendors': { vendors: [] },
  '/api/admin/inventory/stats': { total: 0, lowStock: 0, pendingApprovals: 0, value: 0 },
  '/api/admin/requests': { requests: [], total: 0 },
  '/api/health': { ok: true, status: 'ok', db: 'ok' },
  '/api/tech/staff-documents/availability': { available: false },
  [`/api/admin/customers/${CUSTOMER_ID}`]: { customer: CUSTOMER, ...CUSTOMER },
  [`/api/admin/customers/${CUSTOMER_ID}/timeline`]: { events: [], timeline: [] },
  [`/api/admin/customers/${CUSTOMER_ID}/comms`]: { messages: [], calls: [], emails: [] },
  [`/api/admin/customers/${CUSTOMER_ID}/credits`]: { credits: [], balance: 0 },
  [`/api/admin/customers/${CUSTOMER_ID}/properties`]: { properties: [] },
  [`/api/admin/customers/${CUSTOMER_ID}/autopay-state`]: { autopay: false, cards: [] },
  [`/api/admin/customers/${CUSTOMER_ID}/invoices`]: { invoices: [] },
  [`/api/admin/customers/${CUSTOMER_ID}/estimates`]: { estimates: [] },
  [`/api/admin/customers/${CUSTOMER_ID}/services`]: { services: [] },
  [`/api/admin/customers/${CUSTOMER_ID}/contracts`]: { contracts: [] },
  [`/api/admin/customers/${CUSTOMER_ID}/notes`]: { notes: [] },
  [`/api/admin/dispatch/customers/${CUSTOMER_ID}/property-map`]: { map: null, properties: [] },
  [`/api/admin/estimates/customer-spend/${CUSTOMER_ID}`]: { services: [] },
});

function makeHandle(user) {
  const gets = staticGets(user);
  return ({ method, path, query }) => {
    if (method === 'POST' && path === '/api/admin/usage/track') return { body: { ok: true } };
    if (method === 'POST' && path.startsWith('/api/admin/analytics')) return { body: { ok: true } };
    if (method === 'POST' && path === '/api/client-errors') return { body: { ok: true } };
    if (method === 'GET' && Object.prototype.hasOwnProperty.call(gets, path)) return { body: structuredClone(gets[path]) };
    if (method === 'GET' && path === '/api/admin/customers') return { body: { customers: [CUSTOMER], total: 1, totalPages: 1, page: Number(query.page || 1) } };
    if (method === 'GET' && path === '/api/admin/schedule') return { body: { services: [], visits: [], date: query.date || null, rainChance: null } };
    if (method === 'GET' && path.startsWith('/api/admin/ads/')) return { body: { items: [] } };
    if (method === 'GET' && path.startsWith('/api/admin/pricing-config/')) return { body: { data: null, featureAvailable: false, subFeaturesAvailable: {} } };
    if (method === 'GET' && path.startsWith('/api/admin/invoices/payment-notices')) return { body: { notices: [] } };
    if (method === 'GET' && path.startsWith('/api/admin/protocols/')) return { body: { photos: [], scripts: [], protocols: [] } };
    return null; // unmatched → 404 JSON, recorded by the harness
  };
}

// Customer /login page: useAuth only calls /auth/me when a waves_token exists;
// none is seeded, so the page renders the glass sign-in card with no fetch.
const customerAuthHandle = ({ method, path }) => {
  if (path === '/api/auth/me') return { status: 401, body: { error: 'unauthenticated' } };
  if (method === 'POST' && path.startsWith('/api/auth/')) return { body: { ok: true } };
  return null;
};

const adminHandle = makeHandle(ADMIN_USER);
const techHandle = makeHandle(TECH_USER);
const ADMIN_SHELL = 'css:.admin-shell-v2';
const settledText = async (page) => { await page.waitForFunction(() => document.body.innerText.trim().length > 40, null, { timeout: 30000 }); };

const adminRoutes = [
  ['dashboard', 'Dashboard shell; /admin/dashboard* is deliberately unmocked (404) because an empty payload crashes the KPI cards into the error boundary — the page shows its load-error state inside the shell.'],
  ['customers', 'Customers workspace list with one fictional row (Avery Example).'],
  ['pipeline', 'Pipeline (EstimatesPageV2) with empty leads/estimates lists.'],
  ['dispatch', 'Dispatch board for today with an empty schedule.'],
  ['communications', 'Communications inbox with empty conversation list.'],
  ['invoices', 'Invoices list with empty invoices + zeroed stats.'],
  ['settings', 'Settings hub with empty setting payloads.'],
  ['service-library', 'Service library with empty catalog + discounts.'],
  ['inventory', 'Inventory with empty items/approvals/queues.'],
  ['_design-system', 'Admin design-system reference page (Tier 1 Roboto tokens).'],
];

module.exports = [
  {
    id: 'admin-login', family: 'theme-scope', surface: 'admin', role: 'anonymous staff', route: '/admin/login',
    url: '/admin/login', ready: 'Waves Pest Control Admin', handle: adminHandle,
    notes: 'No token seeded. Admin sign-in card (dark inline palette, "Waves Pest Control Admin"). Expect glass=OFF, no orbs, no backdrop-filter.',
  },
  ...adminRoutes.map(([slug, what]) => ({
    id: `admin-${slug.replace(/^_/, '')}`, family: 'theme-scope', surface: 'admin', role: 'admin', route: `/admin/${slug}`,
    url: `/admin/${slug}`, ready: ADMIN_SHELL, localStorage: seed(ADMIN_USER), handle: adminHandle, settle: 1500,
    notes: `${what} Unmatched admin endpoints are deliberate (404 → empty/error state); the shell (.admin-shell-v2) is the evidence. Expect glass=OFF and Roboto body font.`,
  })),
  {
    id: 'admin-customer-360', family: 'theme-scope', surface: 'admin', role: 'admin', route: '/admin/customers?customerId=:id',
    url: `/admin/customers?customerId=${encodeURIComponent(CUSTOMER_ID)}`, ready: ADMIN_SHELL, localStorage: seed(ADMIN_USER), handle: adminHandle, settle: 2000,
    notes: 'Customer 360 workspace opened for the fictional customer-example-a fixture; sub-panels answer empty. Expect glass=OFF.',
  },
  {
    id: 'tech-home', family: 'theme-scope', surface: 'tech', role: 'technician', route: '/tech',
    url: '/tech', ready: 'Today', localStorage: seed(TECH_USER), handle: techHandle, settle: 1500,
    notes: "Tech portal home (Today's route) with an empty schedule under a technician-role session. Expect glass=OFF, dark inline palette.",
  },
  {
    id: 'tech-protocols', family: 'theme-scope', surface: 'tech', role: 'technician', route: '/tech/protocols',
    url: '/tech/protocols', ready: settledText, localStorage: seed(TECH_USER), handle: techHandle, settle: 1500,
    notes: 'Tech protocols page with empty photos/scripts. Expect glass=OFF.',
  },
  // ---- leak probes ----
  {
    id: 'leak-tech-unknown', family: 'theme-scope', surface: 'tech', role: 'technician', route: '/tech/* (no child match)',
    url: '/tech/does-not-exist', ready: settledText, localStorage: seed(TECH_USER), handle: (req) => techHandle(req) || customerAuthHandle(req), settle: 1500,
    notes: 'The /tech layout has no catch-all child, so React Router falls through to the top-level "/*" customer PortalPage → ProtectedRoute → /login (glass). Captures whatever actually renders; glass=on here means a staff typo lands on the customer glass sign-in.',
  },
  {
    id: 'leak-admin-unknown', family: 'theme-scope', surface: 'admin', role: 'admin', route: '/admin/* (catch-all)',
    url: '/admin/does-not-exist', ready: ADMIN_SHELL, localStorage: seed(ADMIN_USER), handle: adminHandle, settle: 1500,
    notes: 'Admin catch-all redirects to /admin/dashboard inside the shell. Expect glass=OFF.',
  },
  {
    id: 'leak-after-login-nav', family: 'theme-scope', surface: 'admin', role: 'anonymous', route: '/login → /admin/login (SPA navigation)',
    url: '/login', ready: 'css:[data-glass="card"]', handle: (req) => customerAuthHandle(req) || adminHandle(req), settle: 1200,
    states: [{
      name: 'default',
      setup: async (page, rec) => {
        rec.probe = { before: await page.evaluate(() => ({ url: location.pathname, mounted: document.documentElement.hasAttribute('data-glass-theme'), orbs: document.querySelectorAll('.glass-scene-orbs').length, grain: document.querySelectorAll('.glass-scene-grain').length, htmlBg: document.documentElement.style.background.slice(0, 40) })) };
        await page.evaluate(() => { window.history.pushState({}, '', '/admin/login'); window.dispatchEvent(new PopStateEvent('popstate', { state: {} })); });
        await page.waitForFunction(() => document.body.innerText.includes('Waves Pest Control Admin'), null, { timeout: 30000 });
        await page.waitForTimeout(400);
        rec.probe.after = await page.evaluate(() => ({ url: location.pathname, mounted: document.documentElement.hasAttribute('data-glass-theme'), orbs: document.querySelectorAll('.glass-scene-orbs').length, grain: document.querySelectorAll('.glass-scene-grain').length, htmlBg: document.documentElement.style.background.slice(0, 40), bodyBg: document.body.style.background.slice(0, 40) }));
      },
    }],
    notes: 'Opens the customer glass /login, then SPA-navigates (pushState + popstate) to /admin/login without a reload. The capture and theme.mounted/theme.orbs metrics are taken AFTER the hop; rec.probe holds before/after snapshots of the html attribute, orb/grain layers and inline html/body backgrounds.',
  },
];

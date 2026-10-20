/**
 * Server-owned catalog over the existing TOOLS + executeTool modules.
 * Policy is explicit: a new/unclassified tool cannot be discovered or executed.
 * No model-supplied module, URL, SQL, actor, or approval is executable here.
 */
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const policy = require('./action-policy.json');
const {
  UI_GATED_WRITE_TOOL_NAMES, WRITE_TWO_STEP_TOOL_NAMES, CONFIRMED_ENDPOINT_WRITE_TOOL_NAMES,
  FULL_ACCESS_TWO_STEP_TOOL_NAMES, FULL_ACCESS_READ_TOOL_NAMES,
} = require('./write-gates');
const { threadsEnabled } = require('./threads');
const { mergeCustomersEnabled, deleteDuplicateCustomerEnabled } = require('./customer-lifecycle-tools');
const { ibAcceptEstimateLive } = require('../../config/feature-gates');
const { invoiceActionsLive } = require('./invoice-action-tools');
const { repriceVisitsLive } = require('./reprice-visits-tools');
const { adminReadLive } = require('./admin-read-tools');
const { adminWriteLive } = require('./admin-write-tools');
const AGENT_ESTIMATE_TOOL_NAMES = require('./agent-estimate-policy');
const apiToolDefinition = require('./tool-definition');
const { validScope } = require('./scope-policy');

const MODULES = [
  ['customer-estimate-tools', 'CUSTOMER_ESTIMATE_TOOLS', 'executeCustomerEstimateTool'],
  ['property-tools', 'PROPERTY_TOOLS', 'executePropertyTool'],
  ['tools', 'TOOLS', 'executeTool'],
  ['schedule-tools', 'SCHEDULE_TOOLS', 'executeScheduleTool'],
  ['closeout-tools', 'CLOSEOUT_TOOLS', 'executeCloseoutTool'],
  ['closeout-repair-tools', 'CLOSEOUT_REPAIR_TOOLS', 'executeCloseoutRepairTool'],
  ['receipt-resend-tools', 'RECEIPT_RESEND_TOOLS', 'executeReceiptResendTool'],
  ['customer-link-tools', 'CUSTOMER_LINK_TOOLS', 'executeCustomerLinkTool'],
  ['reprice-visits-tools', 'REPRICE_VISITS_TOOLS', 'executeRepriceVisitsTool'],
  ['dashboard-tools', 'DASHBOARD_TOOLS', 'executeDashboardTool'],
  ['seo-tools', 'SEO_TOOLS', 'executeSeoTool'],
  ['procurement-tools', 'PROCUREMENT_TOOLS', 'executeProcurementTool'],
  ['revenue-tools', 'REVENUE_TOOLS', 'executeRevenueTool'],
  ['tech-tools', 'TECH_TOOLS', 'executeTechTool'],
  ['review-tools', 'REVIEW_TOOLS', 'executeReviewTool'],
  ['comms-tools', 'COMMS_TOOLS', 'executeCommsTool'],
  ['tax-tools', 'TAX_TOOLS', 'executeTaxTool'],
  ['leads-tools', 'LEADS_TOOLS', 'executeLeadsTool'],
  ['email-tools', 'EMAIL_TOOLS', 'executeEmailTool'],
  ['banking-tools', 'BANKING_TOOLS', 'executeBankingTool'],
  ['estimate-tools', 'ESTIMATE_TOOLS', 'executeEstimateTool'],
  ['customer-lifecycle-tools', 'CUSTOMER_LIFECYCLE_TOOLS', 'executeCustomerLifecycleTool'],
  ['history-tools', 'HISTORY_TOOLS', 'executeHistoryTool'],
  ['ops-tools', 'OPS_TOOLS', 'executeOpsTool'],
  ['sentry-ops-tools', 'SENTRY_OPS_TOOLS', 'executeSentryOpsTool'],
  ['cloudflare-ops-tools', 'CLOUDFLARE_OPS_TOOLS', 'executeCloudflareOpsTool'],
  ['twilio-ops-tools', 'TWILIO_OPS_TOOLS', 'executeTwilioOpsTool'],
  ['stripe-ops-tools', 'STRIPE_OPS_TOOLS', 'executeStripeOpsTool'],
  ['github-ops-tools', 'GITHUB_OPS_TOOLS', 'executeGithubOpsTool'],
  ['store-ops-tools', 'STORE_OPS_TOOLS', 'executeStoreOpsTool'],
  ['growthbook-tools', 'GROWTHBOOK_TOOLS', 'executeGrowthbookTool'],
  ['google-ads-ops-tools', 'GOOGLE_ADS_OPS_TOOLS', 'executeGoogleAdsOpsTool'],
  ['token-health-tools', 'TOKEN_HEALTH_TOOLS', 'executeTokenHealthTool'],
  ['sendgrid-ops-tools', 'SENDGRID_OPS_TOOLS', 'executeSendgridOpsTool'],
  ['dataforseo-ops-tools', 'DATAFORSEO_OPS_TOOLS', 'executeDataforseoOpsTool'],
  ['gbp-ops-tools', 'GBP_OPS_TOOLS', 'executeGbpOpsTool'],
  ['ga4-ops-tools', 'GA4_OPS_TOOLS', 'executeGa4OpsTool'],
  ['meta-ads-ops-tools', 'META_ADS_OPS_TOOLS', 'executeMetaAdsOpsTool'],
  ['bouncie-ops-tools', 'BOUNCIE_OPS_TOOLS', 'executeBouncieOpsTool'],
  ['apify-ops-tools', 'APIFY_OPS_TOOLS', 'executeApifyOpsTool'],
  ['social-ops-tools', 'SOCIAL_OPS_TOOLS', 'executeSocialOpsTool'],
  ['managed-agents-ops-tools', 'MANAGED_AGENTS_OPS_TOOLS', 'executeManagedAgentsOpsTool'],
  ['job-health-tools', 'JOB_HEALTH_TOOLS', 'executeJobHealthTool'],
  ['call-research-tools', 'CALL_RESEARCH_TOOLS', 'executeCallResearchTool'],
  ['gap-report-tools', 'GAP_REPORT_TOOLS', 'executeGapReportTool'],
  ['needs-me-tools', 'NEEDS_ME_TOOLS', 'executeNeedsMeTool'],
  ['billing-reader-tools', 'BILLING_READER_TOOLS', 'executeBillingReaderTool'],
  ['billing-write-tools', 'BILLING_WRITE_TOOLS', 'executeBillingWriteTool'],
  ['estimate-accept-tools', 'ESTIMATE_ACCEPT_TOOLS', 'executeEstimateAcceptTool'],
  ['invoice-action-tools', 'INVOICE_ACTION_TOOLS', 'executeInvoiceActionTool'],
  ['choice-tools', 'CHOICE_TOOLS', 'executeChoiceTool'],
  ['admin-read-tools', 'ADMIN_READ_TOOLS', 'executeAdminReadTool'],
  ['admin-write-tools', 'ADMIN_WRITE_TOOLS', 'executeAdminWriteTool'],
  ['address-tools', 'ADDRESS_TOOLS', 'executeAddressTool'],
];

const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false });
addFormats(ajv);
const actions = new Map();
const policyErrors = [];
for (const [moduleName, exportName, executeName] of MODULES) {
  const mod = require(`./${moduleName}`);
  for (const tool of mod[exportName] || []) {
    const p = policy[tool.name];
    const approval = UI_GATED_WRITE_TOOL_NAMES.has(tool.name) ? 'ui_confirm'
      : CONFIRMED_ENDPOINT_WRITE_TOOL_NAMES.has(tool.name) ? 'confirmed_endpoint' : null;
    if (!p || p.module !== `${moduleName}.js` || p.approval !== approval
      || !['read', 'internal_write', 'external_action'].includes(p.kind)
      || (p.kind === 'read') !== (approval === null)
      || !['admin', 'technician_or_admin'].includes(p.role)
      || (p.role === 'technician_or_admin' && (moduleName !== 'tech-tools' || p.kind !== 'read'))
      // A tool without a reviewed data scope is unreachable: not discoverable,
      // not executable, and refused by the task-context guards (scope-policy.js).
      || !validScope(p)
      || typeof mod[executeName] !== 'function' || actions.has(tool.name)) {
      policyErrors.push(tool.name);
      continue;
    }
    // Reject extra top-level fields, including actor/approval/hidden pin injection.
    // Existing domain schemas retain their nested semantics and validators.
    const schema = { ...tool.input_schema, additionalProperties: false };
    actions.set(tool.name, {
      id: tool.name, ...p, schema, definition: apiToolDefinition(tool),
      validate: ajv.compile(schema), executor: mod[executeName],
      retry: p.kind === 'read' ? 'read_only' : 'reconcile_before_retry',
      verification: 'domain_result',
    });
  }
}

const DISCOVERY_TOOL = {
  name: 'discover_capabilities',
  description: 'Find and load authorized tools across the whole admin portal. Search before claiming a capability is unavailable. Page context never restricts these results. Returns actual support or a specific unavailable reason; it does not execute an action.',
  strict: true,
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 300 },
      domain: { type: 'string', description: 'Optional domain, such as procurement, estimate, schedule, customers, email, or banking.' },
    },
    required: ['query'],
  },
};
const validateDiscovery = ajv.compile(DISCOVERY_TOOL.input_schema);
const DISCOVERY_STOPWORDS = new Set('a an the i me my we our you your it this that these those do does did can could will would should please like want need to for from of on in with is are be have has and or what how get find show search list'.split(' '));

// Actions offered only while their own gate reads on (read at call time).
const GATED_ACTIONS = {
  reprice_future_visits: () => repriceVisitsLive(),
  search_ib_history: () => threadsEnabled(),
  merge_customers: () => mergeCustomersEnabled(),
  delete_duplicate_customer: () => deleteDuplicateCustomerEnabled(),
  send_invoice: () => invoiceActionsLive(),
  accept_estimate: () => ibAcceptEstimateLive(),
  find_admin_reads: () => adminReadLive(),
  read_admin_data: () => adminReadLive(),
  find_admin_edits: () => adminWriteLive(),
  propose_admin_edit: () => adminWriteLive(),
};

function allowed(action, { role, context, fullAccess } = {}) {
  if (!action) return false;
  if (context === 'agent_estimate' && !AGENT_ESTIMATE_TOOL_NAMES.has(action.id)) return false;
  if (role !== 'admin') return role === 'technician' && action.role === 'technician_or_admin';
  if (context === 'tech') return action.role === 'technician_or_admin';
  if (GATED_ACTIONS[action.id] && !GATED_ACTIONS[action.id]()) return false;
  // The dedicated lead-drafting rail has its own per-user gate and narrower
  // business contract. The global assistant uses the ordinary estimate path.
  if (action.id === 'create_agent_estimate_draft' && context !== 'agent_estimate') return false;
  // Outside-service writes (IB scope expansion item 1, owner ruling
  // 2026-09-28): full-access-only, unlike every other yellow-tier
  // (WRITE_TWO_STEP) tool, which any admin gets. Mirrors the
  // CONFIRMED_ENDPOINT red-tier restriction below execute()'s own explicit
  // refusal, but these ARE structurally two-step (a card), so they need
  // their own check here rather than the blanket approval-kind refusal.
  if (FULL_ACCESS_TWO_STEP_TOOL_NAMES.has(action.id) && fullAccess !== true) return false;
  // General admin reads (owner ruling 2026-10-12): owner login only.
  if (FULL_ACCESS_READ_TOOL_NAMES.has(action.id) && fullAccess !== true) return false;
  return true;
}

function validateInput(name, input, scope) {
  const action = actions.get(name);
  if (name !== DISCOVERY_TOOL.name && !action) return { error: 'Capability is not implemented or has no reviewed action policy', code: 'capability_unimplemented' };
  if (name === DISCOVERY_TOOL.name ? (scope?.role !== 'admin' || ['tech', 'agent_estimate'].includes(scope?.context)) : !allowed(action, scope)) {
    return { error: 'Your current role or feature access does not permit this capability', code: 'permission_denied' };
  }
  const validate = name === DISCOVERY_TOOL.name ? validateDiscovery : action.validate;
  if (!validate(input)) return {
    error: 'Tool arguments do not match the required inputs', code: 'invalid_input',
    fields: (validate.errors || []).map(e => ({ path: e.instancePath, rule: e.keyword })),
  };
  return null;
}

function discover(input, scope) {
  const failure = validateInput(DISCOVERY_TOOL.name, input, scope);
  if (failure) return { result: failure, definitions: [] };
  const terms = [...new Set(input.query.toLowerCase().match(/[a-z0-9]+/g) || [])]
    .filter(term => !DISCOVERY_STOPWORDS.has(term));
  // The model's domain is a ranking hint, never a filter: booking lives under
  // "customers", so a "schedule" search used to return every schedule tool
  // and not the one that books (owner IB history 10-12). A matching tool in
  // the named domain ranks one point higher and wins ties.
  const inDomain = a => (input.domain && a.domain === input.domain ? 1 : 0);
  const ranked = [...actions.values()].filter(a => allowed(a, scope))
    .map(a => {
      const words = new Set(`${a.id.replace(/_/g, ' ')} ${a.domain} ${a.definition.description}`.toLowerCase().match(/[a-z0-9]+/g) || []);
      return { action: a, score: terms.reduce((n, word) => n + (words.has(word) ? 1 : 0), 0) };
    }).filter(r => r.score > 0)
    .sort((a, b) => (b.score + inDomain(b.action)) - (a.score + inDomain(a.action))
      || inDomain(b.action) - inDomain(a.action) || a.action.id.localeCompare(b.action.id));
  const selected = ranked.slice(0, 12).map(r => r.action);
  return {
    definitions: selected.filter(a => a.approval !== 'confirmed_endpoint').map(a => a.definition),
    result: {
      status: selected.length ? 'capabilities_found' : 'capability_unimplemented',
      capabilities: selected.map(a => ({ id: a.id, description: a.definition.description, domain: a.domain,
        kind: a.kind, approval: a.approval, retry: a.retry,
        availability: a.approval === 'confirmed_endpoint' ? 'requires_existing_owner_workflow' : 'loaded' })),
      more_available: ranked.length > selected.length,
      note: 'Use only the listed executors. A lookup or a proposal is not a completed write. Missing capability results describe this catalog, not whether records exist.',
    },
  };
}

// Core reads/writes preloaded on EVERY admin page (owner IB history 10-06:
// ~25 asks — stock counts, a second property, a lead's name, an estimate's
// line prices, open slots — failed with "no tool" because the operator was on
// the Customers page or dashboard). Only the OFFERED list widens: allowed()
// still applies role/context, and every write keeps its ui_confirm card.
const EVERY_PAGE_TOOL_NAMES = Object.freeze([
  'add_customer_property', 'set_primary_property', 'update_customer_property', 'remove_customer_property',
  'update_lead_contact', 'update_lead_status',
  'query_stock', 'adjust_stock', 'query_products',
  'get_estimate_detail', 'find_available_slots',
  // Tap-to-answer buttons for a "which value?" question (choice-tools.js):
  // display only, reads and writes nothing.
  'offer_choices',
  // Google address check (address-tools.js): run before any address write so a
  // dictated street gets Google's spelling and ZIP, never a guessed one.
  'check_address',
  // Owner IB history 10-12: on the dashboard the bar answered "no
  // appointment-creation tool" (booking is filed under customers, and its
  // schedule-domain search missed it), and a "fix the address from the last
  // call" ask spent its rounds discovering the call log and the customer edit.
  'create_appointment', 'reschedule_appointment', 'cancel_appointment',
  'update_customer', 'get_call_log',
  // The general admin read (owner ruling 2026-10-12): the finder AND the read,
  // so a request on any page can search the reviewed read list and call the
  // result on the next round without a discover_capabilities detour (words like
  // "show blocked numbers" match neither static description). Still subject to
  // allowed(): GATE_IB_GENERAL_READ on AND the owner login (full access), so
  // other admins, technicians, the tech rail and a gate-off deploy never see
  // them. With GATE_IB_TOOL_SEARCH the eager page list is built without full
  // access, so they are deferred and searchable there instead.
  'find_admin_reads', 'read_admin_data',
]);

// Page-specific additions beyond a page's own domain (owner ruling 2026-10-07
// Q5: "he accepted" is said on the Customers page and the dashboard too).
const PAGE_EXTRA_TOOL_NAMES = Object.freeze({ customers: ['accept_estimate'], dashboard: ['accept_estimate'] });

// An ordinary admin page: not the technician rail and not the dedicated
// estimate-drafting rail, both of which keep their own narrow tool lists.
function isOrdinaryAdminPage(context, scope) {
  return scope.role === 'admin' && !['tech', 'agent_estimate'].includes(context);
}

// The tool list a page opens with (common + every-page + the page's domain),
// without the discovery tool.
function pageTools(context, scope) {
  const domain = { estimates: 'estimate', agent_estimate: 'estimate', inventory: 'procurement', dispatch: 'schedule', reviews: 'review', blog: 'seo' }[context] || context;
  const common = new Set(['query_customers', 'get_customer_detail', 'get_schedule_view', 'query_leads', 'list_gap_reports', 'needs_me', ...EVERY_PAGE_TOOL_NAMES, ...(PAGE_EXTRA_TOOL_NAMES[context] || [])]);
  // send_invoice (domain customers) also rides the Invoices / Revenue page and dashboard (owner 2026-10-07).
  if (context === 'revenue' || context === 'dashboard') common.add('send_invoice');
  // reprice_future_visits (domain schedule) also rides the Customers page and dashboard (owner 2026-10-07).
  if (context === 'customers' || context === 'dashboard') common.add('reprice_future_visits');
  return [...actions.values()]
    .filter(a => allowed(a, { ...scope, context }) && a.approval !== 'confirmed_endpoint' && (context === 'agent_estimate' || common.has(a.id) || a.domain === domain))
    .map(a => a.definition);
}

// The API's own tool search (GA, no beta header; supported on MODELS.FLAGSHIP
// and newer). Never deferred, never given cache_control.
const TOOL_SEARCH_TOOL = Object.freeze({ type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' });

// Owner ruling 2026-10-12 (the bar must reach everything on the owner login),
// shaped for tool selection: Anthropic documents accuracy degrading past 30 to
// 50 active tools, so the owner keeps exactly the page list a plain admin gets
// (eager, INCLUDING discover_capabilities: it is the route to actions that are
// not callable tools, such as owner-workflow ones), plus the API's tool search,
// plus every other allowed tool with defer_loading true, sorted by name.
// Deferred tools sit outside the cached prefix and a discovered one is appended
// inline, so the cache is untouched. The deferred copies are NEW objects: the
// registry's own definitions stay non-deferred for every other request.
// allowed() still decides every entry (gated tools, FULL_ACCESS_TWO_STEP tools)
// and confirmed_endpoint tools are never loaded.
function toolSearchTools(context, scope) {
  const eager = [DISCOVERY_TOOL, ...pageTools(context, { ...scope, fullAccess: false })];
  const eagerNames = new Set(eager.map(tool => tool.name));
  const deferred = [...actions.values()]
    .filter(a => allowed(a, { ...scope, context }) && a.approval !== 'confirmed_endpoint' && !eagerNames.has(a.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(a => ({ ...a.definition, defer_loading: true }));
  return [...eager, TOOL_SEARCH_TOOL, ...deferred];
}

// scope.toolSearch is set by the route from GATE_IB_TOOL_SEARCH (or a resumed
// history that already holds tool-search blocks) and the authenticated login
// (scope.fullAccess), never from model input.
function initialTools(context, scope) {
  const ordinary = isOrdinaryAdminPage(context, scope);
  if (ordinary && scope.fullAccess === true && scope.toolSearch === true) return toolSearchTools(context, scope);
  return [...(ordinary ? [DISCOVERY_TOOL] : []), ...pageTools(context, scope)];
}

function execute(name, input, { role, context, techContext, actionContext = {} } = {}) {
  const action = actions.get(name);
  // fullAccess travels on actionContext (set by the route from the
  // authenticated request, never from model input) rather than as its own
  // top-level param, so every existing caller of execute() stays unchanged.
  if (!allowed(action, { role, context, fullAccess: actionContext.fullAccess === true })) {
    return Promise.resolve({ error: 'Capability is unavailable to this actor', code: 'permission_denied' });
  }
  if (role === 'technician' && (typeof techContext?.techId !== 'string' || !techContext.techId.trim())) {
    return Promise.resolve({ error: 'A verified technician identity is required', code: 'permission_denied' });
  }
  if (action.approval === 'confirmed_endpoint') {
    return Promise.resolve({ error: 'Use the existing owner approval workflow for this action', code: 'requires_existing_owner_workflow' });
  }
  if (action.kind !== 'read' && actionContext.confirmed !== true && !WRITE_TWO_STEP_TOOL_NAMES.has(name)) {
    return Promise.resolve({ error: 'Explicit approval is required', code: 'approval_required' });
  }
  const invalid = validateInput(name, input, { role, context, fullAccess: actionContext.fullAccess === true });
  if (invalid) return Promise.resolve(invalid);
  // Server pins travel separately from schema-validated model arguments.
  // No input.confirmed/confirm or model-supplied hidden field can approve a
  // two-step executor. Confirm is derived solely from authenticated routing.
  const pins = Object.fromEntries(Object.entries(actionContext.executionPins || {}).filter(([key]) => key.startsWith('_')));
  const executionInput = { ...input, ...pins,
    ...(WRITE_TWO_STEP_TOOL_NAMES.has(name) ? { confirmed: actionContext.confirmed === true } : {}) };
  return action.executor(name, executionInput, action.module === 'tech-tools.js' ? (techContext || {}) : actionContext);
}

module.exports = { actions, policyErrors, DISCOVERY_TOOL, TOOL_SEARCH_TOOL, EVERY_PAGE_TOOL_NAMES, initialTools, discover, validateInput, allowed, execute };

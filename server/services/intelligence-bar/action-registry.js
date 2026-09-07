/**
 * Server-owned catalog over the existing TOOLS + executeTool modules.
 * Policy is explicit: a new/unclassified tool cannot be discovered or executed.
 * No model-supplied module, URL, SQL, actor, or approval is executable here.
 */
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const policy = require('./action-policy.json');
const { UI_GATED_WRITE_TOOL_NAMES, WRITE_TWO_STEP_TOOL_NAMES, CONFIRMED_ENDPOINT_WRITE_TOOL_NAMES } = require('./write-gates');
const { threadsEnabled } = require('./threads');

const MODULES = [
  ['tools', 'TOOLS', 'executeTool'],
  ['schedule-tools', 'SCHEDULE_TOOLS', 'executeScheduleTool'],
  ['closeout-tools', 'CLOSEOUT_TOOLS', 'executeCloseoutTool'],
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
      || typeof mod[executeName] !== 'function' || actions.has(tool.name)) {
      policyErrors.push(tool.name);
      continue;
    }
    // Reject extra top-level fields, including actor/approval/hidden pin injection.
    // Existing domain schemas retain their nested semantics and validators.
    const schema = { ...tool.input_schema, additionalProperties: false };
    actions.set(tool.name, {
      id: tool.name, ...p, schema, definition: tool,
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

function allowed(action, { role, context } = {}) {
  if (!action) return false;
  if (role !== 'admin') return role === 'technician' && action.role === 'technician_or_admin';
  if (context === 'tech') return action.role === 'technician_or_admin';
  if (action.id === 'search_ib_history' && !threadsEnabled()) return false;
  // The dedicated lead-drafting rail has its own per-user gate and narrower
  // business contract. The global assistant uses the ordinary estimate path.
  if (action.id === 'create_agent_estimate_draft' && context !== 'agent_estimate') return false;
  return true;
}

function validateInput(name, input, scope) {
  const action = actions.get(name);
  if (name !== DISCOVERY_TOOL.name && !action) return { error: 'Capability is not implemented or has no reviewed action policy', code: 'capability_unimplemented' };
  if (name === DISCOVERY_TOOL.name ? scope?.role !== 'admin' : !allowed(action, scope)) {
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
  const terms = input.query.toLowerCase().match(/[a-z0-9]+/g) || [];
  const ranked = [...actions.values()].filter(a => allowed(a, scope) && (!input.domain || a.domain === input.domain))
    .map(a => {
      const text = `${a.id.replace(/_/g, ' ')} ${a.domain} ${a.definition.description}`.toLowerCase();
      return { action: a, score: terms.reduce((n, word) => n + (text.includes(word) ? 1 : 0), 0) };
    }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.action.id.localeCompare(b.action.id));
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

function initialTools(context, scope) {
  const domain = { estimates: 'estimate', inventory: 'procurement', dispatch: 'schedule', reviews: 'review', blog: 'seo' }[context] || context;
  const common = new Set(['query_customers', 'get_customer_detail', 'get_schedule_view', 'query_products', 'query_leads']);
  return [DISCOVERY_TOOL, ...[...actions.values()]
    .filter(a => allowed(a, scope) && a.approval !== 'confirmed_endpoint' && (common.has(a.id) || a.domain === domain))
    .map(a => a.definition)];
}

function execute(name, input, { role, context, techContext, actionContext = {} } = {}) {
  const action = actions.get(name);
  if (!allowed(action, { role, context })) return Promise.resolve({ error: 'Capability is unavailable to this actor', code: 'permission_denied' });
  if (action.kind !== 'read' && actionContext.confirmed !== true && !WRITE_TWO_STEP_TOOL_NAMES.has(name)) {
    return Promise.resolve({ error: 'Explicit approval is required', code: 'approval_required' });
  }
  return action.executor(name, input, action.module === 'tech-tools.js' ? (techContext || {}) : actionContext);
}

module.exports = { actions, policyErrors, DISCOVERY_TOOL, initialTools, discover, validateInput, allowed, execute };

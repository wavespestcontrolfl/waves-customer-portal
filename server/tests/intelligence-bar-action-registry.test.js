process.env.JWT_SECRET = 'synthetic-ib-test';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const registry = require('../services/intelligence-bar/action-registry');
const { tierFor } = require('../services/intelligence-bar/authorization-contract');

test('every tool-bearing module in the existing tool census joins the registry', () => {
  const fs = require('fs'), path = require('path');
  const directory = path.join(__dirname, '../services/intelligence-bar');
  for (const file of fs.readdirSync(directory).filter(name => name === 'tools.js' || name.endsWith('-tools.js'))) {
    const definitions = Object.values(require(path.join(directory, file))).filter(Array.isArray).flat()
      .filter(tool => tool && typeof tool.name === 'string' && tool.input_schema?.type === 'object');
    for (const definition of definitions) expect(registry.actions.get(definition.name)?.module).toBe(file);
  }
});

test('a proposal-pinned customer id validates for reply_via_sms while a forged one fails', () => {
  const scope = { role: 'admin', context: 'platform' };
  const pinned = { email_id: '10000000-0000-4000-8000-000000000001', message: 'On our way', customer_id: '10000000-0000-4000-8000-000000000002' };
  expect(registry.validateInput('reply_via_sms', pinned, scope)).toBeNull();
  expect(registry.validateInput('reply_via_sms', { ...pinned, customer_id: 'not-a-uuid' }, scope)).toMatchObject({ code: 'invalid_input' });
});

test('every existing tool has an explicit valid policy and a concrete executor', () => {
  expect(registry.policyErrors).toEqual([]);
  expect(registry.actions.size).toBe(Object.keys(require('../services/intelligence-bar/action-policy.json')).length);
  for (const action of registry.actions.values()) {
    expect(typeof action.executor).toBe('function');
    if (action.kind !== 'read') expect(action.approval).toMatch(/^(ui_confirm|confirmed_endpoint)$/);
  }
});

test('Estimates can discover real inventory executors without preloading every definition', () => {
  const scope = { role: 'admin', context: 'estimates' };
  const initial = registry.initialTools(scope.context, scope);
  expect(initial.length).toBeLessThan(40);
  expect(initial.some(t => t.name === 'create_restock_request')).toBe(false);
  const found = registry.discover({ query: 'save inventory restock request', domain: 'procurement' }, scope);
  expect(found.definitions.some(t => t.name === 'create_restock_request')).toBe(true);
  expect(found.result.capabilities).toContainEqual(expect.objectContaining({
    id: 'create_restock_request', kind: 'internal_write', approval: 'ui_confirm', availability: 'loaded',
  }));
});

test('the dedicated agent estimate workflow preloads its permitted draft tool', () => {
  const scope = { role: 'admin', context: 'agent_estimate' };
  expect(registry.initialTools(scope.context, scope).some(tool => tool.name === 'create_agent_estimate_draft')).toBe(true);
  expect(registry.initialTools('estimates', { ...scope, context: 'estimates' }).some(tool => tool.name === 'create_agent_estimate_draft')).toBe(false);
});

test('vendor price comparison preserves the documented product ID or name alternatives', () => {
  const scope = { role: 'admin', context: 'inventory' };
  expect(registry.validateInput('compare_vendor_pricing', { product_id: '10000000-0000-4000-8000-000000000001' }, scope)).toBeNull();
  expect(registry.validateInput('compare_vendor_pricing', { product_name: 'Synthetic product' }, scope)).toBeNull();
  expect(registry.validateInput('compare_vendor_pricing', {}, scope)).toMatchObject({ code: 'invalid_input' });
  expect(registry.validateInput('compare_vendor_pricing', { product_id: 'invalid' }, scope)).toMatchObject({ code: 'invalid_input' });
});

test('technicians cannot discover admin tools or forge a tool scope', async () => {
  const scope = { role: 'technician', context: 'estimates' };
  expect(registry.discover({ query: 'customer inventory' }, scope).result.code).toBe('permission_denied');
  expect(registry.validateInput('update_customer', { customer_id: 'fixture' }, scope).code).toBe('permission_denied');
  expect(await registry.execute('send_sms', {}, scope)).toMatchObject({ code: 'permission_denied' });
  expect(registry.initialTools('tech', { role: 'technician', context: 'tech' }).some(t => t.name === 'discover_capabilities')).toBe(false);
  expect(registry.initialTools('tech', { role: 'admin', context: 'tech' }).some(t => t.name === 'discover_capabilities')).toBe(false);
});

test('execute validates raw model arguments before a two-step executor can see approval fields', async () => {
  const action = registry.actions.get('create_customer');
  const original = action.executor;
  action.executor = jest.fn(async (_name, input) => ({ confirmed: input.confirmed }));
  const scope = { role: 'admin', context: 'customers' };
  const input = { first_name: 'Synthetic', last_name: 'Person', phone: '+15550101234' };
  try {
    expect(await registry.execute('create_customer', { ...input, confirmed: true }, scope)).toMatchObject({ code: 'invalid_input' });
    expect(await registry.execute('create_customer', { ...input, _approved: true }, scope)).toMatchObject({ code: 'invalid_input' });
    expect(action.executor).not.toHaveBeenCalled();
    expect(await registry.execute('create_customer', input, scope)).toEqual({ confirmed: false });
    expect(await registry.execute('create_customer', input, { ...scope, actionContext: { confirmed: true,
      executionPins: { _ib_customer_version: 'server-version', confirmed: false } } })).toEqual({ confirmed: true });
    expect(action.executor.mock.calls.at(-1)[1]).toMatchObject({ _ib_customer_version: 'server-version', confirmed: true });
  } finally { action.executor = original; }
});

test('unknown classification, coerced quantities, and injected approval/actor fields fail closed', () => {
  const scope = { role: 'admin', context: 'estimates' };
  expect(registry.validateInput('arbitrary_action', {}, scope).code).toBe('capability_unimplemented');
  expect(registry.validateInput('query_products', { limit: '10' }, scope).code).toBe('invalid_input');
  expect(registry.validateInput('query_products', { actorId: 'another-actor' }, scope).code).toBe('invalid_input');
  expect(registry.validateInput('query_products', { _approved: true }, scope).code).toBe('invalid_input');
  expect(tierFor('arbitrary_action')).toBe('unknown');
});

test('a legacy bare write cannot execute through the registry without server confirmation', async () => {
  expect(await registry.execute('send_sms', { confirmed: true }, { role: 'admin', context: 'customers' }))
    .toMatchObject({ code: 'approval_required' });
});

test('restricted owner actions remain in their existing workflow and do not become query tools', () => {
  const found = registry.discover({ query: 'request instant payout', domain: 'banking' }, { role: 'admin', context: 'customers' });
  expect(found.definitions.some(t => t.name === 'request_instant_payout')).toBe(false);
  expect(found.result.capabilities).toContainEqual(expect.objectContaining({
    id: 'request_instant_payout', availability: 'requires_existing_owner_workflow', approval: 'confirmed_endpoint',
  }));
});


test('merge_customers is allowed on the platform path only while GATE_IB_MERGE_CUSTOMERS is on (Codex r14 P1)', async () => {
  const action = registry.actions.get('merge_customers');
  expect(action).toBeTruthy();
  const scope = { role: 'admin', context: 'customers' };
  const original = process.env.GATE_IB_MERGE_CUSTOMERS;
  try {
    delete process.env.GATE_IB_MERGE_CUSTOMERS;
    expect(registry.allowed(action, scope)).toBe(false);
    expect(registry.initialTools('customers', scope).map(t => t.name)).not.toContain('merge_customers');
    expect(await registry.execute('merge_customers', { winner_customer_id: '10000000-0000-4000-8000-000000000001', loser_customer_id: '10000000-0000-4000-8000-000000000002' }, { ...scope, actionContext: { confirmed: true } }))
      .toMatchObject({ code: 'permission_denied' });
    process.env.GATE_IB_MERGE_CUSTOMERS = 'true';
    expect(registry.allowed(action, scope)).toBe(true);
  } finally {
    if (original === undefined) delete process.env.GATE_IB_MERGE_CUSTOMERS; else process.env.GATE_IB_MERGE_CUSTOMERS = original;
  }
});

test('dedicated estimate cabinet excludes every unrelated write and admin discovery', async () => {
  const scope = { role: 'admin', context: 'agent_estimate' };
  const names = require('../services/intelligence-bar/agent-estimate-policy');
  for (const context of [undefined, 'estimates', 'agent_estimate']) {
    expect(registry.initialTools('agent_estimate', { role: 'admin', context }).map(t => t.name).sort()).toEqual([...names].sort());
  }
  expect(registry.discover({ query: 'create estimate inventory' }, scope).result.code).toBe('permission_denied');
  for (const action of registry.actions.values()) {
    if (names.has(action.id)) continue;
    expect(registry.allowed(action, scope)).toBe(false);
    expect(await registry.execute(action.id, {}, { ...scope, actionContext: { confirmed: true } }))
      .toMatchObject({ code: 'permission_denied' });
  }
});

test('technician execution cannot fall through to the unscoped admin executor', async () => {
  const action = registry.actions.get('get_my_route'), original = action.executor;
  action.executor = jest.fn(async (_name, _input, context) => ({ techId: context.techId || null }));
  const scope = { role: 'technician', context: 'tech' };
  try {
    for (const techContext of [undefined, {}, { techId: '' }, { techId: ' ' }, { techName: 'Synthetic' }]) {
      expect(await registry.execute(action.id, {}, { ...scope, techContext })).toMatchObject({ code: 'permission_denied' });
    }
    expect(action.executor).not.toHaveBeenCalled();
    const techId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(await registry.execute(action.id, {}, { ...scope, techContext: { techId } })).toEqual({ techId });
    expect(await registry.execute(action.id, {}, { role: 'admin', context: 'tech' })).toEqual({ techId: null });
  } finally { action.executor = original; }
});

test('sender blocking declares its Gmail filter side effect', () => {
  expect(registry.actions.get('block_sender')).toMatchObject({ kind: 'external_action', approval: 'ui_confirm' });
});


test('initial and discovered model tools exclude local contract metadata', () => {
  const scope = { role: 'admin', context: 'schedule' };
  for (const action of registry.actions.values()) {
    expect(Object.keys(action.definition).filter(key => key.startsWith('_'))).toEqual([]);
  }
  const initial = registry.initialTools('schedule', scope);
  expect(initial.some(tool => tool.name === 'switch_appointment_property')).toBe(true);
  const discovered = registry.discover({ query: 'switch appointment property', domain: 'schedule' }, scope).definitions;
  expect(discovered.some(tool => tool.name === 'switch_appointment_property')).toBe(true);
  for (const tool of [...initial, ...discovered]) {
    expect(Object.keys(tool).filter(key => key.startsWith('_'))).toEqual([]);
  }
  const original = require('../services/intelligence-bar/schedule-tools').SCHEDULE_TOOLS
    .find(tool => tool.name === 'switch_appointment_property');
  expect(original._sideEffects).toBe(true);
});

test('registry cannot directly execute owner-endpoint actions even with confirmation', async () => {
  for (const action of registry.actions.values()) {
    if (action.approval !== 'confirmed_endpoint') continue;
    const original = action.executor;
    action.executor = jest.fn();
    try {
      for (const confirmed of [false, true]) {
        expect(await registry.execute(action.id, {}, { role: 'admin', context: action.domain,
          actionContext: { confirmed, requestedBy: 'synthetic-owner' } }))
          .toMatchObject({ code: 'requires_existing_owner_workflow' });
      }
      expect(action.executor).not.toHaveBeenCalled();
    } finally { action.executor = original; }
  }
});


test('discovery requires meaningful whole-word matches instead of stopword substrings', () => {
  const scope = { role: 'admin', context: 'customers' };
  for (const query of ['do a frobnicate', 'I would like to frobnicate', 'a I the', 'frobnicate']) {
    expect(registry.discover({ query }, scope)).toMatchObject({ definitions: [], result: { status: 'capability_unimplemented' } });
  }
  expect(registry.discover({ query: 'please create a restock request', domain: 'procurement' }, scope).definitions
    .some(tool => tool.name === 'create_restock_request')).toBe(true);
});

test('appointment cancellation declares its possible Stripe follow-through effect', () => {
  expect(registry.actions.get('cancel_appointment')).toMatchObject({ kind: 'external_action', approval: 'ui_confirm' });
});


test('generic lookup verbs cannot make an unsupported capability appear discovered', () => {
  for (const verb of ['get', 'find', 'show', 'search', 'list']) {
    expect(registry.discover({ query: `${verb} a frobnicate` }, { role: 'admin', context: 'customers' }))
      .toMatchObject({ definitions: [], result: { status: 'capability_unimplemented' } });
  }
  expect(registry.discover({ query: 'get inventory stock' }, { role: 'admin', context: 'customers' })
    .definitions.length).toBeGreaterThan(0);
});

// ─── Data-scope catalog (scope-policy.js) ───────────────────────────────
// Membership lives in action-policy.json. These lists are the frozen policy
// snapshot: a tool cannot silently leave a class or join the registry without
// one. Change a list here first, then the policy file.
const SCOPE_SNAPSHOT = {
  broad: [
    'cancel_and_reschedule_far_out', 'export_payouts', 'find_duplicates', 'find_overdue_customers', 'find_similar_estimates',
    'get_ar_aging', 'get_blocked_senders', 'get_churn_analysis', 'get_csr_overview', 'get_day_summary', 'get_email_suppressions',
    'get_expenses', 'get_inbox_summary', 'get_my_route', 'get_outreach_candidates', 'get_outstanding_balances', 'get_payer_ar_aging',
    'get_payout_details', 'get_recent_completions', 'get_revenue_breakdown', 'get_stock_movements', 'get_stripe_payment_intents',
    'get_today_briefing', 'get_top_revenue_customers', 'get_truck_status', 'get_twilio_failed_messages', 'get_unanswered_threads',
    'get_unresponded_reviews', 'get_vendor_invoices', 'get_zone_density', 'list_call_partners', 'list_open_closeouts', 'search_reviews',
    // Provider and operations text that can echo customer identifiers (the
    // route's PII list): alert bodies, error text, log lines, targeting
    // predicates, trip traces, redacted call quotes still keyed by call id.
    'get_growthbook_experiments', 'get_growthbook_features', 'get_managed_agent_runs', 'get_railway_logs', 'get_scheduled_job_health',
    'get_sentry_issue_detail', 'get_sentry_new_issues', 'get_sentry_top_issues', 'get_truck_trips', 'get_twilio_alerts', 'search_call_research',
    // Operator free text passed through verbatim (a name or address can be
    // typed into any of these): technician notes and call snippets, restock
    // reasons, the pricing changelog, estimate service_interest, lost reasons.
    'get_estimate_funnel', 'get_lost_analysis', 'get_restock_queue', 'recent_pricing_changes', 'search_field_intelligence', 'search_knowledge_base',
    // customers.lead_source is operator free text ("Referral — <name>"); commit
    // messages and PR titles are developer free text where customer details
    // have appeared (AGENTS.md).
    'get_ad_attribution', 'get_customer_acquisition', 'get_commit_info', 'get_recent_merged_prs',
    // Social post titles and Google Business Profile post summaries are
    // business-authored free text a customer name or address can be typed into.
    'get_gbp_status', 'get_social_channel_status',
    // Blog and page titles, target keywords and concept labels are
    // operator-authored strings returned verbatim.
    'get_content_decay_alerts', 'get_content_pipeline', 'get_content_workflow_brief', 'get_semantic_concept_map', 'inspect_url',
    'query_blog_performance', 'query_seo_rankings',
    // Raw search queries, ad campaign/ad-group names and provider issue
    // messages, and deployment branch names are human-typed strings.
    'get_cloudflare_pages_builds', 'get_google_ads_disapprovals', 'get_google_ads_serving_status', 'get_meta_ads_delivery_status',
    'get_meta_ads_issues', 'intent_routing_report', 'query_top_queries',
    // Third-party anchor text + agent-written strategy summaries, provider
    // error messages, human-typed Play release names.
    'get_backlink_overview', 'get_integration_token_health', 'get_play_store_status',
  ],
  scoped: ['draft_email_reply', 'get_email_thread', 'get_schedule_view', 'get_stale_leads', 'match_existing_customer', 'query_customers', 'query_leads', 'search_emails'],
  actor_wide: ['search_ib_history'],
  phone_keyed: ['get_partner_call_history'],
  email_keyed: ['check_email_suppression'],
  address_keyed: ['lookup_property'],
  route_wide: ['optimize_all_routes', 'optimize_tech_route', 'swap_tech_assignments'],
  record: [
    // reads: a customer or record selector confines the rows to one customer
    'check_customer_status', 'compute_estimate', 'draft_review_reply', 'draft_sms', 'draft_sms_reply', 'find_available_slots', 'find_schedule_gaps',
    'get_call_log', 'get_closeout_status', 'get_conversation_thread', 'get_customer_detail', 'get_customer_estimate_context', 'get_estimate_detail',
    'get_open_commitments', 'get_service_history',
    'get_stop_details', 'query_revenue', 'search_messages',
    // writes: specific customer records proven by validateRecordTarget
    // block_sender carries no record id; validateSenderBlock binds it to the task customer's own address.
    // merge_customers' winner/loser ids are mapped to the customer collection by validateRecordTarget
    // (CUSTOMER_PAIR_SELECTORS), so both halves must belong to the task's customers.
    'add_customer_property', 'assign_technician', 'block_sender', 'bulk_update_customers', 'bulk_update_leads', 'cancel_appointment', 'cancel_plan',
    'create_agent_estimate_draft',
    'create_appointment', 'create_customer', 'create_pending_estimate', 'merge_customers', 'move_stops_to_day', 'reply_via_sms', 'reschedule_appointment',
    'save_customer_estimate', 'send_email_reply', 'send_sms', 'set_estimate_presentation', 'set_primary_property', 'submit_review_reply',
    'switch_appointment_property', 'toggle_estimate_v2_view', 'toggle_show_one_time_option', 'trigger_review_request', 'update_customer',
    'update_customer_property', 'update_lead_status', 'update_property_access',
  ],
};

test('every tool declares a data scope that is valid for its kind', () => {
  const scopePolicy = require('../services/intelligence-bar/scope-policy');
  const policy = require('../services/intelligence-bar/action-policy.json');
  for (const [name, entry] of Object.entries(policy)) {
    expect({ name, valid: scopePolicy.validScope(entry) }).toEqual({ name, valid: true });
    expect({ name, scope: scopePolicy.scopeOf(name) }).toEqual({ name, scope: entry.scope });
    expect(registry.actions.get(name).scope).toBe(entry.scope);
  }
  expect(scopePolicy.scopeOf('arbitrary_action')).toBeNull();
});

test('the non-trivial scope classes match the frozen snapshot and no tool sits in two of them', () => {
  const { toolsWithScope, READ_SCOPES, WRITE_SCOPES } = require('../services/intelligence-bar/scope-policy');
  for (const [scope, names] of Object.entries(SCOPE_SNAPSHOT)) expect(toolsWithScope(scope)).toEqual([...names].sort());
  const classified = Object.values(SCOPE_SNAPSHOT).flat();
  expect(new Set(classified).size).toBe(classified.length);
  const policy = require('../services/intelligence-bar/action-policy.json');
  for (const name of Object.keys(policy)) {
    if (!classified.includes(name)) expect({ name, scope: policy[name].scope }).toEqual({ name, scope: 'none' });
  }
  expect(READ_SCOPES).toEqual(['none', 'record', 'scoped', 'broad', 'actor_wide', 'phone_keyed', 'email_keyed', 'address_keyed']);
  expect(WRITE_SCOPES).toEqual(['none', 'record', 'route_wide']);
});

test('a reader whose schema takes a customer selector is never scope none', () => {
  for (const action of registry.actions.values()) {
    if (action.kind !== 'read') continue;
    const selector = ['customer_id', 'customer_name'].some(key => action.schema.properties?.[key]);
    if (selector) expect({ id: action.id, scope: action.scope }).toMatchObject({ id: action.id, scope: expect.stringMatching(/^(record|scoped)$/) });
  }
});

test('a tool with a missing or invalid scope never joins the registry', () => {
  const policy = require('../services/intelligence-bar/action-policy.json');
  const { scope: _dropped, ...unscoped } = policy.query_products;
  // Each entry is validated independently in the registry loop, so one
  // isolated load with four distinct broken tools proves every case.
  const broken = {
    query_products: unscoped, // missing
    query_vendors: { ...policy.query_vendors, scope: 'everything' }, // unknown class
    query_stock: { ...policy.query_stock, scope: 'route_wide' }, // write class on a read
    adjust_stock: { ...policy.adjust_stock, scope: 'broad' }, // read class on a write
  };
  jest.isolateModules(() => {
    jest.doMock('../services/intelligence-bar/action-policy.json', () => ({ ...policy, ...broken }));
    const isolated = require('../services/intelligence-bar/action-registry');
    expect([...isolated.policyErrors].sort()).toEqual(Object.keys(broken).sort());
    for (const name of Object.keys(broken)) {
      expect(isolated.actions.has(name)).toBe(false);
      expect(isolated.validateInput(name, {}, { role: 'admin', context: 'procurement' })).toMatchObject({ code: 'capability_unimplemented' });
    }
    expect(isolated.actions.size).toBe(Object.keys(policy).length - Object.keys(broken).length);
    jest.dontMock('../services/intelligence-bar/action-policy.json');
  });
});

test('every record reader carries a selector the task-context guards recognize', () => {
  // prepareReadInput binds customer_name/phone and injects the task customer
  // only through customer_id, and admits an unresolved-name call only through
  // hasOwnSelector; a record reader without one of these params would hand a
  // raw model-supplied selector to its executor.
  const selectorKeys = ['customer_id', 'customer_name', 'phone', 'service_id', 'candidate_service_id', 'customer_ids', 'service_ids', 'lead_ids',
    'customer_id', 'property_id', 'appointment_id', 'estimate_id', 'invoice_id', 'product_id', 'lead_id', 'email_id', 'call_id', 'review_id',
    'customerId', 'propertyId', 'appointmentId', 'estimateId', 'invoiceId', 'productId', 'leadId', 'emailId', 'callId', 'reviewId'];
  for (const action of registry.actions.values()) {
    if (action.kind !== 'read' || action.scope !== 'record') continue;
    const keys = Object.keys(action.schema.properties || {});
    expect({ id: action.id, selector: keys.some(key => selectorKeys.includes(key)) }).toEqual({ id: action.id, selector: true });
  }
});

test('every tool with a non-none scope is a PII tool, every reviewed PII tool is non-none, and only reviewed kinds have scopes', () => {
  const { PII_TOOL_NAMES, REVIEWED_PII_TOOL_NAMES } = require('../services/intelligence-bar/pii-tools');
  const { scopeOf, scopesFor, validScope } = require('../services/intelligence-bar/scope-policy');
  const policy = require('../services/intelligence-bar/action-policy.json');
  for (const name of REVIEWED_PII_TOOL_NAMES) {
    expect({ name, scope: scopeOf(name) }).toEqual({ name, scope: expect.stringMatching(/^(record|scoped|broad|actor_wide|phone_keyed|email_keyed|address_keyed|route_wide)$/) });
    expect(PII_TOOL_NAMES.has(name)).toBe(true);
  }
  // The route redacts telemetry for the derived set, so a reader that returns
  // customer identities is covered by its scope class, not by a hand-kept list.
  for (const name of Object.keys(policy)) {
    expect({ name, pii: PII_TOOL_NAMES.has(name) }).toEqual({ name, pii: policy[name].scope !== 'none' });
  }
  for (const name of ['get_ar_aging', 'get_outstanding_balances', 'get_top_revenue_customers', 'get_open_commitments', 'get_truck_status', 'find_schedule_gaps']) {
    expect(PII_TOOL_NAMES.has(name)).toBe(true);
  }
  expect(PII_TOOL_NAMES.has('get_kpi_snapshot')).toBe(false);
  for (const kind of [undefined, '', 'write', 'READ', 'internal-write']) {
    expect(scopesFor(kind)).toEqual([]);
    expect(validScope({ kind, scope: 'none' })).toBe(false);
    expect(validScope({ kind, scope: 'record' })).toBe(false);
  }
  expect(validScope({ kind: 'read', scope: 'route_wide' })).toBe(false);
  expect(validScope({ kind: 'external_action', scope: 'broad' })).toBe(false);
});

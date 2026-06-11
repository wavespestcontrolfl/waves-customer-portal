/**
 * Write-gate contract for Intelligence Bar tools — mechanical enforcement of
 * "no new bare writes" (issue #1568).
 *
 * Every registered tool must be classified below. A newly added tool fails
 * this suite until its author classifies it — and the only acceptable
 * classifications for a NEW write are WRITE_TWO_STEP (structural
 * preview→confirmed gate) or, once issue #1568 lands, the UI-backed
 * pending-action mechanism. The legacy bare-write set is a frozen by-name
 * snapshot: entries may be REMOVED as tools migrate, but no name may ever be
 * added — a diff that touches FROZEN_LEGACY_BARE_WRITES_2026_06_11 to add a
 * name is a policy violation, not a fix for this test.
 *
 * Tool modules are discovered from the filesystem (every *.js in
 * services/intelligence-bar/ except known non-tool helpers), so a future
 * module wired into admin-intelligence-bar.js is covered automatically.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  fn.raw = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Behavioral tests drive optimize_* far enough to invoke the optimizer —
// keep it off the network.
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.4, lng: -82.5 },
  optimizeRoute: jest.fn(async (stops) => ({
    orderedStops: stops,
    totalDistanceMeters: 10000,
    unoptimizedDistanceMeters: 16000,
    totalDurationSeconds: 1200,
    source: 'nearest_neighbor',
  })),
}));

const TOOLS_DIR = path.join(__dirname, '..', 'services', 'intelligence-bar');

// Helpers in services/intelligence-bar/ that are not tool modules. A new
// non-tool helper added to the directory must be listed here explicitly —
// otherwise the suite fails, which is the safe default.
const NON_TOOL_FILES = new Set(['circuit-breaker.js', 'tool-events.js', 'write-gates.js', 'pending-actions.js']);

function isToolShaped(entry) {
  return entry && typeof entry === 'object'
    && typeof entry.name === 'string'
    && entry.input_schema && typeof entry.input_schema === 'object';
}

// Returns [{ module, name, tool }] for every tool exported by every module in
// the directory. Modules may export multiple arrays (e.g. COMMS_TOOLS plus
// the COMMS_READ_TOOLS subset) — names are deduped per module so subset
// re-exports don't count as duplicate registrations.
function discoverAllTools() {
  const all = [];
  const files = fs.readdirSync(TOOLS_DIR).filter(f => f.endsWith('.js'));
  for (const file of files) {
    if (NON_TOOL_FILES.has(file)) continue;
    const mod = require(path.join(TOOLS_DIR, file));
    const seen = new Map();
    for (const value of Object.values(mod)) {
      if (!Array.isArray(value) || !value.length || !value.every(isToolShaped)) continue;
      for (const tool of value) {
        if (!seen.has(tool.name)) seen.set(tool.name, tool);
      }
    }
    if (seen.size === 0) {
      throw new Error(
        `services/intelligence-bar/${file} exports no tool array. ` +
        'If it is a non-tool helper, add it to NON_TOOL_FILES in this test; ' +
        'if it is a tool module, export an array of {name, input_schema} tools.'
      );
    }
    for (const [name, tool] of seen) all.push({ module: file, name, tool });
  }
  return all;
}

// Writes with a structural in-conversation gate: the un-`confirmed` call
// returns a preview and never mutates. New writes go here (until #1568's
// UI-backed mechanism exists, after which they use that instead).
const WRITE_TWO_STEP = [
  'create_customer',
  'optimize_all_routes',
  'optimize_tech_route',
  'assign_technician',
  'move_stops_to_day',
  'swap_tech_assignments',
];

// Writes blocked in the /query tool loop and executable only via /execute
// with server-checked confirmed:true + idempotency key
// (CONFIRMED_ACTION_TOOL_NAMES in routes/admin-intelligence-bar.js).
const CONFIRMED_ENDPOINT_WRITES = [
  'run_seo_pipeline',
  'approve_seo_action',
  'request_instant_payout',
  'request_standard_payout',
];

// ── FROZEN ── by-name snapshot taken 2026-06-11 (issue #1568). Writes whose
// only confirmation is prompt-level convention. Names may be DELETED as they
// migrate to the UI-backed mechanism. NO NAME MAY EVER BE ADDED.
const FROZEN_LEGACY_BARE_WRITES_2026_06_11 = Object.freeze([
  'update_customer',
  'bulk_update_customers',
  'create_appointment',
  'reschedule_appointment',
  'cancel_appointment',
  'send_sms',
  'update_lead_status',
  'bulk_update_leads',
  'submit_review_reply',
  'trigger_review_request',
  'send_email_reply',
  'reply_via_sms',
  'block_sender',
  'create_pending_estimate',
  'toggle_estimate_v2_view',
  'toggle_show_one_time_option',
  'run_price_lookup',
  'approve_price',
  'run_tax_advisor',
]);

// SHA-256 over the sorted frozen snapshot. The snapshot is a historical
// record and never changes — not even for removals (removals happen in the
// LIVE list below). Editing the snapshot therefore also requires editing
// this constant: tampering is double-entry and unmistakably deliberate.
const FROZEN_SNAPSHOT_SHA256 = '8abf4a31b0c0f6689dd5be9eb675041e4c25cd52bbc0eeae0dcb54d0a576509c';

// LIVE legacy list — maintained separately from the frozen snapshot, and
// must always be a subset of it. When a tool migrates to the #1568
// mechanism or is deleted, remove it HERE (the snapshot above stays put).
const LEGACY_BARE_WRITES = [
  'update_customer',
  'bulk_update_customers',
  'create_appointment',
  'reschedule_appointment',
  'cancel_appointment',
  'send_sms',
  'update_lead_status',
  'bulk_update_leads',
  'submit_review_reply',
  'trigger_review_request',
  'send_email_reply',
  'reply_via_sms',
  'block_sender',
  'create_pending_estimate',
  'toggle_estimate_v2_view',
  'toggle_show_one_time_option',
  'run_price_lookup',
  'approve_price',
  'run_tax_advisor',
];

// Tools that never mutate business data. Drafting tools (draft_sms,
// draft_review_reply, draft_email_reply) and proposal-only tools
// (cancel_and_reschedule_far_out) belong here — they return content for the
// operator, the corresponding send/submit tool is the write.
const READ_ONLY = [
  'query_customers', 'find_overdue_customers', 'get_customer_detail', 'get_schedule_view',
  'query_revenue', 'compare_technicians', 'find_duplicates', 'draft_sms',
  'find_schedule_gaps', 'get_day_summary', 'get_zone_density', 'find_available_slots',
  'cancel_and_reschedule_far_out',
  'get_kpi_snapshot', 'compare_periods', 'get_mrr_trend', 'get_revenue_breakdown',
  'get_estimate_funnel', 'get_churn_analysis', 'get_service_mix', 'get_customer_acquisition',
  'get_outstanding_balances', 'get_today_briefing',
  'query_gsc_performance', 'query_top_queries', 'query_top_pages', 'query_seo_rankings',
  'check_site_health', 'query_blog_performance', 'get_content_pipeline', 'get_backlink_overview',
  'compare_domains', 'get_content_decay_alerts', 'get_semantic_concept_map',
  'score_page_refresh_priority', 'get_content_workflow_brief', 'inspect_url', 'scan_url_issues',
  'indexation_report', 'canonical_conflicts', 'sitemap_validation', 'detect_duplicates',
  'intent_routing_report', 'seo_action_queue', 'seo_experiment_results', 'internal_link_graph',
  'query_products', 'query_vendors', 'compare_vendor_pricing', 'find_cheapest_vendor',
  'get_approval_queue', 'analyze_margins', 'get_price_trends', 'get_unpriced_summary',
  'get_revenue_overview', 'get_service_line_pnl', 'get_ad_attribution',
  'get_tech_revenue_performance', 'compare_revenue_periods', 'get_top_revenue_customers',
  'get_my_route', 'get_stop_details', 'get_service_history', 'get_product_info', 'get_protocol',
  'check_customer_status', 'search_knowledge_base', 'get_weather_conditions',
  'get_review_stats', 'get_unresponded_reviews', 'draft_review_reply', 'get_outreach_candidates',
  'search_reviews', 'get_review_trends', 'get_velocity_pipeline',
  'get_unanswered_threads', 'get_conversation_thread', 'search_messages', 'get_sms_stats',
  'get_call_log', 'draft_sms_reply', 'get_csr_overview', 'get_todays_activity',
  'get_tax_dashboard', 'get_expenses', 'get_equipment_depreciation', 'get_filing_deadlines',
  'get_quarterly_estimate', 'get_pnl', 'get_advisor_alerts', 'get_mileage_summary', 'get_ar_aging',
  'get_lead_overview', 'query_leads', 'get_stale_leads', 'get_lead_funnel',
  'get_source_performance', 'get_lost_analysis', 'get_response_times',
  'get_inbox_summary', 'search_emails', 'get_email_thread', 'draft_email_reply',
  'get_vendor_invoices', 'get_email_stats', 'get_blocked_senders',
  'get_stripe_balance', 'get_payout_history', 'get_payout_details', 'get_cash_flow',
  'get_fee_analysis', 'get_unreconciled_payouts', 'export_payouts',
  'lookup_property', 'compute_estimate', 'read_pricing_config', 'recent_pricing_changes',
  'find_similar_estimates', 'match_existing_customer', 'get_waveguard_tiers',
];

describe('intelligence bar write-gate contract (issue #1568)', () => {
  const allTools = discoverAllTools();
  const byName = new Map(allTools.map(t => [t.name, t.tool]));
  const classified = [
    ...WRITE_TWO_STEP.map(n => ({ name: n, kind: 'two-step' })),
    ...CONFIRMED_ENDPOINT_WRITES.map(n => ({ name: n, kind: 'endpoint' })),
    ...LEGACY_BARE_WRITES.map(n => ({ name: n, kind: 'legacy' })),
    ...READ_ONLY.map(n => ({ name: n, kind: 'read' })),
  ];

  test('discovery finds the known tool modules (sanity floor)', () => {
    const modules = new Set(allTools.map(t => t.module));
    // 14 modules as of 2026-06-11 — a drop below this means discovery broke,
    // not that modules legitimately disappeared.
    expect(modules.size).toBeGreaterThanOrEqual(14);
    expect(allTools.length).toBeGreaterThanOrEqual(149);
  });

  test('no tool name is registered twice across modules', () => {
    const names = allTools.map(t => t.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  test('no tool is classified twice', () => {
    const names = classified.map(c => c.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  test('every registered tool is classified — new tools must be added here with a gate', () => {
    const classifiedNames = new Set(classified.map(c => c.name));
    const unclassified = allTools.filter(t => !classifiedNames.has(t.name))
      .map(t => `${t.module}:${t.name}`);
    // If this fails for a tool you just added: classify it in this file.
    // Reads go in READ_ONLY. New writes MUST use the preview→confirmed
    // two-step (WRITE_TWO_STEP) or the #1568 UI-backed mechanism once it
    // exists. Adding to the frozen legacy snapshot is forbidden — that list
    // only shrinks.
    expect(unclassified).toEqual([]);
  });

  test('classification lists contain no stale entries for removed tools', () => {
    const stale = classified.filter(c => !byName.has(c.name)).map(c => c.name);
    expect(stale).toEqual([]);
  });

  test('two-step writes expose a structural confirmed gate in their schema', () => {
    for (const name of WRITE_TWO_STEP) {
      const tool = byName.get(name);
      expect(tool).toBeDefined();
      expect(Object.keys(tool.input_schema?.properties || {})).toContain('confirmed');
    }
  });

  test('read-only tools do not declare a confirmed param (a gated tool is a write — reclassify it)', () => {
    const misfiled = READ_ONLY.filter(name => {
      const tool = byName.get(name);
      return tool && Object.keys(tool.input_schema?.properties || {}).includes('confirmed');
    });
    expect(misfiled).toEqual([]);
  });

  test('frozen snapshot is tamper-evident (hash pinned)', () => {
    const digest = crypto.createHash('sha256')
      .update([...FROZEN_LEGACY_BARE_WRITES_2026_06_11].sort().join('\n'))
      .digest('hex');
    // If this fails you edited the frozen snapshot. The snapshot never
    // changes — removals belong in LEGACY_BARE_WRITES, additions are
    // forbidden outright.
    expect(digest).toBe(FROZEN_SNAPSHOT_SHA256);
  });

  test('legacy bare writes are a subset of the frozen 2026-06-11 snapshot — additions are impossible, only removals', () => {
    const frozen = new Set(FROZEN_LEGACY_BARE_WRITES_2026_06_11);
    const added = LEGACY_BARE_WRITES.filter(n => !frozen.has(n));
    // A name here means someone tried to register a NEW bare write. That is
    // forbidden: use WRITE_TWO_STEP or the #1568 UI-backed mechanism.
    expect(added).toEqual([]);
  });
});

// ─── BEHAVIORAL CONTRACT ────────────────────────────────────────
// Schema declaration is not proof: a write could declare `confirmed` and
// ignore it. Exercise every two-step executor WITHOUT confirmed against a
// recording knex mock SEEDED with realistic rows — so every lookup succeeds,
// the executor reaches its confirmation gate (not a "not found" early
// return), and the suite asserts the gate returned a preview/proposal with
// zero mutations reaching the database.

function makeRecordingDb(seed = {}) {
  const mutations = [];
  const MUTATING_OPS = new Set(['insert', 'update', 'del', 'delete', 'increment', 'decrement', 'truncate', 'upsert']);
  const firstIndex = {}; // rotates .first() rows per table so consecutive lookups differ (e.g. tech A then tech B)

  function makeBuilder(table) {
    const rows = seed[table] || [];
    const state = { single: false };
    const builder = new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === 'then') {
          if (state.single) {
            const i = firstIndex[table] || 0;
            firstIndex[table] = i + 1;
            return (resolve) => resolve(rows.length ? rows[i % rows.length] : undefined);
          }
          return (resolve) => resolve(rows);
        }
        if (prop === 'first') {
          return () => { state.single = true; return builder; };
        }
        if (MUTATING_OPS.has(prop)) {
          return (...args) => { mutations.push({ table, op: String(prop), args }); return builder; };
        }
        // Any other builder method chains.
        return () => builder;
      },
    });
    return builder;
  }

  const db = (table) => makeBuilder(table);
  db.raw = (...args) => ({ __raw: args });
  db.transaction = async (cb) => cb((table) => makeBuilder(table));
  return { db, mutations };
}

describe('two-step writes do not mutate without confirmed (behavioral)', () => {
  const dbMock = require('../models/db');

  const TECHS = [
    { id: 'tech-1', name: 'Adam' },
    { id: 'tech-2', name: 'Jose' },
  ];
  const STOPS = [
    {
      id: '00000000-0000-0000-0000-000000000001', customer_id: 'cust-1', technician_id: 'tech-1',
      scheduled_date: '2026-06-11', service_type: 'Pest Control', status: 'scheduled',
      lat: 27.39, lng: -82.45, first_name: 'Pat', last_name: 'Tester', city: 'Bradenton',
      address_line1: '1 Test St', state: 'FL', zip: '34208', current_tech_name: 'Adam',
    },
    {
      id: '00000000-0000-0000-0000-000000000002', customer_id: 'cust-2', technician_id: 'tech-1',
      scheduled_date: '2026-06-11', service_type: 'Lawn Care Visit', status: 'scheduled',
      lat: 27.34, lng: -82.53, first_name: 'Sam', last_name: 'Tester', city: 'Sarasota',
      address_line1: '2 Test St', state: 'FL', zip: '34232', current_tech_name: 'Adam',
    },
  ];
  // create_customer's duplicate check must MISS (an existing customer would
  // legitimately stop before the gate), so `customers` stays unseeded.
  // Everything the schedule writes look up is present, so each executor
  // reaches its `confirmed !== true` branch with real work to do.
  const SEED = { technicians: TECHS, scheduled_services: STOPS };

  // Minimal valid inputs per tool, deliberately WITHOUT confirmed.
  const UNCONFIRMED_CALLS = [
    ['tools', 'executeTool', 'create_customer', { first_name: 'Contract', phone: '9415550100' }],
    ['schedule-tools', 'executeScheduleTool', 'optimize_all_routes', { date: '2026-06-11' }],
    ['schedule-tools', 'executeScheduleTool', 'optimize_tech_route', { date: '2026-06-11', technician_name: 'Adam' }],
    ['schedule-tools', 'executeScheduleTool', 'assign_technician', { service_ids: [STOPS[0].id], technician_name: 'Jose' }],
    ['schedule-tools', 'executeScheduleTool', 'move_stops_to_day', { service_ids: [STOPS[0].id], new_date: '2026-06-12' }],
    ['schedule-tools', 'executeScheduleTool', 'swap_tech_assignments', { date: '2026-06-11', tech_a_name: 'Adam', tech_b_name: 'Jose' }],
  ];

  test('harness sanity: the recording db actually records mutations', async () => {
    const { db, mutations } = makeRecordingDb();
    await db('sanity_table').insert({ a: 1 });
    expect(mutations).toEqual([expect.objectContaining({ table: 'sanity_table', op: 'insert' })]);
  });

  test('every WRITE_TWO_STEP tool is exercised by this behavioral contract', () => {
    expect(UNCONFIRMED_CALLS.map(c => c[2]).sort()).toEqual([...WRITE_TWO_STEP].sort());
  });

  test.each(UNCONFIRMED_CALLS)('%s %s: unconfirmed %s reaches the gate, returns a preview, mutates nothing', async (mod, exec, toolName, input) => {
    const { db, mutations } = makeRecordingDb(SEED);
    dbMock.mockImplementation(db);
    dbMock.raw.mockImplementation(db.raw);
    dbMock.transaction.mockImplementation(db.transaction);

    const executor = require(path.join(TOOLS_DIR, mod))[exec];
    const result = await executor(toolName, input);

    // The executor must have reached its confirmation gate — not an error or
    // "not found" early return — and answered with a preview/proposal.
    expect(result?.error).toBeUndefined();
    expect(result?.preview === true || result?.proposal === true).toBe(true);
    expect(result?.success).not.toBe(true);
    expect(mutations).toEqual([]);
  });
});

describe('endpoint-write classification matches the route guard', () => {
  test('CONFIRMED_ENDPOINT_WRITES equals CONFIRMED_ACTION_TOOL_NAMES in admin-intelligence-bar.js', () => {
    const route = require('../routes/admin-intelligence-bar');
    expect(route.CONFIRMED_ACTION_TOOL_NAMES).toBeInstanceOf(Set);
    expect([...route.CONFIRMED_ACTION_TOOL_NAMES].sort())
      .toEqual([...CONFIRMED_ENDPOINT_WRITES].sort());
  });
});

describe('operational write-gates module mirrors this policy snapshot', () => {
  // services/intelligence-bar/write-gates.js drives the runtime interception
  // for issue #1568 — it must never drift from the classifications here.
  const gates = require('../services/intelligence-bar/write-gates');

  test('WRITE_TWO_STEP_TOOL_NAMES matches', () => {
    expect([...gates.WRITE_TWO_STEP_TOOL_NAMES].sort()).toEqual([...WRITE_TWO_STEP].sort());
  });

  test('LEGACY_BARE_WRITE_TOOL_NAMES matches the live legacy list', () => {
    expect([...gates.LEGACY_BARE_WRITE_TOOL_NAMES].sort()).toEqual([...LEGACY_BARE_WRITES].sort());
  });

  test('UI_GATED_WRITE_TOOL_NAMES is exactly two-step + legacy', () => {
    expect([...gates.UI_GATED_WRITE_TOOL_NAMES].sort())
      .toEqual([...WRITE_TWO_STEP, ...LEGACY_BARE_WRITES].sort());
  });
});

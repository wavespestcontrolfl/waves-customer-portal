/**
 * Execution-mode matrix and request tally for the Intelligence Bar
 * ten-workflow scope (docs/intelligence-bar-operator-workflows.md).
 *
 * The matrix is checked against what THIS branch implements: the action
 * registry, write-gates.js, the technician rules, and owner-direct.js (#5563,
 * merged; the owner cells are derived from it). The scenario cases and their
 * write-call checks land with the baseline harness that executes them.
 *
 * Nothing here talks to a database, except the one tally predicate check,
 * which needs DATABASE_URL. Set UPDATE_IB_MATRIX_DOC=1 to rewrite the matrix
 * table in the doc.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');

const DOC = path.join(__dirname, '..', '..', 'docs', 'intelligence-bar-operator-workflows.md');
const MATRIX_BEGIN = '<!-- matrix:begin -->';
const MATRIX_END = '<!-- matrix:end -->';

const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const ownerDirect = require('../services/intelligence-bar/owner-direct');
const matrix = require('./fixtures/ib-workflows/execution-matrix');

describe('execution-mode matrix on main', () => {
  const rows = matrix.computeActual(registry, gates, ownerDirect);

  test('the registry has no policy errors', () => {
    expect(registry.policyErrors).toEqual([]);
  });

  test('every tool named in the matrix exists in the registry', () => {
    const missing = rows.filter((r) => !r.action).map((r) => r.tool);
    expect(missing).toEqual([]);
  });

  test.each(rows.map((r) => [r.tool, r]))('%s classification on main matches the scope', (tool, r) => {
    expect(r.actual.cls).toBe(r.cls);
    // classification, policy kind and approval agree
    if (r.cls === 'read') {
      expect(r.actual.kind).toBe('read');
      expect(r.action.approval).toBeNull();
      expect(gates.UI_GATED_WRITE_TOOL_NAMES.has(tool)).toBe(false);
    } else {
      expect(['internal_write', 'external_action']).toContain(r.actual.kind);
      expect(r.action.approval).toBe('ui_confirm');
      expect(gates.UI_GATED_WRITE_TOOL_NAMES.has(tool)).toBe(true);
      expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has(tool)).toBe(r.cls === 'two_step_card');
      expect(gates.LEGACY_BARE_WRITE_TOOL_NAMES.has(tool)).toBe(r.cls === 'bare_write_card');
    }
  });

  test('a non-owner admin gets reads directly and writes on a card, as the scope expects', () => {
    for (const r of rows) expect(r.actual.admin).toBe(r.admin);
  });

  // Owner cells come from owner-direct.js (#5563): OWNER_DIRECT_TOOL_NAMES and
  // executesWithoutCard(), probed with inputs and previews. They are never
  // typed into the matrix.
  test('gate off, the owner is an ordinary admin on every tool', () => {
    for (const r of rows) expect(r.actual.ownerOff).toBe(r.actual.admin);
  });

  test('gate on, an owner read is direct and an owner write follows owner-direct.js', () => {
    for (const r of rows) {
      if (r.cls === 'read') { expect(r.actual.ownerOn).toBe('direct'); continue; }
      if (!ownerDirect.OWNER_DIRECT_TOOL_NAMES.has(r.tool)) { expect(r.actual.ownerOn).toBe('card'); continue; }
      const probe = matrix.ownerPolicyProbe(ownerDirect, r.tool);
      expect(probe.canBeDirect).toBe(true);
      expect(r.actual.ownerOn).toBe(probe.canBeCard ? `direct when ${matrix.OWNER_DIRECT_CONDITIONS[r.tool]}` : 'direct');
    }
  });

  test('every conditional owner-direct tool has its condition written down, and no unconditional one does', () => {
    const ownerTools = rows.filter((r) => r.cls !== 'read' && ownerDirect.OWNER_DIRECT_TOOL_NAMES.has(r.tool));
    const conditional = ownerTools.filter((r) => matrix.ownerPolicyProbe(ownerDirect, r.tool).canBeCard).map((r) => r.tool).sort();
    expect(conditional).toEqual(Object.keys(matrix.OWNER_DIRECT_CONDITIONS).sort());
    for (const r of rows) expect(r.actual.ownerOn).not.toMatch(/UNDOCUMENTED/);
  });

  test('the conditions say what the policy does', () => {
    const exec = (tool, input, preview) => ownerDirect.executesWithoutCard(tool, input, preview || null);
    expect(exec('update_lead_contact', { lead_id: 'lead-x', first_name: 'A' })).toBe(true);
    expect(exec('update_lead_contact', { lead_name: 'A', first_name: 'A' })).toBe(false);
    expect(exec('update_lead_contact', { lead_id: 'lead-x', lead_name: 'A', first_name: 'A' })).toBe(false);
    for (const field of ownerDirect.DIRECT_CUSTOMER_FIELDS) expect(exec('update_customer', { updates: { [field]: 'x' } })).toBe(true);
    for (const field of ['email', 'waveguard_tier', 'monthly_rate', 'active', 'pipeline_stage']) expect(exec('update_customer', { updates: { [field]: 'x' } })).toBe(false);
    expect(exec('update_customer', { updates: { phone: 'x', email: 'y' } })).toBe(false);
    for (const tool of ['add_customer_property', 'update_customer_property']) {
      expect(exec(tool, { label: null })).toBe(true);
      expect(exec(tool, { label: 'rental' })).toBe(false);
    }
    expect(exec('reschedule_appointment', { appointment_id: 'a' }, { pinned_appointment: { id: 'a' } })).toBe(true);
    expect(exec('reschedule_appointment', { appointment_id: 'a' }, { pinned_appointment: { id: 'a', visit_id: 'v' } })).toBe(false);
    expect(exec('reschedule_appointment', { appointment_id: 'a' }, null)).toBe(false);
  });

  test('the owner cells that differ from the scope are exactly the recorded findings', () => {
    const differing = rows.filter((r) => matrix.differs(r.owner, r.actual.ownerOn)).map((r) => `${r.tool}:owner`).sort();
    expect(differing).toEqual([...matrix.OWNER_KNOWN_DIFFERENCES].sort());
  });

  test('the technician cells that differ from the scope are exactly the recorded findings', () => {
    const differing = rows.filter((r) => matrix.differs(r.tech, r.actual.tech)).map((r) => `${r.tool}:technician`).sort();
    expect(differing).toEqual([...matrix.KNOWN_DIFFERENCES].sort());
  });

  test('no technician-reachable tool is a write', () => {
    for (const r of rows) {
      if (r.actual.tech === 'scoped') expect(r.cls).toBe('read');
    }
  });

  test('the doc carries the current matrix table', () => {
    const table = matrix.renderTable(rows);
    let doc = fs.readFileSync(DOC, 'utf8');
    const begin = doc.indexOf(MATRIX_BEGIN);
    const end = doc.indexOf(MATRIX_END);
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    if (process.env.UPDATE_IB_MATRIX_DOC === '1') {
      doc = `${doc.slice(0, begin + MATRIX_BEGIN.length)}\n${table}\n${doc.slice(end)}`;
      fs.writeFileSync(DOC, doc);
    }
    const current = fs.readFileSync(DOC, 'utf8');
    const between = current.slice(current.indexOf(MATRIX_BEGIN) + MATRIX_BEGIN.length, current.indexOf(MATRIX_END)).trim();
    expect(between).toBe(table);
  });
});

describe('request tally script', () => {
  const tally = require('../../scripts/ib-request-tally');

  test('its SQL never names the prompt, response or error text columns', () => {
    for (const sql of [tally.CALLS_SQL, tally.TURNS_SQL, tally.FAILURES_SQL, tally.CONFIRMED_SQL]) {
      expect(sql).not.toMatch(/\bprompt\b|\bresponse\b|\berror_message\b/i);
      expect(sql.trim().toLowerCase().startsWith('select')).toBe(true);
      expect(sql).not.toMatch(/\b(insert|update|delete|alter|drop|truncate)\b/i);
    }
  });

  test('public estimate Q&A turns are left out of the call and turn counts', () => {
    for (const sql of [tally.CALLS_SQL, tally.TURNS_SQL]) expect(sql).toContain(tally.NOT_PUBLIC_ESTIMATE);
    expect(tally.NOT_PUBLIC_ESTIMATE).toMatch(/public_estimate_ask/);
  });

  test('a NULL or non-array tool_calls row is a tool-free turn that stays in the counts', () => {
    // `not (null and ...)` is NULL, which a WHERE drops: the predicate must be IS DISTINCT FROM TRUE
    expect(tally.NOT_PUBLIC_ESTIMATE).toMatch(/is distinct from true\s*$/i);
    expect(tally.NOT_PUBLIC_ESTIMATE).not.toMatch(/^\s*not\b/i);
    expect(tally.TURNS_SQL).toMatch(/case when jsonb_typeof\(q\.tool_calls\) = 'array' then jsonb_array_length\(q\.tool_calls\) = 0 else true end/);
  });

  // The same predicate, evaluated by PostgreSQL over the rows that matter. Runs in the
  // DB-gated CI step or against a private QA database; skipped when DATABASE_URL is unset.
  (process.env.DATABASE_URL ? test : test.skip)('the predicate keeps NULL, empty, non-array and ordinary rows and drops only public estimate Q&A (PostgreSQL)', async () => {
    const { Client } = require('pg');
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query(`
        with q(id, tool_calls) as (values
          (1, null::jsonb), (2, '[]'::jsonb), (3, '{"a": 1}'::jsonb), (4, '[{"name": "needs_me"}]'::jsonb),
          (5, '[{"name": "public_estimate_ask"}]'::jsonb), (6, '[{"name": "needs_me"}, {"name": "public_estimate_ask"}]'::jsonb), (7, 'null'::jsonb))
        select q.id from q where ${tally.NOT_PUBLIC_ESTIMATE} order by q.id`);
      expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 7]);
    } finally {
      await client.end();
    }
  });

  test('the whole tally reads one REPEATABLE READ, READ ONLY snapshot', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'ib-request-tally.js'), 'utf8');
    expect(src).toMatch(/SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY/);
    expect(src).not.toMatch(/SET TRANSACTION READ ONLY'/);
  });

  test('arguments: default window, --days and --json, bad input refused', () => {
    expect(tally.parseArgs([])).toEqual({ days: 14, json: false, help: false });
    expect(tally.parseArgs(['--days', '30', '--json'])).toEqual({ days: 30, json: true, help: false });
    expect(() => tally.parseArgs(['--days', '0'])).toThrow();
    expect(() => tally.parseArgs(['--days', 'x'])).toThrow();
    expect(() => tally.parseArgs(['--bogus'])).toThrow();
  });

  test('summary groups calls by tool and by operator and day, and carries failure counts through', () => {
    const calls = [
      { day: '2026-10-01', operator_id: '(none)', tool: 'needs_me', calls: 2 },
      { day: '2026-10-02', operator_id: '(none)', tool: 'needs_me', calls: 1 },
      { day: '2026-10-02', operator_id: 'op-1', tool: 'adjust_stock', calls: 1 },
    ];
    const turns = [{ day: '2026-10-02', operator_id: '(none)', turns: 4, turns_without_tools: 1 }];
    const failures = [{ tool: 'adjust_stock', events: 3, failures: 1, circuit_open: 0 }];
    const s = tally.summarize(calls, turns, failures);
    expect(s.tool_rank[0]).toEqual({ tool: 'needs_me', calls: 3 });
    expect(s.operators['(none)'].days['2026-10-01']).toEqual({ needs_me: 2 });
    expect(s.operators['(none)'].turns).toBe(4);
    expect(s.failures).toEqual(failures);
  });

  test('turns are kept per operator and day, including a day whose turns called no tool', () => {
    const turns = [
      { day: '2026-10-01', operator_id: 'op-1', turns: 3, turns_without_tools: 3 },
      { day: '2026-10-02', operator_id: 'op-1', turns: 2, turns_without_tools: 0 },
    ];
    const calls = [{ day: '2026-10-02', operator_id: 'op-1', tool: 'needs_me', calls: 2 }];
    const s = tally.summarize(calls, turns, []);
    expect(s.operators['op-1'].turns).toBe(5);
    expect(s.operators['op-1'].turns_by_day['2026-10-01']).toEqual({ turns: 3, turns_without_tools: 3 });
    const text = tally.formatText({ days: 14, generated_at: 'now', summary: s });
    expect(text).toMatch(/2026-10-01  3 turns \(3 without tools\)/);
    expect(text).toMatch(/2026-10-02  2 turns \(0 without tools\); needs_me x2/);
  });

  test('the turn query only takes an array length inside a CASE that has checked the type', () => {
    expect(tally.TURNS_SQL).toMatch(/case when jsonb_typeof\(q\.tool_calls\) = 'array' then jsonb_array_length\(q\.tool_calls\) = 0 else true end/);
    expect(tally.TURNS_SQL).not.toMatch(/\bor jsonb_array_length/);
  });

  test('confirmed writes are counted from ib_pending_actions using only outcome flags, never result text', () => {
    // the result column is only ever read through a named key
    expect(tally.CONFIRMED_SQL).not.toMatch(/a\.result\s*(,|\bas\b|$)/im);
    expect(tally.CONFIRMED_SQL).toMatch(/status = 'confirmed'/);
  });

  test('confirmed-write outcomes classify like the bar: failures, unknowns and successes per tool', () => {
    const rows = [
      { tool: 'send_sms', flags: { keys: true, success: true } },
      { tool: 'send_sms', flags: { keys: true, error: true } },
      { tool: 'send_sms', flags: { keys: true, state: 'provider_accepted' } },
      { tool: 'send_sms', flags: null }, // consumed, no stored result
      { tool: 'adjust_stock', flags: { keys: true, blocked: true } },
      { tool: 'adjust_stock', flags: { keys: true } }, // a result with no outcome flag
      { tool: 'adjust_stock', flags: { keys: true, partial: true } }, // landed, follow-up still needed
    ];
    expect(tally.classifyConfirmed(rows)).toEqual([
      { tool: 'send_sms', confirmed: 4, succeeded: 2, partial: 0, failed: 1, unknown: 1 },
      { tool: 'adjust_stock', confirmed: 3, succeeded: 0, partial: 1, failed: 1, unknown: 1 },
    ]);
    const s = tally.summarize([], [], [], tally.classifyConfirmed(rows));
    expect(tally.formatText({ days: 14, generated_at: 'now', summary: s })).toMatch(/Committed-write outcomes[\s\S]*2 succeeded \/\s+1 failed \/\s+0 partial \/\s+1 unknown \/\s+4 committed  send_sms/);
  });
});


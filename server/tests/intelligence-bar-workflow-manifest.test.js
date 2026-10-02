/**
 * Contract test for the Intelligence Bar ten-workflow scenario manifests
 * (PR 0 of the operator workflow scope, docs/intelligence-bar-operator-workflows.md).
 *
 * Part 1 validates the manifests under fixtures/ib-workflows/W1.json to W10.json
 * against the shape in scope section 2.4. Part 2 checks the execution-mode
 * matrix against what THIS branch implements (action registry, write-gates.js,
 * technician rules, and owner-direct.js, #5563, which is merged: the owner
 * cells are derived from it). Part 3 is the write-call chokepoint: every write
 * step that commits names the call it would make, and the test checks that call
 * against the tool schemas the bar sends to the model and against the card
 * policy, so a case that expects something the code cannot do, or a card flag
 * that contradicts the policy, fails here and not in review.
 *
 * No runtime behavior is exercised; nothing here talks to a database
 * (except the one tally predicate check, which needs DATABASE_URL).
 * Set UPDATE_IB_MATRIX_DOC=1 to rewrite the matrix table in the doc.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'fixtures', 'ib-workflows');
const DOC = path.join(__dirname, '..', '..', 'docs', 'intelligence-bar-operator-workflows.md');
const MATRIX_BEGIN = '<!-- matrix:begin -->';
const MATRIX_END = '<!-- matrix:end -->';

const OUTCOMES = ['completed', 'submitted_to_provider', 'awaiting_operator', 'unsupported', 'blocked_by_rule', 'failed', 'partial', 'unknown'];
const SCORED_OUTCOMES = ['completed', 'submitted_to_provider'];
const ACTORS = ['owner', 'admin', 'tech'];
const MODES = ['owner_direct_on', 'owner_direct_off'];
const KINDS = ['read', 'write'];
// Generic recovery cases from "Corrections and recovery" (scope Part 1).
const RECOVERY_TAGS = [
  'wrong_target_switch', 'pre_exec_change', 'post_commit_correction', 'plan_drift', 'lost_response',
  'double_submit', 'timeout_unknown', 'second_step_failure', 'permission_revoked', 'clear_or_refresh',
];
const WORKFLOW_IDS = Array.from({ length: 10 }, (_, i) => `W${i + 1}`);

const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const ownerDirect = require('../services/intelligence-bar/owner-direct');
const { UPDATABLE_FIELDS } = require('../services/intelligence-bar/tools');
const matrix = require('./fixtures/ib-workflows/execution-matrix');

const manifests = WORKFLOW_IDS.map((id) => ({ id, file: `${id}.json`, doc: JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8')) }));

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isStringArray = (v) => Array.isArray(v) && v.every(isNonEmptyString);
// A case is scored on its LAST step: the final correction if there are any,
// otherwise the initial request.
const finalOutcome = (c) => (c.corrections.length ? c.corrections[c.corrections.length - 1].expected.outcome : c.expected.outcome);
// A write step whose answer must show a confirmation card is marked card:true (a card is presented; it is confirmed only when the outcome is completed or submitted). Reads never show one, even when the answer is about payment cards.
const mentionsCard = (say) => /\bcard(?:ed)?\b/i.test(say || '') && !/\b(no|without|uncarded)\b[^.]{0,12}\bcard(?:ed)?\b/i.test(say || '');
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
// The same request with another customer, product, day or number is the same
// scenario: mask every capitalized word after the first, and every number,
// before comparing dev and held-out wording.
const scenarioKey = (s) => norm(String(s).replace(/(?<=\S\s+)[A-Z][\w'’-]*/g, '<name>').replace(/\d+/g, '<n>').replace(/[?.!,]/g, ''));

describe('manifest files', () => {
  test('exactly W1.json to W10.json exist', () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
    expect(files).toEqual(WORKFLOW_IDS.map((id) => `${id}.json`).sort());
  });

  test.each(manifests)('$id has the document shape', ({ id, doc }) => {
    expect(doc.schema_version).toBe(1);
    expect(doc.workflow).toBe(id);
    expect(isNonEmptyString(doc.title)).toBe(true);
    expect(isNonEmptyString(doc.inspected_commit)).toBe(true);
    expect(doc.contract && typeof doc.contract === 'object').toBe(true);
    expect(isStringArray(doc.contract.tools)).toBe(true);
    expect(isStringArray(doc.contract.rulings)).toBe(true);
    expect(doc.fixtures && Object.keys(doc.fixtures).length).toBeGreaterThan(0);
    expect(Object.values(doc.fixtures).every(isNonEmptyString)).toBe(true);
    expect(doc.required_corrections && Object.keys(doc.required_corrections).length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(doc.cases)).toBe(true);
  });
});

describe('case shape', () => {
  const allCases = manifests.flatMap(({ id, doc }) => doc.cases.map((c) => ({ wf: id, doc, c })));

  test('there are 200 cases in total', () => {
    expect(allCases).toHaveLength(200);
  });

  test('ids are unique across all manifests', () => {
    const ids = allCases.map(({ c }) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test.each(allCases.map(({ wf, doc, c }) => [c.id, wf, doc, c]))('%s is well formed', (id, wf, doc, c) => {
    expect(id).toMatch(new RegExp(`^${wf}-(dev|held)-\\d{2}$`));
    expect(c.partition).toBe(id.split('-')[1]);
    expect(isNonEmptyString(c.request)).toBe(true);
    expect(isNonEmptyString(c.origin)).toBe(true);
    expect(c.origin.startsWith(`${wf}-`)).toBe(true);
    expect(KINDS).toContain(c.kind);
    expect(c.page_context).toMatch(/^(none|customer:[a-z0-9-]+|lead:[a-z0-9-]+|visit:[a-z0-9-]+)$/);
    expect(ACTORS).toContain(c.actor);
    expect(MODES).toContain(c.mode);
    expect(Object.keys(doc.fixtures)).toContain(c.fixture);
    if (c.inject !== undefined) expect(isNonEmptyString(c.inject)).toBe(true);
    // a dependency that does not exist on this tree is a key of CAPABILITY_GAPS, never free text
    if (c.requires !== undefined) {
      expect(Array.isArray(c.requires) && c.requires.length > 0).toBe(true);
      for (const key of c.requires) expect(Object.keys(matrix.CAPABILITY_GAPS)).toContain(key);
    }

    // expected: outcome enum plus the exact rows, fields and values
    expect(OUTCOMES).toContain(c.expected.outcome);
    expect(isStringArray(c.expected.changes)).toBe(true);
    expect(isStringArray(c.expected.unchanged)).toBe(true);
    expect(Number.isInteger(c.expected.sends) && c.expected.sends >= 0).toBe(true);
    expect(typeof c.expected.card).toBe('boolean');
    // A case that expects a change must say which rows; a case that expects no change must say what stays.
    if (c.expected.changes.length === 0) expect(c.expected.unchanged.length).toBeGreaterThan(0);

    // negative cases are marked so the completion score excludes them
    expect(c.negative).toBe(!SCORED_OUTCOMES.includes(finalOutcome(c)));
    // card expectations agree with what the step says it must show
    for (const step of [c.expected, ...c.corrections.map((x) => x.expected)]) {
      if (c.kind === 'read') expect(step.card).toBe(false); // a read never shows a confirmation card
      else if (mentionsCard(step.say)) expect(step.card).toBe(true);
    }
    // a fault injected after the card is shown, after confirm, or at the
    // provider (which is only reached through a confirmed send) means the
    // initial step did show a card
    if (c.kind === 'write' && (mentionsCard(c.inject) || /after (the )?confirm|provider (accepts|returns)/i.test(c.inject || ''))) expect(c.expected.card).toBe(true);
    // with the owner-direct gate off, an owner write that completes went through a card
    if (c.kind === 'write' && c.actor === 'owner' && c.mode === 'owner_direct_off' && SCORED_OUTCOMES.includes(c.expected.outcome)) {
      expect(c.expected.card).toBe(true);
    }
    // a change of mind before execution: the initial step only proposes, so
    // nothing is sent or committed yet, and the change arrives as a follow-up step
    if (c.tags.includes('pre_exec_change')) {
      expect(c.corrections.length).toBeGreaterThan(0);
      expect(c.expected.outcome).toBe('awaiting_operator');
      expect(c.expected.sends).toBe(0);
      expect(c.expected.changes).toEqual([]);
    }

    // the stored appointment block is duration based (flat 60 minutes for a
    // new booking); the two-hour arrival range is confirmation-text copy, so no
    // change row may assert it as the persisted window
    for (const step of [c.expected, ...c.corrections.map((x) => x.expected)]) {
      // any spelling (.window, .date_window, .day, ...): a time range in a change row is only allowed as named text copy
      for (const ch of step.changes) if (/\d\d:\d\d-\d\d:\d\d/.test(ch)) expect(ch).toMatch(/\btext copy\b|confirmation-text copy/);
    }

    // forbidden: every write case has a list, and so does every read case here
    expect(isStringArray(c.forbidden)).toBe(true);
    if (c.kind === 'write') expect(c.forbidden.length).toBeGreaterThan(0);
    expect(c.forbidden.length).toBeGreaterThan(0);

    // verify: a database query and a page for every entry
    expect(Array.isArray(c.verify) && c.verify.length).toBeGreaterThan(0);
    for (const v of c.verify) {
      expect(isNonEmptyString(v.db)).toBe(true);
      expect(isNonEmptyString(v.page)).toBe(true);
    }

    // corrections carry their own expected and forbidden
    expect(Array.isArray(c.corrections)).toBe(true);
    for (const corr of c.corrections) {
      expect(isNonEmptyString(corr.request)).toBe(true);
      expect(OUTCOMES).toContain(corr.expected.outcome);
      expect(isStringArray(corr.expected.changes)).toBe(true);
      expect(isStringArray(corr.expected.unchanged)).toBe(true);
      expect(Array.isArray(corr.forbidden)).toBe(true);
    }

    // tags and covers
    expect(Array.isArray(c.tags) && c.tags.every((t) => RECOVERY_TAGS.includes(t))).toBe(true);
    expect(Array.isArray(c.covers) && c.covers.every((k) => Object.keys(doc.required_corrections).includes(k))).toBe(true);

    // technician sessions are out of the first release: the only technician case is a negative one
    if (c.actor === 'tech') expect(c.negative).toBe(true);
  });

  test('requests use operator wording: no tool names, ids, uuids or real-looking contact data', () => {
    const toolNames = [...registry.actions.keys(), 'discover_capabilities'];
    const texts = allCases.flatMap(({ c }) => [{ id: c.id, t: c.request }, ...c.corrections.map((x, i) => ({ id: `${c.id}#c${i}`, t: x.request }))]);
    const offenders = [];
    for (const { id, t } of texts) {
      if (toolNames.some((n) => new RegExp(`\\b${n}\\b`, 'i').test(t))) offenders.push(`${id}: tool name`);
      if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(t)) offenders.push(`${id}: uuid`);
      if (/\b\w+_id\b|\bid\s*[:=#]\s*\d+|\b(lead|customer|visit|appointment)\s*#\d+/i.test(t)) offenders.push(`${id}: id`);
      const phones = t.match(/\b\d{3}[-. ]\d{4}\b|\b\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g) || [];
      if (phones.some((p) => !/^555-01\d\d$/.test(p))) offenders.push(`${id}: phone-like number`);
      const emails = t.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
      if (emails.some((e) => !/@example\.invalid$/.test(e))) offenders.push(`${id}: non-synthetic email`);
    }
    expect(offenders).toEqual([]);
  });

  test('no manifest text carries a gate code or a non-synthetic address, phone or email', () => {
    const offenders = [];
    for (const { id, file } of manifests) {
      const raw = fs.readFileSync(path.join(DIR, file), 'utf8');
      if (/gate\s*code|lockbox|codebox|\bcode\s*[:#]\s*\d/i.test(raw)) offenders.push(`${id}: gate code wording`);
      for (const e of raw.match(/[\w.+-]+@[\w.-]+\.[a-z]+/gi) || []) if (!/@example\.invalid$/.test(e)) offenders.push(`${id}: ${e}`);
      for (const p of raw.match(/\b\d{3}[-. ]\d{3}[-. ]\d{4}\b|\b555-\d{4}\b/g) || []) if (!/^555-01\d\d$/.test(p)) offenders.push(`${id}: ${p}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe.each(manifests)('$id coverage', ({ id, doc }) => {
  const dev = doc.cases.filter((c) => c.partition === 'dev');
  const held = doc.cases.filter((c) => c.partition === 'held');

  test('ten dev and ten held-out cases with contiguous sequence numbers', () => {
    expect(dev).toHaveLength(10);
    expect(held).toHaveLength(10);
    for (const part of [dev, held]) {
      part.forEach((c, i) => expect(c.id).toBe(`${id}-${c.partition}-${String(i + 1).padStart(2, '0')}`));
    }
  });

  test('dev and held-out partitions are disjoint by originating example', () => {
    const devOrigins = new Set(dev.map((c) => c.origin));
    const heldOrigins = new Set(held.map((c) => c.origin));
    for (const o of heldOrigins) expect(devOrigins.has(o)).toBe(false);
    // an origin never spans partitions
    const seen = {};
    for (const c of doc.cases) {
      seen[c.origin] = seen[c.origin] || c.partition;
      expect(seen[c.origin]).toBe(c.partition);
    }
    // a held-out request (or correction) is never a dev one, word for word or
    // with only the names and numbers swapped
    const devTexts = new Set(dev.flatMap((c) => [c.request, ...c.corrections.map((x) => x.request)]).map(scenarioKey));
    const leaks = held.flatMap((c) => [c.request, ...c.corrections.map((x) => x.request)].filter((t) => devTexts.has(scenarioKey(t))).map((t) => `${c.id}: ${t}`));
    expect(leaks).toEqual([]);
  });

  test('negative cases are present in both partitions and supported cases remain the majority', () => {
    for (const part of [dev, held]) {
      expect(part.filter((c) => c.negative).length).toBeGreaterThanOrEqual(1);
      expect(part.filter((c) => !c.negative).length).toBeGreaterThanOrEqual(4);
    }
    // negatives cover at least two of the three negative outcomes named in the scope
    const negOutcomes = new Set(doc.cases.filter((c) => c.negative).map(finalOutcome));
    const named = ['unsupported', 'blocked_by_rule', 'awaiting_operator'].filter((o) => negOutcomes.has(o));
    expect(named.length).toBeGreaterThanOrEqual(2);
  });

  test('every specific correction case in section 2.2 is covered', () => {
    const covered = new Set(doc.cases.flatMap((c) => c.covers));
    for (const key of Object.keys(doc.required_corrections)) expect(covered.has(key)).toBe(true);
  });

  test('at least two generic recovery cases from Part 1 are present', () => {
    const tags = new Set(doc.cases.flatMap((c) => c.tags));
    expect(tags.size).toBeGreaterThanOrEqual(2);
    // both partitions exercise recovery, so the held-out run is not recovery-free
    expect(dev.some((c) => c.tags.length > 0)).toBe(true);
    expect(held.some((c) => c.tags.length > 0)).toBe(true);
  });

  test('the contract tools exist in the registry unless they are named as a known gap', () => {
    for (const t of doc.contract.tools) {
      if (/\s/.test(t)) continue; // prose entry such as the W9 reader that is not built yet
      expect(registry.actions.has(t)).toBe(true);
    }
  });
});

// Row references in changes/unchanged name real tables and columns, so a
// harness can query them. These five are deliberate logical names for values
// that are not one column; the doc lists the same mapping.
const LOGICAL_FIELDS = {
  'estimates.lawn_applications': 'estimate_data inputs: services.lawn.lawnFreq',
  'estimates.measurement': 'estimate_data inputs: the property lawn measurement used',
  'estimates.price': 'the engine total saved with the estimate (monthly_total / annual_total per cadence)',
  'scheduled_services.date_window': 'scheduled_date + window_start / window_end',
  'sms_log.template': 'sms_log.message_type (the template key the sender used)',
};

describe('row references', () => {
  const MIGRATIONS = path.join(__dirname, '..', 'models', 'migrations');
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  const tables = new Set(files.flatMap((src) => [...src.matchAll(/createTable\(\s*'([a-z_]+)'/g)].map((m) => m[1])));
  // A column counts for a table only if it is named in a migration that
  // creates or alters THAT table (knex or raw SQL), not anywhere in the tree.
  const columnsOf = (table) => {
    const touches = new RegExp(`(?:createTable|alterTable|table)\\(\\s*'${table}'|ALTER TABLE\\s+(?:IF EXISTS\\s+)?"?${table}"?\\b|CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?"?${table}"?\\b`, 'i');
    return new Set(files.filter((src) => touches.test(src)).flatMap((src) => [...src.matchAll(/['"\s]([a-z0-9_]+)['"\s]/g)].map((m) => m[1])));
  };
  const columnCache = new Map();
  const hasColumn = (table, field) => {
    if (!columnCache.has(table)) columnCache.set(table, columnsOf(table));
    return columnCache.get(table).has(field);
  };

  test('every table[...] and table[...].field in a case is a migrated table and column, or a listed logical name', () => {
    const bad = new Set();
    for (const { doc } of manifests) {
      for (const c of doc.cases) {
        for (const step of [c.expected, ...c.corrections.map((x) => x.expected)]) {
          for (const line of [...step.changes, ...step.unchanged]) {
            for (const m of line.matchAll(/\b([a-z0-9_]+)\[[^\]]*\](?:\.([a-z0-9_]+))?/g)) {
              const [, table, field] = m;
              if (!tables.has(table)) bad.add(`${c.id}: table ${table}`);
              else if (field && !hasColumn(table, field) && !LOGICAL_FIELDS[`${table}.${field}`]) bad.add(`${c.id}: ${table}.${field}`);
            }
          }
        }
      }
    }
    expect([...bad]).toEqual([]);
  });

  test('the column check is per table: a real column of another table is refused', () => {
    expect(hasColumn('sms_log', 'message_body')).toBe(true);
    expect(hasColumn('sms_log', 'window_start')).toBe(false);
    expect(hasColumn('scheduled_services', 'message_body')).toBe(false);
  });

  test('the doc lists every logical field name', () => {
    const text = fs.readFileSync(DOC, 'utf8');
    for (const k of Object.keys(LOGICAL_FIELDS)) expect(text).toContain(`\`${k}\``);
  });
});

describe('scorecard counts', () => {
  test('completion is scored over completed and submitted_to_provider cases only', () => {
    const summary = manifests.map(({ id, doc }) => {
      const scored = doc.cases.filter((c) => SCORED_OUTCOMES.includes(finalOutcome(c)));
      const negative = doc.cases.filter((c) => !SCORED_OUTCOMES.includes(finalOutcome(c)));
      expect(scored.length + negative.length).toBe(20);
      expect(negative.every((c) => c.negative)).toBe(true);
      expect(scored.every((c) => !c.negative)).toBe(true);
      return { id, scored: scored.length, negative: negative.length };
    });
    expect(summary.reduce((n, s) => n + s.scored + s.negative, 0)).toBe(200);
  });
});

describe('doc partition table', () => {
  test('the scored/negative counts in the doc match the manifests', () => {
    const doc = fs.readFileSync(DOC, 'utf8');
    for (const { id, doc: m } of manifests) {
      const cell = (part) => {
        const cs = m.cases.filter((c) => c.partition === part);
        return `${cs.filter((c) => !c.negative).length} / ${cs.filter((c) => c.negative).length}`;
      };
      const needing = m.cases.filter((c) => c.requires).length;
      expect(doc).toContain(`| ${id} | ${cell('dev')} | ${cell('held')} | ${needing}`);
    }
  });
});

describe('execution-mode matrix on main', () => {
  const rows = matrix.computeActual(registry, gates, ownerDirect);

  test('the registry has no policy errors', () => {
    expect(registry.policyErrors).toEqual([]);
  });

  test('every tool named in the matrix exists in the registry', () => {
    const missing = rows.filter((r) => !r.action).map((r) => r.tool);
    expect(missing).toEqual([]);
  });

  test('every tool named by a manifest contract is in the matrix', () => {
    const inMatrix = new Set(matrix.MATRIX.map((r) => r.tool));
    const notUsed = new Set(['create_restock_request']);
    for (const { doc } of manifests) {
      for (const t of doc.contract.tools) {
        if (/\s/.test(t) || notUsed.has(t)) continue;
        expect(inMatrix.has(t)).toBe(true);
      }
    }
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
    const differing = rows.filter((r) => matrix.differs(r.owner, matrix.baseCell(r.actual.ownerOn))).map((r) => `${r.tool}:owner`).sort();
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

// The write-call chokepoint. A manifest describes target behavior; each write
// step that commits therefore names the call it would make ({ tool, input,
// preview? }, synthetic values, a list for a compound step), and the call is
// held to what the code can do: the tool is one the contract declares, every
// input key and enum value exists in the schema the bar sends to the model, and
// the card flag follows owner-direct.js. Anything the target needs that is not
// on this tree is a declared capability gap (CAPABILITY_GAPS) carried as
// `requires`; a gap licenses only what it `adds`.
describe('write calls', () => {
  const writeCases = manifests.flatMap(({ id, doc }) => doc.cases.filter((c) => c.kind === 'write').map((c) => ({ wf: id, doc, c })));
  const stepsOf = (c) => [{ label: 'first step', step: c.expected, holder: c }, ...c.corrections.map((x, i) => ({ label: `correction ${i + 1}`, step: x.expected, holder: x }))];
  const gapKeys = (c) => c.requires || [];
  const callsOf = (c) => stepsOf(c).flatMap(({ holder }) => matrix.callList(holder));

  test('reads carry no call', () => {
    const offenders = manifests.flatMap(({ doc }) => doc.cases.filter((c) => c.kind === 'read').flatMap((c) => stepsOf(c).filter(({ holder }) => holder.call !== undefined).map(() => c.id)));
    expect(offenders).toEqual([]);
  });

  test('every write step that commits or shows a card names its call, and no call hangs on a step that does not', () => {
    const problems = [];
    for (const { c } of writeCases) {
      for (const { label, step, holder } of stepsOf(c)) {
        const calls = matrix.callList(holder);
        if (matrix.stepCommits(step) && calls.length === 0) problems.push(`${c.id} ${label}: commits or shows a card but names no call`);
        if (!matrix.stepCommits(step) && calls.length > 0) problems.push(`${c.id} ${label}: names a call but changes nothing, sends nothing and shows no card`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('every scored write case names at least one call, unless it truthfully commits nothing', () => {
    // a completed no-op (a duplicate add reported, a request already received) changes nothing and shows no card
    const bare = writeCases.filter(({ c }) => !c.negative && callsOf(c).length === 0 && stepsOf(c).some(({ step }) => matrix.stepCommits(step))).map(({ c }) => c.id);
    expect(bare).toEqual([]);
  });

  test('a call has a tool and an input object, and is a write', () => {
    const problems = [];
    for (const { c } of writeCases) {
      for (const k of callsOf(c)) {
        if (!isNonEmptyString(k.tool) || !k.input || typeof k.input !== 'object' || Array.isArray(k.input)) { problems.push(`${c.id}: malformed call`); continue; }
        const action = registry.actions.get(k.tool);
        if (action && !['internal_write', 'external_action'].includes(action.kind)) problems.push(`${c.id}: ${k.tool} is a read, not a write`);
        if (k.preview !== undefined && (!k.preview || typeof k.preview !== 'object')) problems.push(`${c.id}: preview must be an object`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('the call tool is one of the contract tools, or the case declares the gap that adds it', () => {
    const problems = [];
    for (const { doc, c } of writeCases) {
      for (const k of callsOf(c)) {
        if (doc.contract.tools.includes(k.tool)) continue;
        const added = gapKeys(c).some((key) => matrix.CAPABILITY_GAPS[key] && matrix.CAPABILITY_GAPS[key].adds && matrix.CAPABILITY_GAPS[key].adds.tools && matrix.CAPABILITY_GAPS[key].adds.tools[k.tool]);
        if (!added) problems.push(`${c.id}: ${k.tool} is not in the ${doc.workflow} contract tools and no declared gap adds it`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('every input key and enum value exists in the schema the bar sends to the model (declared gaps apply on top)', () => {
    const problems = [];
    for (const { c } of writeCases) {
      for (const k of callsOf(c)) problems.push(...matrix.schemaProblems(k, registry, Object.keys(UPDATABLE_FIELDS), gapKeys(c)).map((p) => `${c.id}: ${p}`));
    }
    expect(problems).toEqual([]);
  });

  test('the schema check catches what it exists to catch', () => {
    // the probes below leave out required inputs on purpose; required is checked on its own at the end
    const check = (call, keys = []) => matrix.schemaProblems(call, registry, Object.keys(UPDATABLE_FIELDS), keys).filter((p) => !/omits the required input/.test(p));
    const checkAll = (call, keys = []) => matrix.schemaProblems(call, registry, Object.keys(UPDATABLE_FIELDS), keys);
    // a template message type and a booking property pin: not on main
    expect(check({ tool: 'send_sms', input: { customer_id: 'c', message_type: 'appointment_rescheduled' } })).toHaveLength(1);
    expect(check({ tool: 'create_appointment', input: { customer_id: 'c', property_id: 'p' } })).toHaveLength(1);
    expect(check({ tool: 'save_customer_estimate', input: { customer_id: 'c', property_id: 'p', measurement_key: 'back_lot' } })).toHaveLength(1);
    expect(check({ tool: 'reschedule_appointment_series', input: { appointment_id: 'a' } })).toHaveLength(1);
    expect(check({ tool: 'update_customer', input: { customer_id: 'c', updates: { favorite_color: 'x' } } })).toHaveLength(1);
    expect(check({ tool: 'save_customer_estimate', input: { customer_id: 'c', property_id: 'p', lawn_applications: 6 } })).toHaveLength(1);
    // the declared gaps license exactly what they add
    expect(check({ tool: 'send_sms', input: { customer_id: 'c', message_type: 'appointment_rescheduled' } }, ['reschedule_notice_send'])).toEqual([]);
    expect(check({ tool: 'send_sms', input: { customer_id: 'c', message_type: 'billing_notice' } }, ['reschedule_notice_send'])).toHaveLength(1);
    expect(check({ tool: 'create_appointment', input: { customer_id: 'c', property_id: 'p' } }, ['create_appointment_property_pin'])).toEqual([]);
    expect(check({ tool: 'create_appointment', input: { customer_id: 'c', property_id: 'p' } }, ['reschedule_notice_send'])).toHaveLength(1);
    // and plain main calls are clean
    expect(check({ tool: 'send_sms', input: { customer_id: 'c', message: 'hi', message_type: 'manual' } })).toEqual([]);
    // a required input that is left out is caught, and a gap that renders the text relaxes it
    const smsRequired = registry.actions.get('send_sms').schema.required || [];
    expect(smsRequired).toContain('message');
    expect(checkAll({ tool: 'send_sms', input: { customer_id: 'c' } }).some((p) => /omits the required input message/.test(p))).toBe(true);
    expect(checkAll({ tool: 'send_sms', input: { customer_id: 'c', message_type: 'appointment_rescheduled' } }, ['reschedule_notice_send']).some((p) => /required input message/.test(p))).toBe(false);
  });

  test('a declared gap is used by the case that declares it', () => {
    const stale = [];
    for (const { c } of writeCases) {
      for (const key of gapKeys(c)) {
        const adds = matrix.CAPABILITY_GAPS[key].adds || {};
        if (!adds.tools && !adds.properties) continue; // behavior-only gap: nothing in a schema to point at
        const calls = callsOf(c);
        const uses = calls.some((k) => {
          if (adds.tools && adds.tools[k.tool]) return true;
          const props = adds.properties && adds.properties[k.tool];
          return !!props && Object.entries(props).some(([prop, spec]) => prop in k.input && (!spec.enum || spec.enum.includes(k.input[prop])));
        });
        if (!uses) stale.push(`${c.id}: requires ${key} but no call uses what it adds`);
      }
    }
    expect(stale).toEqual([]);
  });

  test('the card flag of every step with a call follows owner-direct.js for the owner with the gate on, and is true for every other actor or mode', () => {
    const problems = [];
    for (const { c } of writeCases) {
      for (const { label, step, holder } of stepsOf(c)) {
        const calls = matrix.callList(holder);
        if (!calls.length) continue;
        const want = matrix.expectedCard(c, calls, ownerDirect);
        if (step.card !== want) problems.push(`${c.id} ${label}: card is ${step.card}, the policy says ${want} for ${c.actor}/${c.mode} (${calls.map((k) => k.tool).join(', ')})`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('outside owner-direct, a write never changes or sends anything without a card', () => {
    const problems = [];
    for (const { c } of writeCases) {
      if (c.actor === 'owner' && c.mode === 'owner_direct_on') continue;
      for (const { label, step } of stepsOf(c)) {
        if (!step.card && (step.changes.length > 0 || step.sends > 0)) problems.push(`${c.id} ${label}: ${c.actor}/${c.mode} changes or sends with card false`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('a card that is not shown is a refusal or a question before any proposal, never a completed write', () => {
    const problems = [];
    for (const { c } of writeCases) {
      for (const { label, step, holder } of stepsOf(c)) {
        if (step.card || matrix.callList(holder).length) continue;
        if (step.changes.length > 0 || step.sends > 0) problems.push(`${c.id} ${label}: changes or sends with no card and no call`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('a step never receives a restock request and also restocks the product (receive already adds the stock)', () => {
    const doubled = [];
    for (const { c } of writeCases) {
      for (const { label, holder } of stepsOf(c)) {
        const calls = matrix.callList(holder);
        const receives = calls.some((k) => k.tool === 'update_restock_request' && k.input.action === 'receive');
        const restocks = calls.some((k) => k.tool === 'adjust_stock' && k.input.movement_type === 'restock');
        if (receives && restocks) doubled.push(`${c.id} ${label}`);
      }
    }
    expect(doubled).toEqual([]);
  });

  test('the policy check sees a wrong card flag', () => {
    const owner = { actor: 'owner', mode: 'owner_direct_on' };
    expect(matrix.expectedCard(owner, [{ tool: 'update_customer', input: { updates: { phone: 'x' } } }], ownerDirect)).toBe(false);
    expect(matrix.expectedCard(owner, [{ tool: 'update_customer', input: { updates: { email: 'x' } } }], ownerDirect)).toBe(true);
    expect(matrix.expectedCard(owner, [{ tool: 'add_customer_property', input: { label: 'rental' } }], ownerDirect)).toBe(true);
    expect(matrix.expectedCard(owner, [{ tool: 'reschedule_appointment', input: {}, preview: { pinned_appointment: { id: 'a' } } }, { tool: 'send_sms', input: {} }], ownerDirect)).toBe(true);
    expect(matrix.expectedCard(owner, [{ tool: 'reschedule_appointment', input: {}, preview: { pinned_appointment: { id: 'a', visit_id: 'v' } } }], ownerDirect)).toBe(true);
    expect(matrix.expectedCard({ actor: 'owner', mode: 'owner_direct_off' }, [{ tool: 'adjust_stock', input: {} }], ownerDirect)).toBe(true);
    expect(matrix.expectedCard({ actor: 'admin', mode: 'owner_direct_on' }, [{ tool: 'adjust_stock', input: {} }], ownerDirect)).toBe(true);
  });
});

describe('capability gaps', () => {
  const docText = fs.readFileSync(DOC, 'utf8');
  const caseCount = (key) => manifests.reduce((n, { doc }) => n + doc.cases.filter((c) => (c.requires || []).includes(key)).length, 0);

  test('every gap is described, owned, and used by at least one case', () => {
    for (const [key, gap] of Object.entries(matrix.CAPABILITY_GAPS)) {
      expect(isNonEmptyString(gap.what)).toBe(true);
      expect(isNonEmptyString(gap.owner_pr)).toBe(true);
      expect(caseCount(key)).toBeGreaterThan(0);
    }
  });

  test('the doc lists every gap with its owner and the number of cases that carry it', () => {
    for (const [key, gap] of Object.entries(matrix.CAPABILITY_GAPS)) {
      const row = docText.split('\n').find((line) => line.startsWith(`| \`${key}\` |`));
      expect(row).toBeDefined();
      expect(row).toContain(gap.owner_pr);
      expect(row.trim().endsWith(`| ${caseCount(key)} |`)).toBe(true);
    }
  });

  test('a case that carries a gap is a target, not an unsupported request', () => {
    // the gap documents what the target needs; it never turns the case into a refusal of the request
    const refused = manifests.flatMap(({ doc }) => doc.cases.filter((c) => c.requires && finalOutcome(c) === 'unsupported').map((c) => c.id));
    expect(refused).toEqual([]);
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
    expect(tally.TURNS_SQL).toMatch(/jsonb_typeof\(q\.tool_calls\) is distinct from 'array'/);
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
    ];
    expect(tally.classifyConfirmed(rows)).toEqual([
      { tool: 'send_sms', confirmed: 4, succeeded: 2, failed: 1, unknown: 1 },
      { tool: 'adjust_stock', confirmed: 2, succeeded: 0, failed: 1, unknown: 1 },
    ]);
    const s = tally.summarize([], [], [], tally.classifyConfirmed(rows));
    expect(tally.formatText({ days: 14, generated_at: 'now', summary: s })).toMatch(/Confirmed-write outcomes[\s\S]*1 failed \/\s+1 unknown \/\s+4 confirmed  send_sms/);
  });
});

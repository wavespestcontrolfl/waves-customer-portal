/**
 * Contract test for the Intelligence Bar ten-workflow scenario manifests
 * (PR 0 of the operator workflow scope, docs/intelligence-bar-operator-workflows.md).
 *
 * Part 1 validates the manifests under fixtures/ib-workflows/W1.json to W10.json
 * against the shape in scope section 2.4. Part 2 checks the execution-mode
 * matrix against what THIS branch implements (action registry, write-gates.js,
 * technician rules). Owner-direct (#5563) is not merged: its columns are
 * recorded as "pending #5563" and never asserted.
 *
 * No runtime behavior is exercised; nothing here talks to a database.
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
    if (c.requires !== undefined) expect(isNonEmptyString(c.requires)).toBe(true);

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
    // with the owner-direct gate off, an owner write that completes went through a card
    if (c.kind === 'write' && c.actor === 'owner' && c.mode === 'owner_direct_off' && SCORED_OUTCOMES.includes(c.expected.outcome)) {
      expect(c.expected.card).toBe(true);
    }
    // a change of mind before execution: the initial step only proposes, so nothing is sent or committed yet
    if (c.tags.includes('pre_exec_change') && c.corrections.length) {
      expect(c.expected.outcome).toBe('awaiting_operator');
      expect(c.expected.sends).toBe(0);
      expect(c.expected.changes).toEqual([]);
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
    // a held-out request (or correction) is never word-for-word a dev one
    const devTexts = new Set(dev.flatMap((c) => [c.request, ...c.corrections.map((x) => x.request)]).map(norm));
    for (const c of held) {
      expect(devTexts.has(norm(c.request))).toBe(false);
      for (const x of c.corrections) expect(devTexts.has(norm(x.request))).toBe(false);
    }
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
  const rows = matrix.computeActual(registry, gates);

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

  test('main has no owner-specific branch for these tools (owner-direct is #5563, not merged)', () => {
    for (const r of rows) expect(r.actual.owner).toBe(r.actual.admin);
    expect(matrix.OWNER_DIRECT_PENDING).toBe('pending #5563');
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
    for (const sql of [tally.CALLS_SQL, tally.TURNS_SQL, tally.FAILURES_SQL]) {
      expect(sql).not.toMatch(/\bprompt\b|\bresponse\b|\berror_message\b/i);
      expect(sql.trim().toLowerCase().startsWith('select')).toBe(true);
      expect(sql).not.toMatch(/\b(insert|update|delete|alter|drop|truncate)\b/i);
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
});

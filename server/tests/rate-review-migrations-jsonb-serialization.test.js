/**
 * Every jsonb column the rate review migrations write must reach the pg driver as JSON TEXT.
 * A raw JS array is serialized by `pg` as a Postgres array literal ({"a","b"}), which is not JSON
 * and aborts the migration. This goes through the driver's REAL serializer (pg/lib/utils
 * prepareValue) for both shapes a jsonb column can be read back as (native array, or text), and
 * adds a contract over the PR's migration files.
 */
const fs = require('fs');
const path = require('path');
const { prepareValue } = require('pg/lib/utils');

const seed = require('../models/migrations/20261001200000_rate_review_letter_email_template');
const assurance = require('../models/migrations/20261003120000_rate_review_letter_lane_neutral_assurance');
const subject = require('../models/migrations/20261003140000_rate_review_letter_subject_line');
const variables = require('../models/migrations/20261003150000_rate_review_letter_subject_variables');

const T = seed._private.TEMPLATE;
const DIR = path.join(__dirname, '../models/migrations');
const FILES = [
  '20261003120000_rate_review_letter_lane_neutral_assurance.js',
  '20261003130000_rate_review_sms_failures.js',
  '20261003140000_rate_review_letter_subject_line.js',
  '20261003150000_rate_review_letter_subject_variables.js',
];
const JSON_COLUMNS = ['allowed_variables', 'required_variables', 'optional_variables', 'blocks'];

// A knex stand-in that records every update patch.
function recorder({ subjectText, lists, shape, blocks }) {
  const enc = (a) => (shape === 'string' ? JSON.stringify(a) : a);
  const store = {
    email_templates: [{ id: 't1', template_key: 'billing.rate_review_notice', active_version_id: 'v1', allowed_variables: enc(lists.allowed), required_variables: enc(lists.required), optional_variables: enc(lists.optional) }],
    email_template_versions: [{ id: 'v1', subject: subjectText, blocks: shape === 'string' ? JSON.stringify(blocks || T.blocks) : (blocks || T.blocks) }],
  };
  const writes = [];
  const knex = (table) => {
    let filter = () => true;
    const q = {
      where(cond) { filter = (r) => Object.entries(cond).every(([k, v]) => r[k] === v); return q; },
      first: async () => store[table].find(filter),
      update: async (patch) => { writes.push({ table, patch }); store[table].filter(filter).forEach((r) => Object.assign(r, patch)); return 1; },
    };
    return q;
  };
  knex.schema = { hasTable: async () => true };
  return { knex, writes, store };
}

// What the driver would put on the wire for each jsonb column in a write: must parse as JSON and equal the list/blocks.
function assertWireJson(writes, expectedByColumn) {
  const seen = new Set();
  for (const { patch } of writes) {
    for (const col of JSON_COLUMNS) {
      if (!(col in patch)) continue;
      const wire = prepareValue(patch[col]);
      expect(typeof wire).toBe('string');
      const parsed = JSON.parse(wire); // throws on {"a","b"}
      expect(Array.isArray(parsed)).toBe(true);
      if (expectedByColumn && expectedByColumn[col]) expect(parsed).toEqual(expectedByColumn[col]);
      seen.add(col);
    }
  }
  return seen;
}

describe('rate review migrations write jsonb as JSON text (real pg serializer)', () => {
  test('the failure this guards: a raw array is NOT valid JSON on the wire', () => {
    expect(() => JSON.parse(prepareValue(['a', 'b']))).toThrow();
  });

  const seededLists = { allowed: [...T.required, ...T.optional], required: T.required, optional: T.optional };

  test.each(['array', 'string'])('20261003140000 up and down (%s original)', async (shape) => {
    const r = recorder({ subjectText: subject._private.OLD_SUBJECT, lists: seededLists, shape });
    await subject.up(r.knex);
    const upCols = assertWireJson(r.writes);
    expect([...upCols].sort()).toEqual(['allowed_variables', 'optional_variables']);
    const up = r.writes.at(-1).patch;
    expect(JSON.parse(prepareValue(up.allowed_variables))).toContain('subject_line');
    expect(JSON.parse(prepareValue(up.optional_variables))).toContain('subject_line');
    r.writes.length = 0;
    await subject.down(r.knex);
    assertWireJson(r.writes);
    const down = r.writes.at(-1).patch;
    expect(JSON.parse(prepareValue(down.optional_variables))).toEqual(T.optional);
  });

  test.each(['array', 'string'])('20261003150000 up and down (%s original)', async (shape) => {
    const r = recorder({
      subjectText: variables._private.SUBJECT,
      lists: { allowed: [...T.required, ...T.optional, 'subject_line'], required: T.required, optional: [...T.optional, 'subject_line'] },
      shape,
    });
    await variables.up(r.knex);
    const cols = assertWireJson(r.writes);
    expect([...cols].sort()).toEqual(['allowed_variables', 'optional_variables', 'required_variables']);
    const up = r.writes.at(-1).patch;
    expect(JSON.parse(prepareValue(up.required_variables))).toContain('subject_line');
    expect(JSON.parse(prepareValue(up.required_variables))).not.toContain('effective_date');
    r.writes.length = 0;
    await variables.down(r.knex);
    assertWireJson(r.writes);
    expect(JSON.parse(prepareValue(r.writes.at(-1).patch.required_variables)).sort()).toEqual([...T.required].sort());
  });

  test.each(['array', 'string'])('20261003120000 up and down write blocks as JSON text (%s original)', async (shape) => {
    const r = recorder({ subjectText: 'x', lists: seededLists, shape });
    await assurance.up(r.knex);
    expect(assertWireJson(r.writes).has('blocks')).toBe(true);
    r.writes.length = 0;
    await assurance.down(r.knex);
    expect(assertWireJson(r.writes, { blocks: T.blocks }).has('blocks')).toBe(true);
  });

  test('contract: none of this PR\'s migrations passes a raw array/object to a jsonb column in an update/insert', () => {
    // the object literal passed to each .update( / .insert( call (balanced braces)
    const callBodies = (src) => {
      const out = [];
      for (const m of src.matchAll(/\.(?:update|insert)\(\s*\{/g)) {
        let depth = 1;
        let i = m.index + m[0].length;
        while (i < src.length && depth > 0) { if (src[i] === '{') depth += 1; else if (src[i] === '}') depth -= 1; i += 1; }
        out.push(src.slice(m.index + m[0].length, i - 1));
      }
      return out;
    };
    let checked = 0;
    for (const file of FILES) {
      const src = fs.readFileSync(path.join(DIR, file), 'utf8');
      expect(src).not.toMatch(/sameShape/);
      for (const body of callBodies(src)) {
        for (const col of JSON_COLUMNS) {
          for (const m of body.matchAll(new RegExp(`\\b${col}\\s*:\\s*([^\\n]+)`, 'g'))) {
            checked += 1;
            expect(m[1]).toMatch(/JSON\.stringify|toJson\(/);
          }
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5); // 120000 blocks, 140000 x2, 150000 x3
  });
});

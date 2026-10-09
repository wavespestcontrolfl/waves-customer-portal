/**
 * Monday irrigation email: longer runs on fewer days, never shorter runs or an
 * extra day (owner 2026-10-09, migration 20261009170000).
 *
 * Pins, through the REAL decision builder and the REAL template renderer:
 *  - the two legacy callout lines that said "trim a few minutes off each zone"
 *    and "one extra watering day" are gone from every variant that can send;
 *  - no variant suggests an added watering day, with a one-day restriction
 *    policy in force or not;
 *  - the migration patches only the exact old text, publishes a new version,
 *    leaves an office-edited template whole, is idempotent, and rolls back.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => false), isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const EmailTemplates = require('../services/email-template-library');
const seed = require('../models/migrations/20260702000001_seed_irrigation_weekly_email_templates');
const audit = require('../models/migrations/20260926120100_customer_copy_audit_email');
const migration = require('../models/migrations/20261009170000_irrigation_email_longer_cycles');
// Active versions as published in production on 2026-09-26 (template content only).
const baseline = require('./fixtures/customer-copy-audit-email-baseline.json');
const {
  buildWeeklyEmailDecision,
  TEMPLATE_CUT_BACK,
  TEMPLATE_ADD_WATER,
} = require('../services/irrigation-weekly-email');

const OLD_PHRASES = /trim a few minutes|extra watering day|skip a watering day or trim/i;
// Any wording that suggests MORE days (or an added cycle) than the customer waters now.
const ADDED_DAY = /extra (watering )?(day|cycle|run)|add(ing)? (a|an|one) (watering |extra )?(day|cycle|run)|more watering days|another watering day|additional (watering )?day|water (more often|twice)/i;
const PLACEHOLDER_RE = /\{\{\s*[a-zA-Z][a-zA-Z0-9_]*\s*\}\}/;

// What each legacy template looks like in production right before this
// migration: cut_back = the real v5 text with the 09-26 patch applied;
// add_water = its seed (no later migration touches that callout).
function liveVersion(key) {
  if (key === TEMPLATE_CUT_BACK) {
    const row = baseline.find((t) => t.template_key === key);
    return audit.applyPatches(row, audit.PATCHES.filter((p) => p.key === key)).version;
  }
  const s = seed.__private.TEMPLATES.find((t) => t.key === key);
  return { subject: s.subject, preview_text: s.preview, blocks: s.blocks };
}

function patchedVersion(key) {
  const { version, misses } = audit.applyPatches(liveVersion(key), migration.PATCHES.filter((p) => p.key === key));
  expect(misses).toEqual([]);
  return version;
}

function renderWith(key, version, payload) {
  const templateSeed = seed.__private.TEMPLATES.find((t) => t.key === key);
  const row = seed.__private.templateRow(templateSeed);
  const allowed = [...JSON.parse(row.allowed_variables), 'rain_source_note'];
  const template = {
    id: `tmpl-${key}`,
    ...row,
    allowed_variables: allowed,
    required_variables: JSON.parse(row.required_variables),
    optional_variables: [...JSON.parse(row.optional_variables), 'rain_source_note'],
  };
  const rendered = EmailTemplates.renderTemplate({
    template,
    version: { id: `ver-${key}`, subject: version.subject, preview_text: version.preview_text, blocks: version.blocks, text_body: '' },
    payload,
  });
  return [rendered.subject, rendered.html, rendered.text].join('\n');
}

const ONE_DAY_POLICY = JSON.stringify({
  maxDaysPerWeek: 1,
  effectiveFrom: '2026-08-27',
  expiresOn: '2027-03-31',
  label: 'Test one-day order',
  hoursNote: 'on your assigned day, during your area\'s allowed hours',
  coverage: { counties: ['Manatee'], partial: [] },
});

const BASE = { firstName: 'Dana', grassType: 'st_augustine', weekEnding: '2026-10-04', et0Inches: 1.6 };
// Monday 07:00 ET inside the plan window; the plan week ends Sunday 2026-10-11.
const MONDAY = { weekPlanEnabled: true, planWeekEnd: '2026-10-11', now: new Date('2026-10-05T11:00:00Z') };

// [label, decision inputs]
const LEGACY_VARIANTS = [
  ['surplus, gate off', TEMPLATE_CUT_BACK, { irrigationInchesPerWeek: 1, rainfallInches7d: 2.1, forecastRainInches: 0.5 }],
  ['deficit, gate off', TEMPLATE_ADD_WATER, { irrigationInchesPerWeek: 0.25, rainfallInches7d: 0.1, forecastRainInches: 0.5 }],
  ['balanced week, dry forecast, gate off', TEMPLATE_ADD_WATER, { irrigationInchesPerWeek: 0.25, rainfallInches7d: 1, forecastRainInches: 0 }],
  // Monday morning, but no restriction policy covers the county: the plan is
  // unavailable and the legacy template sends.
  ['surplus, Monday, county not covered', TEMPLATE_CUT_BACK, { irrigationInchesPerWeek: 1, rainfallInches7d: 2.1, forecastRainInches: 0.5, county: null, ...MONDAY }],
  ['deficit, Monday, county not covered', TEMPLATE_ADD_WATER, { irrigationInchesPerWeek: 0.25, rainfallInches7d: 0.1, forecastRainInches: 0.5, county: null, ...MONDAY }],
];

describe('legacy irrigation advice callouts', () => {
  const original = process.env.IRRIGATION_RESTRICTION_POLICY;
  beforeEach(() => { process.env.IRRIGATION_RESTRICTION_POLICY = ONE_DAY_POLICY; });
  afterAll(() => {
    if (original === undefined) delete process.env.IRRIGATION_RESTRICTION_POLICY;
    else process.env.IRRIGATION_RESTRICTION_POLICY = original;
  });

  test('the production text before the patch still carries both old lines (the patch is needed)', () => {
    expect(JSON.stringify(liveVersion(TEMPLATE_CUT_BACK).blocks)).toMatch(/trim a few minutes/);
    expect(JSON.stringify(liveVersion(TEMPLATE_ADD_WATER).blocks)).toMatch(/one extra watering day/);
  });

  test.each(LEGACY_VARIANTS)('%s: renders the longer-runs wording and no old phrase', (label, key, inputs) => {
    const decision = buildWeeklyEmailDecision({ ...BASE, ...inputs });
    expect(decision.shouldSend).toBe(true);
    expect(decision.templateKey).toBe(key);
    if (inputs.weekPlanEnabled) expect(decision.weekPlanUnavailable).toBeTruthy();

    const before = renderWith(key, liveVersion(key), decision.payload);
    expect(before).toMatch(OLD_PHRASES);

    const after = renderWith(key, patchedVersion(key), decision.payload);
    expect(after).not.toMatch(OLD_PHRASES);
    expect(after).not.toMatch(ADDED_DAY);
    expect(after).not.toMatch(PLACEHOLDER_RE);
    expect(after).toContain('reach the roots better than short ones');
    if (key === TEMPLATE_CUT_BACK) {
      expect(after).toContain('skip a watering day.');
      expect(after).not.toMatch(/minutes off/i);
    } else {
      expect(after).toContain('on your allowed watering days');
    }
  });

  test('the new lines name no weekday, no number of days, no fixed minutes, no "safe"', () => {
    for (const p of migration.PATCHES) {
      expect(p.to).not.toMatch(/\b(mon|tues?|wednes|thurs?|fri|satur|sun)day\b/i);
      expect(p.to).not.toMatch(/\b(one|two|three|four|1|2|3|4)[ -]days?\b/i);
      expect(p.to).not.toMatch(/\b\d+\s*(min|minutes)\b/i);
      expect(p.to).not.toMatch(/\bsafe(ly)?\b/i);
    }
  });

  test('under a one-day policy the week-plan path never suggests an added day', () => {
    // Covered county + valid policy: the plan sends instead of the legacy template.
    for (const water of [
      { irrigationInchesPerWeek: 0.25, rainfallInches7d: 0.1, forecastRainInches: 0.5 },
      { irrigationInchesPerWeek: 1, rainfallInches7d: 2.1, forecastRainInches: 0.5 },
    ]) {
      const decision = buildWeeklyEmailDecision({ ...BASE, ...water, county: 'Manatee', ...MONDAY });
      expect(decision.templateKey).toBe('irrigation.weekly_plan');
      const text = [decision.payload.week_plan, decision.payload.plan_note, decision.payload.restriction_note].join('\n');
      expect(text).not.toMatch(ADDED_DAY);
      expect(text).not.toMatch(OLD_PHRASES);
    }
  });
});

describe('migration 20261009170000', () => {
  // Minimal in-memory stand-in for email_templates / email_template_versions.
  function makeKnex(initial) {
    const db = JSON.parse(JSON.stringify(initial));
    let nextId = 1000;
    const match = (row, where) => Object.entries(where || {}).every(([k, v]) => row[k] === v);
    function table(name, store) {
      const rows = store[name];
      const state = { where: {}, order: null };
      const select = () => {
        let sel = rows.filter((r) => match(r, state.where));
        if (state.order) {
          sel = [...sel].sort((a, b) => (state.order.dir === 'desc'
            ? Number(b[state.order.col]) - Number(a[state.order.col])
            : Number(a[state.order.col]) - Number(b[state.order.col])));
        }
        return sel;
      };
      const api = {
        where(w) { state.where = { ...state.where, ...w }; return api; },
        orderBy(col, dir) { state.order = { col, dir }; return api; },
        async first() { return select()[0]; },
        async update(patch) {
          const sel = select();
          sel.forEach((r) => Object.assign(r, patch));
          return sel.length;
        },
        insert(row) {
          const created = { id: `id-${nextId += 1}`, ...row };
          rows.push(created);
          return { returning: async () => [created] };
        },
      };
      return api;
    }
    const knex = (name) => table(name, db);
    knex.schema = { hasTable: async () => true };
    knex.transaction = async (fn) => fn((name) => table(name, db));
    knex.__db = db;
    return knex;
  }

  function fixture({ cutBackBlocks, textBody = null } = {}) {
    const templates = [];
    const versions = [];
    for (const key of migration.KEYS) {
      const v = liveVersion(key);
      templates.push({ id: `t-${key}`, template_key: key, active_version_id: `v-${key}-1` });
      versions.push({
        id: `v-${key}-1`,
        template_id: `t-${key}`,
        version_number: 1,
        status: 'active',
        subject: v.subject,
        preview_text: v.preview_text,
        blocks: JSON.stringify(key === TEMPLATE_CUT_BACK && cutBackBlocks ? cutBackBlocks : v.blocks),
        text_body: textBody,
        validation_snapshot: '{}',
      });
    }
    return { email_templates: templates, email_template_versions: versions };
  }

  const active = (knex, key) => {
    const t = knex.__db.email_templates.find((r) => r.template_key === key);
    return knex.__db.email_template_versions.find((v) => v.id === t.active_version_id);
  };
  const text = (version) => JSON.stringify(typeof version.blocks === 'string' ? JSON.parse(version.blocks) : version.blocks);

  test('sorts after every other migration and defines both templates', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '../models/migrations');
    const names = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
    expect(names[names.length - 1]).toBe('20261009170000_irrigation_email_longer_cycles.js');
    expect(migration.KEYS).toEqual([TEMPLATE_CUT_BACK, TEMPLATE_ADD_WATER]);
  });

  test('up publishes a new active version with only the two lines changed', async () => {
    const knex = makeKnex(fixture());
    await migration.up(knex);
    for (const key of migration.KEYS) {
      const next = active(knex, key);
      const prior = knex.__db.email_template_versions.find((v) => v.id === `v-${key}-1`);
      expect(next.version_number).toBe(2);
      expect(next.status).toBe('active');
      expect(prior.status).toBe('archived');
      expect(JSON.parse(next.validation_snapshot)).toMatchObject({ source: migration.MIGRATION_MARKER, supersedes_version: 1 });
      expect(next.text_body).toBeNull();
      expect(next.subject).toBe(prior.subject);
      expect(next.preview_text).toBe(prior.preview_text);
      expect(text(next)).not.toMatch(OLD_PHRASES);
      // Every other character of the template is untouched.
      const patch = migration.PATCHES.find((p) => p.key === key);
      expect(text(next)).toBe(text(prior).replace(JSON.stringify(patch.from).slice(1, -1), JSON.stringify(patch.to).slice(1, -1)));
    }
  });

  test('a second run changes nothing', async () => {
    const knex = makeKnex(fixture());
    await migration.up(knex);
    const snapshot = JSON.stringify(knex.__db);
    await migration.up(knex);
    expect(JSON.stringify(knex.__db)).toBe(snapshot);
  });

  test('an office-edited callout is left whole, and the other template still updates', async () => {
    const edited = liveVersion(TEMPLATE_CUT_BACK).blocks.map((b) => (b.type === 'callout'
      ? { ...b, content: 'Office wording: back off the sprinklers a little this week.' }
      : b));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const knex = makeKnex(fixture({ cutBackBlocks: edited }));
    await migration.up(knex);
    warn.mockRestore();
    expect(active(knex, TEMPLATE_CUT_BACK).id).toBe(`v-${TEMPLATE_CUT_BACK}-1`);
    expect(text(active(knex, TEMPLATE_CUT_BACK))).toContain('Office wording');
    expect(active(knex, TEMPLATE_ADD_WATER).version_number).toBe(2);
  });

  test('a template with a custom plain-text body is left whole', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const knex = makeKnex(fixture({ textBody: 'Custom plain text.' }));
    await migration.up(knex);
    warn.mockRestore();
    for (const key of migration.KEYS) expect(active(knex, key).version_number).toBe(1);
  });

  test('down restores the superseded version, and leaves a later office publish alone', async () => {
    const knex = makeKnex(fixture());
    await migration.up(knex);
    await migration.down(knex);
    for (const key of migration.KEYS) {
      const back = active(knex, key);
      expect(back.version_number).toBe(1);
      expect(back.status).toBe('active');
      expect(text(back)).toMatch(OLD_PHRASES);
    }

    const knex2 = makeKnex(fixture());
    await migration.up(knex2);
    // The office publishes its own version 3 over ours.
    const t = knex2.__db.email_templates.find((r) => r.template_key === TEMPLATE_ADD_WATER);
    knex2.__db.email_template_versions.push({
      id: 'office-v3', template_id: t.id, version_number: 3, status: 'active',
      subject: 's', preview_text: 'p', blocks: '[]', text_body: null, validation_snapshot: '{}',
    });
    t.active_version_id = 'office-v3';
    await migration.down(knex2);
    expect(active(knex2, TEMPLATE_ADD_WATER).id).toBe('office-v3');
    // The untouched template still rolls back.
    expect(active(knex2, TEMPLATE_CUT_BACK).version_number).toBe(1);
  });
});

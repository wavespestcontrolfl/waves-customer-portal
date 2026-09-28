/**
 * Email division templates — first-visit follow-up, why-91-days,
 * rain-and-treatment, expired-estimate (migration 20260928220000, the
 * re-cut of #5160/20260928080000 — that PR's seed migration was already
 * pushed and is frozen per waves-db §4, so this is a fresh seed on a fresh
 * branch incorporating every Codex finding from #5160's review directly,
 * not a correction chain on top of the old one).
 *
 * Pins five things:
 *  1. The migration seeds all four templates DRAFT (+ three DRAFT
 *     automations; lc.rain_and_treatment gets none — its trigger doesn't
 *     exist yet) and is idempotent on template_key / automation_key.
 *  2. down() is a documented no-op — it never deletes a row, edited or not
 *     (Codex #5160 P1 :398).
 *  3. Every field value is one the admin API's own enum actually accepts —
 *     legal_classification, content_sensitivity (Codex #5160 P1 :238, P2
 *     :179) — checked against the SAME sets admin-email-templates.js uses,
 *     not hand-copied literals that could drift.
 *  4. sendTemplate's OWN refusal path (assertTemplateSendable) rejects a
 *     seeded template — nothing here can send, and this is not mocked away.
 *  5. Every "full" fixture renders with no leftover {{placeholders}}; every
 *     "sparse" fixture drops its optional sections WHOLE (heading and all —
 *     the details-block mechanism the library already has), with no blank
 *     number and no banned claim.
 */

let mockDb;
jest.mock('../models/db', () => {
  const fn = (...args) => mockDb(...args);
  fn.schema = { hasTable: (...args) => mockDb.schema.hasTable(...args) };
  return fn;
});
jest.mock('../services/sendgrid-mail', () => ({
  serviceGroupId: () => 202,
  newsletterGroupId: () => 101,
}));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => false), isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { randomUUID } = require('crypto');
const EmailTemplates = require('../services/email-template-library');
const migration = require('../models/migrations/20260928220000_seed_email_division_templates');

const TABLES = ['email_templates', 'email_template_versions', 'email_template_fixtures', 'email_template_automations'];
const PLACEHOLDER_RE = /\{\{\s*[a-zA-Z][a-zA-Z0-9_]*\s*\}\}/;
const BANNED_PHRASES = [
  '% off', 'discount', 'bee-safe', 'pet-safe', 'guarantee', 'second swarm',
  // Removed by the copy revision — retailer-sourced, not
  // label/manufacturer-verified. Must never come back.
  '90 days', '1–2 weeks', '1-2 weeks', 'about 30 days', 'one hour to dry',
  '7–14 days', '30–90 days', 'sterilis', 'steriliz',
  // Fixed re-entry/drying minute figure (AGENTS.md: "safe once dry" +
  // technician confirms timing) and the stale pre-revision preview line.
  'one-hour rule', 'for 30 minutes and off the interior baseboards for 2 hours',
  // UF/IFAS LH059 is withdrawn (HTTP 410) — no citable source for this claim.
  'four weeks', 'university of florida notes that fipronil',
];
// Scoped to the pet-advisory/re-entry variable specifically —
// irrigation_hold_hours and the label-verified 24-hour no-rain-forecast
// window are unrelated, static, verified facts and are allowed to carry a
// number.
const FIXED_MINUTE_FIGURE_RE = /\b\d+\s*(?:minutes?|hours?)\b/i;
const DOLLAR_DIGIT_RE = /\$\d/;

function fakeKnex(tableNames) {
  const store = {};
  const table = (name) => store[name] || (store[name] = []);
  const matches = (row, cond) => Object.entries(cond || {}).every(([k, v]) => row[k] === v);

  const knex = (name) => {
    const rows = table(name);
    const b = { _where: {} };
    b.where = (cond) => { b._where = { ...b._where, ...cond }; return b; };
    b.whereIn = (col, vals) => { b._whereIn = { col, vals }; return b; };
    b.orderBy = (col, dir) => { b._orderBy = { col, dir: dir || 'asc' }; return b; };
    b._filtered = () => {
      let out = rows.filter((r) => matches(r, b._where));
      if (b._whereIn) out = out.filter((r) => b._whereIn.vals.includes(r[b._whereIn.col]));
      if (b._orderBy) {
        out = out.slice().sort((x, y) => (b._orderBy.dir === 'desc'
          ? (y[b._orderBy.col] || 0) - (x[b._orderBy.col] || 0)
          : (x[b._orderBy.col] || 0) - (y[b._orderBy.col] || 0)));
      }
      return out;
    };
    b.first = async () => { const r = b._filtered()[0]; return r ? { ...r } : undefined; };
    b.then = (resolve, reject) => Promise.resolve(b._filtered().map((r) => ({ ...r }))).then(resolve, reject);
    b.max = (expr) => { b._maxCol = String(expr).split(' ')[0]; return { first: async () => {
      const filtered = b._filtered();
      if (!filtered.length) return { max: null };
      return { max: filtered.reduce((m, r) => Math.max(m, Number(r[b._maxCol]) || 0), 0) };
    } }; };
    b.update = async (patch) => {
      let n = 0;
      rows.forEach((r) => { if (matches(r, b._where)) { Object.assign(r, patch); n += 1; } });
      return n;
    };
    b.del = async () => {
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (matches(rows[i], b._where) && (!b._whereIn || b._whereIn.vals.includes(rows[i][b._whereIn.col]))) {
          rows.splice(i, 1); n += 1;
        }
      }
      return n;
    };
    b.insert = (payload) => {
      const arr = (Array.isArray(payload) ? payload : [payload]).map((p) => ({ id: randomUUID(), ...p }));
      arr.forEach((r) => rows.push(r));
      const result = Promise.resolve(arr.map((r) => r.id));
      result.returning = async () => arr;
      return result;
    };
    return b;
  };
  knex.schema = { hasTable: async (name) => tableNames.includes(name) };
  knex.__store = store;
  return knex;
}

async function seededKnex() {
  const knex = fakeKnex(TABLES);
  await migration.up(knex);
  return knex;
}

function finalStateFor(knex, key) {
  const row = knex.__store.email_templates.find((t) => t.template_key === key);
  const versions = knex.__store.email_template_versions
    .filter((v) => v.template_id === row.id)
    .sort((a, b) => b.version_number - a.version_number);
  const version = versions[0];
  const fixturesByName = Object.fromEntries(
    knex.__store.email_template_fixtures
      .filter((f) => f.template_id === row.id)
      .map((f) => [f.name, JSON.parse(f.payload)]),
  );
  const template = {
    ...row,
    allowed_variables: JSON.parse(row.allowed_variables),
    required_variables: JSON.parse(row.required_variables),
  };
  return {
    template,
    version: { ...version, blocks: JSON.parse(version.blocks) },
    fixtures: fixturesByName,
  };
}

function renderedText(rendered) {
  return [rendered.subject, rendered.previewText, rendered.text, rendered.html].join('\n');
}

describe('seed migration 20260928220000 (re-cut of #5160)', () => {
  test('seeds four draft templates; lc.rain_and_treatment has no automation row', () => {
    expect(migration.TEMPLATES.map((t) => t.key)).toEqual([
      'lc.first_visit_pest', 'lc.why_91_days', 'lc.rain_and_treatment', 'nurture.expired_1',
    ]);
    expect(migration.AUTOMATIONS.map((a) => a.key)).toEqual([
      'lc.first_visit_pest', 'lc.why_91_days', 'nurture.expired_1',
    ]);
    for (const t of migration.TEMPLATES) {
      const row = migration.__private.templateRow(t);
      expect(row.status).toBe('draft');
      expect(row.from_name).toBe('Waves Pest Control');
      expect(row.from_email).toBe('contact@wavespestcontrol.com');
      expect(row.reply_to).toBe('contact@wavespestcontrol.com');
      expect(JSON.parse(row.allowed_variables)).toEqual([...t.required, ...t.optional]);
    }
    const suppressionByKey = Object.fromEntries(migration.TEMPLATES.map((t) => [t.key, t.suppressionGroup]));
    expect(suppressionByKey['lc.first_visit_pest']).toBe('service_operational');
    expect(suppressionByKey['lc.why_91_days']).toBe('service_operational');
    expect(suppressionByKey['lc.rain_and_treatment']).toBe('service_operational');
    expect(suppressionByKey['nurture.expired_1']).toBe('marketing_nurture');
  });

  test('the three lc.* templates are classified outside Lawn Care (Codex P2 :43)', () => {
    for (const key of ['lc.first_visit_pest', 'lc.why_91_days', 'lc.rain_and_treatment']) {
      const t = migration.TEMPLATES.find((x) => x.key === key);
      expect(t.purpose).not.toBe('lawn_care');
      expect(t.purpose).toBe('pest');
    }
  });

  test('legal_classification and content_sensitivity are values the admin API actually accepts (Codex P1 :238, P2 :179)', () => {
    // Read the SAME enums admin-email-templates.js validates against,
    // rather than re-declaring the literals here (a hand-copied list would
    // pass even after the API's enum changed underneath it).
    const routeSrc = require('fs').readFileSync(
      require.resolve('../routes/admin-email-templates.js'), 'utf8',
    );
    const legalMatch = routeSrc.match(/LEGAL_CLASSIFICATIONS = new Set\(\[([^\]]+)\]\)/);
    const sensitivityMatch = routeSrc.match(/SENSITIVITIES = new Set\(\[([^\]]+)\]\)/);
    const legalValues = new Set(JSON.parse(`[${legalMatch[1]}]`.replace(/'/g, '"')));
    const sensitivityValues = new Set(JSON.parse(`[${sensitivityMatch[1]}]`.replace(/'/g, '"')));

    for (const t of migration.TEMPLATES) {
      const row = migration.__private.templateRow(t);
      expect(legalValues.has(row.legal_classification)).toBe(true);
      expect(sensitivityValues.has(row.content_sensitivity)).toBe(true);
    }
    for (const a of migration.AUTOMATIONS) {
      const row = migration.__private.automationRow(a);
      expect(legalValues.has(row.legal_classification)).toBe(true);
    }

    const nurture = migration.__private.templateRow(migration.TEMPLATES.find((t) => t.key === 'nurture.expired_1'));
    expect(nurture.legal_classification).toBe('commercial_marketing');
    expect(nurture.content_sensitivity).toBe('normal');
    const nurtureAutomation = migration.__private.automationRow(migration.AUTOMATIONS.find((a) => a.key === 'nurture.expired_1'));
    expect(nurtureAutomation.legal_classification).toBe('commercial_marketing');
  });

  test("nurture.expired_1's idempotency key includes {estimate_id}, not just {customer_email} (Codex P2 :239)", () => {
    const a = migration.AUTOMATIONS.find((x) => x.key === 'nurture.expired_1');
    expect(a.idempotency).toContain('{estimate_id}');
    expect(a.idempotency).toContain('{customer_email}');
  });

  test('every referenced variable is allowed and every required variable is referenced', () => {
    for (const t of migration.TEMPLATES) {
      const row = migration.__private.templateRow(t);
      const template = { ...row, allowed_variables: JSON.parse(row.allowed_variables), required_variables: JSON.parse(row.required_variables) };
      const version = { subject: t.subject, preview_text: t.preview, blocks: t.blocks, text_body: null };
      const validation = EmailTemplates.validationFor(template, version);
      expect(validation.disallowed_variables).toEqual([]);
      expect(validation.missing_required_in_template).toEqual([]);
      expect(validation.ok).toBe(true);
    }
  });

  test('running the migration twice inserts four templates, four versions, eight fixtures, three automations exactly once', async () => {
    const knex = fakeKnex(TABLES);
    await migration.up(knex);
    await migration.up(knex);

    expect(knex.__store.email_templates).toHaveLength(4);
    expect(knex.__store.email_template_versions).toHaveLength(4);
    expect(knex.__store.email_template_fixtures).toHaveLength(8);
    expect(knex.__store.email_template_automations).toHaveLength(3);

    for (const row of knex.__store.email_templates) expect(row.status).toBe('draft');
    for (const row of knex.__store.email_template_versions) expect(row.status).toBe('draft');
    for (const row of knex.__store.email_template_automations) expect(row.status).toBe('draft');

    const byKey = Object.fromEntries(knex.__store.email_template_automations.map((a) => [a.automation_key, a]));
    expect(byKey['lc.first_visit_pest']).toMatchObject({
      trigger_event_key: 'visit.completed_first', delay_minutes: 2880,
      suppression_group_key: 'service_operational', idempotency_key_template: 'lc.first_visit_pest:{customer_id}',
    });
    expect(byKey['lc.why_91_days']).toMatchObject({
      trigger_event_key: 'visit.completed_first', delay_minutes: 20160,
      idempotency_key_template: 'lc.why_91_days:{customer_id}',
    });
    expect(byKey['nurture.expired_1']).toMatchObject({
      trigger_event_key: 'estimate.expired', delay_minutes: 4320,
      suppression_group_key: 'marketing_nurture', idempotency_key_template: 'nurture.expired_1:{customer_email}:{estimate_id}',
    });
    expect(JSON.parse(byKey['lc.first_visit_pest'].exit_conditions)).toEqual({ stop_if: ['customer.cancelled'] });
    expect(JSON.parse(byKey['nurture.expired_1'].exit_conditions)).toEqual({ stop_if: ['estimate.accepted', 'estimate.archived'] });
  });

  test('down() is a documented no-op — it never deletes a row, edited or not (Codex P1 :398)', async () => {
    const knex = fakeKnex(TABLES);
    await migration.up(knex);
    const before = {
      templates: knex.__store.email_templates.length,
      versions: knex.__store.email_template_versions.length,
      fixtures: knex.__store.email_template_fixtures.length,
      automations: knex.__store.email_template_automations.length,
    };
    // Simulate an operator having edited one of the seeded rows since —
    // down() must not know or care; it touches nothing either way.
    knex.__store.email_templates[0].name = 'An operator renamed this by hand';

    await migration.down(knex);

    expect(knex.__store.email_templates.length).toBe(before.templates);
    expect(knex.__store.email_template_versions.length).toBe(before.versions);
    expect(knex.__store.email_template_fixtures.length).toBe(before.fixtures);
    expect(knex.__store.email_template_automations.length).toBe(before.automations);
    expect(knex.__store.email_templates[0].name).toBe('An operator renamed this by hand');
  });

  test('up() re-running never overwrites a template, version, or automation an operator has touched (local pre-push audit P1)', async () => {
    const knex = fakeKnex(TABLES);
    await migration.up(knex);

    const pestTemplate = knex.__store.email_templates.find((t) => t.template_key === 'lc.first_visit_pest');
    pestTemplate.created_by = 'tech-123'; // only ever set by an authenticated admin action
    pestTemplate.name = 'Operator-edited name';

    const pestVersion = knex.__store.email_template_versions.find((v) => v.template_id === pestTemplate.id);
    pestVersion.published_by = 'tech-123';
    pestVersion.subject = 'Operator-edited subject';
    pestVersion.blocks = JSON.stringify([{ type: 'paragraph', content: 'Operator-written copy.' }]);

    const pestAutomation = knex.__store.email_template_automations.find((a) => a.automation_key === 'lc.first_visit_pest');
    pestAutomation.last_published_by = 'tech-123';
    pestAutomation.delay_minutes = 9999;

    await migration.up(knex); // re-run

    expect(knex.__store.email_templates.find((t) => t.id === pestTemplate.id).name).toBe('Operator-edited name');
    expect(knex.__store.email_template_versions.find((v) => v.id === pestVersion.id).subject).toBe('Operator-edited subject');
    expect(JSON.parse(knex.__store.email_template_versions.find((v) => v.id === pestVersion.id).blocks)).toEqual([
      { type: 'paragraph', content: 'Operator-written copy.' },
    ]);
    expect(knex.__store.email_template_automations.find((a) => a.id === pestAutomation.id).delay_minutes).toBe(9999);

    // An UNTOUCHED template (no created_by/last_published_by/published_by)
    // still gets re-seeded normally — the guard is per-row, not global.
    const untouched = knex.__store.email_templates.find((t) => t.template_key === 'lc.why_91_days');
    expect(untouched.name).toBe('Lawn Care · Why 91 Days');
  });

  test("sendTemplate refuses each seeded template in its seeded ('draft') status, undisguised", async () => {
    mockDb = await seededKnex();
    for (const t of migration.TEMPLATES) {
      await expect(EmailTemplates.sendTemplate({
        templateKey: t.key, to: 'test@example.com', payload: {}, recipientType: 'customer', recipientId: 'r1',
      })).rejects.toMatchObject({ status: 409, code: 'EMAIL_TEMPLATE_DISABLED' });
    }
  });
});

describe('email division templates — rendering the actual post-migration rows', () => {
  let knex;
  beforeAll(async () => { knex = await seededKnex(); });

  for (const t of migration.TEMPLATES) {
    test(`${t.key}: full fixture renders subject/headings with no unresolved placeholders`, () => {
      const { template, version, fixtures } = finalStateFor(knex, t.key);
      const rendered = EmailTemplates.renderTemplate({ template, version, payload: fixtures.full });
      expect(rendered.missingPayload).toEqual([]);
      expect(rendered.subject).not.toMatch(PLACEHOLDER_RE);
      expect(rendered.html).not.toMatch(PLACEHOLDER_RE);
      expect(rendered.text).not.toMatch(PLACEHOLDER_RE);
      for (const block of version.blocks) {
        if (block.type === 'heading' && !PLACEHOLDER_RE.test(block.content)) {
          expect(rendered.text.toUpperCase()).toContain(block.content.toUpperCase());
        }
      }
    });
  }

  const DROPPED_HEADINGS = {
    'lc.first_visit_pest': ['Your number', 'Rain since the visit', 'Pets and re-entry'],
    'lc.why_91_days': ['This month near you'],
    'lc.rain_and_treatment': ['At your address this week', 'Looking ahead'],
    'nurture.expired_1': ['What we are seeing near you'],
  };

  for (const t of migration.TEMPLATES) {
    test(`${t.key}: sparse fixture drops every optional section, no placeholders, no blank number`, () => {
      const { template, version, fixtures } = finalStateFor(knex, t.key);
      const rendered = EmailTemplates.renderTemplate({ template, version, payload: fixtures.sparse });
      expect(rendered.missingPayload).toEqual([]);
      expect(rendered.html).not.toMatch(PLACEHOLDER_RE);
      expect(rendered.text).not.toMatch(PLACEHOLDER_RE);
      for (const heading of DROPPED_HEADINGS[t.key]) {
        expect(rendered.html).not.toContain(heading);
      }
      expect(rendered.text).not.toMatch(/ {2,}/);
      expect(rendered.text).not.toMatch(/\(\s*\)/);
      expect(rendered.text).not.toMatch(/\bfor\s+hours\b/i);
    });
  }

  test('lc.first_visit_pest pet-advisory fixture carries no fixed re-entry/drying minute figure', () => {
    const t = migration.TEMPLATES.find((x) => x.key === 'lc.first_visit_pest');
    for (const fixtureName of ['full', 'sparse']) {
      expect(t.fixtures[fixtureName].pet_advisory_sentence).not.toMatch(FIXED_MINUTE_FIGURE_RE);
    }
  });

  test('nurture.expired_1 sparse fixture drops the consultation offer block entirely', () => {
    const { template, version, fixtures } = finalStateFor(knex, 'nurture.expired_1');
    const rendered = EmailTemplates.renderTemplate({ template, version, payload: fixtures.sparse });
    expect(rendered.html).not.toContain('Not sure yet');
    expect(rendered.html).not.toContain('inspection');
  });

  test('nurture.expired_1 promises what the link actually does once expired, not "view your estimate" (Codex P1 :193)', () => {
    const { template, version, fixtures } = finalStateFor(knex, 'nurture.expired_1');
    const rendered = EmailTemplates.renderTemplate({ template, version, payload: fixtures.full });
    expect(rendered.text.toLowerCase()).toContain('request more time');
    expect(rendered.text).not.toMatch(/view your (saved )?estimate/i);
  });

  for (const t of migration.TEMPLATES) {
    for (const fixtureName of ['full', 'sparse']) {
      test(`${t.key} (${fixtureName}): no forbidden phrase, no $-digit price`, () => {
        const { template, version, fixtures } = finalStateFor(knex, t.key);
        const rendered = EmailTemplates.renderTemplate({ template, version, payload: fixtures[fixtureName] });
        const combined = renderedText(rendered).toLowerCase();
        expect(combined).not.toMatch(DOLLAR_DIGIT_RE);
        for (const phrase of BANNED_PHRASES) {
          expect(combined).not.toContain(phrase.toLowerCase());
        }
      });
    }
  }
});

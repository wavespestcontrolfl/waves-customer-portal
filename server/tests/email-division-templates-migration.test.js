/**
 * Email division templates — first-visit follow-up, why-91-days,
 * rain-and-treatment, expired-estimate (migration 20260928230000, the
 * re-cut of #5160/20260928080000 — that PR's seed migration was already
 * pushed and is frozen per waves-db §4, so this is a fresh seed on a fresh
 * branch incorporating every review finding directly, not a correction
 * chain on top of the old one).
 *
 * Pins six things:
 *  1. The migration seeds all four templates DRAFT and is insert-once
 *     (never updates a row that already exists — templates, versions, AND
 *     fixtures alike). No automation catalog rows are written at all
 *     (Codex P2 :280 on #5252 — the wiring PR that maps triggers must
 *     dispatch through the email division's sendWithLedger, not the
 *     executor's direct sendTemplate call, so no automation row belongs in
 *     this seed).
 *  2. down() is a documented no-op — it never deletes a row, edited or not
 *     (Codex #5160 P1 :398).
 *  3. Every field value is one the admin API's own enum actually accepts —
 *     legal_classification, content_sensitivity — checked against the SAME
 *     sets admin-email-templates.js uses, not hand-copied literals that
 *     could drift; `purpose` is confirmed to have NO such enum (also from
 *     source, not assumed).
 *  4. sendTemplate's OWN refusal path (assertTemplateSendable) rejects a
 *     seeded template — nothing here can send, and this is not mocked away.
 *  5. Every "full" fixture renders with no leftover {{placeholders}}; every
 *     "sparse" fixture drops its optional sections WHOLE (heading and all —
 *     the details-block mechanism the library already has), with no blank
 *     number and no banned/unsupported claim — including every phrase an
 *     independent Fable review found unsupported by
 *     server/services/email-division/fact-register-data.js
 *     (feat/email-division-fact-register-v4), so a removed claim can never
 *     silently come back.
 *  6. nurture.expired_1's service-chrome footer (email-template-library.js,
 *     Fable P1-1) names its OWN suppression group, not "referral emails".
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
const migration = require('../models/migrations/20260928230000_seed_email_division_templates');

// email_template_automations stays in the table list even though the
// migration never writes to it — the "no automation rows" test needs the
// table present to prove that, not merely absent from the fake schema.
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
  // Fable P1-2 on #5252: checked against fact-register-data.js
  // (feat/email-division-fact-register-v4) and found unsupported —
  // reworded or removed, must never come back.
  'you may still see ants after the visit', 'it scatters the colony',
  'spiders and wasps', 'keeps working after the ants you can see are gone',
  'wears with sun, rain and time', 'new colonies move in from the lot line',
  'renews the surface product sooner', 'floods colonies',
  'the two days after a storm', '91 days is our median',
  // Fable P2-4 on #5252: an unconditional extension promise and a false
  // "prices are on the page" claim for an ineligible/expired estimate.
  'the estimate page carries them', 'no new quote needed',
  'request more time on my estimate',
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
  const version = knex.__store.email_template_versions.find((v) => v.template_id === row.id);
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

describe('seed migration 20260928230000 (re-cut of #5160)', () => {
  test('seeds four draft templates', () => {
    expect(migration.TEMPLATES.map((t) => t.key)).toEqual([
      'lc.first_visit_pest', 'lc.why_91_days', 'lc.rain_and_treatment', 'nurture.expired_1',
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

  test('no email_template_automations rows are written (Codex P2 :280 on #5252 — deferred to the wiring PR, through sendWithLedger)', async () => {
    const knex = await seededKnex();
    expect(knex.__store.email_template_automations || []).toHaveLength(0);
    expect(migration.__private).not.toHaveProperty('automationRow');
    expect(migration).not.toHaveProperty('AUTOMATIONS');
  });

  test('the three lc.* templates are classified outside Lawn Care, in purpose AND in their displayed name (Codex #5160 P2 :43, #5252 P2 :91)', () => {
    for (const key of ['lc.first_visit_pest', 'lc.why_91_days', 'lc.rain_and_treatment']) {
      const t = migration.TEMPLATES.find((x) => x.key === key);
      expect(t.purpose).not.toBe('lawn_care');
      expect(t.purpose).toBe('pest');
      expect(t.name).not.toMatch(/lawn care/i);
      expect(t.name).toMatch(/^Pest Control/);
    }
  });

  test('nurture.expired_1 pins service chrome on its marketing_nurture stream, the same mechanism referral.invite uses (local pre-push audit round 3)', () => {
    // email-template-library.js sendTemplate: isMarketingSend is true for
    // ANY suppression_group_key starting with 'marketing_', and it forces
    // modeOverride to 'marketing' (the newsletter wrapper) UNLESS
    // layout_wrapper_id === 'service_pinned_v1'. mode: 'service' alone does
    // NOT survive that override — only the pin does.
    for (const t of migration.TEMPLATES) {
      const row = migration.__private.templateRow(t);
      if (String(row.suppression_group_key || '').startsWith('marketing_')) {
        expect(row.layout_wrapper_id).toBe('service_pinned_v1');
      } else {
        expect(row.layout_wrapper_id).toBe('service_default_v1');
      }
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

    const nurture = migration.__private.templateRow(migration.TEMPLATES.find((t) => t.key === 'nurture.expired_1'));
    expect(nurture.legal_classification).toBe('commercial_marketing');
    expect(nurture.content_sensitivity).toBe('normal');
  });

  test('purpose has no admin-API enum to validate against (confirmed from source, not assumed) — local pre-push audit round 4', () => {
    // admin-email-templates.js declares MODES/LEGAL_CLASSIFICATIONS/
    // AUDIENCES/PRIORITIES/SENSITIVITIES/STREAMS as validated Sets; `purpose`
    // is read with plain cleanString(), no assertOneOf — this pins that fact
    // so a future admin-route change that DOES add a purpose enum breaks
    // this test instead of shipping an unvalidated seed value silently.
    const routeSrc = require('fs').readFileSync(
      require.resolve('../routes/admin-email-templates.js'), 'utf8',
    );
    expect(routeSrc).toMatch(/purpose:\s*cleanString\(body\.purpose/);
    expect(routeSrc).not.toMatch(/PURPOSES\s*=\s*new Set/);
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

  test('running the migration twice inserts four templates, four versions, eight fixtures exactly once, and no automations', async () => {
    const knex = fakeKnex(TABLES);
    await migration.up(knex);
    await migration.up(knex);

    expect(knex.__store.email_templates).toHaveLength(4);
    expect(knex.__store.email_template_versions).toHaveLength(4);
    expect(knex.__store.email_template_fixtures).toHaveLength(8);
    expect(knex.__store.email_template_automations || []).toHaveLength(0);

    for (const row of knex.__store.email_templates) expect(row.status).toBe('draft');
    for (const row of knex.__store.email_template_versions) expect(row.status).toBe('draft');
  });

  test('down() is a documented no-op — it never deletes a row, edited or not (Codex P1 :398)', async () => {
    const knex = fakeKnex(TABLES);
    await migration.up(knex);
    const before = {
      templates: knex.__store.email_templates.length,
      versions: knex.__store.email_template_versions.length,
      fixtures: knex.__store.email_template_fixtures.length,
    };
    // Simulate an operator having edited one of the seeded rows since —
    // down() must not know or care; it touches nothing either way.
    knex.__store.email_templates[0].name = 'An operator renamed this by hand';

    await migration.down(knex);

    expect(knex.__store.email_templates.length).toBe(before.templates);
    expect(knex.__store.email_template_versions.length).toBe(before.versions);
    expect(knex.__store.email_template_fixtures.length).toBe(before.fixtures);
    expect(knex.__store.email_templates[0].name).toBe('An operator renamed this by hand');
  });

  test('up() is insert-once: a re-run never touches a template or version that already exists, even edited the way the REAL admin routes edit them (Fable P2-3 / Codex P2 :401 on #5252)', async () => {
    const knex = fakeKnex(TABLES);
    await migration.up(knex);

    // admin-email-templates.js's PUT /:key and PUT /versions/:id update
    // content and updated_at WITHOUT ever setting created_by /
    // last_published_by / published_by — the earlier touchedByHuman()
    // guard this migration carried would have missed exactly this shape of
    // edit. Mutate the store the same way: content changes only, no
    // provenance field set.
    const pestTemplate = knex.__store.email_templates.find((t) => t.template_key === 'lc.first_visit_pest');
    pestTemplate.name = 'Operator-edited name';
    pestTemplate.updated_at = new Date();

    const pestVersion = knex.__store.email_template_versions.find((v) => v.template_id === pestTemplate.id);
    pestVersion.subject = 'Operator-edited subject';
    pestVersion.blocks = JSON.stringify([{ type: 'paragraph', content: 'Operator-written copy.' }]);
    pestVersion.updated_at = new Date();

    await migration.up(knex); // re-run

    expect(knex.__store.email_templates.find((t) => t.id === pestTemplate.id).name).toBe('Operator-edited name');
    expect(knex.__store.email_template_versions.find((v) => v.id === pestVersion.id).subject).toBe('Operator-edited subject');
    expect(JSON.parse(knex.__store.email_template_versions.find((v) => v.id === pestVersion.id).blocks)).toEqual([
      { type: 'paragraph', content: 'Operator-written copy.' },
    ]);

    // No duplicate template/version rows were inserted for the edited key.
    expect(knex.__store.email_templates.filter((t) => t.template_key === 'lc.first_visit_pest')).toHaveLength(1);
    expect(knex.__store.email_template_versions.filter((v) => v.template_id === pestTemplate.id)).toHaveLength(1);

    // An untouched template still exists exactly once too (insert-once is
    // "leave existing rows alone", not "never seed anything").
    const untouched = knex.__store.email_templates.find((t) => t.template_key === 'lc.why_91_days');
    expect(untouched.name).toBe('Pest Control · Why 91 Days');
  });

  test('up() re-running never overwrites an existing fixture either (insert-once, no created_by/updated_by column on that table at all — local pre-push audit P1 round 2)', async () => {
    const knex = fakeKnex(TABLES);
    await migration.up(knex);

    const pestTemplate = knex.__store.email_templates.find((t) => t.template_key === 'lc.first_visit_pest');
    const fullFixture = knex.__store.email_template_fixtures.find((f) => f.template_id === pestTemplate.id && f.name === 'full');
    const edited = { ...JSON.parse(fullFixture.payload), pet_advisory_sentence: 'An operator edited this fixture by hand.' };
    fullFixture.payload = JSON.stringify(edited);

    await migration.up(knex); // re-run

    const reread = knex.__store.email_template_fixtures.find((f) => f.id === fullFixture.id);
    expect(JSON.parse(reread.payload).pet_advisory_sentence).toBe('An operator edited this fixture by hand.');
    // Still exactly 8 fixtures — a re-run neither duplicates nor drops any.
    expect(knex.__store.email_template_fixtures).toHaveLength(8);
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

  test('nurture.expired_1 promises only what holds for every recipient, eligible or not (Fable P2-4 on #5252)', () => {
    const { template, version, fixtures } = finalStateFor(knex, 'nurture.expired_1');
    const rendered = EmailTemplates.renderTemplate({ template, version, payload: fixtures.full });
    const text = rendered.text.toLowerCase();
    // isEstimateExtensionRequestEligible (estimate-public.js) is false for a
    // plan_restart source, a fixed-bid quote, or one never sent/viewed — an
    // ineligible recipient's link resolves to the "isn't valid, call us"
    // screen, not the extension action. The copy must not promise the
    // extension action unconditionally.
    expect(text).toContain("if it's still eligible");
    expect(text).toContain("if not, it'll tell you how to reach us");
    expect(text).not.toContain('no new quote needed');
    expect(text).not.toContain('the estimate page carries them');
  });

  test("nurture.expired_1's service-chrome footer names its OWN suppression group, not \"referral emails\" (Fable P1-1 on #5252)", () => {
    // The bug: renderTemplate's service-chrome unsubscribe footer was
    // hardcoded to "referral emails" for every service_pinned_v1 template.
    // Passing an unsubscribeUrl is what makes the footer render at all — the
    // earlier render tests above never passed one, so they could not have
    // caught this.
    const { template, version, fixtures } = finalStateFor(knex, 'nurture.expired_1');
    const rendered = EmailTemplates.renderTemplate({
      template, version, payload: fixtures.full, unsubscribeUrl: 'https://example.test/unsub/abc',
    });
    expect(rendered.html).toContain('these follow-ups');
    expect(rendered.html).not.toContain('referral emails');
  });

  test('no "Source:" footer hardcodes a year — this migration is insert-once/frozen and never auto-updates the seeded copy (local pre-push audit round 6)', () => {
    for (const t of migration.TEMPLATES) {
      const { template, version, fixtures } = finalStateFor(knex, t.key);
      const rendered = EmailTemplates.renderTemplate({ template, version, payload: fixtures.full });
      const sourceLine = rendered.text.split('\n\n').find((p) => p.startsWith('Source:'));
      if (sourceLine) expect(sourceLine).not.toMatch(/\b20\d{2}\b/);
    }
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

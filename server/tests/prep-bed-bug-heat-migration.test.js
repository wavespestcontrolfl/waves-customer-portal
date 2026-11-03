/**
 * 20261102190000: the prep.bed_bug_heat customer sheet, its automation, and
 * the chemical guide's pointer to it. Fake-knex unit suite (no database):
 * the seed is insert-only, the copy follows the v3 prep compliance rules, and
 * the old "separate prep" sentence is swapped by exact match.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => false), sendOne: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({}));
const mockRecordAuditEvent = jest.fn(async () => 'audit-1');
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...args) => mockRecordAuditEvent(...args) }));

const fs = require('fs');
const path = require('path');
const migration = require('../models/migrations/20261102190000_seed_prep_bed_bug_heat');
const v3 = require('../models/migrations/20260924000007_prep_guide_content_v3_codex_r6');
const v3Steps = require('../models/migrations/20260924000005_prep_guide_content_v3_codex_r4');
const { normalizeBlocks, renderTemplate } = require('../services/email-template-library');
const { BED_BUG_HEAT_KEYWORDS, isBedBugHeatServiceType } = require('../utils/bed-bug-heat-service');
const ProjectEmail = require('../services/project-email');

const {
  TEMPLATE, FIXTURE_PAYLOAD, HEAT_SERVICE_NAMES, OLD_SENTENCE, NEW_SENTENCE,
  OLD_STEP_SENTENCE, NEW_STEP_SENTENCE, MIGRATION_MARKER,
} = migration.__private;

function chunks(t = TEMPLATE) {
  const out = [`subject: ${t.subject}`, `preview: ${t.preview}`];
  for (const b of t.blocks) {
    if (typeof b.content === 'string') out.push(b.content);
    for (const item of b.items || []) out.push(item);
    for (const row of b.rows || []) out.push(`${row.label} ${row.value}`);
  }
  return out;
}

// ── a small in-memory knex ────────────────────────────────────────────
function makeKnex(seed = {}) {
  const tables = {
    email_templates: [], email_template_versions: [], email_template_fixtures: [],
    email_template_automations: [], automation_steps: [], ...seed,
  };
  let nextId = 1;
  const knex = (name) => {
    const conds = [];
    let order = null;
    const rows = () => {
      let found = tables[name].filter((r) => conds.every((c) => Object.entries(c).every(([k, v]) => r[k] === v)));
      if (order) found = [...found].sort((a, b) => (order[1] === 'desc' ? b[order[0]] - a[order[0]] : a[order[0]] - b[order[0]]));
      return found;
    };
    const q = {
      where(c) { conds.push(c); return q; },
      forUpdate() { return q; },
      orderBy(col, dir) { order = [col, dir]; return q; },
      first() { return Promise.resolve(rows()[0]); },
      update(patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return Promise.resolve(hit.length); },
      insert(row) {
        const inserted = { id: `id-${nextId++}`, ...row };
        tables[name].push(inserted);
        const result = Promise.resolve([inserted]);
        result.returning = () => Promise.resolve([inserted]);
        return result;
      },
    };
    return q;
  };
  knex.tables = tables;
  knex.transaction = async (fn) => fn(knex);
  knex.schema = { hasTable: async (t) => t in tables };
  return knex;
}

const CHEMICAL_TEMPLATE = {
  id: 'tpl-chem', template_key: 'prep.bed_bug', mode: 'service', purpose: 'prep', legal_classification: 'transactional_relationship',
  audience: 'customer', message_priority: 'normal', content_sensitivity: 'health_safety', send_stream: 'service_operational',
  suppression_group_key: 'service_operational', layout_wrapper_id: 'service_default_v1', from_name: 'Waves Pest Control',
  from_email: 'contact@wavespestcontrol.com', reply_to: 'contact@wavespestcontrol.com', default_cta_label: null,
  default_cta_url_variable: null, allowed_variables: ['first_name', 'prep_url'], required_variables: ['first_name'],
  optional_variables: ['prep_url'], status: 'active', active_version_id: 'v-chem-1',
};

function chemicalVersion(blocks) {
  return { id: 'v-chem-1', template_id: 'tpl-chem', version_number: 7, status: 'active', subject: 'S', preview_text: 'P', blocks: JSON.stringify(blocks), text_body: null };
}

function liveChemicalBlocks() {
  return JSON.parse(JSON.stringify(v3.TEMPLATES.find((t) => t.key === 'prep.bed_bug').blocks));
}

function seededKnex(overrides = {}) {
  return makeKnex({
    email_templates: [{ ...CHEMICAL_TEMPLATE }],
    email_template_versions: [chemicalVersion(liveChemicalBlocks())],
    email_template_automations: [{ id: 'auto-chem', automation_key: 'prep.bed_bug', status: 'active', exit_conditions: { stop_if: ['appointment.cancelled', 'appointment.closed', 'appointment.past'] } }],
    automation_steps: [{ id: 'step-1', template_key: 'bed_bug', step_order: 0, html_body: v3Steps.STEP_SWAPS.find((s) => s.templateKey === 'bed_bug').toHtml, text_body: 'x' }],
    ...overrides,
  });
}

beforeEach(() => mockRecordAuditEvent.mockClear());

describe('migration identity and audit', () => {
  test('migration file name stays short enough for the audit_log.action neighbors', () => {
    const file = path.basename(require.resolve('../models/migrations/20261102190000_seed_prep_bed_bug_heat'), '.js');
    expect(file.length).toBeLessThanOrEqual(57);
  });

  test('audit actions fit audit_log.action varchar(96)', () => {
    expect(migration.AUDIT_SEEDED.length).toBeLessThanOrEqual(96);
    expect(migration.AUDIT_CORRECTED.length).toBeLessThanOrEqual(96);
  });

  test('is a plain template migration: down() is a no-op', async () => {
    await expect(migration.down()).resolves.toBeUndefined();
  });
});

describe('heat prep sheet copy', () => {
  test('follows the v3 prep compliance rules', () => {
    for (const chunk of chunks()) {
      expect(chunk).not.toMatch(/\bsafe(ly)?\b/i);
      expect(chunk).not.toMatch(/(out of the (home|house|kitchen|room)|stay (out|away|off)|re-?enter|be out)[^.]{0,50}\d+\s*(–|-|to)?\s*\d*\s*(hour|hr|minute|min)/i);
      expect(chunk).not.toMatch(/Waves Lawn (&|and) Pest/i);
      expect(chunk).not.toMatch(/per visit/i);
      expect(chunk).not.toMatch(/fumigat|tent(ing|ed)?\b/i);
      expect(chunk).not.toMatch(/insulation|set-and-forget/i);
    }
  });

  test('carries the source checklist substance', () => {
    const text = chunks().join('\n');
    expect(text).toMatch(/hot water/);
    expect(text).toMatch(/at least 30 minutes/);
    expect(text).toMatch(/sealed plastic bags/);
    for (const item of ['instruments', 'Vinyl records', 'medications', 'Houseplants', 'artwork', 'Batteries', 'Candles']) {
      expect(text).toContain(item);
    }
    expect(text).toMatch(/18 inches/);
    expect(text).toMatch(/on their edge/);
    expect(text).toMatch(/fish tanks/);
    expect(text).toMatch(/Turn off the air conditioning and fans/);
    expect(text).toMatch(/Close all windows/);
    expect(text).toMatch(/keys or codes/);
    expect(text).toMatch(/6 to 8 hours/);
    expect(text).toMatch(/Do not go back inside until your technician says you can/);
    expect(text).toMatch(/at least 24 hours before we arrive/);
  });

  test('the technician handles smoke detectors; customers are never told to remove them', () => {
    const lists = TEMPLATE.blocks.flatMap((b) => b.items || []);
    expect(lists.join('\n')).not.toMatch(/smoke/i);
    expect(chunks().join('\n')).toMatch(/Leave your smoke detectors alone\. Your technician handles them\./);
  });

  test('the electronics line is heat-specific and batteries still come out', () => {
    const text = chunks().join('\n');
    expect(text).toMatch(/For a heat treatment they can stay in the room/);
    expect(text).toMatch(/Batteries and battery-operated devices are the exception/);
  });

  test('no guarantee, no customer data, no generic letter text', () => {
    const text = chunks().join('\n');
    expect(text).not.toMatch(/guarantee|warrant|12[- ]month|30[- ]day/i);
    expect(text).not.toMatch(/Dear Homeowner/i);
    expect(text).not.toMatch(/\{\{(?!first_name|project_type|service_date|property_address|prep_url)[^}]+\}\}/);
    // The only phone numbers are the company lines in the shared signature.
    const phones = text.match(/\(\d{3}\) \d{3}-\d{4}|\d{3}-\d{3}-\d{4}/g) || [];
    const signatureOnly = TEMPLATE.blocks.find((b) => b.type === 'signature').content.match(/\(\d{3}\) \d{3}-\d{4}|\d{3}-\d{3}-\d{4}/g) || [];
    expect(phones.sort()).toEqual(signatureOnly.sort());
  });

  test('sentences stay short', () => {
    for (const block of TEMPLATE.blocks.filter((b) => b.type === 'list')) {
      for (const item of block.items) expect(item.split(/\s+/).length).toBeLessThanOrEqual(24);
    }
  });

  test('renders with the fixture and leaves no placeholder behind', () => {
    const blocks = normalizeBlocks(TEMPLATE.blocks);
    const html = renderTemplate({
      template: { ...CHEMICAL_TEMPLATE, template_key: TEMPLATE.key },
      version: { subject: TEMPLATE.subject, preview_text: TEMPLATE.preview, blocks },
      payload: FIXTURE_PAYLOAD,
    });
    const rendered = typeof html === 'string' ? html : JSON.stringify(html);
    expect(rendered).toContain('Stan');
    expect(rendered).not.toMatch(/\{\{/);
  });
});

describe('seed', () => {
  test('inserts the template, version, fixture and automation, copying the chemical row settings', async () => {
    const knex = seededKnex();
    await migration.up(knex);

    const created = knex.tables.email_templates.find((t) => t.template_key === 'prep.bed_bug_heat');
    expect(created).toMatchObject({
      name: 'Bed Bug Heat Prep Guide', purpose: 'prep', content_sensitivity: 'health_safety',
      send_stream: 'service_operational', suppression_group_key: 'service_operational', status: 'active',
    });
    expect(JSON.parse(created.allowed_variables)).toEqual(['first_name', 'prep_url']);
    const version = knex.tables.email_template_versions.find((v) => v.id === created.active_version_id);
    expect(version).toMatchObject({ version_number: 1, status: 'active', subject: TEMPLATE.subject });
    expect(JSON.parse(version.blocks)).toEqual(TEMPLATE.blocks);
    expect(knex.tables.email_template_fixtures).toHaveLength(1);

    const automation = knex.tables.email_template_automations.find((a) => a.automation_key === 'prep.bed_bug_heat');
    expect(automation).toMatchObject({
      trigger_event_key: 'appointment.booked', template_key: 'prep.bed_bug_heat', status: 'active',
      frequency_cap: 'once_per_appointment', idempotency_key_template: 'prep.bed_bug_heat:{scheduled_service_id}',
    });
    expect(JSON.parse(automation.conditions)).toEqual({ service_type_contains: HEAT_SERVICE_NAMES });
    expect(JSON.parse(automation.exit_conditions).stop_if).toEqual(['appointment.cancelled', 'appointment.closed', 'appointment.past']);
  });

  test('the automation mirrors a paused chemical automation', async () => {
    const knex = seededKnex({ email_template_automations: [{ id: 'a', automation_key: 'prep.bed_bug', status: 'paused', exit_conditions: { stop_if: [] } }] });
    await migration.up(knex);
    expect(knex.tables.email_template_automations.find((a) => a.automation_key === 'prep.bed_bug_heat').status).toBe('paused');
  });

  test('writes one critical seed audit row and a copy-corrected row, each within 96 characters', async () => {
    await migration.up(seededKnex());
    const actions = mockRecordAuditEvent.mock.calls.map(([event]) => event.action);
    expect(actions).toEqual(['email_template.seeded', 'email_template.copy_corrected']);
    for (const [event] of mockRecordAuditEvent.mock.calls) {
      expect(event.action.length).toBeLessThanOrEqual(96);
      expect(event.critical).toBe(true);
      expect(event.actor_type).toBe('system');
    }
  });

  test('is insert-only: an existing heat template (an office edit) is left alone, with no audit row for it', async () => {
    const knex = seededKnex();
    knex.tables.email_templates.push({ id: 'tpl-heat', template_key: 'prep.bed_bug_heat', name: 'Office name' });
    knex.tables.email_template_automations.push({ id: 'a-heat', automation_key: 'prep.bed_bug_heat', status: 'paused' });
    await migration.up(knex);
    expect(knex.tables.email_templates.filter((t) => t.template_key === 'prep.bed_bug_heat')).toEqual([{ id: 'tpl-heat', template_key: 'prep.bed_bug_heat', name: 'Office name' }]);
    expect(knex.tables.email_template_automations.filter((a) => a.automation_key === 'prep.bed_bug_heat')).toHaveLength(1);
    expect(mockRecordAuditEvent.mock.calls.map(([e]) => e.action)).not.toContain('email_template.seeded');
  });

  test('a second run changes nothing', async () => {
    const knex = seededKnex();
    await migration.up(knex);
    const snapshot = JSON.stringify(knex.tables);
    mockRecordAuditEvent.mockClear();
    await migration.up(knex);
    expect(JSON.stringify(knex.tables)).toBe(snapshot);
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  test('skips quietly when the chemical template is missing', async () => {
    const knex = makeKnex();
    await migration.up(knex);
    expect(knex.tables.email_templates).toEqual([]);
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  test('skips quietly when the template tables do not exist', async () => {
    const knex = makeKnex();
    knex.schema.hasTable = async () => false;
    await expect(migration.up(knex)).resolves.toBeUndefined();
  });
});

describe('chemical guide pointer', () => {
  test('the old sentence is in the shipped chemical guide exactly once, and in the step-0 body exactly once', () => {
    const chemical = v3.TEMPLATES.find((t) => t.key === 'prep.bed_bug');
    const hits = chemical.blocks.filter((b) => typeof b.content === 'string' && b.content.includes(OLD_SENTENCE));
    expect(hits).toHaveLength(1);
    const step = v3Steps.STEP_SWAPS.find((s) => s.templateKey === 'bed_bug').toHtml;
    expect(step.split(OLD_STEP_SENTENCE)).toHaveLength(2);
  });

  test('publishes a new active chemical version with the sentence swapped and every other block kept', async () => {
    const knex = seededKnex();
    await migration.up(knex);
    const chemical = knex.tables.email_templates.find((t) => t.template_key === 'prep.bed_bug');
    const versions = knex.tables.email_template_versions.filter((v) => v.template_id === 'tpl-chem');
    expect(versions).toHaveLength(2);
    const live = versions.find((v) => v.id === chemical.active_version_id);
    expect(live).toMatchObject({ version_number: 8, status: 'active' });
    expect(JSON.parse(live.validation_snapshot)).toMatchObject({ source: MIGRATION_MARKER, supersedes_version: 7 });
    expect(versions.find((v) => v.id === 'v-chem-1').status).toBe('archived');

    const before = liveChemicalBlocks();
    const after = JSON.parse(live.blocks);
    const changed = after.filter((b, i) => JSON.stringify(b) !== JSON.stringify(before[i]));
    expect(changed).toHaveLength(1);
    expect(changed[0].content).toContain(NEW_SENTENCE);
    expect(changed[0].content).not.toContain('technician will send separate prep');
    expect(NEW_SENTENCE).not.toMatch(/electronics/i);
  });

  test('an office edit that removed the sentence leaves the chemical guide alone', async () => {
    const blocks = liveChemicalBlocks().map((b) => (typeof b.content === 'string' ? { ...b, content: b.content.replace(OLD_SENTENCE, 'Office wording.') } : b));
    const knex = seededKnex({ email_template_versions: [chemicalVersion(blocks)] });
    await migration.up(knex);
    expect(knex.tables.email_template_versions.filter((v) => v.template_id === 'tpl-chem')).toHaveLength(1);
    expect(mockRecordAuditEvent.mock.calls.map(([e]) => e.action)).toEqual(['email_template.seeded']);
  });

  test('a custom plain-text body is left whole', async () => {
    const version = { ...chemicalVersion(liveChemicalBlocks()), text_body: 'custom' };
    const knex = seededKnex({ email_template_versions: [version] });
    await migration.up(knex);
    expect(knex.tables.email_template_versions.filter((v) => v.template_id === 'tpl-chem')).toHaveLength(1);
  });

  test('swaps the sentence in the bed bug sequence step-0 body and refreshes its text', async () => {
    const knex = seededKnex();
    await migration.up(knex);
    const step = knex.tables.automation_steps[0];
    expect(step.html_body).toContain(NEW_STEP_SENTENCE);
    expect(step.html_body).not.toContain(OLD_STEP_SENTENCE);
    expect(step.text_body).toContain(NEW_STEP_SENTENCE);
  });

  test('an office-edited step body without the sentence is untouched', async () => {
    const knex = seededKnex({ automation_steps: [{ id: 's', template_key: 'bed_bug', step_order: 0, html_body: '<p>Office</p>', text_body: 'Office' }] });
    await migration.up(knex);
    expect(knex.tables.automation_steps[0]).toMatchObject({ html_body: '<p>Office</p>', text_body: 'Office' });
  });

  test('the new chemical sentence still passes the chemical guide rules', () => {
    expect(NEW_SENTENCE).not.toMatch(/\bsafe(ly)?\b/i);
    expect(NEW_SENTENCE).toMatch(/heat or hybrid treatment/);
    expect(NEW_STEP_SENTENCE).toMatch(/heat or hybrid method/);
  });
});

describe('wiring', () => {
  test('heat and hybrid names select the heat sheet; chemical names do not', () => {
    for (const name of ['Bed Bug Heat Treatment', 'Bed Bug Hybrid Heat + Residual Program', 'bed bug heat', 'Hybrid Bed Bug Treatment']) {
      expect(isBedBugHeatServiceType(name)).toBe(true);
    }
    for (const name of ['Bed Bug Treatment Service', 'Bed Bug Chemical/IPM Program', 'Heat Pump Service', '', null, undefined]) {
      expect(isBedBugHeatServiceType(name)).toBe(false);
    }
  });

  test('the migration condition names match the shared keyword list', () => {
    expect(HEAT_SERVICE_NAMES).toEqual([...BED_BUG_HEAT_KEYWORDS]);
  });

  test('the sheet is a known prep template key for tokened prep pages', () => {
    expect(ProjectEmail.isPrepTemplateKey('prep.bed_bug_heat')).toBe(true);
    expect(ProjectEmail.isPrepTemplateKey('prep.bed_bug')).toBe(true);
    expect(ProjectEmail.isPrepTemplateKey('prep.wildlife')).toBe(true);
    expect(ProjectEmail.isPrepTemplateKey('prep.nope')).toBe(false);
  });

  test('the prep page maps the heat key to the bed bug visit family', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/prep-public.js'), 'utf8');
    expect(source).toMatch(/'prep\.bed_bug_heat': 'bed_bug'/);
  });
});

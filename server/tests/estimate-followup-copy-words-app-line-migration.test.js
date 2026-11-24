/**
 * Migration 20261122140000 (owner-approved copy, no gate): the 2-hour estimate email's new words,
 * "reschedule a visit yourself" in three follow-up emails, and the Waves app paragraph + video
 * in the other four. Runs against a small in-memory knex stand-in (the published-version
 * mechanics are the same as 20261019200000; the real library validates every new version).
 * Starting blocks are the 2026-09-26 production snapshot of the seven templates. Synthetic data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const { recordAuditEvent } = require('../services/audit-log');
const { validationFor } = require('../services/email-template-library');
const migration = require('../models/migrations/20261122140000_estimate_followup_copy_words_app_line');
const copyAudit = require('../models/migrations/20260926120200_customer_copy_audit_automations');
const videoMigration = require('../models/migrations/20260723300000_engage_video_modules');
const baseline = require('./fixtures/customer-copy-audit-email-baseline.json');

const { STEP_SWAPS, APP_BLOCKS, ANY_VISIT, A_VISIT, WORDS_KEYS, APP_KEYS } = migration._private;
const ALL_KEYS = [...WORDS_KEYS, ...APP_KEYS];
const html = STEP_SWAPS.find((s) => s.field === 'html_body');
const text = STEP_SWAPS.find((s) => s.field === 'text_body');
const startBlocks = (key) => structuredClone(baseline.find((t) => t.template_key === key).blocks);

// ---- in-memory knex ---------------------------------------------------------
function makeDb(tables) {
  let seq = 0;
  const run = (name, q) => {
    const rows = tables[name];
    const hit = rows.filter((r) => q.filters.every(([k, v]) => r[k] === v));
    if (q.order) hit.sort((a, b) => (a[q.order[0]] - b[q.order[0]]) * (q.order[1] === 'desc' ? -1 : 1));
    if (q.insert) {
      const row = { id: `id-${++seq}`, ...q.insert };
      rows.push(row);
      return [row];
    }
    if (q.patch) { hit.forEach((r) => Object.assign(r, q.patch)); return hit.length; }
    return hit;
  };
  const db = (name) => {
    const q = { filters: [] };
    const api = {
      where(obj) { q.filters.push(...Object.entries(obj)); return api; },
      forUpdate() { return api; },
      orderBy(col, dir = 'asc') { q.order = [col, dir]; return api; },
      select() { return api; },
      returning() { return api; },
      insert(row) { q.insert = row; return api; },
      update(patch) { q.patch = patch; return api; },
      async first() { return run(name, q)[0]; },
      then(res, rej) { return Promise.resolve().then(() => run(name, q)).then(res, rej); },
    };
    return api;
  };
  db.fn = { now: () => 'NOW' };
  db.schema = { hasTable: async (name) => name in tables };
  db.transaction = async (cb) => cb(db);
  return db;
}

function seed({ steps = true } = {}) {
  const tables = { email_templates: [], email_template_versions: [], audit_log: [] };
  if (steps) {
    tables.automation_steps = [
      { id: 's-html', template_key: 'estimate_sent', step_order: 0, subject: 'Subject kept', preview_text: 'Preview kept', html_body: html.before, text_body: text.before },
      { id: 's-other', template_key: 'new_lead', step_order: 0, subject: 'x', preview_text: 'y', html_body: '<p>other</p>', text_body: 'other' },
    ];
  }
  for (const key of ALL_KEYS) {
    const blocks = startBlocks(key);
    // an empty allow-list means "no limit" to the library, which then reports every variable the blocks use
    const vars = validationFor({}, { subject: 'S', preview_text: 'P', blocks }).referenced_variables;
    const template = { id: `t-${key}`, template_key: key, allowed_variables: vars, required_variables: [], optional_variables: vars, active_version_id: `v-${key}-1` };
    tables.email_templates.push(template);
    tables.email_template_versions.push(
      { id: `v-${key}-1`, template_id: template.id, version_number: 1, status: 'active', subject: 'S', preview_text: 'P', blocks: JSON.stringify(blocks), text_body: null },
      { id: `v-${key}-d`, template_id: template.id, version_number: 2, status: 'draft', subject: 'S', preview_text: 'P', blocks: JSON.stringify([{ type: 'paragraph', content: 'Admin draft' }]), text_body: null },
    );
  }
  return tables;
}

const activeBlocks = (tables, key) => {
  const t = tables.email_templates.find((x) => x.template_key === key);
  const v = tables.email_template_versions.find((x) => x.id === t.active_version_id);
  return JSON.parse(v.blocks);
};
const versionsOf = (tables, key) => tables.email_template_versions.filter((v) => v.template_id === `t-${key}`);

const label = (b) => {
  if (b.type === 'small_note' && b.content === '{{report_video_caption}}') return 'caption';
  if (b.type === 'paragraph' && b.content.includes('the Waves app keeps everything')) return 'app-paragraph';
  if (b.type === 'image' && b.src.endsWith('waves-app-tour-poster.jpg')) return 'app-video';
  if (b.type === 'small_note' && b.content === 'Tap to watch the Waves app in action.') return 'app-note';
  if (b.type === 'image' && b.src === '{{report_video_preview}}') return 'report-video';
  return b.type;
};

beforeEach(() => { jest.clearAllMocks(); jest.spyOn(console, 'warn').mockImplementation(() => {}); jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

// ---- Part 1 -----------------------------------------------------------------
describe('Part 1: the 2-hour estimate email', () => {
  test('starts from exactly what 20260926120200 left in the row', () => {
    const live = copyAudit._STEP_SWAPS.filter((s) => s.key === 'estimate_sent');
    expect(html.before).toBe(live.find((s) => s.field === 'html_body').after);
    expect(text.before).toBe(live.find((s) => s.field === 'text_body').after);
  });

  test('the new words: a new first line, two rows gone, the app paragraph after the list, the rest byte for byte', () => {
    expect(html.after).toContain('<p>Any questions about your Waves estimate? Just reply to this email and a real person answers.</p>');
    expect(html.after).toContain(`<p>${A_VISIT.replace('And the Waves', 'The Waves')}</p>`);
    expect(html.after).not.toMatch(/Am I locked in|activity between visits|couple of hours ago/);
    // every other line is today's text, byte for byte
    const oldLines = html.before.split('\n');
    const newLines = html.after.split('\n');
    expect(newLines.filter((l) => !oldLines.includes(l))).toEqual([
      '<p>Any questions about your Waves estimate? Just reply to this email and a real person answers.</p>',
      '<p>The Waves app keeps everything in one place — every visit and every report, pay in a tap, and if a time stops working you can reschedule a visit yourself, right from the app.</p>',
    ]);
    expect(oldLines.filter((l) => !newLines.includes(l))).toEqual([
      "<p>We sent your estimate over a couple of hours ago and wanted to follow up personally. No sales pitch — just making sure it landed and answering anything you're wondering about.</p>",
      "  <li><strong>Am I locked in?</strong> No. We don't do commitment contracts — you can pause or cancel anytime.</li>",
      "  <li><strong>What if I see activity between visits?</strong> On recurring plans, re-services between visits are free — reply to a service reminder text and we're back out.</li>",
    ]);
    expect(text.after).toBe('Hi {{first_name}} — thanks for considering Waves. Any questions about your Waves estimate? Just reply to this email and a real person answers. A couple of common questions: you can start whenever (most folks pick 1–2 weeks out); your price holds for the quoted service until the estimate expires. The Waves app keeps everything in one place — every visit and every report, pay in a tap, and if a time stops working you can reschedule a visit yourself, right from the app. Reply with any questions — it goes straight to our local team. — The Waves Pest Control team');
    for (const s of [html, text]) expect(s.after.match(/\{\{\w+\}\}/g)).toEqual(['{{first_name}}']);
  });

  test('up rewrites a matching row, leaves subject, preview and other steps alone, and audits', async () => {
    const tables = seed();
    await migration.up(makeDb(tables));
    const row = tables.automation_steps[0];
    expect(row.html_body).toBe(html.after);
    expect(row.text_body).toBe(text.after);
    expect(row.updated_at).toBe('NOW');
    expect([row.subject, row.preview_text]).toEqual(['Subject kept', 'Preview kept']);
    expect(tables.automation_steps[1]).toMatchObject({ html_body: '<p>other</p>', text_body: 'other' });
    const audits = recordAuditEvent.mock.calls.map(([e]) => e).filter((e) => e.action === 'automation_copy_updated');
    expect(audits.map((e) => e.metadata.field).sort()).toEqual(['html_body', 'text_body']);
    expect(audits[0]).toMatchObject({ resource_type: 'automation_steps', resource_id: 's-html', actor_type: 'system', critical: true });
    expect(audits[0].metadata.migration).toBe('20261122140000_estimate_followup_copy_words_app_line');
  });

  test('a field an administrator has edited stays as it is; the other field still updates', async () => {
    const tables = seed();
    tables.automation_steps[0].html_body = `${html.before}\n<p>Admin line</p>`;
    await migration.up(makeDb(tables));
    expect(tables.automation_steps[0].html_body).toBe(`${html.before}\n<p>Admin line</p>`);
    expect(tables.automation_steps[0].text_body).toBe(text.after);
  });

  test('a later estimate_sent step that reuses the same body is another email and stays as it is', async () => {
    const tables = seed();
    tables.automation_steps.push({ id: 's-later', template_key: 'estimate_sent', step_order: 1, subject: 'Later', preview_text: 'Later', html_body: html.before, text_body: text.before });
    await migration.up(makeDb(tables));
    expect(tables.automation_steps[0]).toMatchObject({ html_body: html.after, text_body: text.after });
    expect(tables.automation_steps.find((r) => r.id === 's-later')).toMatchObject({ html_body: html.before, text_body: text.before });
    const audits = recordAuditEvent.mock.calls.map(([e]) => e).filter((e) => e.action === 'automation_copy_updated');
    expect(audits.map((e) => e.resource_id)).toEqual(['s-html', 's-html']);
  });

  test('down is a no-op: it changes no row and publishes no version', async () => {
    const tables = seed();
    const db = makeDb(tables);
    await migration.up(db);
    const snapshot = JSON.stringify(tables);
    recordAuditEvent.mockClear();
    await migration.down(db);
    expect(JSON.stringify(tables)).toBe(snapshot);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('a second run changes nothing', async () => {
    const tables = seed();
    const db = makeDb(tables);
    await migration.up(db);
    const snapshot = JSON.stringify(tables);
    recordAuditEvent.mockClear();
    await migration.up(db);
    expect(JSON.stringify(tables)).toBe(snapshot);
    expect(recordAuditEvent.mock.calls.filter(([e]) => e.action === 'automation_copy_updated')).toHaveLength(0);
  });

  test('a database without automation_steps still publishes the templates', async () => {
    const tables = seed({ steps: false });
    await migration.up(makeDb(tables));
    expect(activeBlocks(tables, 'estimate.engage_expiring').map(label)).toContain('app-paragraph');
  });
});

// ---- Part 2 + 3 --------------------------------------------------------------
describe('Parts 2 and 3: the follow-up email blocks', () => {
  test('the three added blocks equal what the live templates carry once "any" becomes "a"', () => {
    const live = videoMigration._TEMPLATES.find((t) => t.key === 'estimate.engage_high_intent').blocks;
    const at = live.findIndex((b) => b.content?.includes('the Waves app keeps'));
    const carried = structuredClone(live.slice(at, at + 3));
    expect(carried[0].content).toBe(ANY_VISIT);
    carried[0].content = A_VISIT;
    expect(APP_BLOCKS).toEqual(carried);
    expect(A_VISIT).toBe(ANY_VISIT.replace('reschedule any visit', 'reschedule a visit'));
    for (const key of WORDS_KEYS) {
      const snapshot = baseline.find((t) => t.template_key === key).blocks;
      expect(snapshot.some((b) => b.content === ANY_VISIT)).toBe(true);
    }
  });

  test('final block order of all seven templates', async () => {
    const tables = seed();
    await migration.up(makeDb(tables));
    const order = Object.fromEntries(ALL_KEYS.map((k) => [k, activeBlocks(tables, k).map(label)]));
    expect(order).toEqual({
      'estimate.engage_unopened': ['heading', 'paragraph', 'paragraph', 'heading', 'image', 'list', 'heading', 'paragraph', 'paragraph', 'report-video', 'caption', 'app-paragraph', 'app-video', 'app-note', 'heading', 'details', 'small_note', 'cta', 'cta', 'small_note', 'signature'],
      'estimate.engage_expiring_unseen': ['heading', 'paragraph', 'paragraph', 'heading', 'image', 'list', 'heading', 'paragraph', 'paragraph', 'report-video', 'caption', 'app-paragraph', 'app-video', 'app-note', 'paragraph', 'heading', 'details', 'small_note', 'cta', 'cta', 'small_note', 'signature'],
      'estimate.engage_high_intent': ['paragraph', 'paragraph', 'heading', 'paragraph', 'report-video', 'caption', 'app-paragraph', 'app-video', 'app-note', 'heading', 'list', 'small_note', 'cta', 'small_note', 'signature'],
      'estimate.engage_expiring': ['paragraph', 'paragraph', 'report-video', 'caption', 'app-paragraph', 'app-video', 'app-note', 'paragraph', 'heading', 'list', 'small_note', 'cta', 'small_note', 'signature'],
      'estimate.engage_gone_quiet': ['paragraph', 'paragraph', 'paragraph', 'heading', 'list', 'report-video', 'caption', 'app-paragraph', 'app-video', 'app-note', 'heading', 'details', 'small_note', 'cta', 'cta', 'signature'],
      'estimate.engage_return_after_dark': ['paragraph', 'paragraph', 'paragraph', 'paragraph', 'report-video', 'caption', 'app-paragraph', 'app-video', 'app-note', 'heading', 'list', 'small_note', 'cta', 'small_note', 'signature'],
      'estimate.engage_return_visit': ['paragraph', 'paragraph', 'heading', 'paragraph', 'report-video', 'caption', 'app-paragraph', 'app-video', 'app-note', 'heading', 'list', 'small_note', 'cta', 'signature'],
    });
  });

  test('Part 2 changes one word and nothing else in the three live templates', async () => {
    const tables = seed();
    await migration.up(makeDb(tables));
    for (const key of WORDS_KEYS) {
      const before = startBlocks(key);
      const after = activeBlocks(tables, key);
      expect(after).toHaveLength(before.length);
      after.forEach((block, i) => {
        if (before[i].content === ANY_VISIT) expect(block).toEqual({ ...before[i], content: A_VISIT });
        else expect(block).toEqual(before[i]);
      });
      expect(JSON.stringify(after)).not.toContain('reschedule any visit');
    }
  });

  test('Part 3 adds exactly the three blocks right after the caption and leaves every other block as it was', async () => {
    const tables = seed();
    await migration.up(makeDb(tables));
    for (const key of APP_KEYS) {
      const before = startBlocks(key);
      const after = activeBlocks(tables, key);
      const at = before.findIndex((b) => b.type === 'small_note' && b.content === '{{report_video_caption}}');
      expect(after.slice(0, at + 1)).toEqual(before.slice(0, at + 1));
      expect(after.slice(at + 1, at + 4)).toEqual(APP_BLOCKS);
      expect(after.slice(at + 4)).toEqual(before.slice(at + 1));
      expect(after).toHaveLength(before.length + 3);
    }
  });

  test('publishes one new active version per template: only the replaced version archived, a draft untouched, text_body carried', async () => {
    const tables = seed();
    await migration.up(makeDb(tables));
    for (const key of ALL_KEYS) {
      const versions = versionsOf(tables, key);
      expect(versions).toHaveLength(3);
      expect(versions.find((v) => v.id === `v-${key}-1`).status).toBe('archived');
      expect(versions.find((v) => v.id === `v-${key}-d`)).toMatchObject({ status: 'draft', version_number: 2 });
      const created = versions.find((v) => v.status === 'active');
      expect(created).toMatchObject({ version_number: 3, subject: 'S', preview_text: 'P', text_body: null });
      expect(created.validation_snapshot).toContain('"source":"migration:20261122140000"');
      expect(tables.email_templates.find((t) => t.template_key === key).active_version_id).toBe(created.id);
    }
    const publish = recordAuditEvent.mock.calls.map(([e]) => e).filter((e) => e.action === 'migration:20261122140000:publish');
    expect(publish).toHaveLength(1);
    expect(Object.values(publish[0].metadata.results)).toEqual(Array(7).fill('published'));
  });

  test('a custom plain-text body is carried over unchanged', async () => {
    const tables = seed();
    tables.email_template_versions.find((v) => v.id === 'v-estimate.engage_expiring-1').text_body = 'Admin plain text';
    await migration.up(makeDb(tables));
    expect(versionsOf(tables, 'estimate.engage_expiring').find((v) => v.status === 'active').text_body).toBe('Admin plain text');
  });

  test('a second run publishes nothing new', async () => {
    const tables = seed();
    const db = makeDb(tables);
    await migration.up(db);
    const snapshot = JSON.stringify(tables.email_template_versions);
    await migration.up(db);
    expect(JSON.stringify(tables.email_template_versions)).toBe(snapshot);
  });

  test('a template with no {{report_video_caption}} note is skipped and logged, the others still publish', async () => {
    const tables = seed();
    const v = tables.email_template_versions.find((x) => x.id === 'v-estimate.engage_return_visit-1');
    v.blocks = JSON.stringify(startBlocks('estimate.engage_return_visit').filter((b) => b.content !== '{{report_video_caption}}'));
    await migration.up(makeDb(tables));
    expect(versionsOf(tables, 'estimate.engage_return_visit')).toHaveLength(2);
    expect(activeBlocks(tables, 'estimate.engage_return_visit').map(label)).not.toContain('app-paragraph');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('estimate.engage_return_visit: no {{report_video_caption}} note'));
    expect(activeBlocks(tables, 'estimate.engage_expiring').map(label)).toContain('app-paragraph');
  });

  test('Part 3 skips a template that already has the app paragraph (even a reworded one) and Part 2 skips an edited sentence', async () => {
    const tables = seed();
    const gone = tables.email_template_versions.find((x) => x.id === 'v-estimate.engage_gone_quiet-1');
    const blocks = startBlocks('estimate.engage_gone_quiet');
    blocks.splice(7, 0, { type: 'paragraph', content: 'Admin: the Waves app keeps everything in one place.' });
    gone.blocks = JSON.stringify(blocks);
    const high = tables.email_template_versions.find((x) => x.id === 'v-estimate.engage_high_intent-1');
    high.blocks = JSON.stringify(startBlocks('estimate.engage_high_intent').map((b) => (b.content === ANY_VISIT ? { ...b, content: `${ANY_VISIT} Admin edit.` } : b)));
    await migration.up(makeDb(tables));
    expect(versionsOf(tables, 'estimate.engage_gone_quiet')).toHaveLength(2);
    expect(versionsOf(tables, 'estimate.engage_high_intent')).toHaveLength(2);
    expect(JSON.stringify(activeBlocks(tables, 'estimate.engage_high_intent'))).toContain('Admin edit.');
  });

  test('missing, unreadable or invalid templates are left whole', async () => {
    const tables = seed();
    tables.email_templates = tables.email_templates.filter((t) => t.template_key !== 'estimate.engage_expiring');
    tables.email_template_versions.find((x) => x.id === 'v-estimate.engage_unopened-1').blocks = 'not json';
    tables.email_templates.find((t) => t.template_key === 'estimate.engage_high_intent').allowed_variables = ['first_name'];
    await migration.up(makeDb(tables));
    expect(versionsOf(tables, 'estimate.engage_unopened')).toHaveLength(2);
    expect(versionsOf(tables, 'estimate.engage_high_intent')).toHaveLength(2);
    const publish = recordAuditEvent.mock.calls.map(([e]) => e).find((e) => e.action === 'migration:20261122140000:publish');
    expect(publish.metadata.results).toMatchObject({ 'estimate.engage_expiring': 'missing', 'estimate.engage_unopened': 'skipped', 'estimate.engage_high_intent': 'skipped', 'estimate.engage_gone_quiet': 'published' });
  });

  test('no variable is added: every new block uses only variables the templates already carry', () => {
    const vars = JSON.stringify(APP_BLOCKS).match(/\{\{\w+\}\}/g);
    expect(vars).toBeNull();
  });
});

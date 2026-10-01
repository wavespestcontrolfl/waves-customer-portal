// Day 60 and Day 90 invoice follow-up templates (owner-approved wording
// 2026-09-28) for the Day 90 ladder, GATE_DUNNING_LADDER_90 (#5126).
const { countSegments } = require('../services/messaging/segment-counter');
const migration = require('../models/migrations/20260928050000_invoice_followup_day60_day90_templates');

const { SMS_TEMPLATES, EMAIL_TEMPLATES, VARIABLES, REQUIRED } = migration.__private;
const sms = (key) => SMS_TEMPLATES.find((t) => t.template_key === key);
const email = (key) => EMAIL_TEMPLATES.find((t) => t.key === key);

// Typical values: a long service title with a service date clause and a short pay link.
const SAMPLE = {
  first_name: 'Christopher',
  invoice_title: 'Quarterly Pest Control',
  service_date_clause: ' completed on May 12, 2026',
  pay_url: 'https://wvs.link/p/Ab3dE9fQ',
};
const render = (body) => body.replace(/\{(\w+)\}/g, (_m, key) => SAMPLE[key] ?? '');

describe('texts', () => {
  test('both stay GSM-7 in at most two segments, and carry no signature', () => {
    for (const t of SMS_TEMPLATES) {
      const segments = countSegments(render(t.body));
      expect(segments.encoding).toBe('GSM_7');
      expect(segments.segmentCount).toBeLessThanOrEqual(2);
      expect(t.body).not.toMatch(/[—–-]\s*Waves\s*$/);
      expect(t.body.trim().endsWith('{pay_url}')).toBe(true);
    }
  });

  test('each declares exactly the variables it uses, all of which the ladder supplies', () => {
    for (const t of SMS_TEMPLATES) {
      const used = [...t.body.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect([...new Set(used)].sort()).toEqual([...t.variables].sort());
      for (const key of used) expect(Object.keys(SAMPLE)).toContain(key);
    }
  });

  test('Day 90 is the only final notice and names collections; neither claims a day count', () => {
    expect(sms('invoice_followup_90day').body).toMatch(/final notice/i);
    expect(sms('invoice_followup_90day').body).toMatch(/collections/);
    expect(sms('invoice_followup_60day').body).not.toMatch(/final|collections/i);
    for (const t of SMS_TEMPLATES) expect(t.body).not.toMatch(/\d+ days/);
  });
});

describe('emails', () => {
  const textOf = (t) => [t.subject, t.preview, ...t.blocks.map((b) => b.content || '')].join(' ');

  test('Day 90 is the final notice and names collections; Day 60 is neither', () => {
    expect(email('invoice.followup_90_day').subject).toMatch(/^Final notice/);
    expect(textOf(email('invoice.followup_90_day'))).toMatch(/collections/);
    expect(textOf(email('invoice.followup_60_day'))).not.toMatch(/final|collections/i);
  });

  test('every placeholder is an allowed variable, and the required ones are all used', () => {
    for (const t of EMAIL_TEMPLATES) {
      const json = JSON.stringify(t.blocks) + t.subject + t.preview;
      const used = [...json.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
      for (const key of used) expect(VARIABLES).toContain(key);
      for (const key of REQUIRED.filter((k) => k !== 'pay_url')) expect(used).toContain(key);
      expect(t.blocks.some((b) => b.type === 'cta' && b.url_variable === 'pay_url')).toBe(true);
    }
  });
});

describe('the migration is insert-only', () => {
  function fakeKnex({ existingSms = [], existingEmail = [] } = {}) {
    const inserted = { sms_templates: [], email_templates: [], email_template_versions: [], email_template_fixtures: [] };
    const updated = [];
    const knex = (table) => {
      const q = { conditions: {} };
      q.where = jest.fn((cond) => { Object.assign(q.conditions, cond); return q; });
      q.first = jest.fn(async () => {
        if (table === 'sms_templates' && q.conditions.template_key === 'invoice_followup_30day') return { sort_order: 21 };
        if (table === 'sms_templates' && existingSms.includes(q.conditions.template_key)) return { id: 'existing' };
        if (table === 'email_templates' && existingEmail.includes(q.conditions.template_key)) return { id: 'existing' };
        return undefined;
      });
      q.insert = jest.fn((row) => {
        inserted[table].push(row);
        const withId = { id: `${table}-${inserted[table].length}`, ...row };
        const result = Promise.resolve([withId]);
        result.returning = jest.fn(async () => [withId]);
        return result;
      });
      q.update = jest.fn(async (patch) => { updated.push({ table, conditions: q.conditions, patch }); return 1; });
      return q;
    };
    knex.schema = { hasTable: jest.fn(async () => true) };
    return { knex, inserted, updated };
  }

  test('seeds both texts next to the Day 30 text, and both emails with an active version and fixture', async () => {
    const { knex, inserted, updated } = fakeKnex();
    await migration.up(knex);
    expect(inserted.sms_templates.map((r) => r.template_key)).toEqual(['invoice_followup_60day', 'invoice_followup_90day']);
    expect(inserted.sms_templates.every((r) => r.sort_order === 21 && r.is_active === true)).toBe(true);
    expect(inserted.email_templates.map((r) => r.template_key)).toEqual(['invoice.followup_60_day', 'invoice.followup_90_day']);
    expect(inserted.email_template_versions).toHaveLength(2);
    expect(inserted.email_template_versions.every((v) => v.status === 'active' && v.version_number === 1)).toBe(true);
    expect(inserted.email_template_fixtures).toHaveLength(2);
    expect(updated.filter((u) => u.table === 'email_templates' && u.patch.active_version_id)).toHaveLength(2);
  });

  test('a template that already exists is left exactly as it is', async () => {
    const { knex, inserted, updated } = fakeKnex({
      existingSms: ['invoice_followup_90day'], existingEmail: ['invoice.followup_60_day'],
    });
    await migration.up(knex);
    expect(inserted.sms_templates.map((r) => r.template_key)).toEqual(['invoice_followup_60day']);
    expect(inserted.email_templates.map((r) => r.template_key)).toEqual(['invoice.followup_90_day']);
    expect(updated.every((u) => u.conditions.id !== 'existing')).toBe(true);
  });
});

describe('rollback is a documented no-op (a seed that preserves admin edits must not delete them)', () => {
  test('down touches nothing: no table, no query', async () => {
    const knex = jest.fn(() => { throw new Error('down must not query'); });
    knex.schema = { hasTable: jest.fn(async () => { throw new Error('down must not query'); }) };
    await expect(migration.down(knex)).resolves.toBeUndefined();
    expect(knex).not.toHaveBeenCalled();
    expect(knex.schema.hasTable).not.toHaveBeenCalled();
  });
});

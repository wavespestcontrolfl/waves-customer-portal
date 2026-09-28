// Combined invoice follow-up templates (dunning unification PR 2b,
// GATE_DUNNING_COMBINED_MESSAGE). Wording drafted by Claude; owner approval
// pending — mirrors invoice-followup-day60-day90-templates.test.js.
const { countSegments } = require('../services/messaging/segment-counter');
const { renderTemplate } = require('../services/email-template-library');
const migration = require('../models/migrations/20260928060000_invoice_followup_combined_templates');

const {
  SMS_TEMPLATES, EMAIL_TEMPLATES, VARIABLES, REQUIRED, blocksFor, fixture,
} = migration.__private;
const sms = (key) => SMS_TEMPLATES.find((t) => t.template_key === key);
const email = (key) => EMAIL_TEMPLATES.find((t) => t.key === key);

// Typical values: several invoices, a real total, a short pay link.
const SAMPLE = {
  first_name: 'Christopher',
  invoice_count: '3',
  total_due: '482.50',
  pay_url: 'https://wvs.link/p/Ab3dE9fQ',
};
const render = (body) => body.replace(/\{(\w+)\}/g, (_m, key) => SAMPLE[key] ?? '');

describe('texts', () => {
  test('all six stay GSM-7 in at most two segments, and carry no signature', () => {
    for (const t of SMS_TEMPLATES) {
      const segments = countSegments(render(t.body));
      expect(segments.encoding).toBe('GSM_7');
      expect(segments.segmentCount).toBeLessThanOrEqual(2);
      expect(t.body).not.toMatch(/[—–-]\s*Waves\s*$/);
      // 10-day and 60-day end on the pay link itself; the others carry one
      // more short sentence after it (a reply invitation), per spec.
      expect(t.body).toContain('{pay_url}');
    }
  });

  test('each declares exactly the variables it uses, all of which the combined touch supplies', () => {
    for (const t of SMS_TEMPLATES) {
      const used = [...t.body.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect([...new Set(used)].sort()).toEqual([...t.variables].sort());
      for (const key of used) expect(Object.keys(SAMPLE)).toContain(key);
    }
  });

  test('every body quotes a dollar total, not a bare number (the $ lives in the template)', () => {
    for (const t of SMS_TEMPLATES) expect(t.body).toMatch(/\$\{total_due\}/);
  });

  test('Day 90 is the only final notice and names collections; neither claims a day count', () => {
    expect(sms('invoice_followup_combined_90day').body).toMatch(/final notice/i);
    expect(sms('invoice_followup_combined_90day').body).toMatch(/collections/);
    expect(sms('invoice_followup_combined_60day').body).not.toMatch(/final|collections/i);
    for (const t of SMS_TEMPLATES) expect(t.body).not.toMatch(/\d+ days/);
  });
});

describe('emails', () => {
  function fakeTemplate(t) {
    return {
      template_key: t.key,
      name: t.name,
      allowed_variables: VARIABLES,
      required_variables: REQUIRED,
      mode: 'service',
      from_name: 'Waves Pest Control',
      from_email: 'contact@wavespestcontrol.com',
      reply_to: 'contact@wavespestcontrol.com',
      default_cta_label: 'Pay all invoices',
      default_cta_url_variable: 'pay_url',
    };
  }
  function fakeVersion(t) {
    return { subject: t.subject, preview_text: t.preview, blocks: blocksFor(t), text_body: null };
  }
  const textOf = (t) => [t.subject, t.preview, JSON.stringify(blocksFor(t))].join(' ');

  test('Day 90 is the final notice and names collections; Day 60 does not', () => {
    expect(email('invoice.followup_combined_90_day').subject).toMatch(/^Final notice/);
    expect(textOf(email('invoice.followup_combined_90_day'))).toMatch(/collections/);
    expect(textOf(email('invoice.followup_combined_60_day'))).not.toMatch(/final|collections/i);
  });

  test('every placeholder is an allowed variable, and the required ones (besides pay_url, carried by the CTA) are all used', () => {
    for (const t of EMAIL_TEMPLATES) {
      const json = JSON.stringify(blocksFor(t)) + t.subject + t.preview;
      const used = [...json.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
      for (const key of used) expect(VARIABLES).toContain(key);
      for (const key of REQUIRED.filter((k) => k !== 'pay_url')) expect(used).toContain(key);
      expect(blocksFor(t).some((b) => b.type === 'cta' && b.url_variable === 'pay_url')).toBe(true);
    }
  });

  test('the details block generates one row per included invoice, not a fixed admin row list', () => {
    for (const t of EMAIL_TEMPLATES) {
      const details = blocksFor(t).find((b) => b.type === 'details');
      expect(details.rowsFromVariable).toBe('invoices');
      expect(Array.isArray(details.rows)).toBe(false);
    }
  });

  test('renders end-to-end with no missing required variables, and every invoice appears', () => {
    for (const t of EMAIL_TEMPLATES) {
      const payload = fixture(t.stageDays);
      const rendered = renderTemplate({ template: fakeTemplate(t), version: fakeVersion(t), payload });
      expect(rendered.missingPayload).toEqual([]);
      for (const inv of payload.invoices) {
        expect(rendered.html).toContain(inv.invoice_number);
        expect(rendered.html).toContain(inv.amount_due);
      }
      // Only the 3/10/17-day subjects name the count; 30/60 read "still
      // unpaid" and 90 reads "Final notice" (spec).
      if (t.subject.includes('{{invoice_count}}')) {
        expect(rendered.subject).toContain(String(payload.invoice_count));
      }
    }
  });

  test('a template with no invoices in the payload renders no generated rows and does not throw', () => {
    const t = email('invoice.followup_combined_3_day');
    const payload = { ...fixture(t.stageDays), invoices: [] };
    const rendered = renderTemplate({ template: fakeTemplate(t), version: fakeVersion(t), payload });
    expect(rendered.missingPayload).toEqual([]);
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

  test('seeds all six texts next to the Day 30 text, and all six emails with an active version and fixture', async () => {
    const { knex, inserted, updated } = fakeKnex();
    await migration.up(knex);
    expect(inserted.sms_templates.map((r) => r.template_key)).toEqual(SMS_TEMPLATES.map((t) => t.template_key));
    expect(inserted.sms_templates.every((r) => r.sort_order === 21 && r.is_active === true)).toBe(true);
    expect(inserted.email_templates.map((r) => r.template_key)).toEqual(EMAIL_TEMPLATES.map((t) => t.key));
    expect(inserted.email_template_versions).toHaveLength(6);
    expect(inserted.email_template_versions.every((v) => v.status === 'active' && v.version_number === 1)).toBe(true);
    expect(inserted.email_template_fixtures).toHaveLength(6);
    expect(updated.filter((u) => u.table === 'email_templates' && u.patch.active_version_id)).toHaveLength(6);
  });

  test('a template that already exists is left exactly as it is', async () => {
    const { knex, inserted, updated } = fakeKnex({
      existingSms: ['invoice_followup_combined_90day'], existingEmail: ['invoice.followup_combined_60_day'],
    });
    await migration.up(knex);
    expect(inserted.sms_templates.map((r) => r.template_key)).not.toContain('invoice_followup_combined_90day');
    expect(inserted.email_templates.map((r) => r.template_key)).not.toContain('invoice.followup_combined_60_day');
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

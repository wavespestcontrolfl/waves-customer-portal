// Dunning consolidation PR 1: the combined invoice follow-up templates.
//
// The migration is copied BYTE-IDENTICAL from the closed
// feat/dunning-combined-narrow-20260928 branch under the SAME filename on
// purpose: preview databases already recorded that name in knex_migrations,
// so a different name would seed the 12 templates twice and a changed body
// would never reach a database that already ran it. This test pins the
// bytes; a wording edit belongs in the admin template editor after the flip,
// never in this file.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { countSegments } = require('../services/messaging/segment-counter');
const { renderTemplate } = require('../services/email-template-library');

const FILE = path.join(__dirname, '..', 'models', 'migrations', '20260928060000_invoice_followup_combined_templates.js');
const migration = require('../models/migrations/20260928060000_invoice_followup_combined_templates');

const {
  SMS_TEMPLATES, EMAIL_TEMPLATES, VARIABLES, REQUIRED, blocksFor,
} = migration.__private;

test('the migration file is byte-identical to the branch copy (md5 pin)', () => {
  const md5 = crypto.createHash('md5').update(fs.readFileSync(FILE)).digest('hex');
  expect(md5).toBe('612706d2322a6c9c72d4a4510d2e6061');
});

describe('what it seeds', () => {
  test('six texts and six emails, keyed by stage', () => {
    expect(SMS_TEMPLATES.map((t) => t.template_key)).toEqual([3, 10, 17, 30, 60, 90].map((d) => `invoice_followup_combined_${d}day`));
    expect(EMAIL_TEMPLATES.map((t) => t.key)).toEqual([3, 10, 17, 30, 60, 90].map((d) => `invoice.followup_combined_${d}_day`));
  });

  test('every text stays GSM-7 in at most two segments with no signature', () => {
    const sample = { first_name: 'Christopher', invoice_count: '3', total_due: '482.50', pay_url: 'https://wvs.link/p/Ab3dE9fQ' };
    for (const t of SMS_TEMPLATES) {
      const body = t.body.replace(/\{(\w+)\}/g, (_m, key) => sample[key] ?? '');
      const segments = countSegments(body);
      expect(segments.encoding).toBe('GSM_7');
      expect(segments.segmentCount).toBeLessThanOrEqual(2);
      expect(t.body).not.toMatch(/[—–-]\s*Waves\s*$/);
    }
  });

  test('Day 90 is the only final notice', () => {
    expect(SMS_TEMPLATES.find((t) => t.template_key === 'invoice_followup_combined_90day').body).toMatch(/final notice/i);
    for (const t of SMS_TEMPLATES.filter((x) => !x.template_key.endsWith('90day'))) expect(t.body).not.toMatch(/final notice/i);
  });
});

describe('the email on main (rowsFromVariable is NOT ported)', () => {
  const template = (t) => ({
    template_key: t.key, name: t.name, allowed_variables: VARIABLES, required_variables: REQUIRED,
    mode: 'service', from_name: 'Waves Pest Control', from_email: 'contact@wavespestcontrol.com',
    reply_to: 'contact@wavespestcontrol.com', default_cta_label: 'Pay all invoices', default_cta_url_variable: 'pay_url',
  });
  const payload = {
    first_name: 'Sam', invoice_count: '3', total_due: '$258.00',
    pay_url: 'https://pay.example.test/pay/token', customer_portal_url: 'https://portal.example.test',
  };

  test('renders count + total + the pay link, with NO per-invoice rows and no missing variable', () => {
    for (const t of EMAIL_TEMPLATES) {
      const rendered = renderTemplate({
        template: template(t),
        version: { subject: t.subject, preview_text: t.preview, blocks: blocksFor(t), text_body: null },
        payload,
      });
      expect(rendered.missingPayload).toEqual([]);
      expect(rendered.html).toContain('$258.00');
      expect(rendered.html).toContain('https://pay.example.test/pay/token');
      // The details block's per-invoice row template is dropped by main's
      // block normalizer: a row would show its "(#number)" label.
      expect(rendered.html).not.toMatch(/\(#/);
      // Only the SMS is unsigned; the email keeps its team signature.
      expect(rendered.html).toContain('The Waves Team');
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

  test('seeds all twelve, active, and leaves an existing admin-edited row untouched', async () => {
    const fresh = fakeKnex();
    await migration.up(fresh.knex);
    expect(fresh.inserted.sms_templates).toHaveLength(6);
    expect(fresh.inserted.email_templates).toHaveLength(6);
    expect(fresh.inserted.email_template_versions.every((v) => v.status === 'active')).toBe(true);

    const edited = fakeKnex({ existingSms: ['invoice_followup_combined_90day'], existingEmail: ['invoice.followup_combined_60_day'] });
    await migration.up(edited.knex);
    expect(edited.inserted.sms_templates.map((r) => r.template_key)).not.toContain('invoice_followup_combined_90day');
    expect(edited.inserted.email_templates.map((r) => r.template_key)).not.toContain('invoice.followup_combined_60_day');
  });

  test('rollback is a no-op (a seed that preserves admin edits must not delete them)', async () => {
    const knex = jest.fn(() => { throw new Error('down must not query'); });
    await expect(migration.down(knex)).resolves.toBeUndefined();
    expect(knex).not.toHaveBeenCalled();
  });
});

describe('the six email keys are protected and sender-rendered (the six texts are not email templates)', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-email-templates.js'), 'utf8');
  const protectedKeys = new Set(
    [...routeSource.slice(routeSource.indexOf('const PROTECTED_EMAIL_TEMPLATE_KEYS')).split(']);')[0].matchAll(/'([^']+)'/g)].map((m) => m[1]),
  );
  const { SENDER_RENDERED_TEMPLATES } = require('../services/billing-email-no-replay');

  test.each(EMAIL_TEMPLATES.map((t) => t.key))('%s is protected from the admin editor and never replayed from a stored copy', (key) => {
    expect(protectedKeys.has(key)).toBe(true);
    expect(SENDER_RENDERED_TEMPLATES.has(key)).toBe(true);
  });
});

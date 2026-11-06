// Migration 20261105040000 (GATE_ESTIMATE_UPDATED_WORDING): seeds the "updated estimate" text and email from the live
// estimate_sent / estimate.delivery copies, once, never over a row that exists. Synthetic data, in-memory fake knex.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const migration = require('../models/migrations/20261105040000_estimate_updated_wording_templates');

const t = migration._test;
const LIVE_SMS = { template_key: 'estimate_sent', name: 'Estimate Sent', category: 'estimates', body: 'Hi {first_name}, your Waves estimate is ready: {estimate_url}\n\nReply STOP to opt out.', variables: ['first_name', 'estimate_url'], is_active: true, sort_order: 20, trigger_event_key: 'estimate.sent' };
const LIVE_BLOCKS = [
  { type: 'paragraph', content: 'Hi {{first_name}}, your customized Waves estimate is ready for review.' },
  { type: 'details', rows: [{ label: 'Service', value: '{{service_summary}}' }, { label: 'Property', value: '{{property_address}}' }, { label: 'Estimated price', value: '{{price_summary}}' }] },
  { type: 'paragraph', content: 'Inside the estimate you can review the service breakdown, compare any available options, and choose the plan or visit that fits your home.' },
  { type: 'paragraph', content: '{{next_step_summary}}' },
  { type: 'cta', label: 'View estimate', url_variable: 'estimate_url' },
  { type: 'paragraph', content: '{{estimate_pdf_note}}' },
  { type: 'small_note', content: 'Questions, timing concerns, or changes to the property details? Reply here and our team will help before you accept.' },
];
const ALLOWED = ['first_name', 'estimate_url', 'price_summary', 'service_summary', 'property_address', 'next_step_summary', 'estimate_pdf_note'];

function fakeKnex(tables) {
  let seq = 0;
  const knex = (name) => {
    const rows = tables[name];
    const filter = {};
    const matches = () => rows.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
    const qb = {
      where(obj) { Object.assign(filter, obj); return qb; },
      first: async () => matches()[0],
      insert(row) {
        seq += 1;
        const stored = { id: `${name}-${seq}`, ...row };
        rows.push(stored);
        return { returning: async () => [stored], then: (resolve, reject) => Promise.resolve([stored]).then(resolve, reject) };
      },
      update: async (patch) => { const hit = matches(); hit.forEach((r) => Object.assign(r, patch)); return hit.length; },
    };
    return qb;
  };
  knex.schema = { hasTable: async (name) => Object.prototype.hasOwnProperty.call(tables, name), hasColumn: async () => true };
  knex.transaction = async (callback) => callback(knex);
  return knex;
}

function liveTables({ blocks = LIVE_BLOCKS, textBody = null, withEmailSource = true } = {}) {
  const tables = { sms_templates: [{ id: 'sms-1', ...LIVE_SMS }], email_templates: [], email_template_versions: [], email_template_fixtures: [] };
  if (withEmailSource) {
    tables.email_templates.push({
      id: 'tpl-delivery', template_key: 'estimate.delivery', name: 'Estimate Delivery', description: 'Immediate email', mode: 'service', purpose: 'estimate',
      legal_classification: 'transactional_relationship', audience: 'customer', message_priority: 'normal', content_sensitivity: 'normal',
      send_stream: 'service_operational', suppression_group_key: 'service_operational', layout_wrapper_id: 'service_default_v1',
      from_name: 'Waves Pest Control', from_email: 'contact@example.invalid', reply_to: 'contact@example.invalid', default_cta_label: 'View estimate',
      default_cta_url_variable: 'estimate_url', allowed_variables: ALLOWED, required_variables: ['first_name', 'estimate_url'],
      optional_variables: ALLOWED.slice(2), status: 'active', active_version_id: 'ver-delivery-4',
    });
    tables.email_template_versions.push({ id: 'ver-delivery-4', template_id: 'tpl-delivery', version_number: 4, status: 'active', subject: 'Your Waves estimate is ready', preview_text: 'Review your service estimate, what is included, and the next step.', blocks, text_body: textBody });
    tables.email_template_fixtures.push({ id: 'fx-1', template_id: 'tpl-delivery', name: 'Happy path', payload: { first_name: 'Sam' }, is_default: true });
  }
  return tables;
}

describe('the wording helpers', () => {
  test('the text reads "updated" where the live text says "your Waves estimate"', () => {
    expect(t.updatedSmsBody(LIVE_SMS.body)).toBe('Hi {first_name}, your updated Waves estimate is ready: {estimate_url}\n\nReply STOP to opt out.');
    expect(t.updatedSmsBody('Hello {first_name}! Your Waves estimate is ready: {estimate_url}')).toBe('Hello {first_name}! Your updated Waves estimate is ready: {estimate_url}');
    expect(t.updatedSmsBody('Hi {first_name}, take a look: {estimate_url}')).toBe(t.DEFAULT_SMS_BODY);
    expect(t.updatedSmsBody('Hi {first_name}, your Waves estimate is ready.')).toBe(t.DEFAULT_SMS_BODY);
    expect(t.updatedSmsBody(null)).toBe(t.DEFAULT_SMS_BODY);
  });
  test('the email changes only its first sentence, subject and preview, and never mutates the live blocks', () => {
    const live = structuredClone(LIVE_BLOCKS);
    const blocks = t.updatedBlocks(live);
    expect(live).toEqual(LIVE_BLOCKS);
    expect(blocks[0].content).toBe('Hi {{first_name}}, your updated Waves estimate is ready for review. It replaces the one we sent before.');
    expect(blocks.slice(1)).toEqual(LIVE_BLOCKS.slice(1));
    expect(t.updatedBlocks([{ type: 'paragraph', content: 'Something else' }])).toBeNull();
    expect(t.updatedBlocks('not blocks')).toBeNull();
    expect(t.updatedSubject('Your Waves estimate is ready')).toBe('Your updated Waves estimate is ready');
    expect(t.updatedSubject('A custom subject')).toBe('Your updated Waves estimate is ready');
    expect(t.updatedPreview('Review your service estimate, what is included, and the next step.')).toBe('Review your updated estimate, what is included, and the next step.');
  });
});

describe('seeding', () => {
  test('the text template copies the live one once, sorted right after it, and is never re-seeded', async () => {
    const tables = liveTables();
    const knex = fakeKnex(tables);
    expect((await t.seedSms(knex)).status).toBe('seeded');
    const seeded = tables.sms_templates.find((r) => r.template_key === 'estimate_updated');
    expect(seeded).toMatchObject({ name: 'Estimate Updated', category: 'estimates', is_active: true, is_internal: false, sort_order: 21, trigger_event_key: 'estimate.sent' });
    expect(seeded.body).toBe('Hi {first_name}, your updated Waves estimate is ready: {estimate_url}\n\nReply STOP to opt out.');
    expect(JSON.parse(seeded.variables)).toEqual(['first_name', 'estimate_url']);
    seeded.body = 'An admin edit';
    expect((await t.seedSms(knex)).status).toBe('already');
    expect(tables.sms_templates.filter((r) => r.template_key === 'estimate_updated')).toHaveLength(1);
    expect(seeded.body).toBe('An admin edit');
  });

  test('the email copies estimate.delivery settings and its active version as one active version, with its fixture', async () => {
    const tables = liveTables();
    const knex = fakeKnex(tables);
    expect((await t.seedEmail(knex)).status).toBe('seeded');
    const template = tables.email_templates.find((r) => r.template_key === 'estimate.updated_delivery');
    expect(template).toMatchObject({ name: 'Updated Estimate Delivery', status: 'active', send_stream: 'service_operational', suppression_group_key: 'service_operational', purpose: 'estimate' });
    expect(JSON.parse(template.allowed_variables)).toEqual(ALLOWED);
    expect(JSON.parse(template.required_variables)).toEqual(['first_name', 'estimate_url']);
    const version = tables.email_template_versions.find((r) => r.template_id === template.id);
    expect(template.active_version_id).toBe(version.id);
    expect(version).toMatchObject({ version_number: 1, status: 'active', subject: 'Your updated Waves estimate is ready', preview_text: 'Review your updated estimate, what is included, and the next step.', text_body: null });
    expect(JSON.parse(version.blocks)[0].content).toContain('your updated Waves estimate is ready for review');
    expect(JSON.parse(version.validation_snapshot)).toMatchObject({ ok: true, source: t.MARKER, copied_from: 'estimate.delivery v4', copied_blocks: true });
    expect(tables.email_template_fixtures.find((r) => r.template_id === template.id)).toMatchObject({ name: 'Happy path', is_default: true, payload: JSON.stringify({ first_name: 'Sam' }) });
    expect((await t.seedEmail(knex)).status).toBe('already');
    expect(tables.email_templates.filter((r) => r.template_key === 'estimate.updated_delivery')).toHaveLength(1);
  });

  test('a live copy without the first sentence, or with a custom plain-text body, takes the default blocks', async () => {
    for (const opts of [{ blocks: [{ type: 'paragraph', content: 'Hi {{first_name}}.' }, { type: 'cta', label: 'View', url_variable: 'estimate_url' }] }, { textBody: 'Custom text {{estimate_url}}' }]) {
      const tables = liveTables(opts);
      expect((await t.seedEmail(fakeKnex(tables))).status).toBe('seeded_default');
      const version = tables.email_template_versions.find((r) => r.version_number === 1);
      expect(JSON.parse(version.blocks)).toEqual(t.DEFAULT_BLOCKS);
    }
  });

  test('no estimate.delivery template: nothing is seeded and the send keeps the normal email', async () => {
    const tables = liveTables({ withEmailSource: false });
    expect((await t.seedEmail(fakeKnex(tables))).status).toBe('no_source');
    expect(tables.email_templates).toHaveLength(0);
  });

  test('up seeds both in one transaction and writes one audit row per inserted template, none on a re-run', async () => {
    const { recordAuditEvent } = require('../services/audit-log');
    const tables = { ...liveTables(), audit_log: [] };
    await migration.up(fakeKnex(tables));
    expect(tables.sms_templates.map((r) => r.template_key)).toContain('estimate_updated');
    expect(tables.email_templates.map((r) => r.template_key)).toContain('estimate.updated_delivery');
    expect(recordAuditEvent).toHaveBeenCalledTimes(2);
    const [smsAudit, emailAudit] = recordAuditEvent.mock.calls.map(([event]) => event);
    expect(smsAudit).toMatchObject({ action: 'sms_template.seeded', resource_type: 'sms_template', critical: true });
    expect(smsAudit.metadata.changes.created).toMatchObject({ before: null, after: { is_active: true } });
    expect(emailAudit).toMatchObject({ action: 'email_template.seeded', resource_type: 'email_template', critical: true });
    expect(emailAudit.metadata).toMatchObject({ copied_from: 'estimate.delivery v4', to_version_number: 1 });
    expect(emailAudit.metadata.changes.created.after.subject).toBe('Your updated Waves estimate is ready');
    for (const event of [smsAudit, emailAudit]) expect(event.action.length).toBeLessThanOrEqual(96);
    recordAuditEvent.mockClear();
    await migration.up(fakeKnex(tables));
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});

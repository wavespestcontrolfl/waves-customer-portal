/**
 * 20261001140000_review_followup_names_google — the legacy Day-3 review
 * follow-up names a Google review. Pins: exact-body rewrite on both template
 * tables with an audit event per row, admin-edited bodies untouched,
 * idempotent, down() a documented no-op, and no extra SMS segment.
 */
const mockRecordAuditEvent = jest.fn(async () => {});
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockRecordAuditEvent(...a) }));
const migration = require('../models/migrations/20261001140000_review_followup_names_google');

const { KEY, BEFORE, AFTER } = migration._copy;

function createKnex(tables) {
  const knex = jest.fn((table) => {
    const q = {
      criteria: null,
      where(criteria) { q.criteria = criteria; return q; },
      async select() { return tables[table].filter((r) => Object.entries(q.criteria).every(([k, v]) => r[k] === v)); },
      async update(patch) {
        const rows = tables[table].filter((r) => Object.entries(q.criteria).every(([k, v]) => r[k] === v));
        rows.forEach((r) => Object.assign(r, patch));
        return rows.length;
      },
    };
    return q;
  });
  knex.schema = { hasTable: jest.fn(async () => true) };
  knex.fn = { now: () => 'now' };
  return knex;
}

beforeEach(() => mockRecordAuditEvent.mockClear());

test('up() names Google on both template tables and audits each changed row', async () => {
  const tables = {
    sms_templates: [{ id: 1, template_key: KEY, body: BEFORE }],
    sms_template_variants: [{ id: 7, template_key: KEY, body: BEFORE }],
  };
  await migration.up(createKnex(tables));
  expect(tables.sms_templates[0].body).toBe(AFTER);
  expect(tables.sms_template_variants[0].body).toBe(AFTER);
  expect(AFTER).toMatch(/Google review/);
  expect(mockRecordAuditEvent).toHaveBeenCalledTimes(2);
  expect(mockRecordAuditEvent.mock.calls[0][0]).toMatchObject({ resource_type: 'sms_templates', resource_id: '1', metadata: { before: BEFORE, after: AFTER } });
});

test('an admin-edited body is untouched; a second run and down() change nothing', async () => {
  const tables = {
    sms_templates: [{ id: 1, template_key: KEY, body: 'Our own follow-up copy: {google_review_url}' }],
    sms_template_variants: [],
  };
  const knex = createKnex(tables);
  await migration.up(knex);
  await migration.up(knex);
  await migration.down(knex);
  expect(tables.sms_templates[0].body).toBe('Our own follow-up copy: {google_review_url}');
  expect(mockRecordAuditEvent).not.toHaveBeenCalled();
});

test('the new body costs no more SMS segments than the old one', () => {
  const { countSegments } = require('../services/messaging/segment-counter');
  const render = (b) => b.replace('{first_name}', 'Christopher').replace('{google_review_url}', 'portal.wavespestcontrol.com/l/abcdefghij');
  expect(countSegments(render(AFTER)).segmentCount).toBe(countSegments(render(BEFORE)).segmentCount);
});

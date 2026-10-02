/**
 * 20261001160000_review_followup_one_segment — the legacy Day-3 follow-up
 * names a Google review AND stays one GSM-7 segment with the production
 * g.page link (scheme stripped at send) for first names through 12
 * characters. Pins: rewrites from the 140000 body and the original, admin
 * edits untouched, audit event per row, idempotent, no-op down.
 */
const mockRecordAuditEvent = jest.fn(async () => {});
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockRecordAuditEvent(...a) }));
const migration = require('../models/migrations/20261001160000_review_followup_one_segment');

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

test('both earlier bodies move to the one-segment Google wording, audited per row', async () => {
  const tables = {
    sms_templates: [{ id: 1, template_key: KEY, body: BEFORE[0] }],
    sms_template_variants: [{ id: 7, template_key: KEY, body: BEFORE[1] }],
  };
  await migration.up(createKnex(tables));
  expect(tables.sms_templates[0].body).toBe(AFTER);
  expect(tables.sms_template_variants[0].body).toBe(AFTER);
  expect(mockRecordAuditEvent).toHaveBeenCalledTimes(2);
});

test('an admin-edited body is untouched; idempotent; down() is a no-op', async () => {
  const tables = { sms_templates: [{ id: 1, template_key: KEY, body: 'Our own copy {google_review_url}' }], sms_template_variants: [] };
  const knex = createKnex(tables);
  await migration.up(knex);
  await migration.up(knex);
  await migration.down(knex);
  expect(tables.sms_templates[0].body).toBe('Our own copy {google_review_url}');
  expect(mockRecordAuditEvent).not.toHaveBeenCalled();
});

test('one GSM-7 segment with the delivered g.page link for first names up to 12 characters', () => {
  const { countSegments } = require('../services/messaging/segment-counter');
  const link = 'g.page/r/CQxxxxxxxxxxxxxxx/review'; // the scheme is stripped at send
  for (const name of ['Al', 'Maria', 'Michael', 'Jennifer', 'Christina', 'Christopher2']) {
    const rendered = AFTER.replace('{first_name}', name).replace('{google_review_url}', link);
    expect(countSegments(rendered).segmentCount).toBe(1);
  }
  expect(AFTER).toMatch(/Google review/);
});

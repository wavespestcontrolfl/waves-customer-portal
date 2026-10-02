/**
 * 20261001130000_review_email_fixture_neutral_intro — the review email's
 * default preview fixture shows the neutral intro production sends. Pins:
 * exact-match rewrite with an audit event, operator payloads untouched,
 * idempotent, down() a documented no-op.
 */
const mockRecordAuditEvent = jest.fn(async () => {});
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockRecordAuditEvent(...a) }));
const migration = require('../models/migrations/20261001130000_review_email_fixture_neutral_intro');
const { GENERIC_EMAIL_INTRO } = require('../services/review-outreach-templates');

const OLD_INTRO = "We're a small, family-owned pest and lawn company here in Southwest Florida, and word of mouth is how neighbors find us. If your recent service hit the mark, would you take 15 seconds to share a quick review?";

function createKnex(tables) {
  const knex = jest.fn((table) => {
    const q = {
      criteria: null,
      where(criteria) { q.criteria = criteria; return q; },
      async first() { return tables[table].find((r) => Object.entries(q.criteria).every(([k, v]) => r[k] === v)); },
      async update(patch) {
        const row = tables[table].find((r) => Object.entries(q.criteria).every(([k, v]) => r[k] === v));
        if (row) Object.assign(row, patch);
        return row ? 1 : 0;
      },
    };
    return q;
  });
  knex.schema = { hasTable: jest.fn(async () => true) };
  return knex;
}

const seeded = (intro = OLD_INTRO) => ({
  email_templates: [{ id: 't1', template_key: 'review_request_email' }],
  email_template_fixtures: [{ id: 'f1', template_id: 't1', is_default: true, payload: JSON.stringify({ first_name: 'Stan', intro_paragraph: intro }) }],
});

beforeEach(() => mockRecordAuditEvent.mockClear());

test('up() puts the neutral intro production sends into the default fixture, with an audit event', async () => {
  const tables = seeded();
  await migration.up(createKnex(tables));
  const payload = JSON.parse(tables.email_template_fixtures[0].payload);
  expect(payload.intro_paragraph).toBe(GENERIC_EMAIL_INTRO);
  expect(payload.first_name).toBe('Stan');
  expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
  expect(mockRecordAuditEvent.mock.calls[0][0]).toMatchObject({
    resource_type: 'email_template_fixtures', resource_id: 'f1',
    metadata: { migration: '20261001130000_review_email_fixture_neutral_intro' },
  });
});

test('an operator-edited fixture is untouched and nothing is audited', async () => {
  const tables = seeded('Our own preview copy.');
  await migration.up(createKnex(tables));
  expect(JSON.parse(tables.email_template_fixtures[0].payload).intro_paragraph).toBe('Our own preview copy.');
  expect(mockRecordAuditEvent).not.toHaveBeenCalled();
});

test('idempotent, and down() is a no-op', async () => {
  const tables = seeded();
  await migration.up(createKnex(tables));
  const once = JSON.stringify(tables);
  await migration.up(createKnex(tables));
  await migration.down(createKnex(tables));
  expect(JSON.stringify(tables)).toBe(once);
  expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
});

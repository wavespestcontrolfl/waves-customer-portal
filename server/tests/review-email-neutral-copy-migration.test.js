/**
 * 20261001120000_review_email_neutral_copy — the review-request email's fixed
 * pieces lose "If we earned it" (preview), the reply-instead-of-review
 * closing, and name a Google review on the button (owner rulings 2026-09-30 /
 * 10-01). Pins: exact-match rewrite, operator edits untouched, idempotent,
 * down() restores only this migration's copy.
 */
const mockRecordAuditEvent = jest.fn(async () => {});
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockRecordAuditEvent(...a) }));
const migration = require('../models/migrations/20261001120000_review_email_neutral_copy');

beforeEach(() => mockRecordAuditEvent.mockClear());

const OLD_CLOSING = "It genuinely makes our day — and helps other local families decide who to trust with their home. If anything fell short, just reply to this email and we'll make it right.";

function createKnex({ template, version }) {
  const tables = { email_templates: [template], email_template_versions: [version] };
  const knex = jest.fn((table) => {
    const q = {
      criteria: null,
      where(criteria) { q.criteria = criteria; return q; },
      async first() {
        return tables[table].find((r) => Object.entries(q.criteria).every(([k, v]) => r[k] === v));
      },
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

const seeded = () => ({
  template: { id: 't1', template_key: 'review_request_email', active_version_id: 'v1', default_cta_label: 'Leave a quick review' },
  version: {
    id: 'v1',
    preview_text: 'If we earned it, a 15-second Google review would mean the world to our small family business.',
    blocks: JSON.stringify([
      { type: 'heading', content: 'Thanks for trusting Waves, {{first_name}}' },
      { type: 'paragraph', content: '{{intro_paragraph}}' },
      { type: 'cta', label: 'Leave a quick review', url_variable: 'review_url' },
      { type: 'paragraph', content: OLD_CLOSING },
    ]),
  },
});

test('up() neutralizes the preview, closing and button, and keeps the intro variable', async () => {
  const rows = seeded();
  await migration.up(createKnex(rows));
  expect(rows.version.preview_text).toBe('A 15-second Google review helps our small family business a lot.');
  const blocks = JSON.parse(rows.version.blocks);
  expect(blocks[1].content).toBe('{{intro_paragraph}}');
  expect(blocks[2].label).toBe('Leave a Google review');
  expect(blocks[3].content).toBe('It genuinely makes our day — and helps other local families decide who to trust with their home.');
  expect(rows.template.default_cta_label).toBe('Leave a Google review');
  const text = `${rows.version.preview_text} ${rows.version.blocks}`;
  expect(text).not.toMatch(/earned it|fell short|just reply|mean the world/i);
  // One audit event per changed row, with before/after, tagged with the migration.
  expect(mockRecordAuditEvent).toHaveBeenCalledTimes(2);
  const [tplEvent, versionEvent] = mockRecordAuditEvent.mock.calls.map((c) => c[0]);
  expect(tplEvent).toMatchObject({ actor_type: 'system', resource_type: 'email_templates', resource_id: 't1' });
  expect(tplEvent.metadata).toMatchObject({ migration: '20261001120000_review_email_neutral_copy', before: { default_cta_label: 'Leave a quick review' } });
  expect(versionEvent).toMatchObject({ resource_type: 'email_template_versions', resource_id: 'v1' });
  expect(versionEvent.metadata.before.preview_text).toMatch(/If we earned it/);
});

test('an operator-edited field is left untouched', async () => {
  const rows = seeded();
  rows.version.preview_text = 'Our own words.';
  const blocks = JSON.parse(rows.version.blocks);
  blocks[3].content = 'An operator closing.';
  rows.version.blocks = JSON.stringify(blocks);
  await migration.up(createKnex(rows));
  expect(rows.version.preview_text).toBe('Our own words.');
  expect(JSON.parse(rows.version.blocks)[3].content).toBe('An operator closing.');
  expect(JSON.parse(rows.version.blocks)[2].label).toBe('Leave a Google review');
});

test('idempotent, and down() is a no-op (it cannot tell its own copy from an operator\'s)', async () => {
  const rows = seeded();
  await migration.up(createKnex(rows));
  const once = JSON.stringify(rows);
  await migration.up(createKnex(rows));
  expect(JSON.stringify(rows)).toBe(once);
  // A second run changes nothing, so it audits nothing.
  expect(mockRecordAuditEvent).toHaveBeenCalledTimes(2);
  await migration.down(createKnex(rows));
  expect(JSON.stringify(rows)).toBe(once);
});
